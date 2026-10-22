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

import { configString, configFlag, configNumber, logConfig, reloadConfig } from "./lib/config.ts";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { authenticate, loadKeys, REQUIRE_API_KEY } from "./lib/api-keys.ts";
import { readEnvFlag, readEnvNumber, readEnvString } from "./lib/env.ts";
import { deleteSecret, listSecrets, peekCached, setCached } from "./lib/store.ts";
import { AuthError } from "./lib/credential.ts";
import { LimitError } from "./lib/qoder/transport.ts";
import { QODER_MODELS, qoderModelsForRegion } from "./lib/qoder/models.ts";
import { MINIMAX_MODELS } from "./lib/minimax/models.ts";
import { fetchMiniMaxBalance, miniMaxTokenPlan } from "./lib/minimax/credits.ts";
import { credentialStatus, readCredential } from "./lib/minimax/auth.ts";
import { MINIMAX_UPSTREAM } from "./lib/minimax/transport.ts";
import { tokenRhythmCatalogModels } from "./lib/router/catalog.ts";
import { TOKENRHYTHM_MODEL_IDS, TOKENRHYTHM_MODELS } from "./lib/tokenrhythm/models.ts";
import { tokenRhythmStatuses } from "./lib/tokenrhythm/wallet.ts";
import { qoderStatus, type QoderRegion } from "./lib/qoder/auth.ts";
import { checkAccountHealth, fetchQoderCredits, type QoderAccountHealth } from "./lib/qoder/credits.ts";
import { workbuddyStatus } from "./lib/workbuddy/auth.ts";
import { fetchWorkBuddyCatalog } from "./lib/workbuddy/transport.ts";
import { workBuddyFallbackModels, type WorkBuddyModel } from "./lib/workbuddy/models.ts";
import { ensureMinimaxSession, ensureQoderSession, ensureWorkBuddySession } from "./lib/login.ts";
import {
  toMinimax,
  toQoder,
  toTokenRhythm,
  toWorkBuddy,
  type UpstreamContext,
} from "./lib/router/upstreams.ts";
import {
  resolveRoute,
  routeInGroup,
  UPSTREAM_GROUPS,
  type Route,
  type RoutingContext,
  type UpstreamGroup,
} from "./lib/router/routes.ts";
import {
  anthropicCatalog,
  aggregateAnthropicCatalog,
  aggregateCatalog,
  aggregateOpenAICatalog,
  groupCatalog,
  openaiCatalog,
  qoderCatalogModels,
  workbuddyCatalogModels,
  minimaxCatalogModels,
  type AggregateEntry,
  type CatalogGroup,
} from "./lib/router/catalog.ts";
import {
  aggregateModels,
  listAggregateUsage,
  recordAggregateUsage,
  reloadAggregate,
} from "./lib/aggregate.ts";
import { type BenefitUpstream } from "./lib/benefits.ts";
import { fetchWorkBuddyCredits } from "./lib/workbuddy/credits.ts";
import { BenefitsRunner } from "./lib/router/benefits.ts";

const PORT = configNumber("ROUTER_PORT", 6450);
const HOST = configString("ROUTER_HOST", "0.0.0.0");
// Which upstreams this router serves. Each flag turns on one reverse proxy; an
// upstream that is off is not looked at at all — no credential read, no login,
// no models advertised, and a request for one is refused with a clear message.
const ENABLED_MINIMAX = configFlag("MINIMAX_CODE", false);
const MINIMAX_REGION = configString("MINIMAX_REGION", "cn");
// How often the MiniMax credential is looked at, so a warning reaches the log
// even when nothing is being asked for.
const MINIMAX_WATCH_MS = configNumber("MINIMAX_WATCH_MS", 5 * 60 * 1000);
const ENABLED_QODER_GLOBAL = configFlag("QODER_GLOBAL", false);
const ENABLED_QODER_CN = configFlag("QODER_CN", false);
const ENABLED_WORKBUDDY_CN = configFlag("WORKBUDDY_CN", false);
const ENABLED_TOKENRHYTHM = configFlag("TOKENRHYTHM", false);
const TOKENRHYTHM_MAX_ATTEMPTS = configNumber("TOKENRHYTHM_MAX_ATTEMPTS", 3);

/* ------------------------------------------------------------------ *
 * The daily benefits of the China accounts
 * ------------------------------------------------------------------ */

