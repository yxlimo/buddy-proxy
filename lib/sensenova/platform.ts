// lib/sensenova/platform.ts — 控制台接口的调用方式。
//
// 控制台有两套接口，各有各的地址：
//
//   {platform}/lite/console/v1/…   积分池、额度、按量计费的 key
//   {iam}/iam/idp/v1/…             订阅模式的 key
//
// 两套都要 Bearer token。token 是控制台自己发的，登录那一步换来的。
//
// 错误分四种，调用方靠它决定做什么：
//
//   auth      会话没了 → 清掉会话，下次重新登录
//   forbidden 权限不够 → 重试没有意义，报告给用户
//   rate      限流 → 稍后再试
//   request   请求本身不对 → 是我们的错，改代码
//   upstream  上游挂了 → 重试可能有用

import { SENSENOVA_IAM_BASE, SENSENOVA_PLATFORM_BASE } from "./config.ts";
import { SenseNovaError, classify, clearSession, type SenseNovaSession } from "./auth.ts";

/** 一次调用怎么发。 */
export interface PlatformRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** 拼在路径后面的查询参数。 */
  query?: Record<string, string | number | undefined>;
}

/** 把查询参数拼到地址上。空的不拼。 */
export function withQuery(url: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return url;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

/** 发一个请求，把答案读成 JSON。 */
async function requestJson(url: string, session: SenseNovaSession, init: PlatformRequest): Promise<any> {
  const method = init.method ?? "GET";
  const r = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.accessToken}`,
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!r.ok) {
    // 会话没了就把会话清掉：留着它，下一次还是会拿它去撞同一堵墙。
    if (r.status === 401) clearSession();
    throw classify(r.status, body, `控制台接口 ${new URL(url).pathname} 失败`);
  }
  // 有些接口用 code 表示业务错误。成功的结果里没有这个字段。
  if (body && typeof body.code === "number" && body.code !== 0) {
    throw new SenseNovaError(
      "request",
      `控制台接口 ${new URL(url).pathname} 返回 code=${body.code}：${String(body.message ?? "")}`,
    );
  }
  return body;
}

/**
 * 调用控制台的接口（{platform}/lite 底下）。
 *
 * path 从 "/console/v1/…" 开始。
 */
export async function consoleApi<T>(
  path: string,
  session: SenseNovaSession,
  init: PlatformRequest = {},
): Promise<T> {
  const url = withQuery(`${SENSENOVA_PLATFORM_BASE}/lite${path}`, init.query);
  return (await requestJson(url, session, init)) as T;
}

/** 调用身份服务的接口（key 的增删查在那边）。 */
export async function iamApi<T>(
  path: string,
  session: SenseNovaSession,
  init: PlatformRequest = {},
): Promise<T> {
  const url = withQuery(`${SENSENOVA_IAM_BASE}${path}`, init.query);
  return (await requestJson(url, session, init)) as T;
}
