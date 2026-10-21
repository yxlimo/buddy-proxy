// router-proxy.ts — the single entry point in front of both upstreams.
//
// One port, two dialects, two upstreams:
//
//   POST /v1/messages         Anthropic dialect
//   POST /v1/chat/completions  OpenAI dialect
//   GET  /v1/models            model catalog of both upstreams
//   GET  /health
//
// The model name decides the upstream. A prefix is explicit (`qoder/auto`,
// `minimax/MiniMax-M3`); without one the catalog is consulted, Qoder first,
// because it carries far more models.
//
// Each dialect is cheapest on the upstream that speaks it natively:
//   OpenAI  → Qoder    the Qoder gateway is an OpenAI endpoint, so it passes through
//   OpenAI  → MiniMax  converted to Anthropic on the way out
//   Anthropic → Qoder  converted to Anthropic on the way in
//   Anthropic → MiniMax passes through

import express from "express";
import crypto from "node:crypto";
import { authenticate, loadKeys, REQUIRE_API_KEY } from "./lib/api-keys.ts";
import { readEnvFlag, readEnvNumber, readEnvString } from "./lib/env.ts";
import { AuthError } from "./lib/credential.ts";
import { sseHead, writeSafe } from "./lib/sse.ts";
import { sseEvent } from "./lib/sse-stream.ts";
import { anthropicStreamToOpenAI, anthropicToOpenAI, anthropicToOpenAIResponse, effortFromBudget, openaiStreamToAnthropic, openaiToAnthropic, openaiToAnthropicResponse } from "./lib/dialect.ts";
import { readOpenAIChunks, sseData, SSE_DONE } from "./lib/sse-stream.ts";
import { anthropicModelsPayload, openaiModelsPayload, QODER_MODELS, qoderLabel, qoderModelsForRegion, qoderProtocolForRegion, resolveModelRoute, QODER_EFFORTS, QODER_MAX_OUTPUT_TOKENS, type QoderModel } from "./lib/qoder-models.ts";
import { MINIMAX_MODELS } from "./lib/minimax-models.ts";
import { qoderChatCompletion, LimitError } from "./lib/qoder-transport.ts";
import { legacyChatCompletion, readLegacyFrames } from "./lib/qoder-legacy.ts";
import { qoderStatus, checkAccountHealth, type QoderAccountHealth, type QoderRegion } from "./lib/qoder-auth.ts";
import { workbuddyStatus } from "./lib/workbuddy-auth.ts";
import { workbuddyChat, aggregateStream, fetchWorkBuddyCatalog } from "./lib/workbuddy-transport.ts";
import { workBuddyFallbackModels, workbuddyLabel, type WorkBuddyModel } from "./lib/workbuddy-models.ts";
import { ensureQoderSession, ensureWorkBuddySession } from "./lib/login.ts";
import { runBenefits, type BenefitOutcome, type BenefitUpstream } from "./lib/benefits.ts";

const PORT = readEnvNumber("ROUTER_PORT", 6450);
const HOST = readEnvString("ROUTER_HOST", "0.0.0.0");
const MINIMAX_BASE = readEnvString("MINIMAX_UPSTREAM_URL", "http://127.0.0.1:6448").replace(/\/+$/, "");
// Which upstreams this router serves. Each flag turns on one reverse proxy; an
// upstream that is off is not looked at at all — no credential read, no login,
// no models advertised, and a request for one is refused with a clear message.
const ENABLED_MINIMAX = readEnvFlag("MINIMAX_CODE", false);
const ENABLED_QODER_GLOBAL = readEnvFlag("QODER_GLOBAL", false);
const ENABLED_QODER_CN = readEnvFlag("QODER_CN", false);
const ENABLED_WORKBUDDY_CN = readEnvFlag("WORKBUDDY_CN", false);

/* ------------------------------------------------------------------ *
 * The daily benefits of the China accounts
 * ------------------------------------------------------------------ */

/** How often the check-in runs. The day rolls over at midnight in China. */
const BENEFITS_INTERVAL_MS = Number(readEnvString("BENEFITS_INTERVAL_MS", "") || 6 * 3600 * 1000);

interface BenefitsState {
  /** When the last run finished. */
  lastRunAt: string | null;
  /** What that run did. */
  lastOutcome: BenefitOutcome[] | null;
  /** A run is in progress. */
  running: boolean;
}

let benefitsState: BenefitsState = { lastRunAt: null, lastOutcome: null, running: false };

/** The upstreams that hand out credits and are switched on. */
function benefitUpstreams(): BenefitUpstream[] {
  const out: BenefitUpstream[] = [];
  if (ENABLED_WORKBUDDY_CN) out.push("workbuddy-cn");
  if (ENABLED_QODER_CN) out.push("qoder-cn");
  return out;
}

/**
 * Take the daily benefits, if there is a session to take them with.
 *
 * The run is idempotent — asking twice answers "already done" — so it can run
 * on a timer without keeping a state file of its own.
 */
async function runBenefitsOnce(): Promise<void> {
  if (benefitsState.running) return;
  const upstreams = benefitUpstreams();
  if (!upstreams.length) return;
  benefitsState.running = true;
  try {
    const outcomes = await runBenefits(upstreams);
    benefitsState.lastRunAt = new Date().toISOString();
    benefitsState.lastOutcome = outcomes;
    for (const outcome of outcomes) {
      const what = outcome.credits ? `+${outcome.credits} credits` : "nothing new";
      console.log(`  [BENEFITS] ${outcome.upstream}: ${what} — ${outcome.report.join("; ")}`);
    }
  } catch (e) {
    console.warn(`  [BENEFITS] failed: ${(e as Error).message}`);
  } finally {
    benefitsState.running = false;
  }
}

