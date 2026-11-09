// lib/upstream-status.ts — what the upstream itself said.
//
// The gateway wraps an upstream's failure in its own error, and the wrapper's
// status is what the client sees. The upstream's own answer is what the
// router needs: the status says whether the request was wrong, and the
// platform's own code says which account cannot serve it.
//
// The transports keep those two on the error, so the routing layer can tell
// "this account is out of credit" from "this request is wrong" without
// knowing anything about the platform's error table.

/** An error that carries the status the upstream sent. */
export interface UpstreamStatus {
  /** The status the upstream sent (or the one that means the same). */
  upstreamStatus?: number;
}

/** An error that carries the platform's own code. */
export interface UpstreamBusinessCode {
  /** The platform's code: a number (MiniMax) or a word (Discovery). */
  businessCode?: number | string;
}

/**
 * An error that carries the moment the account is free again.
 *
 * The upstream says it in two ways: a `retry-after` header, or a time in the
 * body ("您的限额将在 2026-10-30 07:55:44 重置"). The transport puts the moment
 * on the error, so the routing layer does not have to know how each platform
 * says it.
 */
export interface UpstreamCooldown {
  /** The moment the account may serve a request again (ms since the epoch). */
  cooldownUntil?: number;
}

/** Keep the upstream's own status on an error. */
export function withUpstreamStatus<T extends object>(error: T, status: number): T {
  (error as T & UpstreamStatus).upstreamStatus = status;
  return error;
}

/** Keep the platform's own code on an error. */
export function withBusinessCode<T extends object>(error: T, code: number | string): T {
  (error as T & UpstreamBusinessCode).businessCode = code;
  return error;
}

/** The status the upstream sent, if the error carries one. */
export function upstreamStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const err = error as UpstreamStatus & { status?: unknown };
  for (const value of [err.upstreamStatus, err.status]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * The platform's own code, if the error carries one.
 *
 * A zero code means "no code": the platforms answer 0 on success, and a body
 * that carries 0 is not saying anything about a failure.
 */
export function businessCodeOf(error: unknown): number | string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as UpstreamBusinessCode & { code?: unknown };
  const value = err.businessCode ?? err.code;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    return text && text !== "0" ? text : null;
  }
  return null;
}

/**
 * 平台自己的码，从上游的正文里读（如果那里有）。
 *
 * 状态码说的是「这个请求被拒了」，业务码说的是「为什么」：风控（WorkBuddy
 * 的 11128）与参数不认都是 400，换一个账号的结果却不一样，所以码要带上。
 *
 * 正文里码的位置不统一：有的在顶层 `code`，有的在 `error.code`。两个都看，
 * 取第一个有值的。
 *
 * 0 不算码：有的平台成功时也回 `code: 0`，把它当成「没有码」。
 */
export function businessCodeOfBody(text: string): number | string | null {
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  return businessCodeOfPayload(parsed);
}

/**
 * 平台自己的码，从**已经解析出来的**正文里读。
 *
 * 正文可能带着 `data:` 前缀（SSE 的一帧），直接 parse 整个正文会失败 ——
 * 所以这里接的是解析好的那个 payload。
 *
 * `error.code` 先看，顶层的 `code` 后看：`error` 里那个是**这个错误**的码，
 * 顶层那个有时是整个响应的码（成功时是 0）。两个都看，谁有值算谁。
 */
