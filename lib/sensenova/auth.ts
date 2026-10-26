// lib/sensenova/auth.ts — 登录、拿会话、换 token。
//
// SenseNova 的登录不是「一个 POST 换 token」，是一条四步的链：
//
//   1. GET  {platform}/oauth2/auth?…      → 302，带出 login_challenge
//   2. POST {iam}/v1/auth/nova/login      → 账号密码换回一个「继续登录」的地址
//   3. GET  那个地址                       → 302 → 同意页 → 302 → 带 code 回来
//   4. POST {platform}/oauth2/token        → code 换 token
//
// 第 1 步和第 4 步是一对 PKCE：第 1 步送上 code_challenge，第 4 步要带上
// 当时那个 code_verifier，所以 verifier 得留着，不能每次现生成。
//
// 值得记一笔的两件事：
//
//   - 密码可以明文发。浏览器那一版会用控制台公开的 JWKS 把密码 JWE 加密
//     （is_encrypt=true），但服务端两种都收，明文那一条最省事。密码不经过
//     别人的服务器，也省掉了依赖一个会变的公钥。
//   - 没有验证码，也没有二次验证。账号密码对了就给会话。
//
// 会话存在数据库里（lib/store.ts 的 secrets 表），跟别的上游一样。
// 刷新走 lib/session.ts 的锁：refresh_token 是轮换的，两个进程同时刷新，
// 后一个拿到的就是作废的那张票。

import crypto from "node:crypto";
import {
  SENSENOVA_CLIENT_ID,
  SENSENOVA_IAM_BASE,
  SENSENOVA_PLATFORM_BASE,
  senseNovaApiKey,
  senseNovaCredentials,
} from "./config.ts";
import { readSession, withSessionLock, writeSession } from "../session.ts";
import { deleteSecret, getSecret, setSecret } from "../store.ts";
import { tokenFingerprint } from "../credential.ts";
import { providerSecretId } from "../providers.ts";

/**
 * 会话在数据库里的名字。
 *
 * 会话归 provider 所有：两个 SenseNova 账号各有各的会话。
 */
export function sessionId(providerId = "sensenova"): string {
  return providerSecretId(providerId);
}

/**
 * 账号信息在数据库里的名字。
 *
 * 账号（账号密码与那把推理 key）也归 provider 所有。
 */
export function accountId(providerId = "sensenova"): string {
  return providerSecretId(providerId, "account");
}

/** 内置的那个 provider 的会话在数据库里的名字。 */
export const SESSION_ID = sessionId();

/** 内置的那个 provider 的账号信息在数据库里的名字。 */
export const ACCOUNT_ID = accountId();

/** 数据库里那份账号信息的样子。 */
export interface StoredAccount {
  user?: string;
  password?: string;
  /** 账号上的推理 key（新建的时候存下来，完整的值只出现一次）。 */
  apiKey?: string | null;
}

/**
 * 读这个 provider 的账号信息。
 *
 * 旧的那份也认：账号信息是在 provider 这件事之前存的，搬一次，别让人重新登。
 */
export function storedAccount(providerId = "sensenova"): StoredAccount | null {
  const stored = getSecret<StoredAccount>(accountId(providerId));
  if (stored) return stored;
  // 旧的那份是全局的，所以只有内置的那个 provider 认它。
  return null;
}

/** 多久算快到期（毫秒）。到了就用刷新换新的。 */
const REFRESH_SKEW_MS = 60_000;

/** 面板上的「快到期」提示线（毫秒）。 */
const WARN_MS = 5 * 60 * 1000;

/** 这个会话长什么样。 */
export interface SenseNovaSession {
  /** 登录时发的 cookie（oauth2_authentication_session 那几个）。 */
  cookie: string;
  accessToken: string;
  refreshToken: string;
  /** access token 的到期时刻，毫秒。 */
  expiresAtMs: number;
  /** 拿到这个会话的时刻，毫秒。 */
  obtainedAtMs: number;
  /** 登录用的账号，只用来显示。 */
  username: string;
}

/** 出错的时候分什么类，调用方靠它决定是重试还是重新登录。 */
export type SenseNovaErrorKind = "auth" | "forbidden" | "rate" | "request" | "upstream" | "config";

