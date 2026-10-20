// lib/minimax-oauth.ts — the proxy's own MiniMax Code session, for running in a
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readEnvNumber, readEnvString } from "./env.ts";
import { AuthError, DEFAULT_AUDIENCE, DEFAULT_CLIENT_ID, DEFAULT_REGION, DEFAULT_SCOPES } from "./credential.ts";
import type { Credential } from "./credential.ts";

/** Prod OAuth origins per region (packages/oauth-core/src/endpoint-config.ts). */
export const OAUTH_ORIGINS: Record<string, string> = {
  cn: "https://account.minimax.cn",
  en: "https://account.minimax.io",
};

const CLIENT_ID = readEnvString("MINIMAX_CLIENT_ID", DEFAULT_CLIENT_ID);
const AUDIENCE = readEnvString("MINIMAX_AUDIENCE", DEFAULT_AUDIENCE);
const SCOPES = readEnvString("MINIMAX_SCOPES", DEFAULT_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
const REGION = readEnvString("MINIMAX_REGION", DEFAULT_REGION);
const ORIGIN = readEnvString("MINIMAX_OAUTH_ORIGIN", OAUTH_ORIGINS[REGION] ?? OAUTH_ORIGINS.cn);
const CACHE_MS = readEnvNumber("MINIMAX_AUTH_CACHE_MS", 5000);
const WARN_MS = readEnvNumber("MINIMAX_AUTH_WARN_MS", 10 * 60 * 1000);
// Refresh when this much life is left. The real client uses 5 min; a 1-hour token
// means the proxy refreshes roughly once an hour.
const REFRESH_BUFFER_MS = readEnvNumber("MINIMAX_REFRESH_BUFFER_MS", 5 * 60 * 1000);
const LOCK_STALE_MS = readEnvNumber("MINIMAX_LOCK_STALE_MS", 30000);

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
  const explicit = readEnvString("MINIMAX_DATA_DIR", "");
  if (explicit) return explicit;
  return fs.existsSync("/data") ? "/data" : path.join(os.homedir(), ".minimax-proxy");
}

export function sessionPath(): string {
  const explicit = readEnvString("MINIMAX_CREDENTIAL_FILE", "");
  if (explicit) return explicit;
  return path.join(dataDir(), "minimax-session.json");
}

function loginHint(): string {
  return `还没有登录。服务启动时会自己跑 device flow（把授权链接点一下就行），` +
    `也可以设置 BUDDY_PROXY_MINIMAX_LOGIN=true 强制重新登录后重启。` +
    `凭据写在 ${sessionPath()}，之后每小时自动刷新。`;
}

/** Read our own session file without throwing. */
function loadSession(): Session | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(), "utf8"));
    if (!raw || typeof raw !== "object" || !raw.accessToken || !raw.refreshToken) return null;
    return raw as Session;
  } catch {
    return null;
  }
}

