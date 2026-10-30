// lib/workbuddy/api.ts — the WorkBuddy account's own API.
//
// The growth centre (the check-in, the Buddy trip, the tasks, the blind box)
// and the credit balance both live behind these endpoints, and both need the
// same identity headers.

import { configString } from "../config.ts";
import { accountHeaders, loadSession, regionOf, type WorkBuddySession } from "./auth.ts";

/** The host the account's own API is on, and the account's own domain. */
function apiBase(providerId: string): { base: string; accountHost: string | null } {
  const override = configString("WORKBUDDY_CHAT_BASE", "").replace(/\/+$/, "");
  const session = loadSession(providerId);
  // The account's own domain decides; without one, the region's host does.
  const host = session?.domain || (regionOf(providerId) === "global" ? "www.workbuddy.ai" : "www.workbuddy.cn");
  // With the override the mock server stands in for the account's API, so its
  // host is not the account's domain by design.
  return { base: override || `https://${host}`, accountHost: override ? null : host };
}

/** The host the account's own API is on. */
export function workBuddyApiBase(providerId = "workbuddy-cn"): string {
  return apiBase(providerId).base;
}

/** Providers already warned about a domain mismatch: say it once, not once per request. */
const warnedMismatch = new Set<string>();

/** The host of a base url, without the scheme. */
function hostOf(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
}

/**
 * Say when the session's own domain is not the domain the provider talks to.
 *
 * A missing providerId shows up as a 401 — the token of one region is not
 * accepted by the other region's host — so the miss is worth a line in the log.
 */
function warnOnDomainMismatch(session: WorkBuddySession, providerId: string, accountHost: string | null): void {
  if (!accountHost) return;
  const sessionHost = hostOf(session.domain);
  if (!sessionHost) return;
  if (sessionHost !== hostOf(accountHost)) {
    if (warnedMismatch.has(providerId)) return;
    warnedMismatch.add(providerId);
    console.warn(`[workbuddy] 会话域名 ${sessionHost} 与 ${providerId} 的 API 域名 ${hostOf(accountHost)} 不一致`);
  }
}

export interface ApiResult {
  status: number;
  body: any;
}

/** The payload of a successful answer — the API wraps it in `data`. */
export function dataOf(body: any): any {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

function workbuddyHeaders(session: WorkBuddySession): Record<string, string> {
  return { ...accountHeaders(session), "User-Agent": "WorkBuddy" };
}

/** The growth centre of the account's own API. */
export const GROWTH = "/v2/activity/growth";

/** Call the account's API. The path is the whole path, the growth centre included. */
export async function workbuddyApi(
  session: WorkBuddySession,
  path: string,
  method: "GET" | "POST",
  payload?: unknown,
  providerId = "workbuddy-cn",
): Promise<ApiResult> {
  try {
    const { base, accountHost } = apiBase(providerId);
    warnOnDomainMismatch(session, providerId, accountHost);
    const res = await fetch(`${base}${path}`, {
      method,
      headers: workbuddyHeaders(session),
      body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { msg: (e as Error).message } };
  }
}

/** A token the server checks for replay. */
export function clientToken(): string {
  return `u-${crypto.randomUUID()}`;
}
