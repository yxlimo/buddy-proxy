// lib/router/deliver.ts — how an answer reaches the client.
//
// The upstreams answer in two dialects: the OpenAI ones (Qoder, WorkBuddy,
// TokenRhythm, SenseNova, 书生·端砚, the MiniMax open platform) and the
// Anthropic ones (MiniMax Code, ZCode). The client may ask in either. So an
// answer is converted at most once, and the way it is written out — the
// headers, the frames, the error events — is the same for every upstream.

import type { Json } from "../json.ts";
import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../credential.ts";
import { LimitError } from "../qoder/transport.ts";
import { anthropicStreamToOpenAI, openaiStreamToAnthropic } from "../dialect/stream.ts";
import { anthropicToOpenAIResponse, openaiToAnthropicResponse } from "../dialect/response.ts";
import { parseLooseJson, readOpenAIChunks, readSseEvents, sseData, sseEvent, SSE_DONE } from "../sse-stream.ts";

export type Dialect = "anthropic" | "openai";

/** The dialect an upstream answers in. */
export type UpstreamDialect = Dialect;

const rid = (prefix: string) => prefix + crypto.randomBytes(12).toString("hex");

/**
 * Take the response over.
 *
 * A stream is written frame by frame, so Koa must not also write a body of its
 * own when the middleware chain ends. `respond = false` says that the raw
 * response belongs to us from here on.
 */
function takeOver(ctx: Koa.Context): void {
  ctx.respond = false;
  // Koa starts every request at 404 and only replaces that when it writes the
  // response itself. A stream writes its own, so nothing would ever say 200
  // and the client would see a 404 with a perfectly good body.
  ctx.status = 200;
}

/** The headers of a streaming answer. */
function sseHead(ctx: Koa.Context): void {
  ctx.res.setHeader("content-type", "text/event-stream; charset=utf-8");
  ctx.res.setHeader("cache-control", "no-cache, no-transform");
  ctx.res.setHeader("connection", "keep-alive");
  ctx.res.setHeader("x-accel-buffering", "no");
  ctx.res.flushHeaders?.();
}

/** Write a frame, and say whether the client is still there. */
function writeSafe(ctx: Koa.Context, chunk: string | Uint8Array): boolean {
  try {
    return ctx.res.write(chunk);
  } catch {
    return false;
  }
}

/**
 * Look at the first chunk before committing to a 200 response.
 *
 * The gateway can report a failure inside a 200 response (an SSE error event, or
 * a 429 body). If the headers were already sent there is no way to turn that
 * into a proper status code, so the check happens first.
 */
export async function peekStream(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done) {
    reader.releaseLock();
    return body;
  }
  const head = new TextDecoder().decode(first.value);
  if (head.includes('"error"') || head.includes("errorCode")) {
    const rest = await new Response(body).text();
    let message = rest.slice(0, 300);
    try {
      const parsed = JSON.parse(rest);
      const detail = parsed?.error ?? parsed;
      message = detail?.message ?? parsed?.message ?? message;
    } catch {
      /* keep the raw text */
    }
    throw new AuthError("upstream rejected the request", message, 502);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * The error a failed answer becomes, with the upstream's own message.
 *
 * The answer carries the failure inside the body (an OpenAI `error` object);
 * this turns it into the error the client sees.
 */
export function errorFromUpstreamPayload(detail: any): AuthError {
  return new AuthError(
    `upstream error (${detail?.type ?? detail?.code ?? "unknown"})`,
    typeof detail?.message === "string" ? detail.message : JSON.stringify(detail).slice(0, 300),
    502,
  );
}

/** The whole answer, for a client that did not ask for a stream. */
export function deliverJson(
  ctx: Koa.Context,
  dialect: Dialect,
  from: UpstreamDialect,
  json: any,
  model: string,
  onUsage?: (usage: any) => void,
): void {
  if (from === "openai" && json?.error) throw errorFromUpstreamPayload(json.error);
  const payload =
    dialect === from
      ? json
      : from === "openai"
        ? openaiToAnthropicResponse(json, model)
        : anthropicToOpenAIResponse(json, model);
  // The answer names the model the client asked for. The upstream may know it
  // by another name — a tier key, or the name behind a published model — but
  // the client asked for this one. Both dialects: an Anthropic answer that
  // names the upstream's model is as confusing as an OpenAI one.
  if (payload && typeof payload === "object") {
    payload.model = model;
  }
  onUsage?.(payload?.usage);
  ctx.body = payload;
}

/**
 * Watch the chunks for the upstream's finish reason.
 *
 * A client that asked for a handful of tokens gets a handful of tokens and an
 * upstream that says it stopped there. That is what the client asked for, but
 * from the outside it looks like a broken answer, so the reason is handed to
 * whoever wants to say so in the log.
 */
async function* watchFinish(
  chunks: AsyncIterable<Json>,
  onFinish?: (reason: string) => void,
  onUsage?: (usage: any) => void,
): AsyncGenerator<Json> {
  for await (const chunk of chunks) {
    const reason = chunk?.choices?.[0]?.finish_reason;
    if (reason && onFinish) onFinish(String(reason));
    if (chunk?.usage && onUsage) onUsage(chunk.usage);
    yield chunk;
  }
}

/**
 * A stream of OpenAI chunks.
 *
 * The frames are parsed and written out again rather than copied, because an
 * upstream frame can be malformed — Qoder's last frame carries a raw newline
 * inside a string — and a client that cannot parse it loses the finish reason
 * and the usage with it.
 */
export async function deliverOpenAIStream(
  ctx: Koa.Context,
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  model: string,
  onFinish?: (reason: string) => void,
  onUsage?: (usage: any) => void,
): Promise<void> {
  const upstream = await peekStream(body);
  ctx.res.setHeader("x-request-id", rid("req_"));
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "openai") {
    await pipeOpenAIChunks(upstream, ctx, onFinish, onUsage, model);
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(watchFinish(readOpenAIChunks(upstream), onFinish, onUsage), model)) {
      if (!writeSafe(ctx, chunk)) break;
    }
  } catch (e) {
    // The headers are already out, so the failure goes back as an error event.
    writeSafe(ctx, errorEvent((e as Error)?.message));
  }
  ctx.res.end();
}

