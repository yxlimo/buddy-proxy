// lib/minimax/credits.ts — what the MiniMax accounts have left.
//
// Both things here are read with the account's own session:
//
//   the account balance   GET /account/query_balance
//   the token plan quota  GET /backend/account/token_plan/remains_percent
//
// The token plan is the subscription: its usage runs in a five-hour window and
// a weekly one, and what is left of each is a percentage. The balance is the
// money on the platform account — the cash, the vouchers and the credits, with
// the credits being the ones that were given rather than paid for.

import { configString } from "../config.ts";

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
 * A percentage the platform reports as a string: "0%", "100%", "-1%".
 *
 * "-1%" means the platform has no number for it (an unlimited plan), so it
 * counts as zero rather than as a negative percentage.
 */
function percent(raw: unknown): number {
  const text = String(raw ?? "").replace("%", "").trim();
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The token plan's usage, read with the account's own session.
 *
 * The Code client reads the plan from `/backend/account/token_plan/remains_percent`
 * with the session, and that works for every account — the session is what the
 * account logs in with. There is no second way to read it.
 *
 * The platform reports the window as "how much is *used*" out of the total, so
 * what is left is the difference between the two.
 */
export async function fetchMiniMaxTokenPlanWithSession(
  accessToken: string,
  region: MiniMaxRegion = "cn",
): Promise<MiniMaxTokenPlan | null> {
  try {
    const r = await fetch(`${minimaxApiHost(region)}/backend/account/token_plan/remains_percent`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const body: any = await r.json().catch(() => null);
    if (!body || body?.base_resp?.status_code !== 0) return null;
    const rows = Array.isArray(body.model_remains) ? body.model_remains : [];
    return {
      windows: rows.map((row: any) => ({
        model: String(row?.model_name ?? ""),
        intervalPercent: percent(row?.current_interval_total_percent) - percent(row?.current_interval_used_percent),
        weeklyPercent: percent(row?.current_weekly_total_percent) - percent(row?.current_weekly_used_percent),
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
