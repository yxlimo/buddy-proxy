// lib/sensenova/register.ts — what SenseNova is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of "SenseNova" is its address, its key and its quota pools.

import { senseNovaCatalogModels } from "../catalog-models.ts";
import { fromUpstreamStatus } from "../provider-kinds.ts";
import { outOfCreditsOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { senseNovaStatus } from "./auth.ts";
import { SENSENOVA_INFER_BASE } from "./config.ts";
// 引用即登记：这个 kind 的额度归这个插件问，读法也归它 —— register 里不再有
// 第二份「池子怎么报成额度」的代码，两份迟早会走样。
import { senseNovaPoolsPlugin } from "./quota-plugin.ts";
import { senseNovaCatalog, senseNovaInferenceKey } from "./transport.ts";

export const senseNovaKind = registerCompatiblePlatform({
  kind: "sensenova",
  label: "SenseNova",
  // 上游报错时那句提示里名字后面留一个空格，与改之前一字不差。
  what: "SenseNova ",
  login: "password",
  policies: ["single", "fallback"],
  baseUrl: () => SENSENOVA_INFER_BASE,
  // 推理用的是账号里那把 apiKey：会话与 cookie 只用来问额度。
  inferWith: "api_key",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => senseNovaInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(senseNovaStatus(provider.id), "api_key"),
  models: () => senseNovaCatalogModels(senseNovaCatalog()),
  // 额度读的是插件问回来的那一份结论。平台行没指名插件、插件没登记、这一轮没
  // 问到 —— 三种都是「不知道」，不是 0。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, senseNovaPoolsPlugin.id),
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, senseNovaPoolsPlugin.id),
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, senseNovaPoolsPlugin.id),
});
