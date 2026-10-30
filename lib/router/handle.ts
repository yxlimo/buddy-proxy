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
import { upstreamStatusOf } from "../upstream-status.ts";
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
  const started = Date.now();

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
        // 这一步没打到上游（账号都在冷却或者额度用尽），但用量表也要留一行：
        // 不留的话用量页只看得到打上去的那几条，这批 503 像是没发生过。
        recordUnroutedUsage(entry, target, e, ctx, started);
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

  // 试过的失败，按尝试的先后记着：给客户端看哪一个由它们决定，不由最后一个决定。
  // 记的是「哪个目标」与「它的错」：客户端要知道每个目标各自为什么失败。
  const failures: { id: string; error: unknown }[] = [];

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
        // 答复已经开始的那个错不参与挑选：那时已经没有选择了。
        if (!stopped) failures.push({ id: candidate.id, error: reason });
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
      failure: (lastError) => {
        // 最后一个失败说了算是不对的：前面那个可能是「这个账号没额度」，最后
        // 那个是「这个上游没有这个模型」—— 客户端拿到后者就会去改模型名，而
        // 真正该做的是等额度恢复。所以挑最有说明力的那个。
        const best = pickMostInformativeFailure(failures);
        if (!best) {
          if (lastError instanceof Error) return lastError;
          return new AuthError("no upstream answered", "这个模型的所有上游都没有响应。", 502);
        }
        // 多个目标都失败：把每一个的原因都说出来。只给一个笼统的错（「所有
        // 账号都在额度用尽或者冷却中」），客户端不知道该等哪一个 —— 限流等
        // 一分钟，额度用尽等窗口。
        if (failures.length > 1) {
          const summary = summarizeFailures(failures);
          // 复制一个新的：那个错可能被别人持有（上游的冷却就是这么记的）。
          if (best instanceof AuthError) {
            const hint = [best.hint, summary]
              .filter((part) => part && part.trim())
              .join("\n");
            return new AuthError(best.message, hint, best.status, best.type);
          }
          return new AuthError(String(best.message), summary, clientStatusOf(best) ?? 502);
        }
        return best;
      },
    });
  } catch (e) {
    sendError(ctx, e);
  }
}

/**
 * 记一条没有打到上游的请求。
 *
 * 账号都在冷却、或者额度用尽的时候，请求根本没发出去，客户端拿到的是 503。
 * 这种请求也要留在用量表里：打上去的那条由上游那侧记（recordRequestUsage），
 * 这里的这一条是「连发都没发出去」，两边不重。
 */
function recordUnroutedUsage(
  entry: AggregateEntry,
  target: { group: string; upstreamModel: string },
  error: unknown,
  ctx: Koa.Context,
  started: number,
): void {
  const err = error as AuthError;
  const agent = detectAgent(ctx.request.headers).name;
  const session = detectSession(ctx.request.headers);
  // 模拟客户端的名字（面板上显示的那个）：跟打上去的那条用同一个口径。
  const template = platformOf(target.group);
  const kind = template ? kindOf(template.kind) : null;
  recordUsage({
    upstreamId: target.group,
    upstreamModel: target.upstreamModel,
    agentModel: entry.id,
    agent,
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    agentName: session.agentName,
    client: kind?.label ?? target.group,
    ok: false,
    status: clientStatusOf(error) ?? 503,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    latencyMs: Date.now() - started,
    error: String(err?.message ?? error).slice(0, 200),
  });
}

/**
 * 几个失败里挑一个给客户端看。
 *
 * 排法（先看客户端能不能据此行动，再看是不是上游自己的问题）：
 *
 *   1. 503 / 402：额度用尽、冷却、凭据被拒 —— 客户端等一会儿就能重试。
 *   2. 别的 5xx：上游自己挂了。
 *   3. 4xx：请求本身的问题 —— 换一个 target 也是这个错。
 *   4. 说不清的：垫底。
 *
 * 同一档里取第一个：先试的那个 target 更接近用户真正问的那个模型。
 */
function pickMostInformativeFailure(failures: { id: string; error: unknown }[]): Error | undefined {
  let best: Error | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const failure of failures) {
    const error = failure.error;
    if (!(error instanceof Error)) continue;
    const rank = failureRank(error);
    if (rank >= bestRank) continue;
    best = error;
    bestRank = rank;
  }
  return best;
}

/**
 * 几个目标都失败：每个目标一句话原因，合成一段说明。
 *
 * 客户端只看到一个笼统的错时，它不知道下一步该做什么 —— 限流等一分钟，额度
 * 用尽等窗口，上游挂了换一个。把每个目标各自的原因说出来，才说得上。
 */
function summarizeFailures(failures: { id: string; error: unknown }[]): string {
  const lines = failures.map((one) => `  ${one.id}：${describeTargetFailure(one.error)}`);
  return `这个模型有 ${failures.length} 个上游，都失败了：\n${lines.join("\n")}`;
}

