// lib/quota-plugin-credentials.ts — 额度插件要的那几段凭据。
//
// 插件的字段（QuotaField.name）就是这段凭据在库里的 id 后缀：一段字段一行，
// 行的 id 是 providerSecretId(账号 id, 字段名)。行里只放一个值，形状是
// {"value": "..."} —— 一行只归一段管，插件要几段就有几行，互不干扰。
//
// 字段名不是给人看的名字（那是 label）：它必须与插件读凭据时找的那个位置一致，
// 否则插件读不到它。七牛那个插件的字段名是 "account"，与 lib/qiniu/account.ts
// 的 qiniuAccountId() 一致 —— 名字只有那一个来源。
//
// 推理用的 key 不在这里：它有自己的位置（:key），插件的字段不碰它。

import { providerSecretId } from "./credential-ids.ts";
import { deleteSecret, getSecret, setSecret } from "./store.ts";

/**
 * 这段字段在这个账号上存的值；没有就是 ""。
 *
 * 空字段名一律当没有：providerSecretId 的空后缀是会话那一行，插件的字段写
 * 到那里去就是写错了地方。
 */
export function pluginFieldOf(accountId: string, fieldName: string): string {
  const name = String(fieldName ?? "").trim();
  if (!name) return "";
  const stored = getSecret<{ value?: string }>(providerSecretId(accountId, name));
  return String(stored?.value ?? "").trim();
}

/**
 * 写一段；空串表示清掉。返回写了没有。
 *
 * 写进去的是这一段自己的值：这一行只归这一段管，所以写它就是把这一行换成它
 * （别的一段在别的行里，不会被顺手抹掉）。空的那段表示清掉它 —— 面板上重填
 * 一次就是替换的意思。
 */
export function writePluginField(accountId: string, fieldName: string, value: string): boolean {
  const name = String(fieldName ?? "").trim();
  if (!name) return false;
  const id = providerSecretId(accountId, name);
  const v = String(value ?? "").trim();
  if (!v) {
    deleteSecret(id);
    return false;
  }
  setSecret(id, "account", { value: v });
  return true;
}
