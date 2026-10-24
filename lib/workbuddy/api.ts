// lib/workbuddy/api.ts — the WorkBuddy account's own API.
//
// The growth centre (the check-in, the Buddy trip, the tasks, the blind box)
// and the credit balance both live behind these endpoints, and both need the
// same identity headers.

import { configString } from "../config.ts";
import { accountHeaders, loadSession, type WorkBuddySession } from "./auth.ts";

/** The host the account's own API is on. */
export function workBuddyApiBase(providerId = "workbuddy-cn"): string {
  const override = configString("WORKBUDDY_CHAT_BASE", "").replace(/\/+$/, "");
  if (override) return override;
  const session = loadSession(providerId);
  const host = session?.domain || "www.workbuddy.cn";
  return `https://${host}`;
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
    const res = await fetch(`${workBuddyApiBase(providerId)}${path}`, {
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
