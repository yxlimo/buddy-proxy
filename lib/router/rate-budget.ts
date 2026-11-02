// lib/router/rate-budget.ts — one wait budget per client request.
//
// Several places wait before trying again: the TPM wait in underPolicy, the
// Qoder queue (403/429), the legacy protocol's "all backends failed", the
// TokenRhythm relay that says it is busy. The client waits for all of them
// added up — over every target of the root route and every account of each
// platform — so they all draw on the same budget, the one on the request
// (`rateWait`), instead of each loop counting its own.

import type { CallLife } from "./upstreams/policy.ts";
import { abortableSleep } from "./request-life.ts";

/**
 * 一个请求里总共最多等多久（毫秒）。
 *
 * 「等得起」说的是一分钟以内，不是「随便多久」。按整个请求算：主路由的每个
 * target、平台的每个账号、每一种重试共用这一份 —— 客户端等的是它们加起来的时间。
 */
export const RATE_WAIT_BUDGET_MS = 60_000;

/** The request's ledger, or a fresh one for a caller that has none (unit tests). */
export function ledgerOf(life: CallLife): { spentMs: number } {
  return life.rateWait ?? { spentMs: 0 };
}

/**
 * Wait `ms` out of the request's budget.
 *
 * `false` when the wait does not fit what is left: the caller throws the error
 * it was going to retry. Rejects with the signal's reason when the client goes
 * while waiting. The time actually waited is booked either way.
 */
export async function waitOnBudget(
  ms: number,
  life: CallLife,
  ledger: { spentMs: number } = ledgerOf(life),
): Promise<boolean> {
  if (ledger.spentMs + ms > RATE_WAIT_BUDGET_MS) return false;
  // The client is already gone: no wait, and no retry either.
  if (life.signal?.aborted) throw life.signal.reason;
  const began = Date.now();
  try {
    await abortableSleep(ms, life.signal);
  } finally {
    ledger.spentMs += Date.now() - began;
  }
  return true;
}