/** Run the benefits now, and then on the timer. */
function scheduleBenefits(): void {
  if (!benefitUpstreams().length) return;
  setInterval(() => void runBenefitsOnce(), BENEFITS_INTERVAL_MS);
  // The login may still be waiting for an approval, so the first run waits for
  // the session to be there.
  setTimeout(() => void runBenefitsOnce(), 60_000);
}
const QODER_REGIONS: QoderRegion[] = [
  ...(ENABLED_QODER_GLOBAL ? (["global"] as QoderRegion[]) : []),
  ...(ENABLED_QODER_CN ? (["cn"] as QoderRegion[]) : []),
];
const PING_MS = readEnvNumber("MINIMAX_PING_MS", 15000);
// The legacy endpoint queues models and reports 429 while a request waits. The
// CLI retries these, so the proxy does too — with the same shape.
const LEGACY_MAX_ATTEMPTS = readEnvNumber("QODER_LEGACY_ATTEMPTS", 3);
const LEGACY_RETRY_MS = readEnvNumber("QODER_LEGACY_RETRY_MS", 10000);
const QODER_MAX_ATTEMPTS = readEnvNumber("QODER_MAX_ATTEMPTS", 3);
const LOG_ROUTE = readEnvFlag("QODER_LOG_ROUTE", false);
// How long the upstream's own catalogue is trusted before it is fetched again.
const WORKBUDDY_CATALOG_TTL_MS = readEnvNumber("WORKBUDDY_CATALOG_TTL_MS", 30 * 60 * 1000);

const rid = (prefix: string) => prefix + crypto.randomBytes(12).toString("hex");

type Dialect = "anthropic" | "openai";
type Upstream = "qoder" | "minimax" | "workbuddy";

const MINIMAX_MODEL_IDS = new Set(MINIMAX_MODELS.map((m) => m.id));
const MINIMAX_VISIBLE = ENABLED_MINIMAX ? MINIMAX_MODELS : [];
// Only the models each region can actually serve are advertised. The rest stay
// in the catalog so a request for one gets a clear "not available here"
// instead of being sent to an upstream that will not answer. A region that is
// not enabled contributes no models at all.
const QODER_GLOBAL = ENABLED_QODER_GLOBAL ? qoderModelsForRegion("global") : [];
const QODER_CN = ENABLED_QODER_CN ? qoderModelsForRegion("cn") : [];
const QODER_VISIBLE = [...QODER_GLOBAL, ...QODER_CN];
const QODER_MODEL_IDS = new Set(QODER_VISIBLE.map((m) => m.id));
const QODER_HIDDEN_IDS = new Set(QODER_MODELS.filter((m) => !QODER_MODEL_IDS.has(m.id)).map((m) => m.id));
const GLOBAL_QODER_IDS = new Set(qoderModelsForRegion("global").map((m) => m.id));
const CN_QODER_IDS = new Set(qoderModelsForRegion("cn").map((m) => m.id));
// WorkBuddy's models are addressed by prefix only: several of them (glm-5.3,
// kimi-k2.8-preview) carry the same name as a Qoder model, so a bare name
// would be ambiguous. The list starts as the bundled snapshot and is replaced
// by the upstream's own catalogue as soon as it can be fetched.
let WORKBUDDY_CN: WorkBuddyModel[] = ENABLED_WORKBUDDY_CN ? workBuddyFallbackModels() : [];
let WORKBUDDY_CN_IDS = new Set(WORKBUDDY_CN.map((m) => m.id));
let workbuddyCatalogAt = 0;

/** The upstream catalogue, refreshed at most every half hour. */
async function refreshWorkBuddyCatalog(force = false): Promise<void> {
  if (!ENABLED_WORKBUDDY_CN) return;
  const age = Date.now() - workbuddyCatalogAt;
  if (!force && workbuddyCatalogAt && age < WORKBUDDY_CATALOG_TTL_MS) return;
  try {
    const models = await fetchWorkBuddyCatalog("cn");
    if (models?.length) {
      WORKBUDDY_CN = models;
      WORKBUDDY_CN_IDS = new Set(models.map((m) => m.id));
      workbuddyCatalogAt = Date.now();
    }
  } catch (e) {
    console.warn(`[WORKBUDDY] catalogue refresh failed: ${(e as Error).message}`);
  }
}

interface Route {
  upstream: Upstream;
  /** The model as the server names it: prefixed, e.g. `qoder-cn/glm-5.3`. */
  model: string;
  /** Which Qoder region to talk to. Unset for MiniMax. */
  region?: QoderRegion;
}

/**
 * The upstream a request is addressed to, taken from the path.
 *
 * A client that talks to one upstream says so in the base URL — `/qoder-cn/v1`
 * — and uses the model's real name. The server prefixes it internally, so the
 * two spellings never have to be kept in step by hand.
 */
type UpstreamGroup = "qoder" | "qoder-cn" | "workbuddy-cn" | "minimax";

const UPSTREAM_GROUPS: UpstreamGroup[] = ["qoder", "qoder-cn", "workbuddy-cn", "minimax"];

