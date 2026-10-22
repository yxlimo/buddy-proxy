// lib/workbuddy/transport.ts — talking to the WorkBuddy chat endpoint.
//
// WorkBuddy speaks the OpenAI chat-completions dialect natively, so a request
// body goes out almost unchanged. What is not native is the identity around it:
// the upstream checks that the request looks like it came from the official
// client, which is a set of headers describing the account, the conversation
// and a trace (lib/workbuddy/auth.ts builds them).
//
// Two behaviours worth knowing:
//
//   * The upstream answers with a stream even when the client asked for none.
//     The official client always streams, so a non-streaming request is folded
//     back into a single chat.completion object here.
//   * A failure can arrive as HTTP 200 with an error object in the body. The
//     gateway has to look, or the client sees an empty answer.

import { createHash } from "node:crypto";
import { AuthError } from "../credential.ts";
import { chatBase, chatHeaders, refreshSession, CONFIG_PATH, type WorkBuddyRegion, type WorkBuddySession } from "./auth.ts";
import { clampEffort, curateCatalog, parseRemoteCatalog, type WorkBuddyModel } from "./models.ts";
import { readOpenAIChunks, SSE_DONE } from "../sse-stream.ts";
import { peekCached, setCached } from "../store.ts";

export const CHAT_PATH = "/v2/chat/completions";

export interface WorkBuddyChatOptions {
  region?: WorkBuddyRegion;
  stream?: boolean;
  conversationId?: string;
  /** The model, so the body can be built the way the official client builds it. */
  model?: WorkBuddyModel | null;
}

export interface WorkBuddyChat {
  /** The upstream response, still a stream. */
  response: Response;
  session: WorkBuddySession;
}

/**
 * The body the upstream expects, with the pieces the official client adds.
 *
 * The official client does not pass the caller's parameters through: it sends
 * the ones the model carries, clamps the thinking level to what the model
 * accepts, and leaves the tools out of a model that cannot call them.
 */
export function buildChatBody(
  body: Record<string, any>,
  model?: WorkBuddyModel | null,
): Record<string, any> {
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

  if (model) {
    // The thinking level has to be one the model accepts, or the upstream
    // refuses the request.
    const asked = out.reasoning_effort ?? out.reasoning?.effort ?? out.effort;
    const level = clampEffort(typeof asked === "string" ? asked : undefined, model.efforts);
    delete out.reasoning;
    delete out.effort;
    if (level) out.reasoning_effort = level;

    // A model that cannot call tools is sent no tools.
    if (!model.tools) {
      delete out.tools;
      delete out.tool_choice;
    }

    // The model carries its own parameters, and the official client sends
    // them when the caller did not choose any.
    if (typeof out.temperature !== "number" && typeof model.temperature === "number") {
      out.temperature = model.temperature;
    }
    if (typeof out.top_p !== "number" && typeof model.topP === "number") {
      out.top_p = model.topP;
    }
  }
  return out;
}

/**
 * The id of a conversation.
 *
 * The official client keeps one id per session and every turn of that session
 * carries it. The upstream counts what it is told per conversation, so a new
 * id per request makes every turn look like a new conversation — the context
 * is lost and the account looks busy.
 *
 * The proxy has no session of its own, so the id comes from the conversation:
 * the first system and user message decide it, and they do not change while
 * the conversation grows. A client that brings its own id keeps it.
 */