export function hasSession(): boolean {
  return loadSession() !== null;
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
function saveSession(session: Session): void {
  const file = sessionPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Single-writer lock around a refresh. Two containers sharing the same volume would
 * otherwise rotate the refresh token twice and one of them would be logged out.
 */
async function withSessionLock(fn: () => Promise<Session>): Promise<Session> {
  const lock = `${sessionPath()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let i = 0; i < 3 && !acquired; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      acquired = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        break;
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* someone else won the race */
        }
        continue;
      }
      // Another writer is mid-refresh: wait for its result instead of racing it.
      await new Promise((r) => setTimeout(r, Math.min(LOCK_STALE_MS - age, 2000)));
    }
  }
  if (!acquired) {
    const existing = loadSession();
    if (existing) return existing; // the other writer already landed its result
    throw new AuthError("could not acquire the credential lock", `另一个进程正在刷新凭据，稍后重试。`, 503);
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

async function postForm(endpoint: string, values: Record<string, string>) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
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

let cache: { at: number; cred: Credential } | null = null;

function toCredential(session: Session): Credential {
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    accessToken: session.accessToken,
    generation: session.generation,
    expiresAtMs: session.expiresAtMs,
    remainingMs,
    status: "authenticated",
    clientId: session.clientId,
    audience: session.audience,
    scopes: session.scopes,
    region: session.region,
    source: sessionPath(),
    owner: "oauth",
    warning: remainingMs < WARN_MS,
  };
}

/**
 * Refresh the session with the stored refresh token. The refresh token rotates on every
 * call, so the write must happen even when the caller only wanted a status.
 */
export async function refreshSession(force = false): Promise<Session> {
  const session = loadSession();
  if (!session) {
    cache = null;
    throw new AuthError("no session", loginHint(), 503);
  }
  if (!force && session.expiresAtMs - Date.now() > REFRESH_BUFFER_MS) return session;

  const r = await postForm(`${ORIGIN}/oauth2/token`, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
    audience: AUDIENCE,
  });
  if (!r.ok) {
    cache = null;
    const code = r.error ?? `HTTP ${r.status}`;
    if (code === "invalid_grant" || code === "invalid_token" || r.status === 401) {
      throw new AuthError(
        `refresh rejected (${code})`,
        `这个会话被服务端拒绝了（${code}）。设置 BUDDY_PROXY_MINIMAX_LOGIN=true 后重启服务即可重新登录。`,
        503,
      );
    }
    throw new AuthError(`refresh failed (${code})`, `OAuth 刷新失败（${code}），稍后重试。`, 502);
  }

  const next = sessionFromGrant(parseGrant(r.body), session);
  saveSession(next);
  cache = null;
  console.log(
    `[AUTH] refreshed (generation ${next.generation}, ${Math.round(next.expiresAtMs / 1000 - Date.now() / 1000)}s left)`,
  );
  return next;
}

/**
 * Credential for the proxy. Cached for CACHE_MS; `force` means "the token we just sent
 * was rejected, get a new one" and refreshes unconditionally.
 */
export async function ensureCredential(force = false): Promise<Credential> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.cred;
  const session = await withSessionLock(() => refreshSession(force));
  const cred = toCredential(session);
  if (cred.remainingMs <= 0) {
    throw new AuthError(
      `access token expired (generation ${cred.generation})`,
      `token 已过期且刷新没成功。设置 BUDDY_PROXY_MINIMAX_LOGIN=true 后重启服务即可重新登录。`,
      503,
    );
  }
  cache = { at: Date.now(), cred };
  return cred;
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

/** Poll until the browser approval lands, then persist the session. */
export async function pollDeviceToken(auth: DeviceAuthorization): Promise<Session> {
  const deadline = Date.now() + auth.expiresInSec * 1000;
  let intervalMs = auth.intervalSec * 1000;
  while (Date.now() < deadline) {
    const r = await postForm(`${ORIGIN}/oauth2/token`, {
      grant_type: DEVICE_GRANT,
      ...(auth.pollingParameter === "user_code" ? { user_code: auth.userCode } : { device_code: auth.deviceCode }),
      client_id: CLIENT_ID,
      code_verifier: auth.codeVerifier,
    });
    const status = typeof r.body.status === "string" ? r.body.status : "";
    if (r.ok && status === "pending") {
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    if (r.ok && status === "slow_down") {
      intervalMs += 5000;
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    if (r.ok && (status === "denied" || status === "access_denied")) {
      throw new AuthError("access_denied", "授权被拒绝或在浏览器里取消了。", 503);
    }
    if (r.ok && (status === "expired" || status === "expired_token")) {
      throw new AuthError("expired_token", "device code 超时了，重新跑一次登录。", 503);
    }
    if (r.ok) return sessionFromGrant(parseGrant(r.body));
    if (r.error === "authorization_pending") {
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    if (r.error === "slow_down") {
      intervalMs += 5000;
      await new Promise((res) => setTimeout(res, intervalMs));
      continue;
    }
    throw new AuthError(r.error ?? "device_authorization_failed", `轮询被服务端拒绝（${r.error ?? `HTTP ${r.status}`}）。`, 502);
  }
  throw new AuthError("expired_token", "device code 超时了，重新跑一次登录。", 503);
}

export async function login(): Promise<Session> {
  const auth = await startDeviceAuthorization();
  const url = auth.verificationUriComplete ?? `${auth.verificationUri}?code=${auth.userCode}`;
  console.log("");
  console.log(`  client_id: ${CLIENT_ID}  audience: ${AUDIENCE}  scope: ${SCOPES.join(" ")}`);
  console.log(`  user code: ${auth.userCode}`);
  console.log(`  open in a browser: ${url}`);
  console.log(`  (waiting for approval, up to ${Math.round(auth.expiresInSec / 60)} min)`);
  console.log("");
  const session = await pollDeviceToken(auth);
  saveSession(session);
  console.log(`  logged in: generation ${session.generation}, token good for ${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s`);
  console.log(`  saved to ${sessionPath()} (0600)`);
  console.log("  later refreshes are automatic — nothing else to do.");
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
    fs.unlinkSync(sessionPath());
  } catch {
    /* already gone */
  }
  cache = null;
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function oauthStatus(): Record<string, unknown> {
  const session = loadSession();
  if (!session) return { source: sessionPath(), status: "anonymous", error: "no session", hint: loginHint() };
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    source: sessionPath(),
    status: remainingMs > 0 ? "authenticated" : "expired",
    clientId: session.clientId,
    audience: session.audience,
    scopes: session.scopes,
    region: session.region,
    generation: session.generation,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    remainingSec: Math.round(remainingMs / 1000),
    warning: remainingMs < WARN_MS,
    refreshBufferSec: Math.round(REFRESH_BUFFER_MS / 1000),
    loginAt: new Date(session.loginAtMs).toISOString(),
    lastRefreshAt: new Date(session.refreshedAtMs).toISOString(),
    ...(session.subject ? { subject: session.subject } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
  };
}

export const OAUTH_WARN_MS = WARN_MS;
export const OAUTH_REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;
