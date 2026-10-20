// lib/sse.ts — SSE plumbing shared by every proxy in this repo.
// Extracted from v2-proxy.ts so the MiniMax proxy writes events the same way.

import crypto from "node:crypto";

export type SinkRes = {
  writableEnded?: boolean;
  destroyed?: boolean;
  writeHead(code: number, headers: Record<string, string>): unknown;
  write(s: string): unknown;
  end(): unknown;
};

export function writeSafe(res: SinkRes, s: string): boolean {
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
