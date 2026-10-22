// lib/router/deliver.ts — how an answer reaches the client.
//
// The four upstreams answer in two dialects: Qoder and WorkBuddy speak
// OpenAI, MiniMax speaks Anthropic. The client may ask in either. So an
// answer is converted at most once, and the way it is written out — the
// headers, the frames, the error events — is the same for every upstream.

import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../credential.ts";
import { anthropicStreamToOpenAI, openaiStreamToAnthropic } from "../dialect/stream.ts";
import { anthropicToOpenAIResponse, openaiToAnthropicResponse } from "../dialect/response.ts";
import { readOpenAIChunks, sseData, sseEvent, SSE_DONE } from "../sse-stream.ts";

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

/** The error a failed answer becomes, with the upstream's own message. */
export function upstreamError(detail: any): AuthError {
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
): void {
  if (from === "openai" && json?.error) throw upstreamError(json.error);
  const payload =
    dialect === from
      ? json
      : from === "openai"
        ? openaiToAnthropicResponse(json, model)
        : anthropicToOpenAIResponse(json, model);
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
  chunks: AsyncIterable<Record<string, any>>,
  onFinish?: (reason: string) => void,
): AsyncGenerator<Record<string, any>> {
  for await (const chunk of chunks) {
    const reason = chunk?.choices?.[0]?.finish_reason;
    if (reason && onFinish) onFinish(String(reason));
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
): Promise<void> {
  const upstream = await peekStream(body);
  ctx.res.setHeader("x-request-id", rid("req_"));
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "openai") {
    await pipeOpenAIChunks(upstream, ctx, onFinish);
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(watchFinish(readOpenAIChunks(upstream), onFinish), model)) {
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
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "anthropic") {
    await pipeStream(body, ctx, pingMs);
    return;
  }
  try {
    for await (const chunk of anthropicStreamToOpenAI(body, model)) {
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
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "openai") {
    try {
      for await (const chunk of chunks) {
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
): Promise<void> {
  try {
    for await (const chunk of watchFinish(readOpenAIChunks(body), onFinish)) {
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
 * Forward an Anthropic stream, byte for byte.
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
async function pipeStream(
  body: ReadableStream<Uint8Array>,
  ctx: Koa.Context,
  pingMs = 0,
): Promise<void> {
  const reader = body.getReader();
  let tail = Buffer.alloc(0); // last bytes written, used to detect a frame boundary
  let lastActivity = Date.now();
  const writePing = () => {
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    if (Date.now() - lastActivity < pingMs) return; // upstream is still talking
    if (!/\r?\n\r?\n$/.test(tail.toString("latin1"))) return; // mid-frame: wait
    // Same payload the gateway itself sends, so clients see nothing unusual.
    if (writeSafe(ctx, 'event: ping\ndata: {"type":"ping"}\n\n')) lastActivity = Date.now();
  };
  const pingTimer = pingMs > 0 ? setInterval(writePing, Math.min(pingMs, 5000)) : null;
  pingTimer?.unref?.();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // The bytes go out as they came in: this path forwards the upstream's own
      // SSE, and decoding it would only risk breaking a character across chunks.
      if (!writeSafe(ctx, value)) break;
      lastActivity = Date.now();
      tail = Buffer.concat([tail, Buffer.from(value)]).slice(-4);
    }
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    reader.releaseLock();
    ctx.res.end();
  }
}
