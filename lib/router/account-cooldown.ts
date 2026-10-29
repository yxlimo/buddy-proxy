// lib/router/account-cooldown.ts — 一次失败值多少冷却。
//
// 四类失败，四种冷却：
//
//   限流（rate-limit：超了 RPM/TPM）
//       固定 1 分钟；上游自己说了「过多久再来」（retry-after），就照它说的来。
//       限流的窗口是分钟级的：超了一分钟，等一分钟就够 —— 按 5 分钟算会把
//       同平台别的模型一起挡掉（2026-10-30：qiniu 报 rate_limit_tpm_exceeded，
//       账号被下线五分钟，同平台别的模型也一起没了）。
//
//   额度用完（quota）
//       冷却到「恢复时间 + 1 分钟」。恢复时间取三个来源里**最晚**的：
//         1. 错误对象上带的（传输层读到 retry-after，就挂上去）
//         2. 错误正文里写的时间（MiniMax 的 1310：「您的限额将在
//            2026-10-30 07:55:44 重置」）
//         3. 账号当前的套餐窗口什么时候结束（健康快照里的 tokenPlan.windows）
//       为什么取最晚的：上游的 retry-after 常常只有几十秒，早回来只是再失败
//       一次；正文里的重置时间与套餐窗口才说得出账号什么时候真的有额度。
//       都没有就用固定值（5 分钟）。
//       额度是一次性的（等窗口），限流是分钟级的（等一分钟）—— 两者的等待
//       不是一回事，所以分开算。
//
//   连接与超时（connection、timeout）
//       固定 1 分钟。连接断掉不是账号的错 —— 一个只有单个账号的平台会被
//       自己的超时下线好几分钟。上游自己说了「过多久再来」（retry-after），
//       就照它说的来。
//
//   别的可降级失败（server、credential、no-balance）
//       固定 5 分钟；但上游自己说了「过多久再来」（retry-after），就照它说的
//       来 —— 那时候一个短的等待是对的，套餐窗口跟服务挂了没关系。
//
// 只有可降级的失败才记冷却：请求本身的问题（400/404/413）不记 —— 一个坏请求
// 不该把账号封掉，换一个账号也是一样的结果。

import {
  MAX_COOLDOWN_MS,
  networkCooldownMs,
  rateCooldownMs,
  unavailableCooldownMs,
  isIgnoredPlanWindow,
} from "../cooldown.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import { cooldownUntilOf } from "../upstream-status.ts";
import { classifyUpstreamError, isDegradableUpstreamError } from "./provider-selection.ts";

/** 恢复时间之后再多留一分钟：上游说的那一刻是开始恢复，不是那一刻就好。 */
export const COOLDOWN_GRACE_MS = 60_000;

/**
 * 上游自己说的恢复时间之后多留一秒。
 *
 * 只给限流用：上游说的「过几十秒再来」是分钟级的窗口，多留一分钟就把「限流
 * 只下线一分钟」这个修复抵消了。一秒够避开边界（正好卡在那一刻又被限一次）。
 */
const RATE_RETRY_GRACE_MS = 1_000;

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
  // 上游 5xx 不是账号的错。
  //
  // 它说的是「这个请求这次没成事」：可能就那一个模型挂了，也可能是上游抽了
  // 一下。算到账号头上，同一个平台上别的模型会跟着下线 5 分钟，fallback 的
  // 第二个目标也会被跳过（2026-10-28 实测：一个模型回 500，整个平台 503、
  // 第二个目标没被试）。换下一个目标、下一个账号就够了，不写冷却。
  if (failure.kind === "server") return null;
  if (failure.kind === "rate-limit") {
    // 限流是分钟级的：超了一分钟，等一分钟就够。按 5 分钟算的话，一个只漏了
    // 一分钟的账号会被下线五分钟，同平台别的模型跟着一起被挡。
    const deadline = rateLimitDeadlineFor(accountId, error, now);
    if (deadline) {
      // 上游自己说的恢复时间（retry-after）只多留一秒；正文里的重置时间与
      // 套餐窗口说的是额度，照旧多留一分钟。
      const grace = deadline.source === "the upstream's answer" ? RATE_RETRY_GRACE_MS : COOLDOWN_GRACE_MS;
      return {
        untilMs: Math.min(deadline.at + grace, now + MAX_COOLDOWN_MS),
        reason: failure.kind,
        source: deadline.source,
      };
    }
    // 上游什么也没说得出：固定一分钟。
    return { untilMs: now + rateCooldownMs(), reason: failure.kind, source: "fixed" };
  }
  if (failure.kind === "quota") {
    // 额度是真的用完了：要等窗口，不是等一分钟。
    const deadline = latestDeadlineFor(accountId, error, now);
    // 恢复时间已经过去了（上游说的就是现在）：那就用固定值试一下。
    if (deadline && deadline.at + COOLDOWN_GRACE_MS > now) {
      return {
        untilMs: Math.min(deadline.at + COOLDOWN_GRACE_MS, now + MAX_COOLDOWN_MS),
        reason: failure.kind,
        source: deadline.source,
      };
    }
  } else {
    // 别的失败：上游自己说了「过多久再来」就照它说的来（常常几十秒）。
    // 套餐窗口说的是额度，与服务挂不挂没关系，不参与。
    const attached = cooldownUntilOf(error);
    if (attached !== null && attached > now) {
      return {
        untilMs: Math.min(attached, now + MAX_COOLDOWN_MS),
        reason: failure.kind,
        source: "the upstream's answer",
      };
    }
  }
  // 没有上游给的恢复时间：用固定值。连接与超时是 1 分钟 —— 那不是账号的错，
  // 按 5 分钟算的话一个只有单个账号的平台会被自己的超时下线好几分钟。
  // 额度用完也是固定值：额度是真的用完了，等窗口（5 分钟）。
  const fixed =
    failure.kind === "connection" || failure.kind === "timeout"
      ? networkCooldownMs()
      : unavailableCooldownMs();
  return { untilMs: now + fixed, reason: failure.kind, source: "fixed" };
}

