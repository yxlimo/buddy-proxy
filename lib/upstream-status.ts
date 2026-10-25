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
