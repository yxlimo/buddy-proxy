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
import { deleteCached, listCached, peekCached, setCached, withLock } from "../store.ts";
import { AuthError, authLog } from "../credential.ts";
import { dataDir } from "../paths.ts";
// Side-effect import: this module registers minimax's login flow
import "../minimax/oauth.ts";
import type { DeviceAuthorization as MinimaxDeviceAuthorization } from "../minimax/oauth.ts";
// Side-effect import: this module registers qoder's login flow
import "../qoder/auth.ts";
import type { DeviceAuthorization as QoderDeviceAuthorization } from "../qoder/auth.ts";
import { accountsOfPlatform, provider, type ProviderRow } from "../providers.ts";
import { providerSecretId } from "../credential-ids.ts";
// Side-effect import: this module registers zcode's login flow
import "../zcode/auth.ts";
import type { ZcodeLogin } from "../zcode/auth.ts";
import { beginLoginFlow, driveLogin, submitLogin, submitLoginResult, type LoginContext, type LoginMethod, type LoginTicket } from "../login-flow.ts";
export type { LoginMethod };
import { regionOf as workBuddyRegionOf } from "../workbuddy/auth.ts";
// Side-effect import: this module registers tokenrhythm's login flow
import "../tokenrhythm/accounts.ts";
// Side-effect import: this module registers sensenova's login flow
import "../sensenova/auth.ts";
import type { SenseNovaLogin } from "../sensenova/auth.ts";
// Side-effect import: this module registers intern-ai's login flow
import "../intern-ai/login-flow.ts";
import type { InternAiLogin } from "../intern-ai/login-flow.ts";
import {
  importToken as importInternAiToken,
  storedAccount as storedInternAiAccount,
} from "../intern-ai/auth.ts";
import { internAiDiscoveryKey } from "../intern-ai/config.ts";
import { exchangeCode as exchangeInternAiCode } from "../intern-ai/auth.ts";

/** 一次登录的状态。 */
export type LoginStatus = "pending" | "approved" | "failed" | "expired" | "cancelled";

