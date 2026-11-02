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
//   no_account         平台名下没有账号
//   accounts_off       有账号，但一个都没开
//   no_credential      有开着的账号，但一个能推理的凭据都没有
//   credential_expired 有开着的账号，推理凭据在，但它过期了（或被拒了）
//   credential_unknown 有开着的账号，但凭据一个都读不出来
//   out_of_credits     凭据有了，额度用尽了
//   cooling            凭据有了，没有能接的账号（有账号在冷却里）
//   ready              至少有一个账号现在就能接
//
// 「有账号且都关着」与「有账号开着但都没凭据」是两件事：前者是开关的问题，
// 后者是面板上要填 key 或者登录。报成同一句话，人就不知道该改哪一处。
//
// 会话型平台（MiniMax、Qoder、WorkBuddy、ZCode）压根没有「API Key」这一说：
// 它们的推理凭据就是登录会话。会话过期只说明「定时器还没刷好」，说成「没有
// 凭据」会把人引到填 key 上 —— 所以过期单独一档（credential_expired）。
//
// 凭据读不出来（网关自己的故障）也单独一档：那是「不知道凭据怎么样」，不是
// 「运维没配好」。混进 no_credential 会把平台的账说成运维的错。
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
import { exhaustedPlanWindowEndsAt } from "../plan-window.ts";
import { dataDir } from "../paths.ts";
import { kindOf, type HealthSnapshot } from "../provider-kinds.ts";
import { listProviders, type ProviderRow } from "../providers.ts";
import { platformOfAny, type Platform } from "../platforms.ts";
import { deadSession } from "../session.ts";
import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { hasUsableCredential } from "./credentials.ts";
import { inferenceCredentialsOf, type CredentialRow } from "./accounts.ts";

/** 这个平台现在的状态。 */
export type PlatformState =
  | "no_account"
  | "accounts_off"
  | "no_credential"
  | "credential_expired"
  | "credential_unknown"
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
   * 凭据读不出来（网关自己的故障）的账号也算在里面：不能因为网关自己读不出
   * 就说这个平台没配好。它们不在 usable 里 —— 不可验证的账号不该被派发挑中。
   *
   * 额度与冷却不管：额度用尽的平台照样公布模型、照样在目录里，只是现在接不了
   * 这个请求。
   */
  serving: ProviderRow[];
  /** 平台名下的账号总数。 */
  accounts: number;
  /** 平台名下的账号行。面板要逐个看账号时不用再读一遍表。 */
  rows: ProviderRow[];
  /** 名下开着的账号有几个。平台的开关就是这个：账号自己管自己。 */
  on: number;
  /**
   * 面板上该做什么：一句话。
   *
   * 三件要改的地方不一样的事 —— 加一个账号、打开一个账号、填凭据。只说
   * 「不可用」的话，人只能一个个试。
   */
  advice: string;
  /** 平台的模型目录（带元数据）。恒为平台全量。 */
  catalog: CatalogModel[];
  /** 平台的模型 id：目录里的那些。 */
  ids: string[];
  /**
   * 一个都接不了时最早能试的时刻；能接就是 null。
   *
   * 没有凭据时也是 null：等一会儿不会让凭据长出来。凭据过期与凭据读不出来
   * 也是 null：前者等的是刷新或重新登录（人做的），后者是网关自己的故障。
   */
  untilMs: number | null;
  /** 一句给日志用的话。 */
  reason: string;
}

/**
 * 一个账号的推理凭据现在怎么样。
 *
 * 四种：
 *
 *   ok        有能用的推理凭据
 *   missing   压根没有推理凭据（要人去面板上填 key 或者登录）
 *   expired   有，但过期了或被平台拒了（等人刷新或重新登录）
 *   unknown   读不出来 —— 网关自己的故障，不是运维没配好
 */
interface CredentialVerdict {
  state: "ok" | "missing" | "expired" | "unknown";
  /** 平台拒过这份会话：重新授权才有新的，等刷新没有用。 */
  refused: boolean;
}

