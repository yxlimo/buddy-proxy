// lib/admin/models.ts — 公布的模型（聚合路由）与各上游的模型目录。
//
// 公布的模型是面板管的：对外的 id 背后有几个上游模型、怎么分流量。
// 它们的元数据可以留空，留空就是「上游说多少就是多少」—— 两个上游 fronts
// 同一个模型时，面板给的是两者里较小的那个上下文。

import { isPlatform } from "../platforms.ts";
import {
  deleteAggregateModel,
  getAggregateModel,
  listAggregateModels,
  listAggregateUsage,
  reloadAggregate,
  saveAggregateModel,
  type AggregateModel,
  type AggregateStrategy,
  type AggregateTarget,
} from "../aggregate.ts";
import {
  catalogGroups,
  healthSnapshot,
  outOfCredits,
  upstreamCredential,
  upstreamEnabled,
  type UpstreamId,
} from "./upstreams.ts";
import { hasUsableCredential } from "./credentials.ts";
import { platformCooling } from "./upstream-state.ts";
import { accountsOfPlatform } from "../providers.ts";
import { isCoolingDown } from "../cooldown.ts";
import { aggregateCatalog, type AggregateEntry, type CatalogGroup } from "../router/catalog.ts";
import type { HealthSnapshot } from "../provider-kinds.ts";
import { UnpublishedReason } from "../gen/buddy/admin/v1/admin_pb.ts";

/** 一个公布出来的模型。 */
export interface PublishedModelView {
  id: string;
  displayName: string;
  enabled: boolean;
  /**
   * 根路由现在真的公布它吗？
   *
   * 判据跟根路由一样：模型开着，而且至少有一个目标还在某个上游的目录里。
   * 上游全关着的时候，模型在库里但没人能接 —— 面板上要看得见这件事。
   */
  published: boolean;
  /** 没公布的原因。公布了就没有这个字段。 */
  unpublishedReason?: UnpublishedReason;
  strategy: string;
  /**
   * 元数据可以不给：不给就是「继承目标的值」。
   *
   * 这里是**库里存的那个**：空（NULL）就是继承，客户端原样存回去还是继承 ——
   * 上游改了才跟着改。现算出来的值在 `effective` 里，两个是不同的东西。
   */
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  effortOptions: string[];
  /**
   * 继承之后的值：现算的，算法跟根路由公布的是同一套（几个目标不一致时
   * 取最小的那个）。只读 —— 保存时忽略。
   */
  effective: {
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    toolCall?: boolean;
    effortOptions: string[];
  };
  targets: PublishedTargetView[];
  updatedAt: number;
}

/** 公布模型背后的一个上游模型。 */
export interface PublishedTargetView {
  groupName: string;
  upstreamModel: string;
  /** 权重。越大越优先。 */
  weight: number;
  enabled: boolean;
  requests: number;
  failed: number;
  /**
   * 现在真的会被用到的那一个目标（工作模型）。
   *
   * 同一时刻最多一个为 true。没有为 true 的目标时全部为 false —— 不指一个
   * 就是没有，别指一个假的。
   */
  current: boolean;
  /**
   * 这个目标现在接不了：平台在冷却、账号额度用尽、模型下架、凭据失效。
   *
   * 停用的目标不算「接不了」—— 它是自己关掉的，面板上写着「已停用」。
   */
  blocked: boolean;
  /** 为什么接不了，一句话，直接给人看。空 = 能接。 */
  blockedReason: string;
  /** 什么时候能再接（unix 毫秒）。0 = 算不出来（不猜）。 */
  recoversAtMs: number;
}

/**
 * 目标接不了的理由，给人看的一句话。
 *
 * 只说「接不了」不够用：面板上要能看出是模型没了、平台关了，还是没登录。
 */
const BLOCKER_REASON_LABELS: Partial<Record<UnpublishedReason, string>> = {
  [UnpublishedReason.MODEL_GONE]: "模型已下架",
  [UnpublishedReason.UPSTREAM_DISABLED]: "平台已停用",
  [UnpublishedReason.NO_CREDENTIAL]: "没有可用凭据",
  [UnpublishedReason.TARGET_DISABLED]: "目标已停用",
};

