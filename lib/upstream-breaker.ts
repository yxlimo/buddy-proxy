// lib/upstream-breaker.ts — 上游级（平台级）短熔断，带半开探测。
//
// 为什么要有它：冷却只有**账号级**（lib/router/account-cooldown.ts）。排队、超时、
// 连接断掉这一类失败**不记账号冷却** —— 理由见那个文件顶上：它们说的不是
// 「这个账号不能用了」，把它们算到账号头上会把同平台别的模型一起埋掉。于是
// 每次请求都要先赔一次上游往返才降级：qoder 那种每次都排队的平台，一个请求
// 先赔 60 秒（或者一次等待）才轮得到下一个目标。
//
// 平台级熔断记的是另一件事：「这个平台现在别来了」。连续 N 次可熔断的失败
// 之后，一段时间内不往它发请求（省掉那次往返），到点放**一个**探测进去，
// 探测成功就恢复，探测失败就再开一次、窗口翻倍。
//
// 与账号级冷却的关系：两者并存，各管各的。账号级说的是「这个账号现在接不了」，
// 平台级说的是「这个平台现在发不出去」。账号级管不了的失败（排队、网络错），
// 平台级管；平台级不该管的失败（限流、凭据被拒、额度见底）归账号级 ——
// 那是**账号**的事，把同平台的好账号一起埋掉是错的。
//
// 叶子模块（只 import lib/config.ts）：路由写它、面板读它，两边不能互相 import
// —— 理由与 lib/upstream-failures.ts 的文件头一样：admin 层不引路由层，路由层
// 也不引 admin 层。
//
// 纯内存：进程重启归零 —— 它是「刚发生了什么」的痕迹，不是我们自己的状态。

import { configFlag, configNumber, markHotSetting } from "./config.ts";

/** 熔断的总开关。默认关：凡是能改变路由行为的都先关着等人开。 */
const ENABLED = "UPSTREAM_BREAKER_ENABLED";
/** 连续几次可熔断的失败之后开闸。 */
const FAILURES = "UPSTREAM_BREAKER_FAILURES";
/** 第一次开闸的窗口（毫秒）。 */
const OPEN_MS = "UPSTREAM_BREAKER_OPEN_MS";
/** 窗口翻倍的封顶（毫秒）。 */
const MAX_OPEN_MS = "UPSTREAM_BREAKER_MAX_OPEN_MS";

// 开关是热的：面板改完，下一个请求就是新的值（读它的就是下面那几行）。
markHotSetting(ENABLED);

/** 熔断的那几个旋钮。 */
export interface BreakerSettings {
  /** 总开关。关着的时候这个模块什么都不做。 */
  enabled: boolean;
  /** 连续几次可熔断的失败之后开闸。 */
  failures: number;
  /** 第一次开闸的窗口（毫秒）。 */
  openMs: number;
  /** 窗口翻倍的封顶（毫秒）。 */
  maxOpenMs: number;
}

/**
 * 现在生效的那几个旋钮。
 *
 * 每次都问一遍配置：开关是热的（面板改完下一个请求就是新的值），旋钮改起来
 * 慢一点没关系，但也不能读成常量 —— 常量会把「面板上写着 3、代码里跑着 5」
 * 变成常态。
 */
export function breakerSettings(): BreakerSettings {
  const openMs = configNumber(OPEN_MS, 60_000);
  const maxOpenMs = configNumber(MAX_OPEN_MS, 600_000);
  return {
    enabled: configFlag(ENABLED, false),
    failures: Math.max(1, Math.floor(configNumber(FAILURES, 3))),
    // 窗口至少一秒：0 会让熔断开了就等于没开。
    openMs: Math.max(1000, openMs),
    // 封顶不能小于窗口本身，否则「翻倍」翻不动。
    maxOpenMs: Math.max(openMs, maxOpenMs),
  };
}

