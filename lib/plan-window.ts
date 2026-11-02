// lib/plan-window.ts — 账号当前的套餐窗口什么时候结束。
//
// 它住在顶层，不在 lib/router/ 里：问这个问题的有两处 —— 路由算冷却
// （lib/router/account-cooldown.ts）与 admin 层算平台状态
// （lib/admin/platform-state.ts）。admin 层不引路由层，所以这一份放在两边的
// 下面；两边问的是同一件事，必须是同一个答案。
//
// 健康快照里的 tokenPlan.windows：每个窗口有 5 小时与 7 天两个到期时间。
//
// 先看「见底」的窗口：额度用完了的那个窗口，账号才能真的干活，要等它结束。
// 见底的窗口有多个（5 小时与 7 天都见底）时取最晚的那个 —— 少一个都不行。
//
// 没有见底的窗口，就退回「还没到的最早那个到期点」：那时候额度还在，窗口
// 什么时候换跟恢复时间没关系，只是没有更好的说法。

import { isIgnoredPlanWindow } from "./cooldown.ts";
import { peekHealthSnapshot } from "./health-cache.ts";

/**
 * 账号当前的套餐窗口什么时候结束。
 *
 * 没有见底的窗口，就退回还没到的最早那个到期点（见文件头的取舍）。
 */
export function planWindowEndsAt(accountId: string, now = Date.now()): number | null {
  const windows = windowsOf(accountId);
  // 见底的窗口：它们结束了账号才有额度。
  let exhausted: number | null = null;
  // 所有还没到的到期点：没有见底的窗口时的退路。
  let soonest: number | null = null;
  for (const window of windows) {
    if (isIgnoredPlanWindow(window)) continue;
    for (const key of ["intervalEndsAt", "weeklyEndsAt"]) {
      const at = timeMs(window?.[key]);
      if (!at || at <= now) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
    // 这一格见底了（百分比 0）：这一格的结束时间就是它的恢复时间。
    const intervalAt = timeMs(window?.intervalEndsAt);
    if (intervalAt > now && percentLeft(window?.intervalPercent) <= 0) {
      if (exhausted === null || intervalAt > exhausted) exhausted = intervalAt;
    }
    const weeklyAt = timeMs(window?.weeklyEndsAt);
    if (weeklyAt > now && percentLeft(window?.weeklyPercent) <= 0) {
      if (exhausted === null || weeklyAt > exhausted) exhausted = weeklyAt;
    }
  }
  return exhausted ?? soonest;
}

/**
 * 见底的窗口什么时候结束（没有见底的窗口就是 null）。
 *
 * 这才是「额度什么时候回来」：窗口还有额度的时候，它的到期点跟恢复时间无关
 * —— 那只是一个窗口边界，账号现在就能干活。
 */
export function exhaustedPlanWindowEndsAt(accountId: string, now = Date.now()): number | null {
  const windows = windowsOf(accountId);
  let exhausted: number | null = null;
  for (const window of windows) {
    if (isIgnoredPlanWindow(window)) continue;
    const intervalAt = timeMs(window?.intervalEndsAt);
    if (intervalAt > now && percentLeft(window?.intervalPercent) <= 0) {
      if (exhausted === null || intervalAt > exhausted) exhausted = intervalAt;
    }
    const weeklyAt = timeMs(window?.weeklyEndsAt);
    if (weeklyAt > now && percentLeft(window?.weeklyPercent) <= 0) {
      if (exhausted === null || weeklyAt > exhausted) exhausted = weeklyAt;
    }
  }
  return exhausted;
}

/** 这个账号的套餐窗口（快照里的那几格）。 */
function windowsOf(accountId: string): any[] {
  const snapshot = peekHealthSnapshot<any>();
  const mine = snapshot?.data?.minimax?.[accountId];
  return Array.isArray(mine?.tokenPlan?.windows) ? mine.tokenPlan.windows : [];
}

/**
 * 这一格还剩多少额度（百分比）。
 *
 * 平台没报这个数字就当它还有额度（100）：没有数字不等于没有额度。
 */
function percentLeft(value: unknown): number {
  if (value === null || value === undefined || value === "") return 100;
  const text = String(value).replace("%", "").trim();
  const raw = Number(text);
  return Number.isFinite(raw) ? raw : 100;
}

/** 平台给的时间：毫秒或者 ISO 字符串。 */
function timeMs(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}
