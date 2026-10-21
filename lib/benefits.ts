// lib/benefits.ts — the daily benefits of the China accounts.
//
// Both upstreams hand out credits for showing up, and both do it through
// endpoints the desktop app calls:
//
//   WorkBuddy  POST /v2/billing/meter/daily-checkin           the check-in
//              GET  /v2/activity/growth/...                    the growth centre
//
//   Qoder      GET  /sash/api/v1/me/campaigns                  the campaigns
//              POST /sash/api/v1/me/campaigns/{id}/claim      the claim
//
// The Qoder campaigns list comes back empty without the `Cosy-ClientType`
// header, so that one is not optional.
//
// Everything here is idempotent: claiming twice answers "already done" rather
// than doing it again, so the runner can be called on a timer without keeping
// a state file of its own.

import crypto from "node:crypto";
import os from "node:os";
import {
  loadSession as loadQoderSession,
  deviceIdentity,
  ENDPOINTS,
  type QoderRegion,
  type QoderSession,
} from "./qoder-auth.ts";
import { loadSession as loadWorkBuddySession, workbuddyDeviceId, type WorkBuddySession } from "./workbuddy-auth.ts";
import { readEnvString } from "./env.ts";

/** The host the account's own API is on. */
function workBuddyApiBase(): string {
  const override = readEnvString("WORKBUDDY_CHAT_BASE", "").replace(/\/+$/, "");
  if (override) return override;
  const session = loadWorkBuddySession("cn");
  const host = session?.domain || "www.workbuddy.cn";
  return `https://${host}`;
}

/** The China accounts that hand out credits. */
export type BenefitUpstream = "workbuddy-cn" | "qoder-cn" | "qoder-global";

export interface BenefitOutcome {
  upstream: BenefitUpstream;
  ok: boolean;
  /** Credits that were actually credited by this run. */
  credits: number;
  /** One line per step, so a run says what it did. */
  report: string[];
  /** When the run finished. */
  at: string;
}

interface ApiResult {
  status: number;
  body: any;
}

/** The business code the API reports, or 0 when the call itself failed. */
function businessCode(body: any): number {
  const code = body?.code;
  return typeof code === "number" ? code : 0;
}