/** The prefix the server puts in front of a model id. */
const GROUP_PREFIX: Record<UpstreamGroup, string> = {
  qoder: "qoder/",
  "qoder-cn": "qoder-cn/",
  "workbuddy-cn": "workbuddy-cn/",
  minimax: "minimax/",
};

/** The group a request path addresses, if any. */
function groupFromPath(path: string): UpstreamGroup | undefined {
  const first = (path.split("/")[1] ?? "").toLowerCase();
  return (UPSTREAM_GROUPS as string[]).includes(first) ? (first as UpstreamGroup) : undefined;
}

/** The model as the upstream knows it, prefix stripped. */
function upstreamModel(route: Route): string {
  for (const group of UPSTREAM_GROUPS) {
    const prefix = GROUP_PREFIX[group];
    if (route.model.startsWith(prefix)) return route.model.slice(prefix.length);
  }
  return route.model;
}

/** Decide where a request goes, and what the upstream should call the model. */
export function resolveRoute(model: string): Route {
  const raw = String(model ?? "").trim();
  if (raw.startsWith("workbuddy-cn/")) return workbuddyRoute(raw.slice("workbuddy-cn/".length));
  if (raw.startsWith("qoder-cn/")) return qoderRoute(raw.slice("qoder-cn/".length), "cn");
  if (raw.startsWith("qoder/")) return qoderRoute(raw.slice("qoder/".length), "global");
  if (raw.startsWith("minimax/")) {
    if (!ENABLED_MINIMAX) throw disabledUpstream("minimax");
    return { upstream: "minimax", model: raw };
  }
  if (MINIMAX_MODEL_IDS.has(raw)) {
    if (!ENABLED_MINIMAX) throw disabledUpstream("minimax");
    return { upstream: "minimax", model: `minimax/${raw}` };
  }
  if (GLOBAL_QODER_IDS.has(raw) || CN_QODER_IDS.has(raw)) {
    // Known to a region. Prefer one that is enabled; if the only region that has
    // it is off, say so rather than calling it unknown.
    if (ENABLED_QODER_GLOBAL && GLOBAL_QODER_IDS.has(raw)) {
      return { upstream: "qoder", model: `qoder/${raw}`, region: "global" };
    }
    if (ENABLED_QODER_CN && CN_QODER_IDS.has(raw)) {
      return { upstream: "qoder", model: `qoder-cn/${raw}`, region: "cn" };
    }
    throw disabledUpstream(GLOBAL_QODER_IDS.has(raw) ? "qoder-global" : "qoder-cn");
  }
  if (QODER_HIDDEN_IDS.has(raw)) throw unavailableQoderModel(raw);
  throw new AuthError(
    `unknown model "${raw}"`,
    `这个模型不在目录里。用 qoder/、workbuddy-cn/ 或 minimax/ 前缀显式指定，例如 qoder/auto、workbuddy-cn/glm-5.3、minimax/MiniMax-M3。`,
    400,
  );
}

/**
 * Resolve a model inside one upstream, named by the request path.
 *
 * The model id is the real one — `glm-5.3`, not `qoder-cn/glm-5.3` — because
 * the path already says which upstream it is for.
 */
function routeInGroup(group: UpstreamGroup, id: string): Route {
  switch (group) {
    case "qoder":
      return qoderRoute(id, "global");
    case "qoder-cn":
      return qoderRoute(id, "cn");
    case "workbuddy-cn":
      return workbuddyRoute(id);
    case "minimax": {
      if (!ENABLED_MINIMAX) throw disabledUpstream("minimax");
      if (!MINIMAX_MODEL_IDS.has(id)) {
        throw new AuthError(
          `unknown model "${id}"`,
          `MiniMax 没有这个模型。可用：${[...MINIMAX_MODEL_IDS].join("、")}。`,
          400,
        );
      }
      return { upstream: "minimax", model: `minimax/${id}` };
    }
  }
}

/** WorkBuddy's China region. */
function workbuddyRoute(id: string): Route {
  if (!ENABLED_WORKBUDDY_CN) throw disabledUpstream("workbuddy-cn");
  if (!WORKBUDDY_CN_IDS.has(id)) {
    throw new AuthError(
      `unknown model "${id}"`,
      `WorkBuddy 中国区没有这个模型。可用：${[...WORKBUDDY_CN_IDS].join("、")}。`,
      400,
    );
  }
  return { upstream: "workbuddy", model: `workbuddy-cn/${id}`, region: "cn" };
}

/** An upstream that this router is not serving, because it was not enabled. */
function disabledUpstream(which: "minimax" | "qoder-global" | "qoder-cn" | "workbuddy-cn"): AuthError {
  const flag =
    which === "minimax" ? "MINIMAX_CODE" : which === "qoder-cn" ? "QODER_CN" : which === "workbuddy-cn" ? "WORKBUDDY_CN" : "QODER_GLOBAL";
  const what =
    which === "minimax"
      ? "MiniMax Code"
      : which === "qoder-cn"
        ? "Qoder 中国区"
        : which === "workbuddy-cn"
          ? "WorkBuddy 中国区"
          : "Qoder 全球区";
  return new AuthError(
    `${which} is not enabled`,
    `${what}没有启用。设置 ${flag}=true 后重启 router。`,
    400,
  );
}

