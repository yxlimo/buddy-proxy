// lib/intern-ai/auth.ts — 登录、换授权码、存会话。
//
// intern-ai 自己不收账号密码：账号在 openxlab（sso.openxlab.org.cn），登录成
// 功以后，SSO 发一个 `uaa-token` 的会话 cookie；两个子站再拿这个 cookie 去
// 换自己的 token（就是控制台接口要的那个 Bearer token）。
//
// 所以登录是三段，不是一段：
//
//   ① POST {sso}/gw/uaa-be/api/v1/cipher/getPubKey   → 拿 RSA 公钥
//   ② POST {sso}/gw/uaa-be/api/v1/login/byAccount      → 账号密码换 SSO 会话
//      （密码要先用公钥加密；而且这一步要过一次人机校验，见下）
//   ③ POST {sso}/gw/uaa-be/api/v1/internal/auth        → 换应用授权码
//      POST {子站}/…/users/auth                         → 授权码换子站 token
//
// 关于人机校验，这是本次调研最要紧的一条结论：
//
//   ② 这一步服务端**强制**要人机校验的三个头（captchaVerifyParam / sceneId /
//   prefix）。不带就回 msgCode=B0501「Human verification failed」；带一个假的
//   也回 B0501。这不是客户端的礼貌，是服务端的硬要求——绕过它不是「换个请求
//   形状」能解决的。
//
//   平台用的是阿里云的「无感验证」：页面上一个「确认您不是机器人」的勾选框，
//   背后是风控打分。真人点一下就能过。自动化浏览器（哪怕把 navigator.webdriver
//   改成 false、把 UA 里的 HeadlessChrome 抹掉、鼠标轨迹做成弧线）仍然被判
//   F001。所以这一段**必须有人在浏览器里点一下**。
//
//   因此本模块不假装自己能登录。它做的是：
//     - 把 ①②③ 的每一步都实现了，形状和真前端一模一样；
//     - 人机校验的三个值可以由外部传进来（浏览器辅助的那一次），传进来就
//       能一路跑完；
//     - 拿不到人机校验时，报一个说人话的错，而不是含糊的 401。
//
// 会话存在数据库里（lib/store.ts 的 secrets 表），跟别的上游一样。
// 刷新走 lib/session.ts 的锁：两个进程同时登录会把会话搅乱。

import crypto from "node:crypto";
import {
  INTERN_AI_CHAT_BASE,
  INTERN_AI_CHAT_CLIENT_ID,
  INTERN_AI_DISCOVERY_BASE,
  INTERN_AI_DISCOVERY_CLIENT_ID,
  INTERN_AI_SSO_API_BASE,
  INTERN_AI_SSO_BASE,
  INTERN_AI_TOKEN_COOKIE,
  internAiCredentials,
  internAiDiscoveryKey,
} from "./config.ts";
import { readSession, writeSession } from "../session.ts";
import { deleteSecret, getSecret, setSecret } from "../store.ts";
import { tokenFingerprint } from "../credential.ts";
import { providerSecretId } from "../providers.ts";

/**
 * 会话在数据库里的名字。
 *
 * 会话归 provider 所有：两个书生·端砚账号各有各的会话。
 */
export function sessionId(providerId = "intern-ai"): string {
  return providerSecretId(providerId);
}

/**
 * 账号信息在数据库里的名字。
 *
 * 账号（账号密码与那两把推理 key）也归 provider 所有。
 */
export function accountId(providerId = "intern-ai"): string {
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
  /** 两个子站各自的推理 key（新建时存下来，完整的值只出现一次）。 */
  discoveryKey?: string | null;
  chatKey?: string | null;
}

/**
 * 读这个 provider 的账号信息。
 *
 * 只有账号自己那一处：旧位置不再读——那会让删掉的账号转眼又带上旧的凭据。
 */
export function storedAccount(providerId = "intern-ai"): StoredAccount | null {
  return getSecret<StoredAccount>(accountId(providerId));
}

/** 一个子站的登录结果。 */
export interface InternAiSite {
  /** 子站的名字，两个子站各一个。 */
  name: "discovery" | "chat";
  /** 控制台接口认的 Bearer token。 */
  token: string;
  /** 这个子站的 OAuth 客户端 id。 */
  clientId: string;
}

