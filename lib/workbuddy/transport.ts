// lib/workbuddy/transport.ts — talking to the WorkBuddy chat endpoint.
//
// WorkBuddy speaks the OpenAI chat-completions dialect natively, so a request
// body goes out almost unchanged. What is not native is the identity around it:
// the upstream only talks to its own closed client, so the request has to look
// like it came from that client -- a set of headers describing the account, the
// conversation and a trace (lib/workbuddy/auth.ts builds them). That is what
// this module does: it is the simulated client, and the account's session is
// kept alive so the upstream believes it.
//
// Two behaviours worth knowing:
//
//   * The upstream answers with a stream even when the agent asked for none.
//     The official client always streams, so a non-streaming request is folded
//     back into a single chat.completion object here.
//   * A failure can arrive as HTTP 200 with an error object in the body. The
//     gateway has to look, or the agent sees an empty answer.

import type { Json } from "../json.ts";
import { createHash } from "node:crypto";
import { AuthError } from "../credential.ts";
import { withCooldownUntil, withUpstreamStatus, retryAfterMs } from "../upstream-status.ts";
import {
  chatBase,
  chatHeaders,
  loadSession,
  regionOf,
  CONFIG_PATH,
  type WorkBuddySession,
} from "./auth.ts";
import { clampEffort, curateCatalog, parseRemoteCatalog, type WorkBuddyModel } from "./models.ts";
import { cliFetch } from "../http.ts";
import { readOpenAIChunks, SSE_DONE } from "../sse-stream.ts";
import { catalogTtlMs, readStoredCatalog, writeStoredCatalog } from "./catalog-store.ts";

export const CHAT_PATH = "/v2/chat/completions";

export interface WorkBuddyChatOptions {
  /** Which provider (which account) to talk to. */
  providerId?: string;
  stream?: boolean;
  conversationId?: string;
  /** The model, so the body can be built the way the simulated client builds it. */
  model?: WorkBuddyModel | null;
}

export interface WorkBuddyChat {
  /** The upstream response, still a stream. */
  response: Response;
  session: WorkBuddySession;
}

/**
 * The body the upstream expects, with the pieces the simulated client adds.
 *
 * The simulated client does not pass the caller's parameters through: it sends
 * the ones the model carries, clamps the thinking level to what the model
 * accepts, and leaves the tools out of a model that cannot call them.
 */