/** A model the catalog knows, but no region can serve. */
function unavailableQoderModel(id: string): AuthError {
  const global = [...GLOBAL_QODER_IDS].join("、");
  const cn = [...CN_QODER_IDS].join("、");
  const hints = [
    ENABLED_QODER_GLOBAL ? `可用（全球区）：${global}` : null,
    ENABLED_QODER_CN ? `可用（中国区）：${cn}` : null,
  ].filter(Boolean);
  return new AuthError(
    `model "${id}" is not available`,
    `Qoder 的 ${id} 目前没有可用的区域：全球区的新协议不认它，老协议被限流/额度卡住；中国区把它排进了队列。${hints.join("；") || "当前没有启用任何 Qoder 区域。"}`,
    400,
  );
}

function qoderRoute(id: string, region: QoderRegion): Route {
  if (!(region === "cn" ? ENABLED_QODER_CN : ENABLED_QODER_GLOBAL)) {
    throw disabledUpstream(region === "cn" ? "qoder-cn" : "qoder-global");
  }
  const known = region === "cn" ? CN_QODER_IDS : GLOBAL_QODER_IDS;
  if (known.has(id)) {
    return { upstream: "qoder", model: `${GROUP_PREFIX[region === "cn" ? "qoder-cn" : "qoder"]}${id}`, region };
  }
  if (QODER_HIDDEN_IDS.has(id)) throw unavailableQoderModel(id);
  // Known to the other region but not to this one: point at it.
  const other = region === "cn" ? "global" : "cn";
  if ((region === "cn" ? GLOBAL_QODER_IDS : CN_QODER_IDS).has(id)) {
    if (!(other === "cn" ? ENABLED_QODER_CN : ENABLED_QODER_GLOBAL)) throw disabledUpstream(other === "cn" ? "qoder-cn" : "qoder-global");
    throw new AuthError(
      `model "${id}" is not available in the ${region} region`,
      `这个模型只在 ${other} 区有。用另一个上游的路径指定它：${other === "cn" ? "/qoder-cn/v1" : "/qoder/v1"}。`,
      400,
    );
  }
  throw new AuthError(
    `unknown model "${id}"`,
    `Qoder ${region} 区没有这个模型。可用：${[...known].join("、")}。`,
    400,
  );
}

const keys = loadKeys();
const app = express();
app.use(express.json({ limit: "64mb" }));

app.get("/health", async (_req, res) => {
  // The account's own standing is checked live: a valid token still means nothing
  // if the account is not allowed to make requests from here. A region that is
  // not enabled is not looked at at all.
  const regions: Record<string, unknown> = {};
  for (const region of QODER_REGIONS) {
    let account: QoderAccountHealth | Record<string, unknown>;
    try {
      account = await checkAccountHealth(region);
    } catch (e) {
      account = { region, usable: false, reason: (e as Error)?.message };
    }
    regions[region] = {
      models: region === "cn" ? QODER_CN.length : QODER_GLOBAL.length,
      credential: qoderStatus(region),
      account,
    };
  }
  res.json({
    status: "ok",
    dialects: ["anthropic", "openai"],
    enabled: {
      minimax: ENABLED_MINIMAX,
      qoderGlobal: ENABLED_QODER_GLOBAL,
      qoderCn: ENABLED_QODER_CN,
      workbuddyCn: ENABLED_WORKBUDDY_CN,
    },
    upstreams: {
      minimax: ENABLED_MINIMAX ? { base: MINIMAX_BASE, models: MINIMAX_VISIBLE.length } : { enabled: false },
      qoder: { regions },
      workbuddy: ENABLED_WORKBUDDY_CN
        ? {
            region: "cn",
            models: WORKBUDDY_CN.length,
            credential: workbuddyStatus("cn"),
          }
        : { enabled: false },
    },
    auth: REQUIRE_API_KEY ? "api-key" : "public",
    benefits: {
      enabled: benefitUpstreams().length > 0,
      intervalMs: BENEFITS_INTERVAL_MS,
      lastRunAt: benefitsState.lastRunAt,
      running: benefitsState.running,
      lastOutcome: benefitsState.lastOutcome,
    },
  });
});

/**
 * One upstream's catalogue, with the real model ids.
 *
 * A client that talks to one upstream does not need the prefix: the path says
 * which upstream it is, so the ids are the plain ones.
 */
