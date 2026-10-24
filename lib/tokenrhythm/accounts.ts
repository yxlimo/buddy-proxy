// lib/tokenrhythm/accounts.ts — the TokenRhythm accounts.
//
// TokenRhythm is a relay station: one account, one wallet, one inference key.
// The wallet is only readable with the session cookie, and the session comes
// from a login with the account and password — the proxy does that itself and
// keeps the cookie on this machine, so the browser and CookieCloud are not in
// the way.
//
// The credentials live in the environment, one set per tenant:
//
//   TOKEN_RHYTHM_1_ACCOUNT=...
//   TOKEN_RHYTHM_1_PASSWORD=...
//   TOKEN_RHYTHM_1_API_KEY=sk_tr_...      (the key the inference uses)
//
// The account and the password are for the wallet; the key is for the
// inference. They are different things on the platform: the key cannot read
// the wallet, and the session cannot call the models.
//
// Those environment variables belong to the built-in provider ("tokenrhythm").
// Every provider has its own tenants: the accounts live under
// `key:provider:<id>:tenant-<n>`, and the cookie sessions live in the
// provider's own session — one entry per tenant.

import { configString } from "../config.ts";
import { readEnvValue } from "../env.ts";
import fs from "node:fs";
import { legacyPaths, writeSession } from "../session.ts";
import { dataDir as sharedDataDir } from "../paths.ts";
import { deleteSecret, getSecret, setSecret } from "../store.ts";
import { providerSecretId } from "../providers.ts";

export const TOKENRHYTHM_API_BASE = configString("TOKENRHYTHM_API_BASE", "https://tokenrhythm.studio").replace(/\/+$/, "");
export const TOKENRHYTHM_INFER_BASE = configString("TOKENRHYTHM_INFER_BASE", `${TOKENRHYTHM_API_BASE}/v1`).replace(/\/+$/, "");

/** The built-in provider: the tenants in the environment are its. */
const BUILT_IN = "tokenrhythm";

/** One account, and the key that belongs to it. */
export interface TokenRhythmTenant {
  /** The number in the environment variable names. */
  index: number;
  account: string;
  password: string;
  /** The key the inference uses, when it is configured. */
  apiKey: string | null;
}

/** How many tenants the environment may hold. */
const MAX_TENANTS = 32;

/**
 * The tenants, in order.
 *
 * The account and the password are what log in; the key is what the inference
 * uses. All three are credentials, so the environment wins: a key that was
 * rotated in .env has to take effect. The database holds a copy, so the
 * service still works when the .env file is not there.
 *
 * The environment belongs to the built-in provider only: another provider has
 * its own tenants, and it must not borrow these.
 */
export function tokenRhythmTenants(providerId = BUILT_IN): TokenRhythmTenant[] {
  const out: TokenRhythmTenant[] = [];
  for (let index = 1; index <= MAX_TENANTS; index++) {
    const id = tokenRhythmTenantSecretId(index, providerId);
    // The old copy is read too: the tenants were stored before the providers
    // existed, and nobody should have to type them in again.
    const stored = storedTenant(index, providerId);
    const fromEnv = providerId === BUILT_IN;
    const account = (fromEnv ? readEnvValue(`TOKEN_RHYTHM_${index}_ACCOUNT`) : null) || stored?.account || "";
    const password = (fromEnv ? readEnvValue(`TOKEN_RHYTHM_${index}_PASSWORD`) : null) || stored?.password || "";
    const key = (fromEnv ? readEnvValue(`TOKEN_RHYTHM_${index}_API_KEY`) : null) || stored?.apiKey || "";
    if (!account || !password) continue;
    if (
      !stored ||
      stored.account !== account ||
      stored.password !== password ||
      (stored.apiKey ?? null) !== (key || null)
    ) {
      setSecret(id, "account", { account, password, apiKey: key || null });
    }
    out.push({ index, account, password, apiKey: key || null });
  }
  return out;
}

/** Where the account of a tenant is kept. */
export function tokenRhythmTenantSecretId(index: number, providerId = BUILT_IN): string {
  return providerSecretId(providerId, `tenant-${index}`);
}

/** Where the account of a tenant used to be kept. */
function legacyTenantId(index: number): string {
  return `account:tokenrhythm:${index}`;
}

