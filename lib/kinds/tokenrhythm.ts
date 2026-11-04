// lib/kinds/tokenrhythm.ts — TokenRhythm, the relay.
//
// One account is one wallet, and the credit expires, so this is the only kind
// that can pick by expiry (expiry_first): the periodic scan pins the account
// whose credit expires first.

import { tokenRhythmCatalogModels } from "../catalog-models.ts";
import { outOfCreditsOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { TOKENRHYTHM_API_BASE } from "../tokenrhythm/accounts.ts";
import { isRequestMissingBalance, setBalanceAccount } from "../tokenrhythm/balance.ts";
// 引用即登记：这个 kind 的额度归这个插件问，读法也归它 —— 这里不再有第二份
// 「钱包怎么报成余额」的代码，两份迟早会走样。
import { tokenRhythmWalletPlugin } from "../tokenrhythm/quota-plugin.ts";
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
  credential: (provider) => fromUpstreamStatus(tokenRhythmStatus(provider.id), "session"),
  models: () => tokenRhythmCatalogModels(),
  // 额度读的是插件问回来的那一份结论：钱包读不到是「不知道」，不是「没钱」——
  // 那一条由插件的状态说，这里不重判。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, tokenRhythmWalletPlugin.id),
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, tokenRhythmWalletPlugin.id),
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, tokenRhythmWalletPlugin.id),
  // 定时扫描余额，把「现在该用哪个账户」钉下来（赠金最先到期的那个）。
  // 钉住的单位是平台：一副账号里哪个先用是平台的事。
  scan: async (provider) => {
    await setBalanceAccount(provider.platform);
  },
  // The hook of expiry_first: the platform says this account has no money left.
  isRequestMissingBalance: (error) => isRequestMissingBalance(error),
});
