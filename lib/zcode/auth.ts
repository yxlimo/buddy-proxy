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

/** ZCode 自己的站点。 */
export const ZCODE_BASE = configString("ZCODE_BASE_URL", "https://zcode.z.ai").replace(/\/+$/, "");

/** 用哪家：智谱的 Z.ai（zai）还是 BigModel（bigmodel）。 */
export const ZCODE_PROVIDER = configString("ZCODE_PROVIDER", "zai");

/** 客户端报的版本号。 */
export const ZCODE_VERSION = configString("ZCODE_VERSION", "3.16.2");

/** 轮询的间隔与上限。 */
export const ZCODE_POLL_INTERVAL_MS = configNumber("ZCODE_POLL_INTERVAL_MS", 3000);
export const ZCODE_POLL_TIMEOUT_MS = configNumber("ZCODE_POLL_TIMEOUT_MS", 300_000);

/** 会话在数据库里的 id。 */
const SESSION_ID = "session:zcode";

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
 * poll token 是本地随机生成的 32 字节 hex —— 服务端拿它当这次登录的凭据：
 * 轮询的时候要带上同一个。
 */
export async function beginLogin(provider = ZCODE_PROVIDER): Promise<ZcodeLogin> {
  const pollToken = crypto.randomBytes(32).toString("hex");
  const r = await fetch(`${ZCODE_BASE}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${pollToken}`,
      "user-agent": `ZCode/${ZCODE_VERSION}`,
    },
    body: JSON.stringify({ provider }),
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
    expiresAtMs: Number(data.expires_at ?? 0) || Date.now() + ZCODE_POLL_TIMEOUT_MS,
  };
}

/** 轮询的结果。 */
export type PollState = "pending" | "approved" | "failed" | "expired";

/**
 * 问一次：用户同意了吗？
 *
 * 官方客户端轮询到 ready 时拿到的 `data.token` 就是 zcode JWT。
 */
export async function pollLogin(login: ZcodeLogin): Promise<{ state: PollState; session?: ZcodeSession; message?: string }> {
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
      deviceId: crypto.randomUUID(),
      generation: 1,
      loginAtMs: Date.now(),
      // zcode JWT 没有刷新通道，给一个保守的时长：到了就是过期了，重登。
      expiresAtMs: Date.now() + 7 * 24 * 3600 * 1000,
    };
    saveSession(session);
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
export function saveSession(session: ZcodeSession): void {
  writeSession(SESSION_ID, session);
}

/**
 * 读会话。
 *
 * 过期的不算会话 —— zcode JWT 不能刷新，过期了只能重登。
 */
export function loadSession(): ZcodeSession | null {
  return readSession<ZcodeSession>(SESSION_ID, (raw) => {
    if (!raw?.token) return false;
    if (typeof raw.expiresAtMs === "number" && raw.expiresAtMs < Date.now()) return false;
    return true;
  });
}

/** 忘掉会话：下一次调用会重新登录。 */
export function forgetSession(): void {
  deleteSecret(SESSION_ID);
}

/** 面板上用的凭据状态。 */
export function zcodeStatus(): Record<string, unknown> {
  const session = loadSession();
  if (!session) return { source: SESSION_ID, status: "anonymous", error: "no session" };
  const remainingMs = session.expiresAtMs - Date.now();
  return {
    source: SESSION_ID,
    status: remainingMs > 0 ? "authenticated" : "expired",
    provider: session.provider,
    userId: session.userId ?? "",
    generation: session.generation,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    remainingSec: Math.round(remainingMs / 1000),
    warning: false,
    loginAt: new Date(session.loginAtMs).toISOString(),
  };
}
