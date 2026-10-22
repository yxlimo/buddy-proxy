// lib/workbuddy/auth.ts — the proxy's own WorkBuddy session (China region).
//
// WorkBuddy signs in through a browser. The client asks the server for a
// state, sends the user to a login page, and then polls for the token; the
// state lives on the server, so the proxy only has to keep it and ask again.
// The answer is a JWT — the account id is its `sub` claim.
//
// The session is ours alone (the desktop app keeps its own, encrypted), so
// refreshing is unambiguous. The refresh token rotates on every refresh, so
// the file must survive restarts.
//
// Only the China region is implemented. The endpoints are configurable because
// the region moved host once already: the desktop client talks to
// www.workbuddy.cn, the older gateway was copilot.tencent.com, and the
// account's own domain decides which one answers for it.

import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readEnvNumber, readEnvString } from "../env.ts";
import { AuthError, authLog, tokenFingerprint } from "../credential.ts";
import type { Credential } from "../credential.ts";
import { deriveDeviceIdentity, deviceSalt } from "../device-identity.ts";
import {
  dataDirFor,
  ensureCredential as ensureCredentialShared,
  readSession,
  toCredential as credentialFromSession,
  writeSession,
  type CredentialCache,
} from "../session.ts";

export type WorkBuddyRegion = "cn";

export interface WorkBuddyEndpoints {
  /** Where the user approves in a browser, and where the token comes from. */
  base: string;
  /** Origin of the web console, sent as Origin / Referer on the auth calls. */
  origin: string;
}

export const ENDPOINTS: Record<WorkBuddyRegion, WorkBuddyEndpoints> = {
  cn: {
    base: readEnvString("WORKBUDDY_CN_BASE", "https://www.workbuddy.cn").replace(/\/+$/, ""),
    origin: readEnvString("WORKBUDDY_CN_ORIGIN", "https://www.codebuddy.cn").replace(/\/+$/, ""),
  },
};

/** The API the desktop client and the CLI use. */
export const AUTH_STATE_PATH = "/v2/plugin/auth/state";
export const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
export const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
export const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
export const CONFIG_PATH = "/v3/config";

/** The server answers this while the user has not approved yet. */
const LOGIN_PENDING = 11217;

/** The client version the identity headers claim to be. */
const DESKTOP_VERSION_CN = "5.5.6";
const CLI_VERSION = "2.168.2";

const REFRESH_BUFFER_MS = readEnvNumber("WORKBUDDY_REFRESH_BUFFER_MS", 24 * 3600 * 1000);
const WARN_MS = readEnvNumber("WORKBUDDY_AUTH_WARN_MS", 7 * 24 * 3600 * 1000);
const CACHE_MS = readEnvNumber("WORKBUDDY_AUTH_CACHE_MS", 5000);
const POLL_INTERVAL_MS = readEnvNumber("WORKBUDDY_LOGIN_POLL_MS", 3000);
const LOGIN_TIMEOUT_MS = readEnvNumber("WORKBUDDY_LOGIN_TIMEOUT_MS", 10 * 60 * 1000);

export interface WorkBuddySession {
  accessToken: string;
  refreshToken: string;
  /** Account id: the `sub` claim of the access token. */
  uid: string;
  nickname: string;
  /** The domain this account belongs to; also the host we talk to. */
  domain: string;
  region: WorkBuddyRegion;
  generation: number;
  expiresAtMs: number;
  refreshExpiresAtMs: number;
  loginAtMs: number;
  refreshedAtMs: number;
}

export function dataDir(): string {
  return dataDirFor("WORKBUDDY_DATA_DIR", ".workbuddy-proxy");
}

export function sessionPath(region: WorkBuddyRegion = "cn"): string {
  const explicit = readEnvString("WORKBUDDY_CREDENTIAL_FILE", "");
  if (explicit) return explicit;
  return path.join(dataDir(), `workbuddy-session.${region}.json`);
}

function loginHint(region: WorkBuddyRegion = "cn"): string {
  return (
    `还没有登录 WorkBuddy（${region} 区域）。服务启动时会自己发起登录（把授权链接点一下就行），` +
    `也可以删掉 ${sessionPath(region)} 后重启服务。` +
    `凭据之后自动刷新。`
  );
}