/** The stored account of a tenant, wherever it is. */
export function storedTenant(
  index: number,
  providerId = BUILT_IN,
): { account: string; password: string; apiKey: string | null } | null {
  const stored = getSecret<{ account: string; password: string; apiKey: string | null }>(
    tokenRhythmTenantSecretId(index, providerId),
  );
  if (stored) return stored;
  // 旧的那份是全局的，所以只有内置的那个 provider 认它。
  if (providerId !== BUILT_IN) return null;
  return getSecret<{ account: string; password: string; apiKey: string | null }>(legacyTenantId(index));
}

/** The tenant with this number, if it is configured. */
export function tokenRhythmTenant(index: number, providerId = BUILT_IN): TokenRhythmTenant | null {
  return tokenRhythmTenants(providerId).find((t) => t.index === index) ?? null;
}

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

export interface TokenRhythmSession {
  index: number;
  /** The provider this session belongs to. */
  providerId: string;
  /** The cookies the session needs. */
  cookie: string;
  /** The CSRF token, for the writes that need it. */
  csrf: string;
  userId: string;
  name: string;
  obtainedAtMs: number;
  /** The cookie lives for thirty days. */
  expiresAtMs: number;
}

/** The tenant sessions of one provider, keyed by the tenant number. */
export type TokenRhythmTenantSessions = Record<string, TokenRhythmSession>;

export function dataDir(): string {
  return sharedDataDir();
}

/**
 * Where the session lives in the database.
 *
 * The session belongs to the provider, not to the tenant: the provider's own
 * session holds the sessions of all its tenants.
 */
export function sessionId(providerId = BUILT_IN): string {
  return providerSecretId(providerId);
}

/** Where the session used to live, while the migration is under way. */
export function legacySessionPath(index: number): string[] {
  return legacyPaths(`tokenrhythm-session.${index}.json`);
}

/** Where the session of a tenant used to live in the database. */
function legacySessionId(index: number): string {
  return `session:tokenrhythm:${index}`;
}

/** The tenant sessions of a provider, as they are in the database. */
function tenantSessions(providerId: string): TokenRhythmTenantSessions {
  const raw = getSecret<TokenRhythmTenantSessions>(sessionId(providerId));
  return raw && typeof raw === "object" ? raw : {};
}

/** Is this session one the platform would still accept? */
function validSession(raw: any): boolean {
  if (!raw?.cookie) return false;
  // The cookie lives for thirty days; an expired one is no session.
  if (typeof raw.expiresAtMs === "number" && raw.expiresAtMs < Date.now()) return false;
  // A session written before the CSRF value was read properly carries the
  // cookie's attributes with it ("…; Max-Age"). The platform would refuse
  // every write with it, so such a session is no session either.
  if (typeof raw.csrf === "string" && raw.csrf.includes(";")) return false;
  return true;
}

export function loadSession(index: number, providerId = BUILT_IN): TokenRhythmSession | null {
  const stored = tenantSessions(providerId)[String(index)] ?? null;
  if (stored && validSession(stored)) return stored;
  // The session used to have an id of its own: take it over once, so nobody
  // has to log in again because of the move. Those old ids were global, so
  // only the built-in provider takes them over.
  if (providerId !== BUILT_IN) return null;
  const legacy = getSecret<TokenRhythmSession>(legacySessionId(index));
  if (legacy && validSession(legacy)) {
    saveSession({ ...legacy, providerId }, providerId);
    return legacy;
  }
  return legacyFileSession(index, providerId);
}

/** The session of a tenant, from the file it used to live in. */
function legacyFileSession(index: number, providerId: string): TokenRhythmSession | null {
  for (const file of legacySessionPath(index)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object" || !validSession(raw)) continue;
      const session = { ...(raw as TokenRhythmSession), providerId };
      // The first read moves the session into the database.
      saveSession(session, providerId);
      return session;
    } catch {
      /* no such file */
    }
  }
  return null;
}

/** Atomic write, 0600 — this file is a credential. */
export function saveSession(session: TokenRhythmSession, providerId = BUILT_IN): void {
  const all = tenantSessions(providerId);
  all[String(session.index)] = session;
  writeSession(sessionId(providerId), all);
}

