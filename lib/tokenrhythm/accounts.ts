// lib/tokenrhythm/accounts.ts — the TokenRhythm account: one row, one wallet.
//
// TokenRhythm is a relay station: one account, one wallet, one inference key.
// The wallet is only readable with the session cookie, and the session comes
// from a login with the account and password — the proxy does that itself and
// keeps the cookie on this machine, so the browser and CookieCloud are not in
// the way.
//
// Every account is a row of the provider table (lib/providers.ts), the same as
// on every other platform: the platform says how to talk to it, a row is one
// login. There is no "tenant number" any more — that was the shape before the
// account model, when one platform row had to carry several logins.
//
// An account row owns two secrets:
//
//   key:provider:<account>:account      { account, password, apiKey }
//   session:provider:<account>          the wallet cookie
//
// The account and the password are for the wallet; the key is for the
// inference. They are different things on the platform: the key cannot read
// the wallet, and the session cannot call the models.
//
// The old shape is read once and moved over on the way (see `legacyIndex`):
// the tenants used to live on the platform row, numbered in their ids
// (`key:provider:tokenrhythm:tenant-2`, `account:tokenrhythm:2`) and in the
// environment (`TOKEN_RHYTHM_2_*`). Those numbers map to the account rows the
// account model gives them: 1 → `tokenrhythm`, 2 → `tokenrhythm-2`, …

import { configString } from "../config.ts";
import fs from "node:fs";
import { legacyPaths, writeSession } from "../session.ts";
import { dataDir as sharedDataDir } from "../paths.ts";
import { deleteSecret, getSecret, setSecret } from "../store.ts";
import { addAccount, provider, providerSecretId } from "../providers.ts";

export const TOKENRHYTHM_API_BASE = configString("TOKENRHYTHM_API_BASE", "https://tokenrhythm.studio").replace(/\/+$/, "");
export const TOKENRHYTHM_INFER_BASE = configString("TOKENRHYTHM_INFER_BASE", `${TOKENRHYTHM_API_BASE}/v1`).replace(/\/+$/, "");

/** The platform id. Also the id of the account row the first tenant lands on. */
const PLATFORM = "tokenrhythm";

/** One account: what logs in, and the key the inference uses. */
export interface TokenRhythmCredential {
  account: string;
  password: string;
  /** The key the inference uses, when it is configured. */
  apiKey: string | null;
}

/** Where the credentials of an account live. */
export function tokenRhythmCredentialSecretId(accountId: string): string {
  return providerSecretId(accountId, "account");
}

/** The account id that a tenant number of the old shape became. */
function accountIdOfIndex(index: number): string {
  return index === 1 ? PLATFORM : `${PLATFORM}-${index}`;
}

/**
 * 旧租户号（1、2、3……）的凭据存在哪。
 *
 * 只读：启动时归位（lib/store.ts 的 migrateTokenRhythmTenants）已经把旧的搬
 * 到账号行上并删掉了旧的。这里留着是给还没归位的旧库兜底。
 */
function legacyCredentialIds(index: number): string[] {
  return [providerSecretId(PLATFORM, `tenant-${index}`), `account:tokenrhythm:${index}`];
}

/** 旧位置的一份凭据（只读，不搬）。 */
function legacyCredentialOf(index: number): TokenRhythmCredential | null {
  for (const id of legacyCredentialIds(index)) {
    const raw = getSecret<Partial<TokenRhythmCredential>>(id);
    if (!raw) continue;
    const credential = normalize(raw);
    if (credential.account || credential.apiKey) return credential;
  }
  return null;
}

/**
 * The tenant number an account id came from.
 *
 * The old ids were numbered; the account ids the account model gives them keep
 * that number (`tokenrhythm`, `tokenrhythm-2`).
 */