export function conversationIdFor(messages: any[], given?: string): string {
  if (typeof given === "string" && given.trim()) return given.trim();
  const head = (Array.isArray(messages) ? messages : [])
    .slice(0, 2)
    .map((m) => `${m?.role ?? ""}:${typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")}`)
    .join("|");
  const digest = createHash("sha256").update(head).digest();
  const hex = digest.toString("hex");
  // Shaped like a UUIDv7, because that is the shape the client checks.
  const version = ((digest[6] & 0x07) | 0x07).toString(16);
  const variant = ((digest[7] & 0x03) | 0x08).toString(16);
  const id = `${hex.slice(0, 12)}${version}${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** How often a failed request is tried again. */
const MAX_ATTEMPTS = 2;
/** How long a request may take before it is given up on. */
const TIMEOUT_MS = 120_000;

/** Wait before the next try: the server's own advice, or a backoff. */
async function backoff(attempt: number, retryAfterSec = 0): Promise<void> {
  const wait = retryAfterSec > 0 ? Math.min(retryAfterSec, 32) : Math.min(2 ** (attempt - 1), 32);
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
}

/**
 * Send one chat request. The returned response is the upstream's stream; the
 * caller either forwards it or folds it into one object.
 *
 * The official client does not give up at the first sign of trouble: it waits
 * for a new token when the old one was refused and sends the request again,
 * and it tries a failed request once more with a backoff.
 */
export async function workbuddyChat(
  body: Record<string, any>,
  opts: WorkBuddyChatOptions = {},
): Promise<WorkBuddyChat> {
  const region = opts.region ?? "cn";
  // The session, not just the credential: the request needs the account id and
  // the domain the account belongs to as well as the token.
  let session = await refreshSession(false, region);

  const payload = buildChatBody(body, opts.model ?? null);
  const url = `${chatBase(session)}${CHAT_PATH}`;

  for (let attempt = 1; ; attempt++) {
    const headers = chatHeaders(session, { conversationId: opts.conversationId });
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      throw new AuthError(
        `upstream unreachable (${(e as Error).message})`,
        `连不上 WorkBuddy（${url}）。`,
        502,
      );
    }

    if (res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => "");
      // A refused token means the token is old, not that the account is gone —
      // and only a 401 says that. A 403 is the account's business, and
      // refreshing for it would turn the token over for nothing.
      if (res.status === 401 && attempt === 1) {
        session = await refreshSession(true, region);
        continue;
      }
      throw new AuthError(
        `upstream rejected the credential (HTTP ${res.status})`,
        `WorkBuddy 拒绝了当前凭据：${detail.slice(0, 200)}`,
        503,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      const detail = await res.text().catch(() => "");
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter : 0);
        continue;
      }
      throw new AuthError(
        `upstream error (HTTP ${res.status})`,
        detail.slice(0, 300) || `WorkBuddy 返回了 HTTP ${res.status}`,
        res.status === 429 ? 429 : 502,
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
}

export interface AggregatedChoice {
  content: string;
  reasoning: string;
  toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[];
}

/** How long the catalogue is kept before it is fetched again. */
const CATALOG_TTL_MS = 48 * 60 * 1000;

/**
 * The live catalogue. The upstream publishes it at GET /v3/config and adds
 * models without a client release, so this is the source of truth; the bundled
 * snapshot is only the fallback.
 *
 * The official client keeps the catalogue for three quarters of an hour and
 * falls back to the last one it got when the server cannot be reached, so the
 * same is done here: the catalogue is fetched rarely, and a failure answers
 * with the last good one rather than with nothing.
 */
export async function fetchWorkBuddyCatalog(region: WorkBuddyRegion = "cn"): Promise<WorkBuddyModel[] | null> {
  const cached = peekCached<{ models: WorkBuddyModel[] }>("workbuddy:catalog");
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.data.models;

  try {
    const session = await refreshSession(false, region);
    const res = await fetch(`${chatBase(session)}${CONFIG_PATH}`, {
      headers: { ...chatHeaders(session), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return cached?.data.models ?? null;
    const payload = await res.json().catch(() => null);
    const remote = parseRemoteCatalog(payload);
    if (!remote) return cached?.data.models ?? null;
    const models = curateCatalog(remote);
    if (!models.length) return cached?.data.models ?? null;
    setCached("workbuddy:catalog", { models, at: Date.now() });
    return models;
  } catch {
    return cached?.data.models ?? null;
  }
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
      // A failure can arrive as a normal frame with an error in it. The
      // official client reads the body and classifies the error; without that
      // the client sees an empty answer and no reason.
      if (chunk.error) {
        const error = chunk.error as any;
        throw new AuthError(
          `upstream error (${error.code ?? error.type ?? "unknown"})`,
          typeof error.message === "string" ? error.message : JSON.stringify(error).slice(0, 300),
          502,
        );
      }
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
