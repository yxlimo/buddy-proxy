// lib/login.ts — the device flow, run by the server itself.
//
// The proxies own their credentials, so there is no separate "login program" to
// run and remember: the server looks for its credential at startup and, if it is
// missing, runs the device flow itself. It prints the URL to approve and keeps
// serving in the meantime, so the first request fails with a clear 503 rather
// than a hang.
//
// On demand, without restarting anything:
//
//   BUDDY_PROXY_MINIMAX_LOGIN=true      force a fresh MiniMax session
//   BUDDY_PROXY_QODER_LOGIN=global      force a fresh Qoder session, one region
//   BUDDY_PROXY_QODER_LOGIN=cn          ... the other region
//   BUDDY_PROXY_QODER_LOGIN=all         ... both
//   BUDDY_PROXY_QODER_LOGIN=off         never log in on startup
//
// The default is "auto": log in only where there is no session yet, so a normal
// start is silent. "force" replaces the stored session, which is what you want
// after the account itself was re-authorized somewhere else.

import { readEnvString } from "./env.ts";
import { hasSession as hasMinimaxSession, login as minimaxLogin } from "./minimax-oauth.ts";
import { hasSession as hasQoderSession, login as qoderLogin, type QoderRegion } from "./qoder-auth.ts";

export type LoginMode = "auto" | "force" | "off";

/** What happened: a session was already there, one was made, or logging in is off. */
export type LoginOutcome = "present" | "logged-in" | "skipped";

function parseMode(raw: string | undefined): LoginMode {
  const v = (raw ?? "auto").trim().toLowerCase();
  if (["off", "false", "no", "0"].includes(v)) return "off";
  if (["force", "true", "yes", "1"].includes(v)) return "force";
  return "auto";
}

export function minimaxLoginMode(): LoginMode {
  return parseMode(readEnvString("BUDDY_PROXY_MINIMAX_LOGIN", "auto"));
}

export interface QoderLoginPlan {
  mode: LoginMode;
  /** Regions to consider. In "auto" mode a region is only logged in if it has no session. */
  regions: QoderRegion[];
}

export function qoderLoginPlan(regions: QoderRegion[] = ["global", "cn"]): QoderLoginPlan {
  const raw = readEnvString("BUDDY_PROXY_QODER_LOGIN", "auto").trim().toLowerCase();
  if (["off", "false", "no", "0"].includes(raw)) return { mode: "off", regions: [] };
  if (raw === "all") return { mode: "force", regions };
  const named = regions.find((r) => r === raw);
  if (named) return { mode: "force", regions: [named] };
  return { mode: "auto", regions };
}

/**
 * Make sure there is a usable MiniMax session, logging in if the policy says so.
 * Returns what it did; the caller reports it.
 */
export async function ensureMinimaxSession(): Promise<LoginOutcome> {
  const mode = minimaxLoginMode();
  if (mode === "off") return "skipped";
  if (mode === "auto" && hasMinimaxSession()) return "present";
  await minimaxLogin();
  return "logged-in";
}

/**
 * Same for one Qoder region. The two regions are separate accounts with separate
 * sessions, so each is decided on its own.
 */
export async function ensureQoderSession(region: QoderRegion, mode: LoginMode): Promise<LoginOutcome> {
  if (mode === "off") return "skipped";
  if (mode === "auto" && hasQoderSession(region)) return "present";
  await qoderLogin(region);
  return "logged-in";
}
