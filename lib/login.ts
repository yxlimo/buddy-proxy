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

import { hasSession as hasMinimaxSession, login as minimaxLogin } from "./minimax-oauth.ts";
import { hasSession as hasQoderSession, login as qoderLogin, type QoderRegion } from "./qoder-auth.ts";
import { hasSession as hasWorkBuddySession, login as workBuddyLogin } from "./workbuddy-auth.ts";

/** What happened: a session was already there, or one was made. */
export type LoginOutcome = "present" | "logged-in";

export async function ensureMinimaxSession(): Promise<LoginOutcome> {
  if (hasMinimaxSession()) return "present";
  await minimaxLogin();
  return "logged-in";
}

/**
 * Same for one Qoder region. The two regions are separate accounts with separate
 * sessions, so each is decided on its own.
 */
export async function ensureQoderSession(region: QoderRegion): Promise<LoginOutcome> {
  if (hasQoderSession(region)) return "present";
  await qoderLogin(region);
  return "logged-in";
}

/** The same for WorkBuddy's China region. */
export async function ensureWorkBuddySession(): Promise<LoginOutcome> {
  if (hasWorkBuddySession("cn")) return "present";
  await workBuddyLogin("cn");
  return "logged-in";
}
