// lib/sensenova/quota.ts — 积分池：账号还剩多少，以及一次调用会先扣哪个池。
//
// SenseNova 的额度不是一坨数字，是几个互不相通的池子。
//
// 套餐（plan）决定有没有额度：控制台上是 Free 公测版，plan.type =
// TOKEN_PLAN_PLAN_TYPE_FREE。
//
// 池子（pool）分两类，接口用 pool_type 区分：
//
//   default    通用积分池。套餐里所有模型都能用。
//   dedicated  专属积分池。只给某几个模型用（现在是 Flash-Lite 系列）。
//
// 池子里的积分又分两种，接口用不同字段表示：
//
//   周期积分（rolling）  window_5h / window_7d 两个滚动窗口里的余额
//   活动固定积分（grant） grant_balance，兑换码、活动发的那种，到账后 30 天有效
//
// 扣减顺序是平台定的，控制台上写得很清楚：
//
//   Flash-lite 模型：专属池周期 → 通用池周期 → 通用池活动固定
//   其他模型：       通用池周期 → 通用池活动固定
//
// 还有一个窗口约束：所有消耗都受各池 5 小时窗口的额度限制。某个池在窗口
// 里用满了，这个池就停下来扣，顺序自动往下一个池走。
//
// 所以「还剩多少」要分开看：周期积分看两个窗口的较小值，活动积分单独算。

import { consoleApi } from "./platform.ts";
import type { SenseNovaSession } from "./auth.ts";

/** 一个滚动窗口。 */
export interface SenseNovaWindow {
  limit: number;
  used: number;
  remaining: number;
  /** 窗口重置的时刻，unix 秒。 */
  resetAt: number;
}

/** 池子的种类。 */
export type SenseNovaPoolKind = "general" | "dedicated" | "other";

/** 一个积分池。 */
export interface SenseNovaPool {
  id: string;
  name: string;
  kind: SenseNovaPoolKind;
  /** 接口给的原始 pool_type，别丢——以后冒出新种类时能对上。 */
  poolType: string;
  /** 这个池子覆盖的模型。 */
  modelIds: string[];
  window5h: SenseNovaWindow;
  window7d: SenseNovaWindow;
  /** 活动固定积分的可用余额。 */
  grantBalance: number;
  /** 最近一次到期的时刻，unix 秒；0 表示没有。 */
  nearestGrantExpiry: number;
  /** 最近一次到期的那部分余额。 */
  nearestGrantExpiringBalance: number;
}

/** 套餐。 */
export interface SenseNovaPlan {
  id: string;
  name: string;
  /** 例如 TOKEN_PLAN_PLAN_TYPE_FREE。 */
  type: string;
}

/** 一次额度查询的结果。 */
export interface SenseNovaPoolUsage {
  plan: SenseNovaPlan;
  pools: SenseNovaPool[];
}

/** 扣减顺序里的一步：先扣哪个池的哪种积分。 */
export interface DeductionStep {
  pool: SenseNovaPool;
  /** rolling = 周期积分，grant = 活动固定积分。 */
  credit: "rolling" | "grant";
}

/** pool_type 的值翻译成种类。认不出来的先归到 other，别乱猜。 */
export function classifyPoolType(poolType: string): SenseNovaPoolKind {
  if (poolType === "dedicated") return "dedicated";
  if (poolType === "default") return "general";
  return "other";
}

/** 数字：平台给的都是字符串，坏的当 0。 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 读一个滚动窗口。 */
function parseWindow(raw: any): SenseNovaWindow {
  return {
    limit: num(raw?.limit),
    used: num(raw?.used),
    remaining: num(raw?.remaining),
    resetAt: num(raw?.reset_at),
  };
}

/** 读一个池子。 */
export function parsePool(raw: any): SenseNovaPool {
  const poolType = String(raw?.pool_type ?? "");
  return {
    id: String(raw?.id ?? ""),
    name: String(raw?.name ?? ""),
    kind: classifyPoolType(poolType),
    poolType,
    modelIds: Array.isArray(raw?.model_ids) ? raw.model_ids.map((m: unknown) => String(m)) : [],
    window5h: parseWindow(raw?.window_5h),
    window7d: parseWindow(raw?.window_7d),
    grantBalance: num(raw?.grant_balance),
    nearestGrantExpiry: num(raw?.nearest_grant_expiry),
    nearestGrantExpiringBalance: num(raw?.nearest_grant_expiring_balance),
  };
}

/** 读一次额度查询。 */
export function parsePoolUsage(body: any): SenseNovaPoolUsage {
  const pools = Array.isArray(body?.pools) ? body.pools : [];
  return {
    plan: {
      id: String(body?.plan?.id ?? ""),
      name: String(body?.plan?.name ?? ""),
      type: String(body?.plan?.type ?? ""),
    },
    pools: pools.map(parsePool),
  };
}

