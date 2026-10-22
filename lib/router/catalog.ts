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
