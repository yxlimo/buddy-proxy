// lib/intern-ai/keys.ts — 两个子站各自的 API key。
//
// 两边的 key 各管各的，接口长得像但不一样：
//
//   Discovery（TokenPlan）
//     GET    {discovery}/api/tokenplan/v1/keys
//     POST   {discovery}/api/tokenplan/v1/keys            body {name}，头 Idempotency-Key
//     PUT    {discovery}/api/tokenplan/v1/keys/{id}       body {name}
//     POST   {discovery}/api/tokenplan/v1/keys/{id}/disable
//     POST   {discovery}/api/tokenplan/v1/keys/{id}/enable
//     DELETE {discovery}/api/tokenplan/v1/keys/{id}
//
//   Chat（浦语）
//     GET    {chat}/puyu/user/tokens
//     POST   {chat}/puyu/user/tokens                      body {token_name}
//     DELETE {chat}/puyu/user/tokens/{id}
//
// 两条都要紧的规矩：
//
//   完整的 key 只在创建的那一次回答里出现。Discovery 是在 data.key，Chat 是
//   在 data.token.token（多套了一层）。列表里永远是掩码。所以建 key 的那个
//   函数必须负责把它存起来。
//
//   建 key 要带幂等键。Discovery 的接口要求 `Idempotency-Key` 头；同一个键重
//   发一次不会建出两把 key（-15109）。

import crypto from "node:crypto";
import {
  INTERN_AI_CHAT_BASE,
  INTERN_AI_DISCOVERY_BASE,
  internAiChatKey,
  internAiDiscoveryKey,
} from "./config.ts";
import { consoleApi } from "./platform.ts";
import { accountId, storedAccount, type InternAiSession } from "./auth.ts";
import { setSecret } from "../store.ts";

/** 两个子站的 key 各是什么。 */
export type InternAiSiteName = "discovery" | "chat";

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

/** Chat（浦语）的一把 API Token。 */
export interface ChatApiToken {
  id: string;
  /** 人起的名字。 */
  name: string;
  /** 掩码后的 token。 */
  maskedToken: string;
  /** 权限（平台给的是数字，1 = 可用）。 */
  authStatus: number | string;
  createdAt: string | null;
  /** 有效期至。平台用 "-" 表示没有到期日。 */
  expiredAt: string | null;
  /** 完整的 token：只有创建的那一次回答里有。 */
  plainToken?: string;
}

/** 数字：平台给的可能是字符串，坏的当 0。 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 把 token 掩起来。短 token 不掩——掩了就没法认了。 */
export function maskToken(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}••••${value.slice(-4)}` : value;
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

/**
 * 把接口返回的一行读成 Chat 的 token。
 *
 * plain 说清楚这一行的 token 是不是完整的：创建的那一次是完整的，列表里是
 * 平台掩过的。
 */
export function parseChatToken(row: any, plain = false): ChatApiToken {
  const raw = String(row?.token ?? "");
  return {
    id: String(row?.id ?? ""),
    name: String(row?.token_name ?? ""),
    maskedToken: maskToken(raw),
    authStatus: row?.auth_status ?? "",
    createdAt: row?.created_at ?? null,
    expiredAt: row?.expired_at ?? null,
    plainToken: plain && raw ? raw : undefined,
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

/** 给 Discovery 的 key 改名。 */
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

/** Chat 的 API Token 列表。 */
export async function listChatTokens(
  session: InternAiSession,
  token: string,
): Promise<{ tokens: ChatApiToken[]; maxTokenNum: number; total: number }> {
  const data = await consoleApi<any>(INTERN_AI_CHAT_BASE, "/puyu/user/tokens", session, token);
  const rows = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
  return {
    tokens: rows.map((row: any) => parseChatToken(row)),
    maxTokenNum: num(data?.max_token_num),
    total: num(data?.total ?? rows.length),
  };
}

/**
 * 建一把 Chat 的 API Token。
 *
 * 回答是套了一层的：{token: {id, token, auth_status, token_name, …}, max_token_num}。
 * 完整的 token 在 data.token.token。
 */
export async function createChatToken(
  session: InternAiSession,
  token: string,
  name: string,
): Promise<ChatApiToken> {
  const data = await consoleApi<any>(INTERN_AI_CHAT_BASE, "/puyu/user/tokens", session, token, {
    method: "POST",
    body: { token_name: name },
  });
  const row = data?.token ?? data ?? {};
  return parseChatToken({ name, ...row }, true);
}

/** 注销 Chat 的 API Token。 */
export async function deleteChatToken(session: InternAiSession, token: string, id: string): Promise<void> {
  await consoleApi<any>(INTERN_AI_CHAT_BASE, `/puyu/user/tokens/${encodeURIComponent(id)}`, session, token, {
    method: "DELETE",
  });
}

/**
 * 一个子站要用的推理 key。
 *
 * 谁优先：显式传进来的 > 环境变量里的 > 数据库里的 > 平台新建的。
 * 换过的 key 得算数，所以前三种都算数；只有都没有的时候才去平台建一个，
 * 而且建完必须马上存——完整的 key 只在创建的那一次回答里出现。
 */
export async function ensureApiKey(
  session: InternAiSession,
  site: InternAiSiteName,
  token: string,
  name: string,
  current?: string | null,
  providerId = "intern-ai",
): Promise<string | null> {
  const stored = storedAccount(providerId);
  const existing =
    current ?? (site === "discovery" ? internAiDiscoveryKey(stored?.discoveryKey) : internAiChatKey(stored?.chatKey));
  if (existing) return existing;

  let plain: string | undefined;
  if (site === "discovery") {
    const created = await createDiscoveryKey(session, token, name);
    if (!created.plainKey) {
      // -15108：平台建了 key 但不把完整值给回来。
      throw new Error("平台创建了 key，但没有把完整的 key 交回来");
    }
    plain = created.plainKey;
  } else {
    const created = await createChatToken(session, token, name);
    if (!created.plainToken) {
      throw new Error("平台创建了 token，但没有把完整的 token 交回来");
    }
    plain = created.plainToken;
  }

  setSecret(accountId(providerId), "account", {
    ...stored,
    ...(site === "discovery" ? { discoveryKey: plain } : { chatKey: plain }),
  });
  console.log(`[INTERN-AI] ${site} 子站：新建了一把推理 key`);
  return plain;
}
