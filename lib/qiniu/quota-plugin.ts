// lib/qiniu/quota-plugin.ts — 七牛云的额度做成一个插件。
//
// 额度在门户上，而门户只认门户 cookie：推理用的那把 key 在这里没有用。查不到额度
// 不是错误 —— 推理不需要它。所以 fetch 拿不到就返回 null（不知道），不抛。

import { registerQuotaPlugin } from "../quota-plugins.ts";
import type { CreditLotView, QuotaView } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { qiniuQuotaOf, type QiniuQuota } from "./quota.ts";

/**
 * 门户 cookie 那一段在凭据里的字段名。
 *
 * 就是凭据存进去时用的那个名字（lib/qiniu/account.ts）：插件按名字要一段凭据，
// 而这一段得是真的在那儿。
 */
export const QINIU_PORTAL_COOKIE_FIELD = "portalCookie";

/**
 * 快照里那一份读成额度。
 *
 * 读不出来就是 null —— 那是「没问到」，不是「没有资源包」。读不出来的那一份不能
 * 变成空列表：空列表说的是「一点不剩」，那是在替上游说它没说过的话。
 */
export function qiniuQuotaOfPayload(payload: unknown): QiniuQuota | null {
  if (!payload || typeof payload !== "object") return null;
  const quota = payload as QiniuQuota;
  if (!Array.isArray(quota.respacks)) return null;
  return quota;
}

/**
 * 资源包报成积分：一个包一条，合计是各包的合计。
 *
 * 从 lib/qiniu/register.ts 原样搬过来，一个数字都没动：迁移不许动数字，迁移前
 * 的那份实现留在 test/quota-plugin-check.ts 里当尺子。
 */
export function qiniuQuotas(account: ProviderRow, payload: unknown): QuotaView[] {
  const quota = qiniuQuotaOfPayload(payload);
  if (!quota || !quota.respacks.length) return [];
  const lots: CreditLotView[] = quota.respacks.map((pack) => ({
    id: `${pack.itemCode}@${pack.zoneName}`,
    sourceLabel: `${pack.itemName} · ${pack.zoneName}（${pack.unit}）`,
    remaining: pack.remaining,
    // 资源包是预付的：没有到期这一说。
    expiresAt: 0,
    status: pack.remaining > 0 ? "可用" : "已用尽",
  }));
  const total = quota.respacks.reduce((sum, pack) => sum + pack.total, 0);
  const used = quota.respacks.reduce((sum, pack) => sum + pack.used, 0);
  const remaining = quota.respacks.reduce((sum, pack) => sum + pack.remaining, 0);
  // 单位是 k tokens：不换算，也不跟别家的口径相加（那是另一个数）。
  const unit = quota.respacks[0]?.unit ?? "";
  return [
    {
      upstreamId: account.id,
      accountId: account.id,
      credits: {
        total,
        used,
        remaining,
        lots,
        note: `资源包：${quota.respacks.length} 项，剩 ${remaining} ${unit}`,
      },
    },
  ];
}

export const qiniuQuotaPlugin = registerQuotaPlugin({
  id: "qiniu",
  label: "七牛云资源包",
  fields: [{ name: QINIU_PORTAL_COOKIE_FIELD, label: "门户 cookie", secret: true }],
  fetch: (account) => qiniuQuotaOf(account.id),
  quotas: (account, payload) => qiniuQuotas(account, payload),
  outOfCredits: (account, payload) => {
    const quota = qiniuQuotaOfPayload(payload);
    // 读不到不等于没钱：那是「不知道」。
    if (!quota || !quota.respacks.length) return false;
    // 所有包都见底才算用尽 —— 还有一包剩着就还能走。
    return quota.respacks.every((pack) => pack.remaining <= 0);
  },
  // 资源包不会自己长回来：见底了只能再买一个，没有「什么时候回来」这个时刻。
  recoverAt: () => null,
});