/** 面板按它决定画什么。定义在 lib/login-flow.ts，这里只是转出去。 */

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
function loadLogin(loginId: string): StoredLogin | null {
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
function cleanupLogins(): void {
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
  return hint || code || "登录未成功。";
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

/** MiniMax：设备流，有大字码。
 *
 * 登录链本身登记在 lib/minimax/oauth.ts 的 registerLoginFlow 里，这里只要把
 * 账号行的 id 交给它。 */
async function startMinimax(accountId: string): Promise<Started> {
  const ctx: LoginContext = {
    accountId,
    platform: "minimax",
    region: "",
  };
  const ticket = await beginLoginFlow("minimax", ctx);
  // SAFETY: the ticket comes from the minimax flow's begin, which puts the
  // DeviceAuthorization it fetched under state.auth
  const auth = ticket.state.auth as unknown as Record<string, unknown>;
  return {
    method: ticket.method,
    authorizationUrl: ticket.authorizationUrl,
    userCode: ticket.userCode,
    expiresAt: ticket.expiresAtMs,
    message: ticket.message,
    // 半凭据照旧摊进这一层再存：形状没变，重启前还在等的登录照旧能接上。
    poll: { kind: "minimax", auth },
  };
}

/** Qoder：设备流，但没有大字码（挑战是本地算的）。
 *
 * 登录链本身登记在 lib/qoder/auth.ts 的 registerLoginFlow 里，这里只要把
 * 账号行的 id 交给它。 */
async function startQoder(accountId: string): Promise<Started> {
  const ctx: LoginContext = {
    accountId,
    platform: "qoder",
    region: "",
  };
  const ticket = await beginLoginFlow("qoder", ctx);
  // SAFETY: the ticket comes from the qoder flow's begin, which puts the
  // DeviceAuthorization it built under state.auth
  const auth = ticket.state.auth as unknown as Record<string, unknown>;
  return {
    method: ticket.method,
    authorizationUrl: ticket.authorizationUrl,
    userCode: ticket.userCode,
    expiresAt: ticket.expiresAtMs,
    message: ticket.message,
    // 半凭据照旧摊进这一层再存：形状没变，重启前还在等的登录照旧能接上。
    poll: { kind: "qoder", auth },
  };
}

/** ZCode：浏览器 OAuth，CLI 那一套（init 拿链接，poll 拿 JWT）。
 *
 * 登录链本身登记在 lib/zcode/auth.ts 的 registerLoginFlow 里，这里只要把
 * 账号行的 id 交给它。 */
async function startZcode(accountId: string, platform = "zcode"): Promise<Started> {
  const ctx: LoginContext = {
    accountId,
    platform,
    region: "",
  };
  const ticket = await beginLoginFlow("zcode", ctx);
  // SAFETY: rows with poll.kind === "zcode" are written by startZcode alone
  // and its login field is the ZcodeLogin that init returned
  const login = ticket.state.login as unknown as Record<string, unknown>;
  return {
    method: ticket.method,
    authorizationUrl: ticket.authorizationUrl,
    userCode: ticket.userCode,
    expiresAt: ticket.expiresAtMs,
    message: ticket.message,
    // 半凭据照旧摊进这一层再存：形状没变，重启前还在等的登录照旧能接上。
    poll: { kind: "zcode", login },
  };
}

/** WorkBuddy：浏览器流，state 在服务端。
 *
 * 登录链本身登记在 lib/workbuddy/auth.ts 的 registerLoginFlow 里，这里只要把
 * 账号行的 id 交给它。 */
async function startWorkBuddy(accountId: string): Promise<Started> {
  const ctx: LoginContext = {
    accountId,
    platform: "workbuddy",
    region: workBuddyRegionOf(accountId),
  };
  const ticket = await beginLoginFlow("workbuddy", ctx);
  return {
    method: ticket.method,
    authorizationUrl: ticket.authorizationUrl,
    userCode: ticket.userCode,
    expiresAt: ticket.expiresAtMs,
    message: ticket.message,
    // 半凭据照旧摊进这一层再存：形状没变，重启前还在等的登录照旧能接上。
    poll: { kind: "workbuddy", ...ticket.state },
  };
}

/**
 * 在某个账号上开始一次登录。
 *
 * account_id 是 provider 表那一行的 id（账号）。不给就用这个平台下的第一个
 * 账号 —— 面板在平台那一行上点「登录」时不一定带着账号。
 *
 * 同一个账号的「开始」用锁串行化：两次同时开始会各自在上游那里建一份状态，
 * 互相踩。
 */
export async function beginLogin(upstreamId: string, accountId = ""): Promise<StoredLogin> {
  cleanupLogins();
  const id = crypto.randomUUID();
  const row = accountFor(upstreamId, accountId);
  if (!row) {
    throw new AuthError(
      "no account",
      accountId
        ? `没有这个账号：${accountId}。`
        : `这个平台还没有账号，请先在面板上新增一个。`,
      400,
    );
  }
  const started = await withLock(`login:${row.id}`, async () => {
    // The provider says which kind it is; the kind says how to log in.
    switch (row.kind) {
      case "minimax":
        return startMinimax(row.id);
      case "qoder":
        return startQoder(row.id);
      case "zcode":
        return startZcode(row.id, row.platform);
      case "workbuddy":
        return startWorkBuddy(row.id);
      default:
        // 两种方言（用户自己加的开放平台）没有登录这一说：它用推理 Key。
        // 说清楚怎么办，而不是只说「不行」—— 按钮的名字照面板上实际的写
        // （一格时写「API Key」，几段凭据时写「凭据」）。
        throw new AuthError(
          "no login",
          `这个上游没有登录方式：${upstreamId}。这类平台用推理 Key，` +
            `点账号那一行的「API Key」（有额度凭据时是「凭据」）把它填进去。`,
          400,
        );
    }
  });
  const session: StoredLogin = {
    loginId: id,
    // 平台是那条路径与那一组目录；账号才是这份登录落在哪一行。
    upstreamId: row.platform,
    accountId: row.id,
    status: "pending",
    method: started.method,
    authorizationUrl: started.authorizationUrl,
    userCode: started.userCode,
    expiresAt: started.expiresAt,
    message: started.message,
    username: "",
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
      message: "登录完成。",
      credentialId,
    });
    // 登录的结果要留痕：容器重建就没有日志了，凭据自己的日志里也只有
    // 「刷新成功」，看不出当初是怎么登上去的。
    authLog(dataDir(), `${session.accountId} 登录成功`, credentialId);
    console.log(`[LOGIN] ${session.accountId} 登录成功`);
  } catch (e) {
    const current = loadLogin(session.loginId);
    if (!current || current.status === "cancelled") return;
    updateLogin(session.loginId, { status: "failed", message: errorText(e) });
    authLog(dataDir(), `${session.accountId} 登录失败`, errorText(e));
    console.warn(`[LOGIN] ${session.accountId} 登录失败：${errorText(e)}`);
  }
}