/**
 * 恢复时间从哪儿来 —— 限流类的失败取**最先说得出时间的那个来源**。
 *
 * 三个来源，按这个次序：
 *
 *   1. 正文里写的重置时间（MiniMax 的 1310：「您的限额将在 2026-10-30
 *      07:55:44 重置」）。这是上游明确说的「什么时候恢复」，比 retry-after
 *      那个几十秒的提示准。
 *   2. 上游自己说的（retry-after）。限流的窗口是分钟级的，这几十秒才是对
 *      的 —— 额度要等的是几小时（套餐窗口），跟限流不是一回事。
 *   3. 见底的套餐窗口。它说的是额度，排在最后。
 *
 * 已经过去的时间不算：上游说的截止时间早就过了，那就用固定的一分钟试一下。
 */
function rateLimitDeadlineFor(
  accountId: string,
  error: unknown,
  now: number,
): { at: number; source: string } | null {
  // 正文里写的时间。
  const body = parseDeadlineFromText(errorTextOf(error));
  if (body !== null && body > now) return { at: body, source: "the body" };
  // 错误对象上带的（传输层读到的 retry-after）。
  const attached = cooldownUntilOf(error);
  if (attached !== null && attached > now) return { at: attached, source: "the upstream's answer" };
  // 见底的套餐窗口：额度用完了的那个窗口什么时候换。
  const window = exhaustedPlanWindowEndsAt(accountId, now);
  if (window !== null && window > now) return { at: window, source: "the plan window" };
  return null;
}

/**
 * 恢复时间从哪儿来 —— 额度类的失败取**最晚**的那一个。
 *
 * 三个来源：上游说的（retry-after）、正文里写的（MiniMax 的 1310）、账号当前
 * 见底的套餐窗口。取最晚的，因为上游的 retry-after 常常只有几十秒 —— 早回来
 * 只是再失败一次；正文里的重置时间与见底的窗口才说得出账号什么时候真的有
 * 额度。
 */
function latestDeadlineFor(
  accountId: string,
  error: unknown,
  now: number,
): { at: number; source: string } | null {
  const candidates = [
    // 错误对象上带的（传输层读到的 retry-after，或者平台给的截止时间）。
    { at: cooldownUntilOf(error), source: "the upstream's answer" },
    // 正文里写的时间。
    { at: parseDeadlineFromText(errorTextOf(error)), source: "the body" },
    // 见底的套餐窗口：额度用完了的那个窗口什么时候换。
    { at: exhaustedPlanWindowEndsAt(accountId, now), source: "the plan window" },
  ].filter((c): c is { at: number; source: string } => c.at !== null);
  if (candidates.length === 0) {
    // 什么也没说得出：还是按套餐窗口的下一个边界算（跟以前一样）。
    const window = planWindowEndsAt(accountId, now);
    return window === null ? null : { at: window, source: "the plan window" };
  }
  return candidates.reduce((a, b) => (b.at > a.at ? b : a));
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
 * 健康快照里的 tokenPlan.windows：每个窗口有 5 小时与 7 天两个到期时间。
 *
 * 先看「见底」的窗口：额度用完了的那个窗口，账号才能真的干活，要等它结束。
 * 见底的窗口有多个（5 小时与 7 天都见底）时取最晚的那个 —— 少一个都不行。
 *
 * 没有见底的窗口，就退回「还没到的最早那个到期点」：那时候额度还在，窗口
 * 什么时候换跟恢复时间没关系，只是没有更好的说法。
 */
export function planWindowEndsAt(accountId: string, now = Date.now()): number | null {
  const snapshot = peekHealthSnapshot<any>();
  const mine = snapshot?.data?.minimax?.[accountId];
  const windows = Array.isArray(mine?.tokenPlan?.windows) ? mine.tokenPlan.windows : [];
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
function exhaustedPlanWindowEndsAt(accountId: string, now = Date.now()): number | null {
  const snapshot = peekHealthSnapshot<any>();
  const mine = snapshot?.data?.minimax?.[accountId];
  const windows = Array.isArray(mine?.tokenPlan?.windows) ? mine.tokenPlan.windows : [];
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

/**
 * 冷却到什么时候，给日志看。
 *
 * 按平台的时区（UTC+8）写：上游说的时间就是这个时区的，不写清楚，两边对不上。
 */
export function cooldownStamp(ms: number): string {
  return `${new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ")} +08:00`;
}
