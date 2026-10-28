// lib/zcode/auth.ts — ZCode（智谱 Z.ai / BigModel）的登录。
//
// ZCode 的 CLI 自己走一套浏览器 OAuth：
//
//   1. POST /api/v1/oauth/cli/init   —— 报 provider（zai / bigmodel），
//      拿回 flow_id、poll_token 和一个授权链接
//   2. 人在浏览器里打开那个链接、同意
//   3. GET  /api/v1/oauth/cli/poll/{flowId} —— 轮询；status 变成 ready 时
//      拿到 zcode JWT
//
// 这跟 Qoder 的 device flow 是一回事：一个链接 + 一个轮询。差别是 zcode 的
// JWT **没有刷新通道**（两个 adapter 都没实现 refreshToken），过期了只能
// 重登 —— 所以这个模块不假装能刷新。
//
// 依据：docs/zcode/FINDINGS.md（2026-10-23 逆向，源码行号在里面）。

import crypto from "node:crypto";
import { configNumber, configString } from "../config.ts";
import { AuthError } from "../credential.ts";
import { readSession, writeSession } from "../session.ts";
import { deleteSecret } from "../store.ts";
import { providerSecretId } from "../credential-ids.ts";
import { deriveDeviceIdentity, deviceSalt } from "../device-identity.ts";
import { dataDir } from "../paths.ts";
import {
  registerLoginFlow,
  type LoginContext,
  type LoginTicket,
  type PollResult,
} from "../login-flow.ts";

/** ZCode 自己的站点。 */
export const ZCODE_BASE = configString("ZCODE_BASE_URL", "https://zcode.z.ai").replace(/\/+$/, "");

/** 用哪家：智谱的 Z.ai（zai）还是 BigModel（bigmodel）。 */
export const ZCODE_PROVIDER = configString("ZCODE_PROVIDER", "zai");

/** 客户端报的版本号。 */
export const ZCODE_VERSION = configString("ZCODE_VERSION", "3.16.3");

/** 轮询的间隔与上限。 */
export const ZCODE_POLL_INTERVAL_MS = configNumber("ZCODE_POLL_INTERVAL_MS", 3000);
// How long the background poll waits for the user to finish the login in the
// browser. The platform's own window is longer than that (about forty
// minutes), so this is the shorter of the two: the user has to click the link
// and approve in a quarter of an hour.
export const ZCODE_POLL_TIMEOUT_MS = configNumber("ZCODE_POLL_TIMEOUT_MS", 900_000);

/**
 * 会话在数据库里的 id。
 *
 * 会话归 provider 所有：两个 ZCode 账号各有各的会话。
 */
export function sessionId(providerId = "zcode"): string {
  return providerSecretId(providerId);
}

export interface ZcodeSession {
  /** zcode JWT：模型请求用它。 */
  token: string;
  /** 平台自己的业务 token（Z.ai 的 access_token）。 */
  accessToken?: string;
  /** 用户的 id。 */
  userId?: string;
  /** 登录时用的 provider：zai 或 bigmodel。 */
  provider: string;
  /** 设备 id：请求的 metadata.user_id 里带着。 */
  deviceId: string;
  generation: number;
  loginAtMs: number;
  expiresAtMs: number;
}

/** 一次登录会话：还没同意的时候。 */
export interface ZcodeLogin {
  flowId: string;
  pollToken: string;
  authorizeUrl: string;
  expiresAtMs: number;
}

/**
 * 发起登录。
 *
 * `platform` 是用哪家：智谱的 Z.ai（zai）还是 BigModel（bigmodel）。
 *
 * poll token 是本地随机生成的 32 字节 hex —— 服务端拿它当这次登录的凭据：
 * 轮询的时候要带上同一个。
 */