/** 跑上游自己的轮询，成功后把凭据存起来，返回凭据的 id。 */
async function runPoll(session: StoredLogin): Promise<string> {
  const poll = session.poll ?? {};
  const providerId = session.accountId;
  switch (poll.kind) {
    case "minimax": {
      // SAFETY: rows with poll.kind === "minimax" are written by startMinimax
      // alone and its auth field is the DeviceAuthorization that begin fetched
      const auth = poll.auth as unknown as MinimaxDeviceAuthorization;
      const ctx: LoginContext = {
        accountId: providerId,
        platform: session.upstreamId,
        region: "",
      };
      const ticket: LoginTicket = {
        method: "device",
        authorizationUrl: session.authorizationUrl,
        userCode: session.userCode,
        expiresAtMs: session.expiresAt,
        message: session.message,
        state: { auth },
      };
      const { credentialId } = await driveLogin("minimax", ctx, ticket, session.expiresAt);
      return credentialId;
    }
    case "qoder": {
      // SAFETY: rows with poll.kind === "qoder" are written by startQoder alone
      // and its auth field is the DeviceAuthorization that begin built
      const auth = poll.auth as unknown as QoderDeviceAuthorization;
      const ctx: LoginContext = {
        accountId: providerId,
        platform: session.upstreamId,
        region: "",
      };
      const ticket: LoginTicket = {
        method: "device",
        authorizationUrl: session.authorizationUrl,
        userCode: session.userCode,
        expiresAtMs: session.expiresAt,
        message: session.message,
        state: { auth },
      };
      const { credentialId } = await driveLogin("qoder", ctx, ticket, session.expiresAt);
      return credentialId;
    }
    case "workbuddy": {
      const state = String(poll.state ?? "");
      const ctx: LoginContext = {
        accountId: providerId,
        platform: session.upstreamId,
        region: workBuddyRegionOf(providerId),
      };
      const ticket: LoginTicket = {
        method: "browser",
        authorizationUrl: session.authorizationUrl,
        userCode: session.userCode,
        expiresAtMs: session.expiresAt,
        message: session.message,
        state: { state },
      };
      const { credentialId } = await driveLogin("workbuddy", ctx, ticket, session.expiresAt);
      return credentialId;
    }
    case "zcode": {
      // SAFETY: rows with poll.kind === "zcode" are written by startZcode alone
      // and its login field is the ZcodeLogin that init returned
      const login = poll.login as unknown as ZcodeLogin;
      const ctx: LoginContext = {
        accountId: providerId,
        platform: session.upstreamId,
        region: "",
      };
      const ticket: LoginTicket = {
        method: "browser",
        authorizationUrl: session.authorizationUrl,
        userCode: session.userCode,
        expiresAtMs: session.expiresAt,
        message: session.message,
        state: { login },
      };
      const { credentialId } = await driveLogin("zcode", ctx, ticket, session.expiresAt);
      return credentialId;
    }
    default:
      throw new AuthError("unknown poll", "该登录会话没有可轮询的内容。", 400);
  }
}

