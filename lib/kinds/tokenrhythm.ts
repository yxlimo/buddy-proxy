// lib/kinds/tokenrhythm.ts — TokenRhythm, the relay.
//
// One account is one wallet, and the credit expires, so this is the only kind
// that can pick by expiry (expiry_first): the periodic scan pins the account
// whose credit expires first.

import { catalogModelsFromRow } from "../catalog-models.ts";
import { providerSecretId } from "../credential-ids.ts";
import { outOfCreditsOf, quotaPluginIdOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import {
  loadSession as loadTokenRhythmSession,
  tokenRhythmCredentialOf,
} from "../tokenrhythm/accounts.ts";
// 地址在叶子模块里：这一层与 accounts.ts 互相引着，从那边读常量会在模块求值
// 期撞上「还在初始化」。
import { TOKENRHYTHM_API_BASE, TOKENRHYTHM_INFER_BASE } from "../tokenrhythm/config.ts";
import { isRequestMissingBalance, setBalanceAccount } from "../tokenrhythm/balance.ts";
// 插件 id 从没有依赖的地方读（lib/tokenrhythm/quota-plugin-id.ts）：插件模块与本
// 模块互相引用，从插件对象上取 id 会在求值期撞上「还在初始化」。
import { TOKENRHYTHM_WALLET_PLUGIN_ID } from "../tokenrhythm/quota-plugin-id.ts";
// 引用即登记：登记发生在模块求值期（lib/quota-plugins.ts 的注册表）。读哪一份靠
// 平台行那一格（quotaPluginIdOf）—— 这里再写一个插件 id，写快照一头与读结论
// 一头就有了两个来源，两边不一致时面板自相矛盾。
import "../tokenrhythm/quota-plugin.ts";
import { tokenRhythmStatus } from "../tokenrhythm/wallet.ts";
import { writeTokenRhythmKey } from "../tokenrhythm/keys.ts";
import { fromUpstreamStatus, keyPlan, registerKind, sessionSlot, valueSlot } from "./shared.ts";

registerKind({
  kind: "tokenrhythm",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "TokenRhythm",
  login: "password",
  // 一个账号一个钱包。赠金会过期，所以它还能按到期先后挑。
  policies: ["single", "fallback", "expiry_first"],
  baseUrl: () => TOKENRHYTHM_API_BASE,
  // 这一类默认指哪台（地址是适配器自己的能力描述，不是平台清单）：额度请求靠它
  // 分辨「行上的地址还是默认那台」。
  defaultBaseUrl: TOKENRHYTHM_INFER_BASE,
  // 额度插件：钱包那一路。面板建平台时预填这一格（用户可以改）。
  defaultQuotaPlugin: TOKENRHYTHM_WALLET_PLUGIN_ID,
  // 推理用的是钱包里的那把 api key：会话只用来登录与查余额。
  inferWith: "api_key",
  // 一个账号一个钱包：推理 key 与登录会话各一段，key 先列（干活的那一段在
  // 前面）。登录账号（account / password）不列：它既不是推理凭据，也不是额度
  // 凭据，面板上看不出它能干什么 —— 它留在库里（cookie 丢了要靠它重新登录）。
  credentials: keyPlan({
    title: "TokenRhythm API Key",
    slots: () => [
      valueSlot({
        label: "推理 Key",
        form: "api_key",
        id: (account) => `${providerSecretId(account.id, "account")}#api_key`,
        value: (account) => String(tokenRhythmCredentialOf(account.id)?.apiKey ?? ""),
      }),
      // 会话 cookie 只用来登录与查余额：转发要的是那把 api key。它会自己过期
      // 作废，所以读的时候先过平台自己的校验。
      sessionSlot({ load: (accountId) => loadTokenRhythmSession(accountId) }),
    ],
    field: {
      name: "api-key",
      label: "推理 Key",
      hint: "钱包里那把推理用的 key；留空表示清掉它",
      placeholder: "sk-…",
    },
    write: (account, value) => writeTokenRhythmKey(account.id, value),
  }),
  // 明文 key：转发与「问上游要模型目录」要的是同一把，各自去取一遍就是两份知识。
  keyOf: (provider, accountId) => tokenRhythmCredentialOf(accountId ?? provider.id)?.apiKey ?? "",
  credential: (provider) => fromUpstreamStatus(tokenRhythmStatus(provider.id), "session"),
  // 目录是平台那一行说了算：行里的 id 与顺序就是公布的（目录从上游拉）。
  models: (provider) => catalogModelsFromRow(provider, () => []),
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

