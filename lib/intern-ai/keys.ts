// lib/intern-ai/keys.ts — Discovery（端砚）的 API key。
//
// 控制台上的那一套接口：
//
//     GET    {discovery}/api/tokenplan/v1/keys
//     POST   {discovery}/api/tokenplan/v1/keys            body {name}，头 Idempotency-Key
//     PUT    {discovery}/api/tokenplan/v1/keys/{id}       body {name}
//     POST   {discovery}/api/tokenplan/v1/keys/{id}/disable
//     POST   {discovery}/api/tokenplan/v1/keys/{id}/enable
//     DELETE {discovery}/api/tokenplan/v1/keys/{id}
//
// 两条要紧的规矩：
//
//   完整的 key 只在创建的那一次回答里出现（`data.key`），列表里永远是掩码。
//   所以账号要用的那把 key 由用户自己在面板上填（见 writeInternAiKeys），
//   网关不替人建。
//
//   建 key 要带幂等键：同一个键重发一次不会建出两把 key（-15109）。

import crypto from "node:crypto";
import { INTERN_AI_DISCOVERY_BASE } from "./config.ts";
import { consoleApi } from "./platform.ts";
import { accountId, storedAccount, type InternAiSession } from "./auth.ts";
import { setSecret } from "../store.ts";
import type { PlatformKey, PlatformKeys } from "../platform-keys.ts";

/** Discovery（TokenPlan）的一把 key。 */
export interface DiscoveryApiKey {
  id: string;
  name: string;
  /** 掩码后的 key（列表里就是这个）。 */
  maskedKey: string;
  /** active / disabled。 */
  status: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** 每分钟请求数上限；0 表示不限。 */
  rpmLimit: number;
  /** 决策模型（SystemOne）单独的 RPM 上限；0 表示不限。 */
  decisionRpmLimit: number;
  /** 每分钟 token 上限；0 表示不限。 */
  tpmLimit: number;
  /** 完整的 key：只有创建的那一次回答里有。 */
  plainKey?: string;
}

/** 数字：平台给的可能是字符串，坏的当 0。 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 把接口返回的一行读成 Discovery 的 key。 */
export function parseDiscoveryKey(row: any): DiscoveryApiKey {
  return {
    id: String(row?.id ?? ""),
    name: String(row?.name ?? ""),
    maskedKey: String(row?.masked_key ?? ""),
    status: String(row?.status ?? ""),
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    rpmLimit: num(row?.rpm_limit),
    decisionRpmLimit: num(row?.decision_rpm_limit),
    tpmLimit: num(row?.tpm_limit),
    plainKey: row?.key ? String(row.key) : undefined,
  };
}

/** Discovery 的 key 列表。 */
export async function listDiscoveryKeys(session: InternAiSession, token: string): Promise<DiscoveryApiKey[]> {
  const data = await consoleApi<any>(INTERN_AI_DISCOVERY_BASE, "/api/tokenplan/v1/keys", session, token);
  const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  return rows.map(parseDiscoveryKey);
}

/**
 * 建一把 Discovery 的 key。
 *
 * 幂等键是随机的：同一个键重发不会建出两把 key。平台要是回 -15109（冲突），
 * 那是上一次请求还在路上，重试的时候换一把新的。
 */
export async function createDiscoveryKey(
  session: InternAiSession,
  token: string,
  name: string,
  idempotencyKey?: string,
): Promise<DiscoveryApiKey> {
  const data = await consoleApi<any>(INTERN_AI_DISCOVERY_BASE, "/api/tokenplan/v1/keys", session, token, {
    method: "POST",
    body: { name },
    headers: { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() },
  });
  // 回答是平的：{id, name, key, masked_key, status, created_at}。
  return parseDiscoveryKey({ ...(data?.item ?? {}), ...(data?.id ? data : {}) });
}

