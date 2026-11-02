// lib/qiniu/register.ts — 七牛云是什么，写成一段声明。
//
// 转发是所有开放平台共用的（lib/router/openai-platform.ts）：请求是 OpenAI
// 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer。
// 七牛云剩下的只有三件事：地址、key 从哪来、额度怎么问。
//
// 额度现在是插件（lib/qiniu/quota-plugin.ts）：问门户与读资源包都在那边。这个
// 文件只把快照里的那一份交给插件 —— 数字只有一份实现，搬来搬去迟早会走样。

import { fromUpstreamStatus, type HealthSnapshot } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { qiniuInferenceKey, qiniuStatus } from "./account.ts";
import { qiniuCatalogModels } from "./catalog.ts";
import { QINIU_INFER_BASE } from "./config.ts";
import { QINIU_MODELS } from "./models.ts";
import type { QiniuQuota } from "./quota.ts";
// import 这个插件文件就是登记它：启动校验之前，插件得先被认得。
import { qiniuQuotaOfPayload, qiniuQuotaPlugin } from "./quota-plugin.ts";

/**
 * 快照里这个账号的那一份。
 *
 * 没有就是「没问到」—— 不是「没有资源包」。这两种由读的那一份分得清（读不出来
 * 就是 null）。
 */
function quotaPayload(provider: ProviderRow, snapshot: HealthSnapshot): QiniuQuota | null {
  return qiniuQuotaOfPayload(snapshot.qiniu?.[provider.id]?.quota);
}

export const qiniuKind = registerCompatiblePlatform({
  kind: "qiniu",
  label: "七牛云",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  policies: ["single", "fallback"],
  baseUrl: () => QINIU_INFER_BASE,
  // 推理用的是那把 API key：门户 cookie 只用来查额度。
  inferWith: "api_key",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => qiniuInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(qiniuStatus(provider.id), "api_key"),
  // 目录写死：平台报的 78 个比这把 key 的商品分组宽，报出去就会撞 403。
  models: () => qiniuCatalogModels(QINIU_MODELS),
  quotas: (provider, snapshot) => qiniuQuotaPlugin.quotas(provider, quotaPayload(provider, snapshot)),
  outOfCredits: (provider, snapshot) =>
    qiniuQuotaPlugin.outOfCredits?.(provider, quotaPayload(provider, snapshot)) ?? false,
  // 资源包不会自己长回来，所以没有「什么时候回来」这个时刻：插件答 null（「不
  // 知道」），没人知道的时候调用方要的也是 null。
  recoverAt: (provider, snapshot) =>
    qiniuQuotaPlugin.recoverAt?.(provider, quotaPayload(provider, snapshot)) ?? null,
});

// 推理用 API Key、额度用门户 cookie，两样都不是会话。
declareNoLoginFlow("qiniu", "七牛用 API Key + 门户 cookie，没有会话登录");