/** 这个失败有多说明力：数字越小越说明力强。 */
function failureRank(failure: unknown): number {
  const status = clientStatusOf(failure);
  if (status === 503 || status === 402) return 0;
  if (status !== null && status >= 500) return 1;
  if (status !== null && status >= 400) return 2;
  return 3;
}

/** 客户端会看到的状态码：这个错写出去的时候是什么状态，就是什么。 */
function clientStatusOf(failure: unknown): number | null {
  // 上游在排队：客户端看到的是 503（等一会儿就好），不是上游的 429。
  if (failure instanceof LimitError) return 503;
  if (!failure || typeof failure !== "object") return null;
  const status = Number((failure as { status?: unknown }).status);
  if (Number.isFinite(status) && status > 0) return status;
  return upstreamStatusOf(failure);
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
      // MiniMax Code 有自己的 case：它没有登记 dispatch（登记的是它的种类
      // 模板，不是转发）。漏了它，default 会把它当成「还没接的上游」。
      case "minimax":
        await toMinimax(uctx, body, route, dialect, stream, ctx);
        break;
      case "zcode":
        await toZcode(uctx, body, route, dialect, stream, ctx);
        break;
      default:
        // 没有 case 的 kind 只能靠它自己登记的 dispatch（见
        // lib/router/compatible-platform.ts）。没有 dispatch 就是这个上游还没
        // 接 —— 不能猜：猜错了就是把请求按别的方言、别的鉴权发到别的 host 去。
        if (kind?.dispatch) {
          await kind.dispatch(uctx, body, route, dialect, stream, ctx);
          break;
        }
        throw new AuthError(
          `upstream kind "${kind?.kind ?? "unknown"}" has no dispatch`,
          `这个上游还没接：${kind?.kind ?? "未知"}。`,
          500,
        );
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
 * 上游把输出全放在了思考里。
 *
 * `completion_tokens` 含思考，`reasoning_tokens` 是其中思考的部分：两者相减
 * 才是正文。相减接近 0 说明这条答复只有思考、没有正文 —— 状态仍是 200，我们
 * 记成功，客户端拿到的却是空内容（magic-context 的 empty_completion 就是它）。
 *
 * 两个都是 0 表示上游没给 usage，不是空答复。
 *
 * 两条分支：正文几乎没有（<=5），以及思考吃掉大量预算、正文只剩一点
 * （思考 >= 2000 且正文 <= 100）。单看「正文很小」分不开正常短答复和空答复。
 */
export function isAllThinking(usage?: {
  completionTokens?: number;
  reasoningTokens?: number;
}): boolean {
  const completion = usage?.completionTokens ?? 0;
  // 上游没给 usage：不是空答复，不判。
  if (completion <= 0) return false;
  const reasoning = usage?.reasoningTokens ?? 0;
  const visible = completion - reasoning;
  // 一、正文几乎没有。
  if (visible <= 5) return true;
  // 二、思考吃了大量预算，正文只剩一点。短答复（思考也少）走不到这里，
  // 所以不会把正常的短回答算进来。
  return reasoning >= 2000 && visible <= 100;
}

/**
 * 这次请求真正生效的输出上限。
 *
 * 模拟客户端的上游不用客户端传的值（见 UpstreamContext.upstreamMaxTokens）：
 * Qoder 固定发它自己客户端的 32000，客户端要多少都没用。所以先看真正发
 * 出去的那个数，客户端请求体里的那个只是备选。
 */
export function effectiveMaxTokens(
  uctx: Pick<UpstreamContext, "upstreamMaxTokens">,
  body: Json,
): number | "未指定" {
  return (
    uctx.upstreamMaxTokens ??
    (typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : "未指定")
  );
}

/**
 * 上限用掉了多少：思考把预算吃满时这里就是 100%。
 *
 * 上限不是数字就不知道：写 `?`，不猜。
 */
export function budgetUsed(completion: number, budget: number | "未指定"): string {
  if (typeof budget !== "number" || budget <= 0) return "?";
  return `${Math.round((completion / budget) * 100)}%`;
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
  // 输出全在思考里：200 + 空正文。日志里要能看到是哪个上游、给了多少预算。
  if (isAllThinking(uctx.lastUsage)) {
    const completion = uctx.lastUsage?.completionTokens ?? 0;
    const reasoning = uctx.lastUsage?.reasoningTokens ?? 0;
    // 生效上限优先：模拟客户端的上游不用客户端传的值。
    const budget = effectiveMaxTokens(uctx, body);
    // 用掉了多少：思考把预算吃满时这里就是 100%。上限不是数字就不知道。
    const used = budgetUsed(completion, budget);
    console.warn(
      `[UPSTREAM] ${route.platform}/${upstreamModel} 答 200 但没有正文` +
        `（completion=${completion} reasoning=${reasoning} 正文=${completion - reasoning}` +
        ` 上游上限=${budget} 用掉=${used} client=${client}）`,
    );
  }
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