/** The payload of a successful answer — the API wraps it in `data`. */
function dataOf(body: any): any {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

function clientToken(): string {
  return `u-${crypto.randomUUID()}`;
}

/* ------------------------------------------------------------------ *
 * WorkBuddy
 * ------------------------------------------------------------------ */


function workbuddyHeaders(session: WorkBuddySession): Record<string, string> {
  const deviceId = workbuddyDeviceId(session);
  return {
    Accept: "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
    "X-User-Id": session.uid,
    "User-Agent": "WorkBuddy",
    "X-Domain": session.domain,
    ...(deviceId ? { "X-Device-Id": deviceId } : {}),
  };
}

/** The growth centre of the account's own API. */
const GROWTH = "/v2/activity/growth";

/** Call the account's API. The path is the whole path, the growth centre included. */
async function workbuddyApi(
  session: WorkBuddySession,
  path: string,
  method: "GET" | "POST",
  payload?: unknown,
): Promise<ApiResult> {
  try {
    const res = await fetch(`${workBuddyApiBase()}${path}`, {
      method,
      headers: workbuddyHeaders(session),
      body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { msg: (e as Error).message } };
  }
}

/** The check-in itself: the status first, then the claim if it is not done. */
async function workbuddyCheckin(session: WorkBuddySession, report: string[]): Promise<number> {
  const status = await workbuddyApi(session, "/v2/billing/meter/checkin-activity-status", "POST");
  if (status.status !== 200) {
    report.push(`查签到状态失败（HTTP ${status.status}）`);
    return 0;
  }
  const info = dataOf(status.body) ?? {};
  if (info.today_checked_in) {
    report.push(`今日已签到（连签 ${info.streak_days ?? "?"} 天）`);
    return 0;
  }
  const claim = await workbuddyApi(session, "/v2/billing/meter/daily-checkin", "POST");
  // 10001 means the day was already claimed — a normal outcome, not a failure.
  if (claim.status === 400 && businessCode(claim.body) === 10001) {
    report.push("今日已签到");
    return 0;
  }
  if (claim.status < 200 || claim.status >= 300) {
    report.push(`签到失败（HTTP ${claim.status}）：${claim.body?.msg ?? ""}`);
    return 0;
  }
  const got = Number(dataOf(claim.body)?.credit ?? dataOf(claim.body)?.today_credit ?? 0);
  report.push(`签到成功 +${got} 积分`);
  return Number.isFinite(got) ? got : 0;
}

/**
 * The Buddy that travels somewhere and brings a gift back.
 */
async function workbuddyTravel(session: WorkBuddySession, report: string[]): Promise<number> {
  let credits = 0;
// 1. The Buddy that travels somewhere and brings a gift back.
const travel = await workbuddyApi(session, `${GROWTH}/buddy/travel/status`, "GET");
if (travel.status === 200) {
  const state = dataOf(travel.body) ?? {};
  if (state.state === "arrived" && state.record_id) {
    const claim = await workbuddyApi(session, `${GROWTH}/buddy/travel/claim`, "POST", { record_id: state.record_id });
    if (claim.status >= 200 && claim.status < 300) {
      const got = Number(dataOf(claim.body)?.reward_credit ?? 0);
      credits += got;
      report.push(`领旅行礼物 +${got} 积分`);
    } else {
      report.push(`领旅行礼物失败：${claim.body?.msg ?? `HTTP ${claim.status}`}`);
    }
  }
  // Send the Buddy out again, so there is a gift to collect tomorrow.
  if (!state.daily_limit_reached && state.state !== "traveling") {
    const config = await workbuddyApi(session, `${GROWTH}/buddy/travel/config`, "GET");
    const locations = dataOf(config.body)?.locations;
    if (Array.isArray(locations) && locations[0]?.id) {
      const depart = await workbuddyApi(session, `${GROWTH}/buddy/travel/depart`, "POST", { location_id: locations[0].id });
      if (depart.status >= 200 && depart.status < 300) {
        const name = dataOf(depart.body)?.location?.name ?? "?";
        report.push(`派 Buddy 去${name}`);
      } else {
        report.push(`派 Buddy 失败：${depart.body?.msg ?? `HTTP ${depart.status}`}`);
      }
    }
  }
}

  return credits;
}

/**
 * The tasks: take the ones that are not taken, then claim the finished ones.
 */
async function workbuddyTasks(session: WorkBuddySession, report: string[]): Promise<number> {
  let credits = 0;
// 2. The tasks: take the ones that are not taken, then claim the finished ones.
const tasks = await workbuddyApi(session, `${GROWTH}/tasks`, "GET");
const list = Array.isArray(dataOf(tasks.body)?.tasks) ? (dataOf(tasks.body).tasks as any[]) : [];
const titles = new Map<string, string>();
for (const t of list) titles.set(t.task_code, t.title ?? t.task_code);
const pending = list
  .filter((t) => t.task_code && !t.locked && t.accept_status === "not_accepted")
  .map((t) => t.task_code as string);
if (pending.length) {
  // The endpoint takes the codes in one array, in batches.
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    const accept = await workbuddyApi(session, `${GROWTH}/tasks/accept`, "POST", { task_codes: batch });
    const results = Array.isArray(dataOf(accept.body)?.results) ? (dataOf(accept.body).results as any[]) : [];
    let ok = 0;
    for (const r of results) {
      if (r.status === "error") {
        report.push(`接任务「${titles.get(r.task_code) ?? r.task_code}」失败：${r.message ?? ""}`);
      } else {
        ok++;
      }
    }
    if (!results.length) ok = accept.status >= 200 && accept.status < 300 ? batch.length : 0;
    report.push(`接了 ${ok} 个任务`);
  }
}
for (const t of list) {
  if (t.locked || t.accept_status !== "completed" || !t.task_code) continue;
  const claim = await workbuddyApi(session, `/tasks/${t.task_code}/claim`, "POST", {});
  if (claim.status >= 200 && claim.status < 300) {
    if (dataOf(claim.body)?.already_claimed) {
      report.push(`任务奖「${titles.get(t.task_code)}」已领过`);
      continue;
    }
    const got = Number(dataOf(claim.body)?.credit ?? t.reward_credit ?? 0);
    const energy = Number(dataOf(claim.body)?.energy ?? t.reward_energy ?? 0);
    credits += got;
    report.push(`领任务奖「${titles.get(t.task_code)}」+${got} 积分${energy ? ` +${energy} 能量` : ""}`);
  } else {
    report.push(`领任务奖「${titles.get(t.task_code)}」失败：${claim.body?.msg ?? `HTTP ${claim.status}`}`);
  }
}

  return credits;
}

/**
 * The days of the month that were not active, and so can be made up.
 *
 * The calendar answers with a cell per day and a score; a day with no score
 * was not active. The rule follows the desktop app: this month, before today,
 * after the activity started, and not already made up — the most recent break
 * first, so the streak comes back as soon as possible.
 */
const ACTIVITY_START = "2026-06-17";

function pickMissedDays(heatmap: any, streak: any): string[] {
  const today = heatmap?.today?.date;
  if (typeof today !== "string") return [];
  const cells: any[] = Array.isArray(heatmap?.cells) ? heatmap.cells : [];
  const madeUp = new Set(
    Array.isArray(streak?.makeup_dates) ? streak.makeup_dates.map((d: unknown) => String(d)) : [],
  );
  // The first of the month, and never before the activity started.
  const monthStart = `${today.slice(0, 7)}-01`;
  const start = monthStart > ACTIVITY_START ? monthStart : ACTIVITY_START;
  const missed: string[] = [];
  for (const cell of cells) {
    const date = cell?.date;
    if (typeof date !== "string") continue;
    if (date < start || date >= today) continue;
    if (cell?.score !== 0) continue;
    if (madeUp.has(date)) continue;
    missed.push(date);
  }
  return missed.sort().reverse();
}

/**
 * The streak: use a make-up card for a day that was missed, then redeem the tier it unlocked.
 */
async function workbuddyStreak(session: WorkBuddySession, report: string[]): Promise<number> {
  let credits = 0;
// 3. The streak: use a make-up card for a day that was missed, then redeem
//    the tier the streak unlocked.
const streak = await workbuddyApi(session, `${GROWTH}/streak`, "GET");
const cards = Number(dataOf(streak.body)?.makeup_cards?.balance ?? 0);
const days = Number(dataOf(streak.body)?.streak?.days ?? 0);
if (cards > 0) {
  const heatmap = await workbuddyApi(session, `${GROWTH}/heatmap`, "GET");
  const broken = pickMissedDays(dataOf(heatmap.body), dataOf(streak.body)?.streak);
  for (const day of broken.slice(0, cards)) {
    const use = await workbuddyApi(session, `${GROWTH}/makeup-cards/use`, "POST", { target_date: day });
    if (use.status >= 200 && use.status < 300) {
      report.push(`补登 ${day}`);
    } else {
      report.push(`补登 ${day} 失败：${use.body?.msg ?? `HTTP ${use.status}`}`);
    }
  }
}
const summary = await workbuddyApi(session, `${GROWTH}/redeem/summary`, "GET");
const tiers: Array<[string, string, string]> = [
  ["7d", "starter_status", "入门"],
  ["14d", "advanced_status", "进阶"],
  ["28d", "legendary_status", "巅峰"],
];
for (const [tier, key, label] of tiers) {
  const state = dataOf(summary.body)?.[key];
  // Only "claimed" and "locked" are known; anything else may be redeemable.
  if (!state || state === "claimed" || state === "locked") continue;
  const redeem = await workbuddyApi(session, `${GROWTH}/redeem`, "POST", { tier, client_token: clientToken() });
  if (redeem.status >= 200 && redeem.status < 300) {
    const got = Number(dataOf(redeem.body)?.credit_granted ?? 0);
    credits += got;
    report.push(`连登兑换「${label}」+${got} 积分`);
  } else {
    report.push(`连登兑换「${label}」未解锁或失败：${redeem.body?.msg ?? `HTTP ${redeem.status}`}`);
  }
}
if (days > 0) report.push(`连签 ${days} 天`);

  return credits;
}

/**
 * The blind box. A draw cannot be undone, so only one is opened per run.
 */
async function workbuddyLottery(session: WorkBuddySession, report: string[]): Promise<number> {
  let credits = 0;
// 4. The blind box. The endpoint needs the anti-replay token, and a draw
//    cannot be undone, so only one is opened per run.
const chances = await workbuddyApi(session, `${GROWTH}/lottery/chances`, "GET");
const balance = Number(dataOf(chances.body)?.balance ?? 0);
if (balance > 0) {
  const draw = await workbuddyApi(session, `${GROWTH}/lottery/draw`, "POST", { client_token: clientToken() });
  if (draw.status >= 200 && draw.status < 300) {
    const prize = String(dataOf(draw.body)?.prize_name ?? dataOf(draw.body)?.prize ?? "未知");
    report.push(`开盲盒：${prize}${dataOf(draw.body)?.need_address ? "（实物奖，需自己填收件信息）" : ""}`);
  } else {
    report.push(`开盲盒失败：${draw.body?.msg ?? `HTTP ${draw.status}`}`);
  }
}

  return credits;
}

/**
 * The growth centre: the gifts, the tasks, the streak and the blind box.
 *
 * The order matters: the tasks hand out the lottery chances and the energy the
 * later steps use.
 */
async function workbuddyGrowthCentre(session: WorkBuddySession, report: string[]): Promise<number> {
  let credits = 0;
  credits += await workbuddyTravel(session, report);
  credits += await workbuddyTasks(session, report);
  credits += await workbuddyStreak(session, report);
  credits += await workbuddyLottery(session, report);
  return credits;
}

/** Take the WorkBuddy credits that are waiting. */
export async function runWorkBuddyBenefits(): Promise<BenefitOutcome> {
  const report: string[] = [];
  const session = loadWorkBuddySession("cn");
  if (!session) {
    return { upstream: "workbuddy-cn", ok: false, credits: 0, report: ["没有 WorkBuddy 登录态"], at: new Date().toISOString() };
  }
  let credits = 0;
  try {
    credits += await workbuddyCheckin(session, report);
    credits += await workbuddyGrowthCentre(session, report);
  } catch (e) {
    report.push(`异常：${(e as Error).message}`);
  }
  return { upstream: "workbuddy-cn", ok: true, credits, report, at: new Date().toISOString() };
}

/* ------------------------------------------------------------------ *
 * Qoder
 * ------------------------------------------------------------------ */

/**
 * The Qoder activity service is the same service in both regions; only the
 * host differs.
 */
const QODER_CLAIM_BASE: Record<QoderRegion, string> = {
  cn: ENDPOINTS.cn.openapi,
  global: ENDPOINTS.global.openapi,
};

function qoderClaimHeaders(session: QoderSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    "User-Agent": "Qoder/claim",
    // Without this one the server answers with an empty list of campaigns.
    "Cosy-ClientType": "10",
  };
  // The machine identity the desktop app sends along; the server is happier
  // with a request that looks like the app's. It is the account's own
  // fingerprint, so it never links two accounts.
  const identity = deviceIdentity("cn");
  if (identity) {
    headers["Cosy-MachineId"] = identity.machineId;
    headers["Cosy-MachineToken"] = identity.machineToken;
    headers["Cosy-MachineType"] = identity.machineType;
    headers["Cosy-MachineCode"] = identity.machineCode;
  }
  headers["Cosy-MachineOS"] = `${os.arch()}_linux`;
  headers["Cosy-MachineHostname"] = os.hostname();
  return headers;
}

