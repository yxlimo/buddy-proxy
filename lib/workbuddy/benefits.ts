// lib/workbuddy/benefits.ts — the daily benefits of the WorkBuddy account.
//
// The check-in, the Buddy that travels and brings a gift back, the tasks, the
// streak and the blind box. The order matters: the tasks hand out the lottery
// chances and the energy the later steps use.
//
// Only the check-in and the Buddy trip are in the simulated client. The others
// are the account's own API and answer when they are asked — the tasks hand
// out credits, and the streak reports the days — so they are used as well.

import { loadSession as loadWorkBuddySession, type WorkBuddySession } from "./auth.ts";
import { clientToken, dataOf, GROWTH, workbuddyApi } from "./api.ts";
import type { BenefitOutcome } from "../benefits.ts";

/** The numeric code the API answers with, when it answers with one. */
function businessCode(body: any): number {
  const code = body?.code;
  return typeof code === "number" ? code : 0;
}

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
    // The official client sends an empty body here; the record id is not
    // needed, and the server does not look for it.
    const claim = await workbuddyApi(session, `${GROWTH}/buddy/travel/claim`, "POST", {});
    if (claim.status >= 200 && claim.status < 300) {
      const got = Number(dataOf(claim.body)?.reward_credit ?? 0);
      credits += got;
      report.push(`领旅行礼物 +${got} 积分`);
    } else {
      report.push(`领旅行礼物失败：${claim.body?.msg ?? `HTTP ${claim.status}`}`);
    }
  } else {
    // Say where the Buddy is, so the log alone explains a missing gift.
    report.push(`Buddy 状态：${String(state.state ?? "?")}`);
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
  const claim = await workbuddyApi(session, `${GROWTH}/tasks/${t.task_code}/claim`, "POST", {});
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
    return { upstream: "workbuddy-cn", ok: false, credits: 0, report: ["未找到 WorkBuddy 登录态"], at: new Date().toISOString() };
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
