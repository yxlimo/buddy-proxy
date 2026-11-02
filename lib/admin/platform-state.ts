// lib/admin/platform-state.ts — 这个平台现在能不能接请求。
//
// 「能不能接」是一件事，四个地方都要知道：路由选谁、目录公布什么、平台页说
// 什么、健康检查报什么。以前它们各自判一遍，判据只有「有没有开着的账号」——
// 账号建了但没填 key、没登录的平台照样公布模型、照样进候选，最后在转发里
// 才报「账号上没有推理用的 API key」。那时候已经答不出去了：答复写给客户端
// 就收不回来。
//
// 所以判定收在这里，四处都用它。判定的顺序就是状态的顺序，先命中先返回：
//
//   no_account      平台名下没有账号
//   accounts_off    有账号，但一个都没开
//   no_credential   有开着的账号，但一个能推理的凭据都没有
//   out_of_credits  凭据有了，额度用尽了
//   cooling         凭据有了，账号都在冷却里
//   ready           至少有一个账号现在就能接
//
// 「有账号且都关着」与「有账号开着但都没凭据」是两件事：前者是开关的问题，
// 后者是面板上要填 key 或者登录。报成同一句话，人就不知道该改哪一处。
//
// 额度用尽与冷却不摘模型：目录恒为平台全量。说的是「这个平台现在接不了这个
// 请求」，不是「这个平台没有这个模型」—— 后者会让客户端去改模型名，而真正
// 该做的是等一会儿再试。
//
// 它住在 admin 层：路由那边（lib/router/availability.ts）只做转发。admin 层
// 不引路由层，所以这里也不引 —— 套餐窗口那一问住在 lib/plan-window.ts，两边
// 问的是同一件事，答案也必须是同一个。

import { listAggregateModels } from "../aggregate.ts";
import type { CatalogModel } from "../catalog-models.ts";
import { listCooldowns, unavailableCooldownMs } from "../cooldown.ts";
import { authLog } from "../credential.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import { planWindowEndsAt } from "../plan-window.ts";
import { dataDir } from "../paths.ts";
import { kindOf, type HealthSnapshot } from "../provider-kinds.ts";
import { listProviders, type ProviderRow } from "../providers.ts";
import { platformOfAny, type Platform } from "../platforms.ts";
import { inferenceCredentialOf } from "./accounts.ts";

/** 这个平台现在的状态。 */
export type PlatformState =
  | "no_account"
  | "accounts_off"
  | "no_credential"
  | "out_of_credits"
  | "cooling"
  | "ready";

/** 一个平台的可用性。 */
export interface PlatformAvailability {
  /** 平台 id。 */
  platform: string;
  /** 这个平台的 kind 名（开放平台是那个还没登记的占位名）。 */
  kind: string;
  /** 现在的状态：先命中先返回。 */
  state: PlatformState;
  /**
   * 现在就能接请求的账号行。
   *
   * 关着的、没凭据的、额度用尽的、冷却中的都不在里面。
   */
  usable: ProviderRow[];
  /**
   * 开着的、有推理凭据的账号行。
   *
   * 额度与冷却不管：额度用尽的平台照样公布模型、照样在目录里，只是现在接不了
   * 这个请求。
   */
  serving: ProviderRow[];
  /** 平台名下的账号总数。 */
  accounts: number;
  /** 平台的模型目录（带元数据）。恒为平台全量。 */
  catalog: CatalogModel[];
  /** 平台的模型 id：目录里的那些。 */
  ids: string[];
  /**
   * 一个都接不了时最早能试的时刻；能接就是 null。
   *
   * 没有凭据时也是 null：等一会儿不会让凭据长出来。
   */
  untilMs: number | null;
  /** 一句给日志用的话。 */
  reason: string;
}

/**
 * 这个账号有没有能拿去推理的凭据。
 *
 * 读凭据抛异常不是「没有凭据」：那是网关自己的故障，不是运维没配好。当成
 * 「不知道」，照旧算它能接 —— 宁可多路由一次，也不要把平台的账说成运维没配。
 * 读不出来这件事要落进 auth.log（数据卷里）：凭据的毛病要留痕。
 */
