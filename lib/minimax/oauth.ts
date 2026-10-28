// lib/minimax/oauth.ts — the proxy's own MiniMax Code session, for running in a
// container where the desktop app's store is not readable.
//
// The proxy logs in with the same OAuth client the real MiniMax Code client uses
// (client_id `mcode-public`, audience `agent-backend`, scope `agent.default`) and keeps
// its own credential file, so nothing depends on the desktop app being present. The
// grant itself is the identity — there is no TLS fingerprint or header gate — so a
// plain HTTP client with this token is treated as a MiniMax Code client.
//
// Refreshing is safe here precisely because the session is the proxy's own: there is no
// `generation` to fight over with the desktop app, which is why the read-only file
// source can never refresh.
//
// Access tokens live ~1 hour, so the proxy refreshes with the refresh token, which
// rotates on every call (sliding window). As long as the container is alive the session
// survives restarts through the persisted file. The first login needs a browser once;
// everything after that is automatic.
//
// Note the two MiniMax auth domains are not interchangeable: an mmx CLI OAuth token or
// a platform API key gets 401 on this gateway (measured), because the gateway is locked
// to audience `agent-backend`. Only this grant works.

import { configString, configNumber } from "../config.ts";
import { createHash, randomBytes } from "node:crypto";
import { AuthError, DEFAULT_AUDIENCE, DEFAULT_CLIENT_ID, DEFAULT_REGION, DEFAULT_SCOPES, authLog, tokenFingerprint } from "../credential.ts";
import type { Credential } from "../credential.ts";
import { clearHint, ensureCredential as ensureCredentialShared, hasTokens, deadSession, readSession, refreshSessionFlow, toCredential as credentialFromSession, type CredentialCache, writeSession } from "../session.ts";
import { dataDir as sharedDataDir } from "../paths.ts";
import { providerSecretId } from "../providers.ts";
import { deleteSecret } from "../store.ts";
import { registerLoginFlow, type LoginContext, type LoginTicket, type PollResult } from "../login-flow.ts";

/** Prod OAuth origins per region (packages/oauth-core/src/endpoint-config.ts). */
export const OAUTH_ORIGINS: Record<string, string> = {
  cn: "https://account.minimax.cn",
  en: "https://account.minimax.io",
};

