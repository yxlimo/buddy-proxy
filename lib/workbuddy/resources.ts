// lib/workbuddy/resources.ts — the account's real credit ledger.
//
// The panel used to show a made-up "daily check-in" batch. The platform keeps
// the truth in two calls: a summary of the credit groups (how much is left in
// each kind of credit) and the lots those credits come in (a package, a gift,
// a purchase — each with its own expiry).

import { loadSession as loadWorkBuddySession } from "./auth.ts";
import { dataOf, workbuddyApi, type ApiResult } from "./api.ts";

/** The summary endpoint. Note: this one has no /v2 prefix. */
const SUMMARY_PATH = "/billing/meter/get-user-resource-summary";
/** The lots endpoint. It answers with one page of accounts. */
const PACKAGES_PATH = "/billing/meter/get-user-resource-free-packages";

/** One kind of credit: what the plan brings, what was bought, what was given. */
export interface WorkBuddyCreditGroup {
  kind: string;
  /** The platform's own Chinese name for the group. */
  name: string;
  total: number;
  remaining: number;
  used: number;
  /** How many lots the group is made of. */
  packages: number;
}

/** One batch of credits, with its own expiry and its own cycle. */
export interface WorkBuddyCreditLot {
  id: string;
  name: string;
  remaining: number;
  size: number;
  /** Unix milliseconds; 0 when the platform gives no expiry. */
  expiresAt: number;
  /** Unix milliseconds; when this cycle ends (plan credits reset on it). */
  cycleEndsAt: number;
  active: boolean;
}

export interface WorkBuddyResources {
  /** What is left in total; the platform's own number. */
  total: number;
  /** The plan the account is on (体验版 / 专业版…). */
  plan: string;
  paid: boolean;
  groups: WorkBuddyCreditGroup[];
  lots: WorkBuddyCreditLot[];
}

/**
 * The WorkBuddy part of the health snapshot.
 *
 * Two things, and they are not the same: the check-in status (a streak) and
 * the ledger (what is left of the credits).
 */
export interface WorkBuddySnapshotEntry {
  /** The check-in status; the shape is lib/workbuddy/credits.ts's. */
  credits: unknown;
  /** The ledger; null when the platform did not answer. */
  resources?: WorkBuddyResources | null;
}

/** A number the platform sends as a string; a broken one is zero. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The platform's own timestamps are local time in China (UTC+8), written as
 * "YYYY-MM-DD HH:mm:ss" — not UTC and not an epoch. So the offset is pinned
 * here: without it the expiry of a lot would be eight hours off.
 */
function localTime(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || !value.trim()) return 0;
  const t = Date.parse(value.trim().replace(" ", "T") + "+08:00");
  return Number.isFinite(t) ? t : 0;
}

/** The lots out of the packages answer. */
function parseLots(packagesData: any): WorkBuddyCreditLot[] {
  const data = dataOf(packagesData);
  const accounts = Array.isArray(data?.Accounts) ? data.Accounts : [];
  const lots: WorkBuddyCreditLot[] = [];
  for (const a of accounts) {
    if (!a) continue;
    lots.push({
      id: String(a.ResourceId ?? ""),
      name: String(a.PackageName ?? ""),
      // CapacityRemain is always 0 on the platform; the cycle fields carry
      // the truth.
      remaining: num(a.CycleCapacityRemain),
      size: num(a.CycleCapacitySize),
      expiresAt: localTime(a.ExpiredTime),
      cycleEndsAt: localTime(a.CycleEndTime),
      // The platform marks a lot valid with 0 and anything else as no longer
      // valid; only 0 and 3 have been seen so far.
      active: num(a.Status) === 0,
    });
  }
  return lots;
}

/**
 * The ledger, out of the two answers the platform gives.
 *
 * Pure: it takes the JSON and answers with the ledger. The packages part may
 * be missing — then the ledger has the totals but no lots.
 */
export function parseWorkBuddyResources(summaryData: any, packagesData: any = null): WorkBuddyResources {
  const summary = dataOf(summaryData);
  const groups: WorkBuddyCreditGroup[] = [];
  const raw = Array.isArray(summary?.CreditGroups) ? summary.CreditGroups : [];
  for (const g of raw) {
    if (!g) continue;
    groups.push({
      kind: String(g.Kind ?? ""),
      name: String(g.Name ?? ""),
      total: num(g.CycleTotalCapacity),
      remaining: num(g.CycleRemainCapacity),
      used: num(g.CycleUsedCapacity),
      packages: num(g.TotalCount),
    });
  }
  const left = groups.reduce((sum, g) => sum + g.remaining, 0);
  const given = summary?.TotalCredits;
  // The platform's own total wins. Only when it is missing do the groups
  // speak — otherwise a missing field would look like an empty account.
  const total = given === undefined || given === null || given === "" ? left : num(given);
  return {
    total,
    plan: String(summary?.SubscriptionPackageName ?? ""),
    paid: summary?.IsPaidUser === true,
    groups,
    lots: parseLots(packagesData),
  };
}

/** How the platform is asked for the ledger. */
export type WorkBuddyApiCall = (path: string, body?: unknown) => Promise<ApiResult>;

/**
 * The ledger, from the platform.
 *
 * Null means "unknown" — the account has no session, the platform refused, or
 * the answer was empty. It never means "no credits".
 */
export async function fetchWorkBuddyResources(providerId = "workbuddy-cn"): Promise<WorkBuddyResources | null> {
  const session = loadWorkBuddySession(providerId);
  if (!session) return null;
  const call: WorkBuddyApiCall = (path, body) => workbuddyApi(session, path, "POST", body ?? {}, providerId);
  return fetchWorkBuddyResourcesWith(call);
}

/**
 * The ledger, with the platform call handed in.
 *
 * Split out so the parsing can be tested without a network: the caller
 * decides how the two answers come back.
 */
export async function fetchWorkBuddyResourcesWith(call: WorkBuddyApiCall): Promise<WorkBuddyResources | null> {
  let summary: ApiResult;
  try {
    summary = await call(SUMMARY_PATH, {});
  } catch {
    return null;
  }
  if (!summary || summary.status !== 200) return null;
  const data = dataOf(summary.body);
  if (!data) return null;

  // The lots are asked for by the codes the summary hands out.
  const codes = Array.isArray(data.Packages)
    ? data.Packages.map((p: any) => p?.PackageCode).filter((c: any): c is string => typeof c === "string" && c !== "")
    : [];
  let packagesData: any = null;
  if (codes.length) {
    try {
      const res = await call(PACKAGES_PATH, { PageNumber: 1, PageSize: 50, PackageCodes: codes, Status: [] });
      // The lots are a nicety: when they do not come, the totals still do.
      if (res && res.status === 200) packagesData = res.body;
    } catch {
      packagesData = null;
    }
  }
  return parseWorkBuddyResources(data, packagesData);
}
