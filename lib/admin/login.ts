// lib/admin/login.ts — 面板的登录授权。
//
// 一次登录 = 一个本地会话（cache 表里的一行）+ 一个后台轮询。
//
// 「回调到面板」对所有上游都不成立（授权页不认第三方的 redirect_uri），
// 所以统一是：服务端发起 → 面板把链接给用户 → 后端在后台轮询 → 凭据落库。
//
// 会话放在 cache 表里而不是内存：用户在授权页上点了「同意」，回来发现会话
// 没了，白点一次。cache 表是同一个 0600 的 SQLite 文件，多进程共享。
//
// 半凭据（device_code / code_verifier / nonce / machine_token / state）存在
// 这一行里，一个都不进日志。

import crypto from "node:crypto";
import { deleteCached, getSecret, listCached, peekCached, setCached, setSecret, withLock } from "../store.ts";
import { AuthError } from "../credential.ts";
import {
  pollDeviceToken as pollMinimaxDevice,
  saveSession as saveMinimaxSession,
  startDeviceAuthorization,
  type DeviceAuthorization as MinimaxDeviceAuthorization,
} from "../minimax/oauth.ts";
import {
  buildDeviceAuthorization,
  pollDeviceToken as pollQoderDevice,
  saveSession as saveQoderSession,
  type DeviceAuthorization as QoderDeviceAuthorization,
  type QoderRegion,
} from "../qoder/auth.ts";
import {
  pollLogin as pollWorkBuddyLogin,
  saveSession as saveWorkBuddySession,
  startLogin as startWorkBuddyLogin,
} from "../workbuddy/auth.ts";
import { loginWithCredentials, tokenRhythmTenants } from "../tokenrhythm/accounts.ts";
import { ensureApiKey } from "../tokenrhythm/keys.ts";
import { login as loginSenseNova, ACCOUNT_ID as SENSENOVA_ACCOUNT_ID } from "../sensenova/auth.ts";
import { importToken as importInternAiToken, internAiSite, login as loginInternAi } from "../intern-ai/auth.ts";
import { exchangeCode as exchangeInternAiCode } from "../intern-ai/auth.ts";import { INTERN_AI_SSO_BASE } from "../intern-ai/config.ts";

/** 一次登录的状态。 */
export type LoginStatus = "pending" | "approved" | "failed" | "expired" | "cancelled";

/** 面板按它决定画什么。 */
export type LoginMethod = "device" | "browser" | "password" | "code" | "token";

/** 一次登录会话，存进 cache 表的那一行。 */
export interface StoredLogin {
  loginId: string;
  upstreamId: string;
  accountId: string;
  status: LoginStatus;
  method: LoginMethod;
  /** 用户要点的那个地址。 */
  authorizationUrl: string;
  /** 设备流的大字码。 */
  userCode: string;
  /** 过期时刻。Unix 毫秒。 */
  expiresAt: number;
  /** 给人看的一句话。 */
  message: string;
  /** 账号密码型上游的账号名。 */
  username: string;
  /** intern-ai：登哪个子站。 */
  site: string;
  /** 轮询用的材料。半凭据，不进日志。 */
  poll: Record<string, unknown> | null;
  /** 登录成功后落库的凭据 id。 */
  credentialId: string;
}

/** cache 表里这一行的键。 */
function cacheKey(loginId: string): string {
  return `login:${loginId}`;
}

/** 读一次登录会话。 */
export function loadLogin(loginId: string): StoredLogin | null {
  if (!loginId) return null;
  const row = peekCached<StoredLogin>(cacheKey(loginId));
  return row?.data ?? null;
}

/** 写一次登录会话。 */
function saveLogin(session: StoredLogin): void {
  setCached(cacheKey(session.loginId), session);
}

/** 改一次登录会话的几个字段。 */
function updateLogin(loginId: string, patch: Partial<StoredLogin>): StoredLogin | null {
  const current = loadLogin(loginId);
  if (!current) return null;
  const next = { ...current, ...patch };
  saveLogin(next);
  return next;
}

/** 一个多久以前的登录会话可以扔了。 */
const SESSION_TTL_MS = 24 * 3600 * 1000;

/** 把过期与已结束的会话清掉。cache 表没有别的清理逻辑。 */
export function cleanupLogins(): void {
  const now = Date.now();
  for (const row of listCached("login:")) {
    if (now - row.at > SESSION_TTL_MS) deleteCached(row.id);
  }
}

/** 错误怎么变成面板上的话。 */
function errorText(e: unknown): string {
  const err = e as { hint?: string; message?: string };
  const hint = err?.hint ?? "";
  const code = err?.message ?? "";
  if (hint && code && !hint.includes(code)) return `${hint}（${code}）`;
  return hint || code || "登录没成功。";
}