export async function beginLogin(platform = ZCODE_PROVIDER): Promise<ZcodeLogin> {
  const pollToken = crypto.randomBytes(32).toString("hex");
  const r = await fetch(`${ZCODE_BASE}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${pollToken}`,
      "user-agent": `ZCode/${ZCODE_VERSION}`,
    },
    body: JSON.stringify({ provider: platform }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    throw new AuthError(
      `zcode login init failed (HTTP ${r.status})`,
      `ZCode 登录发起失败（HTTP ${r.status}）：${text.slice(0, 200)}`,
      502,
    );
  }
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const data = body?.data ?? {};
  const flowId = String(data.flow_id ?? "");
  const authorizeUrl = String(data.authorize_url ?? "");
  if (!flowId || !authorizeUrl) {
    throw new AuthError(
      "zcode login init answered without a flow",
      `ZCode 登录发起没有拿到 flow_id：${text.slice(0, 200)}`,
      502,
    );
  }
  return {
    flowId,
    pollToken: String(data.poll_token ?? pollToken),
    authorizeUrl,
    // The platform gives the window's end in **seconds**. Everything here
    // works in milliseconds, and the difference is not small: read as
    // milliseconds, the window ended in 1970 and the poll gave up at once.
    expiresAtMs: expiresAtMs(data.expires_at),
  };
}

/**
 * The platform's expiry, in seconds, as milliseconds.
 *
 * A value that is already in milliseconds (some endpoints give that) is left
 * alone: anything past the year 2000 in seconds is a mistake.
 */
export function expiresAtMs(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + ZCODE_POLL_TIMEOUT_MS;
  return n < 1e11 ? n * 1000 : n;
}

/** 轮询的结果。 */
export type PollState = "pending" | "approved" | "failed" | "expired";

/**
 * 问一次：用户同意了吗？
 *
 * 官方客户端轮询到 ready 时拿到的 `data.token` 就是 zcode JWT。
 */
