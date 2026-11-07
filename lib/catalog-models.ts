// lib/catalog-models.ts — the model list, one shape whatever the client wants.
//
// The models of every upstream, rendered into the shape the list uses. It
// lives on its own so the provider registry (lib/kinds.ts) and the router can
// both use it without importing each other.

import { QODER_EFFORTS, qoderCredits, qoderLabel, type QoderModel } from "./qoder/models.ts";
import { workbuddyLabel, type WorkBuddyModel } from "./workbuddy/models.ts";
import type { MiniMaxModel } from "./minimax/models.ts";
import type { ZcodeModel } from "./zcode/models.ts";
import type { SenseNovaModel } from "./sensenova/models.ts";
import type { InternAiCatalogModel } from "./intern-ai/models.ts";
// 目录是平台那一行的（见 catalogModelsFromRow）：这里只读行，不写行。
import { openPlatformOf, type ModelTraits } from "./open-platforms.ts";
// 共性表：平台自己报不出参数时那一层「人工整理过的答案」。叶子模块，不引别处。
import { commonTraitsOf } from "./common-model-traits.ts";

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
  /**
   * The thinking levels the model accepts, if it has a choice.
   *
   * An empty list is not the same as a missing one: it says the model has no
   * choice at all, which is an answer, not a gap.
   */
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
    // A null multiplier means the client config states none, which is not the
    // same as free: the list says nothing about the price.
    ...(m.credits === null ? {} : { credits: m.credits }),
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
 * 行里报的参数盖在不知道的那一份上。
 *
 * 行里有的字段用行里的（那是上游/人明确说的），没有的字段继续用传进来的那一份
 * （代码表或上游缓存的元数据）。`defaultEffort` 还没有消费者（CatalogModel 没有
 * 这一格），只存在行里。
 */
function withTraits(model: CatalogModel, traits: ModelTraits | undefined): CatalogModel {
  if (!traits) return model;
  const out: CatalogModel = { ...model };
  if (traits.contextWindow !== undefined) out.contextWindow = traits.contextWindow;
  if (traits.maxOutputTokens !== undefined) out.maxOutputTokens = traits.maxOutputTokens;
  if (traits.reasoning !== undefined) out.reasoning = traits.reasoning;
  if (traits.toolCall !== undefined) out.toolCall = traits.toolCall;
  if (traits.credits !== undefined) out.credits = traits.credits;
  // 空档位照收：上游明确说「不能选档」，丢掉它下一层（代码表）的档位就会回来 ——
  // 客户端又被告诉这个模型有档可选。
  if (traits.efforts !== undefined) out.effortOptions = [...traits.efforts];
  return out;
}

/**
 * 只补还没有的字段：前几层说过的那几格一个字也不动。
 *
 * 判据是「这个键在不在」，不是「是不是真值」：`reasoning: false`、`toolCall:
 * false`、`efforts: []` 都是明确的结论，与缺键（谁也不说话）不是同一件事。
 */
function withUnknownTraits(model: CatalogModel, traits: ModelTraits | undefined): CatalogModel {
  if (!traits) return model;
  const out: CatalogModel = { ...model };
  if (out.contextWindow === undefined && traits.contextWindow !== undefined) {
    out.contextWindow = traits.contextWindow;
  }
  if (out.maxOutputTokens === undefined && traits.maxOutputTokens !== undefined) {
    out.maxOutputTokens = traits.maxOutputTokens;
  }
  if (out.reasoning === undefined && traits.reasoning !== undefined) out.reasoning = traits.reasoning;
  if (out.toolCall === undefined && traits.toolCall !== undefined) out.toolCall = traits.toolCall;
  if (out.credits === undefined && traits.credits !== undefined) out.credits = traits.credits;
  if (out.effortOptions === undefined && traits.efforts !== undefined) {
    out.effortOptions = [...traits.efforts];
  }
  return out;
}

/**
 * 平台的目录：平台那一行说了算。
 *
 * 行里的 id 与**顺序**就是公布的 id 与顺序（顺序决定面板与路由里的模型次序）。
 * 元数据按字段一层一层盖上，前一层说过的算数：
 *
 *   人工元数据（最外层 applyModelOverrides 已经做过，这一层看不见）
 *   → 行里的参数（`row.models.traits`，问上游时要回来的那一份）
 *   → 代码表 `known`
 *   → 共性表（仅当行里的 traitsFromCommon 开着且命中，只补仍然没有的字段）
 *   → 最小形状
 *
 * 按**字段**取，不是整条替换：上游报了窗口而没报档位时，档位仍然是代码表的唯一
 * 事实。共性表是人工整理的近似，排在最后：它只补前几层都没说的字段，不盖明确的
 * 结论（上游说 `reasoning: false` 就是不能思考，近似说 true 也是它错）。
 *
 * 它不造模型：命中与否都不影响 items 里有哪些模型（那是行的事）。
 *
 * 两种「空」不是一个意思，别混：
 *
 *   行读不到（null）：平台行没了，理论上不该发生。方言族的目录只有行里那一份，
 *     行没了就是空 —— 不拿代码里的目录去顶：那会让删掉的平台自己回来。
 *
 *   行在、目录是空的：这个平台没有模型。上游还没拉到，就是这个意思。
 */
export function catalogModelsFromRow(
  provider: { platform: string },
  codeCatalog: () => CatalogModel[],
  known?: (id: string) => CatalogModel | undefined,
): CatalogModel[] {
  const row = openPlatformOf(provider.platform);
  if (!row) return codeCatalog();
  return row.models.items.map((id) => {
    const merged = withTraits(known?.(id) ?? minimalCatalogModel(id), row.models.traits[id]);
    // 共性表排在最后，只补前几层都没说的字段。开关关着就完全不看它（同样的 id
    // 在开关前后必须一模一样）。
    if (!row.traitsFromCommon) return merged;
    return withUnknownTraits(merged, commonTraitsOf(id) ?? undefined);
  });
}

/* ------------------------------------------------------------------ *
 * The aggregate catalog
 * ------------------------------------------------------------------ */

/** One target of an aggregate model. */