function groupCatalog(group: UpstreamGroup, openai: boolean) {
  const created = Math.floor(Date.now() / 1000);
  const qoder = (m: (typeof QODER_GLOBAL)[number]) => ({
    id: m.id,
    type: "model",
    display_name: qoderLabel(m),
    created_at: created,
    reasoning: m.reasoning,
    tool_call: true,
    context_window: m.context,
    max_output_tokens: QODER_MAX_OUTPUT_TOKENS,
    ...(m.kind === "tier" ? { effort_options: [...QODER_EFFORTS] } : {}),
    ...(m.backend ? { backend: m.backend } : {}),
  });
  const workbuddy = (m: WorkBuddyModel) => ({
    id: m.id,
    type: "model",
    display_name: workbuddyLabel(m),
    created_at: created,
    reasoning: m.reasoning,
    tool_call: m.tools,
    context_window: m.context,
    max_output_tokens: m.maxOutput,
    ...(m.efforts.length ? { effort_options: [...m.efforts] } : {}),
  });
  const minimax = (m: (typeof MINIMAX_MODELS)[number]) => ({
    id: m.id,
    type: "model",
    display_name: m.display_name,
    created_at: created,
    reasoning: m.reasoning,
    tool_call: m.tool_call,
    context_window: m.context,
    max_output_tokens: m.output,
    effort_options: m.effortOptions,
  });

  const data: any[] = [];
  switch (group) {
    case "qoder":
      data.push(...QODER_GLOBAL.map(qoder));
      break;
    case "qoder-cn":
      data.push(...QODER_CN.map(qoder));
      break;
    case "workbuddy-cn":
      data.push(...WORKBUDDY_CN.map(workbuddy));
      break;
    case "minimax":
      data.push(...MINIMAX_VISIBLE.map(minimax));
      break;
  }

  if (openai) {
    return {
      object: "list",
      data: data.map((m) => ({ id: m.id, object: "model", created, owned_by: group, name: m.display_name })),
    };
  }
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

/** OpenAI shape, with the prefixes that make routing explicit. */
function openaiCatalog() {
  const created = Math.floor(Date.now() / 1000);
  const data = [
    ...QODER_GLOBAL.map((m) => ({ id: `qoder/${m.id}`, object: "model", created, owned_by: "qoder", name: qoderLabel(m) })),
    ...QODER_CN.map((m) => ({ id: `qoder-cn/${m.id}`, object: "model", created, owned_by: "qoder-cn", name: qoderLabel(m) })),
    ...WORKBUDDY_CN.map((m) => ({
      id: `workbuddy-cn/${m.id}`,
      object: "model",
      created,
      owned_by: "workbuddy-cn",
      name: workbuddyLabel(m),
    })),
    ...MINIMAX_VISIBLE.map((m) => ({ id: `minimax/${m.id}`, object: "model", created, owned_by: "minimax" })),
  ];
  return { object: "list", data };
}

/** Anthropic shape, with the extra metadata pi reads. */
function anthropicCatalog() {
  const created = Math.floor(Date.now() / 1000);
  const qoderEntry = (m: (typeof QODER_GLOBAL)[number], prefix: string) => ({
    id: `${prefix}${m.id}`,
    type: "model",
    display_name: qoderLabel(m),
    created_at: created,
    reasoning: m.reasoning,
    tool_call: true,
    context_window: m.context,
    max_output_tokens: QODER_MAX_OUTPUT_TOKENS,
    // A tier accepts a thinking level; a pinned model either thinks or does not,
    // and the list says which.
    ...(m.kind === "tier" ? { effort_options: [...QODER_EFFORTS] } : {}),
    ...(m.backend ? { backend: m.backend } : {}),
  });
  const data = [
    ...QODER_GLOBAL.map((m) => qoderEntry(m, "qoder/")),
    ...QODER_CN.map((m) => qoderEntry(m, "qoder-cn/")),
    ...WORKBUDDY_CN.map((m) => ({
      id: `workbuddy-cn/${m.id}`,
      type: "model",
      display_name: workbuddyLabel(m),
      created_at: created,
      reasoning: m.reasoning,
      tool_call: m.tools,
      context_window: m.context,
      max_output_tokens: m.maxOutput,
      ...(m.efforts.length ? { effort_options: [...m.efforts] } : {}),
    })),
    ...MINIMAX_VISIBLE.map((m) => ({
      id: `minimax/${m.id}`,
      type: "model",
      display_name: m.display_name,
      created_at: created,
      reasoning: m.reasoning,
      tool_call: m.tool_call,
      context_window: m.context,
      max_output_tokens: m.output,
      effort_options: m.effortOptions,
    })),
  ];
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
    default_model: "qoder/auto",
  };
}

/**
 * The same endpoints, once per upstream.
 *
 * The plain `/v1/...` form takes the upstream in the model name
 * (`qoder-cn/glm-5.3`); the prefixed form takes it in the path
 * (`/qoder-cn/v1/messages`) and the model name is the real one.
 */
for (const group of ["", ...UPSTREAM_GROUPS] as (UpstreamGroup | "")[]) {
  const base = group ? `/${group}` : "";

  app.post(`${base}/v1/messages`, async (req: express.Request, res: express.Response) => {
    if (!authenticate(req, keys)) {
      return res.status(401).json({ error: { type: "authentication_error", message: "invalid api key" } });
    }
    await handle(req, res, "anthropic", group || undefined);
  });

  app.post(`${base}/v1/chat/completions`, async (req: express.Request, res: express.Response) => {
    if (!authenticate(req, keys)) {
      return res.status(401).json({ error: { type: "authentication_error", message: "invalid api key" } });
    }
    await handle(req, res, "openai", group || undefined);
  });

  app.get(`${base}/v1/models`, (req: express.Request, res: express.Response) => {
    const dialect = String(req.query.dialect ?? "").toLowerCase();
    // The upstream's catalogue is the source of truth; fetch it in the background
    // so this answer is never blocked by it.
    if (ENABLED_WORKBUDDY_CN) void refreshWorkBuddyCatalog();
    if (group) return res.json(groupCatalog(group, dialect === "openai"));
    if (dialect === "openai") return res.json(openaiCatalog());
    return res.json(anthropicCatalog());
  });
}

