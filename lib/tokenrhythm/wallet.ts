// lib/tokenrhythm/wallet.ts — what the accounts have left, and which one to use.
//
// TokenRhythm hands out the credits in batches: the ones that expire first are
// used first, and the money that was paid in is used last. So the pick is by
// the date the next batch expires — the platform moves that date on its own as
// a batch is used up, and the account switches by itself.
//
// An account is a row of the provider table, and it has one wallet: the cookie
// that reads the wallet is the row's own, and so is the key that calls the
// models. Two rows of the same platform are two accounts with two wallets.

import { platformApi } from "./platform.ts";
import { tokenRhythmKeys } from "./keys.ts";
import { loadSession, sessionFor, sessionId, tokenRhythmCredentialOf, type TokenRhythmSession } from "./accounts.ts";
import { accountsOfPlatform, provider } from "../providers.ts";
import { platformOf } from "../platforms.ts";

export interface TokenRhythmWallet {
  currency: string;
  /** What is there to spend. */
  availableCny: number;
  /** The part of it that was given and expires. */
  giftAvailableCny: number;
  /** The part of it that was paid for and does not expire. */
  rechargeCny: number;
  giftTotalCny: number;
  giftStatus: string;
  asOf: string | null;
}

export interface TokenRhythmGift {
  id: string;
  source: string;
  sourceLabel: string;
  remainingCny: number;
  expiresAt: string | null;
  status: string;
}

