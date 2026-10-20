#!/usr/bin/env node
// minimax-proxy.ts — Anthropic-shaped reverse proxy in front of the MiniMax Code
// LLM gateway, on its own port (6448), independent from v2-proxy.ts.
//
// What makes the server treat this as a MiniMax Code client is the OAuth grant
// itself — client_id `mcode-public`, audience `agent-backend`, scope
// `agent.default` — not a header trick. The token read from the desktop app's
// store is already a MiniMax Code credential, so the proxy only has to present
// it. The attribution headers below mirror what the real client sends
// (packages/tui/src/runtime/public-gateway.ts) so a request is byte-for-byte a
// MiniMax Code request; they are wire-protocol constants, not credentials, and
// the gateway accepts requests without them.
//
// Credentials come from one of two sources, picked by MINIMAX_AUTH_MODE (lib/minimax-auth.ts):
//   oauth (default) — the proxy's own session in its data dir. It logs in once with
//     the same OAuth client the real client uses, then refreshes itself with the
//     refresh token. This is the only source that works inside a container, and the
//     only one allowed to refresh.
//   file — a read-only view of the MiniMax Code desktop app's store. It can never
//     refresh: the app tracks a `generation` and a foreign refresh would bump it and
//     log the app out. Access tokens live ~1 hour, so the app has to be opened often.
// Either way a stale credential answers 503 with a clear re-login hint, not a retry loop.
//
// Only the Anthropic dialect is exposed: the upstream is already Anthropic
// /v1/messages, so requests are forwarded verbatim (thinking, system, tools,
// streaming all pass through untouched).

import express from "express";
import crypto from "node:crypto";
import { authenticate, loadKeys, REQUIRE_API_KEY } from "./lib/api-keys.ts";
import { readEnvFlag, readEnvNumber, readEnvString } from "./lib/env.ts";
import { AUTH_MODE, AuthError, credentialStatus, readCredential } from "./lib/minimax-auth.ts";
import { hasSession, login } from "./lib/minimax-oauth.ts";
import { modelsPayload } from "./lib/minimax-models.ts";

const PORT = readEnvNumber("MINIMAX_PORT", 6448);
const REGION = readEnvString("MINIMAX_REGION", "cn");
const UA = readEnvString("MINIMAX_USER_AGENT", "MiniMaxCode");
const ANTHROPIC_VERSION = readEnvString("MINIMAX_ANTHROPIC_VERSION", "2023-06-01");
const ATTRIBUTION = readEnvFlag("MINIMAX_ATTRIBUTION_HEADERS", true);
// Wire-protocol constants copied from the client; changing them requires a
// coordinated server-side rollout.
const YY_SUFFIX = "ooui";
const SIGNATURE_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";

const BASE_URL = readEnvString(
  "MINIMAX_BASE_URL",
  REGION === "en" ? "https://agent.minimax.io/mavis/api/v1/llm/v1" : "https://agent.minimax.cn/mavis/api/v1/llm/v1",
);
const UPSTREAM = `${BASE_URL}/messages`;

// What to tell the operator when the credential is unusable. It depends on who owns the
// session: only the oauth source can be re-logged-in from the command line.
const RELOGIN_HINT = AUTH_MODE === "oauth"
  ? "会话被服务端拒绝。检查登录是否还有效：node scripts/minimax-login.ts --status，必要时重新登录。"
  : "MiniMax Code 的登录被服务端拒绝。打开桌面 App 重新登录，等它刷新后重试。";
// First start with no session runs the device flow in the background, so a container
// prints the authorization URL and the operator only has to click it.
const AUTO_LOGIN = readEnvFlag("MINIMAX_AUTO_LOGIN", true);
// Log the thinking / effort fields of every request — the only way to see what a
// client actually asked for, since the gateway does not echo them back.
const LOG_BODY = readEnvFlag("MINIMAX_LOG_BODY", false);
// Heartbeat interval for streaming responses. 0 disables the ping entirely.
// 15s keeps idle connections alive through local proxies without being chatty.
const PING_MS = readEnvNumber("MINIMAX_PING_MS", 15000);

const keys = loadKeys();
const app = express();
// The client's own cap is 64 MiB per request body.
app.use(express.json({ limit: "64mb" }));

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const upPath = new URL(UPSTREAM).pathname;

