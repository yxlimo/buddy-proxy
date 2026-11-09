// lib/tokenrhythm/platform.ts — one way to ask the platform for something.
//
// The platform answers with an envelope: `code` says whether it worked and
// `data` holds the answer. A write is checked twice as hard as a read — the
// session cookie, a CSRF token sent twice, and the browser's fetch metadata
// (lib/tokenrhythm/accounts.ts has the headers for that).
//
// Both the wallet and the key management talk to the platform, so both go
// through here: one place that knows the envelope, one place that knows what
// a dead session looks like.

import {
  TokenRhythmError,
  forgetSession as forgetAccountSession,
  writeHeaders,
  type TokenRhythmSession,
} from "./accounts.ts";
import { TOKENRHYTHM_API_BASE } from "./config.ts";
import { retryAfterMs } from "../upstream-status.ts";

/** How to ask: which method, and what to send. */
export interface PlatformRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /**
   * 另一台机器（平台行把地址指到别处时）。
   *
   * 额度要问的是「这个平台在跟谁说话」：行上写的那台与默认的那台不同时，只换
   * 主机名，路径、请求头、超时与凭据都一样。不给就是默认那台。
   */
  base?: string;
}

/**
 * 请求的地址。
 *
 * 没给 base、或给的就是默认那台，照旧把路径接在配置地址后面。给了别的地址
 * （平台行上那台）就按 URL 解析：以它的 origin 为根，用户填的地址带不带 /v1
 * 都不影响路径。
 */
function requestUrl(base: string | undefined, path: string): string {
  const other = String(base ?? "").trim();
  if (!other || other === TOKENRHYTHM_API_BASE) return `${TOKENRHYTHM_API_BASE}${path}`;
  return new URL(path, other).toString();
}

/**
 * Ask the platform for something.
 *
 * A read answers with the session cookie; a write needs the write headers.
 * A dead session is cleared, so the next call logs in again.
 */
export async function platformApi<T>(
  path: string,
  session: TokenRhythmSession,
  init: PlatformRequest = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const write = method !== "GET";
  const r = await fetch(requestUrl(init.base, path), {
    method,
    headers: write
      ? writeHeaders(session)
      : { Cookie: session.cookie, Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (r.status === 401) {
    forgetSession(session);
    throw new TokenRhythmError("登录已过期", 503, "unauthorized");
  }
  if (r.status === 403) {
    // A write that fails the security check is a different thing from a dead
    // session: the session is fine, the request was not what the platform
    // wanted. Saying "log in again" would be wrong.
    if (body?.code === "CSRF_INVALID") {
      throw new TokenRhythmError("安全校验失败：会话的 CSRF 令牌不对，重新登录再试", 502);
    }
    if (!write) {
      forgetSession(session);
      throw new TokenRhythmError("登录已过期", 503, "unauthorized");
    }
    throw new TokenRhythmError(`接口失败（HTTP ${r.status}）：${body?.message ?? text.slice(0, 200)}`);
  }
  if (r.status === 429) {
    // 限流是「等一会儿」，不是「不行了」：调用方（额度）要用这个分别决定要不要
    // 写冷却，以及等到什么时候。Retry-After 只有这里看得到（有时只写在正文里）。
    const error = new TokenRhythmError(
      `接口被限流了（HTTP 429）：${body?.message ?? text.slice(0, 200)}`,
      429,
      "rate_limited",
    );
    error.retryAfterMs = retryAfterMs(r, text);
    throw error;
  }
  if (!r.ok) {
    throw new TokenRhythmError(`接口失败（HTTP ${r.status}）：${body?.message ?? text.slice(0, 200)}`);
  }
  if (body && typeof body.code !== "undefined" && body.code !== 0) {
    throw new TokenRhythmError(`接口返回 code=${body.code}：${body.message ?? ""}`);
  }
  if (!body || typeof body.data === "undefined") {
    throw new TokenRhythmError("接口响应结构异常，缺少 data 字段");
  }
  return body.data as T;
}

/** Drop a session that the platform no longer accepts. */
function forgetSession(session: TokenRhythmSession): void {
  try {
    forgetAccountSession(session.accountId);
  } catch {
    /* nothing to clean up */
  }
}
