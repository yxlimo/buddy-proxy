// lib/quota-plugins.ts — 「这个平台的额度怎么问」的插件注册表。
//
// 额度这件事一直散在两处：抓取在 lib/admin/upstreams.ts 的
// refreshHealthSnapshot() 里按平台写死一长串 if，读成面板视图在各
// lib/kinds/*.ts 的 quotas() 里。开放平台（用户在面板上加的那些平台）进不了这条
// 链 —— 它是数据，不是代码。
//
// 做成插件之后，插件只回答一件事：问一次上游，把答复或异常翻成一个结论
// （probe）。结论怎么处理（写冷却、算不算见底、什么时候恢复）是平台的事，写在
// lib/quota-state.ts 一处 —— 插件里再各写一遍，就会有七份不一样的判断。
// 开放平台只要在 platform.quota_plugin 里填插件 id。
//
// 插件的登记是模块求值期的副作用：每个平台在自己的模块里 import 自己的插件
// 文件，登记就发生了。启动时的校验（assertQuotaPlugins）必须等这些副作用跑完
// —— 它在 router-proxy.ts 里，assertLoginFlows() 旁边，app.listen 之前。

import type { QuotaView } from "./provider-kinds.ts";
import { kindOf } from "./provider-kinds.ts";
import type { ProviderRow } from "./providers.ts";
import { listOpenPlatforms, openPlatformOf } from "./open-platforms.ts";
import type { QuotaState } from "./quota-state.ts";

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
 * 两个地址是不是「同一台同一段」。
 *
 * 走 URL 解析，比的是解析后的 origin 与 pathname，不是原文：大小写、默认端口这些
 * 差异由标准库归一。地址写进库里的时候已经去过尾部斜杠（lib/open-platforms.ts 的
 * normalizeBaseUrl），这边不再自己裁。
 */
function sameBase(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    // 不是完整网址：认不出「同一台」，只好按原文比。
    return a === b;
  }
}

/**
 * 额度请求该打哪台：平台行指向了别处就用它，否则用插件自己那台。
 *
 * 各平台的额度接口地址是代码里的常量（门户、控制台、钱包）。平台行上写的却是
 * 「这个平台在跟谁说话」—— 用户把地址指到别处（自建端点、自测端点）时，额度
 * 也该问同一台，否则那个平台的额度永远问不到，自测只能靠改写主机名绕过去。
 *
 * 「默认那台」由适配器自己说（ProviderKind.defaultBaseUrl）：行上的地址还等于
 * 它时，额度问插件自己那台 —— 那一格说的是这一类平台默认指哪台，不是平台清单。
 *
 * 返回的是行上那个地址原文：路径怎么拼是调用方的事（`new URL(路径, 它)`）。
 */
export function quotaEndpointBase(account: ProviderRow, vendorBase: string): string {
  const row = openPlatformOf(account.platform);
  if (!row) return vendorBase;
  const base = String(row.baseUrl ?? "").trim();
  if (!base) return vendorBase;
  // 认不出这一类（或者它没有默认地址，比如开放平台的 openai）：行上写的那个
  // 地址就是用户要的地址。
  const kind = account.kind || row.kind;
  const defaultBase = kindOf(kind)?.defaultBaseUrl ?? "";
  if (!defaultBase) {
    // 这一类没有默认地址，额度只能问行上那台 —— 插件自己那台（门户、控制台）
    // 问不到。说一声：额度请求打到了推理端点时，这里是唯一说得清为什么的地方。
    warnNoDefaultBase(kind);
    return base;
  }
  if (sameBase(base, defaultBase)) return vendorBase;
  return base;
}

/** 已经说过「这一类没有默认地址」的那些 kind：一个进程只说一次。 */
const warnedNoDefaultBase = new Set<string>();

/**
 * 这一类没有默认地址：额度按行上的地址问。
 *
 * 静默降级会让人以为额度问的是门户，其实是推理端点 —— 问回来的多半是错误页，
 * 面板上就成了「额度未知」。说一句就够，不必每次问都刷。
 */
function warnNoDefaultBase(kind: string): void {
  const id = String(kind ?? "").trim();
  if (!id || warnedNoDefaultBase.has(id)) return;
  warnedNoDefaultBase.add(id);
  console.warn(`[QUOTA] 这一类没有默认地址，额度按行上的地址问：${id}`);
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

/**
 * 已经报过「这个平台的额度插件没登记」的那些。
 *
 * 一个平台的这个插件说一次：这句话是配置错误，不该跟着启动的次数刷屏，也
 * 不能把真正的故障淹掉。
 */
const warnedUnknownPlugins = new Set<string>();

/**
 * 这个平台填的额度插件没登记就说一声。
 *
 * 只在读旧数据时用：写路径（lib/open-platforms.ts 的 createOpenPlatform /
 * updateOpenPlatform）现在直接拒绝没登记的 id，新数据进不了库。旧库里可能还
 * 有以前存下的这种行（那时只 warn、照样写），启动校验替它们说一句。
 *
 * 一个 id 一个进程只说一次。
 */
export function warnUnknownQuotaPlugin(platformId: string, pluginId: string): void {
  const id = String(pluginId ?? "").trim();
  if (!id) return;
  if (PLUGINS.has(id)) return;
  const key = `${platformId}:${id}`;
  if (warnedUnknownPlugins.has(key)) return;
  warnedUnknownPlugins.add(key);
  console.warn(`[QUOTA] 这个平台填的额度插件没登记：${id}（平台 ${platformId}）`);
}

/**
 * 启动校验：在用的额度插件 id 都得在登记表里。
 *
 * 它只 warn，从不抛。开放平台的插件 id 是用户填的，填错不该让谁的服务都起不来
 * —— 与 assertLoginFlows() 相反：那边缺的一定是代码写错了，这边缺的只是有人
 * 打错了一个字。
 *
 * 模板平台的那一半（要么有插件、要么显式声明「没有额度接口」）这一轮不查：八条
 * 具名桶还没搬完，查下去必然列出一串已知缺着的平台，那是噪音，不是故障。等搬
 * 完再查，那时缺了才真的有信息量。
 */
export function assertQuotaPlugins(): void {
  // 表里的开放平台：插件 id 是用户填的，配不上就是填错了。
  let rows: { id: string; quotaPlugin: string }[] = [];
  try {
    rows = listOpenPlatforms();
  } catch (e) {
    // 库读不出来在别处是硬失败；这里只是校验，警告一句就够了。
    console.warn(`[QUOTA] 平台表读不出来，额度插件没校验：${(e as Error)?.message}`);
  }
  for (const row of rows) {
    warnUnknownQuotaPlugin(row.id, row.quotaPlugin.trim());
  }
}
