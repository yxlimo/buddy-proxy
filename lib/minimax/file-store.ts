// lib/minimax/file-store.ts — read-only view of the MiniMax Code desktop app's OAuth
// store. This is the source that works when the proxy runs on the same machine as
// the desktop app; it is useless inside a container, which is why lib/minimax/oauth.ts
// exists.
//
// The desktop app owns this store: it refreshes the token under `auth.lock` and bumps
// `generation` in `auth-state.json`. This module never writes to that store and never
// calls the token endpoint — refreshing here would bump the server-side generation and
// log the desktop app out (its `handleUnauthorized` compares generation and would see a
// session change).
//
// Consequence: access tokens live ~1 hour, so the desktop app has to be opened
// regularly. When the credential is stale we report a clear "re-login in MiniMax Code"
// error instead of trying to fix it ourselves.
//
// Files (default dir /mnt/d/.minimax/auth/prod/cn/mcode-public):
//   auth-state.json  { schemaVersion, status, clientId, scopes, audience,
//                      buildEnv, region, generation, expiresAtMs }
//   auth.json        { schemaVersion, records: { <key>: StoredCredential } }
// A record is the persisted credential; `status` in the state file is the app's own
// view (anonymous / authorizing / refreshing / authenticated / expired / error /
// scope_upgrade_required).

import { configString, configNumber } from "../config.ts";
import { readEnvValue } from "../env.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthError, DEFAULT_CLIENT_ID, DEFAULT_REGION } from "../credential.ts";
import type { Credential } from "../credential.ts";

export interface StoredCredential {
  schemaVersion: number;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  clientId: string;
  scopes: string[];
  audience: string;
  expiresAtMs: number;
  generation: number;
  loginEpoch?: string;
}

export interface AuthState {
  schemaVersion: number;
  status: string;
  storeKind: string;
  clientId: string;
  scopes: string[];
  audience: string;
  buildEnv: string;
  region: string;
  generation: number;
  expiresAtMs: number;
  activeRecord?: StoredCredential;
}

const CLIENT_ID = configString("MINIMAX_CLIENT_ID", DEFAULT_CLIENT_ID);
const REGION = configString("MINIMAX_REGION", DEFAULT_REGION);
const CACHE_MS = configNumber("MINIMAX_AUTH_CACHE_MS", 5000);
const WARN_MS = configNumber("MINIMAX_AUTH_WARN_MS", 10 * 60 * 1000);

/** Explicit dir wins; otherwise try the native home, then the Windows drive mount. */
export function authDir(): string {
  const explicit = readEnvValue("MINIMAX_AUTH_DIR") || "";
  if (explicit) return explicit;
  const rel = path.join(".minimax", "auth", "prod", REGION, CLIENT_ID);
  const native = path.join(os.homedir(), rel);
  if (fs.existsSync(native)) return native;
  return path.join("/mnt/d", rel);
}

/**
 * Read a JSON file without throwing. The app writes atomically, but a reader can
 * still land on a half-written file, so an unreadable/unparsable file counts as
 * "not available right now" and the other source is tried instead.
 */
function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

let cache: { at: number; cred: Credential } | null = null;
let lastWarnedGeneration = -1;

/** Pick the record the app currently considers active, else the freshest one. */
function pickRecord(
  state: AuthState | null,
  store: { records?: Record<string, StoredCredential> } | null,
): { rec: StoredCredential; fallback: boolean } {
  const entries = Object.entries(store?.records || {});
  if (entries.length > 0) {
    const exact = entries.find(([, rec]) => rec.generation === state?.generation);
    if (exact) return { rec: exact[1], fallback: false };
    const freshest = entries.slice().sort((a, b) => b[1].expiresAtMs - a[1].expiresAtMs)[0];
    return { rec: freshest[1], fallback: true };
  }
  if (state?.activeRecord) return { rec: state.activeRecord, fallback: true };
  throw new AuthError(
    "no credential record",
    `读不到凭据（${authDir()}/auth-state.json 或 auth.json）。确认 MiniMax Code 桌面 App 已登录后重试。`,
    503,
  );
}

/**
 * Read the shared credential. Cached for CACHE_MS; `force` bypasses the cache (used
 * after an upstream 401, since the app may have refreshed in the meantime). This
 * source can never refresh — the desktop app owns the session.
 */
export function readFileCredential(force = false): Credential {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.cred;

  const dir = authDir();
  const state = readJsonSafe(path.join(dir, "auth-state.json")) as AuthState | null;
  const store = readJsonSafe(path.join(dir, "auth.json")) as
    | { records?: Record<string, StoredCredential> }
    | null;

  const { rec, fallback } = pickRecord(state, store);
  const remainingMs = rec.expiresAtMs - Date.now();

  if (remainingMs <= 0) {
    cache = null;
    throw new AuthError(
      `access token expired (generation ${rec.generation})`,
      `MiniMax Code 登录已过期（generation ${rec.generation}，剩余 ${Math.round(remainingMs / 1000)}s）。` +
        `打开 MiniMax Code 桌面 App 重新登录或运行一次 mcode，让它刷新后重试。`,
      503,
    );
  }

  // The app's status is its own view; a stale "expired" flag with a live record
  // still works, so only a status that means "no session at all" is a hard failure.
  if (state && state.status === "anonymous") {
    throw new AuthError(
      `auth status is "${state.status}"`,
      `MiniMax Code 当前状态是 anonymous（未登录）。打开桌面 App 完成登录后重试。`,
      503,
    );
  }

  const cred: Credential = {
    accessToken: rec.accessToken,
    generation: rec.generation,
    expiresAtMs: rec.expiresAtMs,
    remainingMs,
    status: state?.status ?? "authenticated",
    clientId: rec.clientId,
    audience: rec.audience,
    scopes: rec.scopes,
    region: state?.region ?? REGION,
    source: dir,
    owner: "file",
    fallback,
    warning: remainingMs < WARN_MS,
  };

  if (cred.warning && cred.generation !== lastWarnedGeneration) {
    lastWarnedGeneration = cred.generation;
    console.warn(
      `[AUTH] token expires in ${Math.round(remainingMs / 60000)} min (generation ${cred.generation}) — ` +
        `open the MiniMax Code desktop app before it goes stale`,
    );
  }

  cache = { at: Date.now(), cred };
  return cred;
}

/** Shape for /health — never throws, reports what is wrong instead. */
export function fileCredentialStatus(): Record<string, unknown> {
  try {
    const c = readFileCredential();
    return {
      source: c.source,
      status: c.status,
      clientId: c.clientId,
      audience: c.audience,
      scopes: c.scopes,
      region: c.region,
      generation: c.generation,
      expiresAt: new Date(c.expiresAtMs).toISOString(),
      remainingSec: Math.round(c.remainingMs / 1000),
      warning: c.warning,
      fallbackRecord: c.fallback,
    };
  } catch (e) {
    const err = e as AuthError;
    return { source: authDir(), status: "unavailable", error: err.message, hint: err.hint };
  }
}

export const FILE_WARN_MS = WARN_MS;
