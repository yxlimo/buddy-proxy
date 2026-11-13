// lib/router/app.ts — the Koa application: the middleware, the routes, and the
// panel's static files.
//
// The entry point only listens on this app; everything about how a request is
// answered before it reaches handle() lives here. Every failure leaves in the
// shape the clients expect, and every request leaves a line in the log.

import type { Json } from "../json.ts";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { authenticate, loadKeys, requireApiKey } from "../api-keys.ts";
import { allPlatforms, platformPolicies, platformPolicy } from "../platforms.ts";
import { listProviders } from "../providers.ts";
import { kindOf } from "../provider-kinds.ts";
import { detectAgent } from "../agent.ts";
// The panel: the Connect routes, the token, the static files.
import { CONNECT_PREFIX, connectMiddleware, hasWebDist, staticMiddleware, webDistDir } from "../admin/http.ts";
import { BENEFITS_INTERVAL_MS, benefitUpstreams, benefits } from "../admin/benefits.ts";
import {
  HEALTH_CACHE_MS,
  outOfCredits,
  healthRefreshing,
  healthSnapshot,
  snapshotEntry,
} from "../admin/upstreams.ts";
import { sendError } from "./deliver.ts";
import { handle } from "./handle.ts";
import { listCooldowns, type CooldownRow } from "../cooldown.ts";
import { serveModels } from "./catalog-routes.ts";
import { platformAvailabilities } from "./availability.ts";

const keys = loadKeys();
export const app = new Koa();
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
 *
 * The shape follows the account model: a platform is a template in the code,
 * and what it can serve depends on whether any of its accounts is on. So every
 * platform is listed, with its policy and its accounts — a platform with no
 * account is there too, saying so.
 */
router.get("/health", async (ctx) => {
  const snapshot = healthSnapshot();
  // 冷却在回答之前就要知道：面板说 READY、网关说 503「冷却中」，两边对不上，
  // 排查的人只能猜。冷却是按账号记的，所以放在账号那一行上。
  const cooldowns = new Map(listCooldowns().map((row) => [row.providerId, row]));
  const platforms: Record<string, unknown> = {};
  // allPlatforms() 每次调用读一次 platform 表（开放平台在那张表里）。
  const templates = allPlatforms();
  // 同一批表在这个请求里只读一遍：可用性算一次，下面都用它。
  const availabilities = platformAvailabilities(templates);
  const rows = listProviders();
  for (const template of templates) {
    const kind = kindOf(template.kind);
    const accounts = rows.filter((row) => row.platform === template.id);
    const availability = availabilities.get(template.id);
    platforms[template.id] = {
      id: template.id,
      label: template.label,
      kind: template.kind,
      region: template.region,
      // 有开着的、凭据可用的账号才算开着。
      enabled: (availability?.serving.length ?? 0) > 0,
      // 现在是什么状态、为什么：只看 enabled 看不出是「没账号」「账号都关着」
      // 还是「没凭据」—— 三件要改的地方不一样（判定住在 admin 层，
      // lib/admin/platform-state.ts，这里只是把它的话带出来）。
      state: availability?.state ?? "no_account",
      reason: availability?.reason ?? "",
      policy: platformPolicy(template.id),
      policies: platformPolicies(template.id),
      base: kind && accounts.length ? safe(() => kind.baseUrl(accounts[0])) : null,
      models: availability?.ids.length ?? 0,
      // 一个账号一行：凭据、额度、快照都在它自己身上。
      accounts: accounts.map((row) => ({
        id: row.id,
        alias: row.alias,
        enabled: row.enabled,
        credential: kind ? safe(() => kind.credential(row)) : null,
        outOfCredits: safe(() => outOfCredits(row.id)) ?? false,
        // 这个账号现在在不在冷却里，到什么时候为止，为什么。
        cooldown: cooldownOf(cooldowns, row.id),
        snapshot: snapshotOf(snapshot.data, template.kind, row.id),
      })),
    };
  }
  ctx.body = {
    status: "ok",
    dialects: ["anthropic", "openai"],
    // 平台与开关：客户端脚本与面板用得上的是「这个平台现在服务不服务」。
    // state 是为什么：没账号、账号都关着、没凭据、额度用尽、冷却 —— 运维要
    // 看得见是哪一件。
    providers: templates.map((template) => ({
      id: template.id,
      name: template.label,
      kind: template.kind,
      enabled: (availabilities.get(template.id)?.serving.length ?? 0) > 0,
      state: availabilities.get(template.id)?.state ?? "no_account",
      accounts: availabilities.get(template.id)?.accounts ?? 0,
    })),
    upstreams: platforms,
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
 * 这个账号的冷却：到什么时候为止，为什么。
 *
 * 没有在冷却里就是 null。冷却的行可以在而已经过期 —— 过期是读的时候才判的，
 * 所以这里只把还在冷却里的账号报出来。
 */
function cooldownOf(
  cooldowns: Map<string, CooldownRow>,
  accountId: string,
): { untilMs: number; reason: string } | null {
  const row = cooldowns.get(accountId);
  if (!row) return null;
  return { untilMs: row.untilMs, reason: row.reason };
}

/** 快照里一个账号的那一段：只有模拟客户端的会话有自己的桶。 */
const SNAPSHOT_BUCKET: Record<string, string> = {
  minimax: "minimax",
  zcode: "zcode",
  qoder: "qoder",
  workbuddy: "workbuddy",
};

/** 一个账号的健康快照，没有就是 null。 */
function snapshotOf(data: unknown, kind: string, accountId: string): Json | null {
  const bucket = SNAPSHOT_BUCKET[kind];
  if (!bucket) return null;
  return snapshotEntry(data as Parameters<typeof snapshotEntry>[0], bucket, accountId);
}

/**
 * 读状态时一处出错不该让整个 /health 挂掉：一个没登录的账号是正常的，
 * 不是服务的错误。
 */
function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
/**
 * The same endpoints, once per upstream.
 *
 * The plain `/v1/...` form takes the upstream in the model name
 * (`qoder-cn/glm-5.3`); the prefixed form takes it in the path
 * (`/qoder-cn/v1/messages`) and the model name is the real one.
 */
for (const base of ["", "/:platform"]) {
  router.post(`${base}/v1/messages`, requireKey, parseBody, async (ctx) => {
    // The root route serves the published models in both dialects. The model
    // name in the body is the published one; the path prefix, when there is
    // one, names the platform.
    await handle(ctx, "anthropic", String(ctx.params.platform ?? "") || undefined);
  });

  router.post(`${base}/v1/chat/completions`, requireKey, parseBody, async (ctx) => {
    await handle(ctx, "openai", String(ctx.params.platform ?? "") || undefined);
  });

  router.get(`${base}/v1/models`, serveModels);
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
