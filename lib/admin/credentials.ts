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
 * 目前只有 MiniMax 开放平台需要：它一把 key 一个租户，key 列表就是租户列表。
 * 环境变量里的 key 优先（那是在 .env 里轮换的，必须立刻生效），所以这里写的
 * 只是数据库那份 —— 环境变量撤掉之后才轮到它。
 */
export function setProviderKeys(
  upstreamId: string,
  keys: string[],
): { ok: boolean; message: string; count: number } {
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
