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

import { QODER_EFFORTS, qoderCredits, qoderLabel, type QoderModel } from "../qoder/models.ts";
import { workbuddyLabel, type WorkBuddyModel } from "../workbuddy/models.ts";
import type { MiniMaxModel } from "../minimax/models.ts";
import type { MiniMaxApiModel } from "../minimax/api.ts";
import type { ZcodeModel } from "../zcode/models.ts";
import { TOKENRHYTHM_MODELS } from "../tokenrhythm/models.ts";
import type { SenseNovaModel } from "../sensenova/models.ts";
import type { InternAiCatalogModel } from "../intern-ai/models.ts";
import type { AggregateModel } from "../aggregate.ts";

export type UpstreamGroup =
  | "qoder"
  | "qoder-cn"
  | "workbuddy-cn"
  | "minimax"
  | "minimax-api"
  | "zcode"
  | "tokenrhythm"
  | "sensenova"
  | "intern-ai";

export const UPSTREAM_GROUPS: UpstreamGroup[] = [
  "qoder",
  "qoder-cn",
  "workbuddy-cn",
  "minimax",
  "minimax-api",
  "zcode",
  "tokenrhythm",
  "sensenova",
  "intern-ai",
];

/** The prefix the server puts in front of a model id. */
export const GROUP_PREFIX: Record<UpstreamGroup, string> = {
  qoder: "qoder/",
  "qoder-cn": "qoder-cn/",
  "workbuddy-cn": "workbuddy-cn/",
  minimax: "minimax/",
  "minimax-api": "minimax-api/",
  zcode: "zcode/",
  tokenrhythm: "tokenrhythm/",
  sensenova: "sensenova/",
  "intern-ai": "intern-ai/",
};

/** A model, the same whatever the shape the client wants it in. */
export interface CatalogModel {
  /** The model id as the upstream knows it. */
  id: string;
  /** The name the list shows. */
  displayName: string;
  /** Whether the model can think. */
  reasoning: boolean;
  /** Whether the model can call tools. */
  toolCall: boolean;
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

/** One upstream's models. */
export interface CatalogGroup {
  group: UpstreamGroup;
  models: CatalogModel[];
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

/** MiniMax 开放平台的模型。 */
export function miniMaxApiCatalogModels(models: MiniMaxApiModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    contextWindow: m.context,
    maxOutputTokens: m.output,
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
 * The aggregate catalog
 * ------------------------------------------------------------------ */

/** One target of an aggregate model. */
export interface AggregateTargetSpec {
  group: UpstreamGroup;
  upstreamModel: string;
  enabled: boolean;
}

/** One model the root route publishes. */
export interface AggregateEntry {
  /** The id the clients use. */
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
        id: `${GROUP_PREFIX[group]}${m.id}`,
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
        id: `${GROUP_PREFIX[group]}${m.id}`,
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
