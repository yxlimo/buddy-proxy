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
import { authenticate, loadKeys, REQUIRE_API_KEY } from "./lib/api-keys.ts";
import { readEnvFlag, readEnvNumber, readEnvString } from "./lib/env.ts";
import { AuthError } from "./lib/credential.ts";
import { LimitError } from "./lib/qoder/transport.ts";
import { QODER_MODELS, qoderModelsForRegion } from "./lib/qoder/models.ts";
import { MINIMAX_MODELS } from "./lib/minimax/models.ts";
import { fetchMiniMaxBalance, miniMaxTokenPlan } from "./lib/minimax/credits.ts";
import { credentialStatus, readCredential } from "./lib/minimax/auth.ts";
import { MINIMAX_UPSTREAM } from "./lib/minimax/gateway.ts";
import { tokenRhythmCatalogModels } from "./lib/router/catalog.ts";
import { TOKENRHYTHM_MODEL_IDS, TOKENRHYTHM_MODELS } from "./lib/tokenrhythm/models.ts";
import { tokenRhythmStatuses } from "./lib/tokenrhythm/accounts.ts";
import { qoderStatus, checkAccountHealth, fetchQoderCredits, type QoderAccountHealth, type QoderRegion } from "./lib/qoder/auth.ts";
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
  groupCatalog,
  openaiCatalog,
  qoderCatalogModels,
  workbuddyCatalogModels,
  minimaxCatalogModels,
  type CatalogGroup,
} from "./lib/router/catalog.ts";
import { fetchWorkBuddyCredits, type BenefitUpstream } from "./lib/benefits.ts";
import { BenefitsRunner } from "./lib/router/benefits.ts";

const PORT = readEnvNumber("ROUTER_PORT", 6450);
const HOST = readEnvString("ROUTER_HOST", "0.0.0.0");
// Which upstreams this router serves. Each flag turns on one reverse proxy; an
// upstream that is off is not looked at at all — no credential read, no login,
// no models advertised, and a request for one is refused with a clear message.
const ENABLED_MINIMAX = readEnvFlag("MINIMAX_CODE", false);
const MINIMAX_REGION = readEnvString("MINIMAX_REGION", "cn");
// How often the MiniMax credential is looked at, so a warning reaches the log
// even when nothing is being asked for.
const MINIMAX_WATCH_MS = readEnvNumber("MINIMAX_WATCH_MS", 5 * 60 * 1000);
const ENABLED_QODER_GLOBAL = readEnvFlag("QODER_GLOBAL", false);
const ENABLED_QODER_CN = readEnvFlag("QODER_CN", false);
const ENABLED_WORKBUDDY_CN = readEnvFlag("WORKBUDDY_CN", false);
const ENABLED_TOKENRHYTHM = readEnvFlag("TOKENRHYTHM", false);
const TOKENRHYTHM_MAX_ATTEMPTS = readEnvNumber("TOKENRHYTHM_MAX_ATTEMPTS", 3);

/* ------------------------------------------------------------------ *
 * The daily benefits of the China accounts
 * ------------------------------------------------------------------ */

/**
 * How often the check-in runs. The day rolls over at midnight in China.
 *
 * An hour, not a day: the Buddy trip lasts one to four hours, so a gift that
 * is already waiting would otherwise sit for hours after it arrived.
 */
const BENEFITS_INTERVAL_MS = Number(readEnvString("BENEFITS_INTERVAL_MS", "") || 60 * 60 * 1000);

/** The accounts that hand out credits and are switched on. */
function benefitUpstreams(): BenefitUpstream[] {
  if (readEnvFlag("BENEFITS_DISABLED", false)) return [];
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
const PING_MS = readEnvNumber("MINIMAX_PING_MS", 15000);
// The legacy endpoint queues models and reports 429 while a request waits. The
// CLI retries these, so the proxy does too — with the same shape.
const LEGACY_MAX_ATTEMPTS = readEnvNumber("QODER_LEGACY_ATTEMPTS", 3);
const LEGACY_RETRY_MS = readEnvNumber("QODER_LEGACY_RETRY_MS", 10000);
const QODER_MAX_ATTEMPTS = readEnvNumber("QODER_MAX_ATTEMPTS", 3);
const LOG_ROUTE = readEnvFlag("QODER_LOG_ROUTE", false);
// How long the upstream's own catalogue is trusted before it is fetched again.
const WORKBUDDY_CATALOG_TTL_MS = readEnvNumber("WORKBUDDY_CATALOG_TTL_MS", 30 * 60 * 1000);


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
      credits: await fetchQoderCredits(region),
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
      tokenrhythm: ENABLED_TOKENRHYTHM,
    },
    upstreams: {
      minimax: ENABLED_MINIMAX
        ? {
            base: MINIMAX_UPSTREAM,
            models: MINIMAX_VISIBLE.length,
            // What the MiniMax account has left: the money on the platform
            // account, and the plan's own windows.
            balance: await miniMaxBalance(),
            tokenPlan: await miniMaxTokenPlan(),
            // Which credential is in use and how much of it is left.
            credential: credentialStatus(),
          }
        : { enabled: false },
      qoder: { regions },
      workbuddy: ENABLED_WORKBUDDY_CN
        ? {
            region: "cn",
            models: WORKBUDDY_CN.length,
            credential: workbuddyStatus("cn"),
            credits: await fetchWorkBuddyCredits(),
          }
        : { enabled: false },
      tokenrhythm: ENABLED_TOKENRHYTHM
        ? {
            models: TOKENRHYTHM_MODELS.length,
            tenants: await tokenRhythmStatuses(),
          }
        : { enabled: false },
    },
    auth: REQUIRE_API_KEY ? "api-key" : "public",
    benefits: {
      enabled: benefitUpstreams().length > 0,
      intervalMs: BENEFITS_INTERVAL_MS,
      lastRunAt: benefits.lastRun.lastRunAt,
      running: benefits.lastRun.running,
      lastOutcome: benefits.lastRun.lastOutcome,
    },
  });
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
    const groups = catalogGroups();
    if (group) return res.json(groupCatalog(group, groups, dialect === "openai"));
    if (dialect === "openai") return res.json(openaiCatalog(groups));
    return res.json(anthropicCatalog(groups));
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
    const ctx = routingContext();
    route = group ? routeInGroup(group, String(body.model ?? "").trim(), ctx) : resolveRoute(body.model, ctx);
  } catch (e) {
    sendError(res, e);
    return;
  }

  const stream = body.stream === true;
  try {
    const ctx = upstreamContext();
    if (route.upstream === "qoder") {
      await toQoder(ctx, body, route, dialect, stream, res);
    } else if (route.upstream === "workbuddy") {
      await toWorkBuddy(ctx, body, route, dialect, stream, res);
    } else if (route.upstream === "tokenrhythm") {
      await toTokenRhythm(ctx, body, route, dialect, stream, res);
    } else {
      await toMinimax(ctx, body, route, dialect, stream, res);
    }
  } catch (e) {
    sendError(res, e);
  }
}

/* ---------------- plumbing ---------------- */

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
      // or the upstream failing. A failure that says otherwise says so.
      type:
        err?.type ??
        (status === 503 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error"),
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
