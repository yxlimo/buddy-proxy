// lib/quota-state.ts — 一次额度探测的结论，以及平台按结论做的那一次处理。
//
// 插件只回答一件事：「这次问到了什么」。ok / no_quota / blocked / unauthorized /
// rate_limited / missing / unknown 这七种就是插件能说的全部。至于「见底了怎么
// 办、被限流了怎么办、凭据被拒了怎么办」是平台的事，只写在 applyProbeEffect 这
// 一处 —— 七家平台各写一遍，就会有七份不一样的判断，其中六份迟早跟第七份不一致。
//
// 状态集只在这里定义：拼错一个字母就静默变成「不知道」，而「不知道」与「没钱」
// 是两件事，混起来就是替上游说话。

import { rateCooldownMs, setCooldown } from "./cooldown.ts";
import type { HealthSnapshot, QuotaView } from "./provider-kinds.ts";
import type { ProviderRow } from "./providers.ts";
import type { QuotaProbe } from "./quota-plugins.ts";

/** 一次探测的结论。 */
export type QuotaState =
  | "ok"
  | "no_quota"
  | "blocked"
  | "unauthorized"
  | "rate_limited"
  | "missing"
  | "unknown";

/** 全部状态。 */
export const QUOTA_STATES: readonly QuotaState[] = [
  "ok",
  "no_quota",
  "blocked",
  "unauthorized",
  "rate_limited",
  "missing",
  "unknown",
];

/** 这是不是一个认得的状态。 */
export function isQuotaState(value: unknown): value is QuotaState {
  return typeof value === "string" && (QUOTA_STATES as readonly string[]).includes(value);
}

/**
 * 造一次探测结果。
 *
 * 插件都走这里：状态、话、恢复时刻三样是每个分支都要写的，写成一堆对象字面量
 * 迟早会漏字段 —— 漏了 recoverAt 的「见底」没有恢复时刻，面板上它就成了永远
 * 不会回来的账号。
 */
export function quotaProbe(
  state: QuotaState,
  message: string,
  extra: { views?: QuotaView[]; recoverAt?: number | null } = {},
): QuotaProbe {
  return {
    state,
    views: extra.views ?? [],
    recoverAt: extra.recoverAt ?? null,
    message,
  };
}

/**
 * 快照里那一次探测的结果。
 *
 * 没问过（没指名插件、插件没登记、账号这一轮不在）就是 null —— 那是「没有答
 * 案」，不是「答了 ok」。
 */
export function probeOf(
  snapshot: HealthSnapshot | null | undefined,
  pluginId: string,
  accountId: string,
): QuotaProbe | null {
  const id = String(pluginId ?? "").trim();
  if (!id || !accountId) return null;
  const stored = snapshot?.plugins?.[id]?.[accountId];
  if (!stored || typeof stored !== "object") return null;
  // 状态是认得的才算数：认不出来的那一份读成「没有答案」，而不是当成 ok 把一份
  // 不知道什么形状的东西摆上面板。
  if (!isQuotaState((stored as QuotaProbe).state)) return null;
  return stored as QuotaProbe;
}

/**
 * 面板上那几行数字。
 *
 * 只有 ok 有数字：别的状态都不是「还剩多少」这个问题的答案。见底与「账号不能
 * 用」另给一条只有说明的额度 —— 两种都不能接，原因不同，面板要能分辨。
 */
export function quotaViewsOf(
  provider: ProviderRow,
  snapshot: HealthSnapshot | null | undefined,
  pluginId: string,
): QuotaView[] {
  const probe = probeOf(snapshot, pluginId, provider.id);
  if (!probe) return [];
  if (probe.state === "ok") {
    // 面板按这两个 id 分组：按当前账号写一遍，快照里那一份是谁的都不影响。
    return probe.views.map((view) => ({ ...view, upstreamId: provider.id, accountId: provider.id }));
  }
  if (probe.state === "no_quota" || probe.state === "blocked") {
    return [reasonView(provider, probe)];
  }
  return [];
}

/**
 * 见底了吗。
 *
 * 只有上游明说「钱用完了」（no_quota）或者明说「这个账号不能用」（blocked）才
 * 算。问不到、凭据被拒、没填凭据都不是 —— 不知道不等于没钱。
 */
export function outOfCreditsOf(
  provider: ProviderRow,
  snapshot: HealthSnapshot | null | undefined,
  pluginId: string,
): boolean {
  const state = probeOf(snapshot, pluginId, provider.id)?.state;
  return state === "no_quota" || state === "blocked";
}

/**
 * 什么时候回来（Unix 毫秒）。
 *
 * 只有三种状态有那个时刻：见底、被停用、被限流。其余都是 null —— 不知道，不猜。
 */
export function recoverAtOf(
  provider: ProviderRow,
  snapshot: HealthSnapshot | null | undefined,
  pluginId: string,
): number | null {
  const probe = probeOf(snapshot, pluginId, provider.id);
  if (!probe) return null;
  switch (probe.state) {
    case "no_quota":
    case "blocked":
    case "rate_limited":
      return probe.recoverAt;
    default:
      return null;
  }
}

/** 一句话往哪写（日志、面板提示）。 */
export type ProbeLog = (message: string) => void;

/**
 * 结论带来的副作用：唯一一处做这件事的地方。
 *
 * 只有限流会写冷却：被限流的账号等一会儿就能再用，而「见底」不是等出来的（等
 * 到什么时候由快照里的恢复时刻说），「凭据被拒」要重新授权（那是凭据那条线的
 * 事），「没填凭据」是用户还没填。把这几种都写成冷却，等于拿冷却当垃圾桶。
 */
export function applyProbeEffect(provider: ProviderRow, probe: QuotaProbe, log: ProbeLog = () => {}): void {
  switch (probe.state) {
    case "rate_limited": {
      const now = Date.now();
      // 上游说了多久就等多久；没说、或者说的时刻已经过去，按平台的默认时长。
      const until =
        probe.recoverAt !== null && probe.recoverAt > now ? probe.recoverAt : now + rateCooldownMs();
      setCooldown(provider.id, until, "rate-limit");
      log(`[QUOTA] 账号 ${provider.id} 被限流，冷却到 ${new Date(until).toISOString()}：${probe.message}`);
      return;
    }
    case "unauthorized":
      // 不算额度问题：不写冷却、不算见底，只把这句话交给凭据那条线。
      log(`[QUOTA] 账号 ${provider.id} 的凭据被拒（${probe.message}），额度不判`);
      return;
    case "unknown":
      log(`[QUOTA] 账号 ${provider.id} 的额度问不到：${probe.message}`);
      return;
    default:
      // ok / no_quota / blocked / missing 不在这里做事：见底与恢复时刻是读的时候
      // 从快照里算出来的，没填凭据是用户还没填。
      return;
  }
}

/**
 * 一条只有说明、没有数字的额度。
 *
 * 见底与「账号不能用」都不是「还剩多少」。数字写 0 的含义是「不知道」，面板不
 * 显示一行零，只显示 note 里那句话 —— 两种原因的话不一样，面板才分得出来。
 */
function reasonView(provider: ProviderRow, probe: QuotaProbe): QuotaView {
  return {
    upstreamId: provider.id,
    accountId: provider.id,
    credits: { total: 0, used: 0, remaining: 0, lots: [], note: probe.message },
  };
}
