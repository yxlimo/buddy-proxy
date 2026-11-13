// lib/router/upstreams/policy.ts — one upstream's accounts, under its policy.
//
// Every adapter runs its call through underPolicy: the platform's policy
// picks the account, the account is skipped while it cools down, and the
// failure is shaped into what the client sees. UpstreamContext is what an
// adapter is handed.

import { AuthError } from "../../credential.ts";
import type { WorkBuddyModel } from "../../workbuddy/models.ts";
import { TokenRhythmNoBalanceError } from "../../tokenrhythm/transport.ts";
import { byOrder, classifyUpstreamError, describeUpstreamError, isDegradableUpstreamError, isNoBalanceFailure, networkDetailOf, selectProvider } from "../provider-selection.ts";
import { byWeight } from "../selection.ts";
import {
  businessCodeOf,
  businessCodeOfBody,
  cooldownUntilOf,
  upstreamBodyOf,
  upstreamStatusOf,
  withBusinessCode,
  withCooldownUntil,
  withUpstreamAnswer,
  withUpstreamBody,
  withUpstreamStatus,
} from "../../upstream-status.ts";
import { clearCooldown, setCooldown } from "../../cooldown.ts";
import { scrubForClient, scrubForLog } from "../../log-scrub.ts";
import { cooldownForFailure, cooldownStamp, errorTextOf, rateWaitedOf, withRateWaited, type RateWaited } from "../account-cooldown.ts";
import { configNumber, markHotSetting } from "../../config.ts";
import { type ProviderRow } from "../../providers.ts";
import { platformPolicy } from "../../platforms.ts";
import { credentialFaultError, platformWithoutAccount } from "../routes.ts";
import { platformAvailability, type PlatformAvailability } from "../availability.ts";
// 余额到期优先的次序：按平台钉一个账号（余额从额度快照读，不问钱包接口）。
import { forgetPinnedAccount, pinNextAccount } from "../balance-order.ts";
import { withRetryAfter, ClientGoneError } from "../deliver.ts";

/** What the adapters need to know about the router they run in. */
export interface UpstreamContext {
  /**
   * How long a queued legacy request waits before its one retry.
   *
   * Only the wait when the upstream gives no seconds of its own: how many
   * times a queue is waited out is not a setting (see LEGACY_QUEUE_WAITS in
   * upstreams/qoder.ts).
   */
  legacyRetryMs: number;
  /** How often a busy relay is tried again, on the same account. */
  tokenRhythmMaxAttempts: number;
  /** Whether a request is written to the log. */
  logRoute: boolean;
  /**
   * The headers the client sent, for the open API platforms.
   *
   * The simulated clients (Qoder, WorkBuddy, MiniMax Code, ZCode) rebuild the
   * request the way the desktop client builds it — only the fields they need,
   * everything else in the client's headers is ignored. The open platforms get
   * the request as it is, so the client's headers go along, minus the ones the
   * gateway owns (see clientForwardHeaders in lib/agent.ts).
   */
  forwardedHeaders: Record<string, string>;
  /**
   * The client's session id, as the client spelled it.
   *
   * The simulated clients rebuild the request the way the desktop client builds
   * it, and the desktop client sends *its own* session id. The clients here
   * spell their session ids differently (pi sends a bare UUID, opencode sends
   * `ses_…`), so the upstream id is mapped from this one (lib/upstream-session.ts).
   * Empty when the client sent no session id.
   */
  clientSessionId?: string;
  /** The output limit of a WorkBuddy model, as its own catalogue says. */
  workbuddyMaxOutput(model: string): number;
  /** The model itself, so the request can be built the way the client builds it. */
  workbuddyModel(model: string): WorkBuddyModel | null;
  /** Told what the upstream charged for the answer, if anyone is keeping score. */
  onUsage?: (usage: any) => void;
  /**
   * The usage the last upstream call reported, already counted.
   *
   * The delivery layer calls `onUsage` with the upstream's own usage object;
   * whoever built the context keeps the largest one seen here so the caller
   * can record it after the call. The Anthropic stream reports it in two
   * pieces (the input in message_start, the output in message_delta), so
   * each piece is counted on its own.
   */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens: number };
  /**
   * 这次请求实际发给上游的输出上限。
   *
   * 模拟客户端的上游不用客户端传的值：Qoder 固定发它自己客户端的 32000
   * （见 lib/qoder/models.ts 的 QODER_CLIENT_MAX_TOKENS）。要判断「思考是不是
   * 把预算吃满了」，得看真正发出去的那个数，不是客户端想要的那个。
   */
  upstreamMaxTokens?: number;
  /**
   * 这个平台这一轮算好的可用性。
   *
   * 派发用它，别再算一遍：算一次要读账号表、冷却表，还要逐个账号看凭据。
   * 判定的答案住在 admin 层（lib/admin/platform-state.ts），这里只是把它带下来。
   */
  availability?: PlatformAvailability;
}

/**
 * The error for an upstream that answered with a status of its own.
 *
 * The client sees the gateway's status, and the upstream's own status and
 * code stay on the error: they say whether another account would do better
 * (a 402 means this account is out of credit, a 400 means the request is
 * wrong and every account would fail the same way).
 *
 * The upstream's own body stays on the error too: when the retries run out,
 * that answer is what the client gets (see upstreamAnswerError).
 *
 * `retryAfterMs` is what the upstream said about its own window ("come back
 * in two seconds"). It is put on the error so the routing layer can wait
 * instead of failing the client — see rateLimitWaitMs. It is *not* the
 * cooldown decision: how long the account is put aside is a separate
 * question (lib/router/account-cooldown.ts).
 */
export function upstreamStatusError(
  status: number,
  text: string,
  what: string,
  retryAfterMs?: number,
): AuthError {
  // 正文只进 hint，日志与用量表只记 message。上游为什么拒，只能靠这一行。
  //
  // stdout 是容器日志：它会被复制、归档、发到别处 —— 那里不该有账号标识、
  // 邮箱、令牌这样的东西。所以打出去之前先抹一遍（正文本身不丢，只是敏感值
  // 没了）。
  console.warn(`[UPSTREAM] ${what}上游 ${status}：${scrubForLog(text, 500)}`);
  const error = new AuthError(
    `upstream HTTP ${status}`,
    // 这一句是客户端看的，上游正文里可能带着 key 片段、cookie、邮箱：抹的规矩
    // 与日志那边同一套（见 scrubForClient）。
    `${what}上游返回 ${status}：${scrubForClient(text, 300)}`,
    502,
  );
  // 上游自己的状态与正文一起留着：状态给路由，正文给客户端（重试用尽时它就
  // 是客户端看到的那一份答复，见 upstreamAnswerError）。两样只留一样是 bug。
  withUpstreamAnswer(error, status, text);
  const code = businessCodeOfBody(text);
  if (code !== null) withBusinessCode(error, code);
  // 上游说的「过多久再来」：挂到错误上，等得起的时候网关自己等。
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
    withCooldownUntil(error, Date.now() + Math.max(0, Math.round(retryAfterMs)));
  }
  return error;
}

/* ------------------------------------------------------------------ *
 * 等得起就自己等
 * ------------------------------------------------------------------ */

/**
 * 上游没说要等多久时，等多久（毫秒）。
 *
 * 一分钟窗口的一半：保守。早回来了只是再失败一次。
 */
const DEFAULT_RATE_WAIT_MS = 30_000;

/**
 * 一次最多等多久（毫秒）。
 *
 * 一分钟以内才等：客户端等不了更久，那种情况照旧报错 + 降级。
 */
const MAX_RATE_WAIT_MS = 60_000;

