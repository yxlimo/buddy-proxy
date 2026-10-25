// lib/admin/credentials.ts — 凭据状态的词表。
//
// 各家上游各说各的（qoder 说 "authenticated"、minimax 说 "anonymous"、
// 面板的凭据表说 "usable"），面板要的是一套：契约里的 CredentialState 枚举。
//
// 词表只有这一处：字符串进来，枚举出去。反过来也有（契约里账号与凭据的
// status 仍是字符串），那是给人看的词。

import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import {
  MAX_MINIMAX_API_TENANTS,
  miniMaxApiTenantSecretId,
} from "../minimax/api.ts";
import { deleteSecret, setSecret } from "../store.ts";
import { providerKindOf, providerSecretId } from "../providers.ts";

/**
 * 上游报的状态 → 契约里的枚举。
 *
 * "usable" 是面板自己的说法：这条凭据能用。
 * "anonymous" 在**上游**那里是「没登录」的意思（qoder、workbuddy、minimax
 * 都这么报），所以上游的 anonymous 要算「没有凭据」—— 那是
 * `fromUpstreamStatus` 那里单独判的。这里的 anonymous 是「有凭据，但还没
 * 过期」—— 账号密码型上游（TokenRhythm）的常态。
 */
/**
 * 写一个 Provider 的 API Key 列表。
 *
 * MiniMax 开放平台：一把 key 一个租户，key 列表就是租户列表。
 *
 * MiniMax Code 网关：只有一把 —— 那是它的 coding plan 的 key（sk-cp-…），
 * 用来查套餐额度。推理走的是会话，不是这把 key。
 *
 * 环境变量里的 key 优先（那是在 .env 里轮换的，必须立刻生效），所以这里写的
 * 只是数据库那份 —— 环境变量撤掉之后才轮到它。
 */
export function setProviderKeys(
  upstreamId: string,
  keys: string[],
): { ok: boolean; message: string; count: number } {
  const kind = providerKindOf(upstreamId);
  if (kind?.kind === "minimax") {
    // Code 网关的套餐 key：只有一把。
    const key = (keys[0] ?? "").trim();
    const id = providerSecretId(upstreamId, "plan");
    if (!key) {
      deleteSecret(id);
      return { ok: true, message: "清掉了套餐 key", count: 0 };
    }
    setSecret(id, "key", { key });
    return { ok: true, message: "写了套餐 key", count: 1 };
  }
  if (upstreamId !== "minimax-api") {
    return { ok: false, message: `这个 Provider 不接受 API Key：${upstreamId}`, count: 0 };
  }
  const cleaned = keys.map((k) => String(k).trim()).filter((k) => k.length > 0);
  if (cleaned.length > MAX_MINIMAX_API_TENANTS) {
    return { ok: false, message: `最多 ${MAX_MINIMAX_API_TENANTS} 把 key`, count: 0 };
  }
  for (let index = 1; index <= MAX_MINIMAX_API_TENANTS; index++) {
    const key = cleaned[index - 1] ?? "";
    if (key) setSecret(miniMaxApiTenantSecretId(index), "key", { key });
    else deleteSecret(miniMaxApiTenantSecretId(index));
  }
  return { ok: true, message: `写了 ${cleaned.length} 把 key`, count: cleaned.length };
}

export function credentialState(status: string): CredentialState {
  switch (status) {
    case "authenticated":
      return CredentialState.AUTHENTICATED;
    case "expired":
      return CredentialState.EXPIRED;
    case "error":
      return CredentialState.ERROR;
    case "usable":
      return CredentialState.USABLE;
    case "anonymous":
      return CredentialState.ANONYMOUS;
    case "missing":
      return CredentialState.MISSING;
    default:
      return CredentialState.MISSING;
  }
}

/**
 * 枚举 → 面板账号与凭据表里的那个词。
 *
 * 契约里 Account.status 与 Credential.status 仍是字符串（usable / expired /
 * missing），所以这里把枚举换成人能读的词。
 */
export function credentialStateText(state: CredentialState): string {
  switch (state) {
    case CredentialState.AUTHENTICATED:
    case CredentialState.ANONYMOUS:
    case CredentialState.USABLE:
      return "usable";
    case CredentialState.EXPIRED:
      return "expired";
    case CredentialState.ERROR:
      return "error";
    default:
      return "missing";
  }
}