/** A stream of Anthropic bytes. */
export async function deliverAnthropicStream(
  ctx: Koa.Context,
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  model: string,
  pingMs = 0,
  onUsage?: (usage: any) => void,
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "anthropic") {
    // The bytes go to the client as they are, apart from one thing: the
    // message_start frame names the model, and it has to name the one the
    // client asked for. The upstream may know it by another name — a tier
    // key, or the name behind a published model.
    //
    // A copy is parsed on the side for the usage: the upstream puts the input
    // tokens in message_start and the output tokens in message_delta, and
    // nobody reads those unless someone parses them.
    const [toClient, toParser] = body.tee();
    void (async () => {
      try {
        for await (const event of readSseEvents(toParser)) {
          const json = parseLooseJson(event.data);
          if (onUsage && json?.usage) onUsage(json.usage);
        }
      } catch {
        // The usage is a nice-to-have; the answer itself is what matters.
      }
    })();
    await writeAnthropicFrames(toClient, ctx, model, pingMs);
    return;
  }
  try {
    for await (const chunk of anthropicStreamToOpenAI(body, model, onUsage)) {
      if (!writeSafe(ctx, chunk)) break;
    }
  } catch (e) {
    writeSafe(ctx, errorEvent((e as Error)?.message));
  }
  ctx.res.end();
}

/** A stream of OpenAI chunks that are already parsed (the legacy protocol). */
export async function deliverOpenAIChunks(
  ctx: Koa.Context,
  chunks: AsyncIterable<any>,
  dialect: Dialect,
  model: string,
  onUsage?: (usage: any) => void,
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "openai") {
    try {
      for await (const chunk of chunks) {
        if (chunk?.usage && onUsage) onUsage(chunk.usage);
        if (model && chunk && typeof chunk === "object") chunk.model = model;
        if (!writeSafe(ctx, sseData(chunk))) break;
      }
      writeSafe(ctx, SSE_DONE);
    } catch (e) {
      writeSafe(ctx, errorEvent((e as Error)?.message));
    }
    ctx.res.end();
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(chunks, model)) {
      if (!writeSafe(ctx, chunk)) break;
    }
  } catch (e) {
    writeSafe(ctx, errorEvent((e as Error)?.message));
  }
  ctx.res.end();
}

function errorEvent(message: string): string {
  return sseEvent("error", { type: "error", error: { type: "api_error", message } });
}

