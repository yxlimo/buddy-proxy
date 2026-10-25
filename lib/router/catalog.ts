// lib/router/catalog.ts — the model lists.
//
// The clients ask for the list in two shapes: the Anthropic one, which carries
// the extra metadata pi reads, and the OpenAI one, which is just a list of
// names. Both are rendered from the same models, so a model never shows up in
// one shape and not in the other.
//
// The list is per upstream: the plain `/v1/models` answers with everything and
// the prefixed form (`/qoder-cn/v1/models`) with one upstream, and the model
// ids are the real ones there — the path already says where the model lives.

import type { AggregateModel } from "../aggregate.ts";
import type { CatalogModel } from "../catalog-models.ts";

export type { CatalogModel };
export {
  internAiCatalogModels,
  minimaxCatalogModels,
  miniMaxApiCatalogModels,
  qoderCatalogModels,
  senseNovaCatalogModels,
  tokenRhythmCatalogModels,
  workbuddyCatalogModels,
  zcodeCatalogModels,
} from "../catalog-models.ts";

/**
 * A group is a provider: one row of the provider table.
 *
 * The prefix the server puts in front of a model id is the provider's id, so
 * two accounts of the same kind do not collide.
 */
export type UpstreamGroup = string;

/** One upstream's models. */
export interface CatalogGroup {
  group: UpstreamGroup;
  models: CatalogModel[];
}

export function groupCatalog(group: UpstreamGroup, groups: CatalogGroup[], openai: boolean): any {
  const found = groups.find((g) => g.group === group);
  const models = found?.models ?? [];
  if (openai) {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created, owned_by: group, name: m.displayName })),
    };
  }
  const created = Math.floor(Date.now() / 1000);
  const data = models.map((m) => ({
    id: m.id,
    type: "model",
    display_name: m.displayName,
    created_at: created,
    reasoning: m.reasoning,
    tool_call: m.toolCall,
    ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
    ...(m.maxOutputTokens ? { max_output_tokens: m.maxOutputTokens } : {}),
    ...(m.effortOptions ? { effort_options: [...m.effortOptions] } : {}),
    ...(m.backend ? { backend: m.backend } : {}),
  }));
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

export interface AggregateTargetSpec {
  group: UpstreamGroup;
  upstreamModel: string;
  enabled: boolean;
}

/** One model the root route publishes. */
export interface AggregateEntry {
  /** The id the agents use. */
  id: string;
  displayName: string;
  reasoning: boolean;
  toolCall: boolean;
  contextWindow?: number;
  /** 平台没报输出上限的时候没有这个数。 */
  maxOutputTokens?: number;
  effortOptions?: string[];
  strategy: "single" | "fallback";
  targets: AggregateTargetSpec[];
}
/** The model behind a target, as the upstream currently lists it. */
/**
 * 目录里找那个模型。
 *
 * 名字不认大小写：MiniMax 的模型 id 是 "MiniMax-M3.1-Flash"，人写的是
 * "Minmax-M3.1-Flash"，两个是同一个东西。认不出就当没有 —— 那样模型不会
 * 被公布，客户端连不上，而没人知道为什么。
 */
function findModel(groups: CatalogGroup[], group: UpstreamGroup, id: string): CatalogModel | null {
  const entry = groups.find((g) => g.group === group);
  if (!entry) return null;
  const wanted = id.trim().toLowerCase();
  return (
    entry.models.find((m) => m.id === id) ??
    entry.models.find((m) => m.id.toLowerCase() === wanted) ??
    null
  );
}

/**
 * The models the root route publishes.
 *
 * The database is the catalog: the panel decides which models exist, what they
 * are called, and which upstream serves them. With nothing in the database
 * there is nothing to publish.
 *
 * The metadata of a published model comes from its targets, and where the
 * targets disagree the smallest value wins — the model can only promise what
 * every one of them can do.
 */
