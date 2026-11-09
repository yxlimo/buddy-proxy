// lib/quota-state.ts — 一次额度探测的结论，以及平台按结论做的那一次处理。
//
// 插件只回答一件事：「这次问到了什么」。ok / no_quota / blocked / unauthorized /
// rate_limited / missing / unknown 这七种就是插件能说的全部。至于「见底了怎么
// 办、凭据被拒了怎么办」是平台的事，只写在 applyProbeEffect 这一处 —— 七家平台
// 各写一遍，就会有七份不一样的判断，其中六份迟早跟第七份不一致。
//
// 被限流不在这里写冷却：额度探测打到的是查额度的那个接口，它答 429 只说明那个
// 接口这会儿忙。路由冷却说的是「这个账号暂时不能接推理请求」，两件事没有关系 ——
// 把前者写成后者，一次额度探测的限流就能把一个能推理的账号踢下线。
//
// 状态集只在这里定义：拼错一个字母就静默变成「不知道」，而「不知道」与「没钱」
// 是两件事，混起来就是替上游说话。

import { accountRecoveryAtMs } from "./admin/platform-state.ts";
import { listCooldowns } from "./cooldown.ts";
import { openPlatformOf } from "./open-platforms.ts";
import type { HealthSnapshot, QuotaView } from "./provider-kinds.ts";
import type { ProviderRow } from "./providers.ts";
import type { QuotaProbe } from "./quota-plugins.ts";

/**
 * 这个账号的额度归哪个插件问。
 *
 * 只有一个来源：平台行那一格（platform.quota_plugin）。写快照的一头按它问，读
 * 结论的一头也按它取 —— kind 那边再写一份插件 id，两边就有了两份判断，改一边
 * 忘一边时面板自相矛盾：数字在 A 插件下，结论从 B 插件读。
 */
export function quotaPluginIdOf(provider: Pick<ProviderRow, "platform">): string {
  return openPlatformOf(provider.platform)?.quotaPlugin?.trim() ?? "";
}

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
 * 用」也不给一条数字全 0 的额度 —— 写 0 是在说「额度是 0」，而我们只该说
 * 「用尽」或「不能用」，那两件事由 quotaConclusionOf 的状态与一句话说。
 */
export function quotaViewsOf(
  provider: ProviderRow,
  snapshot: HealthSnapshot | null | undefined,
  pluginId: string,
): QuotaView[] {
  const probe = probeOf(snapshot, pluginId, provider.id);
  if (!probe) return [];
  if (probe.state !== "ok") return [];
  // 面板按这两个 id 分组：upstreamId 是**平台**（余额页按平台分组，同一平台的
  // 几份余额能合起来看），accountId 是这条数字属于哪个账号。两个都按当前账号
  // 行写，快照里那一份是怎么写的都不影响。
  return probe.views.map((view) => ({ ...view, upstreamId: provider.platform, accountId: provider.id }));
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
 * 插件说的恢复时刻（Unix 毫秒）—— 原样，不估。
 *
 * 只有三种状态带那个时刻：见底、被停用、被限流。其余都是 null —— 插件不知道，
 * 不猜。
 *
 * 这是**插件那一份**（种类用它当 recoverAt）；面板那格与路由那句用的是
 * accountRecoveryAtMs（插件没说时按窗口/冷却估），不是这个。
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
 * 面板上要显示的那份额度结论：状态、恢复时刻、一句话。
 *
 * 数字回答「还剩多少」，这三格回答「为什么没有数字」—— 用尽、不能用、问不到
 * 都不是 0，把这三件事写成一条数字全 0 的额度等于替上游说「额度是 0」。
 */
export interface QuotaConclusion {
  /** 认得的那个状态；null = 这一份答复没有额度结论。 */
  state: QuotaState | null;
  /** 什么时候恢复（Unix 毫秒）；0 = 不知道。 */
  recoverAtMs: number;
  /** 给人看的一句话；空串 = 没有话要说。 */
  message: string;
}

/**
 * 面板上要显示的那份额度结论。
 *
 * 没有结论时三格全是空 / 0：0 说的是「不知道」，不是「额度是 0」。判空与
 * probeOf 一致：没指名插件、插件没登记、快照里没这一份。
 *
 * 恢复时刻由 accountRecoveryAtMs 一处给：面板这一格与路由 402/503 那句必须是
 * 同一个数。吞在这里算一份、路由再算一份，两边就会各说各的（插件不给时刻时
 * 一边报 0、一边报一个固定时长）。
 */
export function quotaConclusionOf(
  provider: ProviderRow,
  snapshot: HealthSnapshot | null | undefined,
  pluginId: string,
  /** 冷却表（账号 id → 冷却到什么时候）。不传就自己读一次。 */
  cooldowns?: Map<string, number>,
  now = Date.now(),
): QuotaConclusion {
  const probe = probeOf(snapshot, pluginId, provider.id);
  if (!probe) return { state: null, recoverAtMs: 0, message: "" };
  const cooling =
    cooldowns ?? new Map(listCooldowns(now).map((row) => [row.providerId, row.untilMs]));
  return {
    state: probe.state,
    // 0 = 不知道：额度不会因为过了一阵就回来。
    recoverAtMs: accountRecoveryAtMs(provider, snapshot ?? null, cooling, now),
    message: probe.message,
  };
}

/**
 * 结论带来的副作用：唯一一处做这件事的地方。
 *
 * 只有一种状态要记一笔：被限流时留一行日志（带插件 id — 哪个接口限的，账号，
 * 恢复时刻）。不写路由冷却 —— 查额度的接口 429 与「这个账号能不能接推理请求」
 * 是两件事，拿冷却去记它等于让一次额度探测把账号踢下线。见底不是等出来的（恢复
 * 时刻在快照里），「凭据被拒」要重新授权，「没填凭据」是用户还没填，三种都不该
 * 拿冷却当垃圾桶。
 */
export function applyProbeEffect(
  provider: ProviderRow,
  probe: QuotaProbe,
  pluginId: string,
  log: ProbeLog = () => {},
): void {
  switch (probe.state) {
    case "rate_limited": {
      // 恢复时刻照上游说的报；没说就是「不知道」，不编一个。
      const at = probe.recoverAt === null ? "不知道" : new Date(probe.recoverAt).toISOString();
      log(`[QUOTA] 账号 ${provider.id} 的额度接口被限流（插件 ${pluginId}），恢复时刻 ${at}：${probe.message}`);
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
