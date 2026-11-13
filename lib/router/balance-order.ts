// lib/router/balance-order.ts — 按余额到期挑选账号：钉住一个，缺钱时重钉。
//
// `expiry_first` 说的是「赠金最先到期的那个账号先上」：赠金会过期，不花掉就是
// 白白浪费。这一条与哪一家平台无关 —— 任何平台只要选了这个策略，次序就由余额
// 决定，所以这一层的判据里没有 kind。
//
// 余额是**额度插件**报上来的那一份（`snapshot.plugins[pluginId][accountId]` 的
// views 里的 balance/credits）。路由不去问钱包接口：问一次上游要凭据、要处理
// 限流，而快照里已经有插件刚问回来的那份数。插件答「不知道」时这里也答不知道
// ——「不知道」不等于「没钱」，那时退回账号的先后顺序，不凭空排除谁。
//
// 钉住的单位是平台：一副账号里哪个先用是平台的事。钉住的状态在进程里，它是
// 「现在该用哪个账号」的答案，不是每次请求现算的次序。

import { peekHealthSnapshot } from "../health-cache.ts";
import { openPlatformOf } from "../open-platforms.ts";
import type { HealthSnapshot, QuotaView } from "../provider-kinds.ts";

/** 一个账号的余额，按「赠金什么时候到期」关心。 */
export interface AccountBalance {
  /** 账号行的 id。 */
  accountId: string;
  /** 还剩多少钱。 */
  availableCny: number;
  /** 会过期的那部分（赠金）。 */
  expiringCny: number;
  /**
   * 最近一批会过期的钱的到期时刻（Unix 毫秒）。0 = 没有会过期的钱。
   *
   * 充值的本金不到期，所以它排在最后 —— 那是最后的去处。
   */
  expiresAt: number;
}

/**
 * 从哪儿读余额。
 *
 * 默认是额度快照。测试可以换掉它（跟 lib/router/benefits.ts 的做法一样：默认
 * 是真的，测试传一个假的进来）。
 */
export type BalanceReader = (platform: string) => Record<string, QuotaView[]>;

/** 每个平台钉住的是哪个账号。 */
const pinned = new Map<string, string>();

/**
 * 快照里这个平台每个账号的额度视图。
 *
 * 插件 id 只从平台行读（`platform.quota_plugin`）：没指名插件就是没有余额可读，
 * 那是「不知道」，不是「没钱」。
 */
function readFromSnapshot(platform: string): Record<string, QuotaView[]> {
  const pluginId = openPlatformOf(platform)?.quotaPlugin?.trim() ?? "";
  if (!pluginId) return {};
  const snapshot = peekHealthSnapshot<HealthSnapshot>()?.data;
  const bucket = snapshot?.plugins?.[pluginId] ?? {};
  const views: Record<string, QuotaView[]> = {};
  for (const [accountId, probe] of Object.entries(bucket)) {
    // 只有「问到了」的那一份才有数：其余状态（见底、被拒、问不到）都不是余额，
    // 拿它们排序等于替上游编一个数。
    if (probe?.state !== "ok") continue;
    views[accountId] = probe.views ?? [];
  }
  return views;
}

/**
 * 一个账号的余额。
 *
 * 余额（钱）与积分（点数）是两种额度，只有余额有到期这一说：积分按剩余量排，
 * 到期时刻算 0 —— 它不会过期，所以它跟本金一样排在后面。
 */
export function balanceOf(accountId: string, views: QuotaView[]): AccountBalance | null {
  if (!views.length) return null;
  const balance = views.find((view) => view.balance)?.balance;
  if (balance) {
    return {
      accountId,
      availableCny: Number(balance.availableCny ?? 0),
      expiringCny: Number(balance.expiringCny ?? 0),
      expiresAt: Number(balance.nextExpiryAt ?? 0),
    };
  }
  const credits = views.find((view) => view.credits)?.credits;
  if (credits) {
    return {
      accountId,
      availableCny: Number(credits.remaining ?? 0),
      expiringCny: 0,
      expiresAt: 0,
    };
  }
  return null;
}

/**
 * 把这些账号按「谁先花钱」排出来。
 *
 * 次序：
 *
 *   1. 钉住的那个（如果它还在名单里）—— 定时器已经算过一次，这里不再改主意
 *   2. 有赠金要过期的，到期早的在前
 *   3. 没有会过期的钱的（本金、积分、读不到余额的）—— 保持调用方给的顺序
 *
 * 读不到余额**不排除**谁：那是「不知道」，不是「没钱」。
 */
export function orderByBalance(
  accountIds: readonly string[],
  balances: Record<string, QuotaView[]>,
  pinnedId: string | null = null,
): string[] {
  const scored = accountIds.map((accountId, index) => {
    const views = balances[accountId];
    return { accountId, index, balance: views ? balanceOf(accountId, views) : null };
  });
  scored.sort((a, b) => {
    if (a.accountId === pinnedId && b.accountId !== pinnedId) return -1;
    if (b.accountId === pinnedId && a.accountId !== pinnedId) return 1;
    const aExpiring = a.balance !== null && a.balance.expiringCny > 0 && a.balance.expiresAt > 0;
    const bExpiring = b.balance !== null && b.balance.expiringCny > 0 && b.balance.expiresAt > 0;
    if (aExpiring && bExpiring) return a.balance!.expiresAt - b.balance!.expiresAt;
    if (aExpiring !== bExpiring) return aExpiring ? -1 : 1;
    return a.index - b.index;
  });
  return scored.map((one) => one.accountId);
}

/** 按余额排出这个平台这些账号的次序。 */
export function balanceOrderOf(
  platform: string,
  accountIds: readonly string[],
  reader: BalanceReader = readFromSnapshot,
): string[] {
  return orderByBalance(accountIds, reader(platform), pinnedAccountOf(platform));
}

/** 现在钉住的是哪个账号。 */
export function pinnedAccountOf(platform: string): string | null {
  return pinned.get(platform) ?? null;
}

/**
 * 重新钉一个：在这些账号里挑「赠金最先到期」的那个。
 *
 * 定时器与「余额不足」的钩子都调它。名单为空、或者一个账号都挑不出来就钉不上
 * （返回 null），那时调用方按没有下一个处理。
 */
export function pinNextAccount(
  platform: string,
  accountIds: readonly string[],
  reader: BalanceReader = readFromSnapshot,
): string | null {
  const ordered = orderByBalance(accountIds, reader(platform), null);
  const next = ordered[0] ?? null;
  if (next === null) {
    pinned.delete(platform);
    return null;
  }
  pinned.set(platform, next);
  return next;
}

/** 忘掉钉住的账号（平台删了、或者没有能用的账号时）。 */
export function forgetPinnedAccount(platform: string): void {
  pinned.delete(platform);
}