function hasInferenceCredential(row: ProviderRow): boolean {
  try {
    return inferenceCredentialOf(row.id) !== null;
  } catch (e) {
    authLog(dataDir(), `读 ${row.id} 的凭据失败`, (e as Error)?.message ?? String(e ?? ""));
    return true;
  }
}

/**
 * 已发布模型的目标里声明过的上游模型 id，按平台分。
 *
 * 面板上可以在目标里手填一个上游模型 id —— 那是一次**明确的声明**：填的人知道
 * 那个上游有这个名字，只是目录里没有。上游的 /v3/config 本来就不是它实际能服务
 * 什么的完整清单（实测 workbuddy.cn 的 deepseek-v4.1-flash、kimi-k3.1-pro 后端
 * 都能正常出话，目录里一个字都没提），所以必须能补。
 *
 * 只认已发布模型里**启用着**的目标：随手乱写的名字没在任何地方声明过，仍然会被
 * routeInGroup 拒掉，那才是它该有的待遇。
 */
export function declaredModels(): Map<string, string[]> {
  const byPlatform = new Map<string, string[]>();
  for (const model of listAggregateModels()) {
    for (const target of model.targets) {
      if (!target.enabled) continue;
      const list = byPlatform.get(target.group) ?? [];
      if (!list.includes(target.upstreamModel)) list.push(target.upstreamModel);
      byPlatform.set(target.group, list);
    }
  }
  return byPlatform;
}

/**
 * 平台的模型目录。
 *
 * 目录是**平台**的，不是账号的：同一个平台下两个账号服务同一批模型。所以拿
 * 平台名下的第一个账号问 kind 要目录 —— 它要的是「这个平台是哪个区域」，
 * 账号之间的差别不影响。
 *
 * 声明过、目录里却没有的模型也补进来（见 declaredModels）。元数据不知道就不写
 * —— 目录没给，猜一个上下文长度等于对客户端撒谎。
 */
function platformCatalog(
  platform: Platform,
  accounts: ProviderRow[],
  declared: Map<string, string[]>,
): CatalogModel[] {
  const kind = kindOf(platform.kind);
  if (!kind || !accounts.length) return [];
  const models = [...kind.models(accounts[0])];
  for (const id of declared.get(platform.id) ?? []) {
    if (!models.some((m) => m.id === id)) {
      models.push({ id, displayName: id, reasoning: false, toolCall: false });
    }
  }
  return models;
}

/**
 * 这个平台的账号最早什么时候能接请求。
 *
 * 额度用尽的看额度什么时候回来：平台自己说（每个种类知道自己的窗口/批次什么时候
 * 满），说不出来才退回套餐窗口，再说不出来就是固定冷却时长。面板那边算的是同一
 * 个时间（lib/admin/upstream-state.ts），两处必须一致。
 *
 * 冷却中的看冷却到什么时候。
 */
function recoveryTime(
  rows: ProviderRow[],
  allSpent: boolean,
  cooldowns: Map<string, number>,
  snapshot: HealthSnapshot | null,
  now: number,
): number {
  const times = rows
    .map((row) => {
      if (allSpent) {
        const kind = kindOf(row.kind);
        const said = snapshot ? (kind?.recoverAt?.(row, snapshot) ?? null) : null;
        const at = said ?? planWindowEndsAt(row.id, now);
        if (typeof at === "number" && at > now) return at;
      }
      return cooldowns.get(row.id) ?? null;
    })
    .filter((at): at is number => typeof at === "number" && at > now);
  return times.length ? Math.min(...times) : now + unavailableCooldownMs();
}

/** 一句给日志用的话：这个平台为什么（不）能接请求。 */
function reasonOf(
  state: PlatformState,
  platformId: string,
  accounts: number,
  on: number,
  usable: number,
): string {
  switch (state) {
    case "no_account":
      return `平台 ${platformId} 还没有账号`;
    case "accounts_off":
      return `平台 ${platformId} 的 ${accounts} 个账号都关着`;
    case "no_credential":
      return `平台 ${platformId} 的 ${on} 个开着的账号都没有可用凭据`;
    case "out_of_credits":
      return `平台 ${platformId} 的额度用尽了`;
    case "cooling":
      return `平台 ${platformId} 的账号都在冷却里`;
    case "ready":
      return `平台 ${platformId} 有 ${usable} 个账号能接请求`;
  }
}

