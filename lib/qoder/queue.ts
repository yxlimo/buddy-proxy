// lib/qoder/queue.ts — the upstream's "this model is queued" answer, as an error.
//
// A request for a model that has no slot yet does not fail: Qoder parks it and
// says how long to come back after. The answer has the same shape whichever way
// it arrives — a plain HTTP 403/429, or an error frame inside a 200 stream — and
// the sentence that matters is nested one JSON string deep, so it has to be
// unwrapped twice.
//
// Parsing it lives here, once, because two callers need the same reading: the
// frame-level wait (lib/router/upstreams/qoder.ts) decides from the same numbers
// how long to wait.
//
// What the router *does* with a queued answer is decided elsewhere: `QueuedError`
// only says "the upstream parked this model". The classification treats it as a
// failure that another target can serve (see lib/router/provider-selection.ts),
// and the account is not blamed for it (see lib/router/account-cooldown.ts).

import { AuthError } from "../credential.ts";
import { withGatewayOwnStatus } from "../upstream-status.ts";

/**
 * The upstream says a model is queued with
 *   403 {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
 * and that nested message is a JSON string, so it has to be unwrapped twice.
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

/**
 * The upstream queued the model and waiting it out did not help.
 *
 * It is not a failure of the account: the account is fine, the model has no
 * slot on this upstream. Another target may well have one, so this is a
 * failure the router moves on from — and one it does not blame the account
 * for (an account put aside would take its *other* models down with it, and
 * those were never queued).
 *
 * The client sees the gateway's own answer, built from `hint`: 429, because
 * what the caller should do is come back later, not change the request. That
 * 429 is marked as the gateway's own (see withGatewayOwnStatus), so nothing
 * downstream mistakes it for something the upstream said.
 */
export class QueuedError extends AuthError {
  /** The seconds the upstream asked for, as it gave them (clamped by the caller). */
  retryAfterSec: number;

  constructor(message: string, hint: string, retryAfterSec = 60) {
    // 429 is the status that tells a client to come back later; the type says
    // what the rest of the gateway calls a 429 (see answerTypeOf in
    // lib/router/upstreams/policy.ts).
    super(message, hint, 429, "rate_limit_error");
    this.name = "QueuedError";
    this.retryAfterSec = retryAfterSec;
    // 这个 429 是网关替客户端说的，不是上游回过的话：排队那句话是在 200 的流
    // 里说的。不标清楚的话，重试用尽那条路会把它当成「上游说过 429」，把客户端
    // 那句「等到它给的时间再试，仍在排队」重建成「上游返回 429。」（见
    // lib/upstream-status.ts 的 withGatewayOwnStatus）。
    withGatewayOwnStatus(this);
  }
}
