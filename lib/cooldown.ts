// lib/cooldown.ts — 账号的冷却：失败之后一段时间不再路由到那个账号。
//
// 三种失败，三种冷却：
//
//   限流 / 额度用完      冷却到「恢复时间 + 1 分钟」。恢复时间从哪儿来，由
//                        lib/router/account-cooldown.ts 去找（错误上带的、
//                        正文里写的、账号当前的套餐窗口）。
//   连接与超时            固定 1 分钟（ACCOUNT_NETWORK_COOLDOWN_MS 可以改）。
//                        连接断掉不是账号的错 —— 按 5 分钟算的话，一个只有
//                        一个账号的平台会被自己的超时下线好几分钟。
//   别的可降级失败        固定 5 分钟（ACCOUNT_COOLDOWN_MS 可以改）。
//
// 冷却落库：网关重启以后它还在 —— 一个刚被限流的账号不该因为重启又被试一次。
//
// 过期是惰性的：判定的时候比时间就行，不需要定时器去「恢复」。过期的行由
// lib/periodic.ts 顺手清掉，只是为了表不长毛。
//
// 这不是封禁：任何路径都不会写出「永远」——上限是一周（MAX_COOLDOWN_MS），
// 到了就自动恢复重试。

import { configNumber } from "./config.ts";
import { store } from "./store.ts";

/** 不可用时的固定冷却时长（毫秒）。 */
export const UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;

/** 连接断掉或超时时的固定冷却时长（毫秒）。 */
export const NETWORK_COOLDOWN_MS = 60_000;

/**
 * 冷却最多到什么时候（毫秒）：一周。
 *
 * 再久就是「永久封禁」了，那不是冷却。窗口最长的一周（套餐的周窗口）也在
 * 这个范围里，所以正常情况用不到这个上限。
 */
export const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/** 固定冷却时长，可以由设置改。 */
export function unavailableCooldownMs(): number {
  return configNumber("ACCOUNT_COOLDOWN_MS", UNAVAILABLE_COOLDOWN_MS);
}

/** 连接与超时的固定冷却时长，可以由设置改。 */
export function networkCooldownMs(): number {
  return configNumber("ACCOUNT_NETWORK_COOLDOWN_MS", NETWORK_COOLDOWN_MS);
}

/** 一条冷却。 */
export interface CooldownRow {
  /** 账号 id。 */
  providerId: string;
  /** 到什么时候为止（毫秒）。 */
  untilMs: number;
  /** 为什么冷却（限流、额度、服务挂了……）。 */
  reason: string;
  /** 什么时候写的（毫秒）。 */
  updatedAt: number;
}

/**
 * The account's cooldown, and until when.
 *
 * `null` means it never cooled down. The row can be there and still be
 * expired — expiry is decided when the row is read.
 */
export function cooldownUntil(providerId: string): number | null {
  const row = store()
    .prepare("SELECT until_ms FROM cooldown WHERE provider_id = ?")
    .get(providerId) as { until_ms?: number } | undefined;
  if (!row) return null;
  const until = Number(row.until_ms ?? 0);
  return Number.isFinite(until) && until > 0 ? until : null;
}

/** 那个账号现在是不是在冷却。 */
export function isCoolingDown(providerId: string, now = Date.now()): boolean {
  const until = cooldownUntil(providerId);
  return until !== null && until > now;
}

/**
 * 把那个账号放进冷却。
 *
 * 到什么时候为止由调用方算好；这里只保证写下去的是一个有限的数 —— 冷却不是
 * 封禁，超出上限的按上限算。
 *
 * 短冷却不覆盖长冷却：被限流到两小时的账号，不该因为三十秒后的一次 500 就
 * 提前回到轮转（那正是它继续被限流的原因）。所以那一行记的永远是「最长的一次
 * 冷却」，理由与时间也跟着那一次走。
 */
export function setCooldown(providerId: string, untilMs: number, reason = ""): void {
  if (!Number.isFinite(untilMs)) return;
  // 冷却不是封禁：到什么时候都不能超过「现在 + 一周」。
  const cap = Date.now() + MAX_COOLDOWN_MS;
  const until = Math.min(Math.max(Math.round(untilMs), 0), cap);
  store()
    .prepare(
      "INSERT INTO cooldown (provider_id, until_ms, reason, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(provider_id) DO UPDATE SET " +
        // 短冷却不覆盖长冷却：取两者里更晚的那个。
        "until_ms = MAX(cooldown.until_ms, excluded.until_ms), " +
        // 理由与时间跟着更长的那条走：这一行说的是「最长的一次冷却」。
        "reason = CASE WHEN excluded.until_ms > cooldown.until_ms THEN excluded.reason ELSE cooldown.reason END, " +
        "updated_at = CASE WHEN excluded.until_ms > cooldown.until_ms THEN excluded.updated_at ELSE cooldown.updated_at END",
    )
    .run(providerId, until, String(reason ?? ""), Date.now());
}

/** 冷却结束了（或者本来就没有）：把那一行删掉。 */
export function clearCooldown(providerId: string): void {
  const db = store();
  const row = db.prepare("SELECT provider_id FROM cooldown WHERE provider_id = ?").get(providerId);
  if (!row) return;
  db.prepare("DELETE FROM cooldown WHERE provider_id = ?").run(providerId);
}

/** 过期的行：清掉，表才不长毛。判定本身不靠这一步。 */
export function sweepExpiredCooldowns(now = Date.now()): number {
  const result = store().prepare("DELETE FROM cooldown WHERE until_ms <= ?").run(now);
  return Number(result.changes ?? 0);
}

/** 现在还在冷却的账号。 */
export function listCooldowns(now = Date.now()): CooldownRow[] {
  const rows = store()
    .prepare("SELECT provider_id, until_ms, reason, updated_at FROM cooldown WHERE until_ms > ? ORDER BY until_ms")
    .all(now) as any[];
  return rows.map((row) => ({
    providerId: String(row.provider_id ?? ""),
    untilMs: Number(row.until_ms ?? 0),
    reason: String(row.reason ?? ""),
    updatedAt: Number(row.updated_at ?? 0),
  }));
}

/**
 * 网关只服务文本模型：`video` 那个窗口是视频权益，不参与路由，也不上屏。
 *
 * 平台按窗口报额度（`general` 管文本、`video` 管视频）。一个账号的文本额度
 * 用完时，视频窗口往往还是满的 —— 把它算进「这个账号还有额度」里，账号就会
 * 显示成可用，而文本请求必然被拒。
 */
export const IGNORED_PLAN_WINDOWS = new Set(["video"]);

/** 这个窗口是不是被无视的那类（视频等）。快照里叫 model，视图里叫 label。 */
export function isIgnoredPlanWindow(window: unknown): boolean {
  const w = window as { model?: unknown; label?: unknown } | null;
  const name = String(w?.model ?? w?.label ?? "").trim().toLowerCase();
  return IGNORED_PLAN_WINDOWS.has(name);
}