/**
 * 一个账号上这一轮总共最多花多久（毫秒）。
 *
 * 这是**无限重试**那条路的唯一刹车：没有别人可换时瞬时失败没有次数上限（上游
 * 抽一下的时候，多试几次就好了），停手看的是时间 —— 客户端等不了更久，再等下
 * 去只是把它挂在那里。
 *
 * 有人可换的时候不用等这么久：试三次就换人（见 BOUNDED_ATTEMPTS）。
 *
 * 等的（限流窗口、重试间隔）与上游自己算的时间都算在里面。
 *
 * 这是设置 ROUTER_RETRY_BUDGET_MS 的默认值：自测不能真等三分钟，生产上也可能
 * 要调短（见 attemptBudgetMs）。
 */
export const ATTEMPT_BUDGET_DEFAULT_MS = 180_000;

// Hot: read again at the start of every upstream call (see runWithRetries), so
// a change made in the panel applies to the next request with no restart. The
// budget is the only brake on the unlimited-retry path, which makes it the one
// number an operator may have to turn down for a self-test
markHotSetting("ROUTER_RETRY_BUDGET_MS");

/** 这一轮的总时限（毫秒）。 */
function attemptBudgetMs(): number {
  return configNumber("ROUTER_RETRY_BUDGET_MS", ATTEMPT_BUDGET_DEFAULT_MS);
}

/**
 * 有人可换的时候，一个账号最多打几次上游。
 *
 * 三次（首次 + 两次重试，间隔 300ms、900ms）：够躲开上游那一下抖动，又不至于
 * 把降级拖成一分半钟 —— 以前就是这个数。打完就交给策略换下一个账号。
 *
 * 没有人可换的时候不用这个上限：一直试到总时限（见 attemptBudgetMs）。
 */
const BOUNDED_ATTEMPTS = 3;

/**
 * 限流最多等几回。
 *
 * 上游说「过 N 秒再来」就等 N 秒 —— 那是它自己的窗口，等得到就等。三回都等
 * 不到，说明这个账号是真的被限住了（不是抖一下），交出去让策略照常记冷却。
 */
const MAX_RATE_WAITS = 3;

/**
 * 瞬时重试的间隔（毫秒）：第 1 档 300ms，第 2 档 900ms，第 3 档 2700ms。
 *
 * 300ms 之后再来，是等上游那一下抖动过去（回滚、单实例重启、某个节点抽了）。
 * 900ms 还不行就是真有事。2700ms 之后再放大间隔也没有意义（上游不是越等越久
 * 就越好），所以之后就一直用 2700ms —— 次数没有上限，刹车是总时限。
 */
const TRANSIENT_RETRY_DELAYS_MS = [300, 900, 2700];

/**
 * 一个等过了的错误：冷却不写它（见 lib/router/account-cooldown.ts）。
 *
 * 标记与「读标记」住在那一个文件里：写不写冷却的判据在那边，它要用这个标记。
 * 这里转出去，调用方的 import 不用改。
 */
export { rateWaitedOf, withRateWaited, type RateWaited } from "../account-cooldown.ts";

/**
 * 这个失败是限流吗。
 *
 * 分类说了算（见 classifyUpstreamError）：正文里有没有「每分钟 token 超限」
 * 那几个字是上游自己的说法，不是网关的判据 —— 上游说「限流」时它就是限流。
 */
function isRateLimitFailure(error: unknown): boolean {
  return classifyUpstreamError(error).kind === "rate-limit";
}

/**
 * 等多久（毫秒）。null = 等不起，照旧报错。
 *
 * 判据：
 *
 *   - **只有限流才等**：分类说了算（见 classifyUpstreamError）。额度见底（402）、
 *     凭据被拒（401）、请求本身的问题（400）都不是「等一会儿就好」—— 那些失败
 *     等多久都一样，换账号才是对的。上游给了 retry-after 也不等：那个头说的是
 *     「这个请求可以再来一次」，不是「这个账号可以再来一次」。
 *   - 上游说了「过多久再来」（错误上带着那个时刻）→ 等它。过了就不等，
 *     超过一分钟也不等 —— 客户端等不了那么久；
 *   - 上游什么也没说，但这次是限流 → 等默认的三十秒。
 *
 * 为什么不再区分 TPM 与 RPM：上游说「限流」时它就是限流，正文里有没有那几个
 * 标记不是网关的判据。分不分的后果只有两个：
 *
 *   - 只有一个账号可换的平台：等三十秒比立刻失败强（上游抽一下就好了）；
 *   - 有别的账号可换的：等完这一轮再交给策略换人 —— 换人要快，但先把这一轮
 *     等完不吃亏（上游的窗口通常只有几秒）。
 *
 * `now` 是钟：测试要能把「等多久」算准（注入的钟与真钟差几毫秒，断言就飘）。
 */
export function rateLimitWaitMs(error: unknown, now: () => number = Date.now): number | null {
  if (!isRateLimitFailure(error)) return null;
  const until = cooldownUntilOf(error);
  if (until !== null) {
    const wait = until - now();
    return wait > 0 && wait <= MAX_RATE_WAIT_MS ? wait : null;
  }
  return DEFAULT_RATE_WAIT_MS;
}

/** 等一会儿（毫秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 瞬时重试的下一次间隔（毫秒）。
 *
 * 阶梯走完就一直是最后一档：没有人可换时次数没有上限（唯一的刹车是总时限），
 * 放大间隔只是把客户端挂在那里，不换来上游的好转。有人可换时阶梯只走前两
 * 档：第三次就换人（见 BOUNDED_ATTEMPTS）。
 */
function retryDelayMs(retries: number): number {
  const steps = TRANSIENT_RETRY_DELAYS_MS;
  return steps[Math.min(retries, steps.length - 1)];
}

/**
 * 退避阶梯：给测试核对间隔。
 *
 * 只报间隔，不报次数上限 —— 无限重试那条路没有次数上限（刹车是总时限
 * ROUTER_RETRY_BUDGET_MS），有人可换时的次数上限是 BOUNDED_ATTEMPTS。
 */
export function transientRetryPlan(): { delaysMs: readonly number[]; repeatLastMs: number } {
  const delaysMs = TRANSIENT_RETRY_DELAYS_MS;
  return { delaysMs, repeatLastMs: delaysMs[delaysMs.length - 1] };
}

/**
 * 这些失败值得在**同一个账号**上再试一次。
 *
 * 用现成的分类，不另判一遍：5xx（server）与连接断掉（connection）说的是
 * 「这一次没成事」，隔几百毫秒多半就好了。
 *
 * 不在这里的：
 *   - timeout：这一次等得太久了，再等一次只是再久一次。超时直接交回客户端，
 *     让它自己决定要不要重试（见 underPolicy 里不写冷却那一条）。
 *   - unreachable：主机名在 DNS 里查不到 —— 隔 300ms 再问一次还是查不到。
 *     它是**永久**的错，所以一次就结束；「没有别人可换就一直试到总时限」那条
 *     豁免也不适用于它（那个豁免是为「上游抽一下」设计的，重试一个不存在的
 *     主机抽不好任何东西）。
 *   - rate-limit 走等窗口那条路（等的是分钟级的窗口，不是几十毫秒）；
 *     quota / no-balance / credential 是账号真的接不了，再试一次也是一样的答复；
 *     request 是请求本身的问题，换谁都一样；unknown 说不清是什么，不猜。
 */
const TRANSIENT_KINDS = new Set(["server", "connection"]);