/** SenseNova 的错误。`message` 是给人看的中文。 */
export class SenseNovaError extends Error {
  kind: SenseNovaErrorKind;
  status: number;

  constructor(kind: SenseNovaErrorKind, message: string, status = 502) {
    super(message);
    this.name = "SenseNovaError";
    this.kind = kind;
    this.status = status;
  }
}

/** PKCE 的一对值。 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * 造一对 PKCE 值。
 *
 * challenge 是 verifier 的 SHA-256，base64url（不是 base64：URL 里要能直接放）。
 */
export function pkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(50).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** 从 Set-Cookie 列表里取出一个 cookie 的值。 */
export function cookieValue(setCookies: string[], name: string): string {
  for (const line of setCookies) {
    const pair = line.split(";")[0] ?? "";
    if (!pair.startsWith(`${name}=`)) continue;
    return pair.slice(name.length + 1);
  }
  return "";
}

/** 把 Set-Cookie 列表变成一个 Cookie 头。 */
export function cookieHeader(setCookies: string[]): string {
  const out: string[] = [];
  for (const line of setCookies) {
    const pair = line.split(";")[0] ?? "";
    if (!pair.includes("=")) continue;
    out.push(pair);
  }
  return out.join("; ");
}

/** 从跳回来的地址里取出登录用的 challenge。 */
export function loginChallengeFrom(location: string): string {
  try {
    return new URL(location).searchParams.get("login_challenge") ?? "";
  } catch {
    return "";
  }
}

/** 从跳回来的地址里取出授权码。 */
export function codeFrom(location: string): string {
  try {
    return new URL(location).searchParams.get("code") ?? "";
  } catch {
    return "";
  }
}

/** 登录时发给身份服务的那份请求体。 */
export function loginBody(user: string, password: string, challenge: string): Record<string, unknown> {
  // is_encrypt=false：密码明文发。服务端两种都收，明文这条少一层依赖。
  return { username: user, password, challenge, is_encrypt: false };
}

/** 一次 fetch 的统一超时。控制台接口不快，但也不该无限等。 */
const TIMEOUT_MS = 20_000;