/** Forward an OpenAI stream, frame by frame. */
async function pipeOpenAIChunks(
  body: ReadableStream<Uint8Array>,
  ctx: Koa.Context,
  onFinish?: (reason: string) => void,
  onUsage?: (usage: any) => void,
  model?: string,
): Promise<void> {
  try {
    for await (const chunk of watchFinish(readOpenAIChunks(body), onFinish, onUsage)) {
      if (model && chunk && typeof chunk === "object") chunk.model = model;
      if (!writeSafe(ctx, sseData(chunk))) break;
    }
    writeSafe(ctx, SSE_DONE);
  } catch (e) {
    writeSafe(ctx, sseData({ error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" } }));
    writeSafe(ctx, SSE_DONE);
  } finally {
    // The response has to end, or the client waits for a connection that never
    // closes.
    ctx.res.end();
  }
}

/**
 * 把上游的 Anthropic 流写给客户端，只改一处：message_start 里的模型名。
 *
 * 客户端问的是哪个模型，答复里就该是哪个 —— 上游可能用另一个名字（档位的
 * key，或者发布模型背后的真名）。别的帧逐字不动。
 *
 * With `pingMs` set, a `ping` event goes out whenever the upstream has been
 * quiet for that long. Some hops in front of the gateway (a local HTTP proxy,
 * a NAT gateway) drop idle connections, and a long thinking pause can keep the
 * stream quiet for minutes. The upstream sends `event: ping` right after
 * message_start but then goes silent while the model thinks, so we emit our
 * own.
 *
 * Two rules keep this safe:
 *   - only ping when the stream is actually idle, so a busy stream is not
 *     padded with useless events;
 *   - only ping on an SSE frame boundary, because writing one in the middle
 *     of an upstream frame would corrupt the client's parse.
 */
async function writeAnthropicFrames(
  body: ReadableStream<Uint8Array>,
  ctx: Koa.Context,
  model: string,
  pingMs = 0,
): Promise<void> {
  let lastActivity = Date.now();
  const writePing = () => {
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    if (Date.now() - lastActivity < pingMs) return;
    if (!writeSafe(ctx, 'event: ping\ndata: {"type":"ping"}\n\n')) return;
    lastActivity = Date.now();
  };
  const pingTimer = pingMs > 0 ? setInterval(writePing, Math.min(pingMs, 5000)) : null;
  pingTimer?.unref?.();
  try {
    for await (const event of readSseEvents(body)) {
      let data = event.data;
      if (event.event === "message_start" || (!event.event && data.includes('"message_start"'))) {
        const json = parseLooseJson(data);
        if (json?.message && typeof json.message === "object") {
          json.message.model = model;
          data = JSON.stringify(json);
        }
      }
      const frame = event.event ? `event: ${event.event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
      if (!writeSafe(ctx, frame)) break;
      lastActivity = Date.now();
    }
  } catch (e) {
    writeSafe(ctx, errorEvent((e as Error)?.message));
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    ctx.res.end();
  }
}

/* ---------------- plumbing ---------------- */

/**
 * 这个错误什么时候能重试。
 *
 * 503 说的是「现在不行」，客户端还得知道什么时候行 —— 冷却到几点、套餐窗口
 * 什么时候换。恢复时间算在出错的地方（那里知道它从哪儿来），写头的事情在这里
 */
export function withRetryAfter<T extends Error>(error: T, untilMs: number): T {
  (error as T & { retryAfterUntilMs?: number }).retryAfterUntilMs = untilMs;
  return error;
}

/** 带恢复时间的错误，写出去的 `Retry-After`（秒）。 */
function retryAfterHeaders(e: unknown): Record<string, string> {
  const until = (e as { retryAfterUntilMs?: unknown })?.retryAfterUntilMs;
  if (typeof until !== "number" || !Number.isFinite(until)) return {};
  // 已经过点了也发 1 秒：Retry-After: 0 会被当成「别重试」。
  return { "retry-after": String(Math.max(1, Math.ceil((until - Date.now()) / 1000))) };
}

/**
 * Write a failure out.
 *
 * `headers` is for the failures that carry something the client acts on — a
 * 503 with `Retry-After` is the one that matters today.
 */
export function sendError(ctx: Koa.Context, e: unknown, headers: Record<string, string> = {}): void {
  const err = e as AuthError;
  const extra = { ...retryAfterHeaders(e), ...headers };
  if (e instanceof LimitError) {
    if (ctx.res.headersSent) {
      ctx.res.end();
      return;
    }
    ctx.status = 503;
    if (Object.keys(extra).length) ctx.set(extra);
    ctx.body = {
      error: { type: "api_error", message: e.message },
      hint: e.detail,
    };
    return;
  }
  const status = typeof err?.status === "number" ? err.status : 500;
  if (ctx.res.headersSent) {
    ctx.res.end();
    return;
  }
  ctx.status = status;
  if (Object.keys(extra).length) ctx.set(extra);
  ctx.body = {
    error: {
      // 503 means the credential is the problem; everything else is the request
      // or the upstream failing. A failure that says otherwise says so.
      type:
        err?.type ??
        (status === 503 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error"),
      message: err?.message ?? "request failed",
    },
    ...(err?.hint ? { hint: err.hint } : {}),
  };
}
