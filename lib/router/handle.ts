// lib/router/handle.ts — the request itself: where it goes, how it is written
// back, and what is recorded about it.
//
// Two shapes of request arrive here. The root route names a published model and
// the database says which targets serve it (handleAggregate); the prefixed route
// names the platform in the path and the model is the real one (handle). Both
// end at callUpstream, which hands the request to the adapter of the platform's
// kind.
//
// The answer is written to the client as the adapter delivers it, so once it has
// started there is nothing left to fall back to: a failure after that point ends
// the response instead of trying the next target.

import type { Json } from "../json.ts";
import Koa from "koa";
import { configFlag, configNumber } from "../config.ts";
import { AuthError } from "../credential.ts";
import { LimitError } from "../qoder/transport.ts";
import { PLATFORMS, platformOf } from "../platforms.ts";
import { accountsOfPlatform, type ProviderRow } from "../providers.ts";
import { cooldownUntil, isCoolingDown, unavailableCooldownMs } from "../cooldown.ts";
import { planWindowEndsAt } from "./account-cooldown.ts";
import { kindOf } from "../provider-kinds.ts";
import { recordAggregateUsage } from "../aggregate.ts";
import type { AggregateEntry } from "./catalog.ts";
import { select, SelectionStop, byWeight } from "./selection.ts";
import { describeUpstreamError } from "./provider-selection.ts";
import { recordUsage, maxTotals, usageTotals } from "../usage.ts";
import { clientSessionHeaders, detectAgent, detectSession, type SessionInfo } from "../agent.ts";
import { outOfCredits, workbuddyCatalog } from "../admin/upstreams.ts";
import {
  toMinimax,
  toMiniMaxApi,
  toZcode,
  toQoder,
  toTokenRhythm,
  toWorkBuddy,
  toSenseNova,
  toInternAi,
  type UpstreamContext,
} from "./upstreams/index.ts";
import {
  routeInGroup,
  type Route,
  type RoutingContext,
} from "./routes.ts";
import { findAggregate, modelsOfPlatform } from "./catalog-routes.ts";
import { sendError } from "./deliver.ts";

const TOKENRHYTHM_MAX_ATTEMPTS = configNumber("TOKENRHYTHM_MAX_ATTEMPTS", 3);
// The legacy endpoint queues models and reports 429 while a request waits. The
// CLI retries these, so the proxy does too — with the same shape.
const LEGACY_MAX_ATTEMPTS = configNumber("QODER_LEGACY_ATTEMPTS", 3);
const LEGACY_RETRY_MS = configNumber("QODER_LEGACY_RETRY_MS", 10000);
const QODER_MAX_ATTEMPTS = configNumber("QODER_MAX_ATTEMPTS", 3);
const LOG_ROUTE = configFlag("QODER_LOG_ROUTE", false);

type Dialect = "anthropic" | "openai";

/**
 * One upstream's catalogue, with the real model ids, is in
 * lib/admin/upstreams.ts — the health endpoint and the panel want the same one.
 */

/** What the adapters need to know about the router they run in. */
function upstreamContext(): UpstreamContext {
  const uctx: UpstreamContext = {
    legacyMaxAttempts: LEGACY_MAX_ATTEMPTS,
    legacyRetryMs: LEGACY_RETRY_MS,
    qoderMaxAttempts: QODER_MAX_ATTEMPTS,
    tokenRhythmMaxAttempts: TOKENRHYTHM_MAX_ATTEMPTS,
    logRoute: LOG_ROUTE,
    // 开放 API 平台直接转发，所以会话相关的头跟着走；模拟客户端的那些
    // 自己重建请求，这些头不会出网关。
    clientHeaders: {},
    workbuddyMaxOutput: (model: string) => workbuddyCatalog().find((m) => m.id === model)?.maxOutput ?? 64000,
    workbuddyModel: (model: string) => workbuddyCatalog().find((m) => m.id === model) ?? null,
  };
  // Keep the usage the upstream reported, so the caller can write it down once
  // the call is over. The upstream may report it in pieces — the Anthropic
  // stream puts the input in message_start and the output in message_delta —
  // so each piece is counted on its own and the largest wins.
  uctx.onUsage = (u) => {
    uctx.lastUsage = maxTotals(uctx.lastUsage ?? null, usageTotals(u));
  };
  return uctx;
}

/**
 * What the router is serving, and what it knows about.
 *
 * One entry per platform, not per account: the path names the platform, and
 * which of its accounts pays is the platform policy's business at call time.
 */
