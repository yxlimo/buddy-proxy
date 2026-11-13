// lib/qiniu/register.ts — 七牛云是什么，写成一段声明。
//
// 转发是所有开放平台共用的（lib/router/openai-platform.ts）：请求是 OpenAI
// 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer。
// 七牛云剩下的只有三件事：地址、key 从哪来、额度怎么问。
//
// 额度现在是插件（lib/qiniu/quota-plugin.ts）：问门户与翻状态都在那边。要不要
// 问由**平台那一行**说了算（platform.quota_plugin）—— 门户 cookie 会过期，没被
// 指名的时候不该每轮都去敲一次门户。这个文件只把快照里那一次结论交给通用的读法
// （lib/quota-state.ts）。

import { fromUpstreamStatus } from "../provider-kinds.ts";
import { providerSecretId } from "../credential-ids.ts";
import { secretRecord, valueSlot } from "../kinds/shared.ts";
import type { ProviderRow } from "../providers.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { catalogModelsFromRow } from "../catalog-models.ts";
// 平台行是额度插件的出处：指名的那个插件问回来，没指名就是「不知道」。
import { openPlatformOf } from "../open-platforms.ts";
import { outOfCreditsOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { qiniuAccountOf, qiniuInferenceKey, qiniuStatus, writeQiniuAccount } from "./account.ts";
import { QINIU_INFER_BASE } from "./config.ts";
// 插件 id 从没有依赖的地方读（lib/qiniu/quota-plugin-id.ts）：插件模块与本模块
// 互相引用，从插件对象上取 id 会在求值期撞上「还在初始化」。
import { QINIU_QUOTA_PLUGIN_ID } from "./quota-plugin-id.ts";
// import 这个插件文件就是登记它：启动校验之前，插件得先被认得。
import "./quota-plugin.ts";

/**
 * 这个平台的额度插件 id。
 *
 * 插件 id 写在平台那一行：没写、写了个没人登记的 id，都是「不知道」—— 不是
 * 错误。用户可能还在输，而网关得照样转发。
 */
function quotaPluginIdOf(provider: ProviderRow): string {
  return openPlatformOf(provider.platform)?.quotaPlugin?.trim() ?? "";
}

export const qiniuKind = registerCompatiblePlatform({
  kind: "qiniu",
  label: "七牛云",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  policies: ["single", "fallback"],
  baseUrl: () => QINIU_INFER_BASE,
  // 这一类默认指哪台：额度请求靠它分辨「行上的地址还是默认那台」（行上的地址
  // 等于它时，额度问门户而不是推理端点）。
  defaultBaseUrl: QINIU_INFER_BASE,
  // 额度插件：门户那一路。面板建平台时预填这一格（用户可以改）。
  defaultQuotaPlugin: QINIU_QUOTA_PLUGIN_ID,
  // 推理用的是那把 API key：门户 cookie 只用来查额度。
  inferWith: "api_key",
  // 两段凭据，两段都在同一条记录里（:account）：推理 key 与门户 cookie。
  //
  // 两者不能互换：用 key 去问门户问不出额度，用 cookie 去推理也不行。所以额度
  // 读不到不是错误 —— 推理照走，额度是「不知道」。
  credentials: {
    title: "七牛云凭据",
    slots: () => {
      const recordId = (account: { id: string }) => providerSecretId(account.id, "account");
      return [
        valueSlot({
          label: "推理 Key",
          form: "api_key",
          id: recordId,
          value: (account) => qiniuInferenceKey(account.id),
          updatedAt: (account) => secretRecord(recordId(account)).updatedAt,
        }),
        // 门户 cookie 是同一份记录里的另一段：id 用派生的写法（#cookie），免得
        // 造一个 parseCredentialId 认不出来的后缀。它不是推理凭据。
        valueSlot({
          label: "额度 Cookie",
          form: "cookie",
          id: (account) => `${recordId(account)}#cookie`,
          value: (account) => String(qiniuAccountOf(account.id)?.portalCookie ?? ""),
          updatedAt: (account) => secretRecord(recordId(account)).updatedAt,
        }),
      ];
    },
    fields: () => [
      {
        name: "api-key",
        label: "推理 Key",
        hint: "发模型请求用的那一把",
        placeholder: "sk-…",
      },
      {
        name: "portal-cookie",
        label: "额度 Cookie",
        hint: "只用来查资源包额度，可以留空",
        placeholder: "c=…",
      },
    ],
    // 位置就是顺序：第一段是 key，第二段是 cookie。空的那段表示清掉它。
    write: (account, values) =>
      writeQiniuAccount(account.id, {
        apiKey: String(values[0] ?? ""),
        portalCookie: String(values[1] ?? ""),
      }),
  },
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => qiniuInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(qiniuStatus(provider.id), "api_key"),
  // 目录是平台那一行说了算：行里的 id 与顺序就是公布的（目录从上游拉）。
  models: (provider) => catalogModelsFromRow(provider, () => []),
  // 没有插件、或者快照里没有这个账号的那一份：额度是「未知」。空数组不是 0 ——
  // 0 说的是「一点不剩」，那是在替一个根本没问过的平台撒谎。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, quotaPluginIdOf(provider)),
  // 不知道就不该断路：问不到额度的账号还是能接请求的账号。
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, quotaPluginIdOf(provider)),
  // 资源包不会自己长回来，所以没有「什么时候回来」这个时刻：插件答 null（「不
  // 知道」），没人知道的时候调用方要的也是 null。
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, quotaPluginIdOf(provider)),
});

// 推理用 API Key、额度用门户 cookie，两样都不是会话。
declareNoLoginFlow("qiniu", "七牛用 API Key + 门户 cookie，没有会话登录");

