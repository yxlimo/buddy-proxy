import { randomUUID } from "node:crypto";


type Json = Record<string, any>;

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
      ...(body?.usage?.prompt_tokens_details?.cached_tokens
        ? { cache_read_input_tokens: body.usage.prompt_tokens_details.cached_tokens }
        : {}),
      ...(body?.usage?.completion_tokens_details?.reasoning_tokens
        ? { output_tokens_details: { thinking_tokens: body.usage.completion_tokens_details.reasoning_tokens } }
        : {}),
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
  // Only the text blocks are the answer. A thinking block is the model's
  // reasoning, which belongs in `reasoning_content` — concatenating it into
  // the answer puts the reasoning in front of the text the caller asked for.
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
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