export function loadSession(region: WorkBuddyRegion = "cn"): WorkBuddySession | null {
  return readSession<WorkBuddySession>(sessionPath(region));
}

export function hasSession(region: WorkBuddyRegion = "cn"): boolean {
  return loadSession(region) !== null;
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function saveSession(session: WorkBuddySession): void {
  writeSession(sessionPath(session.region), session);
}

/** The `sub` claim of a JWT, without verifying the signature. */
export function jwtUid(token: string): string {
  try {
    const segment = token.split(".")[1];
    if (!segment) return "";
    const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return String(JSON.parse(json).sub ?? "");
  } catch {
    return "";
  }
}

function jwtExp(token: string): number {
  try {
    const segment = token.split(".")[1];
    if (!segment) return 0;
    const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return Math.floor(Number(JSON.parse(json).exp ?? 0) * 1000);
  } catch {
    return 0;
  }
}

/** Upstream timestamps are seconds or milliseconds; normalise to milliseconds. */
function normalizeEpoch(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e11 ? Math.floor(n) : Math.floor(n * 1000);
}

interface JsonResponse {
  status: number;
  body: any;
}

async function requestJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** The browser-ish headers the auth endpoints expect. */
function authHeaders(base: WorkBuddyEndpoints): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": `WorkBuddy/${DESKTOP_VERSION_CN}`,
    Origin: base.origin,
    Referer: `${base.origin}/`,
  };
}

/**
 * Run the browser login: ask for a state, print the URL, and poll until the
 * user has approved.
 */
export async function login(region: WorkBuddyRegion = "cn"): Promise<WorkBuddySession> {
  const base = ENDPOINTS[region];

  const start = await requestJson(`${base.base}${AUTH_STATE_PATH}?platform=CLI`, {
    method: "POST",
    headers: authHeaders(base),
    body: "{}",
  });
  const state = start.body?.data?.state;
  const authUrl = start.body?.data?.authUrl;
  if (start.status !== 200 || !state || !authUrl) {
    throw new AuthError(
      `login start failed (HTTP ${start.status})`,
      `WorkBuddy 没有返回登录链接：${JSON.stringify(start.body).slice(0, 200)}`,
      502,
    );
  }

  console.log("");
  console.log(`  region: ${region}  base: ${base.base}`);
  console.log(`  open in a browser: ${authUrl}`);
  console.log(`  (waiting for approval, up to ${Math.round(LOGIN_TIMEOUT_MS / 60000)} min)`);
  console.log("");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let token = "";
  let refreshToken = "";
  let domain = base.base.replace(/^https?:\/\//, "");
  let expiresAt = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await requestJson(`${base.base}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`, {
      method: "GET",
      headers: authHeaders(base),
    });
    const code = poll.body?.code;
    if (code === LOGIN_PENDING) continue;
    if (code !== 0) {
      throw new AuthError(
        `login failed (code ${code})`,
        `WorkBuddy 拒绝了登录：${poll.body?.msg ?? ""}`,
        502,
      );
    }
    const data = poll.body?.data ?? {};
    if (!data.accessToken) continue;
    token = String(data.accessToken);
    refreshToken = String(data.refreshToken ?? "");
    expiresAt = normalizeEpoch(data.expiresAt);
    if (data.domain) domain = String(data.domain);
    break;
  }
  if (!token) {
    throw new AuthError("login timed out", "登录窗口过期了，重启服务再试一次。", 504);
  }

  const uid = jwtUid(token);
  let nickname = "";
  try {
    const profile = await requestJson(
      `${base.base}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`,
      { method: "GET", headers: { ...authHeaders(base), Authorization: `Bearer ${token}` } },
    );
    nickname = String(profile.body?.data?.nickname ?? "");
  } catch {
    /* the profile is a nicety, not a requirement */
  }

  const now = Date.now();
  const session: WorkBuddySession = {
    accessToken: token,
    refreshToken,
    uid,
    nickname: nickname || uid.slice(0, 8),
    domain,
    region,
    generation: 1,
    expiresAtMs: expiresAt || jwtExp(token) || now + 3600 * 1000,
    refreshExpiresAtMs: now + 30 * 24 * 3600 * 1000,
    loginAtMs: now,
    refreshedAtMs: now,
  };
  saveSession(session);
  console.log(
    `  logged in: ${session.nickname}, token good for ${Math.round(session.expiresAtMs / 1000 - now / 1000)}s`,
  );
  console.log(`  saved to ${sessionPath(region)} (0600)`);
  authLog(
    dataDir(),
    `workbuddy ${region} login ok`,
    `generation ${session.generation}, access ${tokenFingerprint(session.accessToken)}, ` +
      `refresh ${tokenFingerprint(session.refreshToken)}, ` +
      `${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s left`,
  );
  console.log("  later refreshes are automatic — nothing else to do.");
  return session;
}