/**
 * How often the check-in runs. The day rolls over at midnight in China.
 *
 * An hour, not a day: the Buddy trip lasts one to four hours, so a gift that
 * is already waiting would otherwise sit for hours after it arrived.
 */
const BENEFITS_INTERVAL_MS = Number(configString("BENEFITS_INTERVAL_MS", "") || 60 * 60 * 1000);

/** The accounts that hand out credits and are switched on. */
function benefitUpstreams(): BenefitUpstream[] {
  if (configFlag("BENEFITS_DISABLED", false)) return [];
  const out: BenefitUpstream[] = [];
  if (ENABLED_WORKBUDDY_CN) out.push("workbuddy-cn");
  if (ENABLED_QODER_CN) out.push("qoder-cn");
  if (ENABLED_QODER_GLOBAL) out.push("qoder-global");
  return out;
}

const benefits = new BenefitsRunner({ intervalMs: BENEFITS_INTERVAL_MS, upstreams: benefitUpstreams() });

const QODER_REGIONS: QoderRegion[] = [
  ...(ENABLED_QODER_GLOBAL ? (["global"] as QoderRegion[]) : []),
  ...(ENABLED_QODER_CN ? (["cn"] as QoderRegion[]) : []),
];
const PING_MS = configNumber("MINIMAX_PING_MS", 15000);
// The legacy endpoint queues models and reports 429 while a request waits. The
// CLI retries these, so the proxy does too — with the same shape.
const LEGACY_MAX_ATTEMPTS = configNumber("QODER_LEGACY_ATTEMPTS", 3);
const LEGACY_RETRY_MS = configNumber("QODER_LEGACY_RETRY_MS", 10000);
const QODER_MAX_ATTEMPTS = configNumber("QODER_MAX_ATTEMPTS", 3);
const LOG_ROUTE = configFlag("QODER_LOG_ROUTE", false);
// How long the upstream's own catalogue is trusted before it is fetched again.
const WORKBUDDY_CATALOG_TTL_MS = configNumber("WORKBUDDY_CATALOG_TTL_MS", 30 * 60 * 1000);


type Dialect = "anthropic" | "openai";

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

// `node router-proxy.ts --clear <id>` forgets one credential, so that the next
// start logs in again. It runs before anything else, so it touches nothing but
// the database.
const clearAt = process.argv.indexOf("--clear");
if (clearAt >= 0) {
  const id = process.argv[clearAt + 1] ?? "";
  if (!id) {
    console.error("usage: node router-proxy.ts --clear <credential-id>");
    console.error("the credentials in the database:");
    for (const row of listSecrets()) console.error(`  ${row.id}  (${row.kind})`);
    process.exit(1);
  }
  deleteSecret(id);
  console.log(`cleared ${id}`);
  process.exit(0);
}

const keys = loadKeys();
const app = new Koa();
const router = new Router();

// Every failure leaves in the shape the clients expect: a JSON body with an
// `error` object, not Koa's plain-text default.
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    sendError(ctx, e);
  }
});

// The body is only parsed once the caller is allowed in: a request with a bad
// key should not cost a megabyte of parsing.
const requireKey: Koa.Middleware = async (ctx, next) => {
  if (!authenticate(ctx.headers as Record<string, unknown>, keys)) {
    ctx.status = 401;
    ctx.body = { error: { type: "authentication_error", message: "invalid api key" } };
    return;
  }
  await next();
};
const parseBody = bodyParser({ enableTypes: ["json"], jsonLimit: "64mb" });

/**
 * The parts of /health that ask the upstreams.
 *
 * They are the slow part — a dozen calls to five different platforms — so they
 * are kept in the database and refreshed in the background. What the endpoint
 * answers with is the last known state, which is what a health check wants
 * anyway.
 */
interface HealthSnapshot {
  qoder: Record<string, { account: unknown; credits: unknown }>;
  minimax: { balance: unknown; tokenPlan: unknown };
  workbuddy: { credits: unknown };
  tokenrhythm: { tenants: unknown };
}

const HEALTH_CACHE_ID = "health:upstreams";
const HEALTH_CACHE_MS = configNumber("HEALTH_CACHE_MS", 300_000);
let healthRefresh: Promise<void> | null = null;

