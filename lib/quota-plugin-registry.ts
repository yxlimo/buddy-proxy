// lib/quota-plugin-registry.ts — 额度插件登记表的那张 map。
//
// 单独成叶是有原因的：插件模块在自己的求值期就登记（import 即登记），而
// lib/quota-plugins.ts 作为集中登记点反过来 import 各家插件 —— 这是一张环。
// 环里谁先求值不一定，`const PLUGINS = new Map()` 若住在这张环上，先到的登记
// 就会撞上 TDZ（实测如此）。map 与登记函数没有任何依赖，放在环外最浅处，谁先
// 谁后都拿得到。
//
// 这个文件不做别的：登记表只有一张 map 与三个函数。读「这个平台怎么问额度」
// 的其余部分在 lib/quota-plugins.ts。

import type { QuotaState } from "./quota-state.ts";
import type { QuotaView } from "./provider-kinds.ts";
import type { ProviderRow } from "./providers.ts";

/** 面板按它渲染的一个输入框。 */
export interface QuotaField {
  /** 凭据里的那一段叫什么。 */
  name: string;
  /** 面板上给人看的名字。 */
  label: string;
  /** 面板上要遮起来显示。 */
  secret: boolean;
}

/** 插件问一次上游的结果。 */
export interface QuotaProbe {
  state: QuotaState;
  /** 面板上显示的那几行（余额/积分/套餐）。没有就是空数组。 */
  views: QuotaView[];
  /** 什么时候恢复（毫秒）；不知道就是 null。 */
  recoverAt: number | null;
  /** 给人看的一句话（日志与面板提示）。不要放凭据。 */
  message: string;
}

/**
 * 一个额度插件：问一次上游，把答复或异常翻成一个结论。
 *
 * 插件只做翻译：上游说了什么（见底了、账号停用了、凭据被拒、限流了），或者什么
 * 也没说出来（网络、解析）。结论怎么处理由平台统一做，插件不判「能不能接」。
 */
export interface QuotaPlugin {
  /** 插件 id：写进 platform.quota_plugin 的那个字符串。 */
  id: string;
  /** 面板上给人看的名字。 */
  label: string;
  /** 查额度要哪些凭据。 */
  fields: QuotaField[];
  /** 去问一次，把答复或异常翻成状态。不许 reject：翻不动的都归到 unknown。 */
  probe(account: ProviderRow): Promise<QuotaProbe>;
}

/**
 * 额度插件 id → 那家平台原来的推理地址。
 *
 * 厂商 kind 退场时，迁移把这几台地址写进了存量平台行（lib/store.ts 的
 * LEGACY_VENDOR_KINDS）。写在行里不代表用户指到了别处：那是我们自己写进去的
 * 默认值，不是用户的信号 —— 这是判据的全部理由。额度插件问的门户/控制台在
 * 另一台机器上，行上的地址只是推理地址；行上地址还等于原推理地址时，额度问
 * 插件自己那台，不问推理主机。
 *
 * 判据按插件 id（行上的 quota_plugin），不按 kind：厂商 kind 已经不存在了，
 * 迁移后行上是 `openai`，稳定身份只剩插件 id。
 *
 * 用户真的把 base_url 改成别的地址时，这条不命中 —— 额度跟着行上地址走
 * （lib/quota-plugins.ts 的 quotaEndpointBase），那个设计意图不在这里被砍掉。
 *
 * 叶模块：谁都许引它，它不许引 store/router —— 引用即登记的环已经踩过一次。
 */
export const VENDOR_INFERENCE_BASES: Readonly<Record<string, string>> = {
  "qiniu": "https://api.qnaigc.com/v1",
  "sensenova-pools": "https://token.sensenova.cn/v1",
  "intern-ai-credits": "https://discovery-api.intern-ai.org.cn/v1",
  "tokenrhythm-wallet": "https://tokenrhythm.studio/v1",
};

const PLUGINS = new Map<string, QuotaPlugin>();

/**
 * 登记一个插件。
 *
 * 同一个 id 注册两次直接抛：那是代码写错了，不是运行时的状况。两个插件抢一个
 * id，「用的是哪一个」就没答案了，面板上会把一个平台的数字挂在另一个平台名下。
 */
export function registerQuotaPlugin(plugin: QuotaPlugin): QuotaPlugin {
  if (PLUGINS.has(plugin.id)) {
    throw new Error(`额度插件 ${plugin.id} 注册了两次`);
  }
  PLUGINS.set(plugin.id, plugin);
  return plugin;
}

/** 这个 id 的插件；没登记就是 null。 */
export function quotaPluginOf(id: string): QuotaPlugin | null {
  return PLUGINS.get(id) ?? null;
}

/** 登记过的全部插件。 */
export function allQuotaPlugins(): QuotaPlugin[] {
  return [...PLUGINS.values()];
}

/**
 * 「这个平台没有额度接口」的声明。
 *
 * 理由留着：「这个平台没有额度」与「还没顾上搬」是两回事，只有前者是决定。
 */
const NO_PLUGINS = new Map<string, string>();

/**
 * 显式声明这个平台没有额度接口。
 *
 * 不声明的话，启动校验分不出「没搬」与「没人问」—— 沉默的平台看着像漏了。
 */
export function declareNoQuotaPlugin(id: string, reason: string): void {
  NO_PLUGINS.set(id, reason);
}

/** 这个平台为什么没有额度插件；没声明过就是 null。 */
export function noQuotaPluginReason(id: string): string | null {
  return NO_PLUGINS.get(id) ?? null;
}