/* ------------------------------------------------------------------ *
 * 开始
 * ------------------------------------------------------------------ */

/** 一个上游的「开始」结果。 */
interface Started {
  method: LoginMethod;
  authorizationUrl: string;
  userCode: string;
  expiresAt: number;
  message: string;
  poll: Record<string, unknown> | null;
}

/** MiniMax：设备流，有大字码。 */
async function startMinimax(): Promise<Started> {
  const auth = await startDeviceAuthorization();
  const url = auth.verificationUriComplete ?? `${auth.verificationUri}?code=${auth.userCode}`;
  return {
    method: "device",
    authorizationUrl: url,
    userCode: auth.userCode,
    expiresAt: Date.now() + auth.expiresInSec * 1000,
    message: "在浏览器里打开上面的链接，同意之后这里会自动变成已登录。",
    poll: { kind: "minimax", auth: auth as unknown as Record<string, unknown> },
  };
}

/** Qoder：设备流，但没有大字码（挑战是本地算的）。 */
async function startQoder(region: QoderRegion): Promise<Started> {
  const auth = buildDeviceAuthorization(region);
  return {
    method: "device",
    authorizationUrl: auth.authUrl,
    userCode: "",
    expiresAt: auth.expiresAtMs,
    message: "在浏览器里打开上面的链接，选账号并同意之后这里会自动变成已登录。",
    poll: { kind: "qoder", region, auth: auth as unknown as Record<string, unknown> },
  };
}

/** WorkBuddy：浏览器流，state 在服务端。 */
async function startWorkBuddy(): Promise<Started> {
  const start = await startWorkBuddyLogin("cn");
  return {
    method: "browser",
    authorizationUrl: start.authUrl,
    userCode: "",
    expiresAt: start.expiresAtMs,
    message: "在浏览器里打开上面的链接，登录完成之后这里会自动变成已登录。",
    poll: { kind: "workbuddy", state: start.state },
  };
}

/** 账号密码型：面板画一个表单。 */
function startPassword(upstreamId: string): Started {
  return {
    method: "password",
    authorizationUrl: "",
    userCode: "",
    // 面板上填账号密码这件事没有「窗口」可言，但给个时刻，面板好算倒计时
    // （密码流的面板上没有倒计时，这一栏只是让它有个值）。
    expiresAt: Date.now() + 30 * 60 * 1000,
    message: "在面板上填账号与密码，然后点「登录」。",
    poll: null,
  };
}

/** intern-ai：只能半自动 —— 人在浏览器里登录，把 token 贴回来。 */
function startInternAi(site: string): Started {
  const url = `${INTERN_AI_SSO_BASE}/login`;
  const which = site ? `「${site}」` : "两个子站";
  return {
    method: "token",
    authorizationUrl: url,
    userCode: "",
    // 人在浏览器里登录、打开开发者工具、复制 token，都要时间：半小时够。
    expiresAt: Date.now() + 30 * 60 * 1000,
    message:
      `在浏览器里打开上面的链接登录，然后从开发者工具的 Cookie 里复制 uaa-token，贴回面板（${which}）。` +
      `这一步要人自己点，服务器替不了。`,
    poll: null,
  };
}

/**
 * 开始一次登录。
 *
 * 同一个上游的「开始」用锁串行化：两次同时开始会各自在上游那里建一份状态，
 * 互相踩。
 */
export async function beginLogin(upstreamId: string, accountId = "", site = ""): Promise<StoredLogin> {
  cleanupLogins();
  const id = crypto.randomUUID();
  const started = await withLock(`login:${upstreamId}`, async () => {
    switch (upstreamId) {
      case "minimax":
        return startMinimax();
      case "qoder":
        return startQoder("global");
      case "qoder-cn":
        return startQoder("cn");
      case "workbuddy-cn":
        return startWorkBuddy();
      case "tokenrhythm":
        return startPassword(upstreamId);
      case "sensenova":
        return startPassword(upstreamId);
      case "intern-ai":
        return startInternAi(site);
      default:
        throw new AuthError("unknown upstream", `这个上游还没有登录的办法：${upstreamId}`, 400);
    }
  });
  const session: StoredLogin = {
    loginId: id,
    upstreamId,
    accountId: accountId || upstreamId,
    status: "pending",
    method: started.method,
    authorizationUrl: started.authorizationUrl,
    userCode: started.userCode,
    expiresAt: started.expiresAt,
    message: started.message,
    username: "",
    site,
    poll: started.poll,
    credentialId: "",
  };
  saveLogin(session);
  // 轮询在后台跑：面板关掉也不影响。
  if (started.poll) void pollLoop(session);
  return session;
}

/* ------------------------------------------------------------------ *
 * 轮询
 * ------------------------------------------------------------------ */