export function businessCodeOfPayload(payload: any): number | string | null {
  for (const value of [payload?.error?.code, payload?.code]) {
    if (typeof value === "string") {
      const text = value.trim();
      // "0" 与 0 一样：没有码。
      if (text && text !== "0") return text;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return value;
  }
  return null;
}

/**
 * 这个正文是不是上游的「错误信封」：只有业务码，没有答复。
 *
 * 上游有时用 200 回一个错 —— WorkBuddy 的渠道校验就是（业务码 11128）。当成
 * 正常的帧的话，客户端收到一个空的 200 答复，看着像模型答了个空，理由也没
 * 有（2026-11-03，作者复查发现：非流式那条路上没认这种信封）。
 *
 * 有答复的正文（`choices` / `object` / `data`）不算：那是正常的帧。
 */
export function isBusinessErrorEnvelope(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (payload.choices || payload.object || payload.data !== undefined) return false;
  return businessCodeOfPayload(payload) !== null;
}

/** Keep the moment the account is free again on an error. */
export function withCooldownUntil<T extends object>(error: T, untilMs: number): T {
  (error as T & UpstreamCooldown).cooldownUntil = untilMs;
  return error;
}

/** The moment the account is free again, if the error carries one. */
export function cooldownUntilOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as UpstreamCooldown).cooldownUntil;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How long the upstream says to wait, in milliseconds.
 *
 * The header comes first: `retry-after` is either a number of seconds or an
 * HTTP date, and it is the upstream's own machine-readable answer. Only when
 * there is no header do we read the body, because some upstreams say it in the
 * message instead ("retry shortly (after 30 s)"). A header that is present but
 * unreadable (`soon`) counts as not said: the body may still have the time.
 *
 * The header's value is passed on as it is — how long is worth waiting is the
 * policy's decision (see rateLimitWaitMs), not this function's.
 *
 * `body` is the upstream's own text (the one already read for the error). The
 * body is read under two limits, because the body is a guess: the time has to
 * carry the "try again" meaning (see RETRY_SEMANTIC), and it may not be longer
 * than a minute (see MAX_BODY_RETRY_MS). The header is not subject to either:
 * it is the upstream's own machine-readable answer.
 *
 * `null` means the upstream did not say.
 */
export function retryAfterMs(response: Response, body?: string): number | null {
  const raw = response?.headers?.get?.("retry-after");
  if (raw) {
    const text = String(raw).trim();
    if (text) {
      const seconds = Number(text);
      if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
      const at = Date.parse(text);
      if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    }
  }
  return retryAfterFromBody(body);
}

/**
 * 正文里说的等待，比这个长就当读不懂。
 *
 * 一分钟以上的不认：正文是我们猜的，猜出个「三十分钟」的一定是猜错了 ——
 * 头里说的窗口可以很长（等不等是 policy 的事），正文里的不行。读出来的秒数
 * 会被写进冷却表：一句普通英文把账号关掉半小时，那不是上游的意思。
 */
const MAX_BODY_RETRY_MS = 60_000;

/**
 * 正文里「过多久再来」的样子。
 *
 * 只认「关键词 + 数字 + 时间单位」挨着写的那一句：正文里别处的数字（错误码
 * 3001、模型名 4.5）不是等待时间。
 *
 * 关键词是必需的：光有「30 s」说不清是等了 30 秒还是别的什么。
 *
 * 光有这些关键词还不够 —— 「after 30 s」也可能只是超时文案。正文里的命中还要
 * 过「重试语义」那道门（见 RETRY_SEMANTIC）。
 */
const BODY_RETRY_PATTERNS: { source: string; flags: string }[] = [
  {
    // after 30 s / in 30 seconds / retry in 30 seconds / wait 30s / try again in 30 seconds
    source:
      "\\b(?:after|in|within|wait(?:ing)?(?:\\s+for)?|retry(?:\\s+again)?(?:\\s+(?:after|in))?|try\\s+again(?:\\s+in)?)\\s*(\\d+(?:\\.\\d+)?)\\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)\\b",
    flags: "gi",
  },
  {
    // 30 秒后 / 请 30 秒后重试 / 5 分钟后
    source: "(\\d+(?:\\.\\d+)?)\\s*(秒钟|秒|分钟)(?:之后|以后|后)",
    flags: "g",
  },
];