/** Refresh the session when it is close to expiry, or when the token was rejected. */
export async function refreshSession(
  force = false,
  region: WorkBuddyRegion = "cn",
): Promise<WorkBuddySession> {
  const session = loadSession(region);
  if (!session) throw new AuthError("no session", loginHint(region), 503);
  if (!force && session.expiresAtMs - Date.now() > REFRESH_BUFFER_MS) return session;

  const base = ENDPOINTS[region];
  const res = await requestJson(`${base.base}${REFRESH_PATH}`, {
    method: "POST",
    headers: {
      ...authHeaders(base),
      "X-Refresh-Token": session.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      "X-User-Id": session.uid,
      "X-Domain": session.domain,
      "X-CodeBuddy-Request": "1",
      "Accept-Language": "zh-CN",
    },
    body: "{}",
  });
  if (res.status !== 200) {
    const code = res.body?.code ?? res.body?.msg ?? `HTTP ${res.status}`;
    authLog(dataDir(), `workbuddy ${region} refresh rejected`, `${code} (HTTP ${res.status}), body ${JSON.stringify(res.body).slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(
        `refresh rejected (${code})`,
        `WorkBuddy 拒绝了刷新（${code}）。刷新时 token 会轮换，一份 session 同一时间只能有一个` +
          `持有者去刷新：如果你在别处（NAS、另一台机器）也跑着一份，那边刷新过之后这份就失效了。` +
          `把当前那份复制过去，或者删掉 ${sessionPath(region)} 后重启，服务会重新登录。`,
        503,
      );
    }
    throw new AuthError(`refresh failed (${code})`, `WorkBuddy 刷新失败（${code}），稍后重试。`, 502);
  }
  const data = res.body?.data?.data ?? res.body?.data ?? {};
  const token = String(data.accessToken ?? "");
  if (!token) {
    throw new AuthError(
      "refresh returned no token",
      `WorkBuddy 刷新没有返回 token：${JSON.stringify(res.body).slice(0, 200)}`,
      503,
    );
  }

  const now = Date.now();
  const next: WorkBuddySession = {
    ...session,
    accessToken: token,
    refreshToken: String(data.refreshToken ?? session.refreshToken),
    generation: session.generation + 1,
    expiresAtMs: jwtExp(token) || session.expiresAtMs,
    refreshExpiresAtMs: normalizeEpoch(data.refreshExpiresAt) || session.refreshExpiresAtMs,
    refreshedAtMs: now,
  };
  saveSession(next);
  cache = null;
  authLog(
    dataDir(),
    `workbuddy ${region} refresh ok`,
    `generation ${next.generation}, access ${tokenFingerprint(next.accessToken)}, ` +
      `refresh ${tokenFingerprint(next.refreshToken)}, ` +
      `${Math.round(next.expiresAtMs / 1000 - now / 1000)}s left`,
  );
  return next;
}

let cache: CredentialCache | null = null;

function toCredential(session: WorkBuddySession): Credential {
  return credentialFromSession(session, {
    source: sessionPath(session.region),
    owner: "oauth",
    warnMs: WARN_MS,
    clientId: "workbuddy-cli",
    audience: "workbuddy",
    region: session.region,
  });
}

/** Credential for the proxy. `force` means the token we sent was rejected. */
export async function ensureCredential(
  force = false,
  region: WorkBuddyRegion = "cn",
): Promise<Credential> {
  return ensureCredentialShared({
    cache,
    setCache: (next) => {
      cache = next;
    },
    key: region,
    cacheMs: CACHE_MS,
    force,
    lockFile: sessionPath(region),
    load: () => loadSession(region),
    refresh: (f) => refreshSession(f, region),
    toCredential,
    expired: (session) =>
      new AuthError(
        `access token expired (generation ${session.generation})`,
        `WorkBuddy token 已过期且刷新没成功。删掉 ${sessionPath(region)} 后重启服务即可重新登录。`,
        503,
      ),
  });
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function workbuddyStatus(region: WorkBuddyRegion = "cn"): Record<string, unknown> {
  const session = loadSession(region);
  if (!session) {
    return { region, source: sessionPath(region), status: "anonymous", error: "no session", hint: loginHint(region) };
  }
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    region,
    source: sessionPath(region),
    status: remainingMs > 0 ? "authenticated" : "expired",
    uid: session.uid,
    nickname: session.nickname,
    domain: session.domain,
    generation: session.generation,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    remainingSec: Math.round(remainingMs / 1000),
    warning: remainingMs < WARN_MS,
    refreshBufferSec: Math.round(REFRESH_BUFFER_MS / 1000),
    loginAt: new Date(session.loginAtMs).toISOString(),
    lastRefreshAt: new Date(session.refreshedAtMs).toISOString(),
  };
}

/**
 * The identity headers a chat request carries. They describe the official CLI:
 * the account, the conversation, and a trace.
 */
/**
 * The device id the official client sends.
 *
 * It is the account's own fingerprint, so two accounts never look like they
 * sit on one machine.
 */
export function workbuddyDeviceId(session: WorkBuddySession): string | undefined {
  if (!session.uid) return undefined;
  return deriveDeviceIdentity(session.uid, deviceSalt(dataDir())).machineId;
}

/**
 * The headers every call to the account's API carries.
 *
 * The chat call adds the agent, IDE and trace headers on top of these; the
 * growth centre does not need them, but it needs the same identity.
 */
export function accountHeaders(session: WorkBuddySession): Record<string, string> {
  const deviceId = workbuddyDeviceId(session);
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    "X-User-Id": session.uid || "anonymous",
    "X-Domain": session.domain,
    ...(deviceId ? { "X-Device-Id": deviceId } : {}),
  };
}

export function chatHeaders(
  session: WorkBuddySession,
  opts: { conversationId?: string; turnRequestId?: string } = {},
): Record<string, string> {
  const trace = randomUUID().replace(/-/g, "");
  const span = randomBytes(8).toString("hex");
  const messageId = randomUUID().replace(/-/g, "");
  const conversationId = opts.conversationId ?? randomUUID();
  const turnRequestId = opts.turnRequestId ?? randomUUID().replace(/-/g, "");
  const headers: Record<string, string> = {
    ...accountHeaders(session),
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Runtime": "other",
    "X-Agent-Type": "main",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CLI_VERSION,
    "X-Product": "SaaS",
    "User-Agent": `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": turnRequestId,
    "X-Root-Request-ID": turnRequestId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": messageId,
    "X-Private-Data": "false",
    // The OpenAI Node SDK fingerprint the official CLI carries.
    "x-stainless-lang": "js",
    "x-stainless-package-version": "6.25.0",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : "Linux",
    "x-stainless-arch": process.arch === "x64" ? "x64" : process.arch,
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": `v${process.versions.node}`,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "1200",
    // The trace family.
    "X-Trace-ID": trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${randomBytes(8).toString("hex")}`,
    "X-B3-TraceId": trace,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
    "X-B3-ParentSpanId": randomBytes(8).toString("hex"),
  };
  return headers;
}

/** The chat endpoint of the account's own domain. */
export function chatBase(session: WorkBuddySession): string {
  // The override is what the mock server is reached through; without it the
  // account's own domain is used.
  const override = readEnvString("WORKBUDDY_CHAT_BASE", "").replace(/\/+$/, "");
  if (override) return override;
  const host = session.domain || ENDPOINTS[session.region].base.replace(/^https?:\/\//, "");
  return `https://${host}`;
}