async function handle(
  req: express.Request,
  res: express.Response,
  dialect: Dialect,
  group?: UpstreamGroup,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, any>;
  let route: Route;
  try {
    route = group ? routeInGroup(group, String(body.model ?? "").trim()) : resolveRoute(body.model);
  } catch (e) {
    sendError(res, e);
    return;
  }

  const stream = body.stream === true;
  try {
    if (route.upstream === "qoder") {
      await toQoder(body, route, dialect, stream, res);
    } else if (route.upstream === "workbuddy") {
      await toWorkBuddy(body, route, dialect, stream, res);
    } else {
      await toMinimax(body, route, dialect, stream, res);
    }
  } catch (e) {
    sendError(res, e);
  }
}

/* ---------------- WorkBuddy ---------------- */

/**
 * WorkBuddy's China region.
 *
 * The upstream speaks the OpenAI dialect natively, so the request goes out
 * almost unchanged; what the upstream checks is the identity around it, which
 * lib/workbuddy-auth.ts builds.
 *
 * The upstream always answers with a stream, even for a client that asked for
 * none, so a non-streaming request is folded back into one object here.
 */
async function toWorkBuddy(
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  if (LOG_ROUTE) {
    console.log(`[ROUTE] workbuddy model=${route.model} stream=${stream}`);
  }

  const { response } = await workbuddyChat(openaiBody, { region: "cn", stream });

  if (!stream) {
    let json: any;
    try {
      json = await aggregateStream(response, model);
    } catch (e) {
      throw new AuthError(
        `upstream stream failed (${(e as Error)?.message ?? "unknown"})`,
        "WorkBuddy 的响应流中断了。",
        502,
      );
    }
    if (json?.error) {
      const detail = json.error;
      throw new AuthError(
        `upstream error (${detail?.type ?? detail?.code ?? "unknown"})`,
        typeof detail?.message === "string" ? detail.message : JSON.stringify(detail).slice(0, 300),
        502,
      );
    }
    const payload = dialect === "openai" ? json : openaiToAnthropicResponse(json, model);
    res.json(payload);
    return;
  }

  // Peek before the headers go out, so an upstream failure inside a 200 response
  // can still become a proper status code.
  const upstreamStream = await peekStream(response.body!);
  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    await pipeOpenAIChunks(upstreamStream, res);
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(readOpenAIChunks(upstreamStream), model)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/* ---------------- Qoder ---------------- */

/**
 * The thinking level a request asks for.
 *
 * Several shapes reach the proxy, depending on the client and the dialect:
 *   `output_config.effort`  — the Anthropic spelling opencode and pi use
 *   `effort`                — explicit, and the only way to ask for `max`
 *   `reasoning_effort`      — the OpenAI spelling
 *   `thinking.budget_tokens` — the Anthropic spelling with a budget instead of a
 *                              level, where the level has to be recovered
 *
 * Qoder's own protocol has no per-request thinking switch: the tier *is* the
 * switch, so the level is translated into a tier here.
 */
function extractEffort(body: Record<string, any>): string | undefined {
  const candidates = [body.output_config?.effort, body.effort, body.reasoning_effort];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }

  const budget = body.thinking?.budget_tokens ?? body.thinking_budget_tokens ?? body.thinking_budget;
  if (typeof budget === "number" && budget > 0) return effortFromBudget(budget);
  return undefined;
}

async function toQoder(
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  // Qoder speaks OpenAI natively, so the request is either already OpenAI or is
  // converted once.
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  openaiBody.stream = stream;

  // Read the effort from the original request: the dialect conversion drops the
  // Anthropic spelling (`output_config.effort`), and that is where opencode and
  // pi put it.
  const effort = extractEffort(body);
  const region = route.region ?? QODER_REGIONS[0] ?? "global";
  const { model, key } = resolveModelRoute(upstreamModel(route), effort, region);
  if (LOG_ROUTE) {
    console.log(`[ROUTE] model=${route.model} region=${region} effort=${effort ?? "-"} -> upstream key=${key}`);
    console.log(`[ROUTE] raw body keys: ${Object.keys(body).join(",")}`);
    console.log(`[ROUTE] thinking=${JSON.stringify((body as any).thinking)} output_config=${JSON.stringify((body as any).output_config)}`);
  }
  if (model && qoderProtocolForRegion(model, region) === "legacy") {
    await toQoderLegacy(openaiBody, model, dialect, stream, res, region);
    return;
  }

  openaiBody.model = key;
  const upstream = await qoderWithRetry(
    () => qoderChatCompletion(openaiBody, { stream, region }),
    QODER_MAX_ATTEMPTS,
  );

  if (!stream) {
    const json = await upstream.json();
    // The gateway can answer 200 with an error object instead of a completion.
    if (json?.error) {
      const detail = json.error;
      throw new AuthError(
        `upstream error (${detail?.type ?? detail?.code ?? "unknown"})`,
        typeof detail?.message === "string" ? detail.message : JSON.stringify(detail).slice(0, 300),
        502,
      );
    }
    const payload = dialect === "openai" ? json : openaiToAnthropicResponse(json, upstreamModel(route));
    res.json(payload);
    return;
  }

  // Peek before the headers go out, so an upstream failure inside a 200 response
  // can still become a proper status code.
  const upstreamStream = await peekStream(upstream.body!);
  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    // Same dialect on both sides: forward the frames, repaired if need be.
    await pipeOpenAIChunks(upstreamStream, res);
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(readOpenAIChunks(upstreamStream), upstreamModel(route))) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    // The headers are already out, so the failure goes back as an error event.
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/**
 * The legacy (COSY) protocol, for the models the new one refuses.
 *
 * Its response is Qoder's own frame format, so the frames are unwrapped into
 * plain OpenAI chunks and then converted like any other upstream. The non-
 * streaming case has no upstream equivalent, so the chunks are collected and
 * reassembled into one completion.
 */
