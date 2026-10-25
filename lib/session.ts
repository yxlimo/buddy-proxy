// lib/session.ts — the session every client keeps, and the machinery around it.
//
// Each client logs in its own way and refreshes its own way — the endpoints,
// the request shapes and the error texts are all different. The parts around
// that are the same everywhere: where the session is kept, how it is written,
// the lock that keeps two writers from rotating a refresh token twice, and
// the credential the upstream call is handed. That is what lives here.
//
// The sessions live in the database (lib/store.ts). The file names the simulated clients
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

/**
 * Write a session.
 *
 * A session carries its generation: the higher it is, the newer the session is.
 * A refresh rotates the refresh token, so the same session refreshed twice at
 * the same time leaves the newer result alive and the older one spent — and
 * the older one must not be the one that stays in the database. So a session
 * that is older than what is already stored is not written at all.
 *
 * A login is a new session and always replaces what is there — that is how
 * an operator recovers from a session the platform refused.
 */
export function writeSession(id: string, session: unknown, options: { force?: boolean } = {}): boolean {
  deadSessions.delete(id);
  const stored = getSecret<{ generation?: number }>(id);
  const mine = generationOf(session);
  const theirs = generationOf(stored);
  if (!options.force && stored && theirs > mine) return false;
  setSecret(id, "session", session);
  return true;
}

/** The generation of a session, as far as it says. */
function generationOf(session: unknown): number {
  if (!session || typeof session !== "object") return 0;
  const value = (session as { generation?: unknown }).generation;
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sessions the platform refused to refresh.
 *
 * A refused refresh token is dead for good: every later attempt gets the same
 * answer, and every attempt costs a round trip to the platform. So the refusal
 * is remembered and answered straight away, until a new session arrives — and
 * writing a session clears the note.
 */
const deadSessions = new Map<string, { until: number; reason: string }>();

/** How long a refusal is remembered. */
const DEAD_SESSION_MS = 30 * 60 * 1000;

/** Remember that this session cannot be refreshed. */
export function markSessionDead(id: string, reason: string, ms = DEAD_SESSION_MS): void {
  deadSessions.set(id, { until: Date.now() + ms, reason });
}

/** The refusal of this session, while it is still remembered. */
export function deadSession(id: string): string | null {
  const entry = deadSessions.get(id);
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    deadSessions.delete(id);
    return null;
  }
  return entry.reason;
}

/** Forget the refusal: the operator asked for another try. */
export function clearDeadSession(id: string): void {
  deadSessions.delete(id);
}

/**
 * The session as it is now, if somebody else has refreshed it since we read ours.
 *
 * The refresh token rotates on every refresh, so a token that differs from the
 * one we used means another holder refreshed it: the answer to a refused
 * refresh is then that holder's session — and this call refreshes again with
 * that one. So two concurrent refreshes never send the same token, and neither
 * of them waits for the other.
 */
export function rotatedSession<T extends SessionTokens>(id: string, used: T): T | null {
  const current = getSecret<T>(id);
  if (!current) return null;
  if (current.refreshToken === used.refreshToken) return null;
  return current;
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

/** How a credential is wanted: now, when it is due, or only when it is dead. */
export type RefreshMode =
  /** Refresh right away, whatever the clock says. */
  | "now"
  /** Refresh when the token is about to expire — the timer wants this. */
  | "due"
  /** Refresh only when the token is already expired — a request wants this. */
  | "expired";

/** How `ensureCredential` gets the credential it hands out. */
export interface EnsureCredentialOptions<T extends SessionTokens> {
  /** The cache to read and to fill. */
  cache: CredentialCache | null;
  /** The cache setter — the caller keeps it in a module-level variable. */
  setCache: (cache: CredentialCache) => void;
  /** The region, for the upstreams that have more than one. */
  key?: string;
  /** How long a cached credential is reused. */
  cacheMs: number;
  /**
   * Who refreshes when.
   *
   * The refresh rotates the refresh token, so it is single-use: two refreshes
   * of the same session at the same time would make one of them fail. So the
   * mode says who refreshes when: the timer refreshes a token that is due
   * (`due`), a request waits for that and only refreshes a token that is
   * already dead (`expired`), and a rejected token is refreshed right away
   * (`now`).
   */
  mode: RefreshMode;
  /** The session id, which is also what the lock is named after. */
  lockId: string;
  /**
   * Refresh, or return the session when it is still good.
   *
   * The refresh rotates the refresh token, so it is single-use: two refreshes
   * of the same session at the same time would make one of them fail. So the
   * mode says who refreshes when: the timer refreshes when the token is due,
   * a request waits for that and only refreshes a token that is already dead.
   */
  refresh: (mode: RefreshMode) => Promise<T>;
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
  // A session the platform already refused is not worth asking again: every
  // request would cost a round trip and get the same answer.
  const dead = deadSession(opts.lockId);
  if (dead) throw new AuthError("session refused by the platform", dead, 503);
  const cached = opts.cache;
  const sameKey = opts.key === undefined || cached?.key === opts.key;
  if (opts.mode !== "now" && cached && sameKey && Date.now() - cached.at < opts.cacheMs) {
    return cached.cred;
  }
  const session = await opts.refresh(opts.mode);
  const cred = opts.toCredential(session);
  if (cred.remainingMs <= 0) throw opts.expired(session);
  opts.setCache({ at: Date.now(), cred, key: opts.key });
  return cred;
}
