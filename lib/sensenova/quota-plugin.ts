// lib/sensenova/quota-plugin.ts — SenseNova 的积分池做成一个额度插件。
//
// 问额度的人和用额度的人不是同一处：池子在控制台上，控制台只认登录态（账号密码
// 换来的会话），推理用的那把 key 在那边没有用。所以这个插件只做一件事：拿会话去
// 问一次 pool-usage，把答复或者异常翻成一个结论。
//
// 翻不成的一律归到 unknown：问不到不等于没钱，这两件事在面板上是不同的两行。
// 所以 probe 从不 reject。
//
// 这个插件不要任何额外的凭据段（fields 是空的）：查额度用的就是登录换来的会话，
// 用户不必再填第二个东西。会话不在 —— 那是「还没登录」，翻成 missing。

import type { QuotaView, CreditLotView } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { quotaProbe } from "../quota-state.ts";
import { quotaEndpointBase, registerQuotaPlugin, type QuotaProbe } from "../quota-plugins.ts";
import { SENSENOVA_PLATFORM_BASE } from "./config.ts";
// 插件 id 住在一个没有依赖的地方（lib/sensenova/quota-plugin-id.ts）：本模块与
// register 互相引用，id 若在本模块里，register 在求值期读它就会撞上「还在初始化」。
import { SENSE_NOVA_POOLS_PLUGIN_ID } from "./quota-plugin-id.ts";
export { SENSE_NOVA_POOLS_PLUGIN_ID };
import { loadSession, SenseNovaError } from "./auth.ts";
import { poolUsage, totalRemaining, type SenseNovaPool, type SenseNovaPoolUsage } from "./quota.ts";

/**
 * 能服务模型的池子才算数。
 *
 * 没有模型挂在它上面的池子扣不到：它在控制台上摆着，但任何一次调用都不会走到
 * 它那儿，报出来只会让人以为还有额度。
 */
export function servablePools(usage: SenseNovaPoolUsage | null): SenseNovaPool[] {
  return (usage?.pools ?? []).filter((pool) => pool.modelIds.length > 0);
}

/**
 * 池子报成额度：活动积分是积分，周期积分按两个窗口报成套餐额度。
 *
 * 从 lib/sensenova/register.ts 原样搬过来，一个数字都没动：迁移不许改口径。
 * 池子里有两种都叫「积分」的东西，不是一回事：
 *
 *   活动积分（grant_balance）  兑换码、活动发的，到账后 30 天到期 → 积分
 *   周期积分（window_5h/7d）  滚动窗口里的额度，5 小时重置 → 套餐额度
 */
export function senseNovaPoolsViews(provider: ProviderRow, usage: SenseNovaPoolUsage | null): QuotaView[] {
  if (!usage?.pools?.length) return [];
  const pools = servablePools(usage);
  if (!pools.length) return [];
  const lots: CreditLotView[] = pools
    .filter((pool) => pool.grantBalance > 0)
    .map((pool) => ({
      id: pool.id,
      sourceLabel: `${pool.name || pool.id} · 30 天到期`,
      remaining: pool.grantBalance,
      expiresAt: pool.nearestGrantExpiry ? pool.nearestGrantExpiry * 1000 : 0,
      status: pool.grantBalance > 0 ? "可用" : "已用尽",
    }));
  const remaining = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const windows = pools.map((pool) => ({
    label: pool.name || pool.id,
    intervalPercent: windowPercent(pool.window5h),
    weeklyPercent: windowPercent(pool.window7d),
    intervalEndsAt: pool.window5h.resetAt ? pool.window5h.resetAt * 1000 : 0,
    weeklyEndsAt: pool.window7d.resetAt ? pool.window7d.resetAt * 1000 : 0,
  }));
  const plan = usage.plan?.name ? `${usage.plan.name}：` : "";
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        // 平台不报活动积分的总额与已用，只报还剩多少。
        total: 0,
        used: 0,
        remaining,
        lots,
        note: `${plan}活动积分 30 天到期；周期积分按 5 小时与 7 天窗口另算`,
      },
      ...(windows.length ? { tokenPlan: { windows } } : {}),
    },
  ];
}

