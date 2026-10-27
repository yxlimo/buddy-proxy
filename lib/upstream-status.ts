// lib/upstream-status.ts — what the upstream itself said.
//
// The gateway wraps an upstream's failure in its own error, and the wrapper's
// status is what the client sees. The upstream's own answer is what the
// router needs: the status says whether the request was wrong, and the
// platform's own code says which account cannot serve it.
//
// The transports keep those two on the error, so the routing layer can tell
// "this account is out of credit" from "this request is wrong" without
// knowing anything about the platform's error table.

/** An error that carries the status the upstream sent. */
export interface UpstreamStatus {
  /** The status the upstream sent (or the one that means the same). */
  upstreamStatus?: number;
}

/** An error that carries the platform's own code. */
export interface UpstreamBusinessCode {
  /** The platform's code: a number (MiniMax) or a word (Discovery). */
  businessCode?: number | string;
}

/**
 * An error that carries the moment the account is free again.
 *
 * The upstream says it in two ways: a `retry-after` header, or a time in the
 * body ("您的限额将在 2026-10-30 07:55:44 重置"). The transport puts the moment
 * on the error, so the routing layer does not have to know how each platform
 * says it.
 */
export interface UpstreamCooldown {
  /** The moment the account may serve a request again (ms since the epoch). */
  cooldownUntil?: number;
}

/** Keep the upstream's own status on an error. */
export function withUpstreamStatus<T extends object>(error: T, status: number): T {
  (error as T & UpstreamStatus).upstreamStatus = status;
  return error;
}

/** Keep the platform's own code on an error. */
export function withBusinessCode<T extends object>(error: T, code: number | string): T {
  (error as T & UpstreamBusinessCode).businessCode = code;
  return error;
}

/** The status the upstream sent, if the error carries one. */
export function upstreamStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const err = error as UpstreamStatus & { status?: unknown };
  for (const value of [err.upstreamStatus, err.status]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The platform's own code, if the error carries one. */
export function businessCodeOf(error: unknown): number | string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as UpstreamBusinessCode & { code?: unknown };
  const value = err.businessCode ?? err.code;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Keep the moment the account is free again on an error. */
export function withCooldownUntil<T extends object>(error: T, untilMs: number): T {
  (error as T & UpstreamCooldown).cooldownUntil = untilMs;
  return error;
}

/** The moment the account is free again, if the error carries one. */
export function cooldownUntilOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as UpstreamCooldown).cooldownUntil;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How long the upstream says to wait, in milliseconds.
 *
 * `retry-after` is either a number of seconds or an HTTP date. Both are read.
 * `null` means the upstream did not say.
 */
export function retryAfterMs(response: Response): number | null {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}