/** Ask the upstreams how they are, and remember the answer. */
async function refreshHealthSnapshot(): Promise<void> {
  const qoder: HealthSnapshot["qoder"] = {};
  for (const region of QODER_REGIONS) {
    let account: QoderAccountHealth | Record<string, unknown>;
    try {
      account = await checkAccountHealth(region);
    } catch (e) {
      account = { region, usable: false, reason: (e as Error)?.message };
    }
    qoder[region] = { account, credits: await fetchQoderCredits(region) };
  }
  const snapshot: HealthSnapshot = {
    qoder,
    minimax: { balance: await miniMaxBalance(), tokenPlan: await miniMaxTokenPlan() },
    workbuddy: { credits: await fetchWorkBuddyCredits() },
    tokenrhythm: { tenants: await tokenRhythmStatuses() },
  };
  setCached(HEALTH_CACHE_ID, snapshot);
}

/** The snapshot, and a refresh started if it is due. */
function healthSnapshot(): { data: HealthSnapshot | null; at: number; stale: boolean } {
  const cached = peekCached<HealthSnapshot>(HEALTH_CACHE_ID);
  const at = cached?.at ?? 0;
  const stale = !cached || Date.now() - at > HEALTH_CACHE_MS;
  if (stale && !healthRefresh) {
    healthRefresh = refreshHealthSnapshot()
      .catch((e) => console.warn(`[HEALTH] refresh failed: ${(e as Error)?.message}`))
      .finally(() => {
        healthRefresh = null;
      });
  }
  return { data: cached?.data ?? null, at, stale };
}

router.get("/health", async (ctx) => {
  const snapshot = healthSnapshot();
  const regions: Record<string, unknown> = {};
  for (const region of QODER_REGIONS) {
    regions[region] = {
      models: region === "cn" ? QODER_CN.length : QODER_GLOBAL.length,
      credential: qoderStatus(region),
      account: snapshot.data?.qoder?.[region]?.account ?? null,
      credits: snapshot.data?.qoder?.[region]?.credits ?? null,
    };
  }
  ctx.body = {
    status: "ok",
    dialects: ["anthropic", "openai"],
    enabled: {
      minimax: ENABLED_MINIMAX,
      qoderGlobal: ENABLED_QODER_GLOBAL,
      qoderCn: ENABLED_QODER_CN,
      workbuddyCn: ENABLED_WORKBUDDY_CN,
      tokenrhythm: ENABLED_TOKENRHYTHM,
    },
    upstreams: {
      minimax: ENABLED_MINIMAX
        ? {
            base: MINIMAX_UPSTREAM,
            models: MINIMAX_VISIBLE.length,
            // Which credential is in use and how much of it is left.
            credential: credentialStatus(),
            // What the account has left: the money on the platform account, and
            // the plan's own windows.
            balance: snapshot.data?.minimax?.balance ?? null,
            tokenPlan: snapshot.data?.minimax?.tokenPlan ?? null,
          }
        : { enabled: false },
      qoder: { regions },
      workbuddy: ENABLED_WORKBUDDY_CN
        ? {
            region: "cn",
            models: WORKBUDDY_CN.length,
            credential: workbuddyStatus("cn"),
            credits: snapshot.data?.workbuddy?.credits ?? null,
          }
        : { enabled: false },
      tokenrhythm: ENABLED_TOKENRHYTHM
        ? {
            models: TOKENRHYTHM_MODELS.length,
            tenants: snapshot.data?.tokenrhythm?.tenants ?? null,
          }
        : { enabled: false },
    },
    // The live part of the answer is cached; this says how old it is.
    snapshot: {
      at: snapshot.at ? new Date(snapshot.at).toISOString() : null,
      stale: snapshot.stale,
      refreshing: healthRefresh !== null,
      maxAgeMs: HEALTH_CACHE_MS,
    },
    auth: REQUIRE_API_KEY ? "api-key" : "public",
    benefits: {
      enabled: benefitUpstreams().length > 0,
      intervalMs: BENEFITS_INTERVAL_MS,
      lastRunAt: benefits.lastRun.lastRunAt,
      running: benefits.lastRun.running,
      lastOutcome: benefits.lastRun.lastOutcome,
    },
  };
});

/**
 * One upstream's catalogue, with the real model ids.
 *
 * A client that talks to one upstream does not need the prefix: the path says
 * which upstream it is, so the ids are the plain ones.
 */
