// lib/login.ts — the device flow, run by the server itself.
//
// The proxies own their credentials, so there is no separate "login program" to
// run and remember: a server whose upstream is enabled looks for its credential
// at startup and, if it is missing, runs the device flow itself. It prints the
// URL to approve and keeps serving in the meantime, so the first request fails
// with a clear 503 rather than a hang.
//
// Whether an upstream is enabled is decided elsewhere — see the enable flags in
// the server entry points. An upstream that is off is not looked at at all: no
// credential read, no login, no models advertised.
//
// Re-logging in means removing the session file; the next start picks it up.

import { hasSession as hasMinimaxSession, login as minimaxLogin } from "./minimax/oauth.ts";
import { hasSession as hasQoderSession, login as qoderLogin } from "./qoder/auth.ts";
import { hasSession as hasWorkBuddySession, login as workBuddyLogin } from "./workbuddy/auth.ts";
import { listProviders } from "./providers.ts";

/** What happened: a session was already there, or one was made. */
export type LoginOutcome = "present" | "logged-in";

export async function ensureMinimaxSession(providerId = "minimax"): Promise<LoginOutcome> {
  if (hasMinimaxSession(providerId)) return "present";
  await minimaxLogin(providerId);
  return "logged-in";
}

/**
 * The same for one Qoder provider.
 *
 * The regions are separate accounts with separate sessions, so each provider
 * is decided on its own.
 */
export async function ensureQoderSession(providerId = "qoder"): Promise<LoginOutcome> {
  if (hasQoderSession(providerId)) return "present";
  await qoderLogin(providerId);
  return "logged-in";
}

/** The same for WorkBuddy. */
export async function ensureWorkBuddySession(providerId = "workbuddy-cn"): Promise<LoginOutcome> {
  if (hasWorkBuddySession(providerId)) return "present";
  await workBuddyLogin(providerId);
  return "logged-in";
}

/**
 * Every provider that is on and has no credential yet.
 *
 * The provider table says which ones there are; this only says which of them
 * still need a login.
 */
export function providersNeedingLogin(kind: string): string[] {
  return listProviders()
    .filter((row) => row.enabled && row.kind === kind)
    .map((row) => row.id);
}
