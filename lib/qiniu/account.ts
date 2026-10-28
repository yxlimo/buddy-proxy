// lib/qiniu/account.ts — 七牛云账号的凭据。
//
// 一个账号上有两段凭据，各管各的：
//
//   apiKey        推理用的 API key。推理端点只认它（Bearer）。
//   portalCookie  门户的会话 cookie。额度只在门户上，而门户只认 cookie。
//
// 两者不能互换：用 key 去问门户问不出额度，用 cookie 去推理也不行。
// 所以额度读不到不是错误 —— 推理照走，额度是「不知道」。
//
// 凭据存在 secrets 表里，id 是 lib/credential-ids.ts 里那唯一的算法：
// key:provider:<账号>:account。

import { providerSecretId } from "../credential-ids.ts";
import { tokenFingerprint } from "../credential.ts";
import { getSecret } from "../store.ts";

/** 数据库里那份账号凭据的样子。 */
export interface QiniuAccount {
  /** 推理用的 API key。 */
  apiKey: string;
  /** 门户的 cookie 串（额度只认它）。没有就查不了额度，不是错误。 */
  portalCookie?: string;
}

/** 这个账号的凭据在数据库里的 id。 */
export function qiniuAccountId(providerId: string): string {
  return providerSecretId(providerId, "account");
}

/**
 * 这个账号的凭据。
 *
 * 没有就 null —— 两段都没有的记录跟没有是一样的。
 */
export function qiniuAccountOf(providerId: string): QiniuAccount | null {
  const stored = getSecret<QiniuAccount>(qiniuAccountId(providerId));
  if (!stored) return null;
  const apiKey = String(stored.apiKey ?? "").trim();
  const portalCookie = String(stored.portalCookie ?? "").trim();
  if (!apiKey && !portalCookie) return null;
  return { apiKey, ...(portalCookie ? { portalCookie } : {}) };
}

/** 这个账号推理用的 key。没有就空字符串。 */
export function qiniuInferenceKey(providerId: string): string {
  return qiniuAccountOf(providerId)?.apiKey ?? "";
}

/** 这个账号的门户 cookie。没有就空字符串。 */
export function qiniuPortalCookie(providerId: string): string {
  return qiniuAccountOf(providerId)?.portalCookie ?? "";
}

/**
 * 面板上看的凭据状态。
 *
 * 干活的是那把推理 key：没有它，一个请求也发不出去。门户 cookie 只影响
 * 「能不能看额度」，所以它写进说明里，不影响状态。
 */
export function qiniuStatus(providerId: string): Record<string, unknown> {
  const key = qiniuInferenceKey(providerId);
  const cookie = qiniuPortalCookie(providerId);
  return {
    status: key ? "authenticated" : "missing",
    fingerprint: key ? tokenFingerprint(key) : "",
    expiresAt: "",
    remainingSec: 0,
    warning: false,
    detail: key
      ? cookie
        ? "推理用的 API key；门户 cookie 也配了，能查额度"
        : "推理用的 API key；没有门户 cookie，查不了额度"
      : "账号上没有推理用的 API key",
  };
}
