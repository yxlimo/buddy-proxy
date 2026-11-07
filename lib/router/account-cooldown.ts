// lib/router/account-cooldown.ts — 一次失败值多少冷却。
//
// 记冷却的只有三类：限流、凭据被拒、额度见底。别的失败都不记 —— 它们说的
// 不是「这个账号不能用了」。
//
// 前提：没有别的账号可换时不记（hasAlternative）。只有一个账号的平台记了冷却，
// 那一段时间里它一个上游请求都不打，而客户端拿到的还是同一条报错 —— 什么也没
// 换好，只是不打了。
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
//   凭据被拒与余额见底（credential、no-balance）
//       固定 5 分钟；上游自己说了「过多久再来」（retry-after），就照它说的来
//       —— 那时候一个短的等待是对的。套餐窗口说的是额度，跟这两类没关系，
//       不参与。
//
// 不记账的：
//
//   连接（connection）
//       连接被上游掐断不是「这个账号不能用了」：同一个账号的下一个请求很可能
//       就通了（上游抽了一下、复用的连接被断掉、中间的代理掐了）。
//       记 1 分钟的话，只有一个账号的平台那一分钟里一个上游请求都不打 ——
//       一次连接重置把整个平台下线一分钟，比这个故障本身还严重。
//
//   超时不记账（timeout）
//       超时说的是「这一条请求等太久了」，不是「这个账号不能用了」。记冷却会
//       把一个好好的账号挡在门外好几分钟，而这一条请求慢，换哪个账号都可能
//       一样慢。答复照旧是那条超时错误，客户端自己决定要不要重发。
//
//   等过了自己的限流窗口（rateWaited 标记）
//       也不记账：它接不了不是因为坏了，等好了就能接；记冷却反而把它（和别的
//       请求）一起挡在门外。标记只贴在「最终那个错误本身还是限流」的错误上
//       （见 policy.ts 的 stop）：它的语义是「这个限流是我们替它等过的」，不是
//       「这个账号这一轮里等过什么」—— 贴在被拒（401）、额度见底（402）上，
//       下面这条就变成「坏凭据永不冷却」。
//
//   上游 5xx（server）不记账
//       —— 它说的是「这个请求这次没成事」，不是「这个账号不能用了」。算到账号
//       头上，同一个平台上别的模型会跟着下线五分钟，fallback 的第二个目标也
//       会被跳过（2026-10-28 实测：一个模型回 500，整个平台 503、第二个目标
//       没被试）。换下一个目标、下一个账号就够了。
//
// 只有可降级的失败才记冷却：请求本身的问题（400/404/413）不记 —— 一个坏请求
// 不该把账号封掉，换一个账号也是一样的结果。
//
// 上面这几条判据都住在**这一层**，不挂在某个调用点上：派发失败（policy.ts 的
// onAttempt）与流式答复的结算（Settlement.failure）问的是同一个问题 ——「这次
// 失败值多少冷却」。判据留在调用点的话，同一个超时在两条路上会有两种待遇
// （一条记冷却、一条不记），排查时看到的账也对不上。
//
// 因此这个函数是纯记账：读快照、算时刻、返回 decision 或 null，没有副作用。
// 写不写、写多少由调用方按 decision 做。

import {
  MAX_COOLDOWN_MS,
  rateCooldownMs,
  unavailableCooldownMs,
} from "../cooldown.ts";
import { cooldownUntilOf } from "../upstream-status.ts";
import { exhaustedPlanWindowEndsAt, planWindowEndsAt } from "../plan-window.ts";
import { classifyUpstreamError, isDegradableUpstreamError } from "./provider-selection.ts";

// 套餐窗口那一问住在 lib/plan-window.ts：admin 层也算同一个时间，它不引路由层。
// 这里转出去，调用方的 import 不用改。
export { planWindowEndsAt } from "../plan-window.ts";

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
 * 一个带标记的错误：它这一次等过了自己的限流窗口。
 *
 * 标记挂在错误对象上，跟着错误走到结算那一层：只记在这个模块里看不到，因为
 * 谁等过是重试循环（policy.ts 的 runWithRetries）说了算。
 */
export interface RateWaited {
  rateWaited?: boolean;
}

/** 记一笔：这个失败等过了自己的限流窗口。 */
export function withRateWaited<T extends object>(error: T): T {
  (error as T & RateWaited).rateWaited = true;
  return error;
}

/** 这个失败等过了吗。 */
export function rateWaitedOf(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as RateWaited).rateWaited === true;
}

/**
 * 这次失败要让那个账号冷却多久。
 *
 * 不可降级的失败没有冷却：换一个账号也是一样的结果，把账号放下去只会让可用
 * 的账号更少；超时、连接断掉与等过限流的也不记（理由见文件顶上）。
 *
 * `hasAlternative` 说「有没有别的账号可换」：没有就不记冷却（理由见文件顶上）。
 */
export function cooldownForFailure(
  accountId: string,
  error: unknown,
  now = Date.now(),
  hasAlternative = true,
): CooldownDecision | null {
  // 没有别的账号可换：记冷却只会让这个平台在一段时间里一个上游请求都不打，
  // 而客户端拿到的还是同一条报错。让它继续试、把上游的话原样交出去。
  if (!hasAlternative) return null;
  if (!isDegradableUpstreamError(error)) return null;
  const failure = classifyUpstreamError(error);
  // 超时不记账：这一条请求等得太久了，不是这个账号不能用了（见文件顶上的分类）。
  if (failure.kind === "timeout") return null;
  // 连接被上游掐断也不记账：它说的不是「这个账号不能用了」，下一个请求很可能
  // 就通了。记 1 分钟的话，只有一个账号的平台那一分钟里一个上游请求都不打。
  if (failure.kind === "connection") return null;
  // 等过了限流的账号正在等自己的窗口恢复：它接不了不是因为坏了。
  if (rateWaitedOf(error)) return null;
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
  // 没有上游给的恢复时间：用固定值 —— 凭据被拒与余额见底是 5 分钟（额度用完
  // 落到这里时也是 5 分钟）。
  return { untilMs: now + unavailableCooldownMs(), reason: failure.kind, source: "fixed" };
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
 * 冷却到什么时候，给日志看。
 *
 * 按平台的时区（UTC+8）写：上游说的时间就是这个时区的，不写清楚，两边对不上。
 */
export function cooldownStamp(ms: number): string {
  return `${new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ")} +08:00`;
}
