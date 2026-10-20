// lib/dialect.ts — translating between the OpenAI and Anthropic dialects.
//
// The router has to do this in both directions:
//   OpenAI request  → Anthropic request  (when the model is a MiniMax one)
//   Anthropic request → OpenAI request  (when the model is a Qoder one)
//
// and the same for the responses, including the streaming case. A non-streaming
// conversion is mechanical; the streaming one is a small state machine per
// direction, because the two dialects disagree about what a "block" is.
//
// Anthropic streams typed events (message_start, content_block_delta, …) and
// carries tool calls as content blocks with an id. OpenAI streams anonymous
// chunks and carries tool calls as indexed deltas whose arguments arrive in
// fragments. The fragments are the awkward part: OpenAI's argument fragments are
// cut at token boundaries, so they cannot be forwarded to Anthropic as they
// arrive — Anthropic expects valid JSON. They are buffered and emitted once the
// call is complete.

import { randomUUID } from "node:crypto";
import { AuthError } from "./credential.ts";
import { readOpenAIChunks, readSseEvents, sseData, sseEvent, SSE_DONE } from "./sse-stream.ts";

type Json = Record<string, any>;

/* ------------------------------------------------------------------ *
 * Request conversion
 * ------------------------------------------------------------------ */

interface TextPart {
  type: "text";
  text: string;
}

/** Anthropic system prompt (string or block list) → OpenAI system message. */
function anthropicSystemToOpenAI(system: unknown): Json | null {
  if (typeof system === "string" && system.trim()) return { role: "system", content: system };
  if (Array.isArray(system)) {
    const text = system
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
    if (text.trim()) return { role: "system", content: text };
  }
  return null;
}

/** Anthropic content block → OpenAI content part. */
function anthropicBlockToOpenAIPart(block: Json): Json | null {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image" && block.source) {
    const src = block.source;
    if (src.type === "base64" && src.data) {
      return { type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } };
    }
    if (src.type === "url" && src.url) {
      return { type: "image_url", image_url: { url: src.url } };
    }
  }
  return null;
}

/** Anthropic → OpenAI chat/completions request. */
export function anthropicToOpenAI(body: Json): Json {
  const out: Json = {};
  if (body.model) out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  const messages: Json[] = [];
  const system = anthropicSystemToOpenAI(body.system);
  if (system) messages.push(system);

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role === "assistant" ? "assistant" : "user";
    const content = msg?.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: Json[] = [];
    const toolCalls: Json[] = [];
    const toolResults: Json[] = [];

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? `call_${randomUUID().slice(0, 12)}`,
          type: "function",
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
        });
      } else {
        const part = anthropicBlockToOpenAIPart(block);
        if (part) parts.push(part);
      }
    }

    if (toolResults.length) {
      // Tool results are their own OpenAI messages, and they must come before the
      // assistant turn they answer.
      messages.push(...toolResults);
    }
    if (toolCalls.length) {
      messages.push({ role: "assistant", content: parts.length ? parts : null, tool_calls: toolCalls });
    } else if (parts.length) {
      messages.push({ role, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
  }
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: Json) => ({
      type: "function",
      function: {
        name: t?.name ?? "",
        description: t?.description ?? "",
        parameters: t?.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "none") out.tool_choice = "none";
  }
  if (body.thinking?.type === "enabled") {
    out.reasoning_effort = effortFromBudget(body.thinking.budget_tokens);
  }
  if (typeof body.stream === "boolean") out.stream = body.stream;
  return out;
}

/** Anthropic thinking budget → OpenAI reasoning effort. */
export function effortFromBudget(budget: unknown): string {
  const n = typeof budget === "number" ? budget : 0;
  if (n <= 1024) return "low";
  if (n <= 8192) return "medium";
  return "high";
}

/** OpenAI reasoning effort → Anthropic thinking budget. */
export function budgetFromEffort(effort: unknown): number {
  switch (effort) {
    case "minimal":
    case "low":
      return 2048;
    case "high":
      return 16384;
    case "medium":
      return 8192;
    default:
      return 8192;
  }
}

/** OpenAI → Anthropic messages request. */
export function openaiToAnthropic(body: Json): Json {
  const out: Json = {};
  if (body.model) out.model = body.model;
  out.max_tokens =
    typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : 4096;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.stop === "string") out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;

  const systemParts: string[] = [];
  const messages: Json[] = [];

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;

    if (role === "system" || role === "developer") {
      const text = openAIContentToText(msg?.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      // A tool result is a user turn in Anthropic, carrying a tool_result block.
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg?.tool_call_id ?? "",
            content: openAIContentToText(msg?.content),
          },
        ],
      });
      continue;
    }

    const blocks: Json[] = [];
    const contentText = openAIContentToText(msg?.content);
    if (contentText) blocks.push({ type: "text", text: contentText });
    for (const part of Array.isArray(msg?.content) ? msg.content : []) {
      if (part?.type === "image_url" && part.image_url?.url) {
        const url = String(part.image_url.url);
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        blocks.push(
          m
            ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
            : { type: "image", source: { type: "url", url } },
        );
      }
    }
    for (const call of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      let input: unknown = {};
      try {
        input = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        input = {};
      }
      blocks.push({
        type: "tool_use",
        id: call?.id ?? `toolu_${randomUUID().slice(0, 12)}`,
        name: call?.function?.name ?? "",
        input,
      });
    }

    if (blocks.length) {
      messages.push({ role: role === "assistant" ? "assistant" : "user", content: blocks });
    }
  }

  if (systemParts.length) out.system = systemParts.join("\n\n");
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: Json) => ({
      name: t?.function?.name ?? t?.name ?? "",
      description: t?.function?.description ?? t?.description ?? "",
      input_schema: t?.function?.parameters ?? t?.input_schema ?? { type: "object", properties: {} },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "none") out.tool_choice = { type: "none" };
    else if (tc?.type === "function" && tc.function?.name) {
      out.tool_choice = { type: "tool", name: tc.function.name };
    }
  }
  if (body.reasoning_effort) {
    out.thinking = { type: "enabled", budget_tokens: budgetFromEffort(body.reasoning_effort) };
  }
  if (typeof body.stream === "boolean") out.stream = body.stream;
  return out;
}