/** 平台那一层现在接不接得上。 */
interface PlatformState {
  /** 现在接得上吗（有一个账号开着、没在冷却、还有额度）。 */
  usable: boolean;
  /** 最早什么时候能再接（unix 毫秒）。0 = 现在就能接，或者算不出来。 */
  recoversAtMs: number;
  /** 一句给面板直接用的话。 */
  reason: string;
}

/**
 * 一个公布出来的模型没被公布的理由。
 *
 * 判据跟根路由那边一致（根路由拿 aggregateCatalog() 算的那份就是公布的
 * 清单），但这里多问一句：这个目标的上游登录了没有 —— 根路由的清单里不看
 * 凭据，模型在清单里但没人能接，面板要说得出来。
 *
 * 顺序：
 *
 *   1. 模型自己被停用了        → DISABLED
 *   2. 一个目标都没有          → NO_TARGET
 *   3. 目标全被停用了          → TARGET_DISABLED
 *   4. 目标的上游关着          → UPSTREAM_DISABLED
 *   5. 目标的上游没登录        → NO_CREDENTIAL
 *   6. 上游不列这个模型了      → MODEL_GONE
 *
 * 有一个目标能用，就是公布了（UNSPECIFIED）。多个目标有的能用有的不能时，
 * 能用的那些说了算 —— 理由留空。
 */
function unpublishedReason(model: AggregateModel, groups: CatalogGroup[]): UnpublishedReason {
  if (!model.enabled) return UnpublishedReason.DISABLED;
  if (!model.targets.length) return UnpublishedReason.NO_TARGET;
  const enabled = model.targets.filter((target) => target.enabled);
  if (!enabled.length) return UnpublishedReason.TARGET_DISABLED;
  let firstBlocker: UnpublishedReason = UnpublishedReason.UNSPECIFIED;
  for (const target of enabled) {
    const blocker = targetBlocker(target, groups);
    if (!blocker) return UnpublishedReason.UNSPECIFIED; // 有能用的目标 → 公布了
    if (firstBlocker === UnpublishedReason.UNSPECIFIED) firstBlocker = blocker;
  }
  return firstBlocker;
}

/** 一个目标为什么不能用。空 = 能用。 */
function targetBlocker(target: AggregateTarget, groups: CatalogGroup[]): UnpublishedReason {
  const group = target.group as UpstreamId;
  // 不认识的分组：不是九个平台之一，没有开关也没有目录 —— 当作关着。
  if (!isPlatform(group)) return UnpublishedReason.UPSTREAM_DISABLED;
  if (!upstreamEnabled(group)) return UnpublishedReason.UPSTREAM_DISABLED;
  const credential = upstreamCredential(group);
  if (!hasUsableCredential(credential.status)) return UnpublishedReason.NO_CREDENTIAL;
  const upstream = groups.find((g) => g.group === target.group);
  if (!upstream || !upstream.models.some((m) => m.id === target.upstreamModel)) {
    return UnpublishedReason.MODEL_GONE;
  }
  return UnpublishedReason.UNSPECIFIED;
}

/**
 * 一个平台的账号现在接得上吗：有一个账号开着、没在冷却、还有额度。
 *
 * 停用的账号不算：路由不会拿它接请求 —— 一个开着但在冷却的账号，配上一个
 * 停用但不在冷却的账号，这个平台还是接不上。
 * 额度读不出来时不算用尽：不知道不等于没有。
 */
function platformUsable(group: UpstreamId): boolean {
  if (!isPlatform(group)) return false;
  return accountsOfPlatform(group).some(
    (row) => row.enabled && !isCoolingDown(row.id) && !outOfCredits(row.id),
  );
}

/**
 * 平台那一层现在接不接得上，以及接得上的时候是什么时候。
 *
 * 额度快照读不出来就当不知道额度：不知道不等于没有，所以不去猜恢复时间。
 * 恢复时间只有平台自己说得清时才给 —— 猜一个时间比空着更坏。
 */
