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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { uuidv7, uuidv7Hex } from "../ids.ts";
import { AuthError, authLog, tokenFingerprint } from "../credential.ts";
import type { Credential } from "../credential.ts";
import { deriveDeviceIdentity, deviceSalt } from "../device-identity.ts";
import { clearHint, ensureCredential as ensureCredentialShared, hasTokens, deadSession, readSession, refreshSessionFlow, toCredential as credentialFromSession, type CredentialCache, writeSession } from "../session.ts";
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
 * The version a request reports is the desktop app's: the client's VLM gateway
 * rewrites the CLI's version header to `app.getVersion()` before the request
 * leaves the machine, and that is what the upstream sees.
 */
/** The version of the desktop app — the one the upstream sees. */
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
  /** 企业账号才有；个人账号没有这一段。 */
  enterpriseId?: string;
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
  const session = readSession<WorkBuddySession>(sessionId(providerId), hasTokens);
  if (session) return session;
  // The session used to be stored per region: take it over once, so nobody has
  // to log in again because of the move. That old copy was global, so only the
  // built-in provider takes it over.
  const legacy = providerId === "workbuddy-cn" ? getSecret<WorkBuddySession>(legacySessionId(region)) : null;
  if (!legacy || !hasTokens(legacy)) return null;
  saveSession(legacy, providerId, { force: true });
  return legacy;
}