/** 这个失败在同一账号上再试一次有没有意义。 */
function isTransientFailure(error: unknown): boolean {
  // 客户端已经走了：再打一次上游只是白花钱，答复也没人要，而且那次尝试的
  // 失败还会被记成账号的账（见 onAttempt 里 ClientGoneError 那一条）。
  if (error instanceof ClientGoneError) return false;
  return TRANSIENT_KINDS.has(classifyUpstreamError(error).kind);
}

/** 这个失败是「等太久了」吗。 */
function isTimeoutFailure(error: unknown): boolean {
  return classifyUpstreamError(error).kind === "timeout";
}

/** 这个失败是「上游把模型排进了队列」吗。 */
function isQueuedFailure(error: unknown): boolean {
  return classifyUpstreamError(error).kind === "queued";
}

/**
 * 这个失败的日志怎么说：不记冷却的两种原因分开写。
 *
 * 记不记账由 cooldownForFailure 定，这里只管把它的答案说成人话 —— 两处各判
 * 一遍就是同一个错两种待遇的来源。
 */
function whyNotCooling(error: unknown): string {
  if (isTimeoutFailure(error)) return ", timed out, not cooling down";
  if (isQueuedFailure(error)) return ", the model is queued, not cooling down";
  if (rateWaitedOf(error)) return ", waited for the rate limit, not cooling down";
  return ", not cooling down";
}

/** 网络类失败的日志：光一个词说不出是哪儿不通。 */
const NETWORK_KINDS = new Set(["connection", "timeout", "unreachable"]);

/**
 * 这次失败的日志怎么说。
 *
 * 网络类失败只说得出一个词（connection、timeout、unreachable），而真正的原因
 * 在错误链的下一层（`getaddrinfo ENOTFOUND <那个主机>`）。日志里带上它，
 * 排查的人就不必再自己去查一次 DNS —— 2026-11-10 那次就是这样认错了对象：
 * 日志只写「connection」，而那个主机早就是 NXDOMAIN。
 */
function describedForLog(error: unknown): string {
  const described = describeUpstreamError(error);
  if (!NETWORK_KINDS.has(classifyUpstreamError(error).kind)) return described;
  const detail = networkDetailOf(error);
  return detail ? `${described} ${detail}` : described;
}

/**
 * 跑一次调用：等得起就等，瞬时失败就再试 —— 都在**同一个**账号上。
 *
 * 两种重试共用一个 attempt 循环与一格预算，因为它们是同一个问题的两种答法：
 * 「这一次没成事，过一会儿再来」。分成两层的话，一个 TPM 限流过的账号会先等
 * 完窗口、再把瞬时重试的次数从头数一遍，最坏打到五次，日志也会出现两套说法。
 *
 *   - 限流：等上游说的那个窗口（一分钟以内；上游什么也没说就等默认的三十秒）
 *     再来一次，最多等三回。客户端
 *     这时候只是在等答复，不该看到 429/503 —— 等发生在拿到答复之前，连接一直
 *     开着，不会写出半截答复。等过的这个账号带一个标记：但只贴在「最终抛出的
 *     那个错误本身还是限流」时 —— 那样冷却不写它（见 cooldownForFailure），它
 *     只是在等自己的窗口恢复。三回都等不到就不是这个意思了（那个账号确实被限
 *     住了），那种情况下标记不贴，冷却照记。等过窗口之后又失败于凭据被拒/额度
 *     见底/连接断，那个失败仍照旧记账。
 *   - 瞬时失败（5xx、连接）：同一个账号再试，隔 300ms、900ms、2700ms。有人可
 *     换的时候试三次就停手（把机会让给下一个账号）；没有人可换的时候次数没有
 *     上限，刹车是总时限。换账号没有用 —— 上游自己抽了一下，换谁都可能抽。
 *   - 超时：不在这里重试。它说的是这一条请求等太久了，再等一次只是再久一次；
 *     答复就是那条超时错误，客户端自己决定要不要重发。
 *
 * 重试只包住「拿到 Response」这一步，不包读答复：`run` 返回之后就不再重试。
 * 答复已经开始写给客户端了再试一次，会把已经发出去的内容重复一遍，SSE 的帧结构
 * 也跟着碎掉 —— 而且那时候早就没有降级的余地。所以所有调用方传进来的 `run`
 * 都是「发请求、拿到答复的头」为止（老协议的 chunks 也是拿到迭代器就返回），
 * 读正文、转发给客户端都是 `run` 返回之后的事。
 *
 * 次数与时间各有一格预算。有人可换的时候次数是三次（见 BOUNDED_ATTEMPTS）：
 * 打完就把机会让给下一个账号 —— 降级要在几秒内换人，不是把一个账号打满整个
 * 时限。没有人可换的时候没有次数上限，刹车是时间：整轮加起来不超过 budgetMs。
 * 到点停手，把最后一个错误原样抛出去：记冷却、换不换账号都由策略（onAttempt）
 * 照旧决定 —— 重试成功那条路走的是返回值，onAttempt 看到的是成功。
 *
 * 停手的时候，客户端看到的是**上游自己的答复**（状态码与正文）：网关自己编
 * 的一句话（“上游在冷却”）会把上游真的发生了什么盖掉。见 upstreamAnswerError。
 *
 * 预算要算上上游自己花的时间，不然它只是「等待时间」的预算：一次 30s 的超时
 * 不算账，三次就能花掉 90s。所以每轮尝试**开始前**先看还剩多少，没了就不打了。
 *
 * `opts` 里时限与钟只为测试：不然验一次预算要真等三分钟。`unbounded` 不是为
 * 测试：它说的是「还有没有别的账号可换」—— 那是调用点答的。
 */
export interface RetryBudget {
  /** 这一轮的总时限（毫秒）。 */
  budgetMs?: number;
  /** 时间从哪儿来。 */
  now?: () => number;
  /** 等待。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 没有别人可换的时候才为 true：瞬时失败一直试到总时限。
   *
   * 默认 false：试三次就停手，把机会让给下一个账号 —— 降级要在几秒内换人，
   * 不是把一个账号打满 180 秒。
   */
  unbounded?: boolean;
}

