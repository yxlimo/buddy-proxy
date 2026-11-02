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

import { AuthError, authLog, tokenFingerprint, type Credential } from "./credential.ts";
import { dataDir } from "./paths.ts";
import { LockUnavailableError, getSecret, setSecret, withLock } from "./store.ts";

/** The fields every session file has. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  generation?: number;
}

/** The default check: a session with both tokens in it. */
export function hasTokens(raw: any): boolean {
  return !!raw?.accessToken && !!raw?.refreshToken;
}

/**
 * Read a session.
 *
 * 只有数据库这一处。会话曾经在文件里，那份文件不再认：文件在数据卷外面，
 * 删账号时它不会被删掉，于是删掉的账号转眼又带着旧会话回来。
 */
export function readSession<T>(id: string, valid: (raw: any) => boolean = hasTokens): T | null {
  const fromDb = getSecret<T>(id);
  if (fromDb) return valid(fromDb) ? fromDb : null;
  return null;
}

/** How to get rid of a credential and log in again. */
export function clearHint(id: string): string {
  return `清掉数据库里的这条凭据（node router-proxy.ts --clear ${id}）后重启，服务会重新登录`;
}

/**
 * Write a session.
 *
 * A session carries when it was logged in and which generation it is. A login
 * is newer than anything that came out of the previous login, and a refresh
 * inside one login is a generation later than the one before it.
 *
 * So the comparison is: the login time first, the generation second. That
 * keeps two things straight at once — a login is never blocked by the
 * session it replaces (its login time is later), and a refresh that raced
 * with another one does not overwrite the newer result (same login time, so
 * the generation decides).
 */
export function writeSession(id: string, session: unknown, options: { force?: boolean } = {}): boolean {
  deadSessions.delete(id);
  const stored = getSecret(id);
  if (!options.force && stored && !newer(stampOf(session), stampOf(stored))) return false;
  setSecret(id, "session", session);
  return true;
}

/**
 * How new a session is: when it was logged in, and which generation it is.
 */
function stampOf(session: unknown): [number, number] {
  if (!session || typeof session !== "object") return [0, 0];
  const s = session as { loginAtMs?: unknown; obtainedAtMs?: unknown; generation?: unknown };
  const login = Number(s.loginAtMs ?? s.obtainedAtMs ?? 0);
  const generation = Number(s.generation ?? 0);
  return [
    Number.isFinite(login) ? login : 0,
    Number.isFinite(generation) ? generation : 0,
  ];
}

/** Is the first stamp newer than the second? */
function newer(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] >= b[1];
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
 * 每份会话的「代」：账号删了（或注销了），这份会话在进程里的一切都作废。
 *
 * 各平台的凭据缓存是模块级的（lib/minimax/oauth.ts 那些 `let cache`），这里
 * 够不着；缓存里记着填它时的代，代变了 ensureCredential 就不认它。
 */
const sessionEpochs = new Map<string, number>();

/**
 * 忘掉进程里关于这份会话的一切：平台拒过的记号、各处缓存着的凭据。
 *
 * 删账号、注销时调（lib/admin/accounts.ts）。库里的那一行由调用方删。
 */
export function forgetSessionState(id: string): void {
  deadSessions.delete(id);
  sessionEpochs.set(id, (sessionEpochs.get(id) ?? 0) + 1);
}

// 换令牌的骨架（refreshSessionFlow）在 lib/session-refresh.ts：这里转出去，
// 调用方不用改。
export { refreshSessionFlow, type RefreshAnswer, type RefreshFlow } from "./session-refresh.ts";

/**
 * One writer at a time for a session.
 *
 * Two writers of the same session would each take a token from the platform
 * and the second one would be logged out. So a refresh takes this lock first
 * (lib/session-refresh.ts). A writer that cannot get it gets the session the
 * other writer is producing — what is stored under the id right now.
 */
export async function withSessionLock<T>(
  id: string,
  fn: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  try {
    return await withLock(id, fn, options);
  } catch (e) {
    if (!(e instanceof LockUnavailableError)) throw e;
    // Another writer is mid-way: its result is the session it wrote, so read
    // that and use it.
    const existing = getSecret<SessionTokens>(id);
    if (existing) {
      // 留一笔：这一轮没换令牌，交出去的是库里那一份（可能是临期的）。
      authLog(dataDir(), `${id} lock busy, using stored session`, `access ${tokenFingerprint(existing.accessToken)}`);
      // SAFETY: the lock is named after the session, so what is stored under
      // it is that session; T is the caller's view of it.
      return existing as unknown as T;
    }
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
  /** 填缓存时这份会话的代（见 forgetSessionState）。 */
  epoch?: number;
}

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
  /** The session id. */
  lockId: string;
  /**
   * The session as it is now.
   *
   * Nobody refreshes here: the timer does that, and it does it before the
   * token runs out. A request that finds an expired token says so — it does
   * not swap the token itself, because the refresh token is single-use and two
   * refreshes of the same session at the same time cost the whole session.
   */
  session: () => T | null;
  /** The credential, built from the session. */
  toCredential: (session: T) => Credential;
  /** The error to raise when there is no session, or it is expired. */
  expired: (session: T | null) => AuthError;
}

/**
 * The credential for the proxy: the cached one when it is still fresh,
 * otherwise the session as it is.
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
  const epoch = sessionEpochs.get(opts.lockId) ?? 0;
  if (cached && sameKey && (cached.epoch ?? 0) === epoch && Date.now() - cached.at < opts.cacheMs) {
    return cached.cred;
  }
  const session = opts.session();
  const cred = session ? opts.toCredential(session) : null;
  if (!cred || cred.remainingMs <= 0) throw opts.expired(session);
  opts.setCache({ at: Date.now(), cred, key: opts.key, epoch });
  return cred;
}