function legacyIndex(accountId: string): number | null {
  if (accountId === PLATFORM) return 1;
  const match = new RegExp(`^${PLATFORM}-(\\d+)$`).exec(accountId);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

/**
 * 账号行的凭据。
 *
 * 旧库里的凭据按租户号存着（`account:tokenrhythm:2`……）。那些在启动时已经
 * 归位到账号行上了（见 lib/store.ts 的 migrateTokenRhythmTenants）：搬完旧的
 * 就删掉，所以这里只读新位置。
 *
 * 早先这里是「读到旧的就搬过来」—— 那会让**新建**的账号继承一个旧租户的
 * 身份（账号 id 恰好也是 `tokenrhythm-2`）：不是新建，那是接管。
 */
export function tokenRhythmCredentialOf(accountId: string): TokenRhythmCredential | null {
  const id = tokenRhythmCredentialSecretId(accountId);
  const stored = getSecret<Partial<TokenRhythmCredential>>(id);
  return stored ? normalize(stored) : null;
}

/** 存一个账号的凭据。没给的字段保持原样。 */
export function saveTokenRhythmCredential(
  accountId: string,
  patch: Partial<TokenRhythmCredential>,
): TokenRhythmCredential {
  const id = tokenRhythmCredentialSecretId(accountId);
  const stored = getSecret<Partial<TokenRhythmCredential>>(id);
  const next: TokenRhythmCredential = {
    account: patch.account ?? String(stored?.account ?? ""),
    password: patch.password ?? String(stored?.password ?? ""),
    apiKey: patch.apiKey === undefined ? (stored?.apiKey ?? null) : patch.apiKey,
  };
  setSecret(id, "account", next);
  return next;
}

function normalize(raw: Partial<TokenRhythmCredential>): TokenRhythmCredential {
  return {
    account: String(raw.account ?? ""),
    password: String(raw.password ?? ""),
    apiKey: raw.apiKey ? String(raw.apiKey) : null,
  };
}

/** 这行在不在。 */
function accountRowExists(id: string): boolean {
  // 只看 secrets 之外的真相：provider 表。用 providers.ts 的读取函数，别自己查表。
  return provider(id) !== null;
}

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

export interface TokenRhythmSession {
  /** The account row this session belongs to. */
  accountId: string;
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

export function dataDir(): string {
  return sharedDataDir();
}

/** Where the session of an account lives. */
export function sessionId(accountId: string): string {
  return providerSecretId(accountId);
}

/** Where the sessions used to live, before they moved into the database. */
export function legacySessionPath(index: number): string[] {
  return legacyPaths(`tokenrhythm-session.${index}.json`);
}

/** Where a tenant's session used to live, as a row of its own. */
function legacySessionId(index: number): string {
  return `session:tokenrhythm:${index}`;
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

/**
 * 一个账号的会话。
 *
 * 旧库里会话是一张表（一个 provider 一行，按租户号分格），现在一个账号一行。
 * 读到表就整张搬一遍 —— 只搬当前这一格的话，别的租户那一格会被这次的写入盖
 * 掉，它们就得重新登录。
 */
export function loadSession(accountId: string): TokenRhythmSession | null {
  const id = sessionId(accountId);
  const raw = getSecret<any>(id);
  if (raw && typeof raw.cookie === "string") {
    const session = { ...(raw as TokenRhythmSession), accountId };
    return validSession(session) ? session : null;
  }
  const index = legacyIndex(accountId);
  if (index === null) return null;
  const legacy = raw && typeof raw === "object" ? raw[String(index)] : null;
  if (legacy && validSession(legacy)) {
    adoptLegacySessionTable(raw);
    const session = { ...(legacy as TokenRhythmSession), accountId };
    return session;
  }
  const taken = takeOverLegacySession(index, accountId);
  return taken;
}

/**
 * 整张旧的会话表搬到各账号行上。
 *
 * 格子的编号就是账号的编号（1 → `tokenrhythm`、2 → `tokenrhythm-2`）。
 */
function adoptLegacySessionTable(table: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(table ?? {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index <= 0) continue;
    if (!validSession(entry)) continue;
    const target = accountIdOfIndex(index);
    writeSession(
      sessionId(target),
      { ...(entry as TokenRhythmSession), accountId: target },
      { force: true },
    );
  }
}

/** The session of a tenant from the places it used to live. */
function takeOverLegacySession(index: number, accountId: string): TokenRhythmSession | null {
  const legacy = getSecret<TokenRhythmSession>(legacySessionId(index));
  if (legacy && validSession(legacy)) {
    const session = { ...legacy, accountId };
    saveSession(session, { force: true });
    deleteSecret(legacySessionId(index));
    return session;
  }
  for (const file of legacySessionPath(index)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object" || !validSession(raw)) continue;
      const session = { ...(raw as TokenRhythmSession), accountId };
      // The first read moves the session into the database.
      saveSession(session, { force: true });
      return session;
    } catch {
      /* no such file */
    }
  }
  return null;
}

/** Atomic write, 0600 — this file is a credential. */
export function saveSession(
  session: TokenRhythmSession,
  options: { force?: boolean } = {},
): void {
  writeSession(sessionId(session.accountId), session, options);
}

/** Forget the session of an account: the next call logs in again. */
export function forgetSession(accountId: string): void {
  if (getSecret(sessionId(accountId))) deleteSecret(sessionId(accountId));
  const index = legacyIndex(accountId);
  if (index !== null && getSecret(legacySessionId(index))) deleteSecret(legacySessionId(index));
}

/**
 * 注销：把这个账号的凭据全删掉，旧的那一份也删。
 *
 * 旧的那一份要删，否则下一次读又把它搬冐来 —— 面板上「注销」过的账号会自己
 * 带着登录态回来。
 */
export function forgetTokenRhythmCredential(accountId: string): number {
  const ids = [tokenRhythmCredentialSecretId(accountId), sessionId(accountId)];
  const index = legacyIndex(accountId);
  if (index !== null) ids.push(...legacyCredentialIds(index), legacySessionId(index));
  let removed = 0;
  for (const id of ids) {
    if (!getSecret(id)) continue;
    deleteSecret(id);
    removed++;
  }
  return removed;
}

export class TokenRhythmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * 用一组账号密码登录，把会话拿回来（不存）。
 *
 * 存着的凭据走 login()，面板上临时输的走 loginWithCredentials()。
 */
async function requestLogin(
  accountId: string,
  account: string,
  password: string,
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
    accountId,
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

/** Log in with the stored account and password, and keep the session. */
export async function login(accountId: string): Promise<TokenRhythmSession> {
  const credential = tokenRhythmCredentialOf(accountId);
  if (!credential?.account || !credential.password) {
    throw new TokenRhythmError(`账号 ${accountId} 没有配置登录账号`, 500);
  }
  return loginWithCredentials(accountId, credential.account, credential.password);
}

/**
 * 用面板给的账号密码登录。
 *
 * 「记住密码」：记住了就把密码也存进 secrets（新部署没有 .env 也能自动登录），
 * 没记住就只记账号 —— 密码不进数据库。
 */
export async function loginWithCredentials(
  accountId: string,
  account: string,
  password: string,
  remember = true,
): Promise<TokenRhythmSession> {
  const session = await requestLogin(accountId, account, password);
  saveSession(session, { force: true });
  const stored = tokenRhythmCredentialOf(accountId);
  saveTokenRhythmCredential(accountId, {
    account,
    password: remember ? password : stored?.password ?? "",
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

/** The session for an account: the stored one, or a fresh login. */
export async function sessionFor(accountId: string): Promise<TokenRhythmSession> {
  const stored = loadSession(accountId);
  if (stored) return stored;
  return login(accountId);
}
