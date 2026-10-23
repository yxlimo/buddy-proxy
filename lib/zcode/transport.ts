// lib/zcode/transport.ts — 调 ZCode 的模型端点。
//
// 上游说的是 Anthropic Messages 方言，路径是：
//
//   POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
//
// 头跟官方 CLI 发的一样（docs/zcode/FINDINGS.md §3）：鉴权是两个头
// （authorization 与 x-api-key 都要），加上客户端自己的那些标识头。
// 请求体是 Anthropic 原生的，外加 ZCode 的两个字段：thinking 与
// output_config（思考档位），还有 metadata.user_id。

import crypto from "node:crypto";
import { configString } from "../config.ts";
import { AuthError } from "../credential.ts";
import { ZCODE_BASE, ZCODE_VERSION, loadSession, type ZcodeSession } from "./auth.ts";

/** 模型端点。 */
export const ZCODE_MESSAGES_URL = `${ZCODE_BASE}/api/v1/zcode-plan/anthropic/v1/messages`;

/** 客户端报的用户代理。 */
const USER_AGENT = `ZCode/${ZCODE_VERSION}`;

/** 时区：客户端报自己的，我们报 UTC。 */
const TIMEZONE = "UTC";
const LANGUAGE = "zh-CN";

/**
 * 官方客户端发的头。
 *
 * 归因那几个头（x-request-id 之类）每次请求都不一样 —— 它们是给平台看
 * 这次请求从哪来的，不是凭据。
 */
export function zcodeHeaders(session: ZcodeSession): Record<string, string> {
  return {
    // 鉴权：两个头都要（官方设计文档 2026-07-01-anthropic-authorization-header.md）。
    authorization: `Bearer ${session.token}`,
    "x-api-key": session.token,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "HTTP-Referer": ZCODE_BASE,
    "user-agent": USER_AGENT,
    "X-ZCode-App-Version": ZCODE_VERSION,
    "X-Title": "Z Code@cli",
    "X-Release-Channel": "production",
    "X-Client-Language": LANGUAGE,
    "X-Client-Timezone": TIMEZONE,
    "X-ZCode-Agent": "glm",
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "X-Os-Version": (process as any).release?.() ?? "",
    "x-request-id": crypto.randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": crypto.randomUUID(),
    "x-session-id": crypto.randomUUID(),
  };
}

/**
 * 请求体：Anthropic 原生的那些，加上 ZCode 追加的。
 *
 * 思考档位怎么写是按模型名定的（客户端的 modelApiRules）：
 * GLM-5.3 写 `thinking: {type:"enabled"}` 加 `output_config: {effort}`，
 * 别的模型只写 `thinking: {type}` —— enabled 或 disabled，取决于档位。
 * `metadata.user_id` 是设备与会话的标识。
 */
export function zcodeBody(
  body: Record<string, any>,
  session: ZcodeSession,
  effort?: string,
  model?: string,
): Record<string, any> {
  const out: Record<string, any> = { ...body };
  const level = effort ?? "medium";
  if (model && /glm-5\.3/i.test(model)) {
    out.thinking = { type: "enabled" };
    out.output_config = { effort: level };
  } else {
    out.thinking = { type: "enabled" };
  }
  out.metadata = {
    ...(body?.metadata ?? {}),
    user_id: JSON.stringify({
      device_id: session.deviceId,
      account_uuid: "",
      session_id: "",
    }),
  };
  return out;
}

/**
 * 调上游。
 *
 * 401 是登录过期（zcode JWT 没有刷新通道，只能重登）；其它错误照原样报。
 */
export async function zcodeChat(
  body: Record<string, any>,
  options: { effort?: string } = {},
): Promise<{ response: Response; session: ZcodeSession }> {
  const session = loadSession();
  if (!session) {
    throw new AuthError(
      "zcode has no session",
      "ZCode 没有登录态。在面板上登录一次。",
      503,
    );
  }
  const response = await fetch(ZCODE_MESSAGES_URL, {
    method: "POST",
    headers: {
      ...zcodeHeaders(session),
      accept: body.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(zcodeBody(body, session, options.effort, String(body.model ?? ""))),
    signal: AbortSignal.timeout(300_000),
  });
  if (response.status === 401) {
    throw new AuthError(
      "zcode rejected the session",
      "ZCode 的登录过期了（它的令牌没有刷新通道）。在面板上重新登录。",
      401,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthError(
      `upstream HTTP ${response.status}`,
      `ZCode 上游返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
  }
  return { response, session };
}
