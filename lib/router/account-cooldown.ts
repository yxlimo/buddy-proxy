// lib/router/account-cooldown.ts — 一次失败值多少冷却。
//
// 两类失败，两种冷却：
//
//   限流 / 额度用完（rate-limit、quota）
//       冷却到「恢复时间 + 1 分钟」。恢复时间按这个顺序找：
//         1. 错误对象上带的（传输层读到 retry-after，就挂上去）
//         2. 错误正文里写的时间（MiniMax 的 1310：「您的限额将在
//            2026-10-30 07:55:44 重置」）
//         3. 账号当前的套餐窗口什么时候结束（健康快照里的 tokenPlan.windows）
//       都没有就用固定值。
//
//   别的可降级失败（server、connection、timeout、credential、no-balance）
//       固定 5 分钟。
//
// 只有可降级的失败才记冷却：请求本身的问题（400/404/413）不记 —— 一个坏请求
// 不该把账号封掉，换一个账号也是一样的结果。

import { MAX_COOLDOWN_MS, unavailableCooldownMs, isIgnoredPlanWindow } from "../cooldown.ts";
import { HEALTH_CACHE_ID } from "../health-cache.ts";
import { peekCached } from "../store.ts";
import { cooldownUntilOf } from "../upstream-status.ts";
import { classifyUpstreamError, isDegradableUpstreamError } from "./provider-selection.ts";

/** 恢复时间之后再多留一分钟：上游说的那一刻是开始恢复，不是那一刻就好。 */
export const COOLDOWN_GRACE_MS = 60_000;

/** 一次失败值多少冷却。 */
export interface CooldownDecision {
  /** 到什么时候为止（毫秒）。 */
  untilMs: number;
  /** 为什么（给日志看）。 */
  reason: string;
  /** 恢复时间是从哪儿来的（给日志看）。 */
  source: string;
}

/**
 * 这次失败要让那个账号冷却多久。
 *
 * 不可降级的失败没有冷却：换一个账号也是一样的结果，把账号放下去只会让可用
 * 的账号更少。
 */
export function cooldownForFailure(
  accountId: string,
  error: unknown,
  now = Date.now(),
): CooldownDecision | null {
  if (!isDegradableUpstreamError(error)) return null;
  const failure = classifyUpstreamError(error);
  const fixed = unavailableCooldownMs();
  if (failure.kind === "rate-limit" || failure.kind === "quota") {
    const deadline = deadlineFor(accountId, error, now);
    // 恢复时间已经过去了（上游说的就是现在）：那就用固定值试一下。
    if (deadline && deadline.at + COOLDOWN_GRACE_MS > now) {
      return {
        untilMs: Math.min(deadline.at + COOLDOWN_GRACE_MS, now + MAX_COOLDOWN_MS),
        reason: failure.kind,
        source: deadline.source,
      };
    }
  }
  return { untilMs: now + fixed, reason: failure.kind, source: "fixed" };
}

/** 恢复时间从哪儿来。 */
function deadlineFor(
  accountId: string,
  error: unknown,
  now: number,
): { at: number; source: string } | null {
  // 1. 错误对象上带的（传输层读到的 retry-after，或者平台给的截止时间）。
  const attached = cooldownUntilOf(error);
  if (attached !== null) return { at: attached, source: "the upstream's answer" };
  // 2. 正文里写的时间。
  const parsed = parseDeadlineFromText(errorTextOf(error));
  if (parsed !== null) return { at: parsed, source: "the body" };
  // 3. 账号当前的套餐窗口。
  const window = planWindowEndsAt(accountId, now);
  if (window !== null) return { at: window, source: "the plan window" };
  return null;
}

/** 错误里能读到的原文：消息、提示，还有平台塞进来的那些字段。 */
export function errorTextOf(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const err = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "hint", "body", "text", "detail"]) {
    const value = err[key];
    if (typeof value === "string" && value) parts.push(value);
  }
  return parts.join("\n");
}

/** 正文里写的时间：`2026-10-30 07:55:44`。 */
const DEADLINE_PATTERN = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * 正文里写的恢复时间。
 *
 * 平台按它自己的时区（UTC+8）报时间，正文里不带时区 —— 不带就按 +08:00
 * 解析；带了就用它带的那个。
 */
export function parseDeadlineFromText(text: string): number | null {
  const source = String(text ?? "");
  const found = DEADLINE_PATTERN.exec(source);
  if (!found) return null;
  const [, year, month, day, hour, minute, second] = found;
  const rest = source.slice(found.index + found[0].length);
  const zone = normalizeZone(/^\s*(Z|[+-]\d{2}:?\d{2})/.exec(rest)?.[1] ?? "+08:00");
  const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}${zone}`;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 时区：`+0800` 与 `+08:00` 一样，`Z` 就是 UTC。 */
function normalizeZone(zone: string): string {
  if (zone === "Z") return "Z";
  const found = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!found) return "+08:00";
  return `${found[1]}${found[2]}:${found[3]}`;
}

/**
 * 账号当前的套餐窗口什么时候结束。
 *
 * 健康快照里的 tokenPlan.windows：每个窗口有 5 小时与 7 天两个到期时间。已经
 * 到期的窗口不算 —— 那个额度已经用完了，要等的是还没到的那个。
 */
export function planWindowEndsAt(accountId: string, now = Date.now()): number | null {
  const snapshot = peekCached<any>(HEALTH_CACHE_ID);
  const mine = snapshot?.data?.minimax?.[accountId];
  const windows = Array.isArray(mine?.tokenPlan?.windows) ? mine.tokenPlan.windows : [];
  let best: number | null = null;
  for (const window of windows) {
    if (isIgnoredPlanWindow(window)) continue;
    for (const key of ["intervalEndsAt", "weeklyEndsAt"]) {
      const at = timeMs(window?.[key]);
      if (!at || at <= now) continue;
      if (best === null || at < best) best = at;
    }
  }
  return best;
}

/** 平台给的时间：毫秒或者 ISO 字符串。 */
function timeMs(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 冷却到什么时候，给日志看。
 *
 * 按平台的时区（UTC+8）写：上游说的时间就是这个时区的，不写清楚，两边对不上。
 */
export function cooldownStamp(ms: number): string {
  return `${new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ")} +08:00`;
}