const CLIENT_ID = configString("MINIMAX_CLIENT_ID", DEFAULT_CLIENT_ID);
const AUDIENCE = configString("MINIMAX_AUDIENCE", DEFAULT_AUDIENCE);
const SCOPES = configString("MINIMAX_SCOPES", DEFAULT_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
const REGION = configString("MINIMAX_REGION", DEFAULT_REGION);
const ORIGIN = configString("MINIMAX_OAUTH_ORIGIN", OAUTH_ORIGINS[REGION] ?? OAUTH_ORIGINS.cn);
const CACHE_MS = configNumber("MINIMAX_AUTH_CACHE_MS", 5000);
const WARN_MS = configNumber("MINIMAX_AUTH_WARN_MS", 10 * 60 * 1000);
// Refresh when this much life is left. The real client uses 5 min; a 1-hour token
// means the proxy refreshes roughly once an hour.
const REFRESH_BUFFER_MS = configNumber("MINIMAX_REFRESH_BUFFER_MS", 5 * 60 * 1000);
// How often the device flow asks the upstream, and how long it may keep asking.
// The upstream's own numbers win (the ticket carries them); these are the floor
// the framework falls back to.
const DEVICE_POLL_INTERVAL_MS = configNumber("MINIMAX_POLL_INTERVAL_MS", 5000);
const DEVICE_POLL_TIMEOUT_MS = configNumber("MINIMAX_POLL_TIMEOUT_MS", 300_000);

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What we persist. Field names follow the desktop app's record shape where they apply. */
export interface Session {
  schemaVersion: number;
  clientId: string;
  audience: string;
  scopes: string[];
  region: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAtMs: number;
  /** Our own counter, bumped on login and every refresh. */
  generation: number;
  loginAtMs: number;
  refreshedAtMs: number;
  subject?: string;
  accountId?: string;
}

interface Grant {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  expiresInSec: number;
  subject?: string;
  accountId?: string;
}

export function dataDir(): string {
  return sharedDataDir();
}

/**
 * Where the session lives in the database.
 *
 * The session belongs to the provider, not to the kind: two MiniMax Code
 * accounts are two providers, each with its own session.
 */
export function sessionId(providerId = "minimax"): string {
  return providerSecretId(providerId);
}

/** Where the session used to live, while the migration is under way. */
function loginHint(providerId = "minimax"): string {
  return `还没有登录。服务启动时会自己跑 device flow（把授权链接点一下就行），` +
    `${clearHint(sessionId(providerId))}（会打印一个授权链接）。` +
    `凭据之后每小时自动刷新。`;
}

/**
 * Read our own session without throwing.
 *
 * The legacy file is the **built-in** provider's session -- it is the one that
 * lived on disk before the credentials moved into the database. It belongs to
 * that provider alone: reading it for any other id would hand a second
 * provider the same account, and with it the same refresh token. One of them
 * refreshing would then break the other.
 */
function loadSession(providerId = "minimax"): Session | null {
  return readSession<Session>(sessionId(providerId), hasTokens);
}

export function hasSession(providerId = "minimax"): boolean {
  return loadSession(providerId) !== null;
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function saveSession(
  session: Session,
  providerId = "minimax",
  options: { force?: boolean } = {},
): boolean {
  return writeSession(sessionId(providerId), session, options);
}


/**
 * Single-writer lock around a refresh. Two containers sharing the same volume would
 * otherwise rotate the refresh token twice and one of them would be logged out.
 */

async function postForm(endpoint: string, values: Record<string, string>, signal?: AbortSignal) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
    signal,
  });
  const body = (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const error = typeof body?.error === "string" ? body.error : undefined;
  return { ok: r.ok && !error, status: r.status, body: body ?? {}, error };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Same validation the real client applies: Bearer, a real expiry, and the scope we asked for. */
function parseGrant(body: Record<string, unknown>, previousRefreshToken?: string): Grant {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previousRefreshToken ?? "";
  const tokenType = typeof body.token_type === "string" ? body.token_type : "";
  const expiresInSec = typeof body.expires_in === "number" ? body.expires_in : 0;
  const claims = accessToken ? decodeJwtPayload(accessToken) : undefined;
  const rawScope = claims?.scope ?? claims?.scp ?? body.scope;
  const scopes = typeof rawScope === "string" ? rawScope.split(/\s+/).filter(Boolean) : [];

  if (!accessToken || !refreshToken || tokenType.toLowerCase() !== "bearer" || !expiresInSec) {
    throw new AuthError("invalid token response", `OAuth 服务端返回的 token 响应不完整。`, 502);
  }
  if (scopes.length > 0 && !scopes.includes(DEFAULT_SCOPES[0])) {
    throw new AuthError(
      `unexpected scope "${scopes.join(" ")}"`,
      `服务端给的 scope 不含 ${DEFAULT_SCOPES[0]}，这个会话用不了这个网关。`,
      502,
    );
  }

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    scopes: scopes.length ? scopes : DEFAULT_SCOPES,
    expiresInSec,
    ...(typeof claims?.sub === "string" ? { subject: claims.sub } : {}),
    ...(typeof claims?.account_id === "string" ? { accountId: claims.account_id } : {}),
  };
}

function sessionFromGrant(grant: Grant, previous?: Session | null): Session {
  const now = Date.now();
  return {
    schemaVersion: 1,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    scopes: grant.scopes,
    region: REGION,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    tokenType: grant.tokenType,
    expiresAtMs: now + grant.expiresInSec * 1000,
    generation: (previous?.generation ?? 0) + 1,
    loginAtMs: previous?.loginAtMs ?? now,
    refreshedAtMs: now,
    ...(grant.subject ? { subject: grant.subject } : {}),
    ...(grant.accountId ? { accountId: grant.accountId } : {}),
  };
}

let cache: CredentialCache | null = null;

function toCredential(session: Session): Credential {
  return credentialFromSession(session, {
    source: sessionId(),
    owner: "oauth",
    warnMs: WARN_MS,
    status: "authenticated",
    clientId: session.clientId,
    audience: session.audience,
    scopes: session.scopes,
    region: session.region,
  });
}