/** 一个滚动窗口里还剩百分之多少。 */
function windowPercent(window: { limit: number; remaining: number }): number {
  if (!window.limit || window.limit <= 0) return 0;
  return Math.round((window.remaining / window.limit) * 100);
}

/**
 * 见底之后什么时候回来。
 *
 * 滚动窗口什么时候重置：见底的窗口先算（与 MiniMax 同一套取舍），没有见底的
 * 窗口就退回最早的那个重置点。与 lib/sensenova/register.ts 的那一份逐字相同。
 */
export function senseNovaRecoverAt(usage: SenseNovaPoolUsage | null): number | null {
  const pools = servablePools(usage);
  if (!pools.length) return null;
  const now = Date.now();
  let exhausted: number | null = null;
  let soonest: number | null = null;
  for (const pool of pools) {
    for (const window of [pool.window5h, pool.window7d]) {
      const at = window.resetAt ? window.resetAt * 1000 : 0;
      if (!at || at <= now) continue;
      if (soonest === null || at < soonest) soonest = at;
      if (window.limit > 0 && window.remaining <= 0) {
        if (exhausted === null || at > exhausted) exhausted = at;
      }
    }
  }
  return exhausted ?? soonest;
}

export const senseNovaPoolsPlugin = registerQuotaPlugin({
  id: SENSE_NOVA_POOLS_PLUGIN_ID,
  label: "SenseNova 资源池",
  fields: [],
  probe: async (account) => {
    // 没有会话：用户还没登录。那不是控制台拒了什么，是没人去问。
    const session = loadSession(account.id);
    if (!session) return quotaProbe("missing", "账号上没有控制台会话，无法查询积分池");

    let usage: SenseNovaPoolUsage;
    // 积分池在控制台上；平台行把地址指到别处时问那一台。
    const endpointBase = quotaEndpointBase(account, SENSENOVA_PLATFORM_BASE);
    try {
      usage = await poolUsage(session, endpointBase);
    } catch (e) {
      return stateOfError(e);
    }

    const pools = servablePools(usage);
    const grantTotal = pools.reduce((sum, pool) => sum + pool.grantBalance, 0);
    // 所有能服务模型的池子都扣不动了，才是「用尽」：还有一个池子剩着，请求就还能
    // 走到那个池子上去。
    if (pools.length && pools.every((pool) => totalRemaining(pool) <= 0)) {
      return quotaProbe("no_quota", `积分池全部用尽：${pools.length} 个池子均无可用额度`, {
        recoverAt: senseNovaRecoverAt(usage),
      });
    }
    return quotaProbe("ok", `积分池 ${pools.length} 个，活动积分剩余 ${grantTotal}`, {
      views: senseNovaPoolsViews(account, usage),
    });
  },
});

/**
 * 抛出来的东西翻成状态。
 *
 * 控制台的错误已经分好类了（lib/sensenova/auth.ts 的 classify），这里只做翻译：
 * 会话没了与没权限都是「凭据被拒」，限流是「等一会儿」，其余都是「问不到」——
 * 而问不到的那句话里要写清是哪一种，不然日志里只剩一句「失败了」。
 */
function stateOfError(error: unknown): QuotaProbe {
  if (error instanceof SenseNovaError) {
    if (error.kind === "auth" || error.kind === "forbidden") {
      return quotaProbe("unauthorized", error.message);
    }
    if (error.kind === "rate") {
      // 上游说了多久之后再来就用它；没说，平台按自己的默认时长冷却。
      return quotaProbe("rate_limited", error.message, {
        recoverAt: error.retryAfterMs === null ? null : Date.now() + error.retryAfterMs,
      });
    }
    return quotaProbe("unknown", `控制台没有返回结果：${error.message}`);
  }
  return quotaProbe("unknown", `查询额度时抛出异常：${describeThrow(error)}`);
}

/** 一句人类能读的「抛了什么」。 */
function describeThrow(error: unknown): string {
  if (error instanceof Error) {
    // 超时与网络错误都没有状态码：说清楚是这一种，别让它看着像上游拒了。
    if (error.name === "TimeoutError" || error.name === "AbortError") return `等控制台超时（${error.message}）`;
    if (error.name === "TypeError") return `连不上控制台（${error.message}）`;
    return `${error.name}：${error.message}`;
  }
  return String(error);
}