/**
 * 哪些失败可以熔断。
 *
 * 判据是「说的不是这个请求本身的问题」，而是「这个平台现在发不出去」：
 *
 *   queued      上游把模型排进了队列 —— 平台的现象，不是账号的（账号本身好好的，
 *               它别的模型现在就能接）。
 *   timeout     等不到上游 —— 这一会儿它发不出去。
 *   connection  连接被掐断 —— 同上。
 *   unreachable 主机名解析不出来 —— 整个平台都打不到。
 *   server      上游 5xx。
 *   empty       空答复：上游接了请求却什么都没给。
 *
 * 不在里面的那些，理由逐条：
 *
 *   request     请求本身的问题（400、上下文超长、请求体非法）：换一个上游也是
 *               这个错，熔断它等于把好平台埋掉。
 *   model       这个账号用不了这个模型（分组限制、免费模型限流）：模型的事。
 *   rate-limit / credential / no-balance / quota
 *               **账号的事**，账号级冷却已经管着（lib/router/account-cooldown.ts）：
 *               平台级熔断会把同平台的好账号一起埋掉，与既有规矩（排队、网络错
 *               不冷却账号）冲突。
 *   unknown     说不清是什么，不猜。
 */
const BREAKABLE_KINDS = new Set([
  "queued",
  "timeout",
  "connection",
  "unreachable",
  "server",
  "empty",
]);

/** 这个失败能不能熔断。 */
export function isBreakableKind(kind: string): boolean {
  return BREAKABLE_KINDS.has(kind);
}

/** 熔断处在哪个阶段。 */
export type BreakerPhase = "closed" | "open" | "half-open";

/** 一个平台的一份熔断状态。 */
interface PlatformBreaker {
  phase: BreakerPhase;
  /** 连续的可熔断失败次数（成功一次清零）。 */
  failures: number;
  /** 开闸到什么时候（绝对时刻，毫秒）。 */
  untilMs: number;
  /** 开过几次闸：窗口翻倍用它。 */
  trips: number;
  /** 半开探测在途的时刻：null = 现在没有探测在途。 */
  probeAtMs: number | null;
}

/** 每个平台一份。进程重启归零。 */
const states = new Map<string, PlatformBreaker>();

/** 现在该不该打这个平台。 */
export interface BreakerVerdict {
  /** false = 跳过这个平台（别花那次上游往返）。 */
  allow: boolean;
  /** 这一次是不是那一个半开探测。 */
  probe: boolean;
  phase: BreakerPhase;
  /** 熔断到什么时候（没有就 null —— 不编）。 */
  untilMs: number | null;
  /** 给日志看的一句话。 */
  reason: string;
}

/** 面板要的那两格。 */
export interface BreakerPanelState {
  /** 现在是不是在跳过这个平台。 */
  tripped: boolean;
  /** 恢复到什么时候（没有就 null —— 不编）。 */
  untilMs: number | null;
}

/**
 * 现在该不该打这个平台。
 *
 * 三种答案：
 *
 *   closed      放行。
 *   open        还没到点 → 跳过（不排队等：等下去只是把客户端的 socket 挂住）。
 *   half-open   到点了 → 抢那**唯一**的探测名额：抢到就放行（这一次是探测），
 *               抢不到就跳过（别人正在探）。
 *
 * 抢不到就跳过，不排队：排队等一个探测的结果，等的是上游，而上游正是不可靠的
 * 那个 —— 与其等，不如让别的目标去答。
 */
export function checkBreaker(platform: string, now = Date.now()): BreakerVerdict {
  const settings = breakerSettings();
  if (!settings.enabled) {
    return { allow: true, probe: false, phase: "closed", untilMs: null, reason: "熔断没开" };
  }
  const state = states.get(platform);
  if (!state || state.phase === "closed") {
    return { allow: true, probe: false, phase: "closed", untilMs: null, reason: "没熔断" };
  }
  if (state.phase === "open") {
    if (now < state.untilMs) {
      return {
        allow: false,
        probe: false,
        phase: "open",
        untilMs: state.untilMs,
        reason: "熔断中",
      };
    }
    // 到点了：进半开。下面抢探测名额。
    state.phase = "half-open";
  }
  // 半开：探测名额只有一个。
  if (state.probeAtMs !== null && now - state.probeAtMs < settings.openMs) {
    return {
      allow: false,
      probe: false,
      phase: "half-open",
      untilMs: null,
      reason: "半开探测在途",
    };
  }
  state.probeAtMs = now;
  return { allow: true, probe: true, phase: "half-open", untilMs: null, reason: "半开探测" };
}

