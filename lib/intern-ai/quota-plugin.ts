// lib/intern-ai/quota-plugin.ts — 书生·端砚的墨点做成一个额度插件。
//
// 墨点在 Discovery 子站的控制台上，只认登录换来的子站 token：推理用的那把 key
// 读不到它。所以这个插件做一件事：拿 Discovery 的 token 问一次余额（顺带问批次，
// 问不到不影响余额），把答复或异常翻成一个结论。
//
// 端砚有自己的一个「账号能不能用」的开关（access_status）。它跟「墨点用完了」是
// 两件事：一个要人去平台上处理，一个等窗口自己回来。所以前者翻成 blocked，后者
// 翻成 no_quota —— 面板上那两句话不一样。
//
// 这个插件不要任何额外的凭据段（fields 是空的）：查额度用的就是登录换来的会话，
// 用户不必再填第二个东西。会话不在 —— 那是「还没登录」，翻成 missing。

import type { CreditLotView, QuotaView } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { quotaProbe } from "../quota-state.ts";
import { registerQuotaPlugin, type QuotaProbe } from "../quota-plugins.ts";
import { InternAiError, loadSession, tokenFor } from "./auth.ts";
import {
  balance as internAiBalance,
  creditPacks as internAiCreditPacks,
  type InternAiBalance,
  type InternAiCreditPack,
  type InternAiCreditWindow,
} from "./quota.ts";

/** 一个账号的墨点：余额与批次。批次拿不到时是空表（余额才是那个最要紧的数）。 */
export interface InternAiCredits {
  balance: InternAiBalance | null;
  packs: InternAiCreditPack[] | null;
}

/**
 * 墨点报成额度。
 *
 * 从 lib/intern-ai/register.ts 原样搬过来，一个数字都没动：迁移不许改口径。
 * 墨点是余额，窗口是限额：两个概念，不相加。批次报成积分的批次，两个滚动窗口
 * 报成套餐窗口的形状（面板不用为这个平台另写一套）。
 */
export function internAiCreditsViews(provider: ProviderRow, credits: InternAiCredits): QuotaView[] {
  const balance = credits.balance;
  if (!balance) return [];
  const packs = credits.packs ?? [];
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
  const rateLimit = balance.rpmLimit > 0 ? `，RPM ${balance.rpmLimit} / TPM ${balance.tpmLimit}` : "";
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

/**
 * 平台说这个账号不能用了吗。
 *
 * access_status 的正常值是 1。null = 平台没报这个字段（老答复里压根没这个键时
 * 也是 null）—— 那不是「不能用」，是「没说」。把「没说」当成「说不行」会把
 * 整条路的请求拦死。
 */
export function internAiBlocked(balance: InternAiBalance): boolean {
  const access = balance.accessStatus;
  return access !== null && access !== undefined && access !== 1;
}

/** 窗口见底了，或者墨点用完了。 */
export function internAiOutOfCredits(balance: InternAiBalance): boolean {
  if (balance.availableCredits <= 0) return true;
  for (const window of [balance.window5h, balance.window7d]) {
    if (window.enabled && window.remainingCredits <= 0) return true;
  }
  return false;
}

/**
 * 什么时候回来。
 *
 * 见底的窗口自己说了恢复时刻：两个窗口都见底取较晚的 —— 少一个都不行（与
 * lib/kinds/minimax.ts 的 planRecovery 同一套取舍）。窗口没说就退回「最早到期的
 * 那一批墨点」。与 lib/intern-ai/register.ts 的那一份逐字相同。
 */
export function internAiRecoverAt(credits: InternAiCredits): number | null {
  const balance = credits.balance;
  if (balance) {
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
  const packs = credits.packs ?? [];
  const alive = packs.filter((pack) => pack.status === "available" || pack.status === "unused");
  const now = Date.now();
  let soonest: number | null = null;
  for (const pack of alive) {
    const at = platformTimeMs(pack.expireAt) || platformTimeMs(pack.cycleEndAt);
    if (!at || at <= now) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

export const internAiCreditsPlugin = registerQuotaPlugin({
  id: "intern-ai-credits",
  label: "书生·端砚墨点",
  fields: [],
  probe: async (account) => {
    const session = loadSession(account.id);
    if (!session) return quotaProbe("missing", "账号上没有端砚的会话，查不了墨点");
    const token = tokenFor(session, "discovery");
    // 两个子站各有各的 token，墨点在 Discovery 那边：Chat 的 token 读不到它。
    if (!token) return quotaProbe("missing", "账号上没有 Discovery 子站的 token，查不了墨点");

    let balance: InternAiBalance;
    try {
      balance = await internAiBalance(session, token);
    } catch (e) {
      return stateOfError(e);
    }

    // 批次是补充信息：问不到照样报余额，只是少几行批次。
    let packs: InternAiCreditPack[] | null = null;
    try {
      packs = await internAiCreditPacks(session, token);
    } catch (e) {
      console.warn(`[INTERN-AI] 墨点批次查询失败：${(e as Error)?.message}`);
    }

    const credits: InternAiCredits = { balance, packs };
    // 平台说这个账号不能用：那不是「额度用完了」，等窗口重置也回不来。
    if (internAiBlocked(balance)) {
      return quotaProbe("blocked", `平台说这个账号不能用（access_status=${String(balance.accessStatus)}）`, {
        recoverAt: internAiRecoverAt(credits),
      });
    }
    if (internAiOutOfCredits(balance)) {
      return quotaProbe("no_quota", `墨点用完了：余额 ${balance.availableCredits}`, {
        recoverAt: internAiRecoverAt(credits),
      });
    }
    const alive = (packs ?? []).filter((pack) => pack.status === "available" || pack.status === "unused");
    return quotaProbe("ok", `墨点余额 ${balance.availableCredits}${alive.length ? `，${alive.length} 个批次` : ""}`, {
      views: internAiCreditsViews(account, credits),
    });
  },
});

/**
 * 抛出来的东西翻成状态。
 *
 * 控制台的错误已经分好类了（lib/intern-ai/auth.ts 的 classify），这里只做翻译：
 * 会话无效与没权限都是「凭据被拒」，限流是「等一会儿」，其余都是「问不到」——
 * 而问不到的那句话里要写清是哪一种。
 */
function stateOfError(error: unknown): QuotaProbe {
  if (error instanceof InternAiError) {
    if (error.kind === "auth" || error.kind === "forbidden") {
      return quotaProbe("unauthorized", error.message);
    }
    if (error.kind === "rate") {
      return quotaProbe("rate_limited", error.message, {
        recoverAt: error.retryAfterMs === null ? null : Date.now() + error.retryAfterMs,
      });
    }
    // captcha / config / request / upstream：都不是「额度」这件事的答案。
    return quotaProbe("unknown", `端砚的控制台没答上来：${error.message}`);
  }
  return quotaProbe("unknown", `问额度时抛了：${describeThrow(error)}`);
}

/** 一句人类能读的「抛了什么」。 */
function describeThrow(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return `等控制台超时（${error.message}）`;
    if (error.name === "TypeError") return `连不上控制台（${error.message}）`;
    return `${error.name}：${error.message}`;
  }
  return String(error);
}