/**
 * 这个账号的推理凭据现在怎么样。
 *
 * 读凭据抛异常不是「没有凭据」：那是网关自己的故障，不是运维没配好。当成
 * 「不知道」—— 不进 usable（不可验证的账号不该被派发挑中），但仍算这个平台
 * 名下有账号（不能因为网关自己读不出就说平台没配好）。读不出来这件事要落进
 * auth.log（数据卷里）：凭据的毛病要留痕。
 */
function credentialVerdictOf(row: ProviderRow): CredentialVerdict {
  let credentials: CredentialRow[];
  try {
    credentials = inferenceCredentialsOf(row.id);
  } catch (e) {
    authLog(dataDir(), `读 ${row.id} 的凭据失败`, (e as Error)?.message ?? String(e ?? ""));
    return { state: "unknown", refused: false };
  }
  if (!credentials.length) return { state: "missing", refused: false };
  if (credentials.some((c) => hasUsableCredential(c.status))) return { state: "ok", refused: false };
  // 有推理凭据但用不了：过期了。被平台拒过的会话也是过期（它已经作废了，
  // 重新授权才有新的）—— 两者要人做的事不一样，所以把「被拒」单独记下来。
  const dead = credentials.filter((c) => c.status === CredentialState.EXPIRED);
  if (!dead.length) return { state: "missing", refused: false };
  return { state: "expired", refused: dead.some((c) => Boolean(deadSession(c.id))) };
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
 * 为什么随便哪个账号都行：今天每个 kind 的 models() 只看平台（WorkBuddy 与
 * Qoder 看的是区域，其余是写死的清单），不看账号。所以 accounts[0] 只是要一
 * 个**确定**的答案（它是权重最大的那个），而不是因为它比别人强。改权重不会
 * 改目录 —— 目录跟着平台走。
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
        // 见底的窗口什么时候结束才是恢复时刻：窗口还有额度的时候，它的到期点
        // 只是一个边界（账号现在就能干活），拿它冒充恢复时间是在骗人。
        const at = said ?? exhaustedPlanWindowEndsAt(row.id, now);
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
  unreadable: number,
  normal: number,
): string {
  const base = ((): string => {
    switch (state) {
      case "no_account":
        return `平台 ${platformId} 还没有账号`;
      case "accounts_off":
        return `平台 ${platformId} 的 ${accounts} 个账号都关着`;
      case "no_credential":
        return `平台 ${platformId} 的 ${on} 个开着的账号都没有可用凭据`;
      case "credential_expired":
        return `平台 ${platformId} 的凭据过期了`;
      case "credential_unknown":
        return `平台 ${platformId} 的凭据读不出来`;
      case "out_of_credits":
        return `平台 ${platformId} 的额度用尽了`;
      case "cooling":
        return `平台 ${platformId} 现在没有能接的账号（有账号在冷却）`;
      case "ready":
        return `平台 ${platformId} 有 ${usable} 个账号能接请求`;
    }
  })();
  // 有正常账号混着时，把读不出来的那几个说清楚：它们不派发，但它们在。
  // 全都是读不出来的时候不用再说一遍 —— 上面那句已经说了。
  return unreadable > 0 && normal > 0
    ? `${base}（另有 ${unreadable} 个账号的凭据读不出来）`
    : base;
}

/**
 * 面板上该做什么。
 *
 * 与 reason 的分工：reason 是给日志看的一句话（这个平台为什么接不了），
 * advice 是给面板看的一句人话（该去改哪一处）。
 *
 * `refused` 是「平台拒过这份会话」：被拒过的会话等刷新没有用，只能重新
 * 登录 —— 这跟「过期了，等定时器刷」要人做的事不一样。
 */
