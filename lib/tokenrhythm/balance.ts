// lib/tokenrhythm/balance.ts — 余额账号：定时扫描，按到期钉住一个。
//
// 中转站的赠金会过期，所以最先到期的那个账户该先用。这是「定时的一件事」：
//
//   scanBalance()          扫描余额，按到期排序
//   setBalanceAccount()    扫描并把第一个钉住（定时器与钩子都调它）
//   pinnedBalanceAccount() 现在钉住的是哪个
//
// 请求打到一个账户上、平台说「余额不足」时，外面的钩子调
// setBalanceAccount() 重新扫描、重新钉一个，请求再打一次那个新的。
//
// 钉住的单位是**平台**：一副账号里哪个先用是平台的事，不是哪一行账号的事。
// 钉住的状态在进程里：它是「现在该用哪个账户」的答案，不是每次请求现算的
// 次序——所以别处想知道该用谁，问这里。

import { orderedAccounts, tokenRhythmStatuses, type TokenRhythmAccountStatus } from "./wallet.ts";
import { TokenRhythmNoBalanceError } from "./transport.ts";
import { upstreamStatusOf } from "../upstream-status.ts";

/** 一个账户的余额，扫描看到的。 */
export interface AccountBalance {
  /** 账户行的 id。 */
  accountId: string;
  /** 面板上的别名。 */
  alias: string;
  /** 还剩多少钱。 */
  availableCny: number;
  /** 赠金还剩多少（充值的本金是 0）。 */
  giftCny: number;
  /** 下一笔赠金什么时候到期（毫秒）。0 = 不到期（充值的本金）。 */
  expiresAt: number;
}

/** 每个平台钉住的是哪个账户。 */
const pinned = new Map<string, AccountBalance>();

/**
 * 从哪儿读钱包。
 *
 * 默认是问平台。测试可以换掉它（跟 lib/router/benefits.ts 的做法一样：默认
 * 是真的，测试传一个假的进来）。
 */
export type WalletReader = (platform: string) => Promise<TokenRhythmAccountStatus[]>;

/** 读钱包。 */
async function readWallet(platform: string): Promise<TokenRhythmAccountStatus[]> {
  return tokenRhythmStatuses(platform);
}

/**
 * 扫描余额：平台上每个能用的账户，按「钱最先到期」排序。
 *
 * 充值的本金不会到期，所以它排在最后——那是最后的去处。
 */
export async function scanBalance(
  platform = "tokenrhythm",
  reader: WalletReader = readWallet,
): Promise<AccountBalance[]> {
  const statuses = await reader(platform);
  // orderedAccounts 已经排除了没 key、查询出错、平台说没钱的那些，并且把
  // 有赠金的排在前面（先到期的先）。
  return orderedAccounts(statuses).map(balanceOf);
}

function balanceOf(account: TokenRhythmAccountStatus): AccountBalance {
  const at = account.credits?.summary?.nextExpiryAt;
  const expiry = at ? Date.parse(at) : Number.NaN;
  return {
    accountId: account.accountId,
    alias: account.name,
    availableCny: Number(account.wallet?.availableCny ?? 0),
    giftCny: Number(account.wallet?.giftAvailableCny ?? 0),
    expiresAt: Number.isFinite(expiry) ? expiry : 0,
  };
}

/**
 * 定下钉住的账户：扫描余额，把最先到期的那个钉上。
 *
 * 定时器调它（每隔一会儿重新定一次），钩子也调它（某个账户说余额不足时，
 * 重新定一个别的）。没有能用的账户就钉不上。
 */
export async function setBalanceAccount(
  platform = "tokenrhythm",
  reader: WalletReader = readWallet,
): Promise<AccountBalance | null> {
  const balances = await scanBalance(platform, reader);
  const first = balances[0] ?? null;
  if (!first) {
    pinned.delete(platform);
    return null;
  }
  pinned.set(platform, first);
  return first;
}

/** 现在钉住的是哪个账户。 */
export function pinnedBalanceAccount(platform = "tokenrhythm"): AccountBalance | null {
  return pinned.get(platform) ?? null;
}

/** 忘掉钉住的账户（没有能用的账户时）。 */
export function clearBalanceAccount(platform = "tokenrhythm"): void {
  pinned.delete(platform);
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
