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

import type { Json } from "../json.ts";
import crypto from "node:crypto";
import { release as osRelease } from "node:os";
import { AuthError } from "../credential.ts";
import { ZCODE_BASE, ZCODE_VERSION, loadSession, type ZcodeSession } from "./auth.ts";
import { matchZcodeModel } from "./models.ts";

/** 模型端点。 */
export const ZCODE_MESSAGES_URL = `${ZCODE_BASE}/api/v1/zcode-plan/anthropic/v1/messages`;

/** 客户端报的用户代理。 */
const USER_AGENT = `ZCode/${ZCODE_VERSION}`;

/**
 * 时区与语言：官方客户端报的是它自己机器的值（`Intl.DateTimeFormat().resolvedOptions()`），
 * 抓包那台是 Asia/Shanghai / zh-CN。网关跑在中国区，时区也是 Asia/Shanghai。
 */
const TIMEZONE = "Asia/Shanghai";
const LANGUAGE = "zh-CN";

/**
 * 官方客户端发的头。
 *
 * 归因那几个头（x-request-id 之类）每次请求都不一样 —— 它们是给平台看
 * 这次请求从哪来的，不是凭据。
 */
/**
 * 模型请求的头。
 *
 * 官方客户端 v3.16.2 的模型请求用的是 `buildCliZCodeSourceHeaders`（见
 * docs/zcode/FINDINGS.md §3.1）：**不带** `X-Device-Mid` —— 那一套更全的头
 * 是平台 API 与遥测用的。
 *
 * sessionId 是上游会话 id：客户端的会话 id 映射过来的（见 lib/upstream-session.ts）。
 * 客户端没给会话 id 时就不发这个头 —— 官方那时候也不发。
 */
export function zcodeHeaders(
  session: ZcodeSession,
  opts: { sessionId?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
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
    // os.release() 是操作系统的版本（客户端发的是这个）。
    // process.release 是另一个东西：一个描述运行时的对象，不是函数。
    "X-Os-Version": osRelease(),
    "x-request-id": crypto.randomUUID(),
    // 主会话与子代理都当 main（我们这边不区分）。
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": crypto.randomUUID(),
  };
  // 客户端没给会话 id 就不发这个头 —— 官方那时候也不发。
  if (opts.sessionId) headers["x-session-id"] = opts.sessionId;
  return headers;
}

/**
 * 平台 API 的头（额度那些）。
 *
 * 那一套比模型请求多一个 `X-Device-Mid`：少了它，billing/balance 答「参数
 * 错误」。模型请求那边**不发**它 —— 官方客户端的模型请求没有这个头。
 */
export function zcodePlatformHeaders(
  session: ZcodeSession,
  opts: { sessionId?: string } = {},
): Record<string, string> {
  return {
    ...zcodeHeaders(session, opts),
    "X-Device-Mid": session.deviceId ?? "",
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
  body: Json,
  session: ZcodeSession,
  opts: { effort?: string; model?: string; sessionId?: string } = {},
): Json {
  const out: Json = { ...body };
  // 思考怎么发：按官方客户端的规则（config/provider/zcode-builtin.json 的
  // modelApiRules）：
  //
  //   glm-5.3 / glm-5.2  → thinking enabled + output_config.effort
  //   glm-5-turbo        → thinking disabled（它没有 effort 这个档）
  //
  // 目录里标了 reasoning 的就是能思考的，effort 跟着客户端的要求走
  // （官方那边没指定时是 medium）。
  const entry = matchZcodeModel(String(opts.model ?? ""));
  const level = opts.effort ?? "medium";
  if (entry?.reasoning) {
    out.thinking = { type: "enabled" };
    out.output_config = { effort: level };
  } else {
    out.thinking = { type: "disabled" };
    delete out.output_config;
  }
  out.metadata = {
    ...(body?.metadata ?? {}),
    // JSON 字符串套 JSON（官方就是这么发的）。
    user_id: JSON.stringify({
      device_id: session.deviceId,
      account_uuid: "",
      // 跟 `x-session-id` 是同一个值（官方那边也是同一个）。
      session_id: opts.sessionId ?? "",
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
  body: Json,
  options: { effort?: string; providerId?: string; sessionId?: string } = {},
): Promise<{ response: Response; session: ZcodeSession }> {
  const session = loadSession(options.providerId);
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
      ...zcodeHeaders(session, { sessionId: options.sessionId }),
      accept: body.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(
      zcodeBody(body, session, {
        effort: options.effort,
        model: String(body.model ?? ""),
        sessionId: options.sessionId,
      }),
    ),
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
  // 上游会用 200 带业务码报错误（额度用尽是 code 1005）。这不是答复。
  const peeked = await peekBusinessFailure(response, Boolean(body.stream));
  if (peeked.failure) throw peeked.failure;
  return { response: peeked.response, session };
}

/**
 * 业务错误：上游答 200，但 body 里是一个错误。
 *
 * 非流式时 body 是 JSON，流式时第一帧是同一个 JSON。两种都要在看之前把它
 * 认出来 —— 写给客户端之后就收不回来了。看过的字节要原样还给下游。
 */
async function peekBusinessFailure(
  response: Response,
  isStream: boolean,
): Promise<{ failure: AuthError | null; response: Response }> {
  const body = response.body;
  if (!body) return { failure: null, response };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const kept: Uint8Array[] = [];
  let text = "";
  let failure: AuthError | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    kept.push(value);
    text += decoder.decode(value, { stream: true });
    // JSON 错误是一整个对象，读到第一个「}」就够判断了。
    if (!isStream || text.includes("}")) {
      const found = businessFailure(text);
      if (found) {
        failure = found;
        break;
      }
      if (!isStream) break;
    }
  }

  if (failure) {
    await reader.cancel().catch(() => {});
    return { failure, response };
  }

  const rest = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of kept) controller.enqueue(chunk);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // 上游断了：下游会看到截断的流。
      }
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return {
    failure: null,
    response: new Response(rest, { status: response.status, headers: response.headers }),
  };
}

/** 把 body 里的业务码认出来：code 非 0 就是错误。 */
function businessFailure(text: string): AuthError | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let body: any;
  try {
    body = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const code = Number(body?.code);
  if (!Number.isFinite(code) || code === 0) return null;
  const message = String(body?.msg ?? body?.message ?? "上游报了业务错误");
  if (code === 1005) {
    return new AuthError("zcode quota exceeded", `ZCode 的套餐额度用尽了：${message}`, 402);
  }
  return new AuthError(`zcode business error ${code}`, `ZCode 上游报了错误（${code}）：${message}`, 502);
}
