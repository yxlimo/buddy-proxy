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
import { platformPolicy } from "./platforms.ts";
// 余额到期优先的次序：余额从额度快照读，钉住的状态按平台存在那一层。
import { pinNextAccount, pinnedAccountOf } from "./router/balance-order.ts";
import { kindOf } from "./provider-kinds.ts";
import { benefits } from "./admin/benefits.ts";
import { HEALTH_CACHE_MS, refreshHealthSnapshot } from "./admin/upstreams.ts";
import { BENEFITS_INTERVAL_MS } from "./admin/benefits.ts";
import { configFlag } from "./config.ts";
import { sweepExpiredCooldowns } from "./cooldown.ts";

/** 定时器多久醒一次。 */
const INTERVAL_MS = 60_000;

/** 上一次做完某一步的时刻。 */
const lastStep = new Map<string, number>();

/** 这一步多久做一次。 */
const STEP_INTERVAL_MS: Record<string, number> = {
  benefits: BENEFITS_INTERVAL_MS,
  scan: 5 * 60_000,
  snapshot: HEALTH_CACHE_MS,
  cooldown: 5 * 60_000,
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
  // 定时器关了就是什么都不做：不动任何登录态。
  if (!periodicEnabled()) return;
  // 上一轮还没跑完就不叠着跑：令牌是一次性的，两轮同时换同一个会话，平台会
  // 当成重放，把整个会话撤掉。
  if (running) return;
  running = true;
  try {
    await runOnce();
  } finally {
    running = false;
  }
}

/** 这一轮是不是正在跑。 */
let running = false;

/**
 * 重新钉「余额到期优先」的那些平台的账号。
 *
 * 判据是平台那一行的策略，不是 kind —— 赠金会过期这件事与哪一家平台无关。
 * 钉住的只是「现在该先用哪个账号」；余额本身是额度插件刚问回来的那一份，
 * 这里不去问上游。
 *
 * `force` 是两种情形：
 *
 *   - true：扫余额的节奏到了，按快照里的到期时刻重排一次（余额变了，次序要变）
 *   - false：这一轮只补「还没钉住」的平台 —— 策略刚改成余额到期优先时，
 *     下一轮就得能用上这个次序，不能等下一次扫余额
 *
 * 已经钉住的不在非 force 那一轮里改：路由那一层刚钉的「下一个账号」说的是
 * 「这个账号没钱了以后换谁」，这里改回去等于把它撤了。
 */
function repinBalancedPlatforms(force: boolean): void {
  for (const [platform, ids] of enabledAccountsByPlatform()) {
    if (platformPolicy(platform) !== "expiry_first") continue;
    if (!force && pinnedAccountOf(platform)) continue;
    pinOnePlatform(platform, ids);
  }
}

/** 开着的账号，按平台分组。 */
function enabledAccountsByPlatform(): Map<string, string[]> {
  const byPlatform = new Map<string, string[]>();
  for (const provider of listProviders()) {
    if (!provider.enabled) continue;
    byPlatform.set(provider.platform, [...(byPlatform.get(provider.platform) ?? []), provider.id]);
  }
  return byPlatform;
}

/** 给一个平台重新钉一个账号：失败了记一笔，不打断别的平台。 */
function pinOnePlatform(platform: string, ids: string[]): void {
  try {
    pinNextAccount(platform, ids);
    lastFailure.delete(`${platform}:scan`);
  } catch (e) {
    const err = e as { message?: string; hint?: string };
    noteFailure(`${platform}:scan`, err?.message ?? String(e), err?.hint);
  }
}

/**
 * 这一轮的重钉：扫余额的节奏到了就按快照重排一次；没到的那几轮只补「还没钉
 * 住」的平台。
 *
 * 策略刚改成余额到期优先时，下一轮就得钉上 —— 等下一次扫余额才钉的话，中间
 * 那段时间路由没有次序可用。重钉读的是缓存的快照，不花上游的额度。
 */
function repinBalancedPlatformsIfDue(): void {
  if (!due("scan")) {
    repinBalancedPlatforms(false);
    return;
  }
  done("scan");
  repinBalancedPlatforms(true);
}

async function runOnce(): Promise<void> {
  for (const provider of listProviders()) {
    const kind = kindOf(provider.kind);
    if (!kind) continue;
    // 1. 令牌快到期就换（启动那一轮是立刻换，好知道会话还活着没有）。
    if (kind.refresh) {
      try {
        await kind.refresh(provider);
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

  // 3. 重新钉「余额到期优先」的那些平台的账号。
  repinBalancedPlatformsIfDue();

  // 4. 读一次状态。
  if (due("snapshot")) {
    try {
      await refreshHealthSnapshot();
      done("snapshot");
    } catch (e) {
      noteFailure("snapshot", (e as Error)?.message ?? String(e));
    }
  }

  // 5. 清掉过期的冷却行。
  //
  // 冷却的判定是惰性的（比时间就行），这一步只是让表不长毛：过期的行留着也
  // 不碍事，但看着像还有账号在冷却。
  if (due("cooldown")) {
    try {
      const swept = sweepExpiredCooldowns();
      if (swept > 0) console.log(`[COOLDOWN] 清掉 ${swept} 条过期的冷却`);
      done("cooldown");
    } catch (e) {
      noteFailure("cooldown", (e as Error)?.message ?? String(e));
    }
  }
}

/**
 * 定时器开不开。
 *
 * 关掉它，网关就不动任何登录态：不换令牌、不签到、不扫余额。
 *
 * 为什么需要这个：换令牌时 refresh token 会轮换，而它是**一次性的**。同一
 * 份会话被换两次，平台会当成重放，把整个会话的令牌一起撤掉。调试、复现、
 * 离线测试的时候，宁可让令牌过期，也不要它自己动。
 *
 * 环境变量或数据库里都能设（`PERIODIC_ENABLED=false`）。设了之后要重启才
 * 生效：这个开关是启动时读一次的。
 */
function periodicEnabled(): boolean {
  return configFlag("PERIODIC_ENABLED", true);
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
  if (!periodicEnabled()) {
    console.log(
      "[PERIODIC] 定时器关了（PERIODIC_ENABLED=false）：不换令牌、不签到、不扫余额。",
    );
    return;
  }
  void runPeriodicOnce();
  const timer = setInterval(() => void runPeriodicOnce(), intervalMs);
  timer.unref?.();
}
