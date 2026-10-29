// lib/xinghuo/account.ts — 讯飞星火账号的凭据。
//
// 只有一段：推理用的 API key（Bearer）。星火没有额度接口，所以也没有第二段
// —— 面板上「额度未知」不是没钱，是没人问得到。
//
// 凭据存在 secrets 表里，id 是 lib/credential-ids.ts 里那唯一的算法：
// key:provider:<账号>:account。

import { providerSecretId } from "../credential-ids.ts";
import { tokenFingerprint } from "../credential.ts";
import { deleteSecret, getSecret, setSecret } from "../store.ts";

/** 数据库里那份账号凭据的样子。 */
export interface XinghuoAccount {
  /** 推理用的 API key。 */
  apiKey: string;
}

/** 这个账号的凭据在数据库里的 id。 */
export function xinghuoAccountId(providerId: string): string {
  return providerSecretId(providerId, "account");
}

/**
 * 这个账号的凭据。
 *
 * 没有就 null —— 空的记录跟没有是一样的。
 */
export function xinghuoAccountOf(providerId: string): XinghuoAccount | null {
  const stored = getSecret<XinghuoAccount>(xinghuoAccountId(providerId));
  if (!stored) return null;
  const apiKey = String(stored.apiKey ?? "").trim();
  if (!apiKey) return null;
  return { apiKey };
}

/** 这个账号推理用的 key。没有就空字符串。 */
export function xinghuoInferenceKey(providerId: string): string {
  return xinghuoAccountOf(providerId)?.apiKey ?? "";
}

/**
 * 写这个账号的 key。
 *
 * 空的那把表示清掉它（面板上重填一次就是替换的意思）。
 *
 * 返回写进去的段数（0/1）：面板要按段报回写了什么。
 */
export function writeXinghuoKey(providerId: string, apiKey: string): number {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    clearXinghuoKey(providerId);
    return 0;
  }
  setSecret(xinghuoAccountId(providerId), "account", { apiKey: key });
  return 1;
}

/** 清掉这个账号的凭据。 */
export function clearXinghuoKey(providerId: string): void {
  deleteSecret(xinghuoAccountId(providerId));
}

/**
 * 面板上看的凭据状态。
 *
 * 干活的是那把 key：没有它，一个请求也发不出去。所以状态只看它。
 */
export function xinghuoStatus(providerId: string): Record<string, unknown> {
  const key = xinghuoInferenceKey(providerId);
  return {
    status: key ? "authenticated" : "missing",
    fingerprint: key ? tokenFingerprint(key) : "",
    expiresAt: "",
    remainingSec: 0,
    warning: false,
    detail: key ? "有推理用的 API key" : "账号上没有推理用的 API key",
  };
}