/** 发一个请求，把跳转发成「不自动跟」。 */
async function hop(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Accept: "application/json, text/html",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * 把状态码和响应体归成一种错误。
 *
 * 平台的错误信封有两种：控制台那边是
 * {"code":16,"details":[{"reason":…,"message":…}]}，推理端点是
 * {"error":{"code":16,"message":…}}。两种都要读得出人话。
 */
export function classify(status: number, body: any, what: string): SenseNovaError {
  const details = Array.isArray(body?.details) ? body.details : [];
  const reason = String(details.find((d: any) => d?.reason)?.reason ?? "");
  const localized = String(details.find((d: any) => d?.message)?.message ?? "");
  const message = String(body?.message ?? body?.error_description ?? body?.error ?? localized ?? "").slice(0, 200);
  const tail = reason ? `（${reason}）` : message ? `：${message}` : "";
  if (status === 401) {
    return new SenseNovaError("auth", `${what}：会话已过期或没带对（HTTP 401）${tail}`, 503);
  }
  if (status === 403) {
    return new SenseNovaError("forbidden", `${what}：没有权限（HTTP 403）${tail}`);
  }
  if (status === 429) {
    return new SenseNovaError("rate", `${what}：被限流了（HTTP 429），稍后再试`);
  }
  if (status === 400 || status === 422) {
    return new SenseNovaError("request", `${what}：请求被拒（HTTP ${status}）${tail}`);
  }
  if (status === 404) {
    return new SenseNovaError("request", `${what}：接口不存在（HTTP 404）`);
  }
  return new SenseNovaError("upstream", `${what}：上游返回 HTTP ${status}${tail}`);
}

/** 登录。用账号密码换一份会话，并把会话存进数据库。 */
export async function login(user?: string, password?: string, providerId = "sensenova"): Promise<SenseNovaSession> {
  const creds = senseNovaCredentials({ user, password }, storedAccount(providerId));
  if (!creds.user || !creds.password) {
    throw new SenseNovaError("config", "没有配置 SenseNova 的账号密码（SENSENOVA_USER / SENSENOVA_PASSWORD）", 500);
  }

  const { codeVerifier, codeChallenge } = pkcePair();
  const state = crypto.randomBytes(8).toString("hex");
  const cookies = new CookieJar();

  // 第 1 步：进 OAuth2 的门，门里给一个 login_challenge。
  const authUrl =
    `${SENSENOVA_PLATFORM_BASE}/oauth2/auth?response_type=code&client_id=${encodeURIComponent(SENSENOVA_CLIENT_ID)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(SENSENOVA_PLATFORM_BASE)}` +
    `&scope=openid%20offline%20offline_access&state=${state}&lang=zh-CN`;
  const r1 = await hop(authUrl);
  cookies.remember(r1, authUrl);
  const firstLocation = r1.headers.get("location");
  if (!firstLocation) {
    throw new SenseNovaError("upstream", "登录失败：OAuth2 的入口没有给出跳转地址");
  }
  const challenge = loginChallengeFrom(firstLocation);
  if (!challenge) {
    throw new SenseNovaError("upstream", "登录失败：跳转地址里没有 login_challenge");
  }

  // 第 2 步：账号密码换一个「继续登录」的地址。
  const loginUrl = `${SENSENOVA_IAM_BASE}/iam/authn/v1/auth/nova/login`;
  const r2 = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    body: JSON.stringify(loginBody(creds.user, creds.password, challenge)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body2 = await readJson(r2);
  if (!r2.ok) {
    throw classify(r2.status, body2, "登录失败");
  }
  if (!body2?.redirect) {
    throw new SenseNovaError("upstream", "登录失败：身份服务没有返回继续登录的地址");
  }

  // 第 3 步：跟着那个地址走完同意页，最后带着授权码回来。
  const code = await followToCode(body2.redirect, cookies);
  if (!code) {
    throw new SenseNovaError("upstream", "登录失败：走完登录流程没有拿到授权码");
  }

  // 第 4 步：授权码换 token。
  const tokens = await exchangeCode(code, codeVerifier, state);
  const session: SenseNovaSession = {
    cookie: cookies.all(),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAtMs: Date.now() + Math.max(60, Number(tokens.expires_in ?? 3600)) * 1000,
    obtainedAtMs: Date.now(),
    username: creds.user,
  };
  saveSession(session, providerId);
  // 账号密码也存一份：.env 不在了还能登录。
  const stored = storedAccount(providerId);
  setSecret(accountId(providerId), "account", {
    user: creds.user,
    password: creds.password,
    apiKey: stored?.apiKey ?? null,
  });
  return session;
}

/** 跟着登录的尾巴走到授权码出现为止。 */
async function followToCode(start: string, cookies: CookieJar): Promise<string> {
  let url = start;
  for (let step = 0; step < 8; step++) {
    const r = await hop(url, { headers: { Cookie: cookies.forUrl(url) } });
    cookies.remember(r, url);
    const location = r.headers.get("location");
    if (!location) {
      // 没有跳转就是走到了尽头：地址里带 code 就是成了。
      return codeFrom(url);
    }
    url = location;
    const code = codeFrom(url);
    if (code) return code;
  }
  return "";
}

/** 授权码换 token。 */
async function exchangeCode(code: string, codeVerifier: string, state: string): Promise<any> {
  const r = await fetch(`${SENSENOVA_PLATFORM_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: SENSENOVA_CLIENT_ID,
      code,
      redirect_uri: SENSENOVA_PLATFORM_BASE,
      code_verifier: codeVerifier,
      state,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(r);
  if (!r.ok || !body?.access_token) {
    throw classify(r.status, body, "换 token 失败");
  }
  return body;
}

/** 用 refresh_token 换一份新会话。 */
export async function refreshSession(session: SenseNovaSession, providerId = "sensenova"): Promise<SenseNovaSession> {
  const r = await fetch(`${SENSENOVA_PLATFORM_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SENSENOVA_CLIENT_ID,
      refresh_token: session.refreshToken,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(r);
  if (!r.ok || !body?.access_token) {
    throw classify(r.status, body, "刷新会话失败");
  }
  const next: SenseNovaSession = {
    ...session,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? session.refreshToken,
    expiresAtMs: Date.now() + Math.max(60, Number(body.expires_in ?? 3600)) * 1000,
    obtainedAtMs: Date.now(),
  };
  saveSession(next, providerId);
  return next;
}

/** 会话还在不在。 */
export function sessionValid(session: SenseNovaSession | null): session is SenseNovaSession {
  if (!session?.accessToken || !session.refreshToken) return false;
  return session.expiresAtMs > Date.now();
}

/** 数据库里的会话。 */
export function loadSession(providerId = "sensenova"): SenseNovaSession | null {
  const valid = (raw: any) => !!raw?.accessToken && !!raw?.refreshToken;
  return readSession<SenseNovaSession>(sessionId(providerId), valid);
}

/** 存会话。 */
export function saveSession(session: SenseNovaSession, providerId = "sensenova"): void {
  writeSession(sessionId(providerId), session);
}

/** 忘掉会话：下一次调用会重新登录。 */
export function clearSession(providerId = "sensenova"): void {
  try {
    deleteSecret(sessionId(providerId));
  } catch {
    /* 没什么可清的了 */
  }
}

/**
 * 能用的会话：先看数据库里的，快到期就刷新，刷新不了就重新登录。
 *
 * 全程拿着锁：refresh_token 是轮换的，两个进程同时刷新，
 * 后一个拿到的是作废的票。
 */
export async function sessionFor(providerId = "sensenova"): Promise<SenseNovaSession> {
  return withSessionLock(sessionId(providerId), async () => {
    const stored = loadSession(providerId);
    if (stored && stored.expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
      return stored;
    }
    if (stored) {
      try {
        return await refreshSession(stored, providerId);
      } catch (e) {
        // 刷新失败多半是会话没了，重新登录。
        if (!(e instanceof SenseNovaError) || e.kind !== "auth") throw e;
      }
    }
    return login(undefined, undefined, providerId);
  });
}

/**
 * 面板上用的凭据状态。
 *
 * 干活的是那把推理 key：没有它，登录了也一个请求也发不出去。所以这里报的是
 * key，会话的情况另放在 sessionStatus 里。
 */
export function senseNovaStatus(providerId = "sensenova"): Record<string, unknown> {
  const stored = storedAccount(providerId);
  const key = senseNovaApiKey(stored?.apiKey);
  const session = loadSession(providerId);
  const remainingMs = session ? session.expiresAtMs - Date.now() : 0;
  return {
    source: sessionId(providerId),
    status: key ? "authenticated" : "missing",
    fingerprint: key ? tokenFingerprint(key) : "",
    detail: key ? "推理用的 API key" : "账号上没有推理用的 API key，登录后网关会建一把",
    sessionStatus: !session ? "anonymous" : remainingMs > 0 ? "authenticated" : "expired",
    username: session?.username ?? stored?.user ?? "",
    expiresAt: session ? new Date(session.expiresAtMs).toISOString() : "",
    remainingSec: Math.round(remainingMs / 1000),
    warning: remainingMs > 0 && remainingMs < WARN_MS,
    obtainedAt: session ? new Date(session.obtainedAtMs).toISOString() : "",
  };
}

/**
 * 一个按域名分的 cookie 罐子。
 *
 * 登录这条链要经过两个域名：控制台（platform）和身份服务（iam）。cookie
 * 是跟着域名走的，把控制台的会话 cookie 发给身份服务没有必要，所以按域名
 * 分开放。
 */
class CookieJar {
  private byHost = new Map<string, Map<string, string>>();

  /** 把回答里的 Set-Cookie 收进来。 */
  remember(res: Response, url: string): void {
    const host = hostOf(url);
    if (!this.byHost.has(host)) this.byHost.set(host, new Map());
    const jar = this.byHost.get(host)!;
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  /** 某个地址该带哪些 cookie。 */
  forUrl(url: string): string {
    const jar = this.byHost.get(hostOf(url));
    if (!jar?.size) return "";
    return cookieHeader([...jar.entries()].map(([k, v]) => `${k}=${v}`));
  }

  /** 全部 cookie（存进会话时用）。 */
  all(): string {
    const out: string[] = [];
    for (const jar of this.byHost.values()) {
      for (const [k, v] of jar.entries()) out.push(`${k}=${v}`);
    }
    return cookieHeader(out);
  }
}

/** 一个地址的域名。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 读一个 JSON 响应，读不出来就当它没有内容。 */
async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
