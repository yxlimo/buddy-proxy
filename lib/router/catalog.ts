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

import { QODER_EFFORTS, qoderLabel, type QoderModel } from "../qoder/models.ts";
import { workbuddyLabel, type WorkBuddyModel } from "../workbuddy/models.ts";
import type { MiniMaxModel } from "../minimax/models.ts";
import { TOKENRHYTHM_MODELS } from "../tokenrhythm/models.ts";
import type { AggregateModel } from "../aggregate.ts";

export type UpstreamGroup = "qoder" | "qoder-cn" | "workbuddy-cn" | "minimax" | "tokenrhythm";

export const UPSTREAM_GROUPS: UpstreamGroup[] = ["qoder", "qoder-cn", "workbuddy-cn", "minimax", "tokenrhythm"];

/** The prefix the server puts in front of a model id. */
export const GROUP_PREFIX: Record<UpstreamGroup, string> = {
  qoder: "qoder/",
  "qoder-cn": "qoder-cn/",
  "workbuddy-cn": "workbuddy-cn/",
  minimax: "minimax/",
  tokenrhythm: "tokenrhythm/",
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
  maxOutputTokens: number;
  /** The thinking levels the model accepts, if it has a choice. */
  effortOptions?: string[];
  /** The model the gateway actually ran, when it is not the one that was asked for. */
  backend?: string;
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

/* ------------------------------------------------------------------ *
 * The aggregate catalog
 * ------------------------------------------------------------------ */

/** One target of an aggregate model. */
export interface AggregateTargetSpec {
  group: UpstreamGroup;
  upstreamModel: string;
  position: number;
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
  maxOutputTokens: number;
  effortOptions?: string[];
  strategy: "single" | "fallback";
  targets: AggregateTargetSpec[];
}

/** The model behind a target, as the upstream currently lists it. */
function findModel(groups: CatalogGroup[], group: UpstreamGroup, id: string): CatalogModel | null {
  const entry = groups.find((g) => g.group === group);
  if (!entry) return null;
  return entry.models.find((m) => m.id === id) ?? null;
}

/**
 * The models the root route publishes.
 *
 * With nothing configured, every upstream's models are published under their
 * prefixed name — the same list the root route always showed. Once the
 * database holds a model, the database is the catalog: the panel decides which
 * models exist, what they are called, and which upstream serves them.
 *
 * The metadata of a configured model comes from its targets, and where the
 * targets disagree the smallest value wins — the model can only promise what
 * every one of them can do.
 */
export function aggregateCatalog(groups: CatalogGroup[], configured: AggregateModel[]): AggregateEntry[] {
  const live = configured.filter((m) => m.enabled);
  if (live.length === 0) {
    const entries: AggregateEntry[] = [];
    for (const { group, models } of groups) {
      for (const m of models) {
        entries.push({
          id: `${GROUP_PREFIX[group]}${m.id}`,
          displayName: m.displayName,
          reasoning: m.reasoning,
          toolCall: m.toolCall,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          effortOptions: m.effortOptions,
          strategy: "single",
          targets: [{ group, upstreamModel: m.id, position: 0, enabled: true }],
        });
      }
    }
    return entries;
  }

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
        position: target.position,
        enabled: true,
      });
      found.push(upstream);
    }
    if (targets.length === 0) continue;

    const contexts = found.map((m) => m.contextWindow).filter((v): v is number => typeof v === "number");
    const outputs = found.map((m) => m.maxOutputTokens);
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
      maxOutputTokens: model.maxOutputTokens ?? (outputs.length ? Math.min(...outputs) : 0),
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
        max_output_tokens: m.maxOutputTokens,
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
    max_output_tokens: e.maxOutputTokens,
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
    max_output_tokens: m.maxOutputTokens,
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
