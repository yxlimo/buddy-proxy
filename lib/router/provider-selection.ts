// lib/router/provider-selection.ts — an upstream's own policy.
//
// The root route decides which upstream serves a published model; the upstream
// then decides which of its accounts pays for the request. The two policies
// are independent, and this file is the upstream's side of it.
//
// `single` and `fallback` are the shared package's (lib/router/selection.ts).
// `expiry_first` belongs to the relay stations: the account whose balance runs
// out first takes the request, and when the wallet says another account runs
// out first, that one takes over. It is a `single` with a different order —
// the candidates come in the order the wallet says, and only the first one is
// used.
//
// The upstream side also knows what a failure means: the account that cannot
// serve the request hands it to the next one, but a request that is wrong
// does not — another account would fail the same way.
//
// `expiry_first` is a single with a hook: the account whose balance runs out
// first takes the request, and when the platform says it has no credit, the
// hook scans the balances again and the next account takes over.

import { select, type SelectionCandidate } from "./selection.ts";
import { AuthError } from "../credential.ts";
import { businessCodeOf, upstreamStatusOf } from "../upstream-status.ts";
import { TokenRhythmNoBalanceError } from "../tokenrhythm/transport.ts";
import type { ProviderPolicy } from "../providers.ts";

/** The policy of an upstream: which of its accounts takes a request. */
export type { ProviderPolicy };

/** A candidate on the upstream side: one account. */
export type ProviderCandidate<T> = SelectionCandidate<T>;

/**
 * Run the request under the upstream's policy.
 *
 * `single` and `fallback` go through the shared package. `expiry_first` is a
 * `single` with a hook: its candidates are already in the order the wallet
 * says, and when one of them says it has no credit, the hook scans the
 * balances again and the next account takes over.
 */
/** How the upstream side picks an account. */
export interface ProviderSelectionOptions<T> {
  /** The failures the next account could serve instead. */
  degradable?: (error: unknown) => boolean;
  /**
   * The hook of expiry_first: this failure means "this account has no money
   * left", so the scan runs again and the next account takes the request.
   */
  insufficient?: (error: unknown) => boolean;
  /** After every attempt. */
  onAttempt?: (candidate: ProviderCandidate<T>, error: unknown | null) => void;
  /** When every candidate is used up. */
  failure?: (lastError: unknown, tried: string[]) => Error;
  /**
   * expiry_first: where the next account comes from.
   *
   * The policy re-orders the accounts by their balances, so which one is next
   * is only known after a fresh scan. This asks for it.
   */
  next?: () => Promise<ProviderCandidate<T> | null>;
  /**
   * The hook of expiry_first: the account said it has no money left.
   *
   * The caller puts that account aside, scans the balances again and pins
   * another one; then the next attempt goes to that one.
   */
  onMissingBalance?: (error: unknown) => Promise<void>;
}

export async function selectProvider<T>(
  policy: ProviderPolicy,
  candidates: ProviderCandidate<T>[],
  options?: ProviderSelectionOptions<T>,
): Promise<T> {
  // The policies are spelled out: a policy that is not in the list is a
  // mistake, and a mistake must not turn into a quiet fallback.
  if (policy !== "single" && policy !== "fallback" && policy !== "expiry_first") {
    throw new AuthError(
      "unknown provider policy",
      `没有这个生效策略：${String(policy)}。只能选 single、fallback、expiry_first。`,
      500,
    );
  }
  if (policy === "single") {
    return select<T>({
      strategy: "single",
      candidates,
      onAttempt: options?.onAttempt,
      failure: options?.failure,
    });
  }
  if (policy === "expiry_first") {
    // expiry_first is a single with a hook: the account whose balance runs
    // out first takes the request, and when it says it has no money left the
    // hook switches to the next one. It is not a plain single — an account
    // with no credit must not fail the request while another one still has
    // some.
    const insufficient = options?.insufficient ?? options?.degradable ?? (() => false);
    const next = options?.next;
    const tried: string[] = [];
    let lastError: unknown;
    for (;;) {
      const candidate = next
        ? await next()
        : candidates.find((c) => !tried.includes(c.id)) ?? null;
      if (!candidate) break;
      // A candidate that was already tried does not get a second turn: the
      // hook has to pin another one.
      if (tried.includes(candidate.id)) break;
      tried.push(candidate.id);
      try {
        const value = await candidate.run();
        options?.onAttempt?.(candidate, null);
        return value;
      } catch (e) {
        options?.onAttempt?.(candidate, e);
        lastError = e;
        // Only "no money left" moves on: anything else is either a wrong
        // request (another account would answer the same way) or an account
        // that can serve it right now.
        if (!insufficient(e)) throw e;
        // The hook: the account is put aside, the balances are scanned again
        // and another one is pinned.
        await options?.onMissingBalance?.(e);
      }
    }
    throw options?.failure
      ? options.failure(lastError, tried)
      : (lastError instanceof Error
          ? lastError
          : new AuthError("no account left", "没有可用的账号了。", 503));
  }
  return select<T>({
    strategy: "fallback",
    candidates,
    degradable: options?.degradable,
    onAttempt: options?.onAttempt,
    failure: options?.failure,
  });
}