/** The models of every enabled upstream, in the shape the list is built from. */
function catalogGroups(): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  if (QODER_GLOBAL.length) groups.push({ group: "qoder", models: qoderCatalogModels(QODER_GLOBAL) });
  if (QODER_CN.length) groups.push({ group: "qoder-cn", models: qoderCatalogModels(QODER_CN) });
  if (WORKBUDDY_CN.length) groups.push({ group: "workbuddy-cn", models: workbuddyCatalogModels(WORKBUDDY_CN) });
  if (MINIMAX_VISIBLE.length) groups.push({ group: "minimax", models: minimaxCatalogModels(MINIMAX_VISIBLE) });
  if (ENABLED_TOKENRHYTHM) groups.push({ group: "tokenrhythm", models: tokenRhythmCatalogModels() });
  return groups;
}

/** What the adapters need to know about the router they run in. */
function upstreamContext(): UpstreamContext {
  return {
    qoderRegions: QODER_REGIONS,
    legacyMaxAttempts: LEGACY_MAX_ATTEMPTS,
    legacyRetryMs: LEGACY_RETRY_MS,
    qoderMaxAttempts: QODER_MAX_ATTEMPTS,
    tokenRhythmMaxAttempts: TOKENRHYTHM_MAX_ATTEMPTS,
    logRoute: LOG_ROUTE,
    workbuddyMaxOutput: (model: string) => WORKBUDDY_CN.find((m) => m.id === model)?.maxOutput ?? 64000,
  };
}

/**
 * The MiniMax account's balance.
 *
 * The router holds the session, so it is the one that can ask the platform.
 */
async function miniMaxBalance(): Promise<unknown> {
  try {
    const cred = await readCredential();
    return await fetchMiniMaxBalance(cred.accessToken, MINIMAX_REGION === "en" ? "global" : "cn");
  } catch {
    return null;
  }
}

/** What the router is serving, and what it knows about. */
function routingContext(): RoutingContext {
  return {
    enabled: {
      minimax: ENABLED_MINIMAX,
      qoderGlobal: ENABLED_QODER_GLOBAL,
      qoderCn: ENABLED_QODER_CN,
      workbuddyCn: ENABLED_WORKBUDDY_CN,
      tokenrhythm: ENABLED_TOKENRHYTHM,
    },
    ids: {
      qoderGlobal: GLOBAL_QODER_IDS,
      qoderCn: CN_QODER_IDS,
      qoderHidden: QODER_HIDDEN_IDS,
      minimax: MINIMAX_MODEL_IDS,
      workbuddy: WORKBUDDY_CN_IDS,
      tokenrhythm: TOKENRHYTHM_MODEL_IDS,
    },
  };
}

/**
 * The models the root route publishes.
 *
 * With nothing configured in the database this is every upstream's models under
 * their prefixed name — the list the root route always showed. Once the
 * database holds a model, the database is the catalog.
 */
function aggregateEntries(): AggregateEntry[] {
  return aggregateCatalog(catalogGroups(), aggregateModels());
}

/** The published model a client asked for, if it is one of ours. */
function findAggregate(id: string): AggregateEntry | undefined {
  if (!id) return undefined;
  return aggregateEntries().find((e) => e.id === id);
}

/**
 * Send the request to the upstream behind a published model.
 *
 * With more than one target the first one that answers wins; the ones before
 * it failed, and every attempt is counted so the panel can show where the
 * traffic went and what it cost.
 */
