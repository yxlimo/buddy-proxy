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
import { allPlatforms, platformOfAny } from "../platforms.ts";
import { upstreamStatusOf } from "../upstream-status.ts";
import { kindOf } from "../provider-kinds.ts";
import { recordAggregateUsage } from "../aggregate.ts";
import type { AggregateEntry } from "./catalog.ts";
import { select, SelectionStop, byWeight } from "./selection.ts";
import { classifyUpstreamError, describeUpstreamError } from "./provider-selection.ts";
import { recordUsage, maxTotals, usageTotals } from "../usage.ts";
import { clientSessionHeaders, detectAgent, detectSession, type SessionInfo } from "../agent.ts";
import { workbuddyCatalog } from "../admin/upstreams.ts";
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
  publishedModelUnavailable,
  unreachableUpstreams,
  emptyCatalogTargets,
  catalogueNotReady,
  type Route,
  type RoutingContext,
} from "./routes.ts";
import { findAggregate, publishedModel } from "./catalog-routes.ts";
import { platformAvailabilities, type PlatformAvailability, type PlatformState } from "./availability.ts";
import { ClientGoneError, sendError } from "./deliver.ts";

const TOKENRHYTHM_MAX_ATTEMPTS = configNumber("TOKENRHYTHM_MAX_ATTEMPTS", 3);
// 上游排队时等多久（毫秒）：上游自己说了秒数就用它的，没说就用这个。等几次不是
// 设置 —— 排队只等一次，实测等完它给的秒数再打还是排队。
const LEGACY_RETRY_MS = configNumber("QODER_LEGACY_RETRY_MS", 10000);
const LOG_ROUTE = configFlag("QODER_LOG_ROUTE", false);

type Dialect = "anthropic" | "openai";

/**
 * One upstream's catalogue, with the real model ids, is in
 * lib/admin/upstreams.ts — the health endpoint and the panel want the same one.
 */