function platformStateOf(group: UpstreamId, snapshot: HealthSnapshot | null): PlatformState {
  const cooling = platformCooling({ rows: accountsOfPlatform(group), snapshot });
  let reason = cooling.stateReason;
  if (!reason) {
    if (cooling.cooldownUntilMs > 0) {
      reason = cooling.cooldownReason ? `平台在冷却（${cooling.cooldownReason}）` : "平台在冷却";
    } else {
      reason = "平台没有可用账号";
    }
  }
  return {
    usable: platformUsable(group),
    recoversAtMs: cooling.recoversAtMs,
    reason,
  };
}

/** 目标的标识：同一个模型下 group + 上游模型 才唯一。 */
function targetKey(target: AggregateTarget): string {
  return `${target.group}\u0000${target.upstreamModel}`;
}

/**
 * 现在真的会被用到的那一个目标（工作模型）。
 *
 * 路由的选法：目标按权重从大到小试，第一个「能用」的接住 —— 能用是指目标
 * 开着、上游开着、上游目录里还有这个模型、平台下有账号没在冷却、账号还有
 * 额度。一个都没有的时候不指：随便指一个就是在骗人。
 */
function currentTargetKey(
  model: AggregateModel,
  groups: CatalogGroup[],
  platformUsableOf: (group: UpstreamId) => boolean,
): string | null {
  const candidates = model.targets.filter(
    (target) => target.enabled && targetBlocker(target, groups) === UnpublishedReason.UNSPECIFIED,
  );
  const usable = candidates.filter((target) => platformUsableOf(target.group as UpstreamId));
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
  return targetKey(sorted[0]);
}

/**
 * 公布的模型，面板看的形状。
 *
 * 元数据是**库里存的那个**，不是合出来的：存的是空（继承）就是没有，客户端
 * 原样存回去还是继承。合出来的值由目录那边算（lib/router/catalog.ts），
 * 面板要显示的话可以用 ListModels 与目标自己算。
 *
 * `contextWindow` 与 `maxOutputTokens` 报的是**继承之后的值** —— 面板上写
 * 「继承」对谁都没用，要看的是这个模型实际上能用多少。合出来的算法跟
 * aggregateCatalog 一样（几个目标不一致时取最小的），所以面板上看到的
 * 就是根路由公布的。
 *
 * `published` 与 `unpublishedReason` 是同一个判断的两面：公布了就没有理由，
 * 没公布就有理由。两边不能各算一套 —— 上游一关，模型立刻就不公布了。
 */