async function handleAggregate(
  ctx: Koa.Context,
  entry: AggregateEntry,
  body: Record<string, any>,
  dialect: Dialect,
): Promise<void> {
  const stream = body.stream === true;
  const rctx = routingContext();
  let lastError: unknown = null;

  for (const target of entry.targets) {
    let route: Route;
    try {
      route = routeInGroup(target.group, target.upstreamModel, rctx);
    } catch (e) {
      lastError = e;
      recordAggregateUsage({
        modelId: entry.id,
        group: target.group,
        upstreamModel: target.upstreamModel,
        ok: false,
      });
      continue;
    }
    // The client asked for the published name; the answer says the same, even
    // though the upstream knows the model by another one.
    route.label = entry.id;

    let usage: any = null;
    const uctx = upstreamContext();
    uctx.onUsage = (u) => {
      usage = u;
    };
    try {
      await callUpstream(uctx, body, route, dialect, stream, ctx);
      recordAggregateUsage({
        modelId: entry.id,
        group: target.group,
        upstreamModel: target.upstreamModel,
        ok: true,
        promptTokens: usage?.prompt_tokens ?? usage?.input_tokens,
        completionTokens: usage?.completion_tokens ?? usage?.output_tokens,
      });
      return;
    } catch (e) {
      lastError = e;
      recordAggregateUsage({
        modelId: entry.id,
        group: target.group,
        upstreamModel: target.upstreamModel,
        ok: false,
      });
      // Once the answer has started there is nothing to fall back to.
      if (ctx.res.headersSent) break;
    }
  }
  sendError(
    ctx,
    lastError ?? new AuthError("no upstream answered", "这个模型的所有上游都没有响应。", 502),
  );
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

  router.post(`${base}/v1/messages`, requireKey, parseBody, async (ctx) => {
    await handle(ctx, "anthropic", group || undefined);
  });

  router.post(`${base}/v1/chat/completions`, requireKey, parseBody, async (ctx) => {
    await handle(ctx, "openai", group || undefined);
  });

  router.get(`${base}/v1/models`, (ctx) => {
    const dialect = String(ctx.query.dialect ?? "").toLowerCase();
    // The upstream's catalogue is the source of truth; fetch it in the background
    // so this answer is never blocked by it.
    if (ENABLED_WORKBUDDY_CN) void refreshWorkBuddyCatalog();
    const groups = catalogGroups();
    if (group) ctx.body = groupCatalog(group, groups, dialect === "openai");
    else {
      // The root route publishes one list: the aggregate.
      const entries = aggregateEntries();
      ctx.body = dialect === "openai" ? aggregateOpenAICatalog(entries) : aggregateAnthropicCatalog(entries);
    }
  });
}

app.use(router.routes());
app.use(router.allowedMethods());

/**
 * Read the configuration again.
 *
 * The settings and the published models are read once and then kept, so the
 * panel can change them without a restart. The panel calls this when it wants
 * the change to take effect now.
 */
router.post("/admin/reload", (ctx) => {
  const settings = reloadConfig();
  const models = reloadAggregate();
  console.log(`[RELOAD] ${settings} settings, ${models} published models`);
  ctx.body = { reloaded: true, settings, models };
});

/** What the traffic table holds, for the panel. */
router.get("/admin/usage", (ctx) => {
  ctx.body = { data: listAggregateUsage() };
});

async function handle(
  ctx: Koa.Context,
  dialect: Dialect,
  group?: UpstreamGroup,
): Promise<void> {
  const body = (ctx.request.body ?? {}) as Record<string, any>;

  // The root route serves the published models. With nothing configured in the
  // database those are the prefixed ones, so this is the old behaviour; once
  // the panel holds a model, the panel decides what the root route publishes.
  if (!group) {
    const entry = findAggregate(String(body.model ?? "").trim());
    if (entry) {
      await handleAggregate(ctx, entry, body, dialect);
      return;
    }
  }

  let route: Route;
  try {
    const rctx = routingContext();
    route = group ? routeInGroup(group, String(body.model ?? "").trim(), rctx) : resolveRoute(body.model, rctx);
  } catch (e) {
    sendError(ctx, e);
    return;
  }

  const stream = body.stream === true;
  try {
    await callUpstream(upstreamContext(), body, route, dialect, stream, ctx);
  } catch (e) {
    sendError(ctx, e);
  }
}

/** Hand the request to the upstream the route points at. */
async function callUpstream(
  uctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  ctx: Koa.Context,
): Promise<void> {
  if (route.upstream === "qoder") {
    await toQoder(uctx, body, route, dialect, stream, ctx);
  } else if (route.upstream === "workbuddy") {
    await toWorkBuddy(uctx, body, route, dialect, stream, ctx);
  } else if (route.upstream === "tokenrhythm") {
    await toTokenRhythm(uctx, body, route, dialect, stream, ctx);
  } else {
    await toMinimax(uctx, body, route, dialect, stream, ctx);
  }
}

/* ---------------- plumbing ---------------- */

