// lib/qiniu/register.ts — 七牛云是什么，写成一段声明。
//
// 转发是所有开放平台共用的（lib/router/openai-platform.ts）：请求是 OpenAI
// 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer。
// 七牛云剩下的只有三件事：地址、key 从哪来、额度怎么问。

import {
  fromUpstreamStatus,
  type CreditLotView,
  type HealthSnapshot,
  type QuotaView,
} from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { qiniuInferenceKey, qiniuStatus } from "./account.ts";
import { qiniuCatalogModels } from "./catalog.ts";
import { QINIU_INFER_BASE } from "./config.ts";
import { QINIU_MODELS } from "./models.ts";
import type { QiniuQuota } from "./quota.ts";

/**
 * 快照里这个账号的额度。
 *
 * 没有就是 null —— 那是「没问到」，不是「没有资源包」。
 */
function quotaOf(provider: ProviderRow, snapshot: HealthSnapshot): QiniuQuota | null {
  const raw = snapshot.qiniu?.[provider.id]?.quota;
  if (!raw || typeof raw !== "object") return null;
  const quota = raw as QiniuQuota;
  if (!Array.isArray(quota.respacks)) return null;
  return quota;
}

/** 资源包报成积分：一个包一条，合计是各包的合计。 */
function qiniuQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const quota = quotaOf(provider, snapshot);
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
      upstreamId: provider.id,
      accountId: provider.id,
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

export const qiniuKind = registerCompatiblePlatform({
  kind: "qiniu",
  label: "七牛云",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  policies: ["single", "fallback"],
  baseUrl: () => QINIU_INFER_BASE,
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => qiniuInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(qiniuStatus(provider.id), "api_key"),
  // 目录写死：平台报的 78 个比这把 key 的商品分组宽，报出去就会撞 403。
  models: () => qiniuCatalogModels(QINIU_MODELS),
  quotas: (provider, snapshot) => qiniuQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const quota = quotaOf(provider, snapshot);
    // 读不到不等于没钱：那是「不知道」。
    if (!quota || !quota.respacks.length) return false;
    // 所有包都见底才算用尽 —— 还有一包剩着就还能走。
    return quota.respacks.every((pack) => pack.remaining <= 0);
  },
});

// 推理用 API Key、额度用门户 cookie，两样都不是会话。
declareNoLoginFlow("qiniu", "七牛用 API Key + 门户 cookie，没有会话登录");
