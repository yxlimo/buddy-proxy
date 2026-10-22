// lib/intern-ai/platform.ts — 控制台接口的调用方式。
//
// 两个子站的控制台是同一个形状，只是地址和路径前缀不同：
//
//   Discovery  {discovery}/api/tokenplan/v1/…   key、墨点、用量
//   Chat       {chat}/puyu/…                    API Token
//
// 鉴权要**两样都带**（实测）：
//
//   Authorization: Bearer <token>
//   Cookie: uaa-token=<token>; ssouid=<…>
//
// 只带 Bearer 时，key 列表那个接口会回 `-10002 request is not authenticated`
// （别的接口照常回数据）；只带 Cookie 时也一样不行。两样都带，全部接口都通。
// 所以这里两个头一起发。
//
// 回答是一个信封：{code, msg, data}。code 是数字，0 才是成功——失败的时候
// **HTTP 状态码可能还是 200**（`/api/tokenplan/v1/keys` 就是这样），所以光看
// 状态码会把失败当成功。信封里的 code 必须一起看。
//
// 错误分四种，调用方靠它决定做什么：
//
//   auth      会话没了 → 清掉会话，下次重新登录
//   captcha   要人机校验 → 只能让人在浏览器里点
//   forbidden 权限不够 → 重试没有意义
//   rate      限流 → 稍后再试
//   request   请求本身不对 → 是我们的错，改代码
//   upstream  上游挂了 → 重试可能有用

import { INTERN_AI_TOKEN_COOKIE } from "./config.ts";
import { InternAiError, classify, clearSession, type InternAiSession } from "./auth.ts";

/** 一次调用怎么发。 */
export interface ConsoleRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** 拼在路径后面的查询参数。 */
  query?: Record<string, string | number | boolean | undefined>;
  /** 额外的请求头（比如建 key 时的幂等键）。 */
  headers?: Record<string, string>;
}

/** 把查询参数拼到地址上。空的不拼。 */
export function withQuery(url: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return url;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

/**
 * 控制台接口要的两样鉴权。
 *
 * Bearer 是子站发的 token，Cookie 是同一份 token 加上 sso uid。两个都要带，
 * 原因见文件头的说明。
 */
export function consoleAuthHeaders(token: string, session?: InternAiSession): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (session) {
    const parts = [`${INTERN_AI_TOKEN_COOKIE}=${token}`];
    const uid = (session as any)?.ssoUid;
    if (uid) parts.push(`ssouid=${uid}`);
    headers.Cookie = parts.join("; ");
  }
  return headers;
}

/**
 * 调用控制台接口。
 *
 * base 是子站地址，path 从 "/api/…" 或 "/puyu/…" 开始。
 */
export async function consoleApi<T>(
  base: string,
  path: string,
  session: InternAiSession,
  token: string,
  init: ConsoleRequest = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const url = withQuery(`${base}${path}`, init.query);
  const r = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
      ...consoleAuthHeaders(token, session),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { msg: text.slice(0, 200) };
  }

  if (r.status === 401) {
    // 会话没了就把会话清掉：留着它，下一次还是会拿它去撞同一堵墙。
    clearSession();
    throw new InternAiError("auth", `控制台接口 ${new URL(url).pathname}：会话已过期（HTTP 401），重新登录`, 503);
  }
  if (!r.ok) {
    throw classify(r.status, body, `控制台接口 ${new URL(url).pathname} 失败`);
  }
  // 业务错误藏在信封里，状态码还是 200。
  const code = body?.code;
  if (typeof code === "number" && code !== 0) {
    if (code === -10002 || code === -10001) {
      // -10002 = 没认证；-10001 = 参数不对，但 token 过期时也报这个。
      throw classify(403, { ...body, code: undefined }, `控制台接口 ${new URL(url).pathname} 失败`);
    }
    throw new InternAiError(
      "request",
      `控制台接口 ${new URL(url).pathname} 返回 code=${code}：${String(body?.msg ?? "")}`,
    );
  }
  if (body && typeof body.data !== "undefined") return body.data as T;
  return body as T;
}