function sendError(ctx: Koa.Context, e: unknown): void {
  const err = e as AuthError;
  if (e instanceof LimitError) {
    if (ctx.res.headersSent) {
      ctx.res.end();
      return;
    }
    ctx.status = 503;
    ctx.body = {
      error: { type: "api_error", message: e.message },
      hint: e.detail,
    };
    return;
  }
  const status = typeof err?.status === "number" ? err.status : 500;
  if (ctx.res.headersSent) {
    ctx.res.end();
    return;
  }
  ctx.status = status;
  ctx.body = {
    error: {
      // 503 means the credential is the problem; everything else is the request
      // or the upstream failing. A failure that says otherwise says so.
      type:
        err?.type ??
        (status === 503 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error"),
      message: err?.message ?? "request failed",
    },
    ...(err?.hint ? { hint: err.hint } : {}),
  };
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
    `    minimax  ${ENABLED_MINIMAX ? `${MINIMAX_UPSTREAM}  models=${MINIMAX_VISIBLE.length}` : "off"}`,
  );
  console.log(
    `    workbuddy cn=${ENABLED_WORKBUDDY_CN ? `${WORKBUDDY_CN.length} models` : "off"}`,
  );
  console.log(
    `    tokenrhythm ${ENABLED_TOKENRHYTHM ? `${TOKENRHYTHM_MODELS.length} models` : "off"}`,
  );
  console.log(`  auth: ${REQUIRE_API_KEY ? "api key required" : "public"}`);
  console.log("");

  // Where the settings came from: the database first, then the environment,
  // then the defaults in the code. A setting that is not the default is
  // printed, so a change in the database is visible in the log.
  logConfig();
  console.log("");

  // The server owns the credentials. An enabled region with no session runs the
  // device flow here, in the background: the URL goes to the log and the operator
  // approves it. A region that is off is never looked at.
  if (ENABLED_MINIMAX) {
    void ensureMinimaxSession()
      .then(async (outcome) => {
        const c = await readCredential();
        const state = `generation ${c.generation}, expires in ${Math.round(c.remainingMs / 60000)} min`;
        console.log(outcome === "logged-in" ? `  [AUTH] minimax: logged in: ${state}` : `  [AUTH] minimax: token ok: ${state}`);
      })
      .catch((e) => {
        const err = e as AuthError;
        console.warn(`  [AUTH] minimax: ${err.message}`);
        console.warn(`         ${err.hint}`);
      });

    // The live part of /health is asked for in the background, on a timer of
    // its own, so the endpoint has something to answer with even when nobody
    // looks at it.
    setInterval(() => {
      void refreshHealthSnapshot().catch((e) =>
        console.warn(`[HEALTH] refresh failed: ${(e as Error)?.message}`),
      );
    }, HEALTH_CACHE_MS);

    // A periodic watch, so a credential that is about to expire reaches the log
    // even when nothing is being asked for.
    let lastState = "";
    setInterval(
      () => {
        void readCredential()
          .then((c) => {
            const state = c.warning ? "warning" : "ok";
            if (state !== lastState) {
              lastState = state;
              console.log(
                `[AUTH] ${state}: generation ${c.generation}, ${Math.round(c.remainingMs / 60000)} min left`,
              );
            }
          })
          .catch((e) => {
            const err = e as AuthError;
            if (err.message !== lastState) {
              lastState = err.message;
              console.warn(`[AUTH] ${err.message}`);
              console.warn(`       ${err.hint}`);
            }
          });
      },
      MINIMAX_WATCH_MS,
    ).unref();
  }

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
        void benefits.runOnce();
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
        void benefits.runOnce();
      })
      .catch((e) => console.warn(`  [AUTH] workbuddy cn login failed: ${(e as Error).message}`));
  }

  if (ENABLED_TOKENRHYTHM) {
    void tokenRhythmStatuses()
      .then((tenants) => {
        for (const tenant of tenants) {
          const wallet = tenant.wallet;
          const gift = wallet ? `${wallet.availableCny} 元` : "未知";
          console.log(
            `  [TOKENRHYTHM] 租户 ${tenant.index} (${tenant.account}): 可用 ${gift}` +
              (tenant.error ? ` — ${tenant.error}` : ""),
          );
        }
      })
      .catch((e) => console.warn(`  [TOKENRHYTHM] 账号状态获取失败: ${(e as Error).message}`));
  }

  // The daily benefits of the China accounts: the check-in, the growth centre
  // and the campaigns. The first run waits for the login above.
  benefits.start();

  void PING_MS;
});
