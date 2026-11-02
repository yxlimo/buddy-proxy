// lib/open-platform-credentials.ts — 开放平台账号的凭据。
//
// 开放平台的账号只有一段凭据：推理用的 API key（Bearer）。这个 key 就是账号
// 的全部身份 —— 没有会话、没有登录账号、没有第二段。
//
// 额度看平台给不接口：给了就查，没给就是「不知道」，不是「没钱」。
//
// 凭据存在 secrets 表里，id 是 lib/credential-ids.ts 里那唯一的算法：
// key:provider:<账号>:key。

import { providerSecretId } from "./credential-ids.ts";
import { deleteSecret, getSecret, setSecret } from "./store.ts";

/** 数据库里那份凭据的样子。 */
export interface OpenPlatformCredential {
  /** 推理用的 API key。 */
  apiKey: string;
}

/** 这个账号的凭据在数据库里的 id。 */
export function openPlatformKeyId(providerId: string): string {
  return providerSecretId(providerId, "key");
}

/**
 * 这个账号的凭据。
 *
 * 没有就 null —— 空的记录跟没有是一样的（面板上不能出现「有凭据」却没有凭据
 * 的行）。
 */
export function openPlatformKeyOf(providerId: string): OpenPlatformCredential | null {
  const stored = getSecret<OpenPlatformCredential>(openPlatformKeyId(providerId));
  if (!stored) return null;
  const apiKey = String(stored.apiKey ?? "").trim();
  if (!apiKey) return null;
  return { apiKey };
}

/**
 * 写这个账号的 key。
 *
 * 空的那把表示清掉它（面板上重填一次就是替换的意思）。
 *
 * 返回写进去的段数（0/1）：面板要按段报回写了什么。
 */
export function writeOpenPlatformKey(providerId: string, apiKey: string): number {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    clearOpenPlatformKey(providerId);
    return 0;
  }
  setSecret(openPlatformKeyId(providerId), "key", { apiKey: key });
  return 1;
}

/** 清掉这个账号的凭据。 */
export function clearOpenPlatformKey(providerId: string): void {
  deleteSecret(openPlatformKeyId(providerId));
}