/**
 * 后台轮询。
 *
 * 轮询到结果就更新那一行：成功了是 approved，失败是 failed（带中文的话）。
 * 用户中途取消的，就不写凭据了。
 */
async function pollLoop(session: StoredLogin): Promise<void> {
  try {
    const credentialId = await runPoll(session);
    const current = loadLogin(session.loginId);
    if (!current || current.status === "cancelled") return;
    updateLogin(session.loginId, {
      status: "approved",
      message: "登录好了。",
      credentialId,
    });
  } catch (e) {
    const current = loadLogin(session.loginId);
    if (!current || current.status === "cancelled") return;
    updateLogin(session.loginId, { status: "failed", message: errorText(e) });
  }
}

/** 跑上游自己的轮询，成功后把凭据存起来，返回凭据的 id。 */
async function runPoll(session: StoredLogin): Promise<string> {
  const poll = session.poll ?? {};
  switch (poll.kind) {
    case "minimax": {
      const auth = poll.auth as unknown as MinimaxDeviceAuthorization;
      const result = await pollMinimaxDevice(auth);
      saveMinimaxSession(result);
      return "session:minimax";
    }
    case "qoder": {
      const region = poll.region as QoderRegion;
      const auth = poll.auth as unknown as QoderDeviceAuthorization;
      const result = await pollQoderDevice(auth, region);
      saveQoderSession(result);
      return `session:qoder:${region}`;
    }
    case "workbuddy": {
      const state = String(poll.state ?? "");
      const result = await pollWorkBuddyLogin("cn", state, session.expiresAt);
      saveWorkBuddySession(result);
      return "session:workbuddy:cn";
    }
    default:
      throw new AuthError("unknown poll", "这个登录会话没有可轮询的东西。", 400);
  }
}

/* ------------------------------------------------------------------ *
 * 查与取消
 * ------------------------------------------------------------------ */

/**
 * 这个上游现在有没有在登录，最近一次是不是被拒了。
 *
 * 面板要知道「正在登录」（用户在点授权，别催他）和「被拒了」（让人重登，
 * 而不是让人以为「没登录」）。登录会话都在 cache 表里 —— 多进程共享 ✓。
 */
export function loginActivity(upstreamId: string): { loggingIn: boolean; rejected: boolean } {
  let loggingIn = false;
  let latest: LoginStatus | null = null;
  // listCached 按时间排，所以最后一个就是最近的那次。
  for (const row of listCached("login:")) {
    const session = peekCached<StoredLogin>(row.id)?.data;
    if (!session || session.upstreamId !== upstreamId) continue;
    if (session.status === "pending") loggingIn = true;
    latest = session.status;
  }
  return { loggingIn, rejected: latest === "failed" };
}

/**
 * 一次登录到哪一步了。
 *
 * 还是 pending、但已经过了过期时间，就是过期了。
 */
export function getLoginStatus(loginId: string): StoredLogin | null {
  const current = loadLogin(loginId);
  if (!current) return null;
  if (current.status === "pending" && current.expiresAt > 0 && Date.now() > current.expiresAt) {
    return updateLogin(loginId, { status: "expired", message: "登录窗口过期了，重新点一次登录。" });
  }
  return current;
}

/** 用户不等了。 */
export function cancelLogin(loginId: string): { ok: boolean; message: string } {
  const current = loadLogin(loginId);
  if (!current) return { ok: false, message: `没有这次登录：${loginId}` };
  if (current.status !== "pending") {
    return { ok: false, message: `这次登录已经结束了（${current.status}）。` };
  }
  updateLogin(loginId, { status: "cancelled", message: "已经取消了。" });
  return { ok: true, message: "已经取消了。" };
}

/* ------------------------------------------------------------------ *
 * 账号密码
 * ------------------------------------------------------------------ */

/** 账号密码登录的结果。 */
export interface PasswordLoginResult {
  ok: boolean;
  message: string;
  /** 凭据的 id。 */
  credentialId: string;
  /** 账号的 id。 */
  accountId: string;
}

/**
 * 用账号密码登录。
 *
 * TokenRhythm 与 SenseNova 的密码登录是纯服务端的；intern-ai 还要人机校验的
 * 三个值（浏览器里过一次验证码才有）。
 */