/**
 * The candidates in the order they are tried.
 *
 * The order is the caller's — the key order, the tenant order, or the order
 * the wallet says — and the first one weighs the most, so the shared package
 * tries it first.
 */
/**
 * 把一组候选按次序排好。
 *
 * 每项可以带自己的权重（账号的权重：大的先试）。没带就用它在列表里的位置
 * —— 后面的先试，跟从前一样。
 */
export function byOrder<T>(
  items: { id: string; weight?: number; run: () => Promise<T> }[],
): ProviderCandidate<T>[] {
  return items.map((item, index) => ({
    id: item.id,
    weight: item.weight ?? items.length - index,
    run: item.run,
  }));
}

/* ------------------------------------------------------------------ *
 * What a failure means
 * ------------------------------------------------------------------ */

/**
 * The codes that mean the account cannot serve the request.
 *
 * MiniMax's open platform puts its own code in the answer — sometimes in a
 * 200, in `base_resp.status_code` — so the HTTP status alone does not say
 * whether the account is out of credit or the request is wrong.
 */
const ACCOUNT_CODES: Record<number, string> = {
  1002: "rate-limit", // 请求频率超限
  1004: "credential", // 未授权
  1008: "quota", // 余额不足
  1310: "rate-limit", // 限额到了，重置时间写在正文里
  2049: "credential", // 无效的 API Key
  2053: "quota", // 积分不足
  2056: "quota", // 超出 M Plan 资源限制
  2062: "rate-limit", // 超出 M Plan 速率限制
  2067: "quota", // 套餐额度已用完
};

/** The codes that mean the request itself is wrong: another account fails too. */
const REQUEST_CODES: Record<number, string> = {
  2013: "request", // 参数错误
  2022: "request", // 模型不存在或无权使用
  // WorkBuddy 的渠道校验：请求不是官方客户端发来的。它认的是**模拟端的
  // 指纹**，跟哪个账号无关 —— 换一个 WorkBuddy 账号也是这个错，所以不降级、
  // 不冷却（2026-11-02，作者复查发现：同一个 11128，走 400 那条路是「请求
  // 本身的问题」，走 200 那条路却成了「上游挂了」，两条路的处理不一样）。
  11128: "request",
};

/** The codes the other platforms use, in their own words. */
const NAMED_CODES: Record<string, { degradable: boolean; kind: string }> = {
  quota_exceeded: { degradable: true, kind: "quota" }, // 墨点不够
  rate_limit_exceeded: { degradable: true, kind: "rate-limit" }, // 超 RPM/TPM
  insufficient_balance: { degradable: true, kind: "no-balance" },
  invalid_api_key: { degradable: true, kind: "credential" },
  api_key_disabled: { degradable: true, kind: "credential" },
  user_disabled: { degradable: true, kind: "credential" },
  whitelist_required: { degradable: true, kind: "credential" },
  invalid_request_error: { degradable: false, kind: "request" },
  model_not_available: { degradable: false, kind: "request" },
  invalid_model_error: { degradable: false, kind: "request" },
  not_found: { degradable: false, kind: "request" },
  // 七牛云: 这个模型不在这把 key 的商品分组里。key 本身是好的 —— 换账号
  // （除非它有别的分组）也是一样的结果，所以这是请求的问题，不是账号的。
  model_group_access_denied: { degradable: false, kind: "model" },
};