/**
 * Refresh the session with the stored refresh token. The refresh token rotates on every
 * call, so the write must happen even when the caller only wanted a status.
 */
/**
 * 换令牌：到了临期就换，没到就原样返回。
 *
 * 定时器每分钟问一次，所以「临期」这个判断放在这里：没到临期就什么都不做。
 *
 * 刷新时 refresh token 会轮换，而它是**一次性的**：同一份 session 被换两次，
 * 平台会当成重放，把**整个会话**的令牌一起撤掉。所以这份会话同一时刻只有
 * 一个刷新者——定时器。请求那一条路不换令牌（它看到过期就报错）。
 */
export async function refreshSession(providerId = "minimax"): Promise<Session> {
  const id = sessionId(providerId);
  return refreshSessionFlow<Session>({
    id,
    load: () => loadSession(providerId),
    bufferMs: REFRESH_BUFFER_MS,
    request: async (session, signal) => {
      const r = await postForm(
        `${ORIGIN}/oauth2/token`,
        {
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
          client_id: CLIENT_ID,
          scope: SCOPES.join(" "),
          audience: AUDIENCE,
        },
        signal,
      );
      return { ok: r.ok, status: r.status, code: r.error ?? `HTTP ${r.status}`, body: r.body };
    },
    parse: (body, session) => sessionFromGrant(parseGrant(body), session),
    refused: (answer) =>
      answer.code === "invalid_grant" || answer.code === "invalid_token" || answer.status === 401,
    hint: (code) =>
      `这个会话的 refresh token 被平台拒了（${code}）。刷新时 token 会轮换，所以一份 session ` +
      `同一时间只能有一个持有者：另一台机器、另一份数据库副本、或者桌面端那份 store，` +
      `只要有一份在刷新，这份就作废。而且平台会把**同一个账号**的其它会话一起撤掉——` +
      `所以两个 MiniMax 账号会同时报 503。` +
      `恢复：在面板上重新登录这个账号；或者${clearHint(sessionId(providerId))}，` +
      `服务会重新登录。`,
    save: (next) => saveSession(next, providerId),
    label: () => `minimax/${providerId}`,
    noSession: loginHint(providerId),
    invalidate: () => {
      cache = null;
    },
    extra: (next) => `scope ${next.scopes.join(",") || "?"}`,
  });
}

/**
 * Credential for the proxy. Cached for CACHE_MS; `force` means "the token we just sent
 * was rejected, get a new one" and refreshes unconditionally.
 */
export async function ensureCredential(providerId = "minimax"): Promise<Credential> {
  return ensureCredentialShared({
    cache,
    setCache: (next) => {
      cache = next;
    },
    cacheMs: CACHE_MS,
    // 缓存是模块级的，两个账号共用一份：所以缓存里要记着它是哪个账号的。
    // 不然 A 的凭据会被当成 B 的发出去（同一个平台账号时能用，但代次就乱了）。
    key: providerId,
    lockId: sessionId(providerId),
    // 令牌是定时器换的，这里只取现在这一份。
    session: () => loadSession(providerId),
    toCredential,
    expired: (session) =>
      new AuthError(
        session ? `access token expired (generation ${session.generation})` : "no session",
        session
          ? `token 已过期。服务会按临期刷新，若一直是这个状态，请${clearHint(sessionId(providerId))}。`
          : `没有登录。${clearHint(sessionId(providerId))}。`,
        503,
      ),
  });
}

export interface DeviceAuthorization {
  deviceCode: string;
  codeVerifier: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSec: number;
  intervalSec: number;
  /** Some deployments return only a user_code; then polling sends it under that name. */
  pollingParameter?: "device_code" | "user_code";
}