export async function runWithRetries<A extends { id: string }, T>(
  account: A,
  what: string,
  run: (account: A) => Promise<T>,
  opts: RetryBudget = {},
): Promise<T> {
  // Read once per call, before the loop: the deadline belongs to this request,
  // and a panel change landing mid-call must not extend or cut it short
  const budgetMs = opts.budgetMs ?? attemptBudgetMs();
  // 没有别人可换的时候才无限重试：有人可换时试三次就换人（见 BOUNDED_ATTEMPTS）。
  const unbounded = opts.unbounded === true;
  const clock = opts.now ?? Date.now;
  const nap = opts.sleep ?? sleep;
  // 时限从第一次上游调用之前算起：等的、试的、上游自己算的都算在里面。
  const deadline = clock() + budgetMs;
  // 打了几次上游：等完窗口之后的那一次也算一次。
  let attempts = 0;
  // 瞬时重试的间隔用第几档（等窗口不占这个阶梯）。
  let retries = 0;
  // 这个账号这一轮替上游的限流等过几回窗口。
  let rateWaits = 0;
  // 三回都等不到：这个账号是真的被限住了 —— 标记不贴，冷却照记。
  let rateWaitsExhausted = false;
  // 这个账号这一轮替上游的限流等过窗口。整轮只算一次，最终抛错时由 stop 决定
  // 贴不贴：只有**最终那个错误本身还是限流**时才贴。
  let rateWaited = false;
  // 上一次尝试的那个错：预算用完时抛的是它（客户端要看到的是最后一次真的发生了
  // 什么，不是一句新造的「超时了」）。
  let lastFailure: unknown = null;
  /**
   * 停手：把最后那个错误交出去。
   *
   * `gaveUp` 说的是「我们是试过之后才停手的」：那种情况下客户端该看到上游
   * 自己的答复（状态码与正文），不是网关编的一句话。
   *
   * 标记的语义是「这个限流是我们替它等过的」，不是「这个账号这一轮里等过什
   * 么」。它只对限流有意义：记账那一层（cooldownForFailure）见到它就当「它在等
   * 自己的窗口」，提前 return null 不写冷却。贴在凭据被拒（401）、额度见底
   * （402）、连接断上，坏凭据的账号就永不冷却、一直被选中重试。三回都等不到
   * 就不是这个意思了（那个账号确实被限住了），那种情况下不贴 —— 冷却照记。
   */
  const stop = (error: unknown, gaveUp = false): never => {
    const isLimit =
      error &&
      typeof error === "object" &&
      classifyUpstreamError(error).kind === "rate-limit";
    const mark = rateWaited && !rateWaitsExhausted && Boolean(isLimit);
    if (gaveUp) {
      const answered = upstreamAnswerOf(error);
      if (answered) {
        const shaped = upstreamAnswerError(answered, error);
        if (mark) withRateWaited(shaped);
        throw shaped;
      }
    }
    if (mark) withRateWaited(error as Record<string, unknown>);
    throw error;
  };
  for (;;) {
    // 预算要算上上游花掉的时间：上一次尝试可能已经吃掉了大头，这时候再打一次
    // 只会在客户端已经等不下去之后才回。第一次尝试前剩余必然为正，不用判。
    if (attempts > 0 && deadline - clock() <= 0) {
      // 预算用完时，标记要按「到底等没等过最后一轮」处理：
      //   - 三轮窗口都等完了还是限流：账号确实被限住了 → 冷却照记（等于等够了）；
      //   - 预算不够、最后一轮没等：不能算「等过了」→ 冷却也照记。
      // 两条都是「不贴标记」，区别只在语义。贴错的后果是：还在限流的账号不记
      // 冷却，下一个请求又挑它、再白等一轮。
      if (rateWaits >= MAX_RATE_WAITS) rateWaitsExhausted = true;
      else rateWaited = false;
      console.log(
        `[ROUTE] ${what} account=${account.id} out of time (${Math.round(budgetMs / 1000)}s), not trying again`,
      );
      stop(lastFailure, true);
    }
    attempts += 1;
    try {
      return await run(account);
    } catch (e) {
      lastFailure = e;
      const wait = rateLimitWaitMs(e, clock);
      const transient = wait === null && isTransientFailure(e);
      // 这一次不值得再试：请求本身的问题、账号接不了、客户端走了、说不清的错。
      if (wait === null && !transient) stop(e);
      if (wait !== null) {
        // 限流：等上游说的那个窗口，最多等 MAX_RATE_WAITS 回。
        if (rateWaits >= MAX_RATE_WAITS) {
          // 等够了还是限流：这个账号是真的被限住了。标记摘掉 —— 冷却照记，
          // 下一个请求不用再拿一个坏窗口试它。
          rateWaitsExhausted = true;
          if (e && typeof e === "object") withoutRateWaited(e);
          console.log(
            `[ROUTE] ${what} account=${account.id} is still rate limited after ${rateWaits} waits, not waiting again`,
          );
          stop(e, true);
        }
        // 等到手也过了这一轮的总时限：不再等，也不再试。
        //
        // 最后一轮根本没等 → 不能算「等过了限流窗口」：那个标记的意思是
        // 「这个限流是我们替它等过的」，而这一轮我们没等（等的是上一轮）。
        // 贴错了的后果是那个还在限流的账号不记冷却，下一个请求又挑它，
        // 再白等一轮。所以在这里先把标记摘掉。
        if (clock() + wait > deadline) {
          rateWaited = false;
          console.log(
            `[ROUTE] ${what} account=${account.id} is rate limited, no time left for a ${Math.ceil(wait / 1000)}s wait, not waiting`,
          );
          stop(e, true);
        }
        rateWaits += 1;
        rateWaited = true;
        console.log(
          `[ROUTE] ${what} account=${account.id} is rate limited, waiting ${Math.ceil(wait / 1000)}s then retrying (wait ${rateWaits}/${MAX_RATE_WAITS})`,
        );
        await nap(wait);
        continue;
      }
      // 瞬时失败：同一个账号再试。
      //
      // 有人可换的时候：试三次就停手，把机会让给下一个账号 —— 降级要在几秒内
      // 换人，不是把一个账号打满整个时限。没有人可换的时候：一直试到总时限
      // （上游抽一下，多试几次就通）。
      if (!unbounded && attempts >= BOUNDED_ATTEMPTS) {
        console.log(
          `[ROUTE] ${what} account=${account.id} ${describedForLog(e)}, no attempt left (${attempts}/${BOUNDED_ATTEMPTS})`,
        );
        stop(e, true);
      }
      // 隔完这一段也过了这一轮的总时限就不等了。
      const delay = retryDelayMs(retries);
      if (clock() + delay > deadline) {
        console.log(
          `[ROUTE] ${what} account=${account.id} ${describedForLog(e)}, no time left for a ${delay}ms retry`,
        );
        stop(e, true);
      }
      retries += 1;
      console.log(
        `[ROUTE] ${what} account=${account.id} ${describedForLog(e)}, retry ${retries} in ${delay}ms`,
      );
      await nap(delay);
    }
  }
}

/**
 * 把「等过了限流窗口」这个标记摘掉：这个失败要照常记冷却。
 *
 * 三回都等不到的时候用：那个账号确实被限住了，把它放下去一会儿是对的。
 */
function withoutRateWaited<T extends object>(error: T): T {
  delete (error as T & RateWaited).rateWaited;
  return error;
}

/**
 * 上游自己的答复：状态码与正文。没有就是 null（那是网关自己编的错）。
 *
 * 正文只认上游自己的：传输层留在错误上的那份。网关自己写的那句话（qoder 的
 * 「删掉 session 文件后重启服务即可重新登录」、tokenrhythm 的「TokenRhythm
 * 上游返回 429：…」）不是上游的答复 —— 把它当上游的答复交给客户端，客户端
 * 看到的就是网关的话，排查时也会认错对象。传输层没留下正文时就是空正文：
 * 上游说了什么，客户端看不到（那不是答复的一部分）。
 */
function upstreamAnswerOf(error: unknown): { status: number; body: string } | null {
  const status = upstreamSaidStatus(error);
  if (status === null) return null;
  return { status, body: upstreamBodyOf(error) ?? "" };
}

/**
 * 上游自己的答复，原样交给客户端。
 *
 * 状态码用上游那个（503 就是 503），正文用上游自己的那句话：网关自己编的
 * 「上游在冷却」会把上游真的发生了什么盖掉 —— 客户端拿到的答复要能看出上游
 * 说了什么，排查时也一样。
 *
 * 上游的状态与业务码仍留在错误上（keepUpstreamTruth）：路由层要靠它们分清
 * 「换个账号也许行」与「换谁都一样」。
 */