/** What the adapters need to know about the router they run in. */
function upstreamContext(
  platform?: string,
  availabilities?: Map<string, PlatformAvailability>,
): UpstreamContext {
  const uctx: UpstreamContext = {
    legacyRetryMs: LEGACY_RETRY_MS,
    tokenRhythmMaxAttempts: TOKENRHYTHM_MAX_ATTEMPTS,
    logRoute: LOG_ROUTE,
    // 开放 API 平台直接转发，所以会话相关的头跟着走；模拟客户端的那些
    // 自己重建请求，这些头不会出网关。
    clientHeaders: {},
    // 目录是区域的，所以查表要先知道这条路由落在哪个平台。
    workbuddyMaxOutput: (model: string) => workbuddyCatalog(platform).find((m) => m.id === model)?.maxOutput ?? 64000,
    workbuddyModel: (model: string) => workbuddyCatalog(platform).find((m) => m.id === model) ?? null,
  };
  // 这一轮算好的可用性带下去：派发要的是同一份答案，别再读一遍那几张表。
  if (platform) uctx.availability = availabilities?.get(platform);
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
function routingContext(availabilities: Map<string, PlatformAvailability>): RoutingContext {
  const platforms = new Map<
    string,
    { kind: string; enabled: boolean; accounts: number; ids: Set<string>; untilMs: number | null; state: PlatformState }
  >();
  for (const [id, availability] of availabilities) {
    // kind 没登记的平台进不了路由：没有 kind 就没有「怎么跟它说话」。
    if (!kindOf(availability.kind)) continue;
    platforms.set(id, {
      kind: availability.kind,
      // 开着**而且**有可用凭据的账号才算数：账号建了但没填 key、没登录的，
      // 进不了路由 —— 那是面板上要填的事，不是等一会儿就会好的事。
      enabled: availability.serving.length > 0,
      accounts: availability.accounts,
      // 模型目录恒为平台全量：额度用尽或者账号在冷却，说的是「这个平台现在接不了
      // 这个请求」，不是「这个平台没有这个模型」。前者答 503 并说什么时候恢复，
      // 后者答 400。把模型从目录里摘掉，客户端看到的是一个不存在的模型名 ——
      // 它会去改配置，而真正该做的是等一会儿再试
      ids: new Set(availability.ids),
      untilMs: availability.untilMs,
      state: availability.state,
    });
  }
  return { platforms };
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
  availabilities: Map<string, PlatformAvailability>,
): Promise<void> {
  const stream = body.stream === true;
  const rctx = routingContext(availabilities);
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

      const uctx = upstreamContext(route.platform, availabilities);
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
      // 客户端走了不是上游的错：不能再打下一个目标。
      //
      // 别的错都往下走（这是根路由一贯的做法）：换一个上游也许能答得出来。
      // 但客户端走了 —— 连接都断了，换谁都一样没人要；而且下一个目标还会
      // 再占一个账号、再花一份上游的钱（那个上游不知道客户端已经不要了）。
      degradable: (error) => !(error instanceof ClientGoneError),
      // Why the traffic went somewhere else: the target that failed, why it
      // failed, and which one takes the request now.
      onAttempt: (candidate, error) => {
        if (!error) return;
        // The answer had already started: there is nothing to fall back to.
        const stopped = error instanceof SelectionStop;
        const reason = stopped ? error.reason : error;
        // 客户端走了：这个错不参与挑选，也没有下一个目标了。
        if (reason instanceof ClientGoneError) {
          console.log(`[ROUTE] ${candidate.id}：客户端走了，答复没送出去`);
          return;
        }
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
        // 客户端走了：这个错要原样出去（答复那一层认它：499，不写正文）。
        // 把它包成别的错，客户端就会收到一个「上游挂了」的样子 —— 而上游没坏。
        if (lastError instanceof ClientGoneError) return lastError;
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
  // 模板还是表里的开放平台：两处都是平台，kind 都在那儿。开放平台的 kind 是
  // 「openai」，登记过了（lib/kinds/openai.ts）。
  const template = platformOfAny(target.group);
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
  const lines = failures.map((one) => `  ${one.id}：${describeTargetFailureForClient(one.error)}`);
  return `这个模型有 ${failures.length} 个上游，都失败了：\n${lines.join("\n")}`;
}

/**
 * 分类的 kind 怎么说给客户端听。
 *
 * kind 是内部词（queued、rate-limit、unreachable）：它属于日志与策略，不是
 * 写给客户端的。客户端是 agent，它读的是一句人话，而且得能据此行动 —— 排队
 * 就等一等，额度用完就充值，请求本身有问题就别重试。所以客户端那层翻一遍，
 * 日志与分类不改：同一个失败在两处各用各的话。
 */
const CLIENT_KIND_WORDS: Record<string, string> = {
  queued: "排队",
  "rate-limit": "限流",
  timeout: "上游太慢",
  connection: "连不上",
  unreachable: "连不上",
  credential: "凭据被拒",
  "no-balance": "余额用尽",
  quota: "额度用完",
  server: "上游出错",
  model: "这个账号用不了这个模型",
  request: "请求本身有问题",
  unknown: "原因不明",
};

/**
 * 这次失败对客户端怎么说。
 *
 * 与 describeTargetFailure 的区别就在这一层：那个是日志，用 kind 原值；这个
 * 是客户端看到的那句话，用中文短语。上游自己的状态放在括号里——它是客户端
 * 能据此行动的信息（429 等一会儿、400 别重试），而不是内部术语。
 */
function describeTargetFailureForClient(error: unknown): string {
  const failure = classifyUpstreamError(error);
  const words = CLIENT_KIND_WORDS[failure.kind] ?? "上游出错";
  return failure.status === null ? words : `${words}（HTTP ${failure.status}）`;
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
    // 先查发布项：模型名写错的请求不该去读账号表、冷却表 —— 那些表只有真的要
    // 判定「这个平台现在能不能接」时才要读。
    const published = publishedModel(wanted);
    if (!published || !published.enabled) {
      unknownModel(ctx, wanted);
      return;
    }
    // 需要判定：可用性算一次，下面都用它。
    //
    // 不做缓存：面板改了账号、凭据或者冷却之后，路由必须立刻按新值走 ——
    // 缓存会让路由按旧值走，而面板说已经改好了。
    const availabilities = platformAvailabilities(allPlatforms());
    const entry = findAggregate(wanted, availabilities);
    if (!entry) {
      // 目标平台接得了，但它的目录是空的：目录还没拿到（账号刚加、目录还没
      // 同步）。这不是「没有这个模型」—— 平台前缀那条路对同样情况答 503，根
      // 路由也得一样：两处答的不一样，客户端就会去改模型名，而模型名是对的。
      const emptyCatalog = emptyCatalogTargets(published.targets, availabilities);
      if (emptyCatalog.length) {
        sendError(ctx, catalogueNotReady(emptyCatalog));
        return;
      }
      // 发布着，却没有能接的目标：说清是哪个上游、什么状态、该做什么。
      // 答「没有这个模型」会让客户端去改模型名，而模型确实发布过。
      const unreachable = unreachableUpstreams(published.targets, availabilities);
      if (unreachable.length) {
        sendError(ctx, publishedModelUnavailable(published.id, unreachable));
        return;
      }
      unknownModel(ctx, wanted);
      return;
    }
    await handleAggregate(ctx, entry, body, dialect, availabilities);
    return;
  }

  // 平台前缀那条路：路由要知道这个平台现在接不接得住，所以可用性要算。
  const availabilities = platformAvailabilities(allPlatforms());
  let route: Route;
  try {
    const rctx = routingContext(availabilities);
    route = routeInGroup(platform!, String(body.model ?? "").trim(), rctx);
  } catch (e) {
    sendError(ctx, e);
    return;
  }

  const stream = body.stream === true;
  try {
    await callUpstream(
      upstreamContext(route.platform, availabilities),
      body,
      route,
      dialect,
      stream,
      ctx,
    );
  } catch (e) {
    sendError(ctx, e);
  }
}

/**
 * 「没有这个模型」：根路由只服务面板里发布出来的模型。
 *
 * 只有模型真的没发布（或者没有启用的目标）才这样答。发布过、只是目标平台
 * 现在接不了的那种，答的是「哪个上游、什么状态」—— 客户端拿到「没有这个
 * 模型」会去改模型名，而模型名是对的。
 */
function unknownModel(ctx: Koa.Context, wanted: string): void {
  ctx.status = 404;
  ctx.body = {
    error: { type: "invalid_request_error", message: `unknown model "${wanted}"` },
    hint: "根路由只服务面板里发布出来的模型。在面板里配置并保存后生效。",
  };
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
  // 平台说的是「怎么跟它说话」（kind）：模板还是表里的开放平台都要认出来，
  // 认错了就找不到它的 kind，请求也就发不出去。
  const template = platformOfAny(route.platform);
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
    // 客户端走了：答复那一层给客户端的是 499，用量表也记 499，不要记成 500
    // —— 500 是「上游挂了」，而上游没坏，只是没人要了。
    const status = e instanceof ClientGoneError ? 499 : typeof err?.status === "number" ? err.status : 500;
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
 * （思考 >= 2000 且正文 <= 100）。单看「正文很小」分不开正常短答复和空答复，
 * 所以先决条件是「思考真的在吃输出」：思考为 0（没有思考可吃）或者思考不比
 * 正文多，都不是「输出全在思考里」。少了这个先决条件，5 个 token 的正常短
 * 答复（completion=5 reasoning=0）会被当成空答复误报。
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
  // 先决条件：思考在吃输出。没有思考（0）说明这条答复没有思考段，短答复
  // 也归在这里；思考不比正文多，说明正文才是主体。
  if (!(reasoning > 0 && reasoning > visible)) return false;
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
