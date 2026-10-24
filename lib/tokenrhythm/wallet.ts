// lib/tokenrhythm/wallet.ts — what the accounts have left, and which one to use.
//
// TokenRhythm hands out the credits in batches: the ones that expire first are
// used first, and the money that was paid in is used last. So the pick is by
// the date the next batch expires — the platform moves that date on its own as
// a batch is used up, and the account switches by itself.

import { platformApi } from "./platform.ts";
import { ensureApiKey } from "./keys.ts";
import {
  TokenRhythmError,
  loadSession,
  login,
  sessionFor,
  sessionId,
  tokenRhythmTenant,
  tokenRhythmTenants,
  type TokenRhythmSession,
} from "./accounts.ts";

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

export async function wallet(session: TokenRhythmSession): Promise<TokenRhythmWallet> {
  const data = await platformApi<any>("/api/wallet/summary", session);
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
 * The tenants, as a whole
 * ------------------------------------------------------------------ */

export interface TokenRhythmTenantStatus {
  index: number;
  /** The account, hidden: only the last two digits are shown. */
  account: string;
  name: string;
  /** Whether the tenant has a key for the inference. */
  hasKey: boolean;
  /** The tenant's own credential: the session and the key. */
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

/** What every tenant has, as far as the platform says. */
export async function tenantStatuses(providerId = "tokenrhythm"): Promise<TokenRhythmTenantStatus[]> {
  const tenants = tokenRhythmTenants(providerId);
  const out: TokenRhythmTenantStatus[] = [];
  for (const tenant of tenants) {
    const status: TokenRhythmTenantStatus = {
      index: tenant.index,
      account: mask(tenant.account),
      name: "",
      hasKey: Boolean(tenant.apiKey),
      credential: null,
      wallet: null,
      credits: null,
      error: null,
    };
    try {
      const session = await sessionFor(tenant.index, providerId);
      status.name = session.name;
      // The tenant's own credential: the session (the cookie) and the key.
      // Without this the panel could only say "no credential" for the provider
      // as a whole, while every tenant had its own.
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
      if (!tenant.apiKey) {
        const made = await ensureApiKey(session, tenant.index, null, providerId);
        status.hasKey = Boolean(made);
      }
      status.wallet = await wallet(session);
      status.credits = await credits(session);
    } catch (e) {
      status.error = (e as Error).message;
    }
    out.push(status);
  }
  return out;
}

/**
 * The tenant a request should go to.
 *
 * The gift money expires, so the gift that runs out first is the one to spend
 * first; the money that was paid for does not expire and is the last resort.
 * A tenant with neither is skipped.
 */
export function pickTenant(statuses: TokenRhythmTenantStatus[]): TokenRhythmTenantStatus | null {
  return pickTenants(statuses)[0] ?? null;
}

/**
 * The tenants a request may go to, in the order they should be tried.
 *
 * The order is the same as pickTenant's: the gift that runs out first is
 * spent first. Tenants that ran out of money are left out — the platform's
 * cached wallet still says there is money on them for a few minutes, and a
 * request that goes there fails with "insufficient balance".
 */
export function pickTenants(statuses: TokenRhythmTenantStatus[]): TokenRhythmTenantStatus[] {
  const usable = statuses.filter(
    (s) => !s.error && s.hasKey && (s.wallet?.availableCny ?? 0) > 0 && !outOfMoney.has(s.index),
  );
  if (!usable.length) return [];

  const withGift = usable.filter((s) => (s.wallet?.giftAvailableCny ?? 0) > 0);
  const pool = withGift.length ? withGift : usable;
  // The soonest expiry first, as the platform reports it: it points at the
  // gift that runs out first and moves on when that gift is spent, so an
  // account whose gift is gone sorts last and the next account takes over.
  const expiry = (s: TokenRhythmTenantStatus): number => {
    const at = s.credits?.summary?.nextExpiryAt;
    if (!at) return Number.POSITIVE_INFINITY;
    const t = Date.parse(at);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return pool.sort((a, b) => expiry(a) - expiry(b));
}

/**
 * Tenants that answered "insufficient balance".
 *
 * They are left out for a while — the wallet the gateway has cached still
 * says there is money on them, and that answer is a few minutes old. After
 * that the platform's own numbers decide again.
 */
const outOfMoney = new Map<number, number>();

/** How long a tenant stays out after it says it has no money. */
const OUT_OF_MONEY_TTL_MS = 10 * 60 * 1000;

/** Remember that a tenant has no money left. */
export function markTenantOutOfMoney(index: number): void {
  outOfMoney.set(index, Date.now());
}

/** Forget the tenants that ran out of money — the check is stale by now. */
function pruneOutOfMoney(): void {
  const cutoff = Date.now() - OUT_OF_MONEY_TTL_MS;
  for (const [index, at] of outOfMoney) {
    if (at < cutoff) outOfMoney.delete(index);
  }
}

/* ------------------------------------------------------------------ *
 * The cached view
 * ------------------------------------------------------------------ */

/** The cached view, one per provider. */
const caches = new Map<string, { at: number; statuses: TokenRhythmTenantStatus[] }>();

/**
 * The tenants' status, from a recent answer.
 *
 * Asking the platform for every wallet on every request would be slow, so the
 * answer is kept for a few minutes. A request that has to know which tenant to
 * use asks for the cached view.
 */
export async function tokenRhythmStatuses(
  providerId = "tokenrhythm",
  maxAgeMs = 300_000,
): Promise<TokenRhythmTenantStatus[]> {
  pruneOutOfMoney();
  const cached = caches.get(providerId);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.statuses;
  const statuses = await tenantStatuses(providerId);
  caches.set(providerId, { at: Date.now(), statuses });
  return statuses;
}

/** Throw the cached view away, so the next question goes to the platform. */
export function resetTokenRhythmStatusCache(): void {
  caches.clear();
}

/* ------------------------------------------------------------------ *
 * The credential
 * ------------------------------------------------------------------ */

/** 面板上的「快到期」提示线（毫秒）。cookie 只能用三十天。 */
const WARN_MS = 3 * 24 * 3600 * 1000;

/**
 * 凭据的状态：这个 provider 有几个租户，其中几个还登着。
 *
 * 租户各有各的会话，所以这里报的是这一组会话的整体情况。
 */
export function tokenRhythmStatus(providerId = "tokenrhythm"): Record<string, unknown> {
  const tenants = tokenRhythmTenants(providerId);
  if (!tenants.length) {
    return { source: sessionId(providerId), status: "anonymous", error: "no tenant" };
  }
  const sessions = tenants
    .map((t) => loadSession(t.index, providerId))
    .filter((s): s is TokenRhythmSession => s !== null);
  const expiresAtMs = sessions.map((s) => s.expiresAtMs).sort((a, b) => a - b)[0] ?? 0;
  const remainingMs = expiresAtMs ? expiresAtMs - Date.now() : 0;
  return {
    source: sessionId(providerId),
    status: sessions.length ? "authenticated" : "anonymous",
    tenants: tenants.length,
    loggedIn: sessions.length,
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : "",
    remainingSec: Math.round(remainingMs / 1000),
    warning: remainingMs > 0 && remainingMs < WARN_MS,
  };
}