async function toQoderLegacy(
  openaiBody: Record<string, any>,
  model: QoderModel,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
  region: QoderRegion,
): Promise<void> {
  const chunks = legacyWithRetry(
    () =>
      legacyChatCompletion(
        {
          messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
          tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
          modelKey: model.key,
          displayName: model.name,
          maxTokens: typeof openaiBody.max_tokens === "number" ? openaiBody.max_tokens : 4096,
          reasoning: model.reasoning,
          contextWindow: model.context,
        },
        { region },
      ),
    LEGACY_MAX_ATTEMPTS,
  );

  if (!stream) {
    const completion = await collectOpenAIChunks(chunks, model.id);
    const payload = dialect === "openai" ? completion : openaiToAnthropicResponse(completion, model.id);
    res.json(payload);
    return;
  }

  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    // Same dialect on both sides: re-emit the chunks as plain OpenAI SSE.
    try {
      for await (const chunk of chunks) {
        if (!writeSafe(res, sseData(chunk))) break;
      }
      writeSafe(res, SSE_DONE);
    } catch (e) {
      writeSafe(res, sseEvent("error", { error: { type: "api_error", message: (e as Error)?.message } }));
    }
    res.end();
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(chunks, model.id)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/** Unwrap the legacy frames into plain OpenAI chunks, raising on error frames. */
async function* readLegacyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  for await (const frame of readLegacyFrames(body)) {
    if (frame.error) throw legacyError(frame.error);
    if (frame.chunk) yield frame.chunk;
  }
}

function legacyError(error: { code?: string; message?: string; status?: number }): AuthError {
  return new AuthError(
    `legacy upstream error (${error.code ?? "unknown"})`,
    `${error.message ?? "upstream failed"}${error.status ? ` (HTTP ${error.status})` : ""}`,
    error.status && error.status >= 500 ? 502 : 503,
  );
}

/**
 * The legacy endpoint answers 429 with `provider_error` / "All backends failed"
 * while the model is queued or the account is rate limited, and the CLI retries
 * such a request rather than failing it. The first frame tells us whether the
 * attempt was queued, so the retry happens before any bytes reach the client.
 */
async function* legacyWithRetry(
  send: () => Promise<Response>,
  maxAttempts: number,
): AsyncGenerator<Record<string, any>> {
  for (let attempt = 1; ; attempt++) {
    const upstream = await send();
    const frames = readLegacyFrames(upstream.body!)[Symbol.asyncIterator]();
    const first = await frames.next();

    if (!first.done && first.value.error && attempt < maxAttempts && isRetryableLegacy(first.value.error)) {
      await new Promise((r) => setTimeout(r, LEGACY_RETRY_MS));
      continue;
    }
    if (!first.done) {
      if (first.value.error) throw legacyError(first.value.error);
      if (first.value.chunk) yield first.value.chunk;
    }
    while (true) {
      const next = await frames.next();
      if (next.done) break;
      if (next.value.error) throw legacyError(next.value.error);
      if (next.value.chunk) yield next.value.chunk;
    }
    return;
  }
}

function isRetryableLegacy(error: { code?: string; status?: number }): boolean {
  return error.status === 429 || error.code === "provider_error";
}

/**
 * The upstream answers 403/429 when the model is queued or every backend for it
 * is busy — the CLI retries these, so the proxy does too. The request has not
 * produced any bytes yet, so the retry is invisible to the client.
 */
async function qoderWithRetry(send: () => Promise<Response>, maxAttempts: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof LimitError && attempt < maxAttempts) {
        if (LOG_ROUTE) console.log(`[ROUTE] upstream busy, retry ${attempt}/${maxAttempts - 1} in ${e.retryAfterSec}s`);
        await new Promise((r) => setTimeout(r, e.retryAfterSec * 1000));
        continue;
      }
      throw e;
    }
  }
}

