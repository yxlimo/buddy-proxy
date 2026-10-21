// lib/tokenrhythm/transport.ts — the inference side.
//
// TokenRhythm speaks the OpenAI dialect, so nothing is converted on the way
// there. The one thing that has to be adjusted is the thinking: in DeepSeek's
// thinking mode a request that ends with a tool result must carry the
// assistant's `reasoning_content` back, even when it is empty — otherwise the
// upstream answers 400. A client that switched models mid-conversation leaves
// that field out, so the gateway puts it back.

import { AuthError } from "../credential.ts";
import { TOKENRHYTHM_INFER_BASE, tokenRhythmTenant, type TokenRhythmTenant } from "./accounts.ts";

/** The one model the gateway serves for now. */
export const TOKENRHYTHM_MODELS = [
  {
    id: "deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    reasoning: true,
    toolCall: true,
    /** The levels the upstream's thinking mode takes. */
    efforts: ["low", "high", "max"],
    context: 1000000,
    maxOutput: 384000,
  },
] as const;

export const TOKENRHYTHM_MODEL_IDS = new Set(TOKENRHYTHM_MODELS.map((m) => m.id));

/**
 * Put the thinking back into the assistant messages.
 *
 * Only the messages that carry tool calls need it, and only when the field is
 * missing: `reasoning_content: null` is a type error upstream, so an empty
 * string is what goes in.
 */
export function restoreReasoningContent(body: Record<string, any>): void {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    if (!Array.isArray(message?.tool_calls) || message.tool_calls.length === 0) continue;
    if (message.reasoning_content === undefined) message.reasoning_content = "";
  }
}

/** The key the inference uses, and the tenant it belongs to. */
export function inferenceTenant(index: number): { tenant: TokenRhythmTenant; key: string } {
  const tenant = tokenRhythmTenant(index);
  if (!tenant) {
    throw new AuthError(`no tenant ${index} configured`, `没有配置第 ${index} 个 TokenRhythm 租户。`, 500);
  }
  if (!tenant.apiKey) {
    throw new AuthError(
      `tenant ${index} has no inference key`,
      `第 ${index} 个 TokenRhythm 租户没有配置 API key。设置 TOKENRHYTHM_${index}_API_KEY 后重启服务。`,
      500,
    );
  }
  return { tenant, key: tenant.apiKey };
}

/**
 * Send the request upstream.
 *
 * The answer comes back as the upstream's own bytes: it is an OpenAI stream or
 * an OpenAI object, and the gateway hands it on.
 */
export async function tokenRhythmChat(
  index: number,
  body: Record<string, any>,
): Promise<{ response: Response; key: string }> {
  const { tenant, key } = inferenceTenant(index);
  const payload = { ...body, model: body.model };
  restoreReasoningContent(payload);
  const response = await fetch(`${TOKENRHYTHM_INFER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: body.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok && response.status === 401) {
    throw new AuthError(
      "tokenrhythm rejected the key",
      `TokenRhythm 拒绝了第 ${index} 个租户的 key（HTTP 401）。`,
      502,
    );
  }
  if (!response.ok && response.status === 429) {
    throw new AuthError("tokenrhythm rate limit", "TokenRhythm 限流了，稍后再试。", 503);
  }
  return { response, key: tenant.apiKey ?? key };
}
