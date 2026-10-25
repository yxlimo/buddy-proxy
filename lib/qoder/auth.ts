// lib/qoder/auth.ts — the proxy's own Qoder session.
//
// Qoder's CLI authenticates with a PKCE device flow, but not the shape the OAuth
// device flow normally has: there is no "device code" endpoint. The client generates
// the verifier and its S256 challenge locally, sends the user to a page that binds
// challenge ↔ nonce ↔ account, then polls with the verifier. A 404 from the poll
// endpoint means "the user has not approved yet" — it is a wait, not an error.
//
// The session is ours alone (no desktop app to fight over a credential file with),
// so refreshing is unambiguous. The refresh token rotates on every call, so the
// file must survive restarts.
//
// Two regions, one client id:
//   cn     qoder.cn            openapi.qoder.com.cn   gateway.qoder.com.cn
//   global qoder.com           openapi.qoder.sh       api2-v2.qoder.sh
// The client id differs between prod and the daily/test environments, not between
// regions — both use the prod one.

import { configString, configNumber } from "../config.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthError, authLog, tokenFingerprint } from "../credential.ts";
import type { Credential } from "../credential.ts";
import { deriveDeviceIdentity, deviceSalt, type DeviceIdentity } from "../device-identity.ts";
import { clearHint, ensureCredential as ensureCredentialShared, hasTokens, legacyPaths, deadSession, markSessionDead, readSession, toCredential as credentialFromSession, type CredentialCache, writeSession } from "../session.ts";
import { dataDir as sharedDataDir } from "../paths.ts";
import { provider, providerSecretId } from "../providers.ts";

export type QoderRegion = "cn" | "global";

/** Prod client id, decrypted from the CLI bundle. The other one is for daily/test. */
export const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";

export interface QoderEndpoints {
  /** Where the user approves in a browser. */
  site: string;
  /** Device token poll / refresh / userinfo. */
  openapi: string;
  /** New protocol (OpenAI dialect) inference endpoint. */
  infer: string;
  /** Old protocol (COSY) inference endpoint, used when the new one is not deployed. */
  inferLegacy: string;
}

export const ENDPOINTS: Record<QoderRegion, QoderEndpoints> = {
  cn: {
    site: "https://qoder.cn",
    openapi: configString("QODER_CN_OPENAPI_BASE", "https://openapi.qoder.com.cn").replace(/\/+$/, ""),
    infer: configString("QODER_CN_INFER_BASE", "https://gateway.qoder.com.cn").replace(/\/+$/, "") + "/model/v1/chat/completions",
    inferLegacy: configString("QODER_CN_INFER_BASE", "https://gateway.qoder.com.cn").replace(/\/+$/, "") + "/algo/api/v2/service/pro/sse/agent_chat_generation",
  },
  global: {
    site: "https://qoder.com",
    openapi: configString("QODER_GLOBAL_OPENAPI_BASE", "https://openapi.qoder.sh").replace(/\/+$/, ""),
    infer: configString("QODER_GLOBAL_INFER_BASE", "https://api2-v2.qoder.sh").replace(/\/+$/, "") + "/model/v1/chat/completions",
    // The legacy protocol lives on another host, so it has its own base.
    inferLegacy: configString("QODER_GLOBAL_LEGACY_BASE", "https://api3.qoder.sh").replace(/\/+$/, "") + "/algo/api/v2/service/pro/sse/agent_chat_generation",
  },
};

export const REGION: QoderRegion = "global";
export const REGION_NAME = REGION;
export const ENDPOINT = ENDPOINTS[REGION];

const CACHE_MS = configNumber("QODER_AUTH_CACHE_MS", 5000);
// A Qoder access token is good for about 30 days (measured: 2591998s), so the
// warning window is days, not minutes. The refresh token is good for about a
// year, which is why the refresh path is barely ever taken.
const WARN_MS = configNumber("QODER_AUTH_WARN_MS", 7 * 24 * 60 * 60 * 1000);
const REFRESH_BUFFER_MS = configNumber("QODER_REFRESH_BUFFER_MS", 24 * 60 * 60 * 1000);
const POLL_INTERVAL_MS = configNumber("QODER_POLL_INTERVAL_MS", 1000);
const POLL_TIMEOUT_MS = configNumber("QODER_POLL_TIMEOUT_MS", 5 * 60 * 1000);
export const USER_AGENT = configString("QODER_USER_AGENT", "qoder/1.1.74");

