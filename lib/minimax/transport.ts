// lib/minimax/transport.ts — the call to the MiniMax Code gateway.
//
// What makes the gateway treat a request as a MiniMax Code client is the
// OAuth grant itself — client_id `mcode-public`, audience `agent-backend`,
// scope `agent.default` — not a header trick. The token read from the
// desktop app's store is already a MiniMax Code credential, so the proxy only
// has to present it. The attribution headers below mirror what the simulated
// client sends (packages/tui/src/runtime/public-gateway.ts) so a request is
// byte-for-byte a MiniMax Code request; they are wire-protocol constants, not
// credentials, and the gateway accepts requests without them.
//
// The upstream speaks the Anthropic dialect natively: the request goes out as
// it is, and the answer comes back the same way.

import type { Json } from "../json.ts";
import { configString, configFlag, configNumber } from "../config.ts";
import crypto from "node:crypto";
import { AUTH_MODE, AuthError, readCredential } from "./auth.ts";

export const REGION = configString("MINIMAX_REGION", "cn");
const UA = configString("MINIMAX_USER_AGENT", "MiniMaxCode");
const ANTHROPIC_VERSION = configString("MINIMAX_ANTHROPIC_VERSION", "2023-06-01");
const ATTRIBUTION = configFlag("MINIMAX_ATTRIBUTION_HEADERS", true);
// Wire-protocol constants copied from the client; changing them requires a
// coordinated server-side rollout.
const YY_SUFFIX = "ooui";
const SIGNATURE_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";

export const BASE_URL = configString(
  "MINIMAX_BASE_URL",
  REGION === "en" ? "https://agent.minimax.io/mavis/api/v1/llm/v1" : "https://agent.minimax.cn/mavis/api/v1/llm/v1",
);
export const UPSTREAM = `${BASE_URL}/messages`;

/** The gateway's own address, for the health report. */
export const MINIMAX_UPSTREAM = UPSTREAM;

/** Heartbeat interval for streaming answers. 0 disables the ping entirely. */
export const PING_MS = configNumber("MINIMAX_PING_MS", 15000);

/** What to tell the operator when the credential is unusable. */
export const RELOGIN_HINT =
  AUTH_MODE === "oauth"
    ? "会话被服务端拒绝。删掉 data 目录里的 minimax-session.json 再重启，会自动重新登录。"
    : "MiniMax Code 的登录被服务端拒绝。打开桌面 App 重新登录，等它刷新后重试。";

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const upPath = new URL(UPSTREAM).pathname;

/** Headers exactly as the MiniMax Code client sends them. */
export function upstreamHeaders(token: string, bodyText: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
    Authorization: `Bearer ${token}`,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (ATTRIBUTION) {
    const nowMs = Date.now();
    const second = Math.floor(nowMs / 1000);
    h.yy = md5(`${encodeURIComponent(upPath)}_${bodyText}${md5(String(nowMs))}${YY_SUFFIX}`);
    h["x-timestamp"] = String(second);
    h["x-signature"] = md5(`${second}${SIGNATURE_SALT}${bodyText}`);
  }
  return h;
}

/** Map a gateway business code to an Anthropic-ish error type. */
export function classify(status: number, code?: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 400) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (code === 50110 || code === 2056) return "usage_limit_error"; // credits / plan exhausted
  if (status >= 500) return "api_error";
  return "api_error";
}

/**
 * Send a request to the gateway.
 *
 * A 401 means the token we sent is not the one the server expects. In oauth
 * mode we own the session, so refresh once and retry; in file mode we only
 * re-read, because the desktop app owns that refresh. One attempt each, then
 * give up.
 */
export async function minimaxChat(
  body: Json,
): Promise<Response> {
  let cred;
  try {
    cred = await readCredential();
  } catch (e) {
    throw e as AuthError;
  }

  const bodyText = JSON.stringify(body);
  const send = (token: string) =>
    fetch(UPSTREAM, { method: "POST", headers: upstreamHeaders(token, bodyText), body: bodyText });

  let r = await send(cred.accessToken);

  if (r.status === 401) {
    try {
      cred = await readCredential(true);
      r = await send(cred.accessToken);
    } catch (e) {
      throw e as AuthError;
    }
    if (r.status === 401) {
      throw new AuthError(
        `access token rejected (generation ${cred.generation})`,
        RELOGIN_HINT,
        401,
      );
    }
  }

  return r;
}

/** The message the gateway put in an error body, in its own words. */
export function gatewayErrorMessage(status: number, body: any, text: string): { type: string; message: string } {
  const code = body?.base_resp?.status_code;
  const message =
    body?.error?.message ||
    body?.error ||
    body?.base_resp?.status_msg ||
    text ||
    "upstream error";
  return { type: classify(status, code), message: String(message) };
}
