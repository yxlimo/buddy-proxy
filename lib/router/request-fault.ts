// lib/router/request-fault.ts — is the request itself what the upstream refused?
//
// The root route tries the next target when one fails. For most failures that
// is right: the account is out of credit, the upstream is down. But when the
// upstream says the request itself is malformed (400) or cannot be processed
// (422), the next target gets the same request — and the client waits for
// every one of them to say no.
//
// 413 (too large) is not on that list: "the context is too long" for this
// target may fit a later target with a larger window, so it moves on.
//
// The line is drawn narrowly. A 400 that is about the model ("no such model",
// "the model is not in this key's group", a limit the model does not allow)
// depends on the target: another target serves another model, so those still
// move on, the way they always have.

import { businessCodeOf, upstreamStatusOf } from "../upstream-status.ts";
import { classifyUpstreamError } from "./provider-selection.ts";

/** The upstream statuses that mean "this request is wrong", whoever serves it. */
const REQUEST_STATUSES = new Set([400, 422]);

/** Business codes that are about the model, not the request. */
const MODEL_CODES = new Set<number | string>([
  2022,
  "model_not_available",
  "invalid_model_error",
  "model_group_access_denied",
  "not_found",
]);

/**
 * Whether the upstream refused the request itself, so another target would
 * refuse it too.
 *
 * Only the upstream's own status counts (`upstreamStatus`, put there by the
 * transport): the gateway's 400s ("this platform has no such model") are about
 * the target.
 */
export function isRequestFault(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const said = (error as { upstreamStatus?: unknown }).upstreamStatus;
  if (typeof said !== "number" || !REQUEST_STATUSES.has(said)) return false;
  if (upstreamStatusOf(error) !== said) return false;
  if (classifyUpstreamError(error).kind !== "request") return false;
  const code = businessCodeOf(error);
  if (code !== null && MODEL_CODES.has(typeof code === "string" ? code.toLowerCase() : code)) return false;
  // The upstream's own words: a refusal that names the model is about the
  // model this target serves.
  const err = error as { message?: unknown; hint?: unknown };
  const text = `${String(err.message ?? "")} ${String(err.hint ?? "")}`.toLowerCase();
  return !text.includes("model") && !text.includes("模型");
}
