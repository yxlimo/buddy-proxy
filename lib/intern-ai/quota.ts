// lib/intern-ai/quota.ts — 两个子站的额度。
//
// Discovery（TokenPlan）的额度单位是「墨点」，不是一个数，是两套东西：
//
//   余额（available_credits）  账号里还剩多少墨点。平台按「一次性 / 按日 /
//                              按月」三种周期发墨点，每一批是一个 credit pack。
//                              一次性的一次发完，到期当天 24:00 清空；按日的
//                              当天有效，次日 24:00 清空；按月的开通当天有效，
//                              之后每个自然月的同一天 24:00 清空（开通日是
//                              几号，就几号清）。
//   窗口（usage_windows）      5 小时和 7 天两个滚动窗口，限制的是「这段
//                              时间里能用多少墨点」，跟批次是两回事。
//
// 所以「还剩多少」要分开报：批次上还剩多少（什么时候过期），窗口里还剩
// 多少（现在能花多少）。真正能花的是两者的较小值。
//
// 墨点怎么算（平台给的公式）：
//
//   消耗墨点 = 缓存命中输入 token ÷ 1e6 × 缓存命中价
//            + 缓存未命中输入 token ÷ 1e6 × 未命中价
//            + 输出 token ÷ 1e6 × 输出价
//
// 价是「墨点 / 百万 token」。墨点跟 token 不是 1:1。
//
// Chat（浦语）没有墨点。它的额度是「agent 模式每天还能问多少次」，是一个
// 次数，不是点数。

import { INTERN_AI_CHAT_BASE, INTERN_AI_DISCOVERY_BASE } from "./config.ts";
import { consoleApi } from "./platform.ts";
import type { InternAiSession } from "./auth.ts";

/** 平台的时间是「本地时间（UTC+8），没有时区」，或者 ISO 串。 */
export type PlatformTime = string;

/** 一个额度窗口（5 小时 / 7 天）。 */
export interface InternAiCreditWindow {
  /** 窗口的名字：5h / 7d。 */
  window: string;
  /** 平台有没有开这个窗口。没开就是不限。 */
  enabled: boolean;
  /** 这个窗口里一共能用多少墨点。 */
  limitCredits: number;
  /** 还剩多少。 */
  remainingCredits: number;
  /** 已经用了多少。 */
  usedCredits: number;
  /** 下一次恢复的时刻。 */
  nextRecoverAt: PlatformTime;
}

/** 一次余额查询的结果。 */
export interface InternAiBalance {
  /** 账号里还剩多少墨点。这是最要紧的一个数。 */
  availableCredits: number;
  /** 当前有批次的墨点包有几个。 */
  activePackageCount: number;
  /** 5 小时窗口。 */
  window5h: InternAiCreditWindow;
  /** 7 天窗口。 */
  window7d: InternAiCreditWindow;
  /** 已经用掉的墨点。 */
  used: number;
  /**
   * 账号能不能用（1 = 能）。
   *
   * null = 平台没报这个字段，不是 0。「没报」和「报了 0」是两件事：没报的时候
   * 说「不知道」，别把「没说」当成「说不行」—— 0 会被当成账号不可用，把整条
   * 路的请求拦死。
   */
  accessStatus: number | null;
  /** 每分钟请求数上限。 */
  rpmLimit: number;
  /** 决策模型单独的 RPM 上限。 */
  decisionRpmLimit: number;
  /** 每分钟 token 上限。 */
  tpmLimit: number;
  /** 算这个数的时候的时刻。 */
  calculatedAt: PlatformTime;
}

/** 一批墨点（一个 credit pack）。 */
export interface InternAiCreditPack {
  id: string;
  /** 发下来的时刻。 */
  issuedAt: PlatformTime;
  /** 周期：once / daily / monthly。 */
  cycleType: string;
  /** 本个周期的起止。 */
  cycleStartAt: PlatformTime;
  cycleEndAt: PlatformTime;
  /** 这一批一共多少墨点。 */
  totalCredits: number;
  /** 还剩多少。 */
  remainingCredits: number;
  /** 状态：pending / unused / available / used_up / expired / voided。 */
  status: string;
  /** 收支类型：platform_grant / consume / admin_delete / expire_clear。 */
  incomeExpenseType: string;
  /** 备注，比如「每月免费基础包」。 */
  remark: string;
  /** 生效时刻。 */
  effectiveAt: PlatformTime;
  /** 到期时刻。 */
  expireAt: PlatformTime;
}

