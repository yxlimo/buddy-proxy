// lib/workbuddy-transport.ts — talking to the WorkBuddy chat endpoint.
//
// WorkBuddy speaks the OpenAI chat-completions dialect natively, so a request
// body goes out almost unchanged. What is not native is the identity around it:
// the upstream checks that the request looks like it came from the official
// client, which is a set of headers describing the account, the conversation
// and a trace (lib/workbuddy-auth.ts builds them).
//
// Two behaviours worth knowing:
//
//   * The upstream answers with a stream even when the client asked for none.
//     The official client always streams, so a non-streaming request is folded
//     back into a single chat.completion object here.
//   * A failure can arrive as HTTP 200 with an error object in the body. The
//     gateway has to look, or the client sees an empty answer.

import { AuthError } from "./credential.ts";
import { chatBase, chatHeaders, refreshSession, CONFIG_PATH, type WorkBuddyRegion, type WorkBuddySession } from "./workbuddy-auth.ts";
import { curateCatalog, parseRemoteCatalog, type WorkBuddyModel } from "./workbuddy-models.ts";
import { readOpenAIChunks, SSE_DONE } from "./sse-stream.ts";

export const CHAT_PATH = "/v2/chat/completions";

export interface WorkBuddyChatOptions {
  region?: WorkBuddyRegion;
  stream?: boolean;
  conversationId?: string;
}

export interface WorkBuddyChat {
  /** The upstream response, still a stream. */
  response: Response;
  session: WorkBuddySession;
}

/** The body the upstream expects, with the pieces the official client adds. */
export function buildChatBody(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...body };
  const messages = Array.isArray(out.messages) ? out.messages : [];
  if (!messages.length || messages[0]?.role !== "system") {
    out.messages = [{ role: "system", content: "You are a helpful assistant." }, ...messages];
  }
  out.stream = true;
  if (!out.stream_options) out.stream_options = { include_usage: true };
  // The official CLI does not send these, and they only invite the upstream to
  // look at fields the proxy does not know about.
  for (const key of ["metadata", "conversation_id", "previous_response_id"]) delete out[key];
  out.cache_retention = "long";
  return out;
}

/**
 * Send one chat request. The returned response is the upstream's stream; the
 * caller either forwards it or folds it into one object.
 */
export async function workbuddyChat(
  body: Record<string, any>,
  opts: WorkBuddyChatOptions = {},
): Promise<WorkBuddyChat> {
  const region = opts.region ?? "cn";
  // The session, not just the credential: the request needs the account id and
  // the domain the account belongs to as well as the token.
  const session = await refreshSession(false, region);

  const payload = buildChatBody(body);
  const url = `${chatBase(session)}${CHAT_PATH}`;
  const headers = chatHeaders(session, { conversationId: opts.conversationId });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch (e) {
    throw new AuthError(
      `upstream unreachable (${(e as Error).message})`,
      `连不上 WorkBuddy（${url}）。`,
      502,
    );
  }

  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().catch(() => "");
    throw new AuthError(
      `upstream rejected the credential (HTTP ${res.status})`,
      `WorkBuddy 拒绝了当前凭据：${detail.slice(0, 200)}`,
      503,
    );
  }
  if (res.status >= 400) {
    const detail = await res.text().catch(() => "");
    throw new AuthError(
      `upstream error (HTTP ${res.status})`,
      detail.slice(0, 300) || `WorkBuddy 返回了 HTTP ${res.status}`,
      502,
    );
  }

  return { response: res, session };
}

export interface AggregatedChoice {
  content: string;
  reasoning: string;
  toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[];
}

/**
 * The live catalogue. The upstream publishes it at GET /v3/config and adds
 * models without a client release, so this is the source of truth; the bundled
 * snapshot is only the fallback.
 */
export async function fetchWorkBuddyCatalog(region: WorkBuddyRegion = "cn"): Promise<WorkBuddyModel[] | null> {
  const session = await refreshSession(false, region);
  const res = await fetch(`${chatBase(session)}${CONFIG_PATH}`, {
    headers: { ...chatHeaders(session), "Content-Type": "application/json" },
  });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  const remote = parseRemoteCatalog(payload);
  if (!remote) return null;
  const models = curateCatalog(remote);
  return models.length ? models : null;
}

/** Fold an upstream stream into one chat.completion object. */
export async function aggregateStream(response: Response, model: string): Promise<any> {
  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: any = null;
  let id = "";
  let finish = "stop";

  if (response.body) {
    for await (const chunk of readOpenAIChunks(response.body)) {
      if (!chunk) continue;
      if (chunk.id) id = chunk.id;
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string") content.push(delta.content);
        if (typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content);
        if (choice.finish_reason) finish = choice.finish_reason;
        for (const call of delta.tool_calls ?? []) {
          const index = typeof call.index === "number" ? call.index : toolCalls.size;
          const entry = toolCalls.get(index) ?? { id: call.id ?? "", type: "function", function: { name: "", arguments: "" } };
          if (call.id) entry.id = call.id;
          if (call.type) entry.type = call.type;
          if (call.function?.name) entry.function.name += call.function.name;
          if (typeof call.function?.arguments === "string") entry.function.arguments += call.function.arguments;
          toolCalls.set(index, entry);
        }
      }
    }
  }

  const message: Record<string, any> = { role: "assistant", content: content.join("") };
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  const calls = [...toolCalls.values()];
  if (calls.length) message.tool_calls = calls;

  return {
    id: id || `chatcmpl-${model}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : finish }],
    ...(usage ? { usage } : {}),
  };
}

export { SSE_DONE };
