// lib/qiniu/quota-plugin.ts — 七牛云的额度做成一个插件。
//
// 额度在门户上，而门户只认门户 cookie：推理用的那把 key 在这里没有用。查不到额度
// 不是错误 —— 推理不需要它。所以 probe 从不 reject：拿不到就翻成一种说清楚原因
// 的状态（没填 cookie / 凭据被拒 / 被限流 / 问不到）。

import { quotaProbe, type QuotaState } from "../quota-state.ts";
import { quotaEndpointBase, registerQuotaPlugin } from "../quota-plugins.ts";
import type { CreditLotView, QuotaView } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { qiniuPortalCookie, QINIU_ACCOUNT_FIELD } from "./account.ts";
// 插件 id 住在一个没有依赖的地方（lib/qiniu/quota-plugin-id.ts）：本模块与
// register 互相引用，id 若在本模块里，register 在求值期读它就会撞上「还在初始化」。
import { QINIU_QUOTA_PLUGIN_ID } from "./quota-plugin-id.ts";
export { QINIU_QUOTA_PLUGIN_ID };
import { QINIU_PORTAL_BASE } from "./config.ts";
import { fetchQiniuQuota, type QiniuQuota } from "./quota.ts";

/**
 * 门户 cookie 那一段在凭据里的字段名。
 *
 * name 不是给人看的名字（那是 label），是这段凭据在库里的 id 后缀：它必须与
 * lib/qiniu/account.ts 的 qiniuAccountId() 一致，否则插件读不到它。
 * 开放平台的账号按同一个规则写同一个位置，qiniuPortalCookie() 就读得到。
 *
 * 名字只有那一个来源：QINIU_ACCOUNT_FIELD。
 */

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
      upstreamId: account.platform,
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
  id: QINIU_QUOTA_PLUGIN_ID,
  label: "七牛云资源包",
  fields: [{ name: QINIU_ACCOUNT_FIELD, label: "门户 cookie", secret: true }],
  probe: async (account) => {
    // 没填门户 cookie：用户还没填，不是门户拒绝了什么。
    const cookie = qiniuPortalCookie(account.id);
    if (!cookie) return quotaProbe("missing", "账号上没有门户 cookie，无法查询资源包");

    const answer = await fetchQiniuQuota(cookie, quotaEndpointBase(account, QINIU_PORTAL_BASE));
    if (!answer.ok) {
      // 门户说的话原样带过去：状态码在日志与面板上是最有用的一句。
      return quotaProbe(stateOfReason(answer.reason), answer.message, {
        // 限流才有「多久之后再来」：门户说了就用它，没说平台按默认时长冷却。
        recoverAt: answer.retryAfterMs === null ? null : Date.now() + answer.retryAfterMs,
      });
    }

    const quota = answer.quota;
    const remaining = quota.respacks.reduce((sum, pack) => sum + pack.remaining, 0);
    const unit = quota.respacks[0]?.unit ?? "";
    const summary = `资源包：${quota.respacks.length} 项，剩余 ${remaining} ${unit}`;
    // 所有包都见底才算用尽 —— 还有一包剩着就还能走。
    if (quota.respacks.every((pack) => pack.remaining <= 0)) {
      // 数字全零，说的是「一包都不剩」：这时候面板要的是一句话，不是那几行零。
      return quotaProbe("no_quota", `资源包全部用尽：${summary}`);
    }
    // 资源包不会自己长回来：见底了只能再买一个，没有「什么时候回来」这个时刻。
    return quotaProbe("ok", summary, { views: qiniuQuotas(account, quota) });
  },
});

/** 门户那边的原因，翻成状态。 */
function stateOfReason(reason: "unauthorized" | "rate_limited" | "unknown"): QuotaState {
  return reason;
}