export async function loginWithPassword(input: {
  upstreamId: string;
  accountId: string;
  username: string;
  password: string;
  captchaVerifyParam: string;
  captchaSceneId: string;
  captchaPrefix: string;
  remember: boolean;
}): Promise<PasswordLoginResult> {
  const { upstreamId } = input;
  switch (upstreamId) {
    case "tokenrhythm": {
      const index = tenantIndex(input.accountId);
      if (!index) {
        return { ok: false, message: "要一个租户号：账号写成 tokenrhythm:1 这样的样子。", credentialId: "", accountId: "" };
      }
      const session = await loginWithCredentials(index, input.username, input.password, input.remember);
      // 推理用的 key 是另一回事：cookie 只读得到钱包，key 才是推理用的。
      // 账号上没有就建一把（平台只给一次完整值）。
      const stored = getSecret<{ account: string; password: string; apiKey: string | null }>(
        `account:tokenrhythm:${index}`,
      );
      await ensureApiKey(session, index, stored?.apiKey ?? null);
      return {
        ok: true,
        message: `租户 ${index} 登录好了。`,
        credentialId: `session:tokenrhythm:${index}`,
        accountId: `tokenrhythm:${index}`,
      };
    }
    case "sensenova": {
      await loginSenseNova(input.username, input.password);
      if (!input.remember) {
        // 现有实现总是把账号密码存一份；不记住密码的时候就把密码抹掉 ——
        // 账号留着，密码下次再问。
        const stored = getSecret<{ user?: string; password?: string; apiKey?: string | null }>(SENSENOVA_ACCOUNT_ID);
        setSecret(SENSENOVA_ACCOUNT_ID, "account", {
          user: stored?.user ?? input.username,
          password: "",
          apiKey: stored?.apiKey ?? null,
        });
      }
      return {
        ok: true,
        message: "SenseNova 登录好了。",
        credentialId: "session:sensenova",
        accountId: "sensenova",
      };
    }
    case "intern-ai": {
      const captcha =
        input.captchaVerifyParam && input.captchaSceneId && input.captchaPrefix
          ? {
              captchaVerifyParam: input.captchaVerifyParam,
              sceneId: input.captchaSceneId,
              prefix: input.captchaPrefix,
            }
          : undefined;
      // 契约里这个请求没有「登哪个子站」这一项，所以两个子站都登。
      await loginInternAi({
        user: input.username,
        password: input.password,
        captcha,
      });
      return {
        ok: true,
        message: "intern-ai 登录好了。",
        credentialId: "session:intern-ai",
        accountId: "intern-ai",
      };
    }
    default:
      return {
        ok: false,
        message: `这个上游不用账号密码登录：${upstreamId}`,
        credentialId: "",
        accountId: "",
      };
  }
}

/** 从账号 id 里读出 TokenRhythm 的租户号。 */
function tenantIndex(accountId: string): number | null {
  const match = /^(?:tokenrhythm:)?(\d+)$/.exec(accountId);
  if (!match) return null;
  const index = Number(match[1]);
  // 面板只让登已经有的租户：新租户不在账号列表里，登录了也看不见。
  return tokenRhythmTenants().some((t) => t.index === index) ? index : null;
}

/* ------------------------------------------------------------------ *
 * 换码与导入
 * ------------------------------------------------------------------ */

/**
 * 用浏览器里拿到的授权码换凭据。
 *
 * 只有 intern-ai 有这条路（而且不建议：chat 的页面换完就把地址栏里的 code
 * 抹掉了）。
 */
export async function exchangeLoginCode(input: {
  upstreamId: string;
  accountId: string;
  code: string;
  site: string;
}): Promise<PasswordLoginResult> {
  if (input.upstreamId !== "intern-ai") {
    return { ok: false, message: `这个上游不用授权码：${input.upstreamId}`, credentialId: "", accountId: "" };
  }
  if (!input.code.trim()) {
    return { ok: false, message: "没有授权码。", credentialId: "", accountId: "" };
  }
  const site = input.site === "chat" ? "chat" : "discovery";
  const token = await exchangeInternAiCode(input.code.trim(), internAiSite(site));
  importInternAiToken(token, site);
  return {
    ok: true,
    message: `换好了 ${site} 子站的凭据。`,
    credentialId: "session:intern-ai",
    accountId: "intern-ai",
  };
}

/**
 * 导入浏览器里拿到的 token。
 *
 * intern-ai 的 uaa-token 就是这么来的：人机校验要人点，那就让人在浏览器里点
 * 完，把 token 拿过来存上。
 */
export async function importLoginToken(input: {
  upstreamId: string;
  accountId: string;
  token: string;
  site: string;
}): Promise<PasswordLoginResult> {
  if (input.upstreamId !== "intern-ai") {
    return { ok: false, message: `这个上游不用回填 token：${input.upstreamId}`, credentialId: "", accountId: "" };
  }
  if (!input.token.trim()) {
    return { ok: false, message: "没有 token。", credentialId: "", accountId: "" };
  }
  const site = input.site === "chat" ? "chat" : "discovery";
  importInternAiToken(input.token.trim(), site);
  return {
    ok: true,
    message: `导入好了 ${site} 子站的凭据。`,
    credentialId: "session:intern-ai",
    accountId: "intern-ai",
  };
}
