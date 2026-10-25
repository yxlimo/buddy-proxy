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

import { configString, configNumber } from "../config.ts";
import { cliFetch } from "../http.ts";
import { randomBytes } from "node:crypto";
import { uuidv7, uuidv7Hex } from "../ids.ts";
import { AuthError, authLog, tokenFingerprint } from "../credential.ts";
import type { Credential } from "../credential.ts";
import { deriveDeviceIdentity, deviceSalt } from "../device-identity.ts";
import { clearHint, ensureCredential as ensureCredentialShared, hasTokens, legacyPaths, deadSession, markSessionDead, readSession, toCredential as credentialFromSession, type CredentialCache, writeSession } from "../session.ts";
import { dataDir as sharedDataDir } from "../paths.ts";
import { getSecret } from "../store.ts";
import { provider, providerSecretId } from "../providers.ts";

export type WorkBuddyRegion = "cn";

export interface WorkBuddyEndpoints {
  /** Where the user approves in a browser, and where the token comes from. */
  base: string;
  /** Origin of the web console, sent as Origin / Referer on the auth calls. */
  origin: string;
}

export const ENDPOINTS: Record<WorkBuddyRegion, WorkBuddyEndpoints> = {
  cn: {
    base: configString("WORKBUDDY_CN_BASE", "https://www.workbuddy.cn").replace(/\/+$/, ""),
    origin: configString("WORKBUDDY_CN_ORIGIN", "https://www.codebuddy.cn").replace(/\/+$/, ""),
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

/**
 * The platform the auth endpoints are asked about.
 *
 * The official client asks for `workbuddy` — that is what its product
 * configuration says — even though it is the CLI talking.
 */
const AUTH_PLATFORM = configString("WORKBUDDY_AUTH_PLATFORM", "workbuddy");

/**
 * The version the identity headers claim to be.
 *
 * The identity is the command line client's, so the version is the client's
 * own — the version of the `@tencent-ai/codebuddy-code` package, not the
 * version of the desktop app that ships it. A request the simulated client
 * made carried `CLI/2.161.0 WorkBuddy/2.161.0` and `X-IDE-Version: 2.161.0`.
 */
const CLI_VERSION = configString("WORKBUDDY_CLI_VERSION", "2.161.0");
/** The version of the desktop app, for the calls that carry it. */
const DESKTOP_VERSION_CN = configString("WORKBUDDY_VERSION", "5.8.3");

const REFRESH_BUFFER_MS = configNumber("WORKBUDDY_REFRESH_BUFFER_MS", 24 * 3600 * 1000);
const WARN_MS = configNumber("WORKBUDDY_AUTH_WARN_MS", 7 * 24 * 3600 * 1000);
const CACHE_MS = configNumber("WORKBUDDY_AUTH_CACHE_MS", 5000);
const POLL_INTERVAL_MS = configNumber("WORKBUDDY_LOGIN_POLL_MS", 3000);
const LOGIN_TIMEOUT_MS = configNumber("WORKBUDDY_LOGIN_TIMEOUT_MS", 10 * 60 * 1000);

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
  return sharedDataDir();
}

/**
 * Where the session lives in the database.
 *
 * The session belongs to the provider, not to the region: two WorkBuddy
 * accounts are two providers, each with its own session.
 */
export function sessionId(providerId = "workbuddy-cn"): string {
  return providerSecretId(providerId);
}

/** Where the session used to live, while the migration is under way. */
export function legacySessionPath(region: WorkBuddyRegion = "cn"): string[] {
  return legacyPaths(`workbuddy-session.${region}.json`);
}

/** The session used to live here, one id per region. */
function legacySessionId(region: WorkBuddyRegion): string {
  return `session:workbuddy:${region}`;
}

/**
 * Which region a provider talks to.
 *
 * The region picks the endpoints; the provider id picks the credential. Only
 * the China region is implemented, so the row has nothing to choose from yet —
 * but the region is read from the row, so a second one only has to be added
 * here.
 */
export function regionOf(providerId = "workbuddy-cn"): WorkBuddyRegion {
  const region = provider(providerId)?.region;
  return region === "cn" ? region : "cn";
}

function loginHint(providerId = "workbuddy-cn"): string {
  const region = regionOf(providerId);
  return (
    `还没有登录 WorkBuddy（${region} 区域）。服务启动时会自己发起登录（把授权链接点一下就行），` +
    `也可以${clearHint(sessionId(providerId))}。` +
    `凭据之后自动刷新。`
  );
}

export function loadSession(providerId = "workbuddy-cn"): WorkBuddySession | null {
  const region = regionOf(providerId);
  const session = readSession<WorkBuddySession>(sessionId(providerId), hasTokens, legacySessionPath(region));
  if (session) return session;
  // The session used to be stored per region: take it over once, so nobody has
  // to log in again because of the move. That old copy was global, so only the
  // built-in provider takes it over.
  const legacy = providerId === "workbuddy-cn" ? getSecret<WorkBuddySession>(legacySessionId(region)) : null;
  if (!legacy || !hasTokens(legacy)) return null;
  saveSession(legacy, providerId);
  return legacy;
}

export function hasSession(providerId = "workbuddy-cn"): boolean {
  return loadSession(providerId) !== null;
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function saveSession(session: WorkBuddySession, providerId = "workbuddy-cn"): void {
  writeSession(sessionId(providerId), session);
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
    const res = await cliFetch(url, { ...init, signal: controller.signal });
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

/**
 * The headers the auth endpoints carry.
 *
 * The four `X-No-` headers tell the server to ignore whatever global identity
 * it would otherwise use, so the login is about this account and not about
 * whoever is logged in elsewhere. The official client sends them, and the
 * server may answer about the wrong account without them.
 */
function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "User-Agent": `WorkBuddy/${DESKTOP_VERSION_CN}`,
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
}

/**
 * Run the browser login: ask for a state, print the URL, and poll until the
 * user has approved.
 */
/** 登录的第一步的结果：给用户一个链接。 */
export interface WorkBuddyLoginStart {
  /** 服务端这边的 state。半凭据，不进日志。 */
  state: string;
  /** 用户要点的那个地址。 */
  authUrl: string;
  /** 过期时刻。 */
  expiresAtMs: number;
}

/**
 * 登录的第一步：建一个 state，给用户一个链接。
 *
 * 浏览器只管登录，state 在服务端 —— 批准之后服务端拿它换 token。
 */
export async function startLogin(providerId = "workbuddy-cn"): Promise<WorkBuddyLoginStart> {
  const region = regionOf(providerId);
  const base = ENDPOINTS[region];
  const start = await requestJson(`${base.base}${AUTH_STATE_PATH}?platform=${AUTH_PLATFORM}`, {
    method: "POST",
    headers: authHeaders(),
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
  return {
    state: String(state),
    authUrl: String(authUrl),
    expiresAtMs: Date.now() + LOGIN_TIMEOUT_MS,
  };
}

/**
 * 登录的第二步：轮询 state，等用户在浏览器里批准。
 *
 * 拿到的是一份会话（没有存库 —— 存不存由调用的人决定）。
 */
export async function pollLogin(
  providerId = "workbuddy-cn",
  state: string,
  deadlineMs?: number,
): Promise<WorkBuddySession> {
  const region = regionOf(providerId);
  const base = ENDPOINTS[region];
  const deadline = deadlineMs ?? Date.now() + LOGIN_TIMEOUT_MS;
  let token = "";
  let refreshToken = "";
  let domain = base.base.replace(/^https?:\/\//, "");
  let expiresAt = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await requestJson(`${base.base}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`, {
      method: "GET",
      headers: authHeaders(),
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
    throw new AuthError("login timed out", "登录窗口已过期，请重启服务后重试。", 504);
  }

  const uid = jwtUid(token);
  let nickname = "";
  try {
    const profile = await requestJson(
      `${base.base}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`,
      { method: "GET", headers: { ...authHeaders(), Authorization: `Bearer ${token}` } },
    );
    nickname = String(profile.body?.data?.nickname ?? "");
  } catch {
    /* the profile is a nicety, not a requirement */
  }

  const now = Date.now();
  return {
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
}

/**
 * 登录：建 state → 用户在浏览器里登录 → 轮询 → 存会话。
 *
 * 面板上要用的是上面那两半（startLogin / pollLogin），这里是一体的。
 */
export async function login(providerId = "workbuddy-cn"): Promise<WorkBuddySession> {
  const region = regionOf(providerId);
  const start = await startLogin(providerId);

  console.log("");
  console.log(`  region: ${region}  base: ${ENDPOINTS[region].base}`);
  console.log(`  open in a browser: ${start.authUrl}`);
  console.log(`  (waiting for approval, up to ${Math.round(LOGIN_TIMEOUT_MS / 60000)} min)`);
  console.log("");

  const session = await pollLogin(providerId, start.state, start.expiresAtMs);
  saveSession(session, providerId);
  console.log(
    `  logged in: ${session.nickname}, token good for ${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s`,
  );
  console.log(`  saved to the database (${sessionId(providerId)})`);
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
  providerId = "workbuddy-cn",
): Promise<WorkBuddySession> {
  const session = loadSession(providerId);
  if (!session) throw new AuthError("no session", loginHint(providerId), 503);
  // 平台已经拒过这份会话：再问一次也是同样的答复，直接回答。
  const dead = deadSession(sessionId(providerId));
  if (dead) throw new AuthError("session refused by the platform", dead, 503);
  if (!force && session.expiresAtMs - Date.now() > REFRESH_BUFFER_MS) return session;

  const region = session.region ?? regionOf(providerId);
  const base = ENDPOINTS[region];
  const res = await requestJson(`${base.base}${REFRESH_PATH}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "X-Refresh-Token": session.refreshToken,
      // The official client says where the refresh came from, and the server
      // has a strategy for each source.
      "X-Auth-Refresh-Source": "plugin",
      // The domain is the endpoint we are talking to, not the one the login
      // answered with.
      "X-Domain": new URL(base.base).host,
    },
    body: "{}",
  });
  if (res.status !== 200) {
    const code = res.body?.code ?? res.body?.msg ?? `HTTP ${res.status}`;
    authLog(dataDir(), `workbuddy ${region} refresh rejected`, `${code} (HTTP ${res.status}), body ${JSON.stringify(res.body).slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) {
      const hint =
        `WorkBuddy 拒绝了刷新（${code}）。刷新时 token 会轮换，一份 session 同一时间只能有一个` +
        `持有者去刷新：另一台机器、另一份数据库副本、或者桌面端那份 store，只要有一份在刷新，` +
        `这份就失效。恢复：${clearHint(sessionId(providerId))}。`;
      // 别再拿这份会话去问平台了：每一次都是同样的拒绝。
      markSessionDead(sessionId(providerId), hint);
      throw new AuthError(`refresh rejected (${code})`, hint, 503);
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
  saveSession(next, providerId);
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

function toCredential(session: WorkBuddySession, providerId: string): Credential {
  return credentialFromSession(session, {
    source: sessionId(providerId),
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
  providerId = "workbuddy-cn",
): Promise<Credential> {
  return ensureCredentialShared({
    cache,
    setCache: (next) => {
      cache = next;
    },
    key: providerId,
    cacheMs: CACHE_MS,
    force,
    lockId: sessionId(providerId),
    load: () => loadSession(providerId),
    refresh: (f) => refreshSession(f, providerId),
    toCredential: (session) => toCredential(session, providerId),
    expired: (session) =>
      new AuthError(
        `access token expired (generation ${session.generation})`,
        `WorkBuddy token 已过期且刷新没成功。${clearHint(sessionId(providerId))}。`,
        503,
      ),
  });
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function workbuddyStatus(providerId = "workbuddy-cn"): Record<string, unknown> {
  const session = loadSession(providerId);
  const region = session?.region ?? regionOf(providerId);
  if (!session) {
    return { region, source: sessionId(providerId), status: "anonymous", error: "no session", hint: loginHint(providerId) };
  }
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    region,
    source: sessionId(providerId),
    status: remainingMs > 0 ? "authenticated" : "expired",
    uid: session.uid,
    nickname: session.nickname,
    domain: session.domain,
    generation: session.generation,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    remainingSec: Math.round(remainingMs / 1000),
    // The warning means "nobody can fix this": the token is gone and the
    // refresh did not replace it. A token that is merely about to expire is
    // normal -- the refresh handles it.
    warning: remainingMs <= 0,
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
 * The device id the simulated client sends.
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
export function accountHeaders(
  session: WorkBuddySession,
  opts: { chat?: boolean } = {},
): Record<string, string> {
  const deviceId = workbuddyDeviceId(session);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    "X-User-Id": session.uid || "anonymous",
    "X-Domain": session.domain,
    ...(deviceId ? { "X-Device-Id": deviceId } : {}),
  };
  if (opts.chat) {
    // The model request is not the account's own API: the simulated client
    // sends neither the device id nor the domain there — the device id belongs
    // to the sandbox SDK.
    delete headers["X-Device-Id"];
  }
  return headers;
}

/**
 * The identity the official CLI sends with a chat request.
 *
 * Everything here was taken from a request the simulated client actually made
 * (the Linux 5.6.2 and the Windows 5.8.3 builds send the same shape, only the
 * version differs). The headers that the simulated client does not send are not sent
 * here either.
 */
export function chatHeaders(
  session: WorkBuddySession,
  opts: { conversationId?: string; turnRequestId?: string } = {},
): Record<string, string> {
  const trace = uuidv7Hex();
  const span = randomBytes(8).toString("hex");
  const messageId = uuidv7Hex();
  // The conversation id is the id of the conversation, not of the request: the
  // same conversation keeps it for every turn, and the upstream counts what it
  // is told per conversation.
  const conversationId = opts.conversationId ?? uuidv7();
  const turnRequestId = opts.turnRequestId ?? uuidv7Hex();
  const headers: Record<string, string> = {
    ...accountHeaders(session, { chat: true }),
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CLI_VERSION,
    "X-Product": "SaaS",
    "User-Agent": `CLI/${CLI_VERSION} WorkBuddy/${CLI_VERSION}`,
    "X-Requested-With": "XMLHttpRequest",
    "X-CodeBuddy-Request": "1",
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": turnRequestId,
    // The root request id is the same id as the conversation's request id.
    "X-Root-Request-ID": turnRequestId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": messageId,
    // The account asked not to be sent to the Yuanbao channel.
    "X-Private-Data": "true",
    // The OpenAI Node SDK fingerprint the official CLI carries — these seven,
    // and no others.
    "x-stainless-lang": "js",
    "x-stainless-package-version": "6.25.0",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : "Linux",
    "x-stainless-arch": process.arch === "x64" ? "x64" : process.arch,
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": `v${process.versions.node}`,
    "x-stainless-retry-count": "0",
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
  const override = configString("WORKBUDDY_CHAT_BASE", "").replace(/\/+$/, "");
  if (override) return override;
  const host = session.domain || ENDPOINTS[session.region].base.replace(/^https?:\/\//, "");
  return `https://${host}`;
}