export async function pollLogin(
  login: ZcodeLogin,
  providerId = "zcode",
): Promise<{ state: PollState; session?: ZcodeSession; message?: string }> {
  const r = await fetch(`${ZCODE_BASE}/api/v1/oauth/cli/poll/${encodeURIComponent(login.flowId)}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${login.pollToken}`,
      "user-agent": `ZCode/${ZCODE_VERSION}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text().catch(() => "");
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const data = body?.data ?? {};
  const status = String(data.status ?? "").toLowerCase();
  if (status === "ready" || status === "success") {
    const token = String(data.token ?? "");
    if (!token) {
      return { state: "failed", message: "ZCode 说登录好了，但没有给 token" };
    }
    const session: ZcodeSession = {
      token,
      accessToken: String(data?.zai?.access_token ?? data?.bigmodel?.access_token ?? "") || undefined,
      userId: String(data?.user?.user_id ?? "") || undefined,
      provider: String(data?.provider ?? ZCODE_PROVIDER),
      deviceId: zcodeDeviceId(providerId),
      generation: 1,
      loginAtMs: Date.now(),
      // zcode JWT 没有刷新通道，给一个保守的时长：到了就是过期了，重登。
      expiresAtMs: Date.now() + 7 * 24 * 3600 * 1000,
    };
    saveSession(session, providerId);
    return { state: "approved", session };
  }
  if (status === "failed" || status === "error") {
    return { state: "failed", message: String(body?.msg ?? data?.message ?? "ZCode 登录失败") };
  }
  if (status === "expired") {
    return { state: "expired", message: "登录窗口过期了" };
  }
  return { state: "pending" };
}

/** 存会话。 */
/**
 * 这个账号的「设备」。
 *
 * 官方客户端每安装一个设备 id（`.zcode/v2/telemetry-state.json` 的 deviceMid，
 * 一个 UUID），跨登录不变；模型请求的 `metadata.user_id.device_id` 与平台 API
 * 的 `X-Device-Mid` 是同一个。我们按账号派生（跟 Qoder / WorkBuddy 同一个做法，
 * 派生出来也是 UUID 形状）：登录多少次都是同一个 id。
 *
 * 已经有的就留着：换它等于换设备，平台会看出「这台机器换人了」。
 */
export function zcodeDeviceId(providerId = "zcode"): string {
  const existing = loadSession(providerId)?.deviceId;
  if (existing) return existing;
  return deriveDeviceIdentity(providerId, deviceSalt(dataDir())).machineId;
}

export function saveSession(session: ZcodeSession, providerId = "zcode"): void {
  writeSession(sessionId(providerId), session);
}

/**
 * 读会话。
 *
 * 过期的不算会话 —— zcode JWT 不能刷新，过期了只能重登。
 */
export function loadSession(providerId = "zcode"): ZcodeSession | null {
  const valid = (raw: any) => {
    if (!raw?.token) return false;
    // expiresAtMs 是 0 就是「不知道什么时候过期」：官方客户端的 zcode JWT
    // 没有 exp，到期由平台说了算，客户端也不记到期时间。不知道就当还有效，
    // 让平台的回答来判断。
    if (typeof raw.expiresAtMs === "number" && raw.expiresAtMs > 0 && raw.expiresAtMs < Date.now()) {
      return false;
    }
    return true;
  };
  // 只有这个账号名下那一份。旧位置（全局的 session:zcode）不再认：留着它，
  // 注销的账号会带着旧身份回来。
  return readSession<ZcodeSession>(sessionId(providerId), valid);
}

/**
 * 忘掉会话：下一次调用会重新登录。
 *
 * 旧位置（全局的 session:zcode）也清掉：留着它，注销的账号会带着旧身份
 * 回来 —— 那份凭据还在，登录的时候会被认出来。
 */
export function forgetSession(providerId = "zcode"): void {
  deleteSecret(sessionId(providerId));
  if (providerId === "zcode") deleteSecret("session:zcode");
}

/** 面板上用的凭据状态。 */
export function zcodeStatus(providerId = "zcode"): Record<string, unknown> {
  const session = loadSession(providerId);
  if (!session) return { source: sessionId(providerId), status: "anonymous", error: "no session" };
  // 官方客户端的 zcode JWT 没有 exp，到期由平台说了算。到期时间不知道的
  // 时候（0），不说它过期，也不编一个日子出来：面板上显示「—」。
  const known = session.expiresAtMs > 0;
  const remainingMs = known ? session.expiresAtMs - Date.now() : 0;
  return {
    source: sessionId(providerId),
    status: known && remainingMs <= 0 ? "expired" : "authenticated",
    provider: session.provider,
    userId: session.userId ?? "",
    generation: session.generation,
    expiresAt: known ? new Date(session.expiresAtMs).toISOString() : "",
    remainingSec: known ? Math.round(remainingMs / 1000) : 0,
    warning: false,
    loginAt: new Date(session.loginAtMs).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 登录链
 * ------------------------------------------------------------------ */

/**
 * ZCode 的登录链（登记给 lib/login-flow.ts）。
 *
 * 轮询的节奏与窗口判定都交给框架：这一段只管「给一条链接」与「问一次」。
 */
registerLoginFlow<ZcodeSession>("zcode", {
  method: "browser",
  label: "zcode",
  timeoutMs: ZCODE_POLL_TIMEOUT_MS,
  pollIntervalMs: ZCODE_POLL_INTERVAL_MS,
  begin: async (_ctx: LoginContext): Promise<LoginTicket> => {
    const login = await beginLogin();
    return {
      method: "browser",
      authorizationUrl: login.authorizeUrl,
      userCode: "",
      expiresAtMs: login.expiresAtMs,
      message: "请在浏览器中打开上方链接并完成登录，之后此处会自动显示为已登录。",
      state: { login },
    };
  },
  poll: async (ctx: LoginContext, ticket: LoginTicket): Promise<PollResult<ZcodeSession>> => {
    const r = await pollLogin(ticket.state.login as ZcodeLogin, ctx.accountId);
    if (r.state === "approved") return { state: "approved", session: r.session as ZcodeSession };
    if (r.state === "failed") return { state: "failed", message: r.message ?? "登录未成功。" };
    if (r.state === "expired") return { state: "expired", message: r.message ?? "登录窗口过期了。" };
    return { state: "pending" };
  },
  // 会话已经在 pollLogin 批准时存过了，这里不再存一次：存两次会把刚写好的
  // 会话当成「更旧的那份」再写一遍。
  commit: (ctx: LoginContext) => providerSecretId(ctx.accountId),
});