/**
 * The codes that mean the model is not in this key's group.
 *
 * 七牛云's 403 `model_group_access_denied`: the key is fine, but the model is
 * not in the product group this key was sold with. The platform's own
 * `/v1/models` is wider than what the key can use — that is the platform's
 * business, not ours to fix.
 */
const MODEL_GROUP_CODES = new Set(["model_group_access_denied"]);

/**
 * The codes that mean the model itself is throttled.
 *
 * 七牛云's free models (`*-free`) have their own rate limit: the body says
 * 「Too many requests for this free model」. That limit is on the model, not on
 * the account — another account would be throttled the same way, and the
 * account's paid models are still fine.
 */
const FREE_MODEL_RATE_LIMIT_CODES = new Set(["rate_limit_exceeded_error", "rate_limit_exceeded"]);

/** What a failure says about the account that produced it. */
export interface UpstreamFailure {
  /** Can the next account serve the request instead? */
  degradable: boolean;
  /** The status the upstream sent, when it sent one. */
  status: number | null;
  /** A short word for the log. */
  kind: string;
}

/**
 * Is this failure the candidate's fault?
 *
 * The account moves on when it cannot serve the request: the service is down
 * or too slow, the quota is full, the money is gone, the credential is
 * refused. A request that is wrong does not move on — another account would
 * answer the same way.
 */
export function isDegradableUpstreamError(error: unknown): boolean {
  return classifyUpstreamError(error).degradable;
}

/**
 * Is this failure "the account has no money left"?
 *
 * That is the hook of expiry_first: the account whose balance runs out first
 * takes the request, and when the platform says it has no credit, the next
 * one by the fresh scan takes over.
 */
export function isNoBalanceFailure(error: unknown): boolean {
  if (error instanceof TokenRhythmNoBalanceError) return true;
  if (upstreamStatusOf(error) === 402) return true;
  // MiniMax's 1008 is 「余额不足」。
  return businessCodeOf(error) === 1008;
}

/** What a failure says about the account that produced it. */
export function classifyUpstreamError(error: unknown): UpstreamFailure {
  const status = upstreamStatusOf(error);
  // The upstream parked the model in a queue and waiting it out did not help.
  //
  // Degradable: another target has its own queue, and this one being full says
  // nothing about that one. Not the account's fault either, so it is not put
  // aside (see cooldownForFailure): a cooldown takes the account's *other*
  // models down with it, and those were never queued.
  //
  // No status: the queue answer arrives inside a 200 stream, so the upstream
  // never sent one. The 429 the client finally sees is the gateway's own
  // answer, not the upstream's.
  if (isQueued(error)) return { degradable: true, status: null, kind: "queued" };
  // The platform's own code says more than the status does.
  const code = businessCodeOf(error);
  // 「这个免费模型被限流」：换账号没用（限的是模型），也不该把整个账号下线
  // （别的模型还好好的）。所以它既不降级也不冷却 —— 与分组拒绝同一类。
  if (isFreeModelRateLimit(error)) return { degradable: false, status, kind: "model" };
  const byCode = code === null ? null : classifyBusinessCode(code);
  if (byCode) return { degradable: byCode.degradable, status, kind: byCode.kind };
  // 「模型不在这个 key 的分组里」：信封里没解出这个码时，正文里写着也算。
  // 状态码这时是 403 —— 按凭据被拒处理会把整个账号冷却掉，而账号没有坏。
  if (isModelGroupDenied(error)) return { degradable: false, status, kind: "model" };
  if (status !== null) {
    if (status === 401 || status === 403) return { degradable: true, status, kind: "credential" };
    if (status === 402) return { degradable: true, status, kind: "no-balance" };
    if (status === 429) return { degradable: true, status, kind: "rate-limit" };
    if (status === 408) return { degradable: true, status, kind: "timeout" };
    if (status >= 500) return { degradable: true, status, kind: "server" };
    // 400, 404, 413 and the rest: the request itself.
    return { degradable: false, status, kind: "request" };
  }
  // The network failure keeps its own name: "the host does not resolve" is a
  // different problem from "the connection broke", and the two are handled
  // differently (see TRANSIENT_KINDS in upstreams/policy.ts and
  // cooldownForFailure in account-cooldown.ts).
  const network = networkReason(error);
  if (network) return { degradable: true, status: null, kind: network };
  return { degradable: false, status: null, kind: "unknown" };
}

