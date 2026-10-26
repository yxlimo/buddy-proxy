// lib/intern-ai/config.ts — intern-ai 的地址和凭据，从哪里来。
//
// 这个平台是两套东西拼起来的：
//
//   openxlab.org.cn  账号体系。登录、OAuth 授权码都在那边（sso.openxlab.org.cn）。
//   intern-ai.org.cn 业务面。两个子站各占一块，共享同一个账号：
//
//     Discovery（端砚）  控制台在 discovery.intern-ai.org.cn，
//                        推理在 discovery-api.intern-ai.org.cn，
//                        额度单位是「墨点」。
//     Chat（浦语）       控制台和推理都在 chat.intern-ai.org.cn，
//                        API Token 的控制台页面在 internlm.intern-ai.org.cn/api/tokens，
//                        额度不是墨点，是「每天还能问多少次」。
//
// 地址是「设置」，走 lib/config.ts 的读取层：数据库 → 环境 → 代码里的默认。
// 默认值是公开端点地址，不是凭据。
//
// 凭据（手机号、密码）是另一回事：环境变量优先。原因是 .env 里换过的密码必须
// 立刻生效，不能被数据库里的一份旧拷贝挡住。数据库里留一份拷贝，是为了 .env
// 不在的时候服务照样能登录。
//
// 值的读法：只按键名取（lib/env.ts 的白名单读取），不打印、不写进别处。

import { configString } from "../config.ts";

/** openxlab 的 SSO（登录、OAuth 授权码）。 */
export const INTERN_AI_SSO_BASE = configString("INTERN_AI_SSO_BASE", "https://sso.openxlab.org.cn").replace(
  /\/+$/,
  "",
);

/** SSO 后端服务（账号密码登录、换授权码）。前缀 /gw/uaa-be 是网关路由。 */
export const INTERN_AI_SSO_API_BASE = configString(
  "INTERN_AI_SSO_API_BASE",
  "https://sso.openxlab.org.cn/gw/uaa-be",
).replace(/\/+$/, "");

/** Discovery 子站的控制台前端（TokenPlan 的 key 和墨点接口都在这台机器上）。 */
export const INTERN_AI_DISCOVERY_BASE = configString(
  "INTERN_AI_DISCOVERY_BASE",
  "https://discovery.intern-ai.org.cn",
).replace(/\/+$/, "");

/** Discovery 子站的推理端点（OpenAI 方言）。 */
export const INTERN_AI_DISCOVERY_API_BASE = configString(
  "INTERN_AI_DISCOVERY_API_BASE",
  "https://discovery-api.intern-ai.org.cn/v1",
).replace(/\/+$/, "");

/** Discovery 子站个人中心（「个人中心」页面的前端）。 */
export const INTERN_AI_DISCOVERY_USERCENTER_BASE = configString(
  "INTERN_AI_DISCOVERY_USERCENTER_BASE",
  "https://discovery-usercenter.intern-ai.org.cn",
).replace(/\/+$/, "");

/** Chat 子站（浦语）——控制台和推理都在这里。 */
export const INTERN_AI_CHAT_BASE = configString("INTERN_AI_CHAT_BASE", "https://chat.intern-ai.org.cn").replace(
  /\/+$/,
  "",
);

/** Chat 子站的推理端点（OpenAI 方言）。 */
export const INTERN_AI_CHAT_API_BASE = configString(
  "INTERN_AI_CHAT_API_BASE",
  "https://chat.intern-ai.org.cn/api/v1",
).replace(/\/+$/, "");

/**
 * Chat 子站的 Anthropic 方言端点。
 *
 * 跟 OpenAI 那边不是一个前缀：Anthropic 的路径是 `/v1/messages`，不带
 * `/api`。所以这里单独一个地址。
 */
export const INTERN_AI_CHAT_ANTHROPIC_BASE = configString(
  "INTERN_AI_CHAT_ANTHROPIC_BASE",
  "https://chat.intern-ai.org.cn",
).replace(/\/+$/, "");

/** Chat 子站的 API Token 控制台（就是「API Tokens」那一页）。 */
export const INTERN_AI_CHAT_CONSOLE_BASE = configString(
  "INTERN_AI_CHAT_CONSOLE_BASE",
  "https://internlm.intern-ai.org.cn",
).replace(/\/+$/, "");

/**
 * Discovery 子站的 OAuth 客户端 id。
 *
 * 客户端 id 决定「授权码能换到哪个应用」。两个子站各有一个，不是同一把：
 * 拿 Discovery 的 id 去换 Chat 的 token，平台会拒。
 */
export const INTERN_AI_DISCOVERY_CLIENT_ID = configString(
  "INTERN_AI_DISCOVERY_CLIENT_ID",
  "dagw07mkg1bazlxzoy31",
);

/** Chat 子站的 OAuth 客户端 id。 */
export const INTERN_AI_CHAT_CLIENT_ID = configString("INTERN_AI_CHAT_CLIENT_ID", "ebmrvod6yo0nlzaek1yp");

/** SSO 发的会话 cookie 名。两个子站都读它。 */
export const INTERN_AI_TOKEN_COOKIE = "uaa-token";

/**
 * 登录用的手机号与密码。
 *
 * 谁优先：显式传进来的 > 数据库里这个账号自己的那份。
 */
export function internAiCredentials(
  explicit?: { user?: string; password?: string },
  stored?: { user?: string; password?: string } | null,
): { user: string; password: string } {
  const user = explicit?.user || stored?.user || "";
  const password = explicit?.password || stored?.password || "";
  return { user, password };
}

/**
 * token 与两把推理 key。
 *
 * 只有账号自己那一处：环境变量不是凭据来源（删掉的账号转眼又会有一把）。
 */
export function internAiToken(fallback?: string | null): string {
  return fallback || "";
}

export function internAiDiscoveryKey(fallback?: string | null): string {
  return fallback || "";
}

export function internAiChatKey(fallback?: string | null): string {
  return fallback || "";
}