/** Forget the session of a tenant: the next call logs in again. */
export function forgetSession(index: number, providerId = BUILT_IN): void {
  const all = tenantSessions(providerId);
  if (!(String(index) in all)) return;
  delete all[String(index)];
  writeSession(sessionId(providerId), all);
  // The old copy is cleared too: otherwise it would come back. Those old ids
  // were global, so only the built-in provider touches them.
  if (providerId === BUILT_IN) deleteSecret(legacySessionId(index));
}

export class TokenRhythmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * 用一组账号密码登录一个租户，把会话拿回来（不存）。
 *
 * 环境变量里的那几份租户走 login()，面板上临时输的走这里。
 */
async function requestLogin(
  index: number,
  account: string,
  password: string,
  providerId: string,
): Promise<TokenRhythmSession> {
  const r = await fetch(`${TOKENRHYTHM_API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ account, password }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new TokenRhythmError(`登录失败（HTTP ${r.status}）：${text.slice(0, 200)}`, 502);
  }
  const jar = r.headers.getSetCookie?.() ?? [];
  const cookie = jar.map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("tr_session=")) {
    throw new TokenRhythmError("登录没有拿到会话 cookie", 502);
  }
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* the cookies are what matter */
  }
  return {
    index,
    providerId,
    cookie,
    // The cookie's value ends at the first ";" — the rest of the Set-Cookie
    // line is attributes ("Max-Age=…"), and splitting on "=" alone would keep
    // them in the value.
    csrf: cookieValue(jar, "tr_csrf"),
    userId: String(body?.data?.user?.id ?? ""),
    name: String(body?.data?.user?.name ?? ""),
    obtainedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000,
  };
}

/** Log in with the account and password, and keep the session. */
export async function login(tenant: TokenRhythmTenant, providerId = BUILT_IN): Promise<TokenRhythmSession> {
  const session = await requestLogin(tenant.index, tenant.account, tenant.password, providerId);
  saveSession(session, providerId);
  return session;
}

/**
 * 用面板给的账号密码登录一个租户。
 *
 * 这个文件里的 login() 只认环境变量里的那几份租户；面板上输的是另一组账号
 * 密码，所以这里单独走一遍：登录、存会话、记下账号。
 *
 * 「记住密码」：记住了就把密码也存进 secrets（.env 不在了也能自动登录），
 * 没记住就只记账号 —— 密码不进数据库。
 */
export async function loginWithCredentials(
  index: number,
  account: string,
  password: string,
  remember = true,
  providerId = BUILT_IN,
): Promise<TokenRhythmSession> {
  const session = await requestLogin(index, account, password, providerId);
  saveSession(session, providerId);
  const id = tokenRhythmTenantSecretId(index, providerId);
  const stored = getSecret<{ account: string; password: string; apiKey: string | null }>(id);
  setSecret(id, "account", {
    account,
    password: remember ? password : "",
    apiKey: stored?.apiKey ?? null,
  });
  return session;
}

/** The value of one cookie in a Set-Cookie list. */
export function cookieValue(jar: string[], name: string): string {
  const hit = jar.find((c) => c.startsWith(`${name}=`));
  if (!hit) return "";
  return hit.split(";")[0].split("=").slice(1).join("=");
}

/**
 * The headers a write request needs.
 *
 * The platform checks three things on a POST: the session cookie, a CSRF
 * token sent twice — once as the `tr_csrf` cookie, once as the
 * `X-CSRF-Token` header — and the browser's fetch metadata. The last one
 * is why a plain `fetch` from a script is refused: the header says the
 * request came from the page itself, and a cross-site page cannot fake it.
 * The browser sets `Sec-Fetch-Site`; a script has to say it itself.
 */
export function writeHeaders(session: TokenRhythmSession): Record<string, string> {
  return {
    Accept: "application/json",
    "content-type": "application/json",
    Cookie: session.cookie,
    "X-CSRF-Token": session.csrf,
    "Sec-Fetch-Site": "same-origin",
    Origin: TOKENRHYTHM_API_BASE,
  };
}

/** The session for a tenant: the stored one, or a fresh login. */
export async function sessionFor(index: number, providerId = BUILT_IN): Promise<TokenRhythmSession> {
  const stored = loadSession(index, providerId);
  if (stored) return stored;
  const tenant = tokenRhythmTenant(index, providerId);
  if (!tenant) throw new TokenRhythmError(`没有配置第 ${index} 个租户`, 500);
  return login(tenant, providerId);
}