export function publishedModels(): PublishedModelView[] {
  const usage = listAggregateUsage();
  const groups = catalogGroups();
  // 继承之后的值：跟根路由公布的是同一套算法。
  const effective = new Map<string, AggregateEntry>();
  for (const entry of aggregateCatalog(groups, listAggregateModels())) {
    effective.set(entry.id, entry);
  }
  // 平台那一层算一次就够：同一个平台的几个目标问的是同一件事，账号与额度
  // 不该在循环里反复读。
  const snapshot = healthSnapshot().data;
  const platformStates = new Map<string, PlatformState>();
  const stateOf = (group: UpstreamId): PlatformState => {
    let state = platformStates.get(group);
    if (!state) {
      state = platformStateOf(group, snapshot);
      platformStates.set(group, state);
    }
    return state;
  };
  return listAggregateModels().map((model) => {
    // 一个判断，两处用：公布了就是没有理由，没公布就有理由。
    const reason = unpublishedReason(model, groups);
    const inherited = effective.get(model.id);
    // The target in force right now: null means nothing can serve this model.
    const current = currentTargetKey(model, groups, (group) => stateOf(group).usable);
    return {
      id: model.id,
      displayName: model.displayName,
      enabled: model.enabled,
      published: reason === UnpublishedReason.UNSPECIFIED,
      // A published model has no reason: the field is absent then.
      unpublishedReason: reason === UnpublishedReason.UNSPECIFIED ? undefined : reason,
      strategy: model.strategy,
      // What the database holds: absent means "inherit from the targets".
      // The computed value goes into `effective` instead — they are two
      // different things, and putting the computed one here would make the
      // panel save it back and turn "inherit" into a fixed number.
      contextWindow: model.contextWindow ?? undefined,
      maxOutputTokens: model.maxOutputTokens ?? undefined,
      reasoning: model.reasoning ?? undefined,
      toolCall: model.toolCall ?? undefined,
      effortOptions: model.effortOptions ?? [],
      // The value in force right now, computed the same way the root route
      // computes it.
      effective: {
        contextWindow: model.contextWindow ?? inherited?.contextWindow,
        maxOutputTokens: model.maxOutputTokens ?? inherited?.maxOutputTokens,
        reasoning: model.reasoning ?? inherited?.reasoning,
        toolCall: model.toolCall ?? inherited?.toolCall,
        effortOptions: model.effortOptions ?? inherited?.effortOptions ?? [],
      },
      updatedAt: model.updatedAt,
      targets: model.targets.map((target) => {
        const row = usage.find(
          (u) => u.modelId === model.id && u.group === target.group && u.upstreamModel === target.upstreamModel,
        );
        // 目标自己接不了（模型没了、平台关了、没登录）是目标的事；目标没问题
        // 但平台接不上（冷却、额度用尽）是平台的事 —— 两种都说清楚。
        const blocker = targetBlocker(target, groups);
        const state = stateOf(target.group as UpstreamId);
        const blocked = target.enabled && (blocker !== UnpublishedReason.UNSPECIFIED || !state.usable);
        const blockedReason = blocked
          ? blocker !== UnpublishedReason.UNSPECIFIED
            ? BLOCKER_REASON_LABELS[blocker] ?? "这个目标现在接不了"
            : state.reason
          : "";
        return {
          groupName: target.group,
          upstreamModel: target.upstreamModel,
          weight: target.weight,
          enabled: target.enabled,
          requests: row?.requests ?? 0,
          failed: row?.failed ?? 0,
          current: current === targetKey(target),
          blocked,
          blockedReason,
          // 算不出来就是 0：前端不显示时间，不猜。
          recoversAtMs: state.recoversAtMs,
        };
      }),
    };
  });
}

/** 面板发过来的模型。 */
export interface PublishedModelInput {
  id: string;
  displayName: string;
  enabled: boolean;
  strategy: string;
  /** 不给 = 继承目标的值。 */
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  effortOptions: string[];
  targets: {
    groupName: string;
    upstreamModel: string;
    /** 权重。越大越优先。 */
    weight: number;
    enabled: boolean;
  }[];
}

/**
 * 保存一个公布的模型。
 *
 * 契约里「不给」就是继承目标的值，所以**不给就存 NULL**（继承），别存成 0
 * 或者 false —— 数据库那几列本来就是可空的，填死了就不再跟着上游变。
 * 客户端把读到的原样存回来，还是继承。
 *
 * 两个数字的 0 也当「没给」：0 不是真的上下文长度与输出上限，写进去会让
 * 模型目录拿它当承诺。布尔不一样：false 是真的「不支持」，要存进去。
 *
 * 目标的顺序是**权重从大到小**：先试权重大的，失败才试小的。权重一样时按
 * 上游模型名排 —— 面板要控制顺序，就给不同的权重。数据库里那列 position
 * 留着，但不再用它排序（写进去的是权重顺序里的序号）。
 *
 * 目标的请求数与失败数是网关自己数的，保存时会被覆盖，客户端传什么都不算。
 */
