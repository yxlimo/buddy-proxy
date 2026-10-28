// lib/sensenova/register.ts — what SenseNova is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of "SenseNova" is its address, its key and its quota pools.

import { senseNovaCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  type CreditLotView,
  type HealthSnapshot,
  type QuotaView,
} from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { senseNovaStatus } from "./auth.ts";
import { SENSENOVA_INFER_BASE } from "./config.ts";
import { totalRemaining, type SenseNovaPoolUsage } from "./quota.ts";
import { senseNovaCatalog, senseNovaInferenceKey } from "./transport.ts";

function senseNovaQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const usage = snapshot.sensenova?.[provider.id]?.pools as SenseNovaPoolUsage | null;
  if (!usage?.pools?.length) return [];
  // 能服务模型的池子才算数：没有模型挂在它上面的池子，扣不到。
  const pools = usage.pools.filter((pool) => pool.modelIds.length > 0);
  if (!pools.length) return [];
  // 池子里有两种都叫「积分」的东西，不是一回事：
  //
  //   活动积分（grant_balance）  兑换码、活动发的，到账后 30 天到期 → 积分
  //   周期积分（window_5h/7d）  滚动窗口里的额度，5 小时重置 → 套餐额度
  //
  // 所以积分只报活动积分，周期积分按窗口的百分比报成套餐额度。
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

export const senseNovaKind = registerCompatiblePlatform({
  kind: "sensenova",
  label: "SenseNova",
  // 上游报错时那句提示里名字后面留一个空格，与改之前一字不差。
  what: "SenseNova ",
  login: "password",
  policies: ["single", "fallback"],
  baseUrl: () => SENSENOVA_INFER_BASE,
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => senseNovaInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(senseNovaStatus(provider.id), "api_key"),
  models: () => senseNovaCatalogModels(senseNovaCatalog()),
  quotas: (provider, snapshot) => senseNovaQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    // The pools that can serve a model: the others are not spent on anything.
    const usage = snapshot.sensenova?.[provider.id]?.pools as SenseNovaPoolUsage | null;
    const pools = (usage?.pools ?? []).filter((pool) => pool.modelIds.length > 0);
    if (!pools.length) return false;
    return pools.every((pool) => totalRemaining(pool) <= 0);
  },
  recoverAt: (provider, snapshot) => {
    // 滚动窗口什么时候重置：见底的窗口先算（与 MiniMax 同一套取舍），
    // 没有见底的窗口就退回最早的那个重置点。
    const usage = snapshot.sensenova?.[provider.id]?.pools as SenseNovaPoolUsage | null;
    const pools = (usage?.pools ?? []).filter((pool) => pool.modelIds.length > 0);
    if (!pools.length) return null;
    const now = Date.now();
    let exhausted: number | null = null;
    let soonest: number | null = null;
    for (const pool of pools) {
      const windows = [pool.window5h, pool.window7d];
      for (const window of windows) {
        const at = window.resetAt ? window.resetAt * 1000 : 0;
        if (!at || at <= now) continue;
        if (soonest === null || at < soonest) soonest = at;
        if (window.limit > 0 && window.remaining <= 0) {
          if (exhausted === null || at > exhausted) exhausted = at;
        }
      }
    }
    return exhausted ?? soonest;
  },
});
