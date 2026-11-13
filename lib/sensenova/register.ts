// lib/sensenova/register.ts — what SenseNova is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of "SenseNova" is its address, its key and its quota pools.

import { catalogModelsFromRow, senseNovaCatalogModels } from "../catalog-models.ts";
import { fromUpstreamStatus } from "../provider-kinds.ts";
import { keyPlan, secretRecord, sessionSlot, valueSlot } from "../kinds/shared.ts";
import { providerSecretId } from "../credential-ids.ts";
import { writeSenseNovaKey } from "./keys.ts";
import { outOfCreditsOf, quotaPluginIdOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { senseNovaStatus } from "./auth.ts";
import { SENSENOVA_INFER_BASE } from "./config.ts";
// 插件 id 从没有依赖的地方读（lib/sensenova/quota-plugin-id.ts）：插件模块与本
// 模块互相引用，从插件对象上取 id 会在求值期撞上「还在初始化」。
import { SENSE_NOVA_POOLS_PLUGIN_ID } from "./quota-plugin-id.ts";
// 引用即登记：登记发生在模块求值期（lib/quota-plugins.ts 的注册表）。读哪一份靠
// 平台行那一格（quotaPluginIdOf）—— 这里再写一个插件 id，写快照一头与读结论
// 一头就有了两个来源，两边不一致时面板自相矛盾。
import "./quota-plugin.ts";
import { senseNovaCatalog, senseNovaInferenceKey } from "./transport.ts";

export const senseNovaKind = registerCompatiblePlatform({
  kind: "sensenova",
  label: "SenseNova",
  // 上游报错时那句提示里名字后面留一个空格，与改之前一字不差。
  what: "SenseNova ",
  login: "password",
  policies: ["single", "fallback"],
  baseUrl: () => SENSENOVA_INFER_BASE,
  // 这一类默认指哪台（地址是适配器自己的能力描述，不是平台清单）。
  defaultBaseUrl: SENSENOVA_INFER_BASE,
  // 额度插件：积分池那一路。面板建平台时预填这一格（用户可以改）。
  defaultQuotaPlugin: SENSE_NOVA_POOLS_PLUGIN_ID,
  // 推理用的是账号里那把 apiKey：会话与 cookie 只用来问额度。
  inferWith: "api_key",
  // 两段凭据：控制台会话（问额度）与推理 key（干活）。
  //
  // 登录身份（user / password）不列：它既不能发请求，也不能问额度 —— 它留在
  // 库里（.env 丢了要靠它重新登录），只是不上屏。
  credentials: keyPlan({
    title: "SenseNova API Key",
    slots: () => [
      sessionSlot(),
      valueSlot({
        label: "推理 Key",
        form: "api_key",
        id: (account) => `${providerSecretId(account.id, "account")}#api_key`,
        value: (account) => String(secretRecord(providerSecretId(account.id, "account")).data?.apiKey ?? ""),
        updatedAt: (account) => secretRecord(providerSecretId(account.id, "account")).updatedAt,
      }),
    ],
    field: {
      name: "api-key",
      label: "推理 Key",
      hint: "发模型请求用的那一把；留空表示清掉它",
      placeholder: "sk-…",
    },
    write: (account, value) => writeSenseNovaKey(account.id, value),
  }),
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => senseNovaInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(senseNovaStatus(provider.id), "api_key"),
  // 目录是平台那一行说了算：行里的 id 与顺序就是公布的。元数据在上游缓存里
  // （平台报的那一份），行里查不到的 id 只给名字。行读不到才退回缓存那一份 ——
  // 那是兜底，不是常态。
  models: (provider) => {
    const rendered = senseNovaCatalogModels(senseNovaCatalog());
    const byId = new Map(rendered.map((model) => [model.id, model]));
    return catalogModelsFromRow(provider, () => rendered, (id) => byId.get(id));
  },
  // 额度读的是插件问回来的那一份结论：平台行没指名插件、插件没登记、这一轮没
  // 问到 —— 三种都是「不知道」，不是 0。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, quotaPluginIdOf(provider)),
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, quotaPluginIdOf(provider)),
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, quotaPluginIdOf(provider)),
});