/** 墨点的一笔流水。 */
export interface InternAiTransaction {
  /** 发生的时刻。 */
  occurredAt: PlatformTime;
  /** 变动量：正数是收入，负数是支出。 */
  creditDelta: number;
  /** 收支类型。 */
  incomeExpenseType: string;
  /** 收支类型的中文名。 */
  incomeExpenseTypeName: string;
  /** 落在哪一批上（消费的时候是空的）。 */
  packageId: string;
  /** 哪个模型。 */
  model: string;
  /** 这一笔是几次调用。 */
  requestCount: number;
  /** 备注。 */
  remark: string;
}

/** 一页流水。 */
export interface InternAiTransactionPage {
  items: InternAiTransaction[];
  total: number;
}

/** 一次用量汇总。 */
export interface InternAiUsageSummary {
  /** 账号 id。 */
  ssoUid: string;
  /** 汇总的范围。 */
  startDate: string;
  endDate: string;
  /** 汇总的数。 */
  totalTokens: number;
  requestCount: number;
  /** 花了多少墨点。 */
  consumedCredits: number;
  inputCachedTokens: number;
  inputUncachedTokens: number;
  outputTokens: number;
  /** 按天的明细。 */
  dailyUsage: Array<{
    date: string;
    totalTokens: number;
    requestCount: number;
    consumedCredits: number;
  }>;
}

/** Chat 的 agent 额度。 */
export interface InternAiAgentQuota {
  /** 问的是哪个模型。 */
  modelId: string;
  /** 今天还能问多少次。 */
  remaining: number;
}

/**
 * 数字：平台给的墨点是小数字符串（"1.698000"），别的可能是数字。
 *
 * 墨点能到小数点后六位，所以这里不能用 parseInt，也不能四舍五入到整数。
 */
export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 读一个额度窗口。 */
export function parseCreditWindow(name: string, raw: any): InternAiCreditWindow {
  return {
    window: name,
    enabled: raw?.enabled === true,
    limitCredits: num(raw?.limit_credits),
    remainingCredits: num(raw?.remaining_credits),
    usedCredits: num(raw?.used_credits),
    nextRecoverAt: String(raw?.next_recover_at ?? ""),
  };
}

/**
 * 读一次余额查询。
 *
 * 窗口的 key 是 "5h" 和 "7d"，别的地方写的是 window_5h，这里是平台的原样。
 */
export function parseBalance(body: any): InternAiBalance {
  const windows = body?.usage_windows ?? {};
  return {
    availableCredits: num(body?.available_credits),
    activePackageCount: num(body?.active_package_count),
    window5h: parseCreditWindow("5h", windows["5h"]),
    window7d: parseCreditWindow("7d", windows["7d"]),
    used: num(body?.used),
    accessStatus:
      body?.access_status === undefined || body?.access_status === null
        ? null
        : num(body.access_status),
    rpmLimit: num(body?.rpm_limit),
    decisionRpmLimit: num(body?.decision_rpm_limit),
    tpmLimit: num(body?.tpm_limit),
    calculatedAt: String(body?.calculated_at ?? ""),
  };
}

/** 读一批墨点。 */
export function parseCreditPack(row: any): InternAiCreditPack {
  return {
    id: String(row?.pkg_id ?? ""),
    issuedAt: String(row?.issued_at ?? ""),
    cycleType: String(row?.cycle_type ?? ""),
    cycleStartAt: String(row?.current_cycle?.start_at ?? ""),
    cycleEndAt: String(row?.current_cycle?.end_at ?? ""),
    totalCredits: num(row?.total_credits),
    remainingCredits: num(row?.remaining_credits),
    status: String(row?.status ?? ""),
    incomeExpenseType: String(row?.income_expense_type ?? ""),
    remark: String(row?.remark ?? ""),
    effectiveAt: String(row?.effective_at ?? ""),
    expireAt: String(row?.expire_at ?? ""),
  };
}

