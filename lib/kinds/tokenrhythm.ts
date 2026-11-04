// lib/kinds/tokenrhythm.ts — TokenRhythm, the relay.
//
// One account is one wallet, and the credit expires, so this is the only kind
// that can pick by expiry (expiry_first): the periodic scan pins the account
// whose credit expires first.

import { tokenRhythmCatalogModels } from "../catalog-models.ts";
import { outOfCreditsOf, quotaPluginIdOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { TOKENRHYTHM_API_BASE, tokenRhythmCredentialOf } from "../tokenrhythm/accounts.ts";
import { isRequestMissingBalance, setBalanceAccount } from "../tokenrhythm/balance.ts";
// 引用即登记：登记发生在模块求值期（lib/quota-plugins.ts 的注册表）。读哪一份靠
// 平台行那一格（quotaPluginIdOf）—— 这里再写一个插件 id，写快照一头与读结论
// 一头就有了两个来源，两边不一致时面板自相矛盾。
import "../tokenrhythm/quota-plugin.ts";
import { tokenRhythmStatus } from "../tokenrhythm/wallet.ts";
import { fromUpstreamStatus, registerKind } from "./shared.ts";

registerKind({
  kind: "tokenrhythm",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "TokenRhythm",
  login: "password",
  // 一个账号一个钱包。赠金会过期，所以它还能按到期先后挑。
  policies: ["single", "fallback", "expiry_first"],
  baseUrl: () => TOKENRHYTHM_API_BASE,
  // 推理用的是钱包里的那把 api key：会话只用来登录与查余额。
  inferWith: "api_key",
  // 明文 key：转发与「问上游要模型目录」要的是同一把，各自去取一遍就是两份知识。
  keyOf: (provider, accountId) => tokenRhythmCredentialOf(accountId ?? provider.id)?.apiKey ?? "",
  credential: (provider) => fromUpstreamStatus(tokenRhythmStatus(provider.id), "session"),
  models: () => tokenRhythmCatalogModels(),
  // 额度读的是插件问回来的那一份结论：钱包读不到是「不知道」，不是「没钱」——
  // 那一条由插件的状态说，这里不重判。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, quotaPluginIdOf(provider)),
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, quotaPluginIdOf(provider)),
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, quotaPluginIdOf(provider)),
  // 定时扫描余额，把「现在该用哪个账户」钉下来（赠金最先到期的那个）。
  // 钉住的单位是平台：一副账号里哪个先用是平台的事。
  scan: async (provider) => {
    await setBalanceAccount(provider.platform);
  },
  // The hook of expiry_first: the platform says this account has no money left.
  isRequestMissingBalance: (error) => isRequestMissingBalance(error),
});
