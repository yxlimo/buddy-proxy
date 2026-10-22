// lib/tokenrhythm/wallet.ts — what the accounts have left, and which one to use.
//
// TokenRhythm hands out the credits in batches: the ones that expire first are
// used first, and the money that was paid in is used last. So the pick is by
// the date the next batch expires — the platform moves that date on its own as
// a batch is used up, and the account switches by itself.

import fs from "node:fs";

import {
  TOKENRHYTHM_API_BASE,
  TokenRhythmError,
  loadSession,
  login,
  sessionFor,
  sessionPath,
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

/** Ask the platform for something, with the session cookie. */
async function apiGet<T>(path: string, session: TokenRhythmSession): Promise<T> {
  const r = await fetch(`${TOKENRHYTHM_API_BASE}${path}`, {
    headers: {
      Cookie: session.cookie,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (r.status === 401 || r.status === 403) {
    // The session is gone: drop it, so the next call logs in again.
    try {
      fs.rmSync(sessionPath(session.index), { force: true });
    } catch {
      /* nothing to clean up */
    }
    throw new TokenRhythmError("登录已过期", 503);
  }
  if (!r.ok) {
    throw new TokenRhythmError(`接口失败（HTTP ${r.status}）：${body?.message ?? text.slice(0, 200)}`);
  }
  if (body && typeof body.code !== "undefined" && body.code !== 0) {
    throw new TokenRhythmError(`接口返回 code=${body.code}：${body.message ?? ""}`);
  }
  if (!body || typeof body.data === "undefined") {
    throw new TokenRhythmError("接口响应结构异常，缺少 data 字段");
  }
  return body.data as T;
}

export async function wallet(session: TokenRhythmSession): Promise<TokenRhythmWallet> {
  const data = await apiGet<any>("/api/wallet/summary", session);
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
  const data = await apiGet<any>(
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
  wallet: TokenRhythmWallet | null;
  credits: TokenRhythmCredits | null;
  error: string | null;
}

const mask = (account: string): string =>
  account.length <= 4 ? "***" : `${account.slice(0, 3)}***${account.slice(-2)}`;

/** What every tenant has, as far as the platform says. */
export async function tenantStatuses(): Promise<TokenRhythmTenantStatus[]> {
  const tenants = tokenRhythmTenants();
  const out: TokenRhythmTenantStatus[] = [];
  for (const tenant of tenants) {
    const status: TokenRhythmTenantStatus = {
      index: tenant.index,
      account: mask(tenant.account),
      name: "",
      hasKey: Boolean(tenant.apiKey),
      wallet: null,
      credits: null,
      error: null,
    };
    try {
      const session = await sessionFor(tenant.index);
      status.name = session.name;
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
  const usable = statuses.filter((s) => !s.error && s.hasKey && (s.wallet?.availableCny ?? 0) > 0);
  if (!usable.length) return null;

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
  return pool.sort((a, b) => expiry(a) - expiry(b))[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * The cached view
 * ------------------------------------------------------------------ */

let cache: { at: number; statuses: TokenRhythmTenantStatus[] } | null = null;

/**
 * The tenants' status, from a recent answer.
 *
 * Asking the platform for every wallet on every request would be slow, so the
 * answer is kept for a few minutes. A request that has to know which tenant to
 * use asks for the cached view.
 */
export async function tokenRhythmStatuses(maxAgeMs = 300_000): Promise<TokenRhythmTenantStatus[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.statuses;
  const statuses = await tenantStatuses();
  cache = { at: Date.now(), statuses };
  return statuses;
}

/** Throw the cached view away, so the next question goes to the platform. */
export function resetTokenRhythmStatusCache(): void {
  cache = null;
}
