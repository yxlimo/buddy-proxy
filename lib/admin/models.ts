// lib/admin/models.ts — 公布的模型（聚合路由）与各上游的模型目录。
//
// 公布的模型是面板管的：对外的 id 背后有几个上游模型、怎么分流量。
// 它们的元数据可以留空，留空就是「上游说多少就是多少」—— 两个上游 fronts
// 同一个模型时，面板给的是两者里较小的那个上下文。

import {
  aggregateModels,
  deleteAggregateModel,
  getAggregateModel,
  listAggregateModels,
  listAggregateUsage,
  reloadAggregate,
  saveAggregateModel,
  type AggregateStrategy,
  type AggregateTarget,
} from "../aggregate.ts";
import {
  catalogGroups,
  minimaxVisible,
  qoderVisible,
  workbuddyCatalog,
  type UpstreamId,
} from "./upstreams.ts";
import { qoderLabel, QODER_EFFORTS } from "../qoder/models.ts";
import { workbuddyLabel } from "../workbuddy/models.ts";
import { aggregateCatalog, tokenRhythmCatalogModels } from "../router/catalog.ts";

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
  strategy: string;
  /**
   * 元数据可以不给：不给就是「继承目标的值」。
   *
   * 库里存的是空（NULL）的时候这里就是没有，客户端原样存回去还是继承 ——
   * 上游改了才跟着改。真正合出来的值由目录那边算（lib/router/catalog.ts），
   * 面板要显示的话可以用 ListModels 与目标自己算。
   */
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  effortOptions: string[];
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
}

/**
 * 公布的模型，面板看的形状。
 *
 * 元数据是**库里存的那个**，不是合出来的：存的是空（继承）就是没有，客户端
 * 原样存回去还是继承。合出来的值由目录那边算（lib/router/catalog.ts），
 * 面板要显示的话可以用 ListModels 与目标自己算。
 *
 * `published` 用的是目录那边的判据：根路由拿 aggregateCatalog() 算出来的那
 * 份就是根路由公布的清单，面板说「公布了」就是说它在那份清单里。两边不能
 * 各算一套 —— 上游一关，模型立刻就不公布了。
 */
export function publishedModels(): PublishedModelView[] {
  const usage = listAggregateUsage();
  const live = new Set(aggregateCatalog(catalogGroups(), aggregateModels()).map((entry) => entry.id));
  return listAggregateModels().map((model) => ({
    id: model.id,
    displayName: model.displayName,
    enabled: model.enabled,
    published: live.has(model.id),
    strategy: model.strategy,
    contextWindow: model.contextWindow ?? undefined,
    maxOutputTokens: model.maxOutputTokens ?? undefined,
    reasoning: model.reasoning ?? undefined,
    toolCall: model.toolCall ?? undefined,
    effortOptions: model.effortOptions ?? [],
    updatedAt: model.updatedAt,
    targets: model.targets.map((target) => {
      const row = usage.find(
        (u) => u.modelId === model.id && u.group === target.group && u.upstreamModel === target.upstreamModel,
      );
      return {
        groupName: target.group,
        upstreamModel: target.upstreamModel,
        weight: target.weight,
        enabled: target.enabled,
        requests: row?.requests ?? 0,
        failed: row?.failed ?? 0,
      };
    }),
  }));
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
    return { ok: false, id: "", message: "模型得有 id（新建的时候先给它起一个对外的名字）" };
  }
  if (!input.targets?.length) return { ok: false, id, message: "模型至少要有一个上游" };
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
    return { ok: false, id, message: "每个目标都要有上游的模型 id" };
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

/** Qoder 的倍率是给客户端看的字符串（"0.5×"），这里换成数。 */
function qoderCredits(multiplier: string | undefined): number {
  if (!multiplier) return 0;
  const n = Number(String(multiplier).replace(/[×x]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * 各上游的模型目录。
 *
 * 不给上游就是全部。倍率只有 WorkBuddy 与 Qoder 有 —— MiniMax 与
 * TokenRhythm 的模型都是免费的（倍率记 0）。
 */
export function catalogModels(upstreamId = ""): CatalogModelView[] {
  const out: CatalogModelView[] = [];
  const want = (id: UpstreamId) => !upstreamId || upstreamId === id;

  if (want("qoder")) {
    for (const m of qoderVisible("global")) {
      out.push({
        id: m.id,
        displayName: qoderLabel(m),
        contextWindow: m.context ?? 0,
        maxOutputTokens: m.maxOutput,
        reasoning: m.reasoning,
        toolCall: true,
        effortOptions: m.kind === "tier" ? [...QODER_EFFORTS] : [],
        credits: qoderCredits(m.multiplier),
      });
    }
  }
  if (want("qoder-cn")) {
    for (const m of qoderVisible("cn")) {
      out.push({
        id: m.id,
        displayName: qoderLabel(m),
        contextWindow: m.context ?? 0,
        maxOutputTokens: m.maxOutput,
        reasoning: m.reasoning,
        toolCall: true,
        effortOptions: m.kind === "tier" ? [...QODER_EFFORTS] : [],
        credits: qoderCredits(m.multiplier),
      });
    }
  }
  if (want("workbuddy-cn")) {
    for (const m of workbuddyCatalog()) {
      out.push({
        id: m.id,
        displayName: workbuddyLabel(m),
        contextWindow: m.context,
        maxOutputTokens: m.maxOutput,
        reasoning: m.reasoning,
        toolCall: m.tools,
        effortOptions: [...m.efforts],
        credits: m.credits,
      });
    }
  }
  if (want("minimax")) {
    for (const m of minimaxVisible()) {
      out.push({
        id: m.id,
        displayName: m.display_name,
        contextWindow: m.context,
        maxOutputTokens: m.output,
        reasoning: m.reasoning,
        toolCall: m.tool_call,
        effortOptions: [...m.effortOptions],
        credits: 0,
      });
    }
  }
  if (want("tokenrhythm")) {
    for (const m of tokenRhythmCatalogModels()) {
      out.push({
        id: m.id,
        displayName: m.displayName,
        contextWindow: m.contextWindow ?? 0,
        maxOutputTokens: m.maxOutputTokens,
        reasoning: m.reasoning,
        toolCall: m.toolCall,
        effortOptions: m.effortOptions ?? [],
        credits: 0,
      });
    }
  }
  return out;
}