export const QODER_WARN_MS = WARN_MS;
export const QODER_REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;

export interface QoderSession {
  schemaVersion: number;
  region: QoderRegion;
  clientId: string;
  /** `dt-` prefixed. */
  accessToken: string;
  /** `drt-` prefixed, rotates on every refresh. */
  refreshToken: string;
  userId: string;
  expiresAtMs: number;
  refreshExpiresAtMs: number;
  /** Machine identity — the refresh endpoint expects these back. */
  machineId: string;
  machineToken: string;
  machineType: string;
  generation: number;
  loginAtMs: number;
  refreshedAtMs: number;
}

export function dataDir(): string {
  return sharedDataDir();
}

/**
 * Where the session lives in the database.
 *
 * The session belongs to the provider, not to the region: two Qoder China
 * accounts are two providers, each with its own session.
 */
export function sessionId(providerId = "qoder"): string {
  return providerSecretId(providerId);
}

/** Where the session used to live, while the migration is under way. */
export function legacySessionPath(region: QoderRegion = REGION): string[] {
  return legacyPaths(`qoder-session.${region}.json`);
}

export function loginHint(providerId = "qoder"): string {
  const region = regionOf(providerId);
  return (
    `还没有登录 Qoder（${region} 区域）。服务启动时会自己跑 device flow（把授权链接点一下就行），` +
    `${clearHint(sessionId(providerId))}（会打印一个授权链接）。` +
    `凭据之后自动刷新。`
  );
}

/** The CLI keeps one machine identity per install and sends it back on refresh. */
export function newMachineIdentity(): { machineId: string; machineToken: string; machineType: string } {
  const machineId = randomUUID();
  const seed = (randomUUID() + randomUUID()).slice(0, 50);
  return {
    machineId,
    machineToken: Buffer.from(seed, "utf8").toString("base64url"),
    machineType: randomUUID().replace(/-/g, "").slice(0, 18),
  };
}

export function loadSession(providerId = "qoder"): QoderSession | null {
  const region = regionOf(providerId);
  return readSession<QoderSession>(sessionId(providerId), hasTokens, legacySessionPath(region));
}

export function hasSession(providerId = "qoder"): boolean {
  return loadSession(providerId) !== null;
}

/**
 * Which region a provider talks to.
 *
 * The region picks the endpoints; the provider id picks the credential. Two
 * providers of the same kind can sit in different regions.
 */
export function regionOf(providerId = "qoder"): QoderRegion {
  const row = provider(providerId);
  const region = row?.region;
  return region === "cn" || region === "global" ? region : REGION;
}

/**
 * The fingerprint of the account: derived from its id, so the account always
 * looks like the same machine and no two accounts look like the same one.
 *
 * The identity that was stored at login time is not used — that one was random,
 * and it would drift with every login.
 */
