// lib/router/upstreams/policy.ts — one upstream's accounts, under its policy.
//
// Every adapter that is not the relay station runs its call through
// underPolicy: the platform's policy picks the account, the account is
// skipped while it cools down, and the failure is shaped into what the
// client sees. UpstreamContext is what an adapter is handed.

import { AuthError } from "../../credential.ts";
import type { WorkBuddyModel } from "../../workbuddy/models.ts";
import { TokenRhythmNoBalanceError } from "../../tokenrhythm/transport.ts";
import { byOrder, classifyUpstreamError, describeUpstreamError, isDegradableUpstreamError, isNoBalanceFailure, selectProvider } from "../provider-selection.ts";
import {
  businessCodeOf,
  cooldownUntilOf,
  upstreamStatusOf,
  withBusinessCode,
  withCooldownUntil,
  withUpstreamStatus,
} from "../../upstream-status.ts";
import { clearCooldown, cooldownUntil, isCoolingDown, setCooldown } from "../../cooldown.ts";
import { cooldownForFailure, cooldownStamp, errorTextOf } from "../account-cooldown.ts";
import { accountsOfPlatform, type ProviderRow } from "../../providers.ts";
import { platformPolicy } from "../../platforms.ts";
import { platformWithoutAccount } from "../routes.ts";
import { withRetryAfter } from "../deliver.ts";

/** What the adapters need to know about the router they run in. */
export interface UpstreamContext {
  /** How often a queued legacy request is tried again. */
  legacyMaxAttempts: number;
  legacyRetryMs: number;
  /** How often a failed new-protocol request is tried again. */
  qoderMaxAttempts: number;
  /** How often a busy relay is tried again, on the same account. */
  tokenRhythmMaxAttempts: number;
  /** Whether a request is written to the log. */
  logRoute: boolean;
  /**
   * The client's session headers, for the open API platforms.
   *
   * The simulated clients (Qoder, WorkBuddy, MiniMax Code, ZCode) rebuild the
   * request the way the desktop client builds it — only the fields they need,
   * everything else in the client's headers is ignored. The open platforms get
   * the request as it is, so the session headers go along.
   */
  clientHeaders: Record<string, string>;
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
}

/**
 * The error for an upstream that answered with a status of its own.
 *
 * The client sees the gateway's status, and the upstream's own status and
 * code stay on the error: they say whether another account would do better
 * (a 402 means this account is out of credit, a 400 means the request is
 * wrong and every account would fail the same way).
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
  console.warn(`[UPSTREAM] ${what}上游 ${status}：${text.slice(0, 500)}`);
  const error = new AuthError(
    `upstream HTTP ${status}`,
    `${what}上游返回 ${status}：${text.slice(0, 300)}`,
    502,
  );
  withUpstreamStatus(error, status);
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
 * 正文里出现这些之一，就是「每分钟 token 超限」（TPM）。
 *
 * 只有这一类才等：RPM（请求太密）等一下没意义 —— 那是请求本身的节奏不对，
 * 换账号才是对的。
 */
const TPM_MARKERS = ["tpm", "tokens per minute", "rate_limit_tpm_exceeded"];

/**
 * 上游没说要等多久时，等多久（毫秒）。
 *
 * 一分钟窗口的一半：保守。早回来了只是再失败一次。
 */
const DEFAULT_RATE_WAIT_MS = 30_000;

/**
 * 一次最多等多久（毫秒）。
 *
 * 超过一分钟就不等了：客户端等不了那么久，那种情况照旧报错 + 降级。
 */
const MAX_RATE_WAIT_MS = 60_000;

/**
 * 一个请求里总共最多等多久（毫秒）。
 *
 * 「等得起」说的是一分钟以内，不是「随便多久」。
 */
const RATE_WAIT_BUDGET_MS = 60_000;

/** 一个等过了的错误：冷却不写它（见 underPolicy 的 onAttempt）。 */
export interface RateWaited {
  rateWaited?: boolean;
}

/** 记一笔：这个失败等过了。 */
export function withRateWaited<T extends object>(error: T): T {
  (error as T & RateWaited).rateWaited = true;
  return error;
}

/** 这个失败等过了吗。 */
export function rateWaitedOf(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as RateWaited).rateWaited === true;
}

/**
 * 这个失败是「每分钟 token 超限」吗。
 *
 * 只有 TPM 类才算：RPM 等一下没意义，换账号才是对的。
 */
