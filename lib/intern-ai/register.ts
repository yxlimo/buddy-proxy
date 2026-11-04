// lib/intern-ai/register.ts — what 书生·端砚 (Discovery) is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of this one is its address, its key and its 墨点 balance.

import { internAiCatalogModels } from "../catalog-models.ts";
import { fromUpstreamStatus } from "../provider-kinds.ts";
import { outOfCreditsOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { internAiStatus } from "./auth.ts";
// 登录链登记：引用即登记（见 lib/login-flow.ts）。
import "./login-flow.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "./config.ts";
// 引用即登记：这个 kind 的额度归这个插件问，读法也归它 —— register 里不再有
// 第二份「墨点怎么报成额度」的代码，两份迟早会走样。
import { internAiCreditsPlugin } from "./quota-plugin.ts";
import { internAiCatalog, internAiInferenceKey } from "./transport.ts";

export const internAiKind = registerCompatiblePlatform({
  kind: "intern-ai",
  label: "书生·端砚",
  login: "code",
  policies: ["single", "fallback"],
  baseUrl: () => INTERN_AI_DISCOVERY_API_BASE,
  // 推理用的是 Discovery 那把 key：子站 token 只用来补 key 与问额度。
  inferWith: "api_key",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => internAiInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(internAiStatus(provider.id), "api_key"),
  models: () => internAiCatalogModels(internAiCatalog()),
  // 额度读的是插件问回来的那一份结论：「平台说账号不能用」（blocked）与「墨点没了」
  // （no_quota）是插件分的，这里只照结论读 —— 两句话不一样，面板才分得清。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, internAiCreditsPlugin.id),
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, internAiCreditsPlugin.id),
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, internAiCreditsPlugin.id),
});
