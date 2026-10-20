// lib/sse.ts — SSE plumbing shared by every proxy in this repo.
// The SSE helpers, so the proxies write events the same way.

import crypto from "node:crypto";

export type SinkRes = {
  writableEnded?: boolean;
  destroyed?: boolean;
  writeHead(code: number, headers: Record<string, string>): unknown;
  // Node's res.write takes a string or a buffer; the OpenAI path forwards the
  // upstream's own bytes.
  write(chunk: string | Uint8Array): unknown;
  end(): unknown;
};

export function writeSafe(res: SinkRes, s: string | Uint8Array): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(s);
    return true;
  } catch {
    return false;
  }
}

export function sseHead(res: SinkRes) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export const rid = (prefix: string) => prefix + crypto.randomBytes(12).toString("hex");