export function deviceIdentity(providerId = "qoder"): DeviceIdentity | null {
  const session = loadSession(providerId);
  if (!session?.userId) return null;
  return deriveDeviceIdentity(session.userId, deviceSalt(dataDir()));
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function saveSession(session: QoderSession, providerId = "qoder"): void {
  writeSession(sessionId(providerId), session);
}


function machineFields(session: QoderSession): Record<string, string> {
  // The derived fingerprint, not the one that was stored at login time: the
  // account has to keep looking like the same machine.
  const identity = deviceIdentity(session.region);
  if (identity) {
    return {
      machine_id: identity.machineId,
      machine_token: identity.machineToken,
      machine_type: identity.machineType,
    };
  }
  return {
    machine_id: session.machineId,
    machine_token: session.machineToken,
    machine_type: session.machineType,
  };
}

async function postJson(endpoint: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const parsed = await r.json().catch(() => undefined);
  return { status: r.status, body: parsed };
}

/** The grant response uses `token` / `refresh_token`, not the OAuth `access_token`. */
function parseGrant(body: any, previous?: QoderSession | null): QoderSession {
  // The login answers `token`, the refresh answers `device_token` — same thing.
  const accessToken =
    typeof body?.token === "string" ? body.token : typeof body?.device_token === "string" ? body.device_token : "";
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : previous?.refreshToken ?? "";
  const userId = typeof body?.user_id === "string" ? body.user_id : previous?.userId ?? "";

  // `expires_at` is an ISO timestamp; `expire_time` is a relative number of seconds.
  let expiresAtMs = 0;
  if (typeof body?.expires_at === "string") expiresAtMs = Date.parse(body.expires_at);
  if (!expiresAtMs && typeof body?.expire_time === "number") expiresAtMs = Date.now() + body.expire_time * 1000;
  if (!expiresAtMs && previous) expiresAtMs = previous.expiresAtMs;

  let refreshExpiresAtMs = 0;
  if (typeof body?.refresh_token_expires_at === "string") refreshExpiresAtMs = Date.parse(body.refresh_token_expires_at);
  if (!refreshExpiresAtMs && typeof body?.refresh_token_expire_time === "number") {
    refreshExpiresAtMs = Date.now() + body.refresh_token_expire_time * 1000;
  }
  if (!refreshExpiresAtMs && previous) refreshExpiresAtMs = previous.refreshExpiresAtMs;

  if (!accessToken || !refreshToken || !expiresAtMs) {
    throw new AuthError("invalid token response", "Qoder 返回的 token 响应不完整。", 502);
  }

  const now = Date.now();
  const machine = previous
    ? { machineId: previous.machineId, machineToken: previous.machineToken, machineType: previous.machineType }
    : newMachineIdentity();

  return {
    schemaVersion: 1,
    region: previous?.region ?? REGION,
    clientId: CLIENT_ID,
    accessToken,
    refreshToken,
    userId,
    expiresAtMs,
    refreshExpiresAtMs,
    ...machine,
    generation: (previous?.generation ?? 0) + 1,
    loginAtMs: previous?.loginAtMs ?? now,
    refreshedAtMs: now,
  };
}

/** Refresh with the stored refresh token. The token rotates, so this must persist. */
export async function refreshSession(force = false, providerId = "qoder"): Promise<QoderSession> {
  const session = loadSession(providerId);
  const region = session?.region ?? regionOf(providerId);
  if (!session) throw new AuthError("no session", loginHint(providerId), 503);
  // 平台已经拒过这份会话：再问一次也是同样的答复，直接回答。
  const dead = deadSession(sessionId(providerId));
  if (dead) throw new AuthError("session refused by the platform", dead, 503);
  if (!force && session.expiresAtMs - Date.now() > REFRESH_BUFFER_MS) return session;

  const r = await postJson(
    `${ENDPOINTS[region].openapi}/api/v1/deviceToken/refresh`,
    { refresh_token: session.refreshToken, ...machineFields(session) },
    session.accessToken,
  );
  if (r.status !== 200) {
    const code = r.body?.errorCode ?? r.body?.code ?? r.body?.message ?? `HTTP ${r.status}`;
    authLog(dataDir(), `qoder ${region} refresh rejected`, `${code} (HTTP ${r.status}), body ${JSON.stringify(r.body).slice(0, 300)}`);
    if (r.status === 401 || r.status === 403) {
      const hint =
        `Qoder 拒绝了刷新（${code}）。刷新时 token 会轮换，一份 session 同一时间只能有一个` +
        `持有者去刷新：另一台机器、另一份数据库副本、或者桌面端那份 store，只要有一份在刷新，` +
        `这份就失效。恢复：${clearHint(sessionId(providerId))}。`;
      // 别再拿这份会话去问平台了：每一次都是同样的拒绝。
      markSessionDead(sessionId(providerId), hint);
      throw new AuthError(`refresh rejected (${code})`, hint, 503);
    }
    throw new AuthError(`refresh failed (${code})`, `Qoder 刷新失败（${code}），稍后重试。`, 502);
  }

  const next = parseGrant(r.body, session);
  saveSession(next, providerId);
  cache = null;
  authLog(
    dataDir(),
    `qoder ${region} refresh ok`,
    `generation ${next.generation}, access ${tokenFingerprint(next.accessToken)}, ` +
      `refresh ${tokenFingerprint(next.refreshToken)}, ` +
      `${Math.round(next.expiresAtMs / 1000 - Date.now() / 1000)}s left`,
  );
  return next;
}

let cache: CredentialCache | null = null;

function toCredential(session: QoderSession): Credential {
  return credentialFromSession(session, {
    source: sessionId(session.region),
    owner: "oauth",
    warnMs: WARN_MS,
    clientId: session.clientId,
    audience: "qoder",
    region: session.region,
  });
}

/** Credential for the proxy. `force` means the token we sent was rejected. */
export async function ensureCredential(force = false, providerId = "qoder"): Promise<Credential> {
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
    toCredential,
    expired: (session) =>
      new AuthError(
        `access token expired (generation ${session.generation})`,
        `Qoder token 已过期且刷新没成功。${clearHint(sessionId(providerId))}。`,
        503,
      ),
  });
}