function adviceOf(state: PlatformState, refused: boolean): string {
  switch (state) {
    case "no_account":
      return "这个平台还没有账号：在「上游」页加一个账号并登录";
    case "accounts_off":
      return "这个平台的账号都关着：在「上游」页打开一个";
    case "no_credential":
      return "没有可用凭据：在「上游」页填 API Key 或登录";
    case "credential_expired":
      return refused ? "凭据被拒了：重新登录" : "凭据过期了：等它自动刷新，或者重新登录";
    case "credential_unknown":
      return "凭据读不出来：看日志";
    case "out_of_credits":
      return "额度用尽了：等额度回来，或者换个账号";
    case "cooling":
      return "账号都在冷却里：等一会儿再试";
    case "ready":
      return "";
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
  // 凭据那一层：每个账号的推理凭据现在怎么样。
  const verdicts = new Map<string, CredentialVerdict>();
  for (const row of on) verdicts.set(row.id, credentialVerdictOf(row));
  const verdictOf = (row: ProviderRow): CredentialVerdict =>
    verdicts.get(row.id) ?? { state: "missing", refused: false };
  // 有能用的推理凭据的账号：会话只用来问额度的那些平台（门户 cookie、登录
  // 账号）不算 —— 配了它们也发不出一个请求。
  const ready = on.filter((row) => verdictOf(row).state === "ok");
  // 凭据读不出来的账号：仍算这个平台名下有账号（不能因为网关自己读不出就说平
  // 台没配好），但它们不进 usable —— 不可验证的账号不该被派发挑中。
  const unreadable = on.filter((row) => verdictOf(row).state === "unknown");
  // 推理凭据在，但它过期了或被拒了。
  const expired = on.filter((row) => verdictOf(row).state === "expired");
  // serving = 名下有账号、开着、而且有推理凭据（或者凭据读不出来 —— 那是网关
  // 自己的事，不是平台没配好）。
  const serving = on.filter((row) => {
    const state = verdictOf(row).state;
    return state === "ok" || state === "unknown";
  });
  // 额度用尽是按账号判的：平台上还有一个账号有额度，这个平台就还能接。
  const spent = (row: ProviderRow): boolean => {
    const kind = kindOf(row.kind);
    return Boolean(snapshot && kind && kind.outOfCredits(row, snapshot));
  };
  // 冷却表读进来的都是还没过期的（过期的行不等于是冷却中）。
  const cooling = (row: ProviderRow): boolean => cooldowns.has(row.id);
  const usable = ready.filter((row) => !spent(row) && !cooling(row));
  const allSpent = ready.length > 0 && ready.every(spent);
  // 「在冷却」是接不了的原因之一：没有账号能接，而有的账号在冷却。
  //
  // 一个账号在冷却、另一个还热着时，平台接得了 —— 那是那个账号的事，不是平台
  // 的事，报「冷却」会让人以为整个平台都停用了。
  const blockedByCooling = usable.length === 0 && ready.some(cooling);

  let state: PlatformState;
  if (accounts.length === 0) state = "no_account";
  else if (on.length === 0) state = "accounts_off";
  else if (serving.length === 0) {
    // 有开着的账号，但一个能推理的凭据都没有。有凭据但过期了是一件事（等人
    // 刷新或重新登录），压根没有是另一件（要人去面板上填）。
    state = expired.length ? "credential_expired" : "no_credential";
  } else if (ready.length === 0) {
    // 名下有账号，但它们的凭据一个都读不出来：那是网关自己的故障。
    state = "credential_unknown";
  } else if (allSpent) state = "out_of_credits";
  else if (blockedByCooling) state = "cooling";
  else state = "ready";

  const catalog = platformCatalog(platform, accounts, declared);
  return {
    platform: platform.id,
    kind: platform.kind,
    state,
    usable,
    serving,
    accounts: accounts.length,
    rows: accounts,
    on: on.length,
    advice: adviceOf(state, expired.some((row) => verdictOf(row).refused)),
    catalog,
    ids: catalog.map((m) => m.id),
    // 恢复时间只算「额度用尽」与「冷却」这两种：它们有时刻表。
    //
    // 凭据过期不是定时器能算的事（等的是刷新或重新登录，人做的），凭据读不
    // 出来更不是（那是网关自己的故障）—— 两种都给 null。
    untilMs:
      state === "out_of_credits" || state === "cooling"
        ? recoveryTime(ready, allSpent, cooldowns, snapshot, now)
        : null,
    reason: reasonOf(
      state,
      platform.id,
      accounts.length,
      on.length,
      usable.length,
      unreadable.length,
      ready.length,
    ),
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