/* ------------------------------------------------------------------ *
 * 查与取消
 * ------------------------------------------------------------------ */

/**
 * 这个账号现在有没有在登录，最近一次是不是被拒了。
 *
 * 传的是账号行的 id：一个平台下有两个账号时，只有一个在登录，另一个不该跟着
 * 显示「正在登录」。
 *
 * 面板要知道「正在登录」（用户在点授权，别催他）和「被拒了」（让人重登，
 * 而不是让人以为「没登录」）。登录会话都在 cache 表里，多进程共享。
 */
export function loginActivity(accountId: string): { loggingIn: boolean; rejected: boolean } {
  let loggingIn = false;
  let latest: LoginStatus | null = null;
  // loginsOf 按时间排，所以最后一个就是最近的那次。
  for (const session of loginsOf(accountId)) {
    // 还在等、但窗口已经过了，就不是「正在登录」了 —— 那次登录早就没戏了。
    // 留着这个状态，面板会一直说「正在登录」，而实际上什么都没在等。
    if (session.status === "pending" && session.expiresAt > 0 && Date.now() > session.expiresAt) {
      // 顺手把它标成过期：下一次来看的人看到的也是「过期」，不是「在等」。
      updateLogin(session.loginId, { status: "expired", message: "登录窗口已过期。" });
      latest = "expired";
      continue;
    }
    if (session.status === "pending") loggingIn = true;
    latest = session.status;
  }
  return { loggingIn, rejected: latest === "failed" };
}

/**
 * 这个账号名下的登录记录，按时间排。
 *
 * 登录会话都在 cache 表里，多进程共享：面板那个进程读到的和网关这个进程写下
 * 的是同一批行。
 */
function loginsOf(accountId: string): StoredLogin[] {
  const sessions: StoredLogin[] = [];
  for (const row of listCached("login:")) {
    const session = peekCached<StoredLogin>(row.id)?.data;
    if (!session || session.accountId !== accountId) continue;
    sessions.push(session);
  }
  return sessions;
}

/**
 * 密码这条路不开轮询：登录结束在这里把记录合上，否则面板一直说「正在登录」。
 *
 * 设备流那条路（pollLoop）会自己把记录合上；密码这条路没有轮询，没人替它
 * 合。记录留着 pending，面板就永远停在「正在登录」，额度栏也空着。
 */
function closePendingLogins(
  accountId: string,
  outcome: { ok: true; credentialId: string } | { ok: false; message: string },
): void {
  for (const session of loginsOf(accountId)) {
    if (session.status !== "pending") continue;
    updateLogin(session.loginId, {
      status: outcome.ok ? "approved" : "failed",
      message: outcome.ok ? "登录完成。" : outcome.message,
      credentialId: outcome.ok ? outcome.credentialId : session.credentialId,
    });
  }
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
    return updateLogin(loginId, { status: "expired", message: "登录窗口已过期，请重新发起登录。" });
  }
  return current;
}