async function qoderCall(
  session: QoderSession,
  path: string,
  method: "GET" | "POST",
  region: QoderRegion = "cn",
): Promise<ApiResult> {
  try {
    const res = await fetch(`${QODER_CLAIM_BASE[region]}${path}`, {
      method,
      headers: qoderClaimHeaders(session),
      body: method === "POST" ? "" : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { msg: (e as Error).message } };
  }
}

/**
 * What the WorkBuddy account has in credits.
 *
 * The check-in status carries the numbers, and asking for it does not check
 * in: the check-in is the other endpoint.
 */
export interface WorkBuddyCredits {
  /** The credits the daily check-in hands out. */
  daily: number;
  /** What today's check-in brought in. */
  today: number;
  /** The credits the account has collected in total. */
  total: number;
  /** How many days in a row the account has shown up. */
  streakDays: number;
  /** Whether today is already checked in. */
  checkedIn: boolean;
}

export async function fetchWorkBuddyCredits(): Promise<WorkBuddyCredits | null> {
  const session = loadWorkBuddySession("cn");
  if (!session) return null;
  try {
    const res = await workbuddyApi(session, "/v2/billing/meter/checkin-activity-status", "POST");
    const data = dataOf(res.body);
    if (!data) return null;
    return {
      daily: Number(data.daily_credit ?? 0),
      today: Number(data.today_credit ?? 0),
      total: Number(data.total_credits ?? 0),
      streakDays: Number(data.streak_days ?? 0),
      checkedIn: data.today_checked_in === true,
    };
  } catch {
    return null;
  }
}

/** Take the Qoder campaign benefits that are waiting. */
export async function runQoderBenefits(region: QoderRegion = "cn"): Promise<BenefitOutcome> {
  const upstream = region === "cn" ? "qoder-cn" : "qoder-global";
  const report: string[] = [];
  const session = loadQoderSession(region);
  if (!session) {
    return { upstream, ok: false, credits: 0, report: ["没有 Qoder 登录态"], at: new Date().toISOString() };
  }
  let credits = 0;
  try {
    const campaigns = await qoderCall(session, "/sash/api/v1/me/campaigns", "GET", region);
    if (campaigns.status !== 200) {
      report.push(`查活动失败（HTTP ${campaigns.status}）`);
      return { upstream, ok: false, credits, report, at: new Date().toISOString() };
    }
    const rows: any[] = Array.isArray(campaigns.body?.campaigns) ? campaigns.body.campaigns : [];
    if (!rows.length) {
      report.push("没有可领的活动");
    }
    const now = Math.floor(Date.now() / 1000);
    let claimable = 0;
    let creditCampaigns = 0;
    for (const row of rows) {
      if (row.actionType !== "CLAIM_BENEFIT") continue;
      creditCampaigns += 1;
      // The window is in seconds, not milliseconds.
      const start = typeof row.startAt === "number" ? row.startAt : 0;
      const end = typeof row.endAt === "number" ? row.endAt : 0;
      if (start && now < start) continue;
      if (end && now >= end) continue;
      if (row.claimStatus === "CLAIMED") {
        report.push(`活动「${row.campaignKey ?? row.campaignId}」已领过`);
        continue;
      }
      if (row.claimStatus !== "CLAIMABLE") continue;
      claimable += 1;
      const claim = await qoderCall(
        session,
        `/sash/api/v1/me/campaigns/${row.campaignId}/claim`,
        "POST",
        region,
      );
      if (claim.status >= 200 && claim.status < 300) {
        const amount = Number(row.benefit?.amount ?? 0);
        credits += amount;
        report.push(`领活动「${row.campaignKey ?? row.campaignId}」+${amount} ${row.benefit?.kind ?? ""}`);
      } else {
        report.push(`领活动「${row.campaignKey ?? row.campaignId}」失败：${claim.body?.msg ?? `HTTP ${claim.status}`}`);
      }
    }
    if (!creditCampaigns) report.push("没有可领积分的活动");
  } catch (e) {
    report.push(`异常：${(e as Error).message}`);
  }
  return { upstream, ok: true, credits, report, at: new Date().toISOString() };
}

/** Run the benefits of every enabled upstream. */
export async function runBenefits(upstreams: BenefitUpstream[]): Promise<BenefitOutcome[]> {
  const out: BenefitOutcome[] = [];
  for (const upstream of upstreams) {
    if (upstream === "workbuddy-cn") out.push(await runWorkBuddyBenefits());
    else out.push(await runQoderBenefits(upstream === "qoder-cn" ? "cn" : "global"));
  }
  return out;
}