/** RFC 8628 device flow, same shape as the real client. Works from plain HTTP. */
export async function startDeviceAuthorization(): Promise<DeviceAuthorization> {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const r = await postForm(`${ORIGIN}/oauth2/device/code`, {
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
    audience: AUDIENCE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (!r.ok) throw new AuthError(`device code failed (${r.error ?? `HTTP ${r.status}`})`, "拿不到 device code。", 502);

  const body = r.body;
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  const deviceCode = typeof body.device_code === "string" ? body.device_code : userCode;
  const verificationUri =
    (typeof body.verification_uri === "string" ? body.verification_uri : "") ||
    (typeof body.verification_url === "string" ? body.verification_url : "");
  const expiresInSec = typeof body.expires_in === "number" ? body.expires_in : 300;
  const intervalSec = typeof body.interval === "number" ? body.interval : 5;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new AuthError("invalid device authorization response", "device code 响应格式不对。", 502);
  }
  return {
    deviceCode,
    codeVerifier,
    userCode,
    verificationUri,
    ...(typeof body.verification_uri_complete === "string" ? { verificationUriComplete: body.verification_uri_complete } : {}),
    expiresInSec,
    intervalSec,
    ...(deviceCode === userCode ? { pollingParameter: "user_code" as const } : {}),
  };
}

/** What one question to the upstream can answer. */
export type DevicePoll =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "approved"; session: Session }
  | { state: "denied"; message: string }
  | { state: "expired"; message: string };

/**
 * Ask the upstream once: has the browser approved this device code yet?
 *
 * The waiting belongs to the caller (lib/login-flow.ts drives it with a
 * rhythm and a window); here we only answer what the upstream said.
 */
export async function pollDeviceTokenOnce(auth: DeviceAuthorization): Promise<DevicePoll> {
  const r = await postForm(`${ORIGIN}/oauth2/token`, {
    grant_type: DEVICE_GRANT,
    ...(auth.pollingParameter === "user_code" ? { user_code: auth.userCode } : { device_code: auth.deviceCode }),
    client_id: CLIENT_ID,
    code_verifier: auth.codeVerifier,
  });
  const status = typeof r.body.status === "string" ? r.body.status : "";
  if (r.ok && status === "pending") return { state: "pending" };
  if (r.ok && status === "slow_down") return { state: "slow_down" };
  if (r.ok && (status === "denied" || status === "access_denied")) {
    return { state: "denied", message: "授权被拒绝或在浏览器里取消了。" };
  }
  if (r.ok && (status === "expired" || status === "expired_token")) {
    return { state: "expired", message: "device code 已超时，请重新发起登录。" };
  }
  if (r.ok) return { state: "approved", session: sessionFromGrant(parseGrant(r.body)) };
  if (r.error === "authorization_pending") return { state: "pending" };
  if (r.error === "slow_down") return { state: "slow_down" };
  throw new AuthError(r.error ?? "device_authorization_failed", `轮询被服务端拒绝（${r.error ?? `HTTP ${r.status}`}）。`, 502);
}