/** 判一个平台：账号、凭据、额度、冷却，一次说完。 */
function judge(
  platform: Platform,
  accounts: ProviderRow[],
  cooldowns: Map<string, number>,
  snapshot: HealthSnapshot | null,
  declared: Map<string, string[]>,
  now: number,
): PlatformAvailability {
  const on = accounts.filter((row) => row.enabled);
  // 能服务 = 开着的 **而且** 有推理用的凭据：会话只用来问额度的那些平台
  // （门户 cookie、登录账号）不算 —— 配了它们也发不出一个请求。
  const serving = on.filter((row) => hasInferenceCredential(row));
  // 额度用尽是按账号判的：平台上还有一个账号有额度，这个平台就还能接。
  const spent = (row: ProviderRow): boolean => {
    const kind = kindOf(row.kind);
    return Boolean(snapshot && kind && kind.outOfCredits(row, snapshot));
  };
  // 冷却表读进来的都是还没过期的（过期的行不等于是冷却中）。
  const cooling = (row: ProviderRow): boolean => cooldowns.has(row.id);
  const usable = serving.filter((row) => !spent(row) && !cooling(row));
  const allSpent = serving.length > 0 && serving.every(spent);
  // 「在冷却」是明说出来的：serving 里有账号在冷却，而不是「没全用尽就说明有
  // 一个在冷却」那种推理。
  const someCooling = serving.some(cooling);

  let state: PlatformState;
  if (accounts.length === 0) state = "no_account";
  else if (on.length === 0) state = "accounts_off";
  else if (serving.length === 0) state = "no_credential";
  else if (allSpent) state = "out_of_credits";
  else if (someCooling) state = "cooling";
  else state = "ready";

  const catalog = platformCatalog(platform, accounts, declared);
  return {
    platform: platform.id,
    kind: platform.kind,
    state,
    usable,
    serving,
    accounts: accounts.length,
    catalog,
    ids: catalog.map((m) => m.id),
    // 没有凭据的时候也是 null：等一会儿不会让凭据长出来，那种情况要人去面板上填。
    untilMs:
      serving.length > 0 && usable.length === 0
        ? recoveryTime(serving, allSpent, cooldowns, snapshot, now)
        : null,
    reason: reasonOf(state, platform.id, accounts.length, on.length, usable.length),
  };
}

/**
 * 几个平台的可用性，一次算完。
 *
 * 同一批表只读一遍：provider 表读一次、冷却表读一次、已发布模型读一次。请求
 * 那条路上这几个表都会被碰到，能合的就合。
 *
 * 平台表（allPlatforms）不在这里读 —— 那是调用方的事，它已经拿到了平台清单。
 */
export function platformAvailabilities(
  platforms: readonly Platform[],
  now = Date.now(),
): Map<string, PlatformAvailability> {
  const rows = listProviders();
  const byPlatform = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform);
    if (list) list.push(row);
    else byPlatform.set(row.platform, [row]);
  }
  const cooldowns = new Map(listCooldowns(now).map((row) => [row.providerId, row.untilMs]));
  const snapshot = peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
  const declared = declaredModels();
  const out = new Map<string, PlatformAvailability>();
  for (const platform of platforms) {
    out.set(
      platform.id,
      judge(platform, byPlatform.get(platform.id) ?? [], cooldowns, snapshot, declared, now),
    );
  }
  return out;
}

/** 一个平台的可用性。 */
export function platformAvailability(platformId: string, now = Date.now()): PlatformAvailability {
  const known = platformOfAny(platformId);
  const platform: Platform = known ?? { id: platformId, kind: "", label: platformId, region: "" };
  return platformAvailabilities([platform], now).get(platformId)!;
}