/** The failure in one line: the kind and the status, for the log. */
export function describeUpstreamError(error: unknown): string {
  const failure = classifyUpstreamError(error);
  const code = businessCodeOf(error);
  const said = code === null ? "" : ` code=${code}`;
  return failure.status === null
    ? `${failure.kind}${said}`
    : `${failure.kind} HTTP ${failure.status}${said}`;
}

/** What the platform's own code means. */
function classifyBusinessCode(code: number | string): { degradable: boolean; kind: string } | null {
  if (typeof code === "number") {
    const account = ACCOUNT_CODES[code];
    if (account) return { degradable: true, kind: account };
    const request = REQUEST_CODES[code];
    if (request) return { degradable: false, kind: request };
    return null;
  }
  // 码写成字符串的样子（"11128"）也要按数字查一遍：同一个码，两种写法，
  // 分类得一样。不然它落回状态码那一条 —— 走 200 那条路时状态是 502，
  // 就成了「上游挂了」，降级会换一个账号再试一次（而这个错跟账号无关，
  // 必然再错一次）（2026-11-03，作者复查发现）。
  const asNumber = Number(code.trim());
  if (Number.isFinite(asNumber) && String(asNumber) === code.trim()) {
    return classifyBusinessCode(asNumber);
  }
  return NAMED_CODES[code.toLowerCase()] ?? null;
}

/**
 * 这个失败是不是「模型不在这个 key 的分组里」。
 *
 * 码在信封里（业务码）是常态；正文里写着也算 —— 有些传输层不拆信封，只把
 * 上游的原话带回来。
 */
function isModelGroupDenied(error: unknown): boolean {
  const code = businessCodeOf(error);
  if (typeof code === "string" && MODEL_GROUP_CODES.has(code.toLowerCase())) return true;
  const text = errorTextOf(error).toLowerCase();
  for (const known of MODEL_GROUP_CODES) {
    if (text.includes(known)) return true;
  }
  return false;
}

/**
 * 这个失败是不是「这个免费模型被限流」。
 *
 * 限的是模型，不是账号：换账号一样被限（同一个免费模型），账号的别的模型
 * 照常能用。所以它不是账号的错 —— 不换账号，也不写冷却。
 *
 * 两个条件都要：业务码说是限流，正文里写着 free model。只满足一个不算 ——
 * 普通的 429 仍然是账号（或者说整个 key）被限流，照旧降级。
 */
function isFreeModelRateLimit(error: unknown): boolean {
  const text = errorTextOf(error).toLowerCase();
  if (!text.includes("free model")) return false;
  const code = businessCodeOf(error);
  if (typeof code === "string" && FREE_MODEL_RATE_LIMIT_CODES.has(code.toLowerCase())) return true;
  // 信封里没解出码时，正文里写着码也算。
  for (const known of FREE_MODEL_RATE_LIMIT_CODES) {
    if (text.includes(known)) return true;
  }
  return false;
}

/** 错误里能读到的原文：消息、提示，还有平台塞进来的那些字段。 */
function errorTextOf(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const err = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "hint", "body", "text", "detail"]) {
    const value = err[key];
    if (typeof value === "string" && value) parts.push(value);
  }
  return parts.join("\n");
}

/**
 * The upstream parked the model in a queue.
 *
 * The type carries the meaning, the way the transports carry theirs: the queue
 * answer is not a status and not a business code — it is the upstream saying
 * "no slot for this model right now, and waiting it out did not help" (see
 * lib/qoder/queue.ts).
 */
function isQueued(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name ?? "");
  return name === "QueuedError";
}