function routingContext(): RoutingContext {
  const platforms = new Map<string, { kind: string; enabled: boolean; accounts: number; ids: Set<string>; untilMs: number | null }>();
  const now = Date.now();
  for (const template of PLATFORMS) {
    const kind = kindOf(template.kind);
    if (!kind) continue;
    const accounts = accountsOfPlatform(template.id);
    const on = accounts.filter((row) => row.enabled);
    // 模型目录恒为平台全量：额度用尽或者账号在冷却，说的是「这个平台现在接不了
    // 这个请求」，不是「这个平台没有这个模型」。前者答 503 并说什么时候恢复，
    // 后者答 400。把模型从目录里摘掉，客户端看到的是一个不存在的模型名 ——
    // 它会去改配置，而真正该做的是等一会儿再试
    const ids = new Set(modelsOfPlatform(template.id));
    // 开着的账号全都接不了：算一下最早什么时候能试
    const noCredits = on.length > 0 && outOfCredits(template.id);
    const usable = noCredits ? [] : on.filter((row) => !isCoolingDown(row.id, now));
    const untilMs = on.length > 0 && usable.length === 0 ? recoveryTime(on, noCredits, now) : null;
    platforms.set(template.id, {
      kind: template.kind,
      enabled: on.length > 0,
      accounts: accounts.length,
      ids,
      untilMs,
    });
  }
  return { platforms };
}

/**
 * 这个平台的账号最早什么时候能接请求。
 *
 * 额度用尽的看套餐窗口什么时候结束（窗口一换就是新的额度），冷却中的看冷却到
 * 什么时候。都算不出来就按固定冷却时长给一个 —— 客户端要的是一个能照着的数字
 */
function recoveryTime(rows: ProviderRow[], noCredits: boolean, now: number): number {
  const times = rows
    .map((row) => (noCredits ? planWindowEndsAt(row.id, now) : null) ?? cooldownUntil(row.id))
    .filter((at): at is number => typeof at === "number" && at > now);
  return times.length ? Math.min(...times) : now + unavailableCooldownMs();
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
  body: Json,
  dialect: Dialect,
): Promise<void> {
  const stream = body.stream === true;
  const rctx = routingContext();

  // The targets are the candidates: the heaviest one first, and `single` only
  // tries that one — the panel says single, and traffic that quietly went to
  // another upstream is not what the panel says. `fallback` tries the next
  // one when a target fails.
  //
  // The root route does not judge the failures: every one of them moves on to
  // the next target, the way it always has.
  const candidates = entry.targets.map((target) => ({
    id: `${target.group}/${target.upstreamModel}`,
    weight: target.weight,
    run: async () => {
      let route: Route;
      try {
        route = routeInGroup(target.group, target.upstreamModel, rctx);
      } catch (e) {
        recordAggregateUsage({
          modelId: entry.id,
          group: target.group,
          upstreamModel: target.upstreamModel,
          ok: false,
        });
        throw e;
      }
      // The client asked for the published name; the answer says the same, even
      // though the upstream knows the model by another one.
      route.label = entry.id;

      const uctx = upstreamContext();
      try {
        await callUpstream(uctx, body, route, dialect, stream, ctx);
      } catch (e) {
        recordAggregateUsage({
          modelId: entry.id,
          group: target.group,
          upstreamModel: target.upstreamModel,
          ok: false,
        });
        // Once the answer has started there is nothing to fall back to.
        if (ctx.res.headersSent) throw new SelectionStop(e);
        throw e;
      }
      const usage = uctx.lastUsage;
      recordAggregateUsage({
        modelId: entry.id,
        group: target.group,
        upstreamModel: target.upstreamModel,
        ok: true,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
      });
    },
  }));

  // The order the candidates are tried in: the heaviest first. The log needs
  // it to say which target takes over.
  const ordered = byWeight(candidates);

  try {
    await select({
      strategy: entry.strategy,
      candidates,
      // Why the traffic went somewhere else: the target that failed, why it
      // failed, and which one takes the request now.
      onAttempt: (candidate, error) => {
        if (!error) return;
        // The answer had already started: there is nothing to fall back to.
        const stopped = error instanceof SelectionStop;
        const reason = stopped ? error.reason : error;
        const at = ordered.findIndex((c) => c.id === candidate.id);
        const next = ordered[at + 1];
        console.log(
          `[ROUTE] ${candidate.id} failed (${describeTargetFailure(reason)}), ` +
            (stopped
              ? "the answer had already started"
              : next
                ? `trying ${next.id}`
                : "no target left"),
        );
      },
      failure: (lastError) =>
        lastError instanceof Error
          ? lastError
          : new AuthError("no upstream answered", "这个模型的所有上游都没有响应。", 502),
    });
  } catch (e) {
    sendError(ctx, e);
  }
}

