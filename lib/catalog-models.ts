// lib/catalog-models.ts — the model list, one shape whatever the client wants.
//
// The models of every upstream, rendered into the shape the list uses. It
// lives on its own so the provider registry (lib/kinds.ts) and the router can
// both use it without importing each other.

import { QODER_EFFORTS, qoderCredits, qoderLabel, type QoderModel } from "./qoder/models.ts";
import { workbuddyLabel, type WorkBuddyModel } from "./workbuddy/models.ts";
import type { MiniMaxModel } from "./minimax/models.ts";
import type { MiniMaxApiModel } from "./minimax/api.ts";
import type { ZcodeModel } from "./zcode/models.ts";
import { TOKENRHYTHM_MODELS } from "./tokenrhythm/models.ts";
import type { SenseNovaModel } from "./sensenova/models.ts";
import type { InternAiCatalogModel } from "./intern-ai/models.ts";

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