/**
 * 周期积分还剩多少。
 *
 * 周期积分同时受 5 小时和 7 天两个窗口管着，所以能用的是小的那个。
 */
export function rollingRemaining(pool: SenseNovaPool): number {
  return Math.min(pool.window5h.remaining, pool.window7d.remaining);
}

/** 这个池子里一共还剩多少（周期 + 活动）。 */
export function totalRemaining(pool: SenseNovaPool): number {
  return rollingRemaining(pool) + pool.grantBalance;
}

/**
 * 这个池子还能不能扣。
 *
 * 5 小时窗口用满了，池子就停下来扣，顺序自动往下一个池走。
 */
export function poolPaused(pool: SenseNovaPool): boolean {
  return pool.window5h.remaining <= 0;
}

/** 池子里的钱是不是全用完了。 */
export function poolEmpty(pool: SenseNovaPool): boolean {
  return rollingRemaining(pool) <= 0 && pool.grantBalance <= 0;
}

/**
 * 一个模型先扣哪个池。
 *
 * 专属池里的模型（现在是 Flash-Lite 系列）先扣专属池；其他的只扣通用池。
 */
export function poolForModel(pools: SenseNovaPool[], modelId: string): SenseNovaPool | null {
  const dedicated = pools.find((p) => p.kind === "dedicated" && p.modelIds.includes(modelId));
  if (dedicated) return dedicated;
  const general = pools.find((p) => p.kind === "general" && p.modelIds.includes(modelId));
  return general ?? null;
}

/**
 * 一个模型的扣减顺序。
 *
 * 平台上的规则：Flash-lite 专属池周期 → 通用池周期 → 通用池活动固定；
 * 其他模型只有通用池周期 → 通用池活动固定。
 *
 * 池子不在套餐覆盖范围里时，顺序是空的：这个模型不归积分池管。
 */
export function deductionOrder(pools: SenseNovaPool[], modelId: string): DeductionStep[] {
  const steps: DeductionStep[] = [];
  const dedicated = pools.find((p) => p.kind === "dedicated" && p.modelIds.includes(modelId));
  if (dedicated) steps.push({ pool: dedicated, credit: "rolling" });

  const general = pools.find((p) => p.kind === "general" && p.modelIds.includes(modelId));
  if (general) {
    steps.push({ pool: general, credit: "rolling" });
    steps.push({ pool: general, credit: "grant" });
  }
  return steps;
}

/**
 * 顺序里第一个还扣得动的池子。
 *
 * 池子用满了（5 小时窗口见底）就跳到下一个，顺序是平台定的，这里只是
 * 照着算一遍，让调用方能提前知道会走哪一池。
 */
export function nextUsableStep(steps: DeductionStep[]): DeductionStep | null {
  for (const step of steps) {
    if (step.credit === "grant") {
      if (step.pool.grantBalance > 0) return step;
      continue;
    }
    if (poolPaused(step.pool)) continue;
    if (rollingRemaining(step.pool) > 0) return step;
  }
  return null;
}

/** 所有池子里的模型，去重。 */
export function modelIdsOf(pools: SenseNovaPool[]): string[] {
  const seen = new Set<string>();
  for (const pool of pools) {
    for (const id of pool.modelIds) seen.add(id);
  }
  return [...seen];
}

/** 查一次额度。 */
export async function poolUsage(session: SenseNovaSession): Promise<SenseNovaPoolUsage> {
  const body = await consoleApi<any>("/console/v1/tokenplan/pool-usage", session);
  return parsePoolUsage(body);
}

/** 池子的简况，给面板和日志用。 */
export interface SenseNovaPoolSummary {
  id: string;
  name: string;
  kind: SenseNovaPoolKind;
  poolType: string;
  models: number;
  rollingRemaining: number;
  grantBalance: number;
  totalRemaining: number;
  paused: boolean;
  empty: boolean;
  reset5hAt: number;
  reset7dAt: number;
  nearestGrantExpiry: number;
}

/** 把一次额度查询压成几行摘要。 */
export function summarize(usage: SenseNovaPoolUsage): SenseNovaPoolSummary[] {
  return usage.pools.map((pool) => ({
    id: pool.id,
    name: pool.name,
    kind: pool.kind,
    poolType: pool.poolType,
    models: pool.modelIds.length,
    rollingRemaining: rollingRemaining(pool),
    grantBalance: pool.grantBalance,
    totalRemaining: totalRemaining(pool),
    paused: poolPaused(pool),
    empty: poolEmpty(pool),
    reset5hAt: pool.window5h.resetAt,
    reset7dAt: pool.window7d.resetAt,
    nearestGrantExpiry: pool.nearestGrantExpiry,
  }));
}
