// lib/tokenrhythm/balance.ts — 余额账号：定时扫描，按到期钉住一个。
//
// 中转站的赠金会过期，所以最先到期的那个账户该先用。这是「定时的一件事」：
//
//   scanBalance()        扫描余额，按到期排序
//   setBalanceAccount()  扫描并把第一个钉住（定时器与钩子都调它）
//   pinnedBalanceAccount() 现在钉住的是哪个
//
// 请求打到一个账户上、平台说「余额不足」时，外面的钩子调
// setBalanceAccount() 重新扫描、重新钉一个，请求再打一次那个新的。
//
// 钉住的状态在进程里：它是「现在该用哪个账户」的答案，不是每次请求现算的
// 次序——所以别处想知道该用谁，问这里。

import { usableTenants, tokenRhythmStatuses, type TokenRhythmTenantStatus } from "./wallet.ts";
import { TokenRhythmNoBalanceError } from "./transport.ts";
import { upstreamStatusOf } from "../upstream-status.ts";

/** 一个租户的余额，扫描看到的。 */
export interface TenantBalance {
  /** 租户号。 */
  index: number;
  /** 还剩多少钱。 */
  availableCny: number;
  /** 赠金还剩多少（充值的本金是 0）。 */
  giftCny: number;
  /** 下一笔赠金什么时候到期（毫秒）。0 = 不到期（充值的本金）。 */
  expiresAt: number;
}

/** 每个上游钉住的是哪个租户。 */
const pinned = new Map<string, TenantBalance>();

/**
 * 从哪儿读钱包。
 *
 * 默认是问平台。测试可以换掉它（跟 lib/router/benefits.ts 的做法一样：默认
 * 是真的，测试传一个假的进来）。
 */
export type WalletReader = (providerId: string) => Promise<TokenRhythmTenantStatus[]>;

/** 读钱包。 */
async function readWallet(providerId: string): Promise<TokenRhythmTenantStatus[]> {
  return tokenRhythmStatuses(providerId);
}

/**
 * 扫描余额：名下每个能用的租户，按「钱最先到期」排序。
 *
 * 充值的本金不会到期，所以它排在最后——那是最后的去处。
 */
export async function scanBalance(
  providerId = "tokenrhythm",
  reader: WalletReader = readWallet,
): Promise<TenantBalance[]> {
  const statuses = await reader(providerId);
  // usableTenants 已经排除了没 key、查询出错、平台说没钱的那些。
  const usable = usableTenants(statuses);
  const expiryOf = (s: TokenRhythmTenantStatus): number => {
    const at = s.credits?.summary?.nextExpiryAt;
    if (!at) return Number.POSITIVE_INFINITY;
    const t = Date.parse(at);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  // 有赠金的先上（先到期的先用），充值的本金排在最后。
  const withGift = usable.filter((s) => (s.wallet?.giftAvailableCny ?? 0) > 0);
  const withoutGift = usable.filter((s) => (s.wallet?.giftAvailableCny ?? 0) <= 0);
  return [...withGift.sort((a, b) => expiryOf(a) - expiryOf(b)), ...withoutGift].map(balanceOf);
}

function balanceOf(tenant: TokenRhythmTenantStatus): TenantBalance {
  const at = tenant.credits?.summary?.nextExpiryAt;
  const expiry = at ? Date.parse(at) : Number.NaN;
  return {
    index: tenant.index,
    availableCny: Number(tenant.wallet?.availableCny ?? 0),
    giftCny: Number(tenant.wallet?.giftAvailableCny ?? 0),
    expiresAt: Number.isFinite(expiry) ? expiry : 0,
  };
}

/**
 * 定下钉住的账号：扫描余额，把最先到期的那个钉上。
 *
 * 定时器调它（每隔一会儿重新定一次），钩子也调它（某个账户说余额不足时，
 * 重新定一个别的）。没有能用的账户就钉不上。
 */
export async function setBalanceAccount(
  providerId = "tokenrhythm",
  reader: WalletReader = readWallet,
): Promise<TenantBalance | null> {
  const balances = await scanBalance(providerId, reader);
  const first = balances[0] ?? null;
  if (!first) {
    pinned.delete(providerId);
    return null;
  }
  pinned.set(providerId, first);
  return first;
}

/** 现在钉住的是哪个租户。 */
export function pinnedBalanceAccount(providerId = "tokenrhythm"): TenantBalance | null {
  return pinned.get(providerId) ?? null;
}

/** 忘掉钉住的账号（没有能用的账户时）。 */
export function clearBalanceAccount(providerId = "tokenrhythm"): void {
  pinned.delete(providerId);
}

/**
 * 这个失败是不是「余额不足」。
 *
 * 余额到期优先的钩子：钉住的账户接不了时，问这个——是余额没了（那就重新
 * 扫描、重新钉一个），还是别的毛病（换个账户也一样）。
 */
export function isRequestMissingBalance(error: unknown): boolean {
  if (error instanceof TokenRhythmNoBalanceError) return true;
  return upstreamStatusOf(error) === 402;
}
