// lib/session.ts — the session every client keeps, and the machinery around it.
//
// Each client logs in its own way and refreshes its own way — the endpoints,
// the request shapes and the error texts are all different. The parts around
// that are the same everywhere: where the session is kept, how it is written,
// the lock that keeps two writers from rotating a refresh token twice, and
// the credential the upstream call is handed. That is what lives here.
//
// The sessions live in the database (lib/store.ts). The file names the clients
// pass in are the ones the sessions used to have; they are only read while the
// migration is under way, and the first read moves the session into the
// database.

import fs from "node:fs";
import path from "node:path";
import { AuthError, type Credential } from "./credential.ts";
import { dataDir, legacyDirs } from "./paths.ts";
import { LockUnavailableError, getSecret, setSecret, withLock } from "./store.ts";

/** The fields every session file has. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  generation?: number;
}

/**
 * Where a session file used to live, and where it may still be.
 *
 * The first entry is the current directory; the rest are the ones an older
 * version used, so a machine that has not been moved yet still finds its
 * session and does not have to log in again.
 */
export function legacyPaths(name: string): string[] {
  return [path.join(dataDir(), name), ...legacyDirs().map((d) => path.join(d, name))];
}

/** The default check: a session with both tokens in it. */
export function hasTokens(raw: any): boolean {
  return !!raw?.accessToken && !!raw?.refreshToken;
}

/**
 * Read a session.
 *
 * The database is where the session lives. The file is where it used to live:
 * it is read once — on the first read after the migration — and moved into the
 * database, so nothing has to log in again because of the move.
 */
export function readSession<T>(
  id: string,
  valid: (raw: any) => boolean = hasTokens,
  legacyFile?: string | string[],
): T | null {
  const fromDb = getSecret<T>(id);
  if (fromDb) return valid(fromDb) ? fromDb : null;
  if (!legacyFile) return null;
  const files = Array.isArray(legacyFile) ? legacyFile : [legacyFile];
  for (const file of files) {
    const raw = readLegacyFile<T>(file, valid);
    if (!raw) continue;
    setSecret(id, "session", raw);
    return raw;
  }
  return null;
}

/** Read the session from the file it used to live in. */
function readLegacyFile<T>(file: string, valid: (raw: any) => boolean): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !valid(raw)) return null;
    return raw as T;
  } catch {
    return null;
  }
}

/** How to get rid of a credential and log in again. */
export function clearHint(id: string): string {
  return `清掉数据库里的这条凭据（node router-proxy.ts --clear ${id}）后重启，服务会重新登录`;
}

/** Write a session. */
export function writeSession(id: string, session: unknown): void {
  setSecret(id, "session", session);
}

/**
 * Single-writer lock around a refresh. Two holders of the same refresh token
 * would rotate it twice and one of them would be logged out, so a refresh
 * takes this lock first.
 */
export async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withLock(id, fn);
  } catch (e) {
    if (!(e instanceof LockUnavailableError)) throw e;
    // Another writer is mid-refresh: its result is the session it wrote, so
    // read that and use it.
    const existing = getSecret<SessionTokens>(id);
    if (existing) return existing as unknown as T;
    throw new AuthError("could not acquire the credential lock", `另一个进程正在刷新凭据，稍后重试。`, 503);
  }
}

/** How the credential is built from the session. */
export interface CredentialShape {
  /** Where the session file is. */
  source: string;
  /** Who owns the session: the desktop app ("file"), or this proxy ("oauth"). */
  owner: "file" | "oauth";
  /** Inside this window the token counts as close to expiry. */
  warnMs: number;
  clientId?: string;
  audience?: string;
  scopes?: string[];
  region?: string;
  /** Overrides the status; the default looks at the expiry. */
  status?: string;
  /** True when the source had no authoritative record and fell back to a guess. */
  fallback?: boolean;
}

/** The credential the upstream call needs, built from the session. */
export function toCredential(session: SessionTokens, shape: CredentialShape): Credential {
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    accessToken: session.accessToken,
    generation: session.generation ?? 0,
    expiresAtMs: session.expiresAtMs,
    remainingMs,
    status: shape.status ?? (remainingMs > 0 ? "authenticated" : "expired"),
    clientId: shape.clientId ?? "",
    audience: shape.audience ?? "",
    scopes: shape.scopes ?? [],
    region: shape.region ?? "",
    source: shape.source,
    owner: shape.owner,
    warning: remainingMs < shape.warnMs,
    fallback: shape.fallback,
  };
}

/** The credential cache. One per client, keyed by the region where there is one. */
export interface CredentialCache {
  at: number;
  cred: Credential;
  key?: string;
}

/** How `ensureCredential` gets the credential it hands out. */
export interface EnsureCredentialOptions<T extends SessionTokens> {
  /** The cache to read and to fill. */
  cache: CredentialCache | null;
  /** The cache setter — the client keeps it in a module-level variable. */
  setCache: (cache: CredentialCache) => void;
  /** The region, for the clients that have more than one. */
  key?: string;
  /** How long a cached credential is reused. */
  cacheMs: number;
  /** True means "the token we sent was rejected, get a new one". */
  force: boolean;
  /** The session id, which is also what the lock is named after. */
  lockId: string;
  /** The session, as it is on disk. */
  load: () => T | null;
  /** Refresh, or return the session when it is still good. */
  refresh: (force: boolean) => Promise<T>;
  /** The credential, built from the session. */
  toCredential: (session: T) => Credential;
  /** The error to raise when the credential is already expired. */
  expired: (session: T) => AuthError;
}

/**
 * The credential for the proxy: the cached one when it is still fresh, otherwise
 * the session, refreshed when it is about to expire.
 */
export async function ensureCredential<T extends SessionTokens>(
  opts: EnsureCredentialOptions<T>,
): Promise<Credential> {
  const cached = opts.cache;
  const sameKey = opts.key === undefined || cached?.key === opts.key;
  if (!opts.force && cached && sameKey && Date.now() - cached.at < opts.cacheMs) {
    return cached.cred;
  }
  const session = await withSessionLock(opts.lockId, () => opts.refresh(opts.force));
  const cred = opts.toCredential(session);
  if (cred.remainingMs <= 0) throw opts.expired(session);
  opts.setCache({ at: Date.now(), cred, key: opts.key });
  return cred;
}
