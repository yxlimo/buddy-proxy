// lib/intern-ai/register.ts — what 书生·端砚 (Discovery) is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of this one is its address, its key and its 墨点 balance.

import { catalogModelsFromRow, internAiCatalogModels } from "../catalog-models.ts";
import { fromUpstreamStatus } from "../provider-kinds.ts";
import { outOfCreditsOf, quotaPluginIdOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { internAiStatus } from "./auth.ts";
// 登录链登记：引用即登记（见 lib/login-flow.ts）。
import "./login-flow.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "./config.ts";
// 插件 id 从没有依赖的地方读（lib/intern-ai/quota-plugin-id.ts）：插件模块与本
// 模块互相引用，从插件对象上取 id 会在求值期撞上「还在初始化」。
import { INTERN_AI_CREDITS_PLUGIN_ID } from "./quota-plugin-id.ts";
// 引用即登记：登记发生在模块求值期（lib/quota-plugins.ts 的注册表）。读哪一份靠
// 平台行那一格（quotaPluginIdOf）—— 这里再写一个插件 id，写快照一头与读结论
// 一头就有了两个来源，两边不一致时面板自相矛盾。
import "./quota-plugin.ts";
import { internAiCatalog, internAiInferenceKey } from "./transport.ts";

export const internAiKind = registerCompatiblePlatform({
  kind: "intern-ai",
  label: "书生·端砚",
  login: "code",
  policies: ["single", "fallback"],
  baseUrl: () => INTERN_AI_DISCOVERY_API_BASE,
  // 这一类默认指哪台（地址是适配器自己的能力描述，不是平台清单）。
  defaultBaseUrl: INTERN_AI_DISCOVERY_API_BASE,
  // 额度插件：墨点那一路。面板建平台时预填这一格（用户可以改）。
  defaultQuotaPlugin: INTERN_AI_CREDITS_PLUGIN_ID,
  // 推理用的是 Discovery 那把 key：子站 token 只用来补 key 与问额度。
  inferWith: "api_key",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => internAiInferenceKey(accountId ?? provider.id),
  modelsFromUpstream: true,
  credential: (provider) => fromUpstreamStatus(internAiStatus(provider.id), "api_key"),
  // 目录是平台那一行说了算：行里的 id 与顺序就是公布的。元数据在上游缓存里
  // （推理端那份清单 + 控制台补的能力与上下文），行里查不到的 id 只给名字。
  // 行读不到才退回缓存那一份 —— 那是兜底，不是常态。
  models: (provider) => {
    const rendered = internAiCatalogModels(internAiCatalog());
    const byId = new Map(rendered.map((model) => [model.id, model]));
    return catalogModelsFromRow(provider, () => rendered, (id) => byId.get(id));
  },
  // 额度读的是插件问回来的那一份结论：「平台说账号不能用」（blocked）与「墨点没了」
  // （no_quota）是插件分的，这里只照结论读 —— 两句话不一样，面板才分得清。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, quotaPluginIdOf(provider)),
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, quotaPluginIdOf(provider)),
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, quotaPluginIdOf(provider)),
});