/**
 * 给 Discovery 的 key 改名。
 *
 * 面板还没做 key 管理：这一族接口是前瞻代码，现在只有网关自己与探针在用。
 */
export async function renameDiscoveryKey(
  session: InternAiSession,
  token: string,
  id: string,
  name: string,
): Promise<void> {
  await consoleApi<any>(INTERN_AI_DISCOVERY_BASE, `/api/tokenplan/v1/keys/${encodeURIComponent(id)}`, session, token, {
    method: "PUT",
    body: { name },
  });
}

/** 停用 Discovery 的 key。 */
export async function disableDiscoveryKey(session: InternAiSession, token: string, id: string): Promise<void> {
  await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    `/api/tokenplan/v1/keys/${encodeURIComponent(id)}/disable`,
    session,
    token,
    { method: "POST" },
  );
}

/** 重新启用 Discovery 的 key。 */
export async function enableDiscoveryKey(session: InternAiSession, token: string, id: string): Promise<void> {
  await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    `/api/tokenplan/v1/keys/${encodeURIComponent(id)}/enable`,
    session,
    token,
    { method: "POST" },
  );
}

/** 注销 Discovery 的 key。 */
export async function deleteDiscoveryKey(session: InternAiSession, token: string, id: string): Promise<void> {
  await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    `/api/tokenplan/v1/keys/${encodeURIComponent(id)}`,
    session,
    token,
    { method: "DELETE" },
  );
}

/**
 * 写这个账号的推理 key。
 *
 * 位置 0 是 Discovery 的（推理就用它）。空串表示清掉它（与七牛云、
 * 讯飞星火一个意思）。
 *
 * 只改 key 那一格：账号密码原样留着（把它们清掉等于把登录态清了）。
 *
 * 返回写进去的段数（0 或 1）：面板要按段报回写了什么。
 */
export function writeInternAiKeys(providerId: string, parts: { discoveryKey?: string }): number {
  const discoveryKey = String(parts.discoveryKey ?? "").trim();
  const stored = storedAccount(providerId);
  // 旧记录里可能还留着一把已经不用了的 Chat token：这里只重写这一次，
  // 顺手把那个字段从账号记录里去掉——凭据删了就得真删干净。
  const kept = { ...(stored ?? {}) };
  delete (kept as Record<string, unknown>).chatKey;
  if (!discoveryKey) {
    // 没有记录就没什么可清的：别凭空造一条只有空 key 的凭据。
    if (!stored) return 0;
    setSecret(accountId(providerId), "account", { ...kept, discoveryKey: null });
    return 0;
  }
  setSecret(accountId(providerId), "account", { ...kept, discoveryKey });
  return 1;
}

/** 一把 key，换成三家平台共同的形状。 */
function toPlatformKey(key: DiscoveryApiKey): PlatformKey {
  return {
    id: key.id,
    name: key.name,
    masked: key.maskedKey,
    plain: key.plainKey,
    status: key.status,
  };
}

/**
 * 书生·端砚 Discovery 子站的 key 管理，三家平台统一的形状。
 *
 * 平台的接口在实现里（那套 tokenplan api-keys）；这里只是把它包的形状换成
 * 三家一样的那种。面板还没做这个操作：现在只有探针在用。
 */
export const internAiKeys: PlatformKeys<InternAiSession> = {
  what: "书生·端砚",
  list: async ({ session, token }) => (await listDiscoveryKeys(session, token ?? "")).map(toPlatformKey),
  create: async ({ session, token }, name) =>
    toPlatformKey(await createDiscoveryKey(session, token ?? "", name)),
  delete: async ({ session, token }, id) => {
    await deleteDiscoveryKey(session, token ?? "", id);
  },
  disable: async ({ session, token }, id) => {
    await disableDiscoveryKey(session, token ?? "", id);
  },
  enable: async ({ session, token }, id) => {
    await enableDiscoveryKey(session, token ?? "", id);
  },
};