function isTokenRateLimit(error: unknown): boolean {
  const text = errorTextOf(error).toLowerCase();
  return TPM_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 等多久（毫秒）。null = 等不起，照旧报错。
 *
 * 等多久：上游自己说的（retry-after，挂在错误上）；没说的话按一分钟窗口的
 * 一半。上游说了「过两分钟再来」就是等不起 —— 客户端等不了那么久。
 */
export function rateLimitWaitMs(error: unknown): number | null {
  if (!isTokenRateLimit(error)) return null;
  const until = cooldownUntilOf(error);
  const wait = until === null ? DEFAULT_RATE_WAIT_MS : until - Date.now();
  if (wait <= 0 || wait > MAX_RATE_WAIT_MS) return null;
  return wait;
}

/** 等一会儿（毫秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑一次调用；遇到「等得起」的限流就等，然后重试**同一个**账号。
 *
 * 等的是上游说的那个窗口（一分钟以内）。客户端这时候只是在等答复，不该看到
 * 429/503 —— 所以等发生在拿到答复之前，连接一直开着，不会写出半截答复。
 *
 * 等过了的错误带一个标记：冷却不写它（见 underPolicy 的 onAttempt）。那个
 * 账号正在等自己的窗口恢复，写了冷却反而把它挡在门外。
 */
async function runWithRateWait<T>(
  account: ProviderRow,
  what: string,
  run: (account: ProviderRow) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + RATE_WAIT_BUDGET_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(account);
    } catch (e) {
      const wait = rateLimitWaitMs(e);
      // 等不起的（不是 TPM，或者上游说了「过两分钟再来」）：照旧报错。
      if (wait === null) throw e;
      if (e && typeof e === "object") withRateWaited(e as Record<string, unknown>);
      // 等过两次还是不行：照旧报错（但不写冷却）。
      if (attempt >= 2) throw e;
      // 这个请求的等待预算用完了：照旧报错。
      if (Date.now() + wait > deadline) throw e;
      console.log(
        `[ROUTE] ${what} account=${account.id} is rate limited on tokens, waiting ${Math.ceil(wait / 1000)}s then retrying`,
      );
      await sleep(wait);
    }
  }
}

/**
 * 平台自己的码（如果错误信封里有）。
 *
 * 状态码说的是「这个请求被拒了」，业务码说的是「为什么」：墨点用完
 * （quota_exceeded）与限流（rate_limit_exceeded）都是 429，换一个账号的结果
 * 却不一样。
 */
function businessCodeOfBody(text: string): number | string | null {
  try {
    const parsed = text ? JSON.parse(text) : null;
    const code = parsed?.error?.code ?? parsed?.code ?? null;
    if (typeof code === "string" && code.trim()) return code.trim();
    if (typeof code === "number" && Number.isFinite(code)) return code;
    return null;
  } catch {
    return null;
  }
}

/**
 * The platform's accounts that can serve a request, in weight order.
 *
 * An account that is turned off is not a candidate: it is not "this account
 * failed", it is "this platform has one fewer account right now".
 *
 * An account that is cooling down is not a candidate either: it is known to be
 * unable to serve the request right now, and a candidate that is tried and
 * fails is worse than one that is not tried at all.
 */
function servingAccounts(platform: string): ProviderRow[] {
  return accountsOfPlatform(platform).filter((row) => row.enabled);
}

/**
 * 这个失败对客户端意味着什么。
 *
 * 客户端看的是网关的状态，不是上游的：网关自己的 401 是「网关的 key 不对」，
 * 上游的 401 是「这把 key 被上游拒了」，两件事不能撞在同一个状态码上。所以
 * 上游的租户级错误分三档报给客户端：
 *
 *   1. 余额真的用完了（上游 402，或者 MiniMax 的业务码 1008）→ 402，提示说
 *      充值后恢复。那是客户端唯一能动手的一件事。
 *   2. 别的租户级错误（凭据被拒、配额打满、额度用尽的业务码）→ 503。这是
 *      网关的凭据或配额问题，客户端无从处理；提示里带上游的状态与原文。
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
    // 网关自己的 503：凭据或配额的问题，客户端处理不了。
    const error = new AuthError(tenant.message, tenant.hint, 503);
    if (tenant.type) error.type = tenant.type;
    return keepUpstreamTruth(error, lastError);
  }
  if (lastError instanceof Error) return lastError;
  return new AuthError(noBalance.message, noBalance.hint, 502);
}

/**
 * 租户级错误：这个账号接不了这个请求，客户端也无从处理。
 *
 * 凭据被拒、配额打满、额度用尽 —— 都是网关这边要处理的事，所以客户端看到
 * 503；上游的状态与原文写进提示里，排查时不用猜。
 */