/** 读一笔流水。 */
export function parseTransaction(row: any): InternAiTransaction {
  return {
    occurredAt: String(row?.occurred_at ?? ""),
    creditDelta: num(row?.credit_delta),
    incomeExpenseType: String(row?.income_expense_type ?? ""),
    incomeExpenseTypeName: String(row?.income_expense_type_name ?? ""),
    packageId: String(row?.pkg_id ?? ""),
    model: String(row?.model ?? ""),
    requestCount: num(row?.request_count),
    remark: String(row?.remark ?? ""),
  };
}

/** 读一页流水。 */
export function parseTransactionPage(body: any): InternAiTransactionPage {
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
  return {
    items: items.map(parseTransaction),
    total: num(body?.total ?? items.length),
  };
}

/** 读一次用量汇总。 */
export function parseUsageSummary(body: any): InternAiUsageSummary {
  const summary = body?.summary ?? {};
  const daily = Array.isArray(body?.daily_usage) ? body.daily_usage : [];
  return {
    ssoUid: String(body?.sso_uid ?? ""),
    startDate: String(body?.start_date ?? ""),
    endDate: String(body?.end_date ?? ""),
    totalTokens: num(summary.total_tokens),
    requestCount: num(summary.request_count),
    consumedCredits: num(summary.consumed_credits),
    inputCachedTokens: num(summary.input_cached_tokens),
    inputUncachedTokens: num(summary.input_uncached_tokens),
    outputTokens: num(summary.output_tokens),
    dailyUsage: daily.map((row: any) => ({
      date: String(row?.date ?? ""),
      totalTokens: num(row?.total_tokens),
      requestCount: num(row?.request_count),
      consumedCredits: num(row?.consumed_credits),
    })),
  };
}

/** 查一次余额（墨点还剩多少）。 */
export async function balance(session: InternAiSession, token: string): Promise<InternAiBalance> {
  const data = await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    "/api/tokenplan/v1/credits/balance",
    session,
    token,
  );
  return parseBalance(data);
}

/** 查墨点批次（哪几批，什么时候过期）。 */
export async function creditPacks(
  session: InternAiSession,
  token: string,
  query: Record<string, string | number | undefined> = {},
): Promise<InternAiCreditPack[]> {
  const data = await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    "/api/tokenplan/v1/credits/packages",
    session,
    token,
    { query },
  );
  const rows = Array.isArray(data?.packages) ? data.packages : Array.isArray(data) ? data : [];
  return rows.map(parseCreditPack);
}

/** 查墨点流水。 */
export async function transactions(
  session: InternAiSession,
  token: string,
  query: Record<string, string | number | undefined> = {},
): Promise<InternAiTransactionPage> {
  const data = await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    "/api/tokenplan/v1/credits/transactions",
    session,
    token,
    { query },
  );
  return parseTransactionPage(data);
}

/**
 * 查用量汇总。
 *
 * 日期必须给：不给的话平台回 400 `field "start_date" is not set`。
 */
export async function usageSummary(
  session: InternAiSession,
  token: string,
  query: { start_date: string; end_date: string; model?: string },
): Promise<InternAiUsageSummary> {
  const data = await consoleApi<any>(
    INTERN_AI_DISCOVERY_BASE,
    "/api/tokenplan/v1/usage/summary",
    session,
    token,
    { query: { ...query, model: query.model ?? "all" } },
  );
  return parseUsageSummary(data);
}

/** 查 Chat 的 agent 每日额度。 */
export async function agentQuota(
  session: InternAiSession,
  token: string,
  modelId: string,
): Promise<InternAiAgentQuota> {
  const data = await consoleApi<any>(INTERN_AI_CHAT_BASE, "/puyu/agent/quota", session, token, {
    query: { model_id: modelId },
  });
  return { modelId, remaining: num(data?.remaining) };
}