function upstreamAnswerError(answered: { status: number; body: string }, original: unknown): AuthError {
  const error = new AuthError(
    `upstream HTTP ${answered.status}`,
    // 上游的正文原样交给客户端 —— 但先抹一遍：上游回显在 401/忙/风控正文里的
    // key 片段、cookie、邮箱、JWT 不该直达调用方。抹的规矩与日志那边是同一套
    // （见 lib/log-scrub.ts 的 scrubForClient），差别只有上限：客户端要看到上游
    // 说了什么，不是给一行日志留 200 字。
    scrubForClient(answered.body, 4000) || `上游返回 ${answered.status}。`,
    answered.status,
    answerTypeOf(answered.status),
  );
  // 上游说过的话，另放在客户端看不到的地方（客户端只拿 message 与 hint）。
  //
  // 传输层没把上游的正文留在错误上时，那些话就在原始错误里（MiniMax 的
  // 「您的限额将在 2026-10-30 07:55:44 重置」）。冷却那一步要读它来算恢复
  // 时刻（见 lib/router/account-cooldown.ts 的 errorTextOf）—— 客户端拿到的
  // 答复里不该混着网关的话，但记账要算得到。
  (error as { detail?: string }).detail = errorTextOf(original);
  // 上游说的「过多久再来」也跟着走：冷却要照上游说的那个时刻算，不是照固定的
  // 一分钟（那会把一个只限流一分钟的账号下线五分钟）。
  const until = cooldownUntilOf(original);
  if (until !== null) withCooldownUntil(error, until);
  return keepUpstreamTruth(error, original);
}

/**
 * 客户端看到的错误类型：跟着上游的状态走。
 *
 * 503 默认会被说成「凭据不对」（sendError 的老规矩），那对上游的 503 是错的
 * 说法：上游挂了不是网关的 key 不对。
 */
function answerTypeOf(status: number): string {
  if (status === 429) return "rate_limit_error";
  if (status === 402) return "usage_limit_error";
  return "api_error";
}

/**
 * The platform's accounts that can serve a request, in weight order.
 *
 * 「能服务」是判定模块的答案（lib/admin/platform-state.ts）：开着**而且**有
 * 能推理的凭据。派发不再自己判一遍 —— 自己判的那一遍只看得见开关，看不见
 * 凭据，于是会挑中一个没有推理 key 的账号，请求打上去才报「账号上没有推理
 * 用的 API key」。那时候答复已经要写给客户端了，收不回来。
 *
 * 额度与冷却不在这里判：它们说的是「这个账号现在接不了这个请求」，不是
 * 「这个账号没有推理的能力」。judged.usable 是现在就能接的那一批。
 */
function servingAccounts(judged: PlatformAvailability): ProviderRow[] {
  return judged.serving;
}

/**
 * 这个失败对客户端意味着什么。
 *
 * 客户端看的是网关的状态，不是上游的：网关自己的 401 是「网关的 key 不对」，
 * 上游的 401 是「这把 key 被上游拒了」，两件事不能撞在同一个状态码上。所以
 * 上游的租户级错误分三档报给客户端：
 *
 *   1. 余额与额度用尽（上游 402，MiniMax 的 1008，别的额度用尽码）→ 402，
 *      提示说充值后恢复。那是客户端唯一能动手的一件事，所以是 402，不是 503。
 *   2. 别的租户级错误（凭据被拒、配额打满）→ 503。这是网关的凭据或配额问题，
 *      客户端无从处理；提示里带上游的状态与原文。
 *   3. 请求本身的问题（上游 400/404/413）→ 原样抛出去：传输层已经报成 502，
 *      提示里带着上游的原文。
 *
 * 换掉状态码之后，上游自己的状态与业务码仍留在错误上（withUpstreamStatus /
 * withBusinessCode）：日志与分类器要能看出真实发生了什么。
 */
export function accountFailure(
  lastError: unknown,
  noBalance: { message: string; hint: string },
): Error {
  // 主机解析不出来：客户端要一句人话（见 unreachableFailure）。
  const unreachable = unreachableFailure(lastError);
  if (unreachable) return unreachable;
  if (isNoBalanceFailure(lastError)) {
    const trace = lastError instanceof TokenRhythmNoBalanceError ? lastError.traceId : "";
    const detail = lastError instanceof Error ? lastError.message : "";
    const error = new AuthError(
      noBalance.message,
      `${noBalance.hint}${detail ? ` ${detail}` : ""}${trace ? ` traceId=${trace}` : ""}`,
      402,
    );
    return keepUpstreamTruth(error, lastError);
  }
  const tenant = tenantLevelFailure(lastError);
  if (tenant) {
    // 网关自己的状态码：这个账号接不了这个请求，客户端处理不了（或者要充值）。
    const error = new AuthError(tenant.message, tenant.hint, tenant.status);
    if (tenant.type) error.type = tenant.type;
    return keepUpstreamTruth(error, lastError);
  }
  if (lastError instanceof Error) return lastError;
  return new AuthError(noBalance.message, noBalance.hint, 502);
}

/**
 * 主机名解析不出来：客户端看到的那句话。
 *
 * Node 与 undici 自己的说法（`fetch failed`、`terminated`）既不是在说客户端的
 * 请求出了什么事，也不是它能处理的东西；真正的原因在 cause 里（`getaddrinfo
 * ENOTFOUND 那台主机`），那句话要原样带到眼前 —— 排查的人和客户端都靠它。
 *
 * 不是这一类就返回 null：别的失败自己会说话（上游的答复比网关编的一句话有用）。
 */
function unreachableFailure(error: unknown): AuthError | null {
  if (classifyUpstreamError(error).kind !== "unreachable") return null;
  const detail = networkDetailOf(error);
  const shaped = new AuthError(
    "upstream host cannot be resolved",
    `上游的主机名解析不出来${detail ? `（${detail}）` : ""}：这个地址在 DNS 里查不到，` +
      "重试同一个地址没有意义。把地址改回可解析的主机之前，这个上游都用不了。",
    502,
  );
  return keepUpstreamTruth(shaped, error);
}

/**
 * 租户级错误：这个账号接不了这个请求，客户端也无从处理。
 *
 * 凭据被拒、配额打满 → 503（网关这边要处理的事）；额度用尽 → 402（客户端能
 * 动手：充值或者等额度）。上游的状态与原文写进提示里，排查时不用猜。
 */
function tenantLevelFailure(
  error: unknown,
): { message: string; hint: string; status: number; type?: string } | null {
  const kind = classifyUpstreamError(error).kind;
  if (kind !== "credential" && kind !== "rate-limit" && kind !== "quota") return null;
  const status = upstreamSaidStatus(error);
  const code = businessCodeOf(error);
  const said = [
    status === null ? null : `上游 HTTP ${status}`,
    code === null ? null : `业务码 ${code}`,
  ].filter((part): part is string => part !== null);
  const because = said.length ? `（${said.join("，")}）` : "";
  // The client reads the type too. A refused credential keeps the type the
  // rest of the gateway uses for a credential problem (the 503 default),
  // and the two quota-ish ones say what they are.
  let type: string | undefined;
  if (kind === "rate-limit") type = "rate_limit_error";
  else if (kind === "quota") type = "usage_limit_error";
  // The code goes into the message too: a client that reads only
  // error.message still sees which failure it was.
  return {
    message: `upstream account cannot serve the request${because}`,
    hint:
      `网关侧的账号无法处理这个请求${because}：${upstreamDetail(error)}。` +
      (kind === "quota"
        ? "额度已用尽：充值或等额度恢复后即可重试。"
        : "凭据或配额属于网关侧，客户端无法处理；待网关更换账号或额度恢复后重试。"),
    // 额度用尽是 402：客户端看到的是「充值/等额度」。其余的租户级错误是网关
    // 自己的事，客户端处理不了，503。
    status: kind === "quota" ? 402 : 503,
    type,
  };
}