/** Collect a chunk stream into a single chat completion. */
async function collectOpenAIChunks(
  chunks: AsyncGenerator<Record<string, any>>,
  model: string,
): Promise<Record<string, any>> {
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: Record<string, any> | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const existing = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.function.name = call.function.name;
      if (typeof call.function?.arguments === "string") existing.function.arguments += call.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message: Record<string, any> = { role: "assistant", content: toolCalls.size ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].map(([index, call]) => ({ index, ...call }));

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/* ---------------- MiniMax ---------------- */

async function toMinimax(
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  // MiniMax speaks Anthropic natively.
  const anthropicBody = dialect === "anthropic" ? { ...body } : openaiToAnthropic(body);
  anthropicBody.model = upstreamModel(route);
  anthropicBody.stream = stream;

  const r = await fetch(`${MINIMAX_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "anthropic-version": body.anthropic_version ?? "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new AuthError(`upstream HTTP ${r.status}`, `MiniMax 上游返回 ${r.status}：${text.slice(0, 300)}`, 502);
  }

  if (!stream) {
    const json = await r.json();
    const payload = dialect === "anthropic" ? json : anthropicToOpenAIResponse(json, upstreamModel(route));
    res.json(payload);
    return;
  }

  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "anthropic") {
    await pipeStream(r.body!, res);
    return;
  }
  try {
    for await (const chunk of anthropicStreamToOpenAI(r.body!, upstreamModel(route))) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/* ---------------- plumbing ---------------- */

/**
 * Look at the first chunk before committing to a 200 response.
 *
 * The gateway can report a failure inside a 200 response (an SSE error event, or
 * a 429 body). If the headers were already sent there is no way to turn that into
 * a proper status code, so the check happens first.
 */
async function peekStream(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done) {
    reader.releaseLock();
    return body;
  }
  const head = new TextDecoder().decode(first.value);
  if (head.includes('"error"') || head.includes("errorCode")) {
    const rest = await new Response(body).text();
    let message = rest.slice(0, 300);
    try {
      const parsed = JSON.parse(rest);
      const detail = parsed?.error ?? parsed;
      message = detail?.message ?? parsed?.message ?? message;
    } catch {
      /* keep the raw text */
    }
    throw new AuthError("upstream rejected the request", message, 502);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * Forward an OpenAI stream, frame by frame.
 *
 * The frames are parsed and written out again rather than copied, because an
 * upstream frame can be malformed — Qoder's last frame carries a raw newline
 * inside a string — and a client that cannot parse it loses the finish reason
 * and the usage with it.
 */
async function pipeOpenAIChunks(body: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  try {
    for await (const chunk of readOpenAIChunks(body)) {
      if (!writeSafe(res, sseData(chunk))) break;
    }
    writeSafe(res, SSE_DONE);
  } catch (e) {
    writeSafe(res, sseData({ error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" } }));
    writeSafe(res, SSE_DONE);
  }
}

async function pipeStream(body: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // The bytes go out as they came in: this path forwards the upstream's own
      // SSE, and decoding it would only risk breaking a character across chunks.
      if (!writeSafe(res, value)) break;
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function sendError(res: express.Response, e: unknown): void {
  const err = e as AuthError;
  if (e instanceof LimitError) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(503).json({
      error: { type: "api_error", message: e.message },
      hint: e.detail,
    });
    return;
  }
  const status = typeof err?.status === "number" ? err.status : 500;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    error: {
      // 503 means the credential is the problem; everything else is the request
      // or the upstream failing.
      type: status === 503 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error",
      message: err?.message ?? "request failed",
    },
    ...(err?.hint ? { hint: err.hint } : {}),
  });
}

app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
  console.log("");
  console.log(`  router listening on ${base}`);
  console.log(`    Anthropic  ${base}/v1/messages`);
  console.log(`    OpenAI     ${base}/v1/chat/completions`);
  console.log(`    Models     ${base}/v1/models`);
  console.log(`    Health     ${base}/health`);
  console.log("");
  console.log(`  upstreams:`);
  console.log(
    `    qoder    global=${ENABLED_QODER_GLOBAL ? `${QODER_GLOBAL.length} models` : "off"}` +
      `  cn=${ENABLED_QODER_CN ? `${QODER_CN.length} models` : "off"}`,
  );
  console.log(
    `    minimax  ${ENABLED_MINIMAX ? `${MINIMAX_BASE}  models=${MINIMAX_VISIBLE.length}` : "off"}`,
  );
  console.log(
    `    workbuddy cn=${ENABLED_WORKBUDDY_CN ? `${WORKBUDDY_CN.length} models` : "off"}`,
  );
  console.log(`  auth: ${REQUIRE_API_KEY ? "api key required" : "public"}`);
  console.log("");

  // The server owns the credentials. An enabled region with no session runs the
  // device flow here, in the background: the URL goes to the log and the operator
  // approves it. A region that is off is never looked at.
  for (const region of QODER_REGIONS) {
    void ensureQoderSession(region)
      .then((outcome) => {
        const s = qoderStatus(region);
        console.log(
          outcome === "logged-in"
            ? `  [AUTH] qoder ${region}: logged in`
            : `  [AUTH] qoder ${region}: session ok, expires in ${Math.round(Number(s.remainingSec ?? 0) / 60)} min`,
        );
        // A fresh session is worth a run right away.
        if (region === "cn") void runBenefitsOnce();
      })
      .catch((e) => console.warn(`  [AUTH] qoder ${region} login failed: ${(e as Error).message}`));
  }

  if (ENABLED_WORKBUDDY_CN) {
    void ensureWorkBuddySession()
      .then(async (outcome) => {
        const s = workbuddyStatus("cn");
        console.log(
          outcome === "logged-in"
            ? `  [AUTH] workbuddy cn: logged in`
            : `  [AUTH] workbuddy cn: session ok, expires in ${Math.round(Number(s.remainingSec ?? 0) / 60)} min`,
        );
        // The catalogue needs a token, so it comes after the login.
        await refreshWorkBuddyCatalog(true);
        console.log(`  [WORKBUDDY] catalogue: ${WORKBUDDY_CN.length} models`);
        // A fresh session is worth a run right away.
        void runBenefitsOnce();
      })
      .catch((e) => console.warn(`  [AUTH] workbuddy cn login failed: ${(e as Error).message}`));
  }

  // The daily benefits of the China accounts: the check-in, the growth centre
  // and the campaigns. The first run waits for the login above.
  scheduleBenefits();

  void PING_MS;
});