/** 存下来的会话。 */
export interface InternAiSession {
  /** 两个子站各自的 token。token 是子站发的，Discovery 的不等于 Chat 的。 */
  sites: InternAiSite[];
  /**
   * openxlab 账号的内部 id。
   *
   * 控制台的 cookie 头要带 `ssouid=<这个>`，key 列表那个接口认它。
   */
  ssoUid?: string;
  /** 拿到这个会话的时刻，毫秒。 */
  obtainedAtMs: number;
  /** 登录用的账号，只用来显示。 */
  username: string;
}

/** 出错的时候分什么类，调用方靠它决定是重试还是重新登录。 */
export type InternAiErrorKind =
  | "auth"
  | "captcha"
  | "forbidden"
  | "rate"
  | "request"
  | "upstream"
  | "config";

/** intern-ai 的错误。`message` 是给人看的中文。 */
export class InternAiError extends Error {
  kind: InternAiErrorKind;
  status: number;

  constructor(kind: InternAiErrorKind, message: string, status = 502) {
    super(message);
    this.name = "InternAiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * 人机校验的三个头。
 *
 * 页面上的「确认您不是机器人」过一次以后，浏览器里就有这三个值。它们是
 * 一次性的：跟账号密码绑在一起用一次就作废。
 */
export interface InternAiCaptcha {
  /** 校验通过的凭证。 */
  captchaVerifyParam: string;
  /** 场景 id。 */
  sceneId: string;
  /** 前缀。 */
  prefix: string;
}

/** 一次 fetch 的统一超时。控制台接口不快，但也不该无限等。 */
const TIMEOUT_MS = 20_000;

/** 浏览器用的 UA。平台对 UA 很敏感（headless 会被判风控）。 */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

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

/**
 * 把状态码和响应体归成一种错误。
 *
 * SSO 的错误信封是 {traceId, msgCode, msg, data, success}，msgCode 是分类：
 *   B0501  人机校验没过
 *   A0101  参数没给对
 *   A0202  身份没通过
 * 业务接口的错误信封是 {code, msg}，code 是数字，0 才是成功。
 */
export function classify(status: number, body: any, what: string): InternAiError {
  const msg = String(body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? "").slice(0, 200);
  const msgCode = String(body?.msgCode ?? body?.code ?? "");
  const tail = msg ? `：${msg}` : "";

  // 人机校验单独一类：它不是「重试一下就好」，也不是「密码错了」。
  if (msgCode === "B0501" || /human verification/i.test(msg)) {
    return new InternAiError(
      "captcha",
      `${what}：需要人机校验（${msgCode || "B0501"}）${tail}。` +
        `这一步要在浏览器里点一次「确认您不是机器人」，把校验的三个值传进来。`,
      503,
    );
  }
  if (status === 401 || msgCode === "A0202") {
    return new InternAiError("auth", `${what}：会话无效或没带对（${msgCode || `HTTP ${status}`}）${tail}`, 503);
  }
  if (status === 403) {
    return new InternAiError("forbidden", `${what}：没有权限（HTTP 403）${tail}`);
  }
  if (status === 429) {
    return new InternAiError("rate", `${what}：被限流了（HTTP 429），稍后再试`);
  }
  if (status === 400 || status === 422 || msgCode === "A0101") {
    return new InternAiError("request", `${what}：请求被拒（${msgCode || `HTTP ${status}`}）${tail}`);
  }
  if (status === 404) {
    return new InternAiError("request", `${what}：接口不存在（HTTP 404）${tail}`);
  }
  return new InternAiError("upstream", `${what}：上游返回 ${msgCode || `HTTP ${status}`}${tail}`);
}

/**
 * 把服务端的裸 base64 公钥包成 PEM。
 *
 * 服务端给的是 DER 的 base64（1024 位 RSA），不是 PEM。Node 的 crypto 只认
 * PEM，所以这里补上头尾。JSEncrypt 那一版是自己补的。
 */
export function pemFromRawPublicKey(raw: string): string {
  const body = raw.trim();
  if (body.includes("BEGIN")) return body;
  return `-----BEGIN PUBLIC KEY-----\n${body.replace(/(.{64})/g, "$1\n").trim()}\n-----END PUBLIC KEY-----`;
}

/**
 * 加密密码。
 *
 * 平台的做法是 RSA(PKCS#1 v1.5) 加密 `{账号}||{密码}{unix 秒}`，base64。
 * 账号也一起加密，是为了不把手机号明文发出去。
 *
 * 时间戳在里面，是服务端用来做时效校验的。
 */
export function encryptSecret(pubKeyPem: string, account: string, secret: string, nowMs = Date.now()): string {
  const plain = `${account}||${secret}${Math.floor(nowMs / 1000)}`;
  return crypto
    .publicEncrypt({ key: pubKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain))
    .toString("base64");
}

/** 登录时发给身份服务的那份请求体。 */
export function loginBody(account: string, encrypted: string): Record<string, unknown> {
  // type：1 = 邮箱，2 = 手机号。平台按账号里有没有 @ 来分。
  return {
    account,
    password: encrypted,
    type: account.includes("@") ? "1" : "2",
    autoLogin: true,
  };
}

/** 人机校验的三个头。没给就一个都不带（服务端会回 B0501）。 */
export function captchaHeaders(captcha?: InternAiCaptcha): Record<string, string> {
  if (!captcha) return {};
  return {
    captchaVerifyParam: captcha.captchaVerifyParam,
    sceneId: captcha.sceneId,
    prefix: captcha.prefix,
  };
}

/** 拿登录用的 RSA 公钥。 */
export async function ssoPublicKey(): Promise<string> {
  const r = await fetch(`${INTERN_AI_SSO_API_BASE}/api/v1/cipher/getPubKey`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ type: "login", from: "browser" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(r);
  const raw = body?.data?.pubKey;
  if (!r.ok || !raw) {
    throw classify(r.status, body, "取登录公钥失败");
  }
  return pemFromRawPublicKey(String(raw));
}

/**
 * 账号密码换 SSO 会话。
 *
 * 回答里带的是 SSO 的会话 cookie（`uaa-token`），不是子站的 token。这一步
 * 要人机校验；`captcha` 没给的话，平台会回 B0501，错误里写清楚了。
 */
export async function ssoLogin(
  account: string,
  password: string,
  captcha?: InternAiCaptcha,
): Promise<string> {
  const pubKey = await ssoPublicKey();
  const encrypted = encryptSecret(pubKey, account, password);
  const r = await fetch(`${INTERN_AI_SSO_API_BASE}/api/v1/login/byAccount`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Origin: INTERN_AI_SSO_BASE,
      Referer: `${INTERN_AI_SSO_BASE}/login`,
      ...captchaHeaders(captcha),
    },
    body: JSON.stringify(loginBody(account, encrypted)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(r);
  if (!r.ok || body?.success === false || !body?.success) {
    throw classify(r.status, body, "登录失败");
  }
  const cookie = cookieHeader(r.headers.getSetCookie?.() ?? []);
  if (!cookie.includes(`${INTERN_AI_TOKEN_COOKIE}=`)) {
    throw new InternAiError("upstream", "登录失败：平台没有发回会话 cookie");
  }
  return cookie;
}

/**
 * 换一个应用授权码。
 *
 * 这一步在 SSO 的 /oauth 页面上做：页面上有 `uaa-token` cookie 就调这个接口，
 * 拿到 code，然后跳回应用并把 code 拼在地址后面。这里直接把中间那步抄过来。
 *
 * 回答是 {code: "uaa::code::…", subCallback: "<跳回去的地址>"}。
 * subCallback 是 SSO 算好的回跳地址（拿它拼 code 就是浏览器那条路）。
 */
export async function ssoAuthorizationCode(cookie: string, clientId: string): Promise<string> {
  const r = await fetch(`${INTERN_AI_SSO_API_BASE}/api/v1/internal/auth`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Cookie: cookie,
      Origin: INTERN_AI_SSO_BASE,
      Referer: `${INTERN_AI_SSO_BASE}/oauth`,
    },
    body: JSON.stringify({ clientId }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(r);
  const code = body?.data?.code ?? body?.code;
  if (!r.ok || !code || code === 0) {
    throw classify(r.status, body, "换授权码失败");
  }
  return String(code);
}

/**
 * 授权码换子站 token。
 *
 * 两个子站的换法路径不一样，形状一样（body 只有 code）：
 *
 *   Discovery  POST {discovery}/api/user-center/v1/users/auth
 *   Chat       POST {chat}/puyu/users/auth
 *
 * 换出来的 token 就是控制台接口要的那个 Bearer token。
 */
export async function exchangeCode(
  code: string,
  site: { name: "discovery" | "chat"; appBase: string; authPath: string },
): Promise<string> {
  const r = await fetch(`${site.appBase}${site.authPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Origin: site.appBase,
      Referer: `${site.appBase}/`,
    },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(r);
  const token = body?.data?.token;
  if (!r.ok || !token) {
    throw classify(r.status, body, `${site.name} 子站换 token 失败`);
  }
  return String(token);
}

/** 两个子站各自的登录参数。 */
function siteTargets(): Array<{
  name: "discovery" | "chat";
  clientId: string;
  appBase: string;
  authPath: string;
}> {
  return [
    {
      // Discovery：换 token 的接口挂在 discovery 这台机器上，路径是
      // /api/user-center/v1/users/auth。个人中心那台机器上的 /api/v1/users/auth
      // 是错的路（回 -10007）。
      name: "discovery",
      clientId: INTERN_AI_DISCOVERY_CLIENT_ID,
      appBase: INTERN_AI_DISCOVERY_BASE,
      authPath: "/api/user-center/v1/users/auth",
    },
    {
      name: "chat",
      clientId: INTERN_AI_CHAT_CLIENT_ID,
      appBase: INTERN_AI_CHAT_BASE,
      authPath: "/puyu/users/auth",
    },
  ];
}

/**
 * 一个子站的登录参数。
 *
 * 两个子站各是一套：客户端 id、控制台地址、换 token 的路径都不一样。拿错
 * 的话，平台会回「oauth error」——不是「没登录」，重试没有用。
 */
export function internAiSite(
  name: "discovery" | "chat",
): { name: "discovery" | "chat"; clientId: string; appBase: string; authPath: string } {
  const target = siteTargets().find((t) => t.name === name);
  if (!target) throw new InternAiError("config", `没有这个子站：${name}`, 500);
  return target;
}

/** 登录的选项。 */
export interface InternAiLoginOptions {
  user?: string;
  password?: string;
  /**
   * 人机校验的三个值。
   *
   * 没给的话，登录会停在 SSO 那一步，错误里说清楚要什么。
   */
  captcha?: InternAiCaptcha;
  /** 只登一个子站。两个都要就都登（默认）。 */
  only?: "discovery" | "chat";
}

/**
 * 登录并存会话。
 *
 * 走完三段，把两个子站的 token 存进数据库。
 */
export async function login(opts: InternAiLoginOptions = {}, providerId = "intern-ai"): Promise<InternAiSession> {
  const creds = internAiCredentials({ user: opts.user, password: opts.password }, storedAccount(providerId));
  if (!creds.user || !creds.password) {
    throw new InternAiError("config", "没有配置 intern-ai 的账号密码（INTERN_AI_USER / INTERN_AI_PASSWORD）", 500);
  }

  const cookie = await ssoLogin(creds.user, creds.password, opts.captcha);
  const sites: InternAiSite[] = [];
  for (const target of siteTargets()) {
    if (opts.only && opts.only !== target.name) continue;
    const code = await ssoAuthorizationCode(cookie, target.clientId);
    const token = await exchangeCode(code, target);
    sites.push({ name: target.name, token, clientId: target.clientId });
  }
  if (!sites.length) {
    throw new InternAiError("config", "没有指定要登哪个子站", 500);
  }

  const session: InternAiSession = {
    sites,
    ssoUid: ssoUidFromToken(sites[0]!.token),
    obtainedAtMs: Date.now(),
    username: creds.user,
  };
  saveSession(session, providerId);
  // 账号密码也存一份：.env 不在了还能登录。
  const stored = storedAccount(providerId);
  setSecret(accountId(providerId), "account", {
    user: creds.user,
    password: creds.password,
    discoveryKey: stored?.discoveryKey ?? null,
    chatKey: stored?.chatKey ?? null,
  });
  return session;
}

/**
 * 把一个已经在浏览器里拿到的 token 存进来。
 *
 * 人机校验要人点，那就让人在浏览器里点完，把 `uaa-token` 拿过来存上。
 * 这条路跟 login() 换来的会话没有区别。
 */
/**
 * 把 uaa-token 记下来。
 *
 * 两个子站共用同一个 token —— 登录的是同一个账号，token 也是同一个。所以
 * 这里一次登记两个子站，登录的时候不必问「登哪个子站」。
 */
export function importToken(token: string, providerId = "intern-ai"): InternAiSession {
  const stored = loadSession(providerId);
  const sites = siteTargets().map((target) => ({
    name: target.name,
    token,
    clientId: target.clientId,
  }));
  const session: InternAiSession = {
    sites,
    ssoUid: stored?.ssoUid ?? ssoUidFromToken(token),
    obtainedAtMs: stored?.obtainedAtMs ?? Date.now(),
    username: stored?.username ?? "",
  };
  saveSession(session, providerId);
  return session;
}

/**
 * 从 token 里读出账号的内部 id。
 *
 * token 是 JWT（HS512），载荷里的 jti 就是 openxlab 账号 id。控制台的 cookie
 * 头要带 `ssouid=<它>`，所以登录的时候顺手取出来存着。
 *
 * 只解不验：这里只是取一个 id，不是拿它当凭据用。签名是平台自己的密钥签的，
 * 我们没有那个密钥，也不需要。
 */
export function ssoUidFromToken(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return String(payload?.jti ?? "");
  } catch {
    return "";
  }
}

/**
 * token 什么时候到期。
 *
 * 同样是 JWT 载荷里的 exp（unix 秒）。账号是「14 天内免登录」，所以 token 的
 * 有效期是 14 天。
 */
export function tokenExpiryMs(token: string): number {
  const parts = token.split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return Number(payload?.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

/** 会话还在不在。 */
/** 数据库里的会话。 */
export function loadSession(providerId = "intern-ai"): InternAiSession | null {
  const valid = (raw: any) => !!raw?.sites?.length && raw.sites.every((s: any) => !!s?.token);
  const session = readSession<InternAiSession>(sessionId(providerId), valid);
  return session;
}

/** 存会话。 */
export function saveSession(session: InternAiSession, providerId = "intern-ai"): void {
  writeSession(sessionId(providerId), session);
}

/** 忘掉会话：下一次调用会重新登录。 */
export function clearSession(providerId = "intern-ai"): void {
  try {
    deleteSecret(sessionId(providerId));
  } catch {
    /* 没什么可清的了 */
  }
}

/** 面板上的「快到期」提示线（毫秒）。 */
const WARN_MS = 24 * 3600 * 1000;

/**
 * 面板上用的凭据状态。
 *
 * 与 SenseNova 一样：推理端点认的是 Discovery 那把 key，不是登录态。所以这里
 * 报的是 key，会话的情况另放在 sessionStatus 里。
 */
export function internAiStatus(providerId = "intern-ai"): Record<string, unknown> {
  const stored = storedAccount(providerId);
  const key = internAiDiscoveryKey(stored?.discoveryKey);
  const session = loadSession(providerId);
  // The tokens are JWTs; the earliest expiry is the one that matters.
  const expiresAtMs = session
    ? (session.sites
        .map((s) => tokenExpiryMs(s.token))
        .filter((t) => t > 0)
        .sort((a, b) => a - b)[0] ?? 0)
    : 0;
  const remainingMs = expiresAtMs ? expiresAtMs - Date.now() : 0;
  return {
    source: sessionId(providerId),
    status: key ? "authenticated" : "missing",
    fingerprint: key ? tokenFingerprint(key) : "",
    detail: key ? "Discovery 的推理 key" : "账号上没有 Discovery 推理 key，登录后网关会建一把",
    sessionStatus: !session ? "anonymous" : remainingMs > 0 ? "authenticated" : "expired",
    username: session?.username ?? stored?.user ?? "",
    sites: session?.sites.map((s) => s.name).join(", ") ?? "",
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : "",
    remainingSec: Math.round(remainingMs / 1000),
    warning: remainingMs > 0 && remainingMs < WARN_MS,
    obtainedAt: session ? new Date(session.obtainedAtMs).toISOString() : "",
  };
}

/** 一个子站的 token。 */
export function tokenFor(session: InternAiSession, site: "discovery" | "chat"): string {
  return session.sites.find((s) => s.name === site)?.token ?? "";
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
