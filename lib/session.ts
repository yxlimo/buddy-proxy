// lib/session.ts — the session file every client keeps, and the machinery around it.
//
// Each client logs in its own way and refreshes its own way — the endpoints,
// the request shapes and the error texts are all different. The parts around
// that are the same everywhere: where the file lives, how it is written, the
// lock that keeps two writers from rotating a refresh token twice, and the
// credential the upstream call is handed. That is what lives here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthError, type Credential } from "./credential.ts";
import { readEnvNumber, readEnvString } from "./env.ts";

/** The fields every session file has. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  generation?: number;
}

/** A lock file older than this counts as abandoned. */
const LOCK_STALE_MS = readEnvNumber("SESSION_LOCK_STALE_MS", 30_000);

/**
 * Where the sessions live: the environment override, else the mounted volume,
 * else the home directory.
 */
export function dataDirFor(envVar: string, fallback: string): string {
  const explicit = readEnvString(envVar, "");
  if (explicit) return explicit;
  return fs.existsSync("/data") ? "/data" : path.join(os.homedir(), fallback);
}

/** The default check: a session with both tokens in it. */
function hasTokens(raw: any): boolean {
  return !!raw?.accessToken && !!raw?.refreshToken;
}

/**
 * Read a session file; a broken file counts as no session.
 *
 * The check is a parameter because not every client keeps the same thing: the
 * token clients keep an access and a refresh token, TokenRhythm keeps a cookie.
 */
export function readSession<T>(file: string, valid: (raw: any) => boolean = hasTokens): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !valid(raw)) return null;
    return raw as T;
  } catch {
    return null;
  }
}

/** Atomic write, 0600 — this file is a credential, not configuration. */
export function writeSession(file: string, session: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Single-writer lock around a refresh. Two containers sharing the same volume would
 * otherwise rotate the refresh token twice and one of them would be logged out.
 */
export async function withSessionLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
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
    const existing = readSession<SessionTokens>(file);
    if (existing) return existing as unknown as T; // the other writer already landed its result
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
  /** The session file, which is also what the lock is named after. */
  lockFile: string;
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
  const session = await withSessionLock(opts.lockFile, () => opts.refresh(opts.force));
  const cred = opts.toCredential(session);
  if (cred.remainingMs <= 0) throw opts.expired(session);
  opts.setCache({ at: Date.now(), cred, key: opts.key });
  return cred;
}