/** Flatten OpenAI content (string or parts) into text. */
function openAIContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * Streaming response conversion
 * ------------------------------------------------------------------ */

/**
 * OpenAI chunks → Anthropic SSE events.
 *
 * Takes parsed chunks rather than a byte stream, because two different upstreams
 * produce them: the new protocol streams plain OpenAI SSE, the legacy protocol
 * wraps each chunk in its own frame format.
 */
export async function* openaiStreamToAnthropic(
  chunks: AsyncIterable<Json>,
  model: string,
): AsyncGenerator<string> {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let started = false;
  // Anthropic block indexes have to be contiguous, so thinking and text each take
  // one and the order they appear in decides the numbering.
  let nextIndex = 0;
  let textIndex = -1;
  let thinkingIndex = -1;
  let textOpen = false;
  let thinkingOpen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  async function* start(usage?: Json): AsyncGenerator<string> {
    if (started) return;
    started = true;
    yield sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 },
      },
    });
  }

  for await (const chunk of chunks) {
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length) {
      if (!started) yield* start();
      if (!textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        yield sseEvent("content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      yield sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // Reasoning arrives on a separate channel in the OpenAI dialect.
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof reasoning === "string" && reasoning.length) {
      if (!started) yield* start();
      if (!thinkingOpen) {
        thinkingIndex = nextIndex++;
        thinkingOpen = true;
        yield sseEvent("content_block_start", {
          type: "content_block_start",
          index: thinkingIndex,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      yield sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: thinkingIndex,
        delta: { type: "thinking_delta", thinking: reasoning },
      });
    }

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const existing = toolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name = call.function.name;
      if (typeof call.function?.arguments === "string") existing.args += call.function.arguments;
      toolCalls.set(index, existing);
    }

    if (choice.finish_reason) {
      if (!started) yield* start();
      if (textOpen) {
        yield sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex });
        textOpen = false;
      }
      if (thinkingOpen) {
        yield sseEvent("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
        thinkingOpen = false;
      }
      // OpenAI splits the tool arguments at token boundaries, so they are only
      // valid JSON once the call is complete.
      let index = nextIndex++;
      for (const call of toolCalls.values()) {
        yield sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: call.id || `toolu_${randomUUID().slice(0, 12)}`, name: call.name, input: {} },
        });
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: call.args || "{}" },
        });
        yield sseEvent("content_block_stop", { type: "content_block_stop", index });
        index++;
      }
      const stopReason = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
      yield sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      yield sseEvent("message_stop", { type: "message_stop" });
      return;
    }
  }

  if (!started) yield* start();
  if (textOpen) yield sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex });
  if (thinkingOpen) yield sseEvent("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
  yield sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  yield sseEvent("message_stop", { type: "message_stop" });
}

