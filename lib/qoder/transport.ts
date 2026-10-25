// lib/qoder/transport.ts — talking to the Qoder gateway.
//
// The new protocol speaks the OpenAI chat dialect natively: the body is a plain
// chat/completions request and the response is a plain SSE stream of
// chat.completion.chunk. Nothing has to be rewritten, which is why this is the
// cheap path — the CLI's own feature gate (model_server_transport) decides which
// protocol a given region serves.
//
// The one thing the endpoint wants on top of a normal OpenAI request is a
// metadata.context block carrying the session identity, and the machine identity
// headers. The upstream only talks to its own closed client, so those headers
// are the simulated client's part: this module and lib/qoder/legacy.ts are the
// two protocols the simulated client speaks, and the account's session is kept
// alive so the upstream keeps believing it.

import { randomUUID } from "node:crypto";
import {
  ensureCredential,
  ENDPOINTS,
  deviceIdentity,
  regionOf,
  type QoderRegion,
} from "./auth.ts";
import { AuthError } from "../credential.ts";
import { withUpstreamStatus } from "../upstream-status.ts";

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
  /** Which provider (which account) to talk to. */
  providerId?: string;
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

async function upstreamHeaders(
  providerId: string,
  region: QoderRegion,
  force: boolean,
): Promise<Record<string, string>> {
  const cred = await ensureCredential(force, providerId);
  const identity = deviceIdentity(providerId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": USER_AGENT,
    "X-Request-ID": randomUUID(),
    // The session id belongs to the account: a new one on every request would
    // look like a new session on every request.
    "X-Session-ID": identity?.sessionId ?? randomUUID(),
  };
  if (identity) {
    headers["Cosy-MachineId"] = identity.machineId;
    headers["Cosy-MachineToken"] = identity.machineToken;
    headers["Cosy-Machine-Type"] = identity.machineType;
    headers["Cosy-MachineCode"] = identity.machineCode;
  }
  return headers;
}

/**
 * One chat completion. Returns the upstream response as-is; the agent decides
 * whether to stream it through or read it whole. A 401 triggers exactly one
 * forced refresh and retry, the way the simulated client does.
 */
export async function qoderChatCompletion(
  body: Record<string, unknown>,
  opts: QoderRequestOptions,
): Promise<Response> {
  // The provider says which account; the account says which region.
  const providerId = opts.providerId ?? "qoder";
  const region = opts.region ?? regionOf(providerId);
  const url = ENDPOINTS[region].infer;

  const send = async (force: boolean) => {
    const headers = await upstreamHeaders(providerId, region, force);
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
    // The client sees the gateway's status; the upstream's own status says
    // that the credential was refused, not that the request was wrong.
    const error = new AuthError(
      `upstream rejected the credential (HTTP 401)`,
      `Qoder 拒绝了当前凭据。删掉 session 文件后重启服务即可重新登录。`,
      503,
    );
    throw withUpstreamStatus(error, 401);
  }
  if (r.status === 403 || r.status === 429) {
    // 403 is not a credential problem here: Qoder answers 403 with
    // RESOURCE_LIMIT when the model is queued, and 429 when every backend for
    // it is busy. Both are worth retrying.
    const text = await r.text().catch(() => "");
    const detail = parseLimitError(text);
    const error = new LimitError(
      `qoder model is queued (HTTP ${r.status})`,
      detail?.message ?? `Qoder 上游繁忙（HTTP ${r.status}）：${text.slice(0, 200)}`,
      detail?.retryAfterSec ?? 10,
    );
    throw withUpstreamStatus(error, r.status);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    // The client sees the gateway's status; the upstream's own status says
    // whether another account would do better (a 400 is the request's fault,
    // and every account would fail the same way).
    const error = new AuthError(
      `upstream HTTP ${r.status}`,
      `Qoder 上游返回 ${r.status}：${text.slice(0, 300)}`,
      502,
    );
    throw withUpstreamStatus(error, r.status);
  }
  return r;
}
