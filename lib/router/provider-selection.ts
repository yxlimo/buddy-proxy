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
export function byOrder<T>(items: { id: string; run: () => Promise<T> }[]): ProviderCandidate<T>[] {
  return items.map((item, index) => ({ id: item.id, weight: items.length - index, run: item.run }));
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
};

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
  // Qoder's queue: the request waits on the same account and the account
  // stays. Another account would only be another queue, so this one is not
  // the account's fault.
  //
  // The relay station's busy is different: it has already been retried on
  // the same account (the transport does that), so when it still fails the
  // account cannot serve the request at all right now — and it is counted as
  // a 5xx, which is degradable.
  if (isBusy(error)) return { degradable: false, status, kind: "busy" };
  // The platform's own code says more than the status does.
  const code = businessCodeOf(error);
  const byCode = code === null ? null : classifyBusinessCode(code);
  if (byCode) return { degradable: byCode.degradable, status, kind: byCode.kind };
  if (status !== null) {
    if (status === 401 || status === 403) return { degradable: true, status, kind: "credential" };
    if (status === 402) return { degradable: true, status, kind: "no-balance" };
    if (status === 429) return { degradable: true, status, kind: "rate-limit" };
    if (status === 408) return { degradable: true, status, kind: "timeout" };
    if (status >= 500) return { degradable: true, status, kind: "server" };
    // 400, 404, 413 and the rest: the request itself.
    return { degradable: false, status, kind: "request" };
  }
  const network = networkReason(error);
  if (network) {
    return { degradable: true, status: null, kind: network === "timeout" ? "timeout" : "connection" };
  }
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
  return NAMED_CODES[code.toLowerCase()] ?? null;
}

/** Qoder's queue: the request waits on this account, so the account stays. */
function isBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name ?? "");
  return name === "LimitError";
}

/**
 * The network failure behind an error, if that is what it is.
 *
 * A connection that failed, a socket that hung up, a timeout that ran out —
 * none of them is the request's fault, and the next account may well reach
 * the upstream.
 */
function networkReason(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code ?? "");
    if (
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EPIPE",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(code)
    ) {
      return "connection";
    }
    const name = String(current.name ?? "");
    if (name === "TimeoutError") return "timeout";
    if (name === "AbortError") return "timeout";
    const message = String(current.message ?? "").toLowerCase();
    if (message.includes("fetch failed") || message.includes("socket hang up")) return "connection";
    current = current.cause;
  }
  return null;
}