/** Headers exactly as the MiniMax Code client sends them. */
function upstreamHeaders(token: string, bodyText: string): Record<string, string> {
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

function errorBody(type: string, message: string, hint?: string) {
  const body: Record<string, unknown> = { type: "error", error: { type, message } };
  if (hint) body.hint = hint;
  return body;
}

/** Map a gateway business code to an Anthropic-ish error type. */
function classify(status: number, code?: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 400) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (code === 50110 || code === 2056) return "usage_limit_error"; // credits / plan exhausted
  if (status >= 500) return "api_error";
  return "api_error";
}

// Anthropic's canonical path is /v1/messages (the gateway path is
// /mavis/api/v1/llm/v1/messages). Clients that speak the Anthropic dialect
// append "/messages" to their base URL, so the base URL is expected to carry
// the "/v1" version segment: opencode and the Anthropic SDK use
// <base>/v1/messages, pi uses <base>/v1/messages as well.
app.post("/v1/messages", async (req: any, res: any) => {
  const who = authenticate(req, keys);
  if (!who) {
    return res.status(401).json(errorBody("authentication_error", "invalid api key"));
  }

  let cred;
  try {
    cred = await readCredential();
  } catch (e) {
    const err = e as AuthError;
    return res.status(err.status).json(errorBody("authentication_error", err.message, err.hint));
  }

  const bodyText = JSON.stringify(req.body ?? {});
  const stream = req.body?.stream === true;

  if (LOG_BODY) {
    console.log(
      `[REQ] ${req.path} model=${req.body?.model} thinking=${JSON.stringify(req.body?.thinking ?? null)} ` +
        `output_config=${JSON.stringify(req.body?.output_config ?? null)} stream=${stream}`,
    );
  }

  const send = (token: string) =>
    fetch(UPSTREAM, { method: "POST", headers: upstreamHeaders(token, bodyText), body: bodyText });

  let r = await send(cred.accessToken);

  // A 401 means the token we sent is not the one the server expects. In oauth mode we
  // own the session, so refresh once and retry; in file mode we only re-read, because
  // the desktop app owns that refresh. One attempt each, then give up.
  if (r.status === 401) {
    try {
      cred = await readCredential(true);
      r = await send(cred.accessToken);
    } catch (e) {
      const err = e as AuthError;
      return res.status(err.status).json(errorBody("authentication_error", err.message, err.hint));
    }
    if (r.status === 401) {
      return res
        .status(401)
        .json(errorBody("authentication_error", `access token rejected (generation ${cred.generation})`, RELOGIN_HINT));
    }
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const code = parsed?.base_resp?.status_code;
    const message = parsed?.error?.message || parsed?.error || parsed?.base_resp?.status_msg || text || "upstream error";
    return res.status(r.status).json(errorBody(classify(r.status, code), String(message)));
  }

  if (!stream) {
    const payload = await r.json();
    return res.json(payload);
  }

  // Streaming: pass the upstream SSE through verbatim.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const reader = r.body!.getReader();
  const startedAt = Date.now();
  let bytesOut = 0;

  // Heartbeat. Some hops in front of this proxy (a local HTTP proxy, a NAT
  // gateway) drop idle connections, and a long thinking pause can keep the
  // stream quiet for minutes. The upstream sends `event: ping` right after
  // message_start but then goes silent while the model thinks, so we emit our
  // own ping once the stream has been quiet for PING_MS. Anthropic's dialect
  // defines `ping` exactly for this, and clients ignore it.
  //
  // Two rules keep this safe:
  //   - only ping when the stream is actually idle, so a busy stream is not
  //     padded with useless events;
  //   - only ping on an SSE frame boundary, because writing one in the middle
  //     of an upstream frame would corrupt the client's parse.
  let tail = Buffer.alloc(0); // last bytes written, used to detect a frame boundary
  let lastActivity = Date.now();
  let pings = 0;
  const writePing = () => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastActivity < PING_MS) return; // upstream is still talking
    if (!/\r?\n\r?\n$/.test(tail.toString("latin1"))) return; // mid-frame: wait
    // Same payload the gateway itself sends, so clients see nothing unusual.
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
    lastActivity = Date.now();
    pings++;
  };
  const pingTimer = PING_MS > 0 ? setInterval(writePing, Math.min(PING_MS, 5000)) : null;
  pingTimer?.unref?.();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) break;
      res.write(value);
      bytesOut += value.length;
      lastActivity = Date.now();
      tail = Buffer.concat([tail, Buffer.from(value)]).slice(-4);
    }
    if (LOG_BODY) {
      console.log(
        `[RES] ${req.path} model=${req.body?.model} done ${Date.now() - startedAt}ms ` +
          `bytes=${bytesOut} pings=${pings}`,
      );
    }
  } catch (e) {
    const err = e as Error;
    // Log the outcome either way: an upstream stream that dies mid-flight is
    // the difference between "the gateway is flaky" and "a hop in front of us
    // dropped the connection", and only one of those is ours to fix.
    console.log(
      `[RES] ${req.path} model=${req.body?.model} FAILED after ${Date.now() - startedAt}ms ` +
        `bytes=${bytesOut} pings=${pings} aborted=${ac.signal.aborted} cause=${err.message}`,
    );
    if (!ac.signal.aborted) {
      if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify(errorBody("api_error", err.message))}\n\n`);
    }
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    if (!res.writableEnded) res.end();
  }
});

app.get("/v1/models", (req: any, res: any) => {
  const who = authenticate(req, keys);
  if (!who) return res.status(401).json(errorBody("authentication_error", "invalid api key"));
  res.json(modelsPayload());
});

app.get("/health", (_req: any, res: any) => {
  res.json({
    status: "ok",
    upstream: BASE_URL,
    dialect: "anthropic",
    attributionHeaders: ATTRIBUTION,
    models: modelsPayload().data.length,
    auth: REQUIRE_API_KEY ? "required" : "public",
    credential: credentialStatus(),
  });
});

app.listen(PORT, "0.0.0.0", async () => {
  const base = `http://127.0.0.1:${PORT}`;
  console.log("");
  console.log(`minimax-proxy listening on ${base}`);
  console.log(`  upstream:   ${UPSTREAM}`);
  console.log(`  credential: ${credentialStatus().source} [mode ${AUTH_MODE}]`);
  console.log("");
  console.log("  Endpoints:");
  console.log(`    Anthropic  ${base}/v1/messages`);
  console.log(`               ${base}/v1/models`);
  console.log(`    Health     ${base}/health`);
  console.log("");

  // Fail fast with an actionable message instead of waiting for the first request.
  if (AUTH_MODE === "oauth" && !hasSession()) {
    if (!AUTO_LOGIN) {
      console.warn("  [AUTH] no session yet.");
      console.warn(`         ${RELOGIN_HINT}`);
    } else {
      // Background, so the server still answers (503) while the browser approval lands.
      console.log("  [AUTH] no session yet — starting the device flow");
      login()
        .then((s) => console.log(`  [AUTH] logged in: generation ${s.generation}, expires in ${Math.round((s.expiresAtMs - Date.now()) / 60000)} min`))
        .catch((e) => console.warn(`  [AUTH] login failed: ${(e as AuthError).message}`));
    }
  } else {
    try {
      const c = await readCredential();
      console.log(
        `  token ok: generation ${c.generation}, expires in ${Math.round(c.remainingMs / 60000)} min`,
      );
    } catch (e) {
      const err = e as AuthError;
      console.warn(`  [AUTH] ${err.message}`);
      console.warn(`         ${err.hint}`);
    }
  }
  console.log("");
});

// Periodic watch, so the warning reaches the log even with no traffic. In oauth mode a
// tick only hits the network when the token is inside the refresh buffer; in file mode
// it re-reads the app's store, which is the only thing this layer can do there.
const WATCH_MS = readEnvNumber("MINIMAX_WATCH_MS", 5 * 60 * 1000);
let lastWatchState = "";
async function watchCredential() {
  try {
    const cred = await readCredential();
    const state = cred.warning ? "warning" : "ok";
    if (state !== lastWatchState) {
      lastWatchState = state;
      console.log(`[AUTH] ${state}: generation ${cred.generation}, ${Math.round(cred.remainingMs / 60000)} min left`);
    }
  } catch (e) {
    const err = e as AuthError;
    if (err.message !== lastWatchState) {
      lastWatchState = err.message;
      console.log(`[AUTH] ${err.message}`);
      console.log(`       ${err.hint}`);
    }
  }
}
setInterval(watchCredential, WATCH_MS).unref();