/**
 * 这次失败一句话怎么说（给日志）。
 *
 * 上游自己的状态最有说明力：400 是请求本身的问题，503 是上游挂了。网关自己
 * 的状态说明不了问题。
 */
function describeTargetFailure(error: unknown): string {
  const described = describeUpstreamError(error);
  if (!described.startsWith("unknown")) return described;
  const err = error as { message?: unknown };
  return String(err?.message ?? "unknown");
}
export async function handle(
  ctx: Koa.Context,
  dialect: Dialect,
  platform?: string,
): Promise<void> {
  const body = (ctx.request.body ?? {}) as Json;

  // The root route serves the published models and nothing else: the database
  // decides which models exist and which upstream serves them.
  if (!platform) {
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
    route = routeInGroup(platform!, String(body.model ?? "").trim(), rctx);
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
  body: Json,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  ctx: Koa.Context,
): Promise<void> {
  const started = Date.now();
  const agent = detectAgent(ctx.request.headers).name;
  const session = detectSession(ctx.request.headers);
  // The simulated clients send their own session id upstream; the clients
  // spell it differently, so the upstream id is mapped from this one.
  uctx.clientSessionId = session.sessionId;
  // The platform says how to talk to it; its accounts are the ones the policy
  // picks from, inside the adapter.
  const template = platformOf(route.platform);
  const kind = template ? kindOf(template.kind) : null;
  // 开放 API 平台（MiniMax 开放平台、TokenRhythm、SenseNova、书生·端砚）
  // 是直接转发的，客户端的会话头跟着过去。模拟客户端的那些（Qoder、
  // WorkBuddy、MiniMax Code、ZCode）按客户端的样子重建请求，多余的头无视。
  if (kind?.openPlatform) {
    uctx.clientHeaders = clientSessionHeaders(ctx.request.headers);
  }
  try {
    switch (kind?.kind) {
      case "qoder":
        await toQoder(uctx, body, route, dialect, stream, ctx);
        break;
      case "workbuddy":
        await toWorkBuddy(uctx, body, route, dialect, stream, ctx);
        break;
      case "tokenrhythm":
        await toTokenRhythm(uctx, body, route, dialect, stream, ctx);
        break;
      // The compatible platforms carry their own dispatch: registering one is
      // a declaration (lib/router/compatible-platform.ts), not a case here.
      case "sensenova":
        await (kind?.dispatch
          ? kind.dispatch(uctx, body, route, dialect, stream, ctx)
          : toSenseNova(uctx, body, route, dialect, stream, ctx));
        break;
      case "intern-ai":
        await (kind?.dispatch
          ? kind.dispatch(uctx, body, route, dialect, stream, ctx)
          : toInternAi(uctx, body, route, dialect, stream, ctx));
        break;
      case "minimax-api":
        await toMiniMaxApi(uctx, body, route, dialect, stream, ctx);
        break;
      case "zcode":
        await toZcode(uctx, body, route, dialect, stream, ctx);
        break;
      default:
        await toMinimax(uctx, body, route, dialect, stream, ctx);
        break;
    }
    recordRequestUsage(body, route, agent, session, uctx, ctx.status || 200, started, "", kind?.label ?? route.platform);
  } catch (e) {
    const err = e as AuthError;
    const status = typeof err?.status === "number" ? err.status : 500;
    recordRequestUsage(
      body,
      route,
      agent,
      session,
      uctx,
      status,
      started,
      err?.message ?? String(e),
      kind?.label ?? route.platform,
    );
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
  body: Json,
  route: Route,
  agent: string,
  session: SessionInfo,
  uctx: UpstreamContext,
  status: number,
  started: number,
  error: string,
  client: string,
): void {
  const totals = uctx.lastUsage ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  const upstreamModel = route.model.includes("/")
    ? route.model.slice(route.model.indexOf("/") + 1)
    : route.model;
  recordUsage({
    upstreamId: route.platform,
    upstreamModel,
    agentModel: String(body.model ?? route.label ?? upstreamModel),
    agent,
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    agentName: session.agentName,
    client,
    ok: !error && status < 400,
    status,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    reasoningTokens: totals.reasoningTokens,
    latencyMs: Date.now() - started,
    error,
  });
}