/** 用户不等了。 */
export function cancelLogin(loginId: string): { ok: boolean; message: string } {
  const current = loadLogin(loginId);
  if (!current) return { ok: false, message: `没有这次登录：${loginId}` };
  if (current.status !== "pending") {
    return { ok: false, message: `这次登录已结束（${current.status}）。` };
  }
  updateLogin(loginId, { status: "cancelled", message: "登录已取消。" });
  return { ok: true, message: "登录已取消。" };
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
 * 账号行 → 登录链要的那三样。
 *
 * 凭据落在哪一行（accountId）、它是哪个平台（platform）、哪个区域（region）。
 */
function contextOf(row: ProviderRow): LoginContext {
  return { accountId: row.id, platform: row.platform, region: row.region ?? "" };
}

/**
 * 用账号密码登录。
 *
 * 账号密码这一登录方式随那几家平台一起退场了：现在能建的平台只有两种方言
 * （用推理 Key）与模拟客户端（各自的登录流，不走这里）。这一条留着是因为面板
 * 上还有这条路径，答复要说清「不支持」，而不是静默失败。
 *
 * account_id 是账号行的 id：登录落在哪一行，凭据就存在哪一行下面。没给就用这个
 * 平台下的第一个账号。
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
  const row = accountFor(input.upstreamId, input.accountId);
  if (!row) {
    return {
      ok: false,
      message: input.accountId ? `没有这个账号：${input.accountId}` : "这个平台还没有账号，请先在面板上新增一个。",
      credentialId: "",
      accountId: "",
    };
  }
  try {
    switch (row.kind) {
      default: {
        const message = `这个账号不支持账号密码登录：${row.alias || row.id}`;
        closePendingLogins(row.id, { ok: false, message });
        return {
          ok: false,
          message,
          credentialId: "",
          accountId: "",
        };
      }
    }
  } catch (e) {
    // 登录没成，那条「正在登录」的记录也得合上：不然面板会一直等一个已经
    // 不会有结果的人。
    closePendingLogins(row.id, { ok: false, message: errorText(e) });
    throw e;
  }
}

/**
 * 面板给的 upstream + account 落到哪一行。
 *
 * 账号是数据（一行一份登录），平台是模板：给了账号 id 就用它，没给就用这个平台
 * 下的第一个账号。两者都没有就是 null，调用方要说「先在面板上新增一个」。
 */
function accountFor(upstreamId: string, accountId: string): ProviderRow | null {
  const wanted = String(accountId ?? "").trim();
  if (wanted) return provider(wanted);
  const platform = String(upstreamId ?? "").trim();
  if (!platform) return null;
  return accountsOfPlatform(platform)[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * 换码与导入
 * ------------------------------------------------------------------ */

/**
 * 这个账号上已经有推理用的 key 吗。
 *
 * key 由用户自己在面板上填（面板上的 setProviderKeys）：导入登录态不碰它。
 */
function internAiHasKey(accountId: string): boolean {
  return Boolean(internAiDiscoveryKey(storedInternAiAccount(accountId)?.discoveryKey));
}

/**
 * 用浏览器里拿到的授权码换凭据。
 *
 * 只有 intern-ai 有这条路（而且不建议：那个页面换完就把地址栏里的 code
 * 抹掉了）。
 */
export async function exchangeLoginCode(input: {
  upstreamId: string;
  accountId: string;
  code: string;
}): Promise<PasswordLoginResult> {
  if (input.upstreamId !== "intern-ai") {
    return { ok: false, message: `这个平台不使用授权码：${input.upstreamId}`, credentialId: "", accountId: "" };
  }
  if (!input.code.trim()) {
    return { ok: false, message: "缺少授权码。", credentialId: "", accountId: "" };
  }
  // 换 token 走 Discovery（端砚）那个应用。
  const token = await exchangeInternAiCode(input.code.trim());
  importInternAiToken(token);
  return {
    ok: true,
    message: internAiHasKey(input.accountId)
      ? "凭据已更新，推理用的 key 已就绪。"
      : "凭据已更新。账号上没有推理用的 API key，请在面板上填一把。",
    credentialId: providerSecretId(input.accountId),
    accountId: input.accountId,
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
}): Promise<PasswordLoginResult> {
  if (input.upstreamId !== "intern-ai") {
    return { ok: false, message: `这个平台不使用回填 token：${input.upstreamId}`, credentialId: "", accountId: "" };
  }
  if (!input.token.trim()) {
    return { ok: false, message: "缺少 token。", credentialId: "", accountId: "" };
  }
  importInternAiToken(input.token.trim());
  return {
    ok: true,
    message: internAiHasKey(input.accountId)
      ? "凭据已导入，推理用的 key 已就绪。"
      : "凭据已导入。账号上没有推理用的 API key，请在面板上填一把。",
    credentialId: providerSecretId(input.accountId),
    accountId: input.accountId,
  };
}