export function buildChatBody(
  body: Json,
  model?: WorkBuddyModel | null,
): Json {
  const out: Json = { ...body };
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

    // A model that thinks is also asked for a summary of its thinking and for
    // a verbose answer. The official client sends these two only for a model
    // that reasons — a request for a model that does not has neither, and the
    // compatibility rules of the product gateway keep them as they are.
    if (model.reasoning) {
      if (out.reasoning_summary === undefined) out.reasoning_summary = "auto";
      if (out.verbosity === undefined) out.verbosity = "high";
    } else {
      delete out.reasoning_summary;
      delete out.verbosity;
    }

    // A model that cannot call tools is sent no tools.
    if (!model.tools) {
      delete out.tools;
      delete out.tool_choice;
    }

    // The model carries its own parameters, and the simulated client sends
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
  // Shaped like a UUIDv7, because that is the shape the simulated client checks.
  const version = ((digest[6] & 0x07) | 0x07).toString(16);
  const variant = ((digest[7] & 0x03) | 0x08).toString(16);
  const id = `${hex.slice(0, 12)}${version}${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** How often a failed request is tried again. */
const MAX_ATTEMPTS = 2;
/**
 * How long a request may take before it is given up on.
 *
 * 300 seconds, like MiniMax and ZCode: 120 seconds cut long generations off
 * (the client saw ECONNRESET), and a cut-off request is not the account's
 * fault — it used to cool the account down for five minutes.
 */
const TIMEOUT_MS = 300_000;
/**
 * How long the catalogue fetch may take.
 *
 * The catalogue is a background action at startup, not a chat: it must not
 * hold a chat's budget, so it keeps its own short limit.
 */
const CATALOG_TIMEOUT_MS = 30_000;

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
  body: Json,
  opts: WorkBuddyChatOptions = {},
): Promise<WorkBuddyChat> {
  // The provider says which account; the account says which region.
  const providerId = opts.providerId ?? "workbuddy-cn";
  // The session, not just the credential: the request needs the account id and
  // the domain the account belongs to as well as the token.
  //
  // 令牌是定时器换的，这一条路不换：它只取现在这一份。过期了就是过期了，
  // 报出来，让定时器去换。
  let session = loadSession(providerId);
  if (!session) {
    throw new AuthError(
      "no session",
      `WorkBuddy 这个账号没有登录。在面板上登录一次。`,
      503,
    );
  }

  const payload = buildChatBody(body, opts.model ?? null);
  const url = `${chatBase(session)}${CHAT_PATH}`;

  for (let attempt = 1; ; attempt++) {
    const headers = chatHeaders(session, { conversationId: opts.conversationId });
    let res: Response;
    try {
      res = await cliFetch(url, {
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
      // 平台拒了这个令牌：这里不换令牌（换令牌是定时器的事，它临期就换）。
      // 换个说法报出去。
      throw withUpstreamStatus(
        new AuthError(
          `upstream rejected the credential (HTTP ${res.status})`,
          `WorkBuddy 拒绝了当前凭据：${detail.slice(0, 200)}`,
          503,
        ),
        res.status,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      const detail = await res.text().catch(() => "");
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter : 0);
        continue;
      }
      const error = withUpstreamStatus(
        new AuthError(
          `upstream error (HTTP ${res.status})`,
          detail.slice(0, 300) || `WorkBuddy 返回了 HTTP ${res.status}`,
          res.status === 429 ? 429 : 502,
        ),
        res.status,
      );
      // 上游说的「过多久再试」：冷却到那时候为止（路由层看这个，不自己猜）。
      const wait = retryAfterMs(res);
      if (wait !== null) withCooldownUntil(error, Date.now() + wait);
      throw error;
    }

    if (res.status >= 400) {
      const detail = await res.text().catch(() => "");
      // The client sees the gateway's status; the upstream's own status says
      // whether another account would do better (a 400 is the request's fault,
      // and every account would fail the same way).
      throw withUpstreamStatus(
        new AuthError(
          `upstream error (HTTP ${res.status})`,
          detail.slice(0, 300) || `WorkBuddy 返回了 HTTP ${res.status}`,
          502,
        ),
        res.status,
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

/**
 * The live catalogue. The upstream publishes it at GET /v3/config and adds
 * models without a client release, so this is the source of truth.
 *
 * The catalogue lives in the database (lib/workbuddy/catalog-store.ts): the
 * last one that was fetched successfully is kept there whatever its age, and a
 * fetch that fails answers with that one rather than with the bundled
 * bootstrap table. The table only fills the gap of a brand-new database, and
 * it is replaced as soon as the upstream answers for the first time.
 *
 * The official client keeps the catalogue for three quarters of an hour and
 * falls back to the last one it got when the server cannot be reached, so the
 * same is done here: the catalogue is fetched rarely, and a failure answers
 * with the last good one rather than with nothing.
 */
export async function fetchWorkBuddyCatalog(
  providerId = "workbuddy-cn",
  options: { force?: boolean } = {},
): Promise<WorkBuddyModel[] | null> {
  // 目录按区域分开存：这个账号是哪个区的，就只读写那个区的那一份。
  const region = regionOf(providerId);
  const stored = readStoredCatalog(region);
  // 库里那份不旧就直接用：不必问上游。
  if (stored && !options.force && Date.now() - stored.at < catalogTtlMs()) {
    return stored.models;
  }

  try {
    // 只取现在这一份会话：换令牌是定时器的事。
    const session = loadSession(providerId);
    if (!session) return stored?.models ?? null;
    const res = await cliFetch(`${chatBase(session)}${CONFIG_PATH}`, {
      headers: { ...chatHeaders(session), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) return stored?.models ?? null;
    const payload = await res.json().catch(() => null);
    const remote = parseRemoteCatalog(payload);
    if (!remote) return stored?.models ?? null;
    const models = curateCatalog(remote);
    if (!models.length) return stored?.models ?? null;
    // 抓到了新的：写进库（那是往后的事实），内存里的那份也换掉。
    writeStoredCatalog(models, region);
    return models;
  } catch {
    return stored?.models ?? null;
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
      // the agent sees an empty answer and no reason.
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

  const message: Json = { role: "assistant", content: content.join("") };
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
