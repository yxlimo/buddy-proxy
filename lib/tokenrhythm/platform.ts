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
  TOKENRHYTHM_API_BASE,
  TokenRhythmError,
  forgetSession as forgetTenantSession,
  writeHeaders,
  type TokenRhythmSession,
} from "./accounts.ts";

/** How to ask: which method, and what to send. */
export interface PlatformRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
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
  const r = await fetch(`${TOKENRHYTHM_API_BASE}${path}`, {
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
    throw new TokenRhythmError("登录已过期", 503);
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
      throw new TokenRhythmError("登录已过期", 503);
    }
    throw new TokenRhythmError(`接口失败（HTTP ${r.status}）：${body?.message ?? text.slice(0, 200)}`);
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
    forgetTenantSession(session.index, session.providerId);
  } catch {
    /* nothing to clean up */
  }
}