/** Anthropic stream → OpenAI SSE chunks. */
export async function* anthropicStreamToOpenAI(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let finished = false;
  const toolIndex = new Map<number, number>();
  let nextToolIndex = 0;

  const chunk = (delta: Json, finishReason: string | null = null) =>
    sseData({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  for await (const ev of readSseEvents(body)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let evt: Json;
    try {
      evt = JSON.parse(ev.data);
    } catch {
      continue;
    }

    if (evt.type === "error") {
      const detail = evt.error ?? evt;
      throw new AuthError(
        `upstream stream error (${detail?.type ?? "unknown"})`,
        typeof detail?.message === "string" ? detail.message : JSON.stringify(detail).slice(0, 300),
        502,
      );
    }
    if (evt.type === "message_start") {
      if (!roleSent) {
        roleSent = true;
        yield chunk({ role: "assistant", content: "" });
      }
      continue;
    }
    if (evt.type === "content_block_start") {
      const block = evt.content_block ?? {};
      if (block.type === "tool_use") {
        const idx = nextToolIndex++;
        toolIndex.set(evt.index ?? 0, idx);
        yield chunk({
          tool_calls: [
            {
              index: idx,
              id: block.id ?? `call_${randomUUID().slice(0, 12)}`,
              type: "function",
              function: { name: block.name ?? "", arguments: "" },
            },
          ],
        });
      } else if (block.type === "thinking") {
        // OpenAI has no first-class thinking channel; reasoning_content is what the
        // ecosystem reads.
      }
      continue;
    }
    if (evt.type === "content_block_delta") {
      const delta = evt.delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (!roleSent) {
          roleSent = true;
          yield chunk({ role: "assistant", content: "" });
        }
        yield chunk({ content: delta.text });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        if (!roleSent) {
          roleSent = true;
          yield chunk({ role: "assistant", content: "" });
        }
        yield chunk({ reasoning_content: delta.thinking });
      } else if (delta.type === "input_json_delta") {
        const idx = toolIndex.get(evt.index ?? 0) ?? 0;
        yield chunk({
          tool_calls: [{ index: idx, function: { arguments: delta.partial_json ?? "" } }],
        });
      }
      continue;
    }
    if (evt.type === "message_delta") {
      const reason = evt.delta?.stop_reason;
      const mapped = reason === "max_tokens" ? "length" : reason === "tool_use" ? "tool_calls" : reason ? "stop" : null;
      if (mapped) {
        finished = true;
        yield chunk({}, mapped);
      }
      continue;
    }
    if (evt.type === "message_stop") {
      if (!finished) yield chunk({}, "stop");
      yield SSE_DONE;
      return;
    }
  }
  if (!finished) yield chunk({}, "stop");
  yield SSE_DONE;
}

/* ------------------------------------------------------------------ *
 * Non-streaming response conversion
 * ------------------------------------------------------------------ */

/** OpenAI chat completion → Anthropic message. */
export function openaiToAnthropicResponse(body: Json, model: string): Json {
  const choice = body?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: Json[] = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : message.reasoning;
  if (typeof reasoning === "string" && reasoning) {
    content.push({ type: "thinking", thinking: reasoning, signature: "" });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let input: unknown = {};
    try {
      input = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: call?.id ?? `toolu_${randomUUID().slice(0, 12)}`,
      name: call?.function?.name ?? "",
      input,
    });
  }
  const stopReason =
    choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: body?.usage?.prompt_tokens ?? 0,
      output_tokens: body?.usage?.completion_tokens ?? 0,
    },
  };
}

/** Anthropic message → OpenAI chat completion. */
export function anthropicToOpenAIResponse(body: Json, model: string): Json {
  const content: Json[] = [];
  const toolCalls: Json[] = [];
  for (const block of Array.isArray(body?.content) ? body.content : []) {
    if (block?.type === "text") content.push({ type: "text", text: block.text ?? "" });
    else if (block?.type === "thinking") {
      content.push({ type: "reasoning_content", text: block.thinking ?? "" });
    } else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `call_${randomUUID().slice(0, 12)}`,
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const text = content.map((c) => c.text).join("");
  const reasoning = content
    .filter((c) => c.type === "reasoning_content")
    .map((c) => c.text)
    .join("");
  const message: Json = { role: "assistant", content: toolCalls.length ? null : text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const stopReason =
    body?.stop_reason === "max_tokens" ? "length" : body?.stop_reason === "tool_use" ? "tool_calls" : "stop";
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopReason }],
    usage: {
      prompt_tokens: body?.usage?.input_tokens ?? 0,
      completion_tokens: body?.usage?.output_tokens ?? 0,
      total_tokens: (body?.usage?.input_tokens ?? 0) + (body?.usage?.output_tokens ?? 0),
    },
  };
}
