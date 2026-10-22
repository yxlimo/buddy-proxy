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

import { readEnvString } from "../env.ts";

/** The platform hosts. The key decides which one answers. */
export const MINIMAX_API_HOSTS = {
  global: "https://api.minimaxi.com",
  cn: "https://api.minimax.cn",
} as const;

export type MiniMaxRegion = keyof typeof MINIMAX_API_HOSTS;

export function minimaxApiHost(region: MiniMaxRegion = "cn"): string {
  const explicit = readEnvString("MINIMAX_API_BASE", "");
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

/** The token plan's key, when one is configured. */
export function miniMaxTokenPlanKey(): string | null {
  const key = readEnvString("MINIMAX_TOKEN_PLAN_KEY", "");
  return key || null;
}

/* ------------------------------------------------------------------ *
 * The cached view
 * ------------------------------------------------------------------ */

let planCache: { at: number; plan: MiniMaxTokenPlan | null } | null = null;

/**
 * The token plan's usage, from a recent answer.
 *
 * The health endpoint asks for it on every check, and the platform is not
 * asked more often than it needs to be.
 */
export async function miniMaxTokenPlan(maxAgeMs = 300_000): Promise<MiniMaxTokenPlan | null> {
  const key = miniMaxTokenPlanKey();
  if (!key) return null;
  if (planCache && Date.now() - planCache.at < maxAgeMs) return planCache.plan;
  const plan = await fetchMiniMaxTokenPlan(key);
  planCache = { at: Date.now(), plan };
  return plan;
}
