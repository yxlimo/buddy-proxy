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

import { configString, configFlag, configNumber, logConfig } from "./lib/config.ts";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { authenticate, loadKeys, requireApiKey } from "./lib/api-keys.ts";
import { deleteSecret, listSecrets } from "./lib/store.ts";
import { AuthError } from "./lib/credential.ts";
import { LimitError } from "./lib/qoder/transport.ts";
import { QODER_MODELS } from "./lib/qoder/models.ts";
import { MINIMAX_MODELS } from "./lib/minimax/models.ts";
import { credentialStatus, readCredential } from "./lib/minimax/auth.ts";
import { MINIMAX_UPSTREAM } from "./lib/minimax/transport.ts";
import { TOKENRHYTHM_MODEL_IDS, TOKENRHYTHM_MODELS } from "./lib/tokenrhythm/models.ts";
import { tokenRhythmStatuses } from "./lib/tokenrhythm/wallet.ts";
import { qoderStatus } from "./lib/qoder/auth.ts";
import { workbuddyStatus } from "./lib/workbuddy/auth.ts";
import { fetchWorkBuddyCatalog } from "./lib/workbuddy/transport.ts";
import { ensureMinimaxSession, ensureQoderSession, ensureWorkBuddySession } from "./lib/login.ts";
import {
  ensureSenseNovaKey,
  refreshSenseNovaCatalog,
  senseNovaCatalog,
  senseNovaInferenceKey,
  senseNovaModelIds,
} from "./lib/sensenova/transport.ts";
import { loadSession as loadSenseNovaSession } from "./lib/sensenova/auth.ts";
import { SENSENOVA_INFER_BASE } from "./lib/sensenova/config.ts";
import {
  ensureInternAiKey,
  internAiCatalog,
  internAiInferenceKey,
  internAiModelIds,
  refreshInternAiCatalog,
} from "./lib/intern-ai/transport.ts";
import { loadSession as loadInternAiSession } from "./lib/intern-ai/auth.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "./lib/intern-ai/config.ts";
import {
  toMinimax,
  toQoder,
  toTokenRhythm,
  toWorkBuddy,
  toSenseNova,
  toInternAi,
  type UpstreamContext,
} from "./lib/router/upstreams.ts";
import {
  routeInGroup,
  UPSTREAM_GROUPS,
  type Route,
  type RoutingContext,
  type UpstreamGroup,
} from "./lib/router/routes.ts";
import {
  aggregateAnthropicCatalog,
  aggregateCatalog,
  aggregateOpenAICatalog,
  groupCatalog,
  type AggregateEntry,
} from "./lib/router/catalog.ts";
import { aggregateModels, recordAggregateUsage } from "./lib/aggregate.ts";
import { recordUsage, pruneUsage } from "./lib/usage.ts";
import { detectAgent } from "./lib/agent.ts";
// The panel: the Connect routes, the token, the static files.
import { adminToken } from "./lib/admin/token.ts";
import { CONNECT_PREFIX, connectMiddleware, hasWebDist, staticMiddleware, webDistDir } from "./lib/admin/http.ts";
import { BENEFITS_INTERVAL_MS, benefitUpstreams, benefits } from "./lib/admin/benefits.ts";
import {
  HEALTH_CACHE_MS,
  QODER_CN_ALL,
  QODER_GLOBAL_ALL,
  catalogGroups,
  healthRefreshing,
  healthSnapshot,
  minimaxVisible,
  qoderRegions,
  qoderVisible,
  refreshHealthSnapshot,
  setWorkbuddyCatalog,
  upstreamEnabled,
  workbuddyCatalog,
  workbuddyModelIds,
} from "./lib/admin/upstreams.ts";

