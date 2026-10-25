// lib/periodic.ts — 一条定时器，一件件事依次做。
//
// 一个登录态只有这一个定时器管它。每一次触发，依次：
//
//   1. 令牌快到期就换。这一步是唯一的主动刷新者：请求只会在令牌真的过期
//      时才换（见 lib/session.ts 的 RefreshMode），所以两处不会同时拿同一份
//      refresh token 去换——那会让其中一个被平台当成重放。
//   2. 今天没签到就签到。平台那边是幂等的，问两次会答「已经领过了」。
//   3. 余额该扫就扫。扫完按上游的策略看「现在该用哪个账户」要不要换
//      （余额到期优先：钱最先到期的那个账户）。
//   4. 读一次状态：面板要的余额、额度、签到结果。
//
// 各步的节奏不一样：换令牌每次都看（判断只是读一次库）；签到一小时一次
// （平台那边按周期翻）；扫余额跟钱包的缓存一样，五分钟；读状态跟健康快照的
// 缓存一样。

import { listProviders } from "./providers.ts";
import { kindOf } from "./provider-kinds.ts";
import type { RefreshMode } from "./session.ts";
import { benefits } from "./admin/benefits.ts";
import { HEALTH_CACHE_MS, refreshHealthSnapshot } from "./admin/upstreams.ts";
import { BENEFITS_INTERVAL_MS } from "./admin/benefits.ts";

/** 定时器多久醒一次。 */
const INTERVAL_MS = 60_000;

/** 上一次做完某一步的时刻。 */
const lastStep = new Map<string, number>();

/** 这一步多久做一次。 */
const STEP_INTERVAL_MS: Record<string, number> = {
  benefits: BENEFITS_INTERVAL_MS,
  scan: 5 * 60_000,
  snapshot: HEALTH_CACHE_MS,
};

/** 上一次失败的措辞：一样的就不重复打印了。 */
const lastFailure = new Map<string, string>();

/** 记一次失败，重复的不再打印。 */
function noteFailure(id: string, message: string, hint?: string): void {
  if (message === lastFailure.get(id)) return;
  lastFailure.set(id, message);
  console.warn(`[AUTH] ${id}: ${message}`);
  if (hint) console.warn(`       ${hint}`);
}

/** 这一步该做了吗。 */
function due(step: string): boolean {
  const interval = STEP_INTERVAL_MS[step];
  if (!interval) return true;
  const last = lastStep.get(step) ?? 0;
  return Date.now() - last >= interval;
}

/** 记下这一步做过。 */
function done(step: string): void {
  lastStep.set(step, Date.now());
}

/**
 * 把该做的事做一遍。
 *
 * 每一件都是独立的：某一件失败不挡住后面的。
 *
 * The refresh only swaps a token that is due. A session the platform has
 * revoked is noticed by the check-in and by the state read further down: they
 * ask the platform, and a 401 is the answer that says this credential is
 * spent.
 */
export async function runPeriodicOnce(): Promise<void> {
  for (const provider of listProviders()) {
    const kind = kindOf(provider.kind);
    if (!kind) continue;
    // 1. 令牌快到期就换（启动那一轮是立刻换，好知道会话还活着没有）。
    if (kind.refresh) {
      try {
        await kind.refresh(provider, "due");
        lastFailure.delete(`${provider.id}:refresh`);
      } catch (e) {
        const err = e as { message?: string; hint?: string };
        noteFailure(`${provider.id}:refresh`, err?.message ?? String(e), err?.hint);
      }
    }
  }

  // 2. 今天没签到就签到。
  if (due("benefits")) {
    try {
      await benefits.runOnce();
      done("benefits");
    } catch (e) {
      noteFailure("benefits", (e as Error)?.message ?? String(e));
    }
  }

  // 3. 余额该扫就扫；扫完按策略看「现在该用哪个账户」要不要换。
  if (due("scan")) {
    done("scan");
    for (const provider of listProviders()) {
      const kind = kindOf(provider.kind);
      if (!kind?.scan) continue;
      try {
        await kind.scan(provider);
        lastFailure.delete(`${provider.id}:scan`);
      } catch (e) {
        const err = e as { message?: string; hint?: string };
        noteFailure(`${provider.id}:scan`, err?.message ?? String(e), err?.hint);
      }
    }
  }

  // 4. 读一次状态。
  if (due("snapshot")) {
    try {
      await refreshHealthSnapshot();
      done("snapshot");
    } catch (e) {
      noteFailure("snapshot", (e as Error)?.message ?? String(e));
    }
  }
}

/**
 * 定时做事。
 *
 * 客户端是自己在后台换令牌的，网关也这样：不需要谁来点。
 *
 * The first round runs right away: the service has just started, and a
 * session the platform revoked should show up as expired right then.
 */
export function startPeriodic(intervalMs = INTERVAL_MS): void {
  void runPeriodicOnce();
  const timer = setInterval(() => void runPeriodicOnce(), intervalMs);
  timer.unref?.();
}