/** Poll until the browser approval lands, then persist the session. */
export async function pollDeviceToken(auth: DeviceAuthorization): Promise<Session> {
  const deadline = Date.now() + auth.expiresInSec * 1000;
  let intervalMs = auth.intervalSec * 1000;
  while (Date.now() < deadline) {
    const r = await pollDeviceTokenOnce(auth);
    if (r.state === "approved") return r.session;
    if (r.state === "denied") throw new AuthError("access_denied", r.message, 503);
    if (r.state === "expired") throw new AuthError("expired_token", r.message, 503);
    if (r.state === "slow_down") {
      intervalMs += 5000;
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new AuthError("expired_token", "device code 已超时，请重新发起登录。", 503);
}

export async function login(providerId = "minimax"): Promise<Session> {
  const auth = await startDeviceAuthorization();
  const url = auth.verificationUriComplete ?? `${auth.verificationUri}?code=${auth.userCode}`;
  console.log("");
  console.log(`  client_id: ${CLIENT_ID}  audience: ${AUDIENCE}  scope: ${SCOPES.join(" ")}`);
  console.log(`  user code: ${auth.userCode}`);
  console.log(`  open in a browser: ${url}`);
  console.log(`  (waiting for approval, up to ${Math.round(auth.expiresInSec / 60)} min)`);
  console.log("");
  const session = await pollDeviceToken(auth);
  saveSession(session, providerId, { force: true });
  console.log(`  logged in: generation ${session.generation}, token good for ${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s`);
  console.log(`  saved to the database (${sessionId(providerId)})`);
  console.log("  later refreshes are automatic — nothing else to do.");
  authLog(
    dataDir(),
    `minimax/${providerId} login ok`,
    `generation ${session.generation}, access ${tokenFingerprint(session.accessToken)}, ` +
      `refresh ${tokenFingerprint(session.refreshToken)}, scope ${session.scopes.join(",") || "?"}, ` +
      `${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s left`,
  );
  return session;
}

export async function revoke(): Promise<void> {
  const session = loadSession();
  if (!session) return;
  const r = await postForm(`${ORIGIN}/oauth2/revoke`, {
    token: session.refreshToken,
    token_type_hint: "refresh_token",
    client_id: CLIENT_ID,
  });
  if (!r.ok) throw new AuthError(`revoke failed (${r.error ?? `HTTP ${r.status}`})`, "撤销失败。", 502);
  try {
    deleteSecret(sessionId());
  } catch {
    /* already gone */
  }
  cache = null;
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function oauthStatus(providerId = "minimax"): Record<string, unknown> {
  const session = loadSession(providerId);
  if (!session) {
    return { source: sessionId(providerId), status: "anonymous", error: "no session", hint: loginHint(providerId) };
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
    source: sessionId(providerId),
    status: remainingMs > 0 ? "authenticated" : "expired",
    clientId: session.clientId,
    audience: session.audience,
    scopes: session.scopes,
    region: session.region,
    generation: session.generation,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    remainingSec: Math.round(remainingMs / 1000),
    // The warning means "nobody can fix this": the token is gone and the
    // refresh did not replace it. A token that is merely about to expire is
    // normal -- the refresh handles it (the watcher does it before the
    // request does), so warning about it would cry wolf every hour.
    warning: remainingMs <= 0,
    refreshBufferSec: Math.round(REFRESH_BUFFER_MS / 1000),
    loginAt: new Date(session.loginAtMs).toISOString(),
    lastRefreshAt: new Date(session.refreshedAtMs).toISOString(),
    ...(session.subject ? { subject: session.subject } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
  };
}

export const OAUTH_WARN_MS = WARN_MS;
export const OAUTH_REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;

/* ------------------------------------------------------------------ *
 * Login flow
 * ------------------------------------------------------------------ */

/**
 * MiniMax Code's login flow (registered for lib/login-flow.ts).
 *
 * The waiting belongs to the framework: this only hands out a link and
 * answers one question at a time.
 */
registerLoginFlow<Session>("minimax", {
  method: "device",
  label: "minimax",
  timeoutMs: DEVICE_POLL_TIMEOUT_MS,
  pollIntervalMs: DEVICE_POLL_INTERVAL_MS,
  begin: async (_ctx: LoginContext): Promise<LoginTicket> => {
    const auth = await startDeviceAuthorization();
    return {
      method: "device",
      authorizationUrl: auth.verificationUriComplete ?? `${auth.verificationUri}?code=${auth.userCode}`,
      userCode: auth.userCode,
      expiresAtMs: Date.now() + auth.expiresInSec * 1000,
      message: "请在浏览器中打开上方链接并完成授权，之后此处会自动显示为已登录。",
      // The half-credential travels as it is: the row the panel stores keeps
      // the old shape, so a login that was still waiting survives a restart.
      state: { auth },
    };
  },
  poll: async (_ctx: LoginContext, ticket: LoginTicket): Promise<PollResult<Session>> => {
    const auth = ticket.state.auth as DeviceAuthorization;
    const r = await pollDeviceTokenOnce(auth);
    if (r.state === "approved") return { state: "approved", session: r.session };
    if (r.state === "denied") return { state: "failed", message: r.message };
    if (r.state === "expired") return { state: "expired", message: r.message };
    if (r.state === "slow_down") {
      // The upstream asks us to back off: wait five more seconds, the same
      // way the device flow handles slow_down.
      await new Promise((res) => setTimeout(res, 5000));
    }
    return { state: "pending" };
  },
  // The session is stored here: this is the one moment a login finishes, so
  // it may overwrite the older one.
  commit: (ctx: LoginContext, session: Session) => {
    saveSession(session, ctx.accountId, { force: true });
    return providerSecretId(ctx.accountId);
  },
});
