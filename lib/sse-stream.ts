// lib/sse-stream.ts — reading and writing SSE, for the paths that have to convert
// between dialects instead of passing bytes through.
//
// The passthrough proxies (minimax-proxy) do not need any of this: they copy the
// upstream stream. The router does, because an OpenAI request aimed at the
// MiniMax gateway has to become an Anthropic request and back.

/** Turn a byte stream into a stream of SSE `data:` payloads, with the event name. */
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line === "") {
          // Blank line ends an event.
          if (event !== undefined) {
            yield { event, data: "" };
            event = undefined;
          }
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).replace(/^ /, "");
          if (event === undefined) {
            yield { data };
          } else {
            yield { event, data };
            event = undefined;
          }
        }
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith("data:")) yield { data: rest.slice(5).replace(/^ /, "") };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an OpenAI-style SSE stream into chunks.
 *
 * An upstream error can arrive inside a 200 response as an SSE error event or as
 * an `error` field in the payload. Swallowing it would turn a failure into an
 * empty reply, which looks like a model that thought for a moment and gave up —
 * so it is raised instead.
 */
export async function* readOpenAIChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  for await (const ev of readSseEvents(body)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (ev.event === "error" || chunk?.error) {
      const detail = chunk?.error ?? chunk;
      throw new Error(
        `upstream stream error (${detail?.type ?? detail?.code ?? "unknown"}): ` +
          (typeof detail?.message === "string" ? detail.message : JSON.stringify(detail).slice(0, 300)),
      );
    }
    yield chunk;
  }
}

export function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";
