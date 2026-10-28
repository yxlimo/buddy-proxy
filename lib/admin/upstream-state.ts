// lib/admin/upstream-state.ts — 面板要看见的「冷却」。
//
// 冷却是账号的事（lib/cooldown.ts 落库），面板问的是平台那一层：这个平台名下
// 最早的冷却到什么时候、因为什么、最早什么时候能再接。这个模块把这些算出来，
// lib/admin/upstreams.ts 只调用它 —— 那边已经超标了，不该再往里堆逻辑。
//
// 三个数：
//
//   cooldownUntilMs  名下最早到期的冷却（0 = 都不在冷却）。
//   cooldownReason   那条冷却的理由（平台给的说法：quota / rate-limit / connection）。
//   recoversAtMs     最早什么时候能再接（0 = 现在就能接，或者算不出来）。
//
// 「能再接」看的是两件事：冷却什么时候结束，额度什么时候回来（套餐窗口结束）。
// 有一个账号现在就能接，这个上游就能接 —— 恢复时间就是现在（0）。

import { listCooldowns } from "../cooldown.ts";
import { planWindowEndsAt } from "../router/account-cooldown.ts";
import { kindOf } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import type { HealthSnapshot } from "../provider-kinds.ts";

/** 一个账号的冷却。 */
export interface CoolingInfo {
  /** 冷却到什么时候（毫秒）。0 = 没在冷却。 */
  untilMs: number;
  /** 平台给的说法（quota / rate-limit / connection……）。没有就空串。 */
  reason: string;
}

/** 平台这一层的冷却：面板看的那几个数。 */
export interface PlatformCooling {
  /** 名下最早的冷却到什么时候（毫秒）。0 = 都不在冷却。 */
  cooldownUntilMs: number;
  /** 那条冷却的理由。 */
  cooldownReason: string;
  /** 最早什么时候能再接（毫秒）。0 = 现在就能接，或者算不出来。 */
  recoversAtMs: number;
  /** 一句给面板直接用的话。没有就空串。 */
  stateReason: string;
}

const NO_COOLING: CoolingInfo = { untilMs: 0, reason: "" };

/**
 * 现在还在冷却的账号（账号 id → 冷却信息）。
 *
 * 冷却的过期是惰性的：判定的时候比时间就行。表里留着的那一行如果已经过期，
 * 它就不算冷却 —— 面板不该说「还在冷却」，路由也确实会再试它。
 */
export function coolingAccounts(now = Date.now()): Map<string, CoolingInfo> {
  const out = new Map<string, CoolingInfo>();
  for (const row of listCooldowns(now)) {
    out.set(row.providerId, { untilMs: row.untilMs, reason: row.reason });
  }
  return out;
}

/** 一个账号自己的冷却。没在冷却就是 0 与空串。 */
export function coolingOf(accountId: string, cooling?: Map<string, CoolingInfo>): CoolingInfo {
  const map = cooling ?? coolingAccounts();
  return map.get(accountId) ?? NO_COOLING;
}

/**
 * 平台这一层的冷却信息。
 *
 * `snapshot` 是额度快照（/health 缓存的那份）：读不到就当不知道额度 —— 不知道
 * 不是「没有」，所以不去猜恢复时间。
 */
export function platformCooling(options: {
  /** 平台名下的账号。 */
  rows: ProviderRow[];
  /** 额度快照。 */
  snapshot?: HealthSnapshot | null;
  now?: number;
}): PlatformCooling {
  const now = options.now ?? Date.now();
  const cooling = coolingAccounts(now);

  // 名下最早到期的冷却。
  let cooldownUntilMs = 0;
  let cooldownReason = "";
  for (const row of options.rows) {
    const info = cooling.get(row.id);
    if (!info) continue;
    if (cooldownUntilMs === 0 || info.untilMs < cooldownUntilMs) {
      cooldownUntilMs = info.untilMs;
      cooldownReason = info.reason;
    }
  }

  // 每个账号：额度用尽了吗？什么时候能再接？
  const snapshot = options.snapshot ?? null;
  let canServeNow = false;
  let creditsRecoverAtMs: number | null = null;
  let recoversAtMs = 0;
  let foundRecovery = false;
  let exhaustedCount = 0;
  let enabledCount = 0;
  for (const row of options.rows) {
    if (!row.enabled) continue;
    enabledCount++;
    const kind = kindOf(row.kind);
    const exhausted = Boolean(snapshot && kind && kind.outOfCredits(row, snapshot));
    if (exhausted) {
      exhaustedCount++;
      // 额度什么时候回来 = 套餐窗口结束。
      const endsAt = planWindowEndsAt(row.id, now);
      if (endsAt !== null && (creditsRecoverAtMs === null || endsAt < creditsRecoverAtMs)) {
        creditsRecoverAtMs = endsAt;
      }
    }
    const info = cooling.get(row.id);
    const candidates: number[] = [];
    if (info) candidates.push(info.untilMs);
    if (exhausted) {
      const endsAt = planWindowEndsAt(row.id, now);
      if (endsAt !== null) candidates.push(endsAt);
    }
    if (!candidates.length) {
      // 这个账号既不在冷却也没有额度问题：它现在就能接（凭据的问题看凭据状态）。
      canServeNow = true;
      continue;
    }
    for (const at of candidates) {
      if (!foundRecovery || at < recoversAtMs) {
        recoversAtMs = at;
        foundRecovery = true;
      }
    }
  }
  // 有一个账号能接，这个上游就能接。
  if (canServeNow) recoversAtMs = 0;

  const parts: string[] = [];
  if (enabledCount > 0 && exhaustedCount === enabledCount) {
    parts.push(creditsRecoverAtMs === null ? "额度用尽" : `额度用尽，窗口 ${stamp(creditsRecoverAtMs)} 结束`);
  }
  if (cooldownUntilMs > 0) {
    parts.push(`冷却到 ${stamp(cooldownUntilMs)}${cooldownReason ? `（${cooldownReason}）` : ""}`);
  }

  return {
    cooldownUntilMs,
    cooldownReason,
    recoversAtMs,
    stateReason: parts.join("；"),
  };
}

/** 给面板看的时刻：上游的时区（UTC+8），只到分钟。 */
function stamp(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
}