export function aggregateCatalog(groups: CatalogGroup[], configured: AggregateModel[]): AggregateEntry[] {
  const live = configured.filter((m) => m.enabled);
  const entries: AggregateEntry[] = [];
  for (const model of live) {
    const targets: AggregateTargetSpec[] = [];
    const found: CatalogModel[] = [];
    for (const target of model.targets) {
      if (!target.enabled) continue;
      const upstream = findModel(groups, target.group, target.upstreamModel);
      if (!upstream) continue; // The upstream no longer lists it.
      targets.push({
        group: target.group,
        upstreamModel: target.upstreamModel,
        enabled: true,
      });
      found.push(upstream);
    }
    if (targets.length === 0) continue;

    const contexts = found.map((m) => m.contextWindow).filter((v): v is number => typeof v === "number");
    const outputs = found.map((m) => m.maxOutputTokens).filter((v): v is number => typeof v === "number");
    const efforts = found
      .map((m) => m.effortOptions)
      .filter((v): v is string[] => Array.isArray(v));
    const commonEfforts = efforts.length
      ? efforts.reduce((a, b) => a.filter((v) => b.includes(v)))
      : undefined;

    entries.push({
      id: model.id,
      displayName: model.displayName,
      reasoning: model.reasoning ?? found.some((m) => m.reasoning),
      toolCall: model.toolCall ?? found.every((m) => m.toolCall),
      contextWindow: model.contextWindow ?? (contexts.length ? Math.min(...contexts) : undefined),
      maxOutputTokens: model.maxOutputTokens ?? (outputs.length ? Math.min(...outputs) : undefined),
      effortOptions: model.effortOptions ?? (commonEfforts?.length ? commonEfforts : undefined),
      strategy: model.strategy,
      targets,
    });
  }
  return entries;
}

/** The Anthropic shape, with the extra metadata pi reads. */
export function anthropicCatalog(groups: CatalogGroup[]): any {
  const created = Math.floor(Date.now() / 1000);
  const data: any[] = [];
  for (const { group, models } of groups) {
    for (const m of models) {
      data.push({
        id: `${group}/${m.id}`,
        type: "model",
        display_name: m.displayName,
        created_at: created,
        reasoning: m.reasoning,
        tool_call: m.toolCall,
        ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
        ...(m.maxOutputTokens ? { max_output_tokens: m.maxOutputTokens } : {}),
        ...(m.effortOptions ? { effort_options: [...m.effortOptions] } : {}),
        ...(m.backend ? { backend: m.backend } : {}),
      });
    }
  }
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
    default_model: "qoder/auto",
  };
}

/** The OpenAI shape. */
export function openaiCatalog(groups: CatalogGroup[]): any {
  const created = Math.floor(Date.now() / 1000);
  const data: any[] = [];
  for (const { group, models } of groups) {
    for (const m of models) {
      data.push({
        id: `${group}/${m.id}`,
        object: "model",
        created,
        owned_by: group,
        name: m.displayName,
      });
    }
  }
  return { object: "list", data };
}

/**
 * The aggregate catalog in the OpenAI shape.
 *
 * The root route publishes one list, whether the models come from the
 * database or from the upstreams themselves.
 */
export function aggregateOpenAICatalog(entries: AggregateEntry[]): any {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: entries.map((e) => ({
      id: e.id,
      object: "model",
      created,
      owned_by: e.targets[0]?.group ?? "buddy",
      name: e.displayName,
    })),
  };
}

/**
 * The aggregate catalog in the Anthropic shape, with the metadata pi reads.
 */
export function aggregateAnthropicCatalog(entries: AggregateEntry[]): any {
  const created = Math.floor(Date.now() / 1000);
  const data = entries.map((e) => ({
    id: e.id,
    type: "model",
    display_name: e.displayName,
    created_at: created,
    reasoning: e.reasoning,
    tool_call: e.toolCall,
    ...(e.contextWindow ? { context_window: e.contextWindow } : {}),
    ...(e.maxOutputTokens ? { max_output_tokens: e.maxOutputTokens } : {}),
    ...(e.effortOptions ? { effort_options: [...e.effortOptions] } : {}),
  }));
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

/**
 * One upstream's list.
 *
 * The model ids are the real ones: the path already says which upstream it is
 * for, so the name does not have to say it again.
 */
