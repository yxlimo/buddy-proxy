// lib/qoder-auth.ts — the proxy's own Qoder session.
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readEnvNumber, readEnvString } from "./env.ts";
import { AuthError } from "./credential.ts";
import type { Credential } from "./credential.ts";
import { deriveDeviceIdentity, deviceSalt, type DeviceIdentity } from "./device-identity.ts";

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
    openapi: "https://openapi.qoder.com.cn",
    infer: "https://gateway.qoder.com.cn/model/v1/chat/completions",
    inferLegacy: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
  },
  global: {
    site: "https://qoder.com",
    openapi: "https://openapi.qoder.sh",
    infer: "https://api2-v2.qoder.sh/model/v1/chat/completions",
    inferLegacy: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
  },
};

const REGION = (readEnvString("QODER_REGION", "global").trim().toLowerCase() === "cn" ? "cn" : "global") as QoderRegion;
export const REGION_NAME = REGION;
export const ENDPOINT = ENDPOINTS[REGION];

const CACHE_MS = readEnvNumber("QODER_AUTH_CACHE_MS", 5000);
// A Qoder access token is good for about 30 days (measured: 2591998s), so the
// warning window is days, not minutes. The refresh token is good for about a
// year, which is why the refresh path is barely ever taken.
const WARN_MS = readEnvNumber("QODER_AUTH_WARN_MS", 7 * 24 * 60 * 60 * 1000);
const REFRESH_BUFFER_MS = readEnvNumber("QODER_REFRESH_BUFFER_MS", 24 * 60 * 60 * 1000);
const LOCK_STALE_MS = readEnvNumber("QODER_LOCK_STALE_MS", 30000);
const POLL_INTERVAL_MS = readEnvNumber("QODER_POLL_INTERVAL_MS", 1000);
const POLL_TIMEOUT_MS = readEnvNumber("QODER_POLL_TIMEOUT_MS", 5 * 60 * 1000);
const USER_AGENT = readEnvString("QODER_USER_AGENT", "qoder/1.1.74");

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
  const explicit = readEnvString("QODER_DATA_DIR", "");
  if (explicit) return explicit;
  return fs.existsSync("/data") ? "/data" : path.join(os.homedir(), ".qoder-proxy");
}

export function sessionPath(region: QoderRegion = REGION): string {
  const explicit = readEnvString("QODER_CREDENTIAL_FILE", "");
  if (explicit) return explicit;
  return path.join(dataDir(), `qoder-session.${region}.json`);
}

function loginHint(region: QoderRegion = REGION): string {
  return (
    `还没有登录 Qoder（${region} 区域）。服务启动时会自己跑 device flow（把授权链接点一下就行），` +
    `也可以设置 BUDDY_PROXY_QODER_LOGIN=${region} 强制重新登录后重启。` +
    `凭据写在 ${sessionPath(region)}，之后自动刷新。`
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

export function loadSession(region: QoderRegion = REGION): QoderSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(region), "utf8"));
    if (!raw || typeof raw !== "object" || !raw.accessToken || !raw.refreshToken) return null;
    return raw as QoderSession;
  } catch {
    return null;
  }
}

export function hasSession(region: QoderRegion = REGION): boolean {
  return loadSession(region) !== null;
}

/**
 * The fingerprint of the account: derived from its id, so the account always
 * looks like the same machine and no two accounts look like the same one.
 *
 * The identity that was stored at login time is not used — that one was random,
 * and it would drift with every login.
 */
