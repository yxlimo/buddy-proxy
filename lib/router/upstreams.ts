// lib/router/upstreams.ts — the four upstream adapters.
//
// Each upstream has its own protocol and its own idea of what a model is
// called, but the way an answer is written back to the client is the same for
// all of them (see deliver.ts). So an adapter only has to do its own part:
// turn the request into what the upstream wants, call it, and hand the answer
// over.

import crypto from "node:crypto";
import type express from "express";
import { AuthError } from "../credential.ts";
import { anthropicToOpenAI, effortFromBudget, openaiToAnthropic } from "../dialect/request.ts";
import {
  qoderProtocolForRegion,
  resolveModelRoute,
  type QoderModel,
} from "../qoder-models.ts";
import { qoderChatCompletion, LimitError } from "../qoder-transport.ts";
import { legacyChatCompletion, readLegacyFrames } from "../qoder-legacy.ts";
import { workbuddyChat, aggregateStream } from "../workbuddy-transport.ts";
import { MINIMAX_MODELS } from "../minimax-models.ts";
import type { QoderRegion } from "../qoder-auth.ts";
import {
  deliverAnthropicStream,
  deliverJson,
  deliverOpenAIChunks,
  deliverOpenAIStream,
  type Dialect,
} from "./deliver.ts";
import { upstreamModel, type Route } from "./routes.ts";

/** The output limit of a MiniMax model, as its own catalog says. */
function minimaxMaxOutput(model: string): number {
  return MINIMAX_MODELS.find((m) => m.id === model)?.output ?? 4096;
}

/** What the adapters need to know about the router they run in. */
export interface UpstreamContext {
  /** The MiniMax gateway, by address. */
  minimaxBase: string;
  /** The Qoder regions that are on. */
  qoderRegions: QoderRegion[];
  /** How often a queued legacy request is tried again. */
  legacyMaxAttempts: number;
  legacyRetryMs: number;
  /** How often a failed new-protocol request is tried again. */
  qoderMaxAttempts: number;
  /** Whether a request is written to the log. */
  logRoute: boolean;
}

/**
 * WorkBuddy's China region.
 *
 * The upstream speaks the OpenAI dialect natively, so the request goes out
 * almost unchanged; what the upstream checks is the identity around it, which
 * lib/workbuddy-auth.ts builds.
 *
 * The upstream always answers with a stream, even for a client that asked for
 * none, so a non-streaming request is folded back into one object here.
 */
export async function toWorkBuddy(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  if (ctx.logRoute) {
    console.log(`[ROUTE] workbuddy model=${route.model} stream=${stream}`);
  }

  const { response } = await workbuddyChat(openaiBody, { region: "cn", stream });

  if (!stream) {
    // The upstream always answers with a stream, so a non-streaming request is
    // folded back into one object here.
    let json: any;
    try {
      json = await aggregateStream(response, model);
    } catch (e) {
      throw new AuthError(
        `upstream stream failed (${(e as Error)?.message ?? "unknown"})`,
        "WorkBuddy 的响应流中断了。",
        502,
      );
    }
    deliverJson(res, dialect, "openai", json, model);
    return;
  }

  await deliverOpenAIStream(res, response.body!, dialect, model);
}

/**
 * The thinking level a request asks for.
 *
 * Several shapes reach the proxy, depending on the client and the dialect:
 *   `output_config.effort`  — the Anthropic spelling opencode and pi use
 *   `effort`                — explicit, and the only way to ask for `max`
 *   `reasoning_effort`      — the OpenAI spelling
 *   `thinking.budget_tokens` — the Anthropic spelling with a budget instead of a
 *                              level, where the level has to be recovered
 *
 * Qoder's own protocol has no per-request thinking switch: the tier *is* the
 * switch, so the level is translated into a tier here.
 */
export function extractEffort(body: Record<string, any>): string | undefined {
  const candidates = [body.output_config?.effort, body.effort, body.reasoning_effort];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }

  const budget = body.thinking?.budget_tokens ?? body.thinking_budget_tokens ?? body.thinking_budget;
  if (typeof budget === "number" && budget > 0) return effortFromBudget(budget);
  return undefined;
}

export async function toQoder(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  // Qoder speaks OpenAI natively, so the request is either already OpenAI or is
  // converted once.
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  openaiBody.stream = stream;

  // Read the effort from the original request: the dialect conversion drops the
  // Anthropic spelling (`output_config.effort`), and that is where opencode and
  // pi put it.
  const effort = extractEffort(body);
  const region = route.region ?? ctx.qoderRegions[0] ?? "global";
  const { model, key } = resolveModelRoute(upstreamModel(route), effort, region);
  if (ctx.logRoute) {
    console.log(`[ROUTE] model=${route.model} region=${region} effort=${effort ?? "-"} -> upstream key=${key}`);
  }
  if (model && qoderProtocolForRegion(model, region) === "legacy") {
    await toQoderLegacy(ctx, openaiBody, model, dialect, stream, res, region);
    return;
  }

  openaiBody.model = key;
  const upstream = await qoderWithRetry(
    () => qoderChatCompletion(openaiBody, { stream, region }),
    ctx.qoderMaxAttempts,
  );

  if (!stream) {
    const json = await upstream.json();
    deliverJson(res, dialect, "openai", json, upstreamModel(route));
    return;
  }

  await deliverOpenAIStream(res, upstream.body!, dialect, upstreamModel(route));
}

