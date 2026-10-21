// lib/router/deliver.ts — how an answer reaches the client.
//
// The four upstreams answer in two dialects: Qoder and WorkBuddy speak
// OpenAI, MiniMax speaks Anthropic. The client may ask in either. So an
// answer is converted at most once, and the way it is written out — the
// headers, the frames, the error events — is the same for every upstream.

import crypto from "node:crypto";
import type express from "express";
import { AuthError } from "../credential.ts";
import { anthropicStreamToOpenAI, openaiStreamToAnthropic } from "../dialect/stream.ts";
import { anthropicToOpenAIResponse, openaiToAnthropicResponse } from "../dialect/response.ts";
import { readOpenAIChunks, sseData, sseEvent, SSE_DONE } from "../sse-stream.ts";

export type Dialect = "anthropic" | "openai";

/** The dialect an upstream answers in. */
export type UpstreamDialect = Dialect;

const rid = (prefix: string) => prefix + crypto.randomBytes(12).toString("hex");

/** The headers of a streaming answer. */
function sseHead(res: express.Response): void {
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
}

/** Write a frame, and say whether the client is still there. */
function writeSafe(res: express.Response, chunk: string | Uint8Array): boolean {
  try {
    return res.write(chunk);
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
  res: express.Response,
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
  res.json(payload);
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
  res: express.Response,
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  model: string,
): Promise<void> {
  const upstream = await peekStream(body);
  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    await pipeOpenAIChunks(upstream, res);
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(readOpenAIChunks(upstream), model)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    // The headers are already out, so the failure goes back as an error event.
    writeSafe(res, errorEvent((e as Error)?.message));
  }
  res.end();
}

/** A stream of Anthropic bytes. */
export async function deliverAnthropicStream(
  res: express.Response,
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  model: string,
): Promise<void> {
  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "anthropic") {
    await pipeStream(body, res);
    return;
  }
  try {
    for await (const chunk of anthropicStreamToOpenAI(body, model)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(res, errorEvent((e as Error)?.message));
  }
  res.end();
}

/** A stream of OpenAI chunks that are already parsed (the legacy protocol). */
export async function deliverOpenAIChunks(
  res: express.Response,
  chunks: AsyncIterable<any>,
  dialect: Dialect,
  model: string,
): Promise<void> {
  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    try {
      for await (const chunk of chunks) {
        if (!writeSafe(res, sseData(chunk))) break;
      }
      writeSafe(res, SSE_DONE);
    } catch (e) {
      writeSafe(res, errorEvent((e as Error)?.message));
    }
    res.end();
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(chunks, model)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(res, errorEvent((e as Error)?.message));
  }
  res.end();
}

function errorEvent(message: string): string {
  return sseEvent("error", { type: "error", error: { type: "api_error", message } });
}

/** Forward an OpenAI stream, frame by frame. */
async function pipeOpenAIChunks(body: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  try {
    for await (const chunk of readOpenAIChunks(body)) {
      if (!writeSafe(res, sseData(chunk))) break;
    }
    writeSafe(res, SSE_DONE);
  } catch (e) {
    writeSafe(res, sseData({ error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" } }));
    writeSafe(res, SSE_DONE);
  } finally {
    // The response has to end, or the client waits for a connection that never
    // closes.
    res.end();
  }
}

/** Forward an Anthropic stream, byte for byte. */
async function pipeStream(body: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // The bytes go out as they came in: this path forwards the upstream's own
      // SSE, and decoding it would only risk breaking a character across chunks.
      if (!writeSafe(res, value)) break;
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