export function deviceIdentity(region: QoderRegion = REGION): DeviceIdentity | null {
  const session = loadSession(region);
  if (!session?.userId) return null;
  return deriveDeviceIdentity(session.userId, deviceSalt(dataDir()));
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function saveSession(session: QoderSession): void {
  const file = sessionPath(session.region);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Single-writer lock around a refresh. The refresh token rotates, so two processes
 * refreshing at once would leave one of them logged out.
 */
async function withSessionLock<T>(region: QoderRegion, fn: () => Promise<T>): Promise<T> {
  const lock = `${sessionPath(region)}.lock`;
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
      await new Promise((r) => setTimeout(r, Math.min(LOCK_STALE_MS - age, 2000)));
    }
  }
  if (!acquired) {
    const existing = loadSession(region);
    if (existing) return existing as unknown as T;
    throw new AuthError("could not acquire the credential lock", "另一个进程正在刷新凭据，稍后重试。", 503);
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
export async function refreshSession(force = false, region: QoderRegion = REGION): Promise<QoderSession> {
  const session = loadSession(region);
  if (!session) throw new AuthError("no session", loginHint(region), 503);
  if (!force && session.expiresAtMs - Date.now() > REFRESH_BUFFER_MS) return session;

  const r = await postJson(
    `${ENDPOINTS[region].openapi}/api/v1/deviceToken/refresh`,
    { refresh_token: session.refreshToken, ...machineFields(session) },
    session.accessToken,
  );
  if (r.status !== 200) {
    const code = r.body?.errorCode ?? r.body?.code ?? r.body?.message ?? `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) {
      throw new AuthError(
        `refresh rejected (${code})`,
        `Qoder 拒绝了刷新（${code}）。设置 BUDDY_PROXY_QODER_LOGIN=${region} 后重启服务即可重新登录。`,
        503,
      );
    }
    throw new AuthError(`refresh failed (${code})`, `Qoder 刷新失败（${code}），稍后重试。`, 502);
  }

  const next = parseGrant(r.body, session);
  saveSession(next);
  cache = null;
  console.log(`[AUTH] refreshed qoder/${region} (generation ${next.generation}, ${Math.round(next.expiresAtMs / 1000 - Date.now() / 1000)}s left)`);
  return next;
}

let cache: { at: number; cred: Credential; region: QoderRegion } | null = null;

function toCredential(session: QoderSession): Credential {
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    accessToken: session.accessToken,
    generation: session.generation,
    expiresAtMs: session.expiresAtMs,
    remainingMs,
    status: remainingMs > 0 ? "authenticated" : "expired",
    clientId: session.clientId,
    audience: "qoder",
    scopes: [],
    region: session.region,
    source: sessionPath(session.region),
    owner: "oauth",
    warning: remainingMs < WARN_MS,
  };
}

/** Credential for the proxy. `force` means the token we sent was rejected. */
export async function ensureCredential(force = false, region: QoderRegion = REGION): Promise<Credential> {
  if (!force && cache && cache.region === region && Date.now() - cache.at < CACHE_MS) return cache.cred;
  const session = await withSessionLock(region, () => refreshSession(force, region));
  const cred = toCredential(session);
  if (cred.remainingMs <= 0) {
    throw new AuthError(
      `access token expired (generation ${cred.generation})`,
      `Qoder token 已过期且刷新没成功。设置 BUDDY_PROXY_QODER_LOGIN=${region} 后重启服务即可重新登录。`,
      503,
    );
  }
  cache = { at: Date.now(), cred, region };
  return cred;
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
export function buildDeviceAuthorization(region: QoderRegion = REGION): DeviceAuthorization {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const nonce = randomUUID();
  // A login for an account that is already known reuses that account's
  // fingerprint, so the upstream does not see a new device. A first login has
  // no account id to derive from yet, so it gets a fresh one.
  const machine = deviceIdentity(region) ?? newMachineIdentity();
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
export async function pollDeviceToken(auth: DeviceAuthorization, region: QoderRegion = REGION): Promise<QoderSession> {
  const deadline = Math.min(auth.expiresAtMs, Date.now() + POLL_TIMEOUT_MS);
  const url =
    `${ENDPOINTS[region].openapi}/api/v1/deviceToken/poll?` +
    new URLSearchParams({ nonce: auth.nonce, verifier: auth.verifier, challenge_method: "S256" });

  while (Date.now() < deadline) {
    let r: Response;
    try {
      r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
    } catch (e) {
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
  throw new AuthError("expired_token", "授权超时了，重新跑一次登录。", 503);
}

export async function login(region: QoderRegion = REGION): Promise<QoderSession> {
  const auth = buildDeviceAuthorization(region);
  console.log("");
  console.log(`  region: ${region}  client_id: ${CLIENT_ID}`);
  console.log(`  open in a browser: ${auth.authUrl}`);
  console.log(`  (waiting for approval, up to ${Math.round(POLL_TIMEOUT_MS / 60000)} min)`);
  console.log("");
  const session = await pollDeviceToken(auth, region);
  saveSession(session);
  console.log(`  logged in: generation ${session.generation}, token good for ${Math.round(session.expiresAtMs / 1000 - Date.now() / 1000)}s`);
  console.log(`  saved to ${sessionPath(region)} (0600)`);
  console.log("  later refreshes are automatic — nothing else to do.");
  return session;
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function qoderStatus(region: QoderRegion = REGION): Record<string, unknown> {
  const session = loadSession(region);
  if (!session) return { region, source: sessionPath(region), status: "anonymous", error: "no session", hint: loginHint(region) };
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    region,
    source: sessionPath(region),
    status: remainingMs > 0 ? "authenticated" : "expired",
    clientId: session.clientId,
    userId: session.userId,
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
 * What the account itself says about its standing.
 *
 * A valid token does not mean the account may make requests: Qoder gates on a
 * whitelist that can reject an account because of where the request comes from
 * (`NoIpPermission`), because the app was disabled (`AppDisable`), or because the
 * login lapsed (`LoginExpire`). Those all surface at inference time as an opaque
 * failure, so the proxy asks the server instead of guessing from a 403 later.
 */
export interface QoderAccountHealth {
  region: QoderRegion;
  authorized: boolean;
  /** PASS / WAIT / NoIpPermission / AppDisable / LoginExpire, as the server reports it. */
  whitelistStatus?: string;
  userId?: string;
  userType?: string;
  /** True when the account is fine to use. */
  usable: boolean;
  /** Why not, in a sentence. */
  reason?: string;
  hint?: string;
}

export async function checkAccountHealth(region: QoderRegion = REGION): Promise<QoderAccountHealth> {
  const session = loadSession(region);
  if (!session) {
    return { region, authorized: false, usable: false, reason: "no session", hint: loginHint(region) };
  }
  const cred = await ensureCredential(false, region);
  const r = await fetch(`${ENDPOINTS[region].openapi}/api/v3/user/status`, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(session.machineToken ? { "Cosy-MachineToken": session.machineToken } : {}),
      ...(session.machineType ? { "Cosy-Machine-Type": session.machineType } : {}),
    },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => undefined);
    const code = body?.errorCode ?? body?.code ?? `HTTP ${r.status}`;
    return {
      region,
      authorized: false,
      usable: false,
      reason: `status check failed (${code})`,
      hint: `Qoder 账号状态查询失败（${code}）。`,
    };
  }
  const body = await r.json().catch(() => undefined);
  const userId = typeof body?.id === "string" ? body.id : undefined;
  const whitelistStatus = typeof body?.whitelistStatus === "string" ? body.whitelistStatus : undefined;
  const userType = typeof body?.userType === "string" ? body.userType : undefined;

  if (!userId) {
    return {
      region,
      authorized: false,
      usable: false,
      reason: "login expired",
      hint: `登录已失效，设置 BUDDY_PROXY_QODER_LOGIN=${region} 后重启服务即可重新登录。`,
    };
  }
  if (whitelistStatus === "NoIpPermission") {
    return {
      region,
      authorized: false,
      usable: false,
      whitelistStatus,
      userId,
      userType,
      reason: "the account may not be used from this IP",
      hint: "Qoder 拒绝了当前出口 IP（NoIpPermission）。换一个出口再试。",
    };
  }
  if (whitelistStatus === "AppDisable") {
    return { region, authorized: false, usable: false, whitelistStatus, userId, userType, reason: "the app is disabled for this account" };
  }
  if (whitelistStatus === "LoginExpire") {
    return {
      region,
      authorized: false,
      usable: false,
      whitelistStatus,
      userId,
      userType,
      reason: "login expired",
      hint: `登录已过期，设置 BUDDY_PROXY_QODER_LOGIN=${region} 后重启服务即可重新登录。`,
    };
  }
  return { region, authorized: true, usable: true, whitelistStatus, userId, userType };
}