/**
 * 现在能花多少墨点。
 *
 * 批次管的是「这些墨点什么时候过期」，窗口管的是「这段时间里能用多少」。
 * 两个都得满足，所以取小的。
 */
export function usableCredits(balance: InternAiBalance, packs: InternAiCreditPack[]): number {
  const limits: number[] = [balance.availableCredits];
  for (const w of [balance.window5h, balance.window7d]) {
    if (w.enabled) limits.push(w.remainingCredits);
  }
  const fromWindows = Math.min(...limits);
  // 批次是另一道闸：过期的批次不算数。
  const fromPacks = packs
    .filter((p) => p.status === "available" || p.status === "unused")
    .reduce((sum, p) => sum + p.remainingCredits, 0);
  if (!packs.length) return fromWindows;
  return Math.min(fromWindows, fromPacks);
}

/** 批次是不是已经不能用了。 */
export function packExpired(pack: InternAiCreditPack): boolean {
  if (pack.status === "expired" || pack.status === "voided" || pack.status === "used_up") return true;
  return false;
}

/** 一个模型的价格（墨点 / 百万 token）。 */
export interface InternAiPrice {
  /** 缓存命中的输入价。 */
  cachedInputPerMillion: number;
  /** 缓存没命中的输入价。 */
  inputPerMillion: number;
  /** 输出价。 */
  outputPerMillion: number;
}

/** 一次调用的用量。 */
export interface InternAiUsage {
  /** 缓存命中的输入 token。 */
  cachedInputTokens: number;
  /** 缓存没命中的输入 token。 */
  inputTokens: number;
  /** 输出 token。 */
  outputTokens: number;
}

/**
 * 算一次调用要花多少墨点。
 *
 * 平台给的公式，逐字照抄。参数单位是「墨点 / 百万 token」，所以 token 要
 * 先除以一百万。
 *
 * 平台的分流规则：无法区分缓存命中与未命中时，输入 token 全按未命中算。
 */
export function estimateInkPoints(price: InternAiPrice, usage: InternAiUsage): number {
  return (
    (usage.cachedInputTokens / 1_000_000) * price.cachedInputPerMillion +
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion
  );
}

/**
 * 已知模型的墨点价（平台 2026-10 的公开清单）。
 *
 * 限时免费的几个是 0。价会调，所以这份表只是「现在长这样」，真扣多少以调用
 * 当时生效的价格为准。
 */
export const INTERN_AI_MODEL_PRICES: Record<string, InternAiPrice> = {
  "intern-s2": { cachedInputPerMillion: 0, inputPerMillion: 0, outputPerMillion: 0 },
  "Atria-Dawn": { cachedInputPerMillion: 0, inputPerMillion: 0, outputPerMillion: 0 },
  "Agents-A1": { cachedInputPerMillion: 0, inputPerMillion: 0, outputPerMillion: 0 },
  "Sage-A1.5": { cachedInputPerMillion: 0, inputPerMillion: 0, outputPerMillion: 0 },
  "deepseek-v4-flash-0731": { cachedInputPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 4 },
  "deepseek-v4-flash-vision": { cachedInputPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 4 },
  "deepseek-v4-pro-0813": { cachedInputPerMillion: 0.15, inputPerMillion: 4.5, outputPerMillion: 13.5 },
  "glm-5.3": { cachedInputPerMillion: 2, inputPerMillion: 8, outputPerMillion: 28 },
  "kimi-k2.6": { cachedInputPerMillion: 1.1, inputPerMillion: 6.5, outputPerMillion: 27 },
  "minimax-m3": { cachedInputPerMillion: 0.42, inputPerMillion: 2.1, outputPerMillion: 8.4 },
  "qwen3.8-27b": { cachedInputPerMillion: 0.1, inputPerMillion: 0.8, outputPerMillion: 2.7 },
  // 决策模型没有缓存维度，输入全按未命中算，输出不计费。
  "intern-decision-4b": { cachedInputPerMillion: 0, inputPerMillion: 0.2, outputPerMillion: 0 },
};