/**
 * 记一次结局。
 *
 * `kind` 是分类给的词（lib/router/provider-selection.ts）："ok" 是成功，其余是
 * 失败的 kind。
 *
 *   "ok"        成功 → 关闭（计数清零，开闸次数也清零：下一次开闸从头来）。
 *   可熔断的    计数 +1；够次数就开闸。半开时失败 → 重新开闸，窗口翻倍。
 *   不可熔断的  **既不计数也不清零**（忽略）。
 *
 * 为什么不可熔断的失败是「忽略」而不是「清零」：清零会让「三次排队 + 一次
 * 400」永远熔断不了 —— 那一次 400 说的是这个请求不对，与这个平台发不发得出去
 * 没关系，它不该把已经攒起来的证据擦掉。计数也一样：请求本身的问题推不动熔断。
 *
 * 半开时那个不可熔断的失败有一点特别：它把探测名额还回去（探测已经结束了），
 * 但**不**重新开闸 —— 平台没有证据说它坏了，只是这一次没能证明它好，下一个
 * 请求接着探。
 */
export function noteBreakerOutcome(platform: string, kind: string, now = Date.now()): void {
  const settings = breakerSettings();
  // 开关关着的时候不记账：行为与现在完全一样（连内存里都不留痕迹）。
  if (!settings.enabled) return;
  if (kind === "ok") {
    // 成功：关闭。这一次成功说明平台回来了，攒着的失败没有意义了。
    states.delete(platform);
    return;
  }
  const state = states.get(platform) ?? {
    phase: "closed" as BreakerPhase,
    failures: 0,
    untilMs: 0,
    trips: 0,
    probeAtMs: null,
  };
  if (!isBreakableKind(kind)) {
    // 半开时把探测名额还回去：探测结束了，下一个请求可以接着探。
    if (state.phase === "half-open") state.probeAtMs = null;
    states.set(platform, state);
    return;
  }
  if (state.phase === "half-open") {
    // 探测失败：重新开闸，窗口翻倍（封顶 maxOpenMs）。
    trip(state, now, settings);
    state.failures = settings.failures;
  } else {
    state.failures += 1;
    if (state.failures >= settings.failures) trip(state, now, settings);
  }
  states.set(platform, state);
}

/**
 * 开闸：窗口按开过几次翻倍。
 *
 * 第一次开闸是 openMs，第二次 2×，第三次 4×……封顶在 maxOpenMs。翻倍的理由：
 * 一次排队可能是偶然，连续两次探测都失败说明它这一会儿真的发不出去 ——
 * 等得久一点比不停试划算（每一次试都要赔一次上游往返）。
 */
function trip(state: PlatformBreaker, now: number, settings: BreakerSettings): void {
  const window = Math.min(settings.openMs * 2 ** state.trips, settings.maxOpenMs);
  state.phase = "open";
  state.untilMs = now + window;
  state.trips += 1;
  state.probeAtMs = null;
}

/**
 * 面板要的那两格。
 *
 * `tripped` 说「现在是不是在跳过这个平台」；`untilMs` 说恢复到什么时候。
 *
 * 恢复时刻没有就返回 null，不编：半开的时候还没有恢复时刻（探测说了算），
 * 窗口过了的时候也还没有（下一个请求去探，探完才知道）。
 */
export function breakerPanelState(platform: string, now = Date.now()): BreakerPanelState {
  const state = states.get(platform);
  if (!state) return { tripped: false, untilMs: null };
  if (state.phase === "open") {
    if (now < state.untilMs) return { tripped: true, untilMs: state.untilMs };
    // 窗口已经过了：还没探，不算在跳过（下一个请求就是那个探测）。
    return { tripped: false, untilMs: null };
  }
  if (state.phase === "half-open") return { tripped: true, untilMs: null };
  return { tripped: false, untilMs: null };
}

/**
 * 把这个平台的状态清掉（测试用：每个场景从干净的状态开始）。
 *
 * 生产路径不用它：状态是「刚发生了什么」的痕迹，重启归零就是它的自然寿命。
 */
export function resetBreaker(platform?: string): void {
  if (platform === undefined) {
    states.clear();
    return;
  }
  states.delete(platform);
}