export interface DeviceAuthorization {
  verifier: string;
  challenge: string;
  nonce: string;
  machineId: string;
  machineToken: string;
  machineType: string;
  authUrl: string;
  expiresAtMs: number;
}

/**
 * Build the authorization URL. There is no server-side device code: the challenge is
 * computed here, exactly as the CLI does it.
 */
export function buildDeviceAuthorization(providerId = "qoder"): DeviceAuthorization {
  const region = regionOf(providerId);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const nonce = randomUUID();
  // A login for an account that is already known reuses that account's
  // fingerprint, so the upstream does not see a new device. A first login has
  // no account id to derive from yet, so it gets a fresh one.
  const machine = deviceIdentity(providerId) ?? newMachineIdentity();
  const params = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machine.machineId,
    client_id: CLIENT_ID,
  });
  params.set("machine_token", machine.machineToken);
  return {
    verifier,
    challenge,
    nonce,
    ...machine,
    authUrl: `${ENDPOINTS[region].site}/device/selectAccounts?${params.toString()}`,
    expiresAtMs: Date.now() + POLL_TIMEOUT_MS,
  };
}

/** Poll until the browser approval lands, then persist the session. */
export async function pollDeviceToken(auth: DeviceAuthorization, providerId = "qoder"): Promise<QoderSession> {
  const region = regionOf(providerId);
  const deadline = Math.min(auth.expiresAtMs, Date.now() + POLL_TIMEOUT_MS);
  const url =
    `${ENDPOINTS[region].openapi}/api/v1/deviceToken/poll?` +
    new URLSearchParams({ nonce: auth.nonce, verifier: auth.verifier, challenge_method: "S256" });

  while (Date.now() < deadline) {
    let r: Response;
    try {
      r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
    } catch {
      await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
      continue;
    }
    if (r.status === 404) {
      // Designed-in "still waiting for the user to approve".
      await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
      continue;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => undefined);
      const code = body?.errorCode ?? body?.code ?? `HTTP ${r.status}`;
      throw new AuthError(`device poll failed (${code})`, `轮询授权结果被服务端拒绝（${code}）。`, 502);
    }
    const body = await r.json();
    if (body?.token) {
      // The machine identity comes from the authorization step and must survive into
      // the stored session, so the refresh call can send it back.
      const previous = {
        region,
        clientId: CLIENT_ID,
        machineId: auth.machineId,
        machineToken: auth.machineToken,
        machineType: auth.machineType,
      } as unknown as QoderSession;
      return parseGrant(body, previous);
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new AuthError("expired_token", "授权超时，请重新发起登录。", 503);
}

export async function login(providerId = "qoder"): Promise<QoderSession> {
  const region = regionOf(providerId);
  const auth = buildDeviceAuthorization(providerId);
  console.log("");
  console.log(`  region: ${region}  client_id: ${CLIENT_ID}`);
  console.log(`  open in a browser: ${auth.authUrl}`);
  console.log(`  (waiting for approval, up to ${Math.round(POLL_TIMEOUT_MS / 60000)} min)`);
  console.log("");
  const session = await pollDeviceToken(auth, providerId);
  saveSession(session, providerId);
  console.log(`  logged in: generation ${session.generation}, token good for ${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s`);
  console.log(`  saved to the database (${sessionId(providerId)})`);
  authLog(
    dataDir(),
    `qoder ${region} login ok`,
    `generation ${session.generation}, access ${tokenFingerprint(session.accessToken)}, ` +
      `refresh ${tokenFingerprint(session.refreshToken)}, ` +
      `${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s left`,
  );
  console.log("  later refreshes are automatic — nothing else to do.");
  return session;
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function qoderStatus(providerId = "qoder"): Record<string, unknown> {
  const region = regionOf(providerId);
  const session = loadSession(providerId);
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
    clientId: session.clientId,
    userId: session.userId,
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
 * What the account itself says about its standing.
 *
 * A valid token does not mean the account may make requests: Qoder gates on a
 * whitelist that can reject an account because of where the request comes from
 * (`NoIpPermission`), because the app was disabled (`AppDisable`), or because the
 * login lapsed (`LoginExpire`). Those all surface at inference time as an opaque
 * failure, so the proxy asks the server instead of guessing from a 403 later.
 */