/** 这个状态算「有能用的凭据」吗。 */
export function hasUsableCredential(state: CredentialState): boolean {
  return (
    state === CredentialState.AUTHENTICATED ||
    state === CredentialState.ANONYMOUS ||
    state === CredentialState.USABLE
  );
}

/* ------------------------------------------------------------------ *
 * 凭据的 id
 * ------------------------------------------------------------------ */

/**
 * 一条凭据 id 的形状。
 *
 * 凭据的 id 就是它在数据库里的地址（见 lib/providers.ts 的 providerSecretId）：
 * 会话是 session:provider:<上游>，钥匙是 key:provider:<上游>:<后缀>。后缀各家
 * 不同（套餐额度是 plan，开放平台一把 key 一个租户是 key-1，账号密码是 account，
 * 中转站一个账号一个租户是 tenant-1），所以认出它是哪一种要靠后缀。
 */
export interface CredentialRef {
  /** 它属于哪个上游。 */
  providerId: string;
  /** session / plan_key / api_key / login。 */
  form: string;
  /** 租户号：开放平台一把 key 一个租户，中转站一个账号一个钱包。 */
  tenant: number | null;
  /** 从登录账号里派生出来的那把推理 key：api_key、discovery_key。 */
  derived: string;
}

/**
 * 把凭据的 id 读成它指向的东西。
 *
 * 面板把凭据的 id 原样交回来（「试一下」「刷新一下」），所以这里是唯一的算法：
 * 认不出来的 id 就是不认识的凭据，不会去猜。
 *
 * 中转站的会话是一张表（session:provider:tokenrhythm 里按租户号存），所以它的
 * 会话 id 后面带一个租户号：session:provider:tokenrhythm:tenant-1。
 */
export function parseCredentialId(id: string): CredentialRef | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  // 派生出来的推理 key 用 # 记：账号是它来的地方，key 是从账号里取的那把。
  const hash = raw.indexOf("#");
  const derived = hash >= 0 ? raw.slice(hash + 1) : "";
  const base = hash >= 0 ? raw.slice(0, hash) : raw;
  const parts = base.split(":");
  if (parts[0] === "session" && parts[1] === "provider" && parts.length >= 3) {
    const providerId = parts[2];
    if (!providerId) return null;
    if (parts.length === 3) return { providerId, form: "session", tenant: null, derived };
    if (parts.length === 4 && parts[3].startsWith("tenant-")) {
      const tenant = Number(parts[3].slice("tenant-".length));
      if (Number.isInteger(tenant)) return { providerId, form: "session", tenant, derived };
    }
    return null;
  }
  if (parts[0] === "key" && parts[1] === "provider" && parts.length === 4) {
    const providerId = parts[2];
    const suffix = parts[3];
    if (!providerId) return null;
    if (suffix === "plan") return { providerId, form: "plan_key", tenant: null, derived };
    if (suffix === "account") return { providerId, form: "login", tenant: null, derived };
    const key = /^key-(\d+)$/.exec(suffix);
    if (key) return { providerId, form: "api_key", tenant: Number(key[1]), derived };
    const tenant = /^tenant-(\d+)$/.exec(suffix);
    if (tenant) return { providerId, form: "login", tenant: Number(tenant[1]), derived };
    return null;
  }
  return null;
}

/**
 * 账号的 id 拆成上游与租户。
 *
 * 账号的 id 是上游自己的 id，或者是「上游:租户号」那种（中转站一个租户一个
 * 账号）。上游的 id 里没有冒号，所以从后面拆就分得清。
 */
export function splitAccountId(accountId: string): { providerId: string; tenant: number | null } {
  const raw = String(accountId ?? "").trim();
  const cut = raw.lastIndexOf(":");
  if (cut <= 0) return { providerId: raw, tenant: null };
  const tenant = Number(raw.slice(cut + 1));
  if (!Number.isInteger(tenant)) return { providerId: raw, tenant: null };
  return { providerId: raw.slice(0, cut), tenant };
}
