// lib/workbuddy/credits.ts — what the WorkBuddy account has collected.
//
// The check-in status carries the numbers, and asking for it does not check in:
// the check-in is the other endpoint.

import { loadSession as loadWorkBuddySession } from "./auth.ts";
import { dataOf, workbuddyApi } from "./api.ts";

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