/**
 * The legacy (COSY) protocol, for the models the new one refuses.
 *
 * Its response is Qoder's own frame format, so the frames are unwrapped into
 * plain OpenAI chunks and then converted like any other upstream. The non-
 * streaming case has no upstream equivalent, so the chunks are collected and
 * reassembled into one completion.
 */
export async function toQoderLegacy(
  ctx: UpstreamContext,
  openaiBody: Record<string, any>,
  model: QoderModel,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
  region: QoderRegion,
): Promise<void> {
  const chunks = legacyWithRetry(
    () =>
      legacyChatCompletion(
        {
          messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
          tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
          modelKey: model.key,
          displayName: model.name,
          // The gateway does not enforce the cap, but the answer is cut at it.
          maxTokens: typeof openaiBody.max_tokens === "number" ? openaiBody.max_tokens : model.maxOutput,
          reasoning: model.reasoning,
          contextWindow: model.context,
        },
        { region },
      ),
    ctx.legacyMaxAttempts,
    ctx.legacyRetryMs,
  );

  if (!stream) {
    // The legacy protocol has no non-streaming answer, so the chunks are
    // collected and reassembled into one completion.
    const completion = await collectOpenAIChunks(chunks, model.id);
    deliverJson(res, dialect, "openai", completion, model.id);
    return;
  }

  await deliverOpenAIChunks(res, chunks, dialect, model.id);
}

export function legacyError(error: { code?: string; message?: string; status?: number }): AuthError {
  return new AuthError(
    `legacy upstream error (${error.code ?? "unknown"})`,
    `${error.message ?? "upstream failed"}${error.status ? ` (HTTP ${error.status})` : ""}`,
    error.status && error.status >= 500 ? 502 : 503,
  );
}

/**
 * The legacy endpoint answers 429 with `provider_error` / "All backends failed"
 * while the model is queued or the account is rate limited, and the CLI retries
 * such a request rather than failing it. The first frame tells us whether the
 * attempt was queued, so the retry happens before any bytes reach the client.
 */
async function* legacyWithRetry(
  send: () => Promise<Response>,
  maxAttempts: number,
  retryMs: number,
): AsyncGenerator<Record<string, any>> {
  for (let attempt = 1; ; attempt++) {
    const upstream = await send();
    const frames = readLegacyFrames(upstream.body!)[Symbol.asyncIterator]();
    const first = await frames.next();

    if (!first.done && first.value.error && attempt < maxAttempts && isRetryableLegacy(first.value.error)) {
      await new Promise((r) => setTimeout(r, retryMs));
      continue;
    }
    if (!first.done) {
      if (first.value.error) throw legacyError(first.value.error);
      if (first.value.chunk) yield first.value.chunk;
    }
    while (true) {
      const next = await frames.next();
      if (next.done) break;
      if (next.value.error) throw legacyError(next.value.error);
      if (next.value.chunk) yield next.value.chunk;
    }
    return;
  }
}

export function isRetryableLegacy(error: { code?: string; status?: number }): boolean {
  return error.status === 429 || error.code === "provider_error";
}

/**
 * The upstream answers 403/429 when the model is queued or every backend for it
 * is busy — the CLI retries these, so the proxy does too. The request has not
 * produced any bytes yet, so the retry is invisible to the client.
 */
export async function qoderWithRetry(
  send: () => Promise<Response>,
  maxAttempts: number,
  logRoute = false,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof LimitError && attempt < maxAttempts) {
        if (logRoute) console.log(`[ROUTE] upstream busy, retry ${attempt}/${maxAttempts - 1} in ${e.retryAfterSec}s`);
        await new Promise((r) => setTimeout(r, e.retryAfterSec * 1000));
        continue;
      }
      throw e;
    }
  }
}

/** Collect a chunk stream into a single chat completion. */
export async function collectOpenAIChunks(
  chunks: AsyncGenerator<Record<string, any>>,
  model: string,
): Promise<Record<string, any>> {
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: Record<string, any> | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const existing = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.function.name = call.function.name;
      if (typeof call.function?.arguments === "string") existing.function.arguments += call.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message: Record<string, any> = { role: "assistant", content: toolCalls.size ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].map(([index, call]) => ({ index, ...call }));

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

export async function toMinimax(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  // MiniMax speaks Anthropic natively.
  const anthropicBody = dialect === "anthropic" ? { ...body } : openaiToAnthropic(body);
  anthropicBody.model = upstreamModel(route);
  anthropicBody.stream = stream;
  // The Anthropic dialect requires a limit; when the client did not name one,
  // the model's own is used rather than a guess.
  if (typeof anthropicBody.max_tokens !== "number") {
    anthropicBody.max_tokens = minimaxMaxOutput(upstreamModel(route));
  }

  const r = await fetch(`${ctx.minimaxBase}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "anthropic-version": body.anthropic_version ?? "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new AuthError(`upstream HTTP ${r.status}`, `MiniMax 上游返回 ${r.status}：${text.slice(0, 300)}`, 502);
  }

  if (!stream) {
    const json = await r.json();
    deliverJson(res, dialect, "anthropic", json, upstreamModel(route));
    return;
  }

  await deliverAnthropicStream(res, r.body!, dialect, upstreamModel(route));
}