const PORT = configNumber("ROUTER_PORT", 6450);
const HOST = configString("ROUTER_HOST", "0.0.0.0");
// How often the MiniMax credential is looked at, so a warning reaches the log
// even when nothing is being asked for.
const MINIMAX_WATCH_MS = configNumber("MINIMAX_WATCH_MS", 5 * 60 * 1000);
const TOKENRHYTHM_MAX_ATTEMPTS = configNumber("TOKENRHYTHM_MAX_ATTEMPTS", 3);

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
// The models a region can serve, whether the region is on or not.
const GLOBAL_QODER_IDS = new Set(QODER_GLOBAL_ALL.map((m) => m.id));
const CN_QODER_IDS = new Set(QODER_CN_ALL.map((m) => m.id));
/**
 * The models that are not published right now.
 *
 * The switches are hot, so this is computed per request: a region that is
 * turned off has its models hidden, and the answer says "that region is off"
 * rather than "no such model".
 */
function qoderHiddenIds(): Set<string> {
  const visible = new Set([...qoderVisible("global"), ...qoderVisible("cn")].map((m) => m.id));
  return new Set(QODER_MODELS.filter((m) => !visible.has(m.id)).map((m) => m.id));
}
// WorkBuddy's models are addressed by prefix only: several of them (glm-5.3,
// kimi-k2.8-preview) carry the same name as a Qoder model, so a bare name
// would be ambiguous. The list starts as the bundled snapshot and is replaced
// by the upstream's own catalogue as soon as it can be fetched. The catalogue
// itself lives in lib/admin/upstreams.ts, because the health endpoint and the
// panel look at the same one.
let workbuddyCatalogAt = 0;

