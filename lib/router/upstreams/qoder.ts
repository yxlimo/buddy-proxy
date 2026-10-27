// lib/router/upstreams/qoder.ts — Qoder, both protocols.
//
// The new protocol answers with an OpenAI stream; the legacy (COSY) one
// answers in Qoder's own frame format, which is unwrapped into plain
// chunks here.

import type { Json } from "../../json.ts";
import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { anthropicToOpenAI, effortOf } from "../../dialect/request.ts";
import {
  qoderProtocolForRegion,
  resolveModelRoute,
  QODER_CLIENT_MAX_TOKENS,
  type QoderModel,
} from "../../qoder/models.ts";
import { qoderChatCompletion, LimitError } from "../../qoder/transport.ts";
import type { QoderRegion } from "../../qoder/auth.ts";
import { legacyChatCompletion, readLegacyFrames } from "../../qoder/legacy.ts";
import { deliverJson, deliverOpenAIChunks, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { platformOf } from "../../platforms.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { type UpstreamContext, underPolicy } from "./policy.ts";

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
export function extractEffort(body: Json): string | undefined {
  return effortOf(body);
}

export async function toQoder(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  // Qoder speaks OpenAI natively, so the request is either already OpenAI or is
  // converted once.
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  openaiBody.stream = stream;

  // Read the effort from the original request: the dialect conversion drops the
  // Anthropic spelling (`output_config.effort`), and that is where opencode and
  // pi put it.
  const effort = extractEffort(body);
  // The region is the platform's, not an account's: the global and the China
  // Qoder are two platforms, each with its own endpoints.
  const region: QoderRegion = platformOf(route.platform)?.region === "cn" ? "cn" : "global";
  const { model, key } = resolveModelRoute(upstreamModel(route), effort, region);
  if (ctx.logRoute) {
    console.log(`[ROUTE] model=${route.model} region=${region} effort=${effort ?? "-"} -> upstream key=${key}`);
  }
  if (model && qoderProtocolForRegion(model, region) === "legacy") {
    await toQoderLegacy(ctx, openaiBody, model, dialect, stream, out, region, route.label, route.platform);
    return;
  }

  openaiBody.model = key;
  // The official client sends the limit from its own catalog, whatever the
  // caller asked for; the gateway ignores it and cuts the answer at the
  // model's real limit.
  openaiBody.max_tokens = QODER_CLIENT_MAX_TOKENS;
  const upstream = await underPolicy(route.platform, "qoder", (account) =>
    qoderWithRetry(
      () => qoderChatCompletion(openaiBody, { stream, providerId: account.id, region }),
      ctx.qoderMaxAttempts,
    ),
  );

  if (!stream) {
    const json = await upstream.json();
    deliverJson(out, dialect, "openai", json, route.label ?? upstreamModel(route), ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, upstream.body!, dialect, route.label ?? upstreamModel(route), undefined, ctx.onUsage);
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
  openaiBody: Record<string, unknown>,
  model: QoderModel,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
  region: QoderRegion,
  label?: string,
  platform = "qoder",
): Promise<void> {
  const chunks = await underPolicy(platform, "qoder", async (account) =>
    legacyWithRetry(
      () =>
        legacyChatCompletion(
          {
            messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
            tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
            modelKey: model.key,
            displayName: model.name,
            // The same number the simulated client sends.
            maxTokens: QODER_CLIENT_MAX_TOKENS,
            reasoning: model.reasoning,
            contextWindow: model.context,
          },
          { providerId: account.id, region },
        ),
      ctx.legacyMaxAttempts,
      ctx.legacyRetryMs,
    ),
  );

  if (!stream) {
    // The legacy protocol has no non-streaming answer, so the chunks are
    // collected and reassembled into one completion.
    const completion = await collectOpenAIChunks(chunks, model.id);
    deliverJson(out, dialect, "openai", completion, label ?? model.id, ctx.onUsage);
    return;
  }

  await deliverOpenAIChunks(out, chunks, dialect, label ?? model.id, ctx.onUsage);
}

export function legacyError(error: { code?: string; message?: string; status?: number }): AuthError {
  // A 403 with a pricing link is the platform saying the account has no
  // credits left. Saying so is more use than the code it answers with.
  if (error.status === 403 && /pricing/i.test(error.message ?? "")) {
    return new AuthError(
      "the qoder account has no credits left",
      "Qoder 的额度用完了（套餐和加购都没了）。充值，或等额度重置后再试。",
      402,
      "usage_limit_error",
    );
  }
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
): AsyncGenerator<Json> {
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
  chunks: AsyncGenerator<Json>,
  model: string,
): Promise<Json> {
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: Json | undefined;

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

  const message: Json = { role: "assistant", content: toolCalls.size ? null : content };
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
