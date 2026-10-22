// lib/tokenrhythm/keys.ts — the inference keys of an account.
//
// The platform keeps two things apart: the session, which reads the wallet,
// and the key, which calls the models. A key is only shown in full once, in
// the answer that creates it, so the list is all masked.
//
// Creating a key is a write, and a write is checked: the session cookie, the
// CSRF token sent twice, and the browser's fetch metadata. The last one is
// the part a script has to say out loud — the server reads `Sec-Fetch-Site`
// to learn that the request came from the page itself, and a cross-site
// page cannot fake it. So the headers below are not optional.

import {
  TOKENRHYTHM_API_BASE,
  TokenRhythmError,
  sessionId,
  writeHeaders,
  type TokenRhythmSession,
} from "./accounts.ts";
import { deleteSecret } from "../store.ts";

export interface TokenRhythmApiKey {
  id: string;
  name: string;
  /** The key with its middle hidden — this is all the list ever shows. */
  maskedKey: string;
  keyPrefix: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string | null;
  /** Only in the answer that creates the key. */
  key?: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toKey = (row: any): TokenRhythmApiKey => ({
  id: String(row?.id ?? ""),
  name: String(row?.name ?? ""),
  maskedKey: String(row?.maskedKey ?? ""),
  keyPrefix: String(row?.keyPrefix ?? ""),
  status: String(row?.status ?? ""),
  lastUsedAt: row?.lastUsedAt ?? null,
  createdAt: row?.createdAt ?? null,
  key: row?.key ? String(row.key) : undefined,
});

/** Ask the platform for something, with the session cookie. */
async function api<T>(
  path: string,
  session: TokenRhythmSession,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const r = await fetch(`${TOKENRHYTHM_API_BASE}${path}`, {
    method,
    headers: {
      ...(write ? writeHeaders(session) : { Cookie: session.cookie, Accept: "application/json" }),
      ...(write ? {} : { "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)" }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
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
    // The session is gone: drop it, so the next call logs in again.
    try {
      deleteSecret(sessionId(session.index));
    } catch {
      /* nothing to clean up */
    }
    throw new TokenRhythmError("登录已过期", 503);
  }
  if (r.status === 403 && body?.code === "CSRF_INVALID") {
    throw new TokenRhythmError("安全校验失败：会话的 CSRF 令牌不对，重新登录再试", 502);
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

/** Every key of the account, masked. */
export async function listApiKeys(session: TokenRhythmSession): Promise<TokenRhythmApiKey[]> {
  const data = await api<any>("/api/api-keys", session);
  return (Array.isArray(data) ? data : []).map(toKey);
}

/**
 * Make a key.
 *
 * The full key is in the answer and nowhere else — the list only shows it
 * masked — so the caller has to keep it.
 */
export async function createApiKey(
  session: TokenRhythmSession,
  name: string,
): Promise<TokenRhythmApiKey> {
  const data = await api<any>("/api/api-keys", session, { method: "POST", body: { name } });
  return toKey(data);
}

/** Remove a key. */
export async function deleteApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await api<any>(`/api/api-keys/${encodeURIComponent(id)}/delete`, session, {
    method: "POST",
    body: {},
  });
}

/** Stop a key from being used, without throwing it away. */
export async function disableApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await api<any>(`/api/api-keys/${encodeURIComponent(id)}/disable`, session, {
    method: "POST",
    body: {},
  });
}

/** Make a disabled key usable again. */
export async function enableApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await api<any>(`/api/api-keys/${encodeURIComponent(id)}/enable`, session, {
    method: "POST",
    body: {},
  });
}