/** The upstream catalogue, refreshed at most every half hour. */
async function refreshWorkBuddyCatalog(force = false): Promise<void> {
  if (!upstreamEnabled("workbuddy-cn")) return;
  const age = Date.now() - workbuddyCatalogAt;
  if (!force && workbuddyCatalogAt && age < WORKBUDDY_CATALOG_TTL_MS) return;
  try {
    const models = await fetchWorkBuddyCatalog("cn");
    if (models?.length) {
      setWorkbuddyCatalog(models);
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

// 每个请求留一行。
//
// 排查的时候先看日志 —— 没有这行，失败请求的状态码在日志里就看不见了，
// 只能靠猜或者去翻别的服务。聚合路由的成败另外记在用量表里，
// 但各上游自己那条路（/qoder/v1/…）只有这里能看到。
app.use(async (ctx, next) => {
  const started = Date.now();
  await next();
  const body = ctx.request.body as Record<string, unknown> | undefined;
  const model = typeof body?.model === "string" ? body.model : "";
  const ms = Date.now() - started;
  const status = ctx.status;
  // 上游自己的路径（/qoder/v1/…）的前缀就是上游是谁；根路由是按模型名分的，
  // 模型名已经在那一栏了，不用再说一遍。
  const first = ctx.path.replace(/^\//, "").split("/")[0];
  const via = first === "v1" || first === "admin" || first === "health" ? "" : first;
  // 谁发来的：pi、opencode、dsh……排查的时候一眼看出是哪边在打。
  const agent = detectAgent(ctx.request.headers).name;
  const line = `${ctx.method} ${ctx.path}${model ? ` model=${model}` : ""} → ${status} ${ms}ms${via ? ` via=${via}` : ""} from=${agent}`;
  // 失败的两级：5xx 是服务自己的问题，4xx 是请求本身的问题。
  if (status >= 500) console.error(`[REQ] ${line}`);
  else if (status >= 400) console.warn(`[REQ] ${line}`);
  else console.log(`[REQ] ${line}`);
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
 * The parts of /health that ask the upstreams live in lib/admin/upstreams.ts,
 * because the management panel needs the same answers.
 */
router.get("/health", async (ctx) => {
  const snapshot = healthSnapshot();
  const regions: Record<string, unknown> = {};
  for (const region of qoderRegions()) {
    regions[region] = {
      models: qoderVisible(region).length,
      credential: qoderStatus(region),
      account: snapshot.data?.qoder?.[region]?.account ?? null,
      credits: snapshot.data?.qoder?.[region]?.credits ?? null,
    };
  }
  ctx.body = {
    status: "ok",
    dialects: ["anthropic", "openai"],
    enabled: {
      minimax: upstreamEnabled("minimax"),
      qoderGlobal: upstreamEnabled("qoder"),
      qoderCn: upstreamEnabled("qoder-cn"),
      workbuddyCn: upstreamEnabled("workbuddy-cn"),
      tokenrhythm: upstreamEnabled("tokenrhythm"),
      sensenova: upstreamEnabled("sensenova"),
      internAi: upstreamEnabled("intern-ai"),
    },
    upstreams: {
      minimax: upstreamEnabled("minimax")
        ? {
            base: MINIMAX_UPSTREAM,
            models: minimaxVisible().length,
            // Which credential is in use and how much of it is left.
            credential: credentialStatus(),
            // What the account has left: the money on the platform account, and
            // the plan's own windows.
            balance: snapshot.data?.minimax?.balance ?? null,
            tokenPlan: snapshot.data?.minimax?.tokenPlan ?? null,
          }
        : { enabled: false },
      qoder: { regions },
      workbuddy: upstreamEnabled("workbuddy-cn")
        ? {
            region: "cn",
            models: workbuddyCatalog().length,
            credential: workbuddyStatus("cn"),
            credits: snapshot.data?.workbuddy?.credits ?? null,
          }
        : { enabled: false },
      tokenrhythm: upstreamEnabled("tokenrhythm")
        ? {
            models: TOKENRHYTHM_MODELS.length,
            tenants: snapshot.data?.tokenrhythm?.tenants ?? null,
          }
        : { enabled: false },
      sensenova: upstreamEnabled("sensenova")
        ? {
            base: SENSENOVA_INFER_BASE,
            models: senseNovaCatalog().length,
            // 推理端点要的是 key，不是 cookie。
            credential: senseNovaInferenceKey() ? "api_key" : "missing",
            pools: snapshot.data?.sensenova?.pools ?? null,
          }
        : { enabled: false },
      internAi: upstreamEnabled("intern-ai")
        ? {
            base: INTERN_AI_DISCOVERY_API_BASE,
            models: internAiCatalog().length,
            credential: internAiInferenceKey() ? "api_key" : "missing",
            balance: snapshot.data?.internAi?.balance ?? null,
            packs: snapshot.data?.internAi?.packs ?? null,
          }
        : { enabled: false },
    },
    // The live part of the answer is cached; this says how old it is.
    snapshot: {
      at: snapshot.at ? new Date(snapshot.at).toISOString() : null,
      stale: snapshot.stale,
      refreshing: healthRefreshing(),
      maxAgeMs: HEALTH_CACHE_MS,
    },
    auth: requireApiKey() ? "api-key" : "public",
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
 * One upstream's catalogue, with the real model ids, is in
 * lib/admin/upstreams.ts — the health endpoint and the panel want the same one.
 */

/** What the adapters need to know about the router they run in. */
function upstreamContext(): UpstreamContext {
  const uctx: UpstreamContext = {
    qoderRegions: qoderRegions(),
    legacyMaxAttempts: LEGACY_MAX_ATTEMPTS,
    legacyRetryMs: LEGACY_RETRY_MS,
    qoderMaxAttempts: QODER_MAX_ATTEMPTS,
    tokenRhythmMaxAttempts: TOKENRHYTHM_MAX_ATTEMPTS,
    logRoute: LOG_ROUTE,
    workbuddyMaxOutput: (model: string) => workbuddyCatalog().find((m) => m.id === model)?.maxOutput ?? 64000,
    workbuddyModel: (model: string) => workbuddyCatalog().find((m) => m.id === model) ?? null,
  };
  // Keep the last usage the upstream reported, so the caller can write it down
  // once the call is over.
  uctx.onUsage = (u) => {
    uctx.lastUsage = u;
  };
  return uctx;
}

/** What the router is serving, and what it knows about. */
function routingContext(): RoutingContext {
  return {
    enabled: {
      minimax: upstreamEnabled("minimax"),
      qoderGlobal: upstreamEnabled("qoder"),
      qoderCn: upstreamEnabled("qoder-cn"),
      workbuddyCn: upstreamEnabled("workbuddy-cn"),
      tokenrhythm: upstreamEnabled("tokenrhythm"),
      sensenova: upstreamEnabled("sensenova"),
      internAi: upstreamEnabled("intern-ai"),
    },
    ids: {
      qoderGlobal: GLOBAL_QODER_IDS,
      qoderCn: CN_QODER_IDS,
      qoderHidden: qoderHiddenIds(),
      minimax: MINIMAX_MODEL_IDS,
      workbuddy: workbuddyModelIds(),
      tokenrhythm: TOKENRHYTHM_MODEL_IDS,
      sensenova: senseNovaModelIds(),
      internAi: internAiModelIds(),
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

  // single 只走权重最大的那一个，失败了就是失败了 —— 面板上写着 single，
  // 流量却悄悄跑到别的账号上，那就跟面板说的不是一回事。
  // fallback 才试下一个。
  const targets = entry.strategy === "fallback" ? entry.targets : entry.targets.slice(0, 1);

  for (const target of targets) {
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

    const uctx = upstreamContext();
    try {
      await callUpstream(uctx, body, route, dialect, stream, ctx);
      const usage = uctx.lastUsage;
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
    if (!group) {
      // The published models are served in the OpenAI dialect only.
      ctx.status = 404;
      ctx.body = {
        error: { type: "invalid_request_error", message: "the root route speaks the OpenAI dialect only" },
        hint: `用 OpenAI 方言：POST /v1/chat/completions，或者用某个上游自己的路径：${UPSTREAM_GROUPS.map((g) => `/${g}/v1/messages`).join("、")}`,
      };
      return;
    }
    await handle(ctx, "anthropic", group);
  });

  router.post(`${base}/v1/chat/completions`, requireKey, parseBody, async (ctx) => {
    await handle(ctx, "openai", group || undefined);
  });

  router.get(`${base}/v1/models`, (ctx) => {
    const dialect = String(ctx.query.dialect ?? "").toLowerCase();
    // The upstream's catalogue is the source of truth; fetch it in the background
    // so this answer is never blocked by it.
    if (upstreamEnabled("workbuddy-cn")) void refreshWorkBuddyCatalog();
    if (upstreamEnabled("sensenova")) void refreshSenseNovaCatalog();
    if (upstreamEnabled("intern-ai")) void refreshInternAiCatalog();
    const groups = catalogGroups();
    if (group) {
      ctx.body = groupCatalog(group, groups, dialect === "openai");
      return;
    }
    // The root route publishes one list: the models the database says it
    // publishes. With nothing in the database there is no list to give.
    const entries = aggregateEntries();
    if (!entries.length) {
      ctx.status = 404;
      ctx.body = {
        error: { type: "invalid_request_error", message: "no published models" },
        hint: "根路由还没有发布任何模型。在面板里配置并保存后生效。",
      };
      return;
    }
    ctx.body = dialect === "openai" ? aggregateOpenAICatalog(entries) : aggregateAnthropicCatalog(entries);
  });
}

/**
 * The panel's API: Connect over HTTP.
 *
 * The path is the Connect standard one — POST /buddy.admin.v1.AdminService/<方法>
 * — and the token goes in the Authorization header. The JSON routes that used
 * to live here (/admin/reload, /admin/usage, /admin/models) are gone: those
 * are in the contract now.
 */
router.all(`${CONNECT_PREFIX}/:method`, connectMiddleware());

/**
 * The panel's own files.
 *
 * The frontend is a single-page app, so a deep link falls back to index.html
 * and the frontend's router sorts it out. When web/dist is not there yet there
 * is nothing to serve, and the API works all the same.
 */
if (hasWebDist()) {
  app.use(staticMiddleware(webDistDir()));
}

app.use(router.routes());
app.use(router.allowedMethods());

async function handle(
  ctx: Koa.Context,
  dialect: Dialect,
  group?: UpstreamGroup,
): Promise<void> {
  const body = (ctx.request.body ?? {}) as Record<string, any>;

  // The root route serves the published models and nothing else: the database
  // decides which models exist and which upstream serves them.
  if (!group) {
    const wanted = String(body.model ?? "").trim();
    const entry = findAggregate(wanted);
    if (!entry) {
      ctx.status = 404;
      ctx.body = {
        error: { type: "invalid_request_error", message: `unknown model "${wanted}"` },
        hint: "根路由只服务面板里发布出来的模型。在面板里配置并保存后生效。",
      };
      return;
    }
    await handleAggregate(ctx, entry, body, dialect);
    return;
  }

  let route: Route;
  try {
    const rctx = routingContext();
    route = routeInGroup(group!, String(body.model ?? "").trim(), rctx);
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
  const started = Date.now();
  const agent = detectAgent(ctx.request.headers).name;
  try {
    if (route.upstream === "qoder") {
      await toQoder(uctx, body, route, dialect, stream, ctx);
    } else if (route.upstream === "workbuddy") {
      await toWorkBuddy(uctx, body, route, dialect, stream, ctx);
    } else if (route.upstream === "tokenrhythm") {
      await toTokenRhythm(uctx, body, route, dialect, stream, ctx);
    } else if (route.upstream === "sensenova") {
      await toSenseNova(uctx, body, route, dialect, stream, ctx);
    } else if (route.upstream === "intern-ai") {
      await toInternAi(uctx, body, route, dialect, stream, ctx);
    } else {
      await toMinimax(uctx, body, route, dialect, stream, ctx);
    }
    recordRequestUsage(body, route, agent, uctx, ctx.status || 200, started, "");
  } catch (e) {
    const err = e as AuthError;
    const status = typeof err?.status === "number" ? err.status : 500;
    recordRequestUsage(body, route, agent, uctx, status, started, err?.message ?? String(e));
    throw e;
  }
}

/**
 * 记下这一条请求。
 *
 * 每条走过的请求都记：哪个上游、哪个模型、客户端要的是什么、谁发来的、
 * 成功还是失败、用了多少令牌。面板的用量页和「今日用量」从这张表出。
 */
function recordRequestUsage(
  body: Record<string, any>,
  route: Route,
  agent: string,
  uctx: UpstreamContext,
  status: number,
  started: number,
  error: string,
): void {
  const usage = uctx.lastUsage ?? {};
  const upstreamModel = route.model.includes("/")
    ? route.model.slice(route.model.indexOf("/") + 1)
    : route.model;
  recordUsage({
    upstreamId: providerId(route),
    upstreamModel,
    agentModel: String(body.model ?? route.label ?? upstreamModel),
    agent,
    client: route.upstream,
    ok: !error && status < 400,
    status,
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    reasoningTokens: Number(
      usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
    ),
    latencyMs: Date.now() - started,
    error,
  });
}

/** 面板里的上游 id：Qoder 按区分全球区与中国区。 */
function providerId(route: Route): string {
  if (route.upstream === "qoder") return route.region === "cn" ? "qoder-cn" : "qoder";
  if (route.upstream === "workbuddy") return "workbuddy-cn";
  return route.upstream;
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
  // The panel's token: generated once, kept in the data directory. The
  // operator reads it from the file and hands it to the panel.
  adminToken();
  // The usage log grows one row per request, so old rows go. Ninety days is
  // enough for "today" and the monthly view.
  const pruned = pruneUsage(90);
  if (pruned > 0) console.log(`  [USAGE] 丢掉了 ${pruned} 条超过 90 天的用量记录`);
  console.log("");
  console.log(`  router listening on ${base}`);
  console.log(`    Anthropic  ${base}/v1/messages`);
  console.log(`    OpenAI     ${base}/v1/chat/completions`);
  console.log(`    Models     ${base}/v1/models`);
  console.log(`    Health     ${base}/health`);
  console.log(`    Panel      ${base}/admin${hasWebDist() ? "" : " (还没有构建产物)"}`);
  console.log(`    Admin API  ${base}${CONNECT_PREFIX}/<Method>  (Bearer 令牌)`);
  console.log("");
  console.log(`  upstreams:`);
  console.log(
    `    qoder    global=${upstreamEnabled("qoder") ? `${qoderVisible("global").length} models` : "off"}` +
      `  cn=${upstreamEnabled("qoder-cn") ? `${qoderVisible("cn").length} models` : "off"}`,
  );
  console.log(
    `    minimax  ${upstreamEnabled("minimax") ? `${MINIMAX_UPSTREAM}  models=${minimaxVisible().length}` : "off"}`,
  );
  console.log(
    `    workbuddy cn=${upstreamEnabled("workbuddy-cn") ? `${workbuddyCatalog().length} models` : "off"}`,
  );
  console.log(
    `    tokenrhythm ${upstreamEnabled("tokenrhythm") ? `${TOKENRHYTHM_MODELS.length} models` : "off"}`,
  );
  // 这两个的目录是启动后从上游问来的（要拿推理 key、要问平台），所以这里只说
  // 「正在取」——数目在下面的日志里。
  console.log(`    sensenova ${upstreamEnabled("sensenova") ? "loading" : "off"}`);
  console.log(`    intern-ai ${upstreamEnabled("intern-ai") ? "loading" : "off"}`);
  console.log(`  auth: ${requireApiKey() ? "api key required" : "public"}`);
  console.log("");

  // Where the settings came from: the database first, then the environment,
  // then the defaults in the code. A setting that is not the default is
  // printed, so a change in the database is visible in the log.
  logConfig();
  console.log("");

  // The server owns the credentials. An enabled region with no session runs the
  // device flow here, in the background: the URL goes to the log and the operator
  // approves it. A region that is off is never looked at.
  if (upstreamEnabled("minimax")) {
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

  for (const region of qoderRegions()) {
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

  if (upstreamEnabled("workbuddy-cn")) {
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
        console.log(`  [WORKBUDDY] catalogue: ${workbuddyCatalog().length} models`);
        // A fresh session is worth a run right away.
        void benefits.runOnce();
      })
      .catch((e) => console.warn(`  [AUTH] workbuddy cn login failed: ${(e as Error).message}`));
  }

  if (upstreamEnabled("tokenrhythm")) {
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

  if (upstreamEnabled("sensenova")) {
    // 推理端点要的是一把 key，不是 cookie。账号上有会话却没有 key 的（老版本
    // 登录留下的），在这里补一把 —— 登录完了上游才是 READY 的。
    void (async () => {
      const session = loadSenseNovaSession();
      if (!session) {
        console.log("  [SENSENOVA] 还没有登录态");
        return;
      }
      await ensureSenseNovaKey(session);
      await refreshSenseNovaCatalog(true);
      console.log(`  [SENSENOVA] 模型清单：${senseNovaCatalog().length} 个`);
    })().catch((e) => console.warn(`  [SENSENOVA] ${(e as Error).message}`));
  }

  if (upstreamEnabled("intern-ai")) {
    // 与 SenseNova 一样：推理端点认的是 Discovery 子站那把 key。
    void (async () => {
      const session = loadInternAiSession();
      if (!session) {
        console.log("  [INTERN-AI] 还没有登录态");
        return;
      }
      await ensureInternAiKey(session);
      await refreshInternAiCatalog(true);
      console.log(`  [INTERN-AI] 模型目录：${internAiCatalog().length} 个`);
    })().catch((e) => console.warn(`  [INTERN-AI] ${(e as Error).message}`));
  }

  // The daily benefits of the China accounts: the check-in, the growth centre
  // and the campaigns. The first run waits for the login above.
  benefits.start();

  void PING_MS;
});