/**
 * undici gives up on a quiet upstream: no headers, or no body for a while.
 *
 * The socket was fine and then stopped answering, so this is "the upstream is
 * too slow", not "the upstream could not be reached". The two lead to
 * different handling, so they must not share a word.
 */
const NETWORK_TIMEOUT_CODES = new Set(["UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);
const NETWORK_TIMEOUT_NAMES = new Set([
  "BodyTimeoutError",
  "HeadersTimeoutError",
  "TimeoutError",
  "AbortError",
]);

/**
 * The codes that mean the host cannot be reached at all — not now, not later.
 *
 * `ENOTFOUND` is the one that matters: the name is not in the DNS, so every
 * attempt fails the same way until someone fixes the address or the DNS.
 * `EAI_FAIL` is the resolver saying the same thing in another dialect,
 * `ERR_INVALID_URL` is an address that cannot even be parsed, and `ENOTSUP`
 * is the address family this machine cannot use.
 */
const NETWORK_UNREACHABLE_CODES = new Set(["ENOTFOUND", "EAI_FAIL", "ERR_INVALID_URL", "ENOTSUP"]);

/** The codes that mean the connection broke: worth another try on the same account. */
const NETWORK_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * The network failure behind an error, if that is what it is.
 *
 * A connection that failed, a socket that hung up, a timeout that ran out —
 * none of them is the request's fault, and the next account may well reach
 * the upstream.
 *
 * The timeout is checked first: undici's own body/headers timeouts carry a
 * code in the `UND_ERR_*` family like the connection ones do, and they are one
 * step down the chain (undici throws `TypeError: terminated` and puts its own
 * error in the cause). Its default body timeout is five minutes, so a stream
 * that goes quiet ends up here — as "timeout", never as "connection".
 *
 * The whole chain is read before anything is decided, because the outermost
 * error is usually undici's own words and nothing else: `TypeError: fetch
 * failed` says nothing about why. Deciding on it (as this used to) turned a
 * name that does not resolve into an ordinary broken connection — the same
 * account was then retried every 2.7s until the attempt budget ran out
 * (2026-11-10: one upstream host in its region had gone NXDOMAIN, one request
 * made 67 attempts and hung the client for 180s).
 *
 * The three are asked in this order, and the order is the point:
 *
 *   1. timeout      — the socket was fine and then went quiet
 *   2. unreachable  — the name is not in the DNS; nothing will fix it by waiting
 *   3. connection   — the connection broke, which one more try often fixes
 *
 * "unreachable" outranks "connection": when one link in the chain says the
 * host does not resolve, waiting will not change it.
 */
function networkReason(error: unknown): string | null {
  const seen = new Set<unknown>();
  const codes: string[] = [];
  const names: string[] = [];
  const messages: string[] = [];
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    codes.push(String(current.code ?? ""));
    names.push(String(current.name ?? ""));
    messages.push(String(current.message ?? "").toLowerCase());
    current = current.cause;
  }
  if (codes.some((code) => NETWORK_TIMEOUT_CODES.has(code)) || names.some((name) => NETWORK_TIMEOUT_NAMES.has(name))) {
    return "timeout";
  }
  if (codes.some((code) => NETWORK_UNREACHABLE_CODES.has(code))) return "unreachable";
  if (codes.some((code) => NETWORK_CONNECTION_CODES.has(code))) return "connection";
  // A `fetch failed` with nothing under it is still a broken connection: that
  // is all anyone can say about it.
  if (messages.some((message) => message.includes("fetch failed") || message.includes("socket hang up"))) {
    return "connection";
  }
  return null;
}

/**
 * The network failure in its own words: the step of the chain that carries a
 * code, or the last thing said when none of them does.
 *
 * The outer error only ever says `fetch failed`, so the reason lives one step
 * down. Whoever tells the client what happened needs that step — and only that
 * step: `fetch failed` is the one sentence the client must not be handed.
 */
export function networkDetailOf(error: unknown): string {
  const seen = new Set<unknown>();
  let withCode = "";
  let last = "";
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code ?? "");
    const message = String(current.message ?? "");
    const said = [code, message].filter(Boolean).join(" ");
    if (said) last = said;
    if (code && said) withCode = said;
    current = current.cause;
  }
  return withCode || last;
}