/**
 * 「重试」的语义：正文里没有它，那句「30 秒」就不是「等一等」的窗口。
 *
 * 光有 `after 30 s` / `in 30 s` 不算 —— 那是超时文案（「Request timed out
 * after 30 seconds」）。而读出来的秒数会被写进冷却表：一句普通英文把账号
 * 关掉半小时，那不是上游的意思。
 *
 * `resets` / `restored` / `restore` 也算：上游说「限流窗口 30 秒后重置」时
 * 说的就是「等一等再来」（`rate limit exceeded, resets in 30s`、`The quota
 * will be restored in 60 seconds`）。它们不会把「密码 30 分钟后重置」读成
 * 等待时间 —— 正文里的秒数本来就限死在一分钟以内（见 MAX_BODY_RETRY_MS），
 * 超过就落空。
 */
const RETRY_SEMANTIC =
  /\b(?:retr(?:y|ies|ied|ying)|try\s+again|waits?|waiting|resets?|restored|restore)\b|重试|等待|恢复/i;

/**
 * 分句的界：标点与换行。
 *
 * 括号不算界 —— 括号里的话与外面是同一句（`retry shortly (after 30 s)`）。
 */
const CLAUSE_BREAKS = new Set([
  ",",
  ";",
  ".",
  "!",
  "?",
  "，",
  "。",
  "；",
  "！",
  "？",
  "\r",
  "\n",
]);

/**
 * 这个命中在哪个分句里（分句的界：标点与换行；括号不算界）。
 */
function clauseAround(text: string, index: number): { start: number; end: number } {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (CLAUSE_BREAKS.has(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    if (CLAUSE_BREAKS.has(text[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * 这个命中带不带「重试」的语义。
 *
 * 两条都算：
 *   - 命中自己就写着（`wait 30s`）；
 *   - 同一个分句里写着（`请 30 秒后重试`、`retry in 45 seconds`）。
 *
 * 不跨分句回看：上一句的「try again later」不是下一句「after 30 seconds」的
 * 许可 —— 那是两句话，超时文案不是等待窗口。括号不算分句界，所以真案例
 * `retry shortly (after 30 s)` 仍然命中（同一分句里有「retry」）。
 */
function hasRetrySemantic(text: string, start: number, end: number): boolean {
  if (RETRY_SEMANTIC.test(text.slice(start, end))) return true;
  const clause = clauseAround(text, start);
  return RETRY_SEMANTIC.test(text.slice(clause.start, clause.end));
}

/**
 * 正文里说的「过多久再来」（毫秒）。
 *
 * 数字必须紧挨着时间单位，而且要有一个说「等」的词在前面 —— 否则正文里的
 * 错误码与模型名会被当成等待时间。
 */
function retryAfterFromBody(body?: string): number | null {
  const text = String(body ?? "");
  if (!text) return null;
  for (const pattern of BODY_RETRY_PATTERNS) {
    // 每次新建：带 g 的正则会记着 lastIndex，复用会把上一次的落点带过来。
    const re = new RegExp(pattern.source, pattern.flags);
    for (;;) {
      const found = re.exec(text);
      if (found === null) break;
      if (found[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const start = found.index;
      const end = start + found[0].length;
      // 没有「重试」的意思：这句不是在说「等一等」（那是超时文案）。
      if (!hasRetrySemantic(text, start, end)) continue;
      const ms = unitToMs(found[1], found[2]);
      if (ms === null) continue;
      // 超过一分钟的当读不懂：宁可没有，也不要拿一个猜出来的值去冷却。
      if (ms > MAX_BODY_RETRY_MS) continue;
      return ms;
    }
  }
  return null;
}

/** 单位换算成毫秒。认不出来就是 null。 */
function unitToMs(value: string, unit: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const u = unit.toLowerCase();
  if (u === "ms" || u === "millisecond" || u === "milliseconds") return Math.round(n);
  if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") {
    return Math.round(n * 1_000);
  }
  if (u === "m" || u === "min" || u === "mins" || u === "minute" || u === "minutes") {
    return Math.round(n * 60_000);
  }
  if (u === "秒" || u === "秒钟") return Math.round(n * 1_000);
  if (u === "分钟") return Math.round(n * 60_000);
  return null;
}