export function hasSession(providerId = "workbuddy-cn"): boolean {
  return loadSession(providerId) !== null;
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function saveSession(
  session: WorkBuddySession,
  providerId = "workbuddy-cn",
  options: { force?: boolean } = {},
): boolean {
  return writeSession(sessionId(providerId), session, options);
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
  // 调用方也可能给一个闸（刷新那一步的超时）：两个都响才算完。
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    const res = await cliFetch(url, { ...init, signal });
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
 * The host of an endpoint.
 *
 * The base is one of our own constants, so this never fails — but a header
 * is not worth an exception over.
 */
function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "";
  }
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
  saveSession(session, providerId, { force: true });
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
/**
 * 换令牌：到了临期就换，没到就原样返回。
 *
 * 定时器每分钟问一次，所以「临期」这个判断放在这里：没到临期就什么都不做。
 *
 * 刷新时 refresh token 会轮换，而它是**一次性的**：同一份 session 被换两次，
 * 平台会当成重放，把整个会话的令牌一起撤掉。所以这份会话同一时刻只有一
 * 刷新者——定时器。请求那一条路不换令牌（它看到过期就报错）。
 */
export async function refreshSession(providerId = "workbuddy-cn"): Promise<WorkBuddySession> {
  const id = sessionId(providerId);
  return refreshSessionFlow<WorkBuddySession>({
    id,
    load: () => loadSession(providerId),
    bufferMs: REFRESH_BUFFER_MS,
    request: async (session, signal) => {
      const region = session.region ?? regionOf(providerId);
      const base = ENDPOINTS[region];
      const res = await requestJson(`${base.base}${REFRESH_PATH}`, {
        method: "POST",
        signal,
        headers: {
          ...authHeaders(),
          "X-Refresh-Token": session.refreshToken,
          // The official client says where the refresh came from, and the
          // server has a strategy for each source.
          "X-Auth-Refresh-Source": "plugin",
          // The domain is the endpoint we are talking to, not the one the
          // login answered with.
          "X-Domain": hostOf(base.base),
        },
        body: "{}",
      });
      const code = res.body?.code ?? res.body?.msg ?? `HTTP ${res.status}`;
      return { ok: res.status === 200, status: res.status, code: String(code), body: res.body };
    },
    parse: (body, session) => workbuddySessionFrom(body, session),
    refused: (answer) => answer.status === 401 || answer.status === 403,
    hint: (code) =>
      `WorkBuddy 拒绝了刷新（${code}）。刷新时 token 会轮换，一份 session 同一时间只能有一个` +
      `持有者去刷新：另一台机器、另一份数据库副本、或者桌面端那份 store，只要有一份在刷新，` +
      `这份就失效。恢复：${clearHint(sessionId(providerId))}。`,
    save: (next) => saveSession(next, providerId),
    label: (session) => `workbuddy ${session.region ?? regionOf(providerId)}`,
    noSession: loginHint(providerId),
    invalidate: () => {
      cache = null;
    },
  });
}

/**
 * The refreshed session, from what the platform answered.
 *
 * The answer keeps the shape of the login: the token is in `data.data` (or in
 * `data`).
 */
function workbuddySessionFrom(body: any, session: WorkBuddySession): WorkBuddySession {
  const data = body?.data?.data ?? body?.data ?? {};
  const token = String(data.accessToken ?? "");
  if (!token) {
    throw new AuthError(
      "refresh returned no token",
      `WorkBuddy 刷新没有返回 token：${JSON.stringify(body).slice(0, 200)}`,
      503,
    );
  }

  const now = Date.now();
  return {
    ...session,
    accessToken: token,
    refreshToken: String(data.refreshToken ?? session.refreshToken),
    generation: session.generation + 1,
    expiresAtMs: jwtExp(token) || session.expiresAtMs,
    refreshExpiresAtMs: normalizeEpoch(data.refreshExpiresAt) || session.refreshExpiresAtMs,
    refreshedAtMs: now,
  };
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
export async function ensureCredential(providerId = "workbuddy-cn"): Promise<Credential> {
  return ensureCredentialShared<WorkBuddySession>({
    cache,
    setCache: (next) => {
      cache = next;
    },
    key: providerId,
    cacheMs: CACHE_MS,
    lockId: sessionId(providerId),
    // 令牌是定时器换的，这里只取现在这一份。
    session: () => loadSession(providerId),
    toCredential: (session) => toCredential(session, providerId),
    expired: (session) =>
      new AuthError(
        session ? `access token expired (generation ${session.generation})` : "no session",
        session
          ? `WorkBuddy token 已过期。服务会按临期刷新，若一直是这个状态，请${clearHint(sessionId(providerId))}。`
          : `没有登录。${clearHint(sessionId(providerId))}。`,
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
  // 平台拒过这份会话：令牌没了，换令牌也没用，只能重新授权。
  const refused = deadSession(sessionId(providerId));
  if (refused) {
    return {
      source: sessionId(providerId),
      status: "expired",
      error: "这份会话已经失效，需要重新授权",
      hint: refused,
      warning: true,
      generation: session.generation,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      remainingSec: Math.round(remainingMs / 1000),
    };
  }
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
 * The headers a chat request carries.
 *
 * This is the DESK set, not the CLI set: the official client's VLM gateway
 * rebuilds the identity before the request leaves the machine
 * (`buildVlmGatewayHeaders` + `applyGatewayHeaders` in main/server.js), and
 * what the upstream sees is that rebuilt set. The values, their names
 * (including casing) and the order here come from
 * docs/workbuddy/FINDINGS.md §1.1 — do not add a header the desktop does not
 * send, and do not drop one it does.
 *
 * Session ids, and what each one belongs to:
 *
 *   X-Conversation-ID          the conversation, uuid v7 with dashes, the same
 *                              on every turn of that conversation, across
 *                              restarts
 *   X-Conversation-Request-ID  one turn, uuid v7 without dashes (the client
 *                              checks this shape itself)
 *   X-Conversation-Message-ID  one request, randomUUID (v4, with dashes)
 *   X-Request-ID               one request, randomUUID, a *different* one
 *   acp-connection-id          one connection, fixed for as long as the
 *                              conversation lives
 */
export function chatHeaders(
  session: WorkBuddySession,
  opts: { conversationId?: string; turnRequestId?: string } = {},
): Record<string, string> {
  const trace = randomBytes(16).toString("hex");
  const span = randomBytes(8).toString("hex");
  const parentSpan = randomBytes(8).toString("hex");
  // The official client's own generator is randomUUID for these two, and they
  // are two different ids.
  const messageId = randomUUID();
  const requestId = randomUUID();
  const conversationId = opts.conversationId ?? uuidv7();
  const turnRequestId = opts.turnRequestId ?? uuidv7Hex();

  const headers: Record<string, string> = {
    // Identity: buildVlmGatewayHeaders runs first, so these come first.
    ...(session.uid ? { "X-User-Id": session.uid } : {}),
    ...(session.enterpriseId
      ? { "X-Enterprise-Id": session.enterpriseId, "X-Tenant-Id": session.enterpriseId }
      : {}),
    ...(session.domain ? { "X-Domain": session.domain } : {}),
    "X-Product": "SaaS",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": DESKTOP_VERSION_CN,
    "X-Private-Data": "true",
    // The desktop's own version twice, and nothing else — no CLI segment here.
    "User-Agent": `WorkBuddy/${DESKTOP_VERSION_CN} WorkBuddy/${DESKTOP_VERSION_CN}`,

    // Then applyGatewayHeaders overwrites the request identity.
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": turnRequestId,
    "acp-connection-id": acpConnectionIdFor(conversationId),
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": requestId,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "x-codebuddy-request": "1",

    // Then the trace family.
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${randomBytes(8).toString("hex")}`,
    "X-B3-TraceId": trace,
    "X-B3-ParentSpanId": parentSpan,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
    "X-Trace-ID": trace,

    // And the two the VLM upstream sets last.
    "Accept-Encoding": "identity",
    Authorization: `Bearer ${session.accessToken}`,
  };
  return headers;
}

/**
 * The connection id of a conversation.
 *
 * The official client mints one uuid per VLM session and reuses it for every
 * request of that session. A conversation is that session, so the id is
 * derived from its id: the same conversation always gets the same connection
 * id, and two conversations never share one.
 */
export function acpConnectionIdFor(conversationId: string): string {
  const digest = createHash("sha256").update(`acp:${conversationId}`).digest();
  const hex = digest.toString("hex");
  // Shaped like a uuid v7, which is what randomUUID would have produced of it.
  const version = ((digest[6] & 0x07) | 0x07).toString(16);
  const variant = ((digest[7] & 0x03) | 0x08).toString(16);
  const id = `${hex.slice(0, 12)}${version}${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
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
