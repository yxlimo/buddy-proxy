import type { Json } from "../json.ts";
import { AuthError } from "../credential.ts";
import { randomUUID } from "node:crypto";
import { readSseEvents, sseData, sseEvent, SSE_DONE } from "../sse-stream.ts";


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
  onUsage?: (usage: Json) => void,
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
  let cachedTokens = 0;
  let reasoningTokens = 0;
  // The OpenAI dialect reports the usage in the last chunk, which can arrive
  // after the chunk that carries the finish reason. The stream therefore is not
  // over until the upstream says so.
  let finalStopReason = "";
  let finished = false;
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
    // 上游偶尔发 `data: null` 这一帧（流末尾的哨兵）。它的意思是「没有内容」，
    // 不是失败：在这里放行。否则下一行读 `chunk.usage` 会抛 TypeError，整条
    // 答复变成一个 api_error（线上就是这样，一秒断流）。
    if (!chunk) continue;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens;
      reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens;
    }
    // After the finish reason the upstream may still send the usage; anything
    // else would arrive out of order and is dropped.
    if (finished) continue;
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
      finalStopReason = stopReason;
      // The stream is not over yet: the usage may still be coming.
      finished = true;
    }
  }

  if (!started) yield* start();
  if (textOpen) yield sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex });
  if (thinkingOpen) yield sseEvent("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
  yield sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: finalStopReason || "end_turn", stop_sequence: null },
    // The Anthropic dialect reports the input tokens in the first frame, but the
    // OpenAI dialect only knows them at the end — so they ride along here, and a
    // client that reads them from the last frame finds them.
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
      ...(reasoningTokens ? { output_tokens_details: { thinking_tokens: reasoningTokens } } : {}),
    },
  });
  onUsage?.({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
    ...(reasoningTokens ? { output_tokens_details: { thinking_tokens: reasoningTokens } } : {}),
  });
  yield sseEvent("message_stop", { type: "message_stop" });
}

/** Anthropic stream → OpenAI SSE chunks. */
export async function* anthropicStreamToOpenAI(
  body: ReadableStream<Uint8Array>,
  model: string,
  onUsage?: (usage: Json) => void,
): AsyncGenerator<string> {
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let finished = false;
  const toolIndex = new Map<number, number>();
  let nextToolIndex = 0;
  // The Anthropic dialect reports the input tokens in the first frame and the
  // output tokens in the last one, so they are collected and the OpenAI chunk
  // carries them at the end.
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  const chunk = (delta: Json, finishReason: string | null = null, usage?: Json) =>
    sseData({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
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
      const usage = evt.message?.usage ?? {};
      inputTokens = usage.input_tokens ?? inputTokens;
      cachedTokens = usage.cache_read_input_tokens ?? cachedTokens;
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
      const usage = evt.usage ?? {};
      if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
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
      const usage = openaiUsage(inputTokens, outputTokens, cachedTokens);
      onUsage?.(usage);
      yield chunk({}, null, usage);
      yield SSE_DONE;
      return;
    }
  }
  if (!finished) yield chunk({}, "stop");
  const usage = openaiUsage(inputTokens, outputTokens, cachedTokens);
  onUsage?.(usage);
  yield chunk({}, null, usage);
  yield SSE_DONE;
}

/** The usage in the OpenAI shape. */
function openaiUsage(inputTokens: number, outputTokens: number, cachedTokens: number): Json {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cachedTokens ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
  };
}

