// lib/catalog-models.ts — the model list, one shape whatever the client wants.
//
// The models of every upstream, rendered into the shape the list uses. It
// lives on its own so the provider registry (lib/kinds.ts) and the router can
// both use it without importing each other.

import { QODER_EFFORTS, qoderCredits, qoderLabel, type QoderModel } from "./qoder/models.ts";
import { workbuddyLabel, type WorkBuddyModel } from "./workbuddy/models.ts";
import type { MiniMaxModel } from "./minimax/models.ts";
import type { ZcodeModel } from "./zcode/models.ts";
import { TOKENRHYTHM_MODELS } from "./tokenrhythm/models.ts";
import type { SenseNovaModel } from "./sensenova/models.ts";
import type { InternAiCatalogModel } from "./intern-ai/models.ts";
// 目录是平台那一行的（见 catalogModelsFromRow）：这里只读行，不写行。
import { openPlatformOf } from "./open-platforms.ts";

/** A model, the same whatever the shape the client wants it in. */
export interface CatalogModel {
  /** The model id as the upstream knows it. */
  id: string;
  /** The name the list shows. */
  displayName: string;
  /** Whether the model can think. Absent when nobody knows — not the same as false. */
  reasoning?: boolean;
  /** Whether the model can call tools. Absent when nobody knows — not the same as false. */
  toolCall?: boolean;
  /** Absent when the gateway advertises no context window for the model. */
  contextWindow?: number;
  /** Absent when the platform does not say how much the model may answer. */
  maxOutputTokens?: number;
  /** The thinking levels the model accepts, if it has a choice. */
  effortOptions?: string[];
  /** The model the gateway actually ran, when it is not the one that was asked for. */
  backend?: string;
  /** What the account is charged at: 0 is free. Absent when nobody says. */
  credits?: number;
}

export function qoderCatalogModels(models: QoderModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: qoderLabel(m),
    reasoning: m.reasoning,
    toolCall: true,
    contextWindow: m.context,
    maxOutputTokens: m.maxOutput,
    // A tier accepts a thinking level; a pinned model either thinks or does not,
    // and the list says which.
    ...(m.kind === "tier" ? { effortOptions: [...QODER_EFFORTS] } : {}),
    ...(m.backend ? { backend: m.backend } : {}),
    credits: qoderCredits(m.multiplier),
  }));
}

export function workbuddyCatalogModels(models: WorkBuddyModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: workbuddyLabel(m),
    reasoning: m.reasoning,
    toolCall: m.tools,
    contextWindow: m.context,
    maxOutputTokens: m.maxOutput,
    ...(m.efforts.length ? { effortOptions: [...m.efforts] } : {}),
    credits: m.credits,
  }));
}

export function minimaxCatalogModels(models: MiniMaxModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.display_name,
    reasoning: m.reasoning,
    toolCall: m.tool_call,
    contextWindow: m.context,
    maxOutputTokens: m.output,
    effortOptions: m.effortOptions,
  }));
}

/** ZCode 的模型目录（内置的静态表）。 */
export function zcodeCatalogModels(models: ZcodeModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    contextWindow: m.context,
    maxOutputTokens: m.output,
    ...(m.efforts.length ? { effortOptions: [...m.efforts] } : {}),
  }));
}

export function tokenRhythmCatalogModels(): CatalogModel[] {
  return TOKENRHYTHM_MODELS.map((m) => ({
    id: m.id,
    displayName: m.name,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    effortOptions: [...m.efforts],
    contextWindow: m.context,
    maxOutputTokens: m.maxOutput,
  }));
}

/**
 * SenseNova 的模型目录。
 *
 * 能力是平台自己报的（supported_features 里有 tools、reasoning），上下文长度
 * 与输出上限也是（context_length、max_output_length）。平台没报的那一项这里
 * 就没有 —— 不拿别的数来填。
 */
export function senseNovaCatalogModels(models: SenseNovaModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.name || m.id,
    reasoning: m.features.includes("reasoning"),
    toolCall: m.features.includes("tools"),
    ...(m.contextLength > 0 ? { contextWindow: m.contextLength } : {}),
    ...(m.maxOutputLength > 0 ? { maxOutputTokens: m.maxOutputLength } : {}),
  }));
}

/**
 * 书生·端砚的模型目录。
 *
 * 上下文长度是平台报的；输出上限平台没报，所以这里也没有 —— 客户端问多少
 * 就发多少。
 */
export function internAiCatalogModels(models: InternAiCatalogModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.name || m.id,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    ...(m.contextLength > 0 ? { contextWindow: m.contextLength } : {}),
  }));
}

/* ------------------------------------------------------------------ *
 * 平台的目录：行说有哪些，表说它们是什么
 * ------------------------------------------------------------------ */

/**
 * 只认得名字的模型。
 *
 * 元数据表里没有它 —— 名字是行里的，能力与窗口我们不知道。不知道就不写：填
 * 一个猜的数等于对客户端撒谎（客户端会拿它当承诺）。这两个布尔也不例外：
 * `toolCall: false` 会被读成「这个模型不能调工具」，而它可能能 —— 与
 * contextWindow 同一个口径，缺键才是「这一层没有关于它的知识」。见
 * CatalogModel 上那两个字段的注释。
 */
export function minimalCatalogModel(id: string): CatalogModel {
  return { id, displayName: id };
}

/**
 * 平台的目录：平台那一行说了算。
 *
 * 行里的 id 与**顺序**就是公布的 id 与顺序（顺序决定面板与路由里的模型次序）。
 * 元数据按 id 去 `known` 里查：七牛云、讯飞星火、TokenRhythm 查代码里的元数据
 * 表，SenseNova 与书生·端砚查上游缓存；查不到就给最小形状。
 *
 * 两种「空」不是一个意思，别混：
 *
 *   行读不到（null）：模板行本该由迁移补出，理论上不该发生。这时退回各家自己的
 *     **兜底源**，而它们不是同一种东西：
 *
 *       qiniu / xinghuo / tokenrhythm  代码里的常量表（lib/<kind>/models.ts），
 *         与路由读的是同一份。
 *       sensenova / intern-ai          上游目录的缓存（cache 表里那一份）—— 这两家
 *         没有代码目录，缓存就是它们手上唯一的事实。
 *       openai / anthropic              没有兜底：这两类平台的目录只在表里那一行，
 *         行没了就是空。上面说的「整组消失」在它们身上照样发生 —— 留一个兜底名字
 *         不等于每家都有东西可退。
 *
 *     兜底是**兜底**，不是常态；按家写清楚退到哪儿，是因为那个后果不一样大。
 *
 *   行在、目录是空的：这个平台没有模型。人清空了，或者上游还没拉到，都是这个
 *     意思。**不许退回代码目录** —— 那会让人删掉的模型自己回来。
 */
export function catalogModelsFromRow(
  provider: { platform: string },
  codeCatalog: () => CatalogModel[],
  known?: (id: string) => CatalogModel | undefined,
): CatalogModel[] {
  const row = openPlatformOf(provider.platform);
  if (!row) return codeCatalog();
  return row.models.items.map((id) => known?.(id) ?? minimalCatalogModel(id));
}

/* ------------------------------------------------------------------ *
 * The aggregate catalog
 * ------------------------------------------------------------------ */

/** One target of an aggregate model. */