/**
 * 上游自己回过的状态，写进提示里。
 *
 * upstreamStatusOf 会退回到错误上的 status 字段：对 MiniMaxApiTenantError
 * 那是上游的状态（401/402/429），但 AuthError 的 status 是网关给客户端看的
 * 那个（502/503），把它当「上游回了什么」会写错。只有传输层明确放上去的
 * upstreamStatus 才是上游真的回过的状态。
 */
function upstreamSaidStatus(error: unknown): number | null {
  const status = upstreamStatusOf(error);
  if (status === null) return null;
  if (error instanceof AuthError && (error as { upstreamStatus?: unknown }).upstreamStatus === undefined) {
    return null;
  }
  return status;
}

/** 上游自己说的话：错误里的原文。 */
function upstreamDetail(error: unknown): string {
  if (error instanceof AuthError) return error.hint || error.message;
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

/**
 * 把上游的状态与业务码留在新错误上。
 *
 * 换了状态码之后，日志与分类器还要能看出真实发生了什么：上游 401 仍然是
 * 上游 401，不是网关的 503。
 */
export function keepUpstreamTruth<T extends object>(error: T, original: unknown): T {
  const status = upstreamStatusOf(original);
  if (status !== null) withUpstreamStatus(error, status);
  const code = businessCodeOf(original);
  if (code !== null) withBusinessCode(error, code);
  // 上游自己的正文也留着：客户端要看到的是上游的原话（见 upstreamAnswerError）。
  const body = upstreamBodyOf(original);
  if (body !== null) withUpstreamBody(error, body);
  return error;
}

/** 记账失败时那句话：短一点，日志里够用就行。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

/**
 * 一次调用的结算：成功就清冷却，失败就按失败记冷却。
 *
 * 流式答复在 underPolicy 返回之后才消费，所以「响应头到了」不能算成功：
 * SSE 中途断了的答复，那个账号是要记冷却的，而且原来那行冷却不能被清掉。
 * 传了这个句柄的调用方，自己负责在流结束（或失败）时结算。
 */
export interface Settlement {
  /** 这次调用成功：清掉那个账号的冷却。 */
  success(): void;
  /** 这次调用失败：按失败给那个账号记冷却。 */
  failure(error: unknown): void;
  /**
   * 内部用：把这次真正服务的账号绑上来。
   *
   * 只有 run() 成功的那一次会绑 —— 失败的那个账号已经由策略记过冷却了。
   */
  bind(accountId: string, what: string): void;
  /**
   * 内部用：有没有别的账号可换（策略与候选数说了算）。
   *
   * 没有别人可换时不记冷却：记了只会让这个平台在一段时间里一个上游请求都不
   * 打，而客户端拿到的还是同一条报错。
   */
  hasAlternatives(has: boolean): void;
}

/**
 * 一个空着的结算句柄，等 underPolicy 告诉它这次是哪个账号服务的。
 *
 * 惰性：句柄本身什么也不做，绑上账号之后才知道清哪一个的冷却。
 * 结算只算一次：失败之后再来的 success() 不算（流断了就是断了，不能因为
 * 「答复写完了」就把冷却清掉）。
 */
export function settlement(): Settlement {
  let accountId: string | null = null;
  let what = "";
  let settled = false;
  // 有没有别的账号可换：默认当有（策略没说话就是照旧记冷却）。
  let hasAlternative = true;
  return {
    bind(id: string, label: string): void {
      if (settled) return;
      accountId = id;
      what = label;
    },
    hasAlternatives(has: boolean): void {
      hasAlternative = has;
    },
    success(): void {
      if (settled || !accountId) return;
      settled = true;
      // 记账失败不许影响请求：冷却写不下去，也不能让已经成功的答复变成 500。
      try {
        clearCooldown(accountId);
      } catch (e) {
        console.warn(`[ROUTE] ${what} account=${accountId} cannot clear its cooldown: ${errorText(e)}`);
      }
    },
    failure(error: unknown): void {
      if (settled || !accountId) return;
      settled = true;
      // 客户端走了：账号没有问题，答复只是没人要。所以既不记冷却，也不把它
      // 写成「这个账号接不了」——那会把一个好好的账号说成坏的。
      if (error instanceof ClientGoneError) {
        console.log(`[ROUTE] ${what} account=${accountId}: the client went away, the answer was cut short`);
        return;
      }
      // 这次失败值多少冷却：判据在 cooldownForFailure（记账那一层）里，这里
      // 只按它的答案记账。超时与等过的限流在那里就已经答了 null —— 派发那条路
      // （onAttempt）问的是同一个函数，同一种失败不会两边两种待遇。
      const decision = cooldownForFailure(accountId, error, Date.now(), hasAlternative);
      if (decision) {
        try {
          setCooldown(accountId, decision.untilMs, decision.reason);
        } catch (e) {
          // 记账失败不许顶掉上游真正的错误。
          console.warn(`[ROUTE] ${what} account=${accountId} cannot record its cooldown: ${errorText(e)}`);
        }
      }
      console.log(
        `[ROUTE] ${what} account=${accountId} cannot serve it (${describedForLog(error)})` +
          (decision ? `, cooling down until ${cooldownStamp(decision.untilMs)}` : ", not cooling down"),
      );
    },
  };
}

/**
 * Run one upstream call on one of the platform's accounts, under its policy.
 *
 * `single` uses the first account that is on and never moves; `fallback` hands
 * the request to the next account when this one cannot serve it; the account
 * that is refused a request that is itself wrong is not left behind — another
 * account would fail the same way.
 *
 * `expiry_first` reaches here like the other policies: the order comes from
 * the balances the quota plugin reported (lib/router/balance-order.ts), and
 * only "this account has no money left" moves the request on to the next
 * account. No platform is special: any platform may pick this policy.
 *
 * `settle` is for the callers that consume the answer after this returns (the
 * streaming ones): the headers arriving is not the answer arriving, so the
 * cooldown of the account that served it is settled by the caller.
 *
 * `availability` 是这一轮已经算好的可用性：上层算过一次就传下来，别再读一遍
 * 那几张表。没给就自己算（答案一样，只是多读一次表）。
 *
 * `retry` 是重试的那一格预算：只为测试（时限与钟都能单独看）。生产上不传。
 */
export async function underPolicy<T>(
  platform: string,
  what: string,
  run: (account: ProviderRow) => Promise<T>,
  settle?: Settlement,
  availability?: PlatformAvailability,
  /**
   * 重试的那一格预算：只为测试（时限与钟都能单独看）。
   *
   * 生产上不传：重试走默认的总时限与真的等待。
   */
  retry?: RetryBudget,
): Promise<T> {
  // 判定：平台现在能不能接请求、有哪些账号能接。判定住在 admin 层
  // （lib/admin/platform-state.ts），派发只取它的答案 —— 判定与派发必须是同一
  // 个答案，各判一遍就会各说各的。
  const judged = availability?.platform === platform ? availability : platformAvailability(platform);
  const serving = servingAccounts(judged);
  // 一个能接的账号都没有：没账号、账号都关着、或者开着但没有凭据。三件是要
  // 改的地方不一样的事，状态由判定给 —— 不再靠账号数去猜。
  if (!serving.length) {
    throw platformWithoutAccount(platform, judged.state);
  }
  const policy = platformPolicy(platform);
  const now = Date.now();

  // 冷却表：判定已经读过一次了（usable 里没有冷却中的账号），这里要的
  // 是「哪个账号在冷却、到什么时候」—— 判定把它带下来，别再读一遍表。
  const cooling = judged.cooling;

  // 候选：判定说现在就能接的账号（开着、有凭据、额度没见底、不在冷却里）。
  // 额度见底的账号不进候选：它发出去只会换一个 402，而判定已经知道它没钱了。
  const usable = judged.usable;

  if (policy === "single") {
    // single 的语义是「就用这一个账号，接不了就说清楚」：面板上写着单一，流量
    // 悄悄落到别的账号上，那就不是面板说的那样了。所以接不了就说接不了。
    const only = serving[0];
    const onlyUntil = cooling.get(only.id);
    if (onlyUntil !== undefined) {
      console.log(
        `[ROUTE] ${what} account=${only.id} cooling down (until ${cooldownStamp(onlyUntil)}), not switching`,
      );
      throw coolingError(only.id, onlyUntil);
    }
    // 额度见底同样要明确拒绝：见底的账号打过去只会换一个 402，而判定已经知道
    // 它没钱了。不去打，也不悄悄换到别的账号身上去。
    //
    // 值是 null 说的是「见底了，但没人知道什么时候回来」：那时答复里不写时刻，
    // 不拿一个固定时长冒充恢复时间。
    const onlySpent = judged.spent.get(only.id);
    if (onlySpent !== undefined) {
      console.log(
        `[ROUTE] ${what} account=${only.id} is out of credits (until ${untilText(onlySpent)}), not switching`,
      );
      throw accountSpentError(platform, only.id, onlySpent);
    }
    // 凭据读不出来：拒绝，不换账号。
    //
    // 「单一」说的是「就用这一个账号」：它的凭据读不出来时悄悄落到别的账号身上
    // 去，面板上写着单一而流量走了别处，那就不是面板说的那样了。
    //
    // 到这里只剩「凭据读不出来」这一种可能：上面已经把冷却与额度见底答掉了，
    // 而 serving 里只有凭据能用（ok）与凭据读不出来（unknown）这两种账号 ——
    // 凭据能用却不在 usable 里的那两种，上面已经答过了。
    if (!usable.some((row) => row.id === only.id)) {
      console.log(
        `[ROUTE] ${what} account=${only.id} credential cannot be read, not switching`,
      );
      throw credentialFaultError(platform, "credential_unknown", 503);
    }
  }

  if (!usable.length) {
    // 有账号，但现在一个都接不了：是额度用尽、凭据过期、凭据读不出来，还是
    // 都在冷却 —— 哪一种由判定说。恢复时间只有额度用尽与冷却有（凭据那两档等
    // 的是人，不是钟）。
    if (judged.state === "out_of_credits") {
      console.log(
        `[ROUTE] ${what} every account is out of credits (until ${untilText(judged.untilMs)}), not switching`,
      );
      throw spentError(judged.untilMs);
    }
    // 网关自己的故障：不是「等一会儿就好」，所以没有 Retry-After —— 等一会儿
    // 不会让凭据自己读出来，也不会让它自己过期。
    if (judged.state === "credential_unknown") {
      console.log(
        `[ROUTE] ${what} the credential of platform ${platform} cannot be read, not switching`,
      );
      throw credentialFaultError(platform, "credential_unknown", 503);
    }
    if (judged.state === "credential_expired") {
      console.log(
        `[ROUTE] ${what} the credential of platform ${platform} is expired, not switching`,
      );
      throw credentialFaultError(platform, "credential_expired", 503);
    }
    const until = judged.untilMs ?? now;
    console.log(
      `[ROUTE] ${what} every account is cooling down (until ${cooldownStamp(until)}), not switching`,
    );
    throw coolingError(serving[0].id, until, true);
  }

  // 被跳过的账号要说出来：为什么没轮上它。
  const position = new Map(serving.map((row, index) => [row.id, index]));
  for (const row of serving) {
    const until = cooling.get(row.id);
    if (until === undefined) continue;
    const after = usable.find((other) => (position.get(other.id) ?? 0) > (position.get(row.id) ?? 0));
    if (after) {
      console.log(
        `[ROUTE] ${what} account=${row.id} cooling down (until ${cooldownStamp(until)}), trying ${after.id}`,
      );
      continue;
    }
    // 后面没有能用的账号了：这个账号本来也轮不到（前面有人接手），除非前面
    // 的人也不行——那上面已经报过了。
    const before = usable.find((other) => (position.get(other.id) ?? 0) < (position.get(row.id) ?? 0));
    if (!before) {
      console.log(
        `[ROUTE] ${what} account=${row.id} cooling down (until ${cooldownStamp(until)}), no account left`,
      );
    }
  }

  const candidates = byOrder(
    // 每个候选跑之前先过一遍「等得起就等 / 瞬时失败再试」：两者重试的都是同一
    // 个账号（客户端不该看到这些错），策略只在全部尝试失败之后才轮到换人。
    usable.map((account) => ({
      id: account.id,
      weight: account.weight,
      run: () =>
        runWithRetries(account, what, run, {
          ...retry,
          // 无限重试只在「没有别的账号可换」时才有意义（见 unboundedFor）。
          unbounded: unboundedFor(account.id),
        }),
    })),
  );
  // expiry_first 的候选：次序由余额决定，所以「下一个」每次都得重新钉。
  //
  // 钉住的单位是平台，状态在 balance-order 里；这里只负责「把手上的候选按 id
  // 递出去」。试过的账号不再给第二次机会 —— 否则重新钉的时候又会钉回同一个。
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const attempted: string[] = [];
  const nextByBalance = async () => {
    const rest = usable.map((account) => account.id).filter((id) => !attempted.includes(id));
    if (!rest.length) return null;
    const id = pinNextAccount(platform, rest);
    if (id === null) return null;
    const candidate = candidateById.get(id);
    if (!candidate) return null;
    attempted.push(id);
    return candidate;
  };

  // 有没有别的账号可换：策略与候选数说了算。降级且不止一个候选时才算有。
  //
  // 没有别人可换时不记冷却（见 cooldownForFailure）：记了只会让这个平台在一
  // 段时间里一个上游请求都不打，而客户端拿到的还是同一条报错。结算那条路
  // （流式答复的 failure）问的是同一件事，所以同一个答案带下去。
  const hasAlternative =
    (policy === "fallback" || policy === "expiry_first") && candidates.length > 1;
  settle?.hasAlternatives(hasAlternative);

  // 试的次序：权重大的先试（select 里也是这个次序，byWeight）。
  const tryOrder = byWeight(candidates);

  /**
   * 这个账号要不要无限重试（试到总时限）。
   *
   * 无限重试只在**没有别的账号可换**时才有意义：换账号要快，把第一个账号打
   * 满 180 秒不是降级，是把整轮都耗在这一个账号上。
   *
   *   - 降级：只有最后一个候选无限重试 —— 它后面没人可换。
   *   - 单一与余额到期优先：不换账号（到期优先只在「没钱」时换，那不是这次的
   *     失败），没人可换 → 一样无限重试。
   */
  function unboundedFor(id: string): boolean {
    if (policy !== "fallback") return true;
    return tryOrder.findIndex((candidate) => candidate.id === id) === tryOrder.length - 1;
  }

  return selectProvider(policy, candidates, {
    // expiry_first：只有「这个账号没钱了」才换人，判据是通用的那一份（402 /
    // 平台自己的余额不足码）。它说没钱时把钉住的账号忘掉，下一次重新钉。
    insufficient: isNoBalanceFailure,
    next: policy === "expiry_first" ? nextByBalance : undefined,
    onMissingBalance: async () => {
      forgetPinnedAccount(platform);
    },
    // 账号层「这个失败要不要换人」的判据。
    //
    // 它只看得到 `run` 抛出来的错，而老协议那条路上 `run` 只把流的迭代器交回来
    // —— 请求是在 underPolicy 返回之后才开始发的（见 lib/router/upstreams/qoder.ts
    // 的 run：它 return 的是一个还没被 next() 的生成器，读正文、转发给客户端都
    // 在策略之外）。所以那一路上帧里带的失败（排队、限流、没额度）走不到这里，
    // 账号层不会因为这些错换人，也不会跳过这个账号。
    //
    // 后果要说清楚：老协议那一路的换人是**根路由**（lib/router/handle.ts 的
    // select）在换 target，不是这里在换账号。账号表只在这里替「连接层就失败」
    // 的那几种（凭据读不出来、发请求时上游直接 4xx/5xx）做决定。
    degradable: isDegradableUpstreamError,
    onAttempt: (candidate, error) => {
      if (!error) {
        // 答复已经成功：冷却没有理由留着 —— 除非调用方自己结算（流式答复
        // 在这里返回之后才消费，「响应头到了」不算成功）。
        if (settle) {
          settle.bind(candidate.id, what);
          return;
        }
        // 记账失败不许影响请求 —— 冷却写不下去，也不能让已经成功的答复变成 500。
        try {
          clearCooldown(candidate.id);
        } catch (e) {
          console.warn(`[ROUTE] ${what} account=${candidate.id} cannot clear its cooldown: ${errorText(e)}`);
        }
        return;
      }
      // 客户端走了：账号没有问题，答复只是没人要。不换账号（换了也一样没人
      // 要），也不说这个账号「接不了」——那会把一个好好的账号说成坏的。
      if (error instanceof ClientGoneError) {
        console.log(`[ROUTE] ${what} account=${candidate.id}: the client went away, the answer was cut short`);
        return;
      }
      // 这次失败值多少冷却：判据在 cooldownForFailure（记账那一层）里，这里
      // 只按它的答案记账 —— 流式答复的结算（Settlement.failure）问的是同一个
      // 函数，两边不会给同一个错两种待遇。
      const decision = cooldownForFailure(candidate.id, error, Date.now(), hasAlternative);
      if (decision) {
        try {
          setCooldown(candidate.id, decision.untilMs, decision.reason);
        } catch (e) {
          // 记账失败不许顶掉上游真正的错误：那会让 429 变成一个没头没脑的 500。
          console.warn(`[ROUTE] ${what} account=${candidate.id} cannot record its cooldown: ${errorText(e)}`);
        }
      }
      const moves = isDegradableUpstreamError(error);
      const at = candidates.findIndex((c) => c.id === candidate.id);
      const next = moves && policy === "fallback" ? candidates[at + 1]?.id : undefined;
      // 换不换人、换到谁，说清楚：换人有目标就报目标，没有目标而策略是要换的
      // 就报「没人可换了」，其余报「不换」。
      let switching = ", not switching";
      if (next) switching = `, trying ${next}`;
      else if (moves && policy === "fallback") switching = ", no account left";
      console.log(
        `[ROUTE] ${what} account=${candidate.id} cannot serve it (${describedForLog(error)})` +
          switching +
          (decision ? `, cooling down until ${cooldownStamp(decision.untilMs)}` : whyNotCooling(error)),
      );
    },
    // The caller sees the error the upstream produced, not a new one — except
    // when that error is Node's own words for something the client cannot
    // read (see unreachableFailure).
    failure: (lastError) =>
      unreachableFailure(lastError) ??
      (lastError instanceof Error ? lastError : new AuthError("upstream failed", "上游没有响应。", 502)),
  });
}

/**
 * 账号在冷却：告诉调用方到什么时候能试。
 *
 * 503：这是网关这边的账号接不了，不是请求本身的问题，客户端处理不了。`why`
 * 说的是哪一种接不了 —— 冷却，还是额度用尽 —— 两种的恢复时间来源不同，提示
 * 里得说清楚。
 *
 * Retry-After 跟着错误走（deliver.ts 把它写进头里）：客户端不用自己猜多久
 */
export function coolingError(accountId: string, untilMs: number, all = false, why = "冷却中"): AuthError {
  const minutes = Math.max(1, Math.ceil((untilMs - Date.now()) / 60_000));
  const when = cooldownStamp(untilMs);
  const error = new AuthError(
    all ? "every upstream account is cooling down" : "upstream account is cooling down",
    all
      ? `网关侧所有账号都处于${why}，最早 ${when} 恢复（约 ${minutes} 分钟后）。到点自动重试。`
      : `网关侧的账号 ${accountId} 处于${why}，${when} 恢复（约 ${minutes} 分钟后）。到点自动重试；` +
        `如需其他账号接手，请把上游的生效策略改成「降级」。`,
    503,
  );
  return withRetryAfter(error, untilMs);
}

/**
 * 日志里那个「到什么时候」：不知道就写 unknown，不写一个编出来的时刻。
 */
function untilText(untilMs: number | null): string {
  return untilMs === null ? "unknown" : cooldownStamp(untilMs);
}

/**
 * 额度用尽：所有账号都没额度了。
 *
 * 402：额度用尽是客户端能动手的事（充值，或者等额度回来），所以是 402，不是
 * 503 —— 503 说的是「等一会儿就好」，而额度等的是窗口。
 *
 * 额度什么时候回来跟着错误走（Retry-After）：那是平台自己说的窗口，不是猜的。
 * null 是「没人知道什么时候回来」：那时正文里不写时刻（也不说「恢复」），
 * 因为额度不会因为过了某个固定时长就回来。
 */
export function spentError(untilMs: number | null): AuthError {
  if (untilMs === null) {
    return new AuthError(
      "every upstream account is out of credits",
      "网关侧所有账号的额度都已用尽。额度恢复之前无法处理这个请求；可以充值或等待额度恢复。",
      402,
      "usage_limit_error",
    );
  }
  const minutes = Math.max(1, Math.ceil((untilMs - Date.now()) / 60_000));
  const when = cooldownStamp(untilMs);
  const error = new AuthError(
    "every upstream account is out of credits",
    `网关侧所有账号的额度都已用尽，最早 ${when} 恢复（约 ${minutes} 分钟后）。到点自动重试；如需立即恢复，只能为该上游充值。`,
    402,
    "usage_limit_error",
  );
  return withRetryAfter(error, untilMs);
}

/**
 * 额度用尽：那个账号没钱了。
 *
 * 402：与「所有账号都没额度」是同一个口径 —— 额度用尽就是 402，客户端看到的是
 * 「充值/等额度」。单打独斗的那个账号见底时说清楚是哪个账号：这个上游的策略
 * 是「单一」，不会换到别的账号身上去，客户端要知道自己在等的是哪一个。
 *
 * Retry-After 跟着错误走（deliver.ts 把它写进头里）：什么时候恢复是平台自己
 * 说的窗口，不是猜的。null 是不知什么时候回来：不写时刻，不说「恢复」。
 */
export function accountSpentError(
  platform: string,
  accountId: string,
  untilMs: number | null,
): AuthError {
  const reason =
    "能做的就是充值或者等额度；这个上游的生效策略是「单一」，不会换到别的账号。";
  if (untilMs === null) {
    return new AuthError(
      "upstream account is out of credits",
      `上游 ${platform} 的账号 ${accountId} 的额度用尽了。${reason}`,
      402,
      "usage_limit_error",
    );
  }
  const minutes = Math.max(1, Math.ceil((untilMs - Date.now()) / 60_000));
  const when = cooldownStamp(untilMs);
  const error = new AuthError(
    "upstream account is out of credits",
    `上游 ${platform} 的账号 ${accountId} 的额度用尽了，最早 ${when} 恢复（约 ${minutes} 分钟后）。${reason}`,
    402,
    "usage_limit_error",
  );
  return withRetryAfter(error, untilMs);
}