function tenantLevelFailure(
  error: unknown,
): { message: string; hint: string; type?: string } | null {
  const kind = classifyUpstreamError(error).kind;
  if (kind !== "credential" && kind !== "rate-limit" && kind !== "quota") return null;
  const status = upstreamSaidStatus(error);
  const code = businessCodeOf(error);
  const said = [
    status === null ? null : `上游 HTTP ${status}`,
    code === null ? null : `业务码 ${code}`,
  ].filter((part): part is string => part !== null);
  const because = said.length ? `（${said.join("，")}）` : "";
  // The code goes into the message too: a client that reads only
  // error.message still sees which failure it was.
  return {
    message: `upstream account cannot serve the request${because}`,
    hint:
      `网关这边的账号接不了这个请求${because}：${upstreamDetail(error)}。` +
      "凭据或配额是网关这边的事，客户端处理不了；等网关换好账号或额度恢复后再试。",
    // The client reads the type too. A refused credential keeps the type the
    // rest of the gateway uses for a credential problem (the 503 default),
    // and the two quota-ish ones say what they are.
    type: kind === "rate-limit" ? "rate_limit_error" : kind === "quota" ? "usage_limit_error" : undefined,
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
  return {
    bind(id: string, label: string): void {
      if (settled) return;
      accountId = id;
      what = label;
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
      // 这次失败值多少冷却：可降级的失败才记，请求本身的问题不记。
      const decision = cooldownForFailure(accountId, error);
      if (decision) {
        try {
          setCooldown(accountId, decision.untilMs, decision.reason);
        } catch (e) {
          // 记账失败不许顶掉上游真正的错误。
          console.warn(`[ROUTE] ${what} account=${accountId} cannot record its cooldown: ${errorText(e)}`);
        }
      }
      console.log(
        `[ROUTE] ${what} account=${accountId} cannot serve it (${describeUpstreamError(error)})` +
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
 * `expiry_first` is the relay station's alone: its order comes from the
 * wallet, so it has its own adapter (toTokenRhythm) and never reaches here.
 *
 * `settle` is for the callers that consume the answer after this returns (the
 * streaming ones): the headers arriving is not the answer arriving, so the
 * cooldown of the account that served it is settled by the caller.
 */
export async function underPolicy<T>(
  platform: string,
  what: string,
  run: (account: ProviderRow) => Promise<T>,
  settle?: Settlement,
): Promise<T> {
  const accounts = accountsOfPlatform(platform);
  const serving = servingAccounts(platform);
  if (!serving.length) throw platformWithoutAccount(platform, accounts.length);
  const policy = platformPolicy(platform);
  const now = Date.now();

  // 冷却里的账号不进候选：它现在接不了这个请求（被限流、额度用完、服务挂了）。
  // 不是「试一次失败再换」——它根本不该被试。
  const cooling = new Set(serving.filter((row) => isCoolingDown(row.id, now)).map((row) => row.id));

  if (policy === "single") {
    // single 只用一个账号：那个账号在冷却，就说清楚冷却到什么时候。不去打
    // 上游（打了也是白打），也不悄悄换到别的账号身上去——面板说的是 single。
    const only = serving[0];
    if (cooling.has(only.id)) {
      const until = cooldownUntil(only.id) ?? now;
      console.log(
        `[ROUTE] ${what} account=${only.id} cooling down (until ${cooldownStamp(until)}), not switching`,
      );
      throw coolingError(only.id, until);
    }
  }

  const usable = serving.filter((row) => !cooling.has(row.id));
  if (!usable.length) {
    // 全都在冷却：告诉调用方最早什么时候能试。
    const until = Math.min(...serving.map((row) => cooldownUntil(row.id) ?? now));
    console.log(
      `[ROUTE] ${what} every account is cooling down (until ${cooldownStamp(until)}), not switching`,
    );
    throw coolingError(serving[0].id, until, true);
  }

  // 被跳过的账号要说出来：为什么没轮上它。
  const position = new Map(serving.map((row, index) => [row.id, index]));
  for (const row of serving) {
    if (!cooling.has(row.id)) continue;
    const until = cooldownUntil(row.id) ?? now;
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
    // 每个候选跑之前先过一遍「等得起就等」：限流的窗口是一分钟级的，等得起
    // 就自己等，重试的还是同一个账号（客户端不该看到这个错）。
    usable.map((account) => ({
      id: account.id,
      weight: account.weight,
      run: () => runWithRateWait(account, what, run),
    })),
  );
  return selectProvider(policy, candidates, {
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
      // 这次失败值多少冷却：可降级的失败才记，请求本身的问题不记。
      //
      // 等过了的限流不记：那个账号正在等自己的窗口恢复，记了冷却反而把它
      // （和别的请求）挡在门外 —— 它等好了就能接。
      const waited = rateWaitedOf(error);
      const decision = waited ? null : cooldownForFailure(candidate.id, error);
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
      console.log(
        `[ROUTE] ${what} account=${candidate.id} cannot serve it (${describeUpstreamError(error)})` +
          (next ? `, trying ${next}` : moves && policy === "fallback" ? ", no account left" : ", not switching") +
          (waited
            ? ", waited for the rate limit, not cooling down"
            : decision
              ? `, cooling down until ${cooldownStamp(decision.untilMs)}`
              : ""),
      );
    },
    // The caller sees the error the upstream produced, not a new one.
    failure: (lastError) =>
      lastError instanceof Error ? lastError : new AuthError("upstream failed", "上游没有响应。", 502),
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
      ? `网关这边所有账号都在${why}，最早 ${when} 恢复（约 ${minutes} 分钟后）。到点自动重试。`
      : `网关这边的账号 ${accountId} 在${why}，${when} 恢复（约 ${minutes} 分钟后）。到点自动重试；` +
        `要别的账号接手，把上游的生效策略改成「降级」。`,
    503,
  );
  return withRetryAfter(error, untilMs);
}
