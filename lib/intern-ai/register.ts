// lib/intern-ai/register.ts — what 书生·端砚 (Discovery) is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of this one is its address, its key and its 墨点 balance.

import { internAiCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  type CreditLotView,
  type HealthSnapshot,
  type QuotaView,
} from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { internAiStatus } from "./auth.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "./config.ts";
import type {
  InternAiBalance,
  InternAiCreditPack,
  InternAiCreditWindow,
} from "./quota.ts";
import { internAiCatalog, internAiInferenceKey } from "./transport.ts";

function internAiQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const balance = snapshot.internAi?.[provider.id]?.balance as InternAiBalance | null;
  if (!balance) return [];
  const packs = (snapshot.internAi?.[provider.id]?.packs as InternAiCreditPack[] | null) ?? [];
  // 只有还在的批次算数：过期与作废的不算。
  const alive = packs.filter((pack) => pack.status === "available" || pack.status === "unused");
  const lots: CreditLotView[] = alive.map((pack) => ({
    id: pack.id,
    sourceLabel: pack.remark || pack.cycleType || pack.id,
    remaining: pack.remainingCredits,
    expiresAt: platformTimeMs(pack.expireAt) || platformTimeMs(pack.cycleEndAt),
    // 一批墨点用完了就是用完了，不管平台还把它算不算「还在」。
    status:
      pack.remainingCredits > 0
        ? pack.status === "unused"
          ? "未使用"
          : "可用"
        : "已用尽",
  }));
  const total = alive.reduce((sum, pack) => sum + pack.totalCredits, 0);
  // 墨点是余额，窗口是限额：两个概念，不相加。面板分开显示。
  const rateLimit =
    balance.rpmLimit > 0 ? `，RPM ${balance.rpmLimit} / TPM ${balance.tpmLimit}` : "";
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total,
        used: balance.used,
        remaining: balance.availableCredits,
        lots,
        note: `墨点：余额 ${balance.availableCredits}${alive.length ? `，${alive.length} 个批次` : ""}${rateLimit}`,
      },
      // 端砚真正的使用限额是这两个滚动窗口。报成套餐窗口的形状，面板不用为
      // 这个平台另写一套（与 MiniMax 的套餐窗口同一个形状）。
      tokenPlan: {
        windows: [
          {
            label: "墨点",
            // 5 小时窗口当「本轮」，7 天窗口当「本周」。
            intervalPercent: windowPercent(balance.window5h),
            weeklyPercent: windowPercent(balance.window7d),
            intervalEndsAt: platformTimeMs(balance.window5h?.nextRecoverAt),
            weeklyEndsAt: platformTimeMs(balance.window7d?.nextRecoverAt),
          },
        ],
      },
    },
  ];
}

/**
 * 一个窗口还剩多少（百分比）。
 *
 * 没开这个窗口就是不限，算不出来也当满额 —— 面板显示 0% 会让人以为账号没额度。
 */
function windowPercent(window: InternAiCreditWindow | undefined): number {
  if (!window || !window.enabled) return 100;
  if (!(window.limitCredits > 0)) return 100;
  const percent = (window.remainingCredits / window.limitCredits) * 100;
  if (!Number.isFinite(percent)) return 100;
  return Math.max(0, Math.min(100, percent));
}

/**
 * 平台给的时间戳。
 *
 * 平台按它自己的时区报（UTC+8），没带时区就按那个算。
 */
function platformTimeMs(value: string): number {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}+08:00`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const internAiKind = registerCompatiblePlatform({
  kind: "intern-ai",
  label: "书生·端砚",
  login: "code",
  policies: ["single", "fallback"],
  baseUrl: () => INTERN_AI_DISCOVERY_API_BASE,
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => internAiInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(internAiStatus(provider.id), "api_key"),
  models: () => internAiCatalogModels(internAiCatalog()),
  quotas: (provider, snapshot) => internAiQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const mine = (snapshot.internAi?.[provider.id] ?? {}) as any;
    const raw = mine.balance as any;
    const balance = raw as InternAiBalance | null;
    if (!balance) return false;
    // 平台自己说这个账号不能用（access_status 的正常值是 1）：不再往它发请求。
    // 老数据里没有这个字段时当作正常，不误判。
    const access = raw.accessStatus;
    if (access !== undefined && access !== null && access !== 1) return true;
    if (balance.availableCredits <= 0) return true;
    // A window that is full is full: it cannot be spent this time round.
    for (const window of [balance.window5h, balance.window7d]) {
      if (window.enabled && window.remainingCredits <= 0) return true;
    }
    return false;
  },
  recoverAt: (provider, snapshot) => {
    const mine = (snapshot.internAi?.[provider.id] ?? {}) as any;
    const balance = mine.balance as InternAiBalance | null;
    if (balance) {
      // 窗口见底时，恢复时间由窗口自己说：见底的那个窗口的 next_recover_at。
      // 两个窗口都见底取较晚的 —— 少一个都不行（与 lib/kinds/minimax.ts 的
      // planRecovery 同一套取舍）。算不出来就不知道。
      let exhausted: number | null = null;
      let sawExhausted = false;
      for (const window of [balance.window5h, balance.window7d]) {
        if (!window?.enabled || window.remainingCredits > 0) continue;
        sawExhausted = true;
        const at = platformTimeMs(window.nextRecoverAt);
        if (!at) continue;
        if (exhausted === null || at > exhausted) exhausted = at;
      }
      if (sawExhausted) return exhausted;
    }
    // 墨点批次的到期时间：最早到期的那批先走。
    const packs = (mine.packs ?? []) as InternAiCreditPack[];
    const alive = packs.filter((pack) => pack.status === "available" || pack.status === "unused");
    const now = Date.now();
    let soonest: number | null = null;
    for (const pack of alive) {
      const at = platformTimeMs(pack.expireAt) || platformTimeMs(pack.cycleEndAt);
      if (!at || at <= now) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
    return soonest;
  },
});
