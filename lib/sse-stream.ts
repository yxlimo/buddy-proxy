import type { Json } from "./json.ts";

// lib/sse-stream.ts — reading and writing SSE, for the paths that have to convert
// between dialects instead of passing bytes through.
//
// The MiniMax upstream does not need any of this: its stream is copied the
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
  // The data lines of the event being read.
  let dataLines: string[] = [];

  /** Take the event that was read, if there is one. */
  const take = (): SseEvent | undefined => {
    if (!dataLines.length) {
      event = undefined;
      return undefined;
    }
    const payload = dataLines.join("\n");
    const name = event;
    dataLines = [];
    event = undefined;
    return name ? { event: name, data: payload } : { data: payload };
  };

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
          const ev = take();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          continue;
        }
        // A line with no field name belongs to the data line above it: some
        // upstreams (Qoder) pretty-print the JSON across several lines, and
        // dropping the continuations would lose the whole frame — including the
        // usage that rides in the last one.
        if (dataLines.length) dataLines.push(line);
      }
    }
    // Whatever is left when the stream ends.
    const rest = buffer.trim();
    if (rest) {
      if (rest.startsWith("data:")) dataLines.push(rest.slice(5).replace(/^ /, ""));
      else if (dataLines.length) dataLines.push(rest);
    }
    const ev = take();
    if (ev) yield ev;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse JSON that has a raw control character inside a string.
 *
 * Qoder's last frame of a stream carries a field whose value contains a
 * newline that was never escaped, which strict JSON rejects — and that frame is
 * the one the usage arrives in. Escaping the control characters instead of
 * failing keeps the numbers, which is the whole point of the frame.
 */
export function parseLooseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the lenient pass */
  }
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out +=
          code === 10 ? "\\n" : code === 13 ? "\\r" : code === 9 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return JSON.parse(out);
}

/**
 * Parse an OpenAI-style SSE stream into chunks.
 *
 * An upstream error can arrive inside a 200 response as an SSE error event or as
 * an `error` field in the payload. Swallowing it would turn a failure into an
 * empty reply, which looks like a model that thought for a moment and gave up —
 * so it is raised instead.
 */
export async function* readOpenAIChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  for await (const ev of readSseEvents(body)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let chunk: Json;
    try {
      chunk = parseLooseJson(ev.data);
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
