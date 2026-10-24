// lib/minimax/credits.ts — what the MiniMax accounts have left.
//
// Two different things are asked about here, and they need different
// credentials:
//
//   the account balance   GET /account/query_balance      the OAuth session works
//   the token plan quota  GET /v1/token_plan/remains      needs the API key
//
// The token plan is the subscription: its usage runs in a five-hour window and
// a weekly one, and what is left of each is a percentage. The balance is the
// money on the platform account — the cash, the vouchers and the credits, with
// the credits being the ones that were given rather than paid for.

import { configString } from "../config.ts";
import { readEnvValue } from "../env.ts";
import { getSecret, setSecret } from "../store.ts";
import { providerSecretId } from "../providers.ts";

/** The platform hosts. The key decides which one answers. */
export const MINIMAX_API_HOSTS = {
  global: "https://api.minimaxi.com",
  cn: "https://api.minimax.cn",
} as const;

export type MiniMaxRegion = keyof typeof MINIMAX_API_HOSTS;

export function minimaxApiHost(region: MiniMaxRegion = "cn"): string {
  const explicit = configString("MINIMAX_API_BASE", "");
  if (explicit) return explicit.replace(/\/+$/, "");
  return MINIMAX_API_HOSTS[region];
}

/** The money on the account. */
export interface MiniMaxBalance {
  /** What can be spent. */
  available: number;
  /** The money that was paid in. */
  cash: number;
  /** The vouchers. */
  voucher: number;
  /** The credits — the ones that were given. */
  credit: number;
  /** What is owed. */
  owed: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The account balance.
 *
 * The OAuth session of the MiniMax Code gateway answers this one, so the
 * gateway can report what its own account has without a second credential.
 */
export async function fetchMiniMaxBalance(
  accessToken: string,
  region: MiniMaxRegion = "cn",
): Promise<MiniMaxBalance | null> {
  try {
    const r = await fetch(`${minimaxApiHost(region)}/account/query_balance`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const body: any = await r.json().catch(() => null);
    if (!body || body?.base_resp?.status_code !== 0) return null;
    return {
      available: num(body.available_amount),
      cash: num(body.cash_balance),
      voucher: num(body.voucher_balance),
      credit: num(body.credit_balance),
      owed: num(body.owed_amount),
    };
  } catch {
    return null;
  }
}

/** One model's share of the token plan. */
export interface MiniMaxQuotaWindow {
  /** The name of the group: `general`, `video`, … */
  model: string;
  /** What is left of the five-hour window, in percent. */
  intervalPercent: number;
  /** What is left of the weekly window, in percent. */
  weeklyPercent: number;
  /** When the five-hour window ends. */
  intervalEndsAt: string | null;
  /** When the weekly window ends. */
  weeklyEndsAt: string | null;
  /** How much of the five-hour window is left, in milliseconds. */
  intervalRemainsMs: number;
  /** How much of the weekly window is left, in milliseconds. */
  weeklyRemainsMs: number;
}

export interface MiniMaxTokenPlan {
  windows: MiniMaxQuotaWindow[];
}

const iso = (ms: unknown): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/**
 * The token plan's usage.
 *
 * The plan's key is the API key (`sk-cp-…`), not the OAuth session: the
 * session is for the Code gateway, the key is for the plan.
 */
export async function fetchMiniMaxTokenPlan(
  apiKey: string,
  region: MiniMaxRegion = "cn",
): Promise<MiniMaxTokenPlan | null> {
  try {
    const r = await fetch(`${minimaxApiHost(region)}/v1/token_plan/remains`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const body: any = await r.json().catch(() => null);
    if (!body || body?.base_resp?.status_code !== 0) return null;
    const rows = Array.isArray(body.model_remains) ? body.model_remains : [];
    return {
      windows: rows.map((row: any) => ({
        model: String(row?.model_name ?? ""),
        intervalPercent: num(row?.current_interval_remaining_percent),
        weeklyPercent: num(row?.current_weekly_remaining_percent),
        intervalEndsAt: iso(row?.end_time),
        weeklyEndsAt: iso(row?.weekly_end_time),
        intervalRemainsMs: num(row?.remains_time),
        weeklyRemainsMs: num(row?.weekly_remains_time),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * The token plan's key, when one is configured.
 *
 * It is a credential, so the environment wins: a key that was rotated in .env
 * has to take effect. The database holds a copy, so the service still works
 * when the .env file is not there, and the panel can read what is configured.
 */
export function miniMaxTokenPlanKey(providerId = "minimax"): string | null {
  // The plan key belongs to the provider: two accounts have two plans.
  const id = providerSecretId(providerId, "plan");
  const fromEnv = providerId === "minimax" ? readEnvValue("MINIMAX_TOKEN_PLAN_KEY") || "" : "";
  if (fromEnv) {
    if (getSecret<string>(id) !== fromEnv) {
      setSecret(id, "key", { key: fromEnv });
    }
    return fromEnv;
  }
  const stored = getSecret<unknown>(id);
  if (typeof stored === "string" && stored) return stored;
  if (stored && typeof stored === "object" && "key" in stored) return String((stored as any).key ?? "");
  return null;
}

/** Where the token plan's key is kept. */
/** The plan key of the built-in provider, for the old id. */
const TOKEN_PLAN_KEY_ID = "key:minimax-token-plan";

/* ------------------------------------------------------------------ *
 * The cached view
 * ------------------------------------------------------------------ */

// The plan of each provider is cached separately: they are different accounts.

/**
 * The token plan's usage, from a recent answer.
 *
 * The health endpoint asks for it on every check, and the platform is not
 * asked more often than it needs to be.
 */
export async function miniMaxTokenPlan(
  maxAgeMs = 300_000,
  providerId = "minimax",
): Promise<MiniMaxTokenPlan | null> {
  const key = miniMaxTokenPlanKey(providerId);
  if (!key) return null;
  const cached = planCaches.get(providerId);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.plan;
  const plan = await fetchMiniMaxTokenPlan(key);
  planCaches.set(providerId, { at: Date.now(), plan });
  return plan;
}

/** The plan of each provider, cached separately: they are different accounts. */
const planCaches = new Map<string, { at: number; plan: MiniMaxTokenPlan | null }>();
