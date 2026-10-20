// lib/qoder-transport.ts — talking to the Qoder gateway.
//
// The new protocol speaks the OpenAI chat dialect natively: the body is a plain
// chat/completions request and the response is a plain SSE stream of
// chat.completion.chunk. Nothing has to be rewritten, which is why this is the
// cheap path — the CLI's own feature gate (model_server_transport) decides which
// protocol a given region serves.
//
// The one thing the endpoint wants on top of a normal OpenAI request is a
// metadata.context block carrying the session identity, and the machine identity
// headers.

import { randomUUID } from "node:crypto";
import { ensureCredential, ENDPOINTS, loadSession, type QoderRegion } from "./qoder-auth.ts";
import { AuthError } from "./credential.ts";

const USER_AGENT = "qoder/1.1.74";

/**
 * The upstream says a model is queued with
 *   403 {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
 * and that the nested message is a JSON string, so it has to be unwrapped twice.
 */
export interface LimitDetail {
  message: string;
  retryAfterSec?: number;
  queued?: boolean;
}

export function parseLimitError(text: string): LimitDetail | undefined {
  try {
    const outer = JSON.parse(text);
    let inner: any = outer;
    if (typeof outer?.message === "string") {
      try {
        inner = JSON.parse(outer.message);
      } catch {
        inner = outer;
      }
    }
    const message = typeof inner?.message === "string" ? inner.message : outer?.message;
    const retryAfterSec =
      typeof inner?.retryAfterSeconds === "number"
        ? inner.retryAfterSeconds
        : typeof inner?.waitTime === "number"
          ? inner.waitTime
          : undefined;
    return {
      message: message ?? text.slice(0, 200),
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      ...(inner?.isQueued !== undefined ? { queued: Boolean(inner.isQueued) } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Raised when the upstream is busy rather than broken. */
export class LimitError extends Error {
  retryAfterSec: number;
  detail: string;

  constructor(message: string, detail: string, retryAfterSec = 10) {
    super(message);
    this.name = "LimitError";
    this.detail = detail;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface QoderRequestOptions {
  stream: boolean;
  region?: QoderRegion;
  /** Force a token refresh before the request (used after a 401). */
  force?: boolean;
}

/** The session ids the gateway expects on every request. */
function contextBlock(): Record<string, string> {
  return {
    request_id: randomUUID(),
    request_set_id: randomUUID(),
    session_id: randomUUID(),
    task_id: "common",
    client_type: "qodercli",
  };
}

/**
 * Build the upstream body. The caller's OpenAI body is used as-is; only the
 * metadata.context block is added, and an existing one is left alone.
 */
export function buildBody(body: Record<string, unknown>, stream: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  out.stream = stream;
  const metadata = (out.metadata ?? {}) as Record<string, unknown>;
  const existing = (metadata.context ?? {}) as Record<string, unknown>;
  out.metadata = { ...metadata, context: { ...contextBlock(), ...existing } };
  return out;
}

async function upstreamHeaders(region: QoderRegion, force: boolean): Promise<Record<string, string>> {
  const cred = await ensureCredential(force, region);
  const session = loadSession(region);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": USER_AGENT,
    "X-Request-ID": randomUUID(),
    "X-Session-ID": randomUUID(),
  };
  if (session) {
    headers["Cosy-MachineToken"] = session.machineToken;
    headers["Cosy-Machine-Type"] = session.machineType;
  }
  return headers;
}

/**
 * One chat completion. Returns the upstream response as-is; the caller decides
 * whether to stream it through or read it whole. A 401 triggers exactly one
 * forced refresh and retry, the way the real client does.
 */
export async function qoderChatCompletion(
  body: Record<string, unknown>,
  opts: QoderRequestOptions,
): Promise<Response> {
  const region = opts.region ?? "global";
  const url = ENDPOINTS[region].infer;

  const send = async (force: boolean) => {
    const headers = await upstreamHeaders(region, force);
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(body, opts.stream)),
    });
  };

  let r = await send(opts.force ?? false);
  if (r.status === 401) {
    r = await send(true);
  }
  if (r.status === 401) {
    const text = await r.text().catch(() => "");
    throw new AuthError(
      `upstream rejected the credential (HTTP 401)`,
      `Qoder 拒绝了当前凭据。去 qoder.com 重新登录：node scripts/qoder-login.ts --region ${region}`,
      503,
    );
  }
  if (r.status === 403 || r.status === 429) {
    // 403 is not a credential problem here: Qoder answers 403 with
    // RESOURCE_LIMIT when the model is queued, and 429 when every backend for
    // it is busy. Both are worth retrying.
    const text = await r.text().catch(() => "");
    const detail = parseLimitError(text);
    throw new LimitError(
      `qoder model is queued (HTTP ${r.status})`,
      detail?.message ?? `Qoder 上游繁忙（HTTP ${r.status}）：${text.slice(0, 200)}`,
      detail?.retryAfterSec ?? 10,
    );
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new AuthError(`upstream HTTP ${r.status}`, `Qoder 上游返回 ${r.status}：${text.slice(0, 300)}`, 502);
  }
  return r;
}