export interface TokenRhythmCredits {
  /**
   * What the platform itself says.
   *
   * `expiringCny` counts the money that never expires as money that runs out,
   * so it is not to be trusted as an amount. `nextExpiryAt` is the useful one:
   * it points at the gift that runs out first, and it moves on when that gift
   * is spent, which is how the gateway knows to change account.
   */
  summary: {
    expiringCny: number;
    nextExpiryAt: string | null;
  };
  /** Every lot, as the platform lists it. */
  list: TokenRhythmGift[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Which platform an id belongs to.
 *
 * A platform id is one of the nine templates; an account id is a row of the
 * provider table. Both reach this file — the router has the platform, the
 * panel and the health snapshot have the account — so both are accepted and
 * resolved here once.
 */
export function platformOfAccount(id: string): string {
  return platformOf(id) ? id : (provider(id)?.platform ?? id);
}

export async function wallet(session: TokenRhythmSession, accountId = session.accountId): Promise<TokenRhythmWallet> {
  const data = await platformApi<any>("/api/wallet/summary", session);
  // A fresh wallet means the cached view is stale: which account runs out
  // first may have changed, and the next request has to decide again. Only
  // this platform's view goes — another platform's accounts did not change.
  resetTokenRhythmStatusCache(platformOfAccount(accountId));
  return {
    currency: String(data?.currency ?? "CNY"),
    availableCny: num(data?.availableBalanceCny),
    giftAvailableCny: num(data?.giftAvailableCny),
    rechargeCny: num(data?.rechargeBalanceCny),
    giftTotalCny: num(data?.giftTotalCny),
    giftStatus: String(data?.giftStatus ?? ""),
    asOf: data?.asOf ?? null,
  };
}

export async function credits(session: TokenRhythmSession): Promise<TokenRhythmCredits> {
  const data = await platformApi<any>(
    "/api/wallet/expiring-credits?page=1&pageSize=50&includeInactive=true&includePermanent=true",
    session,
  );
  const list: TokenRhythmGift[] = (Array.isArray(data?.list) ? data.list : []).map((row: any) => ({
    id: String(row?.id ?? ""),
    source: String(row?.source ?? ""),
    sourceLabel: String(row?.sourceLabel ?? ""),
    remainingCny: num(row?.remainingCny),
    expiresAt: row?.expiresAt ?? null,
    status: String(row?.status ?? ""),
  }));

  return {
    summary: {
      expiringCny: num(data?.summary?.expiringBalanceCny),
      nextExpiryAt: data?.summary?.nextExpiryAt ?? null,
    },
    list,
  };
}

/* ------------------------------------------------------------------ *
 * The accounts of a platform, as a whole
 * ------------------------------------------------------------------ */

export interface TokenRhythmAccountStatus {
  /** The account row this is about. */
  accountId: string;
  /** The platform account, hidden: only the last two digits are shown. */
  account: string;
  /** The alias of the row, so the log and the panel can tell two apart. */
  name: string;
  /** Whether the account has a key for the inference. */
  hasKey: boolean;
  /** The account's own credential: the session and the key. */
  credential: {
    status: string;
    /** The session's own expiry. */
    expiresAt: string;
    remainingSec: number;
    warning: boolean;
  } | null;
  wallet: TokenRhythmWallet | null;
  credits: TokenRhythmCredits | null;
  error: string | null;
}

const mask = (account: string): string =>
  account.length <= 4 ? "***" : `${account.slice(0, 3)}***${account.slice(-2)}`;

/** What every account of the platform has, as far as the platform says. */
export async function accountStatuses(platform: string): Promise<TokenRhythmAccountStatus[]> {
  const out: TokenRhythmAccountStatus[] = [];
  for (const row of accountsOfPlatform(platform)) {
    const stored = tokenRhythmCredentialOf(row.id);
    const status: TokenRhythmAccountStatus = {
      accountId: row.id,
      account: mask(stored?.account ?? ""),
      name: row.alias,
      hasKey: Boolean(stored?.apiKey),
      credential: null,
      wallet: null,
      credits: null,
      error: stored ? null : "这个账号还没有账号密码",
    };
    out.push(status);
    if (!stored) continue;
    try {
      const session = await sessionFor(row.id);
      status.name = session.name || row.alias;
      // The account's own credential: the session (the cookie) and the key.
      const remainingMs = session.expiresAtMs - Date.now();
      status.credential = {
        status: remainingMs > 0 ? "authenticated" : "expired",
        expiresAt: session.expiresAtMs ? new Date(session.expiresAtMs).toISOString() : "",
        remainingSec: Math.round(remainingMs / 1000),
        warning: remainingMs > 0 && remainingMs < WARN_MS,
      };
      // An account with no key cannot serve a request, and the key is only
      // ever shown in full in the answer to the call that makes it. So the
      // gateway makes one and keeps it — a new account works without anybody
      // putting a key in the environment.
      if (!stored.apiKey) {
        const made = await tokenRhythmKeys.ensure({ session, providerId: row.id }, null);
        status.hasKey = Boolean(made);
      }
      status.wallet = await wallet(session, row.id);
      status.credits = await credits(session);
    } catch (e) {
      status.error = (e as Error).message;
    }
  }
  return out;
}

/**
 * The accounts that can serve a request at all.
 *
 * They have a key, the platform says they have money, and they have not just
 * said they have none. The order is the order the accounts were added in —
 * the one that runs out first is `orderedAccounts`'s business, not this one's.
 */
export function usableAccounts(statuses: TokenRhythmAccountStatus[]): TokenRhythmAccountStatus[] {
  return statuses.filter((s) => {
    // 能发请求靠的是 API key；账号密码那份登录态只用来查余额。
    if (!s.hasKey) return false;
    if (outOfMoney.has(s.accountId)) return false;
    // 余额读到了、而且是空的：这才叫没钱。
    if (s.wallet && (s.wallet.availableCny ?? 0) <= 0) return false;
    // 余额读不到（登录失败、平台挂了）：那是「不知道」，不是「没有」——
    // 排到最后，但照样让它接；拒掉它等于把「查不了余额」当成「没钱」。
    return true;
  });
}

/**
 * Every account that can serve a request, in the order they should be tried.
 *
 * The gift that runs out first is spent first; the money that was paid for
 * does not expire, so it is the last resort — but it is still in the list:
 * once the gifts are gone, the request has to go somewhere.
 */
export function orderedAccounts(statuses: TokenRhythmAccountStatus[]): TokenRhythmAccountStatus[] {
  const usable = usableAccounts(statuses);
  if (!usable.length) return [];
  const withGift = usable.filter((s) => (s.wallet?.giftAvailableCny ?? 0) > 0);
  // 余额读得到的本金排在赠金后面；余额读不到的排最后 —— 它们能不能用还不知道。
  const paid = usable.filter((s) => s.wallet && (s.wallet.giftAvailableCny ?? 0) <= 0);
  const unknown = usable.filter((s) => !s.wallet);
  return [...sortByExpiry(withGift), ...paid, ...unknown];
}

/**
 * The account a request should go to: the one whose gift runs out first.
 *
 * A single account is the first of `orderedAccounts`.
 */
export function pickAccount(statuses: TokenRhythmAccountStatus[]): TokenRhythmAccountStatus | null {
  return orderedAccounts(statuses)[0] ?? null;
}

/** The ones whose gift runs out first come first. */
function sortByExpiry(accounts: TokenRhythmAccountStatus[]): TokenRhythmAccountStatus[] {
  // The soonest expiry first, as the platform reports it: it points at the
  // gift that runs out first and moves on when that gift is spent, so an
  // account whose gift is gone sorts last and the next account takes over.
  const expiry = (s: TokenRhythmAccountStatus): number => {
    const at = s.credits?.summary?.nextExpiryAt;
    if (!at) return Number.POSITIVE_INFINITY;
    const t = Date.parse(at);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return accounts.sort((a, b) => expiry(a) - expiry(b));
}

/**
 * Accounts that answered "insufficient balance".
 *
 * They are left out for a while — the wallet the gateway has cached still
 * says there is money on them, and that answer is a few minutes old. After
 * that the platform's own numbers decide again.
 */
const outOfMoney = new Map<string, number>();

/** How long an account stays out after it says it has no money. */
const OUT_OF_MONEY_TTL_MS = 10 * 60 * 1000;

/** Remember that an account has no money left. */
export function markAccountOutOfMoney(accountId: string): void {
  outOfMoney.set(accountId, Date.now());
}

/** Forget the accounts that ran out of money — the check is stale by now. */
function pruneOutOfMoney(): void {
  const cutoff = Date.now() - OUT_OF_MONEY_TTL_MS;
  for (const [accountId, at] of outOfMoney) {
    if (at < cutoff) outOfMoney.delete(accountId);
  }
}

/* ------------------------------------------------------------------ *
 * The cached view
 * ------------------------------------------------------------------ */

/** The cached view, one per platform. */
const caches = new Map<string, { at: number; statuses: TokenRhythmAccountStatus[] }>();

/**
 * The accounts' status, from a recent answer.
 *
 * Asking the platform for every wallet on every request would be slow, so the
 * answer is kept for a few minutes. A request that has to know which account
 * to use asks for the cached view.
 *
 * The argument is the platform; an account id is accepted too and resolved to
 * its platform, because the health snapshot asks per account row.
 */
export async function tokenRhythmStatuses(
  platformOrAccount: string = "tokenrhythm",
  maxAgeMs = 300_000,
): Promise<TokenRhythmAccountStatus[]> {
  pruneOutOfMoney();
  const platform = platformOfAccount(platformOrAccount);
  const cached = caches.get(platform);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.statuses;
  const statuses = await accountStatuses(platform);
  caches.set(platform, { at: Date.now(), statuses });
  return statuses;
}

/**
 * Throw one platform's cached view away, so the next question goes to the
 * platform.
 *
 * Only that platform's view goes: the other platforms' accounts have not
 * changed, and asking the platform about them again is a call it does not
 * need to answer.
 */
export function resetTokenRhythmStatusCache(platformOrAccount: string): void {
  caches.delete(platformOfAccount(platformOrAccount));
}

/* ------------------------------------------------------------------ *
 * The credential
 * ------------------------------------------------------------------ */

/** 面板上的「快到期」提示线（毫秒）。cookie 只能用三十天。 */
const WARN_MS = 3 * 24 * 3600 * 1000;

/**
 * One account's credential state.
 *
 * The account is a row of the provider table, so the answer is about that row:
 * whether it has a session, and when that session runs out.
 */
export function tokenRhythmStatus(accountId: string): Record<string, unknown> {
  const session = loadSession(accountId);
  const remainingMs = session ? session.expiresAtMs - Date.now() : 0;
  const stored = tokenRhythmCredentialOf(accountId);
  return {
    source: sessionId(accountId),
    status: session ? "authenticated" : stored ? "anonymous" : "missing",
    hasKey: Boolean(stored?.apiKey),
    expiresAt: session?.expiresAtMs ? new Date(session.expiresAtMs).toISOString() : "",
    remainingSec: Math.round(remainingMs / 1000),
    warning: remainingMs > 0 && remainingMs < WARN_MS,
  };
}