export function savePublishedModel(input: PublishedModelInput): { ok: boolean; id: string; message: string } {
  const id = String(input.id ?? "").trim();
  if (!id) {
    // 契约里说「id 为空表示新建」，可新建的模型总得有个对外的 id：网关不替
    // 面板起名字，起了面板也不知道。
    return { ok: false, id: "", message: "模型必须有 id（新建时先指定一个对外名称）" };
  }
  if (!input.targets?.length) return { ok: false, id, message: "模型至少需要配置一个上游" };
  const strategy: AggregateStrategy = input.strategy === "fallback" ? "fallback" : "single";
  // 权重从大到小。权重一样时排序是稳定的，面板给的先后留着。
  const sorted = [...input.targets].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
  const targets: AggregateTarget[] = sorted.map((target, index) => ({
    group: target.groupName as AggregateTarget["group"],
    upstreamModel: String(target.upstreamModel ?? "").trim(),
    weight: target.weight ?? 1,
    position: index,
    enabled: target.enabled !== false,
  }));
  if (targets.some((t) => !t.upstreamModel)) {
    return { ok: false, id, message: "每个目标都需要填写上游模型 id" };
  }
  // 目标的上游模型得是真的存在。写错一个字（"Minmax-M3.1-Flash" 而不是
  // "MiniMax-M3.1-Flash"）的话，模型能存进去，但根路由不会公布它 ——
  // 客户端连不上，界面上只写「未公布」，没人看得出原因。
  // 那个上游没有目录的时候说不了，存。
  const groups = catalogGroups();
  for (const target of targets) {
    const group = groups.find((g) => g.group === target.group);
    if (!group || group.models.length === 0) continue;
    const wanted = target.upstreamModel.toLowerCase();
    const found = group.models.some((m) => m.id.toLowerCase() === wanted);
    if (!found) {
      return {
        ok: false,
        id,
        message: `上游 ${target.group} 里没有模型「${target.upstreamModel}」。目录里有：${group.models
          .slice(0, 6)
          .map((m) => m.id)
          .join("、")}${group.models.length > 6 ? " …" : ""}`,
      };
    }
  }
  const model = saveAggregateModel({
    id,
    displayName: String(input.displayName ?? id),
    enabled: input.enabled !== false,
    strategy,
    // 0 不是真的上下文长度（模型目录会拿它当承诺），当「没给」处理。
    contextWindow: input.contextWindow ? input.contextWindow : null,
    maxOutputTokens: input.maxOutputTokens ? input.maxOutputTokens : null,
    reasoning: input.reasoning ?? null,
    toolCall: input.toolCall ?? null,
    effortOptions: input.effortOptions?.length ? input.effortOptions : null,
    targets,
  });
  // The published models are read once and then kept, so the panel's change has
  // to be picked up: the model is live right away, no restart needed.
  reloadAggregate();
  return { ok: true, id: model.id, message: `保存了 ${model.id}（${model.targets.length} 个目标）` };
}

/** 删掉一个公布的模型。 */
export function deletePublishedModel(id: string): { ok: boolean; message: string } {
  if (!getAggregateModel(id)) return { ok: false, message: `没有这个模型：${id}` };
  deleteAggregateModel(id);
  reloadAggregate();
  return { ok: true, message: `删掉了 ${id}` };
}

/* ------------------------------------------------------------------ *
 * 各上游的模型目录
 * ------------------------------------------------------------------ */

/** 目录里的一个模型。 */
export interface CatalogModelView {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  toolCall: boolean;
  effortOptions: string[];
  /** 计费倍率，0 是免费。 */
  credits: number;
}

/**
 * 各上游的模型目录。
 *
 * 不给上游就是全部。倍率只有 WorkBuddy 与 Qoder 有 —— MiniMax 与
 * TokenRhythm 的模型都是免费的（倍率记 0）。
 *
 * 目录取自 `catalogGroups()`：那是唯一看开关的地方（关着的上游不公布模型）。
 * 以前这里各读各的目录，WorkBuddy 与 TokenRhythm 忘了看开关 —— 上游关了
 * 面板上还列着它的模型。
 */
export function catalogModels(upstreamId = ""): CatalogModelView[] {
  const out: CatalogModelView[] = [];
  for (const group of catalogGroups()) {
    if (upstreamId && group.group !== upstreamId) continue;
    for (const m of group.models) {
      out.push({
        id: m.id,
        displayName: m.displayName,
        contextWindow: m.contextWindow ?? 0,
        maxOutputTokens: m.maxOutputTokens ?? 0,
        reasoning: m.reasoning,
        toolCall: m.toolCall,
        effortOptions: m.effortOptions ?? [],
        credits: m.credits ?? 0,
      });
    }
  }
  return out;
}
