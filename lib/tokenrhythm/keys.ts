// lib/tokenrhythm/keys.ts — the inference keys of an account.
//
// The platform keeps two things apart: the session, which reads the wallet,
// and the key, which calls the models. A key is only shown in full once, in
// the answer that creates it, so the list is all masked.
//
// That is why the gateway makes its own key: a new account has none, and the
// full value only ever exists in the answer to the call that created it. So
// the one that creates it has to be the one that keeps it.
//
// Creating a key is a write, and a write is checked: the session cookie, the
// CSRF token sent twice, and the browser's fetch metadata. The headers for
// that are in lib/tokenrhythm/accounts.ts.

import { platformApi } from "./platform.ts";
import {
  storedTenant,
  tokenRhythmTenantSecretId,
  writeHeaders,
  type TokenRhythmSession,
} from "./accounts.ts";
import { setSecret } from "../store.ts";

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

/** Every key of the account, masked. */
export async function listApiKeys(session: TokenRhythmSession): Promise<TokenRhythmApiKey[]> {
  const data = await platformApi<any>("/api/api-keys", session);
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
  const data = await platformApi<any>("/api/api-keys", session, { method: "POST", body: { name } });
  return toKey(data);
}

/** Remove a key. */
export async function deleteApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await platformApi<any>(`/api/api-keys/${encodeURIComponent(id)}/delete`, session, {
    method: "POST",
    body: {},
  });
}

/** Stop a key from being used, without throwing it away. */
export async function disableApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await platformApi<any>(`/api/api-keys/${encodeURIComponent(id)}/disable`, session, {
    method: "POST",
    body: {},
  });
}

/** Make a disabled key usable again. */
export async function enableApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await platformApi<any>(`/api/api-keys/${encodeURIComponent(id)}/enable`, session, {
    method: "POST",
    body: {},
  });
}

/**
 * The key of a tenant, and make one when the account has none.
 *
 * A new account has no key, and the only place the full value ever appears is
 * the answer to the call that creates it. So the gateway creates it and keeps
 * it, and the account works without anybody putting a key in the environment.
 *
 * The key that is already in the environment wins: a key that was rotated
 * there has to take effect.
 */
export async function ensureApiKey(
  session: TokenRhythmSession,
  index: number,
  current: string | null,
  providerId = "tokenrhythm",
): Promise<string | null> {
  if (current) return current;
  const created = await createApiKey(session, `buddy-${index}`);
  if (!created.key) {
    throw new Error("平台没有返回完整的 key");
  }
  const id = tokenRhythmTenantSecretId(index, providerId);
  const stored = storedTenant(index, providerId);
  if (stored) {
    setSecret(id, "account", { ...stored, apiKey: created.key });
  }
  console.log(`[TOKENRHYTHM] 租户 ${index}: 新建的 key ${created.maskedKey || created.keyPrefix}`);
  return created.key;
}
