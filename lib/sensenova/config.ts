// lib/sensenova/config.ts — SenseNova 的地址和凭据，从哪里来。
//
// 三个地址分属三个服务，别弄混：
//
//   SENSENOVA_BASE            推理端点（OpenAI 方言），配置项就是它
//   SENSENOVA_PLATFORM_BASE   控制台前端 + OAuth2 代理（登录、换 token 都走它）
//   SENSENOVA_IAM_BASE        身份服务（登录接口、API key 的增删查）
//
// 地址是「设置」，走 lib/config.ts 的读取层：环境 → 数据库 → 代码里的默认。
// 默认值是公开的端点地址，不是凭据；换环境（比如内网镜像）时用配置项覆盖。
//
// 凭据（账号、密码、已有的 key）是另一回事：它们只在这个账号名下。环境变量
// 不再是凭据的来源——它以前是，而且每读一次就把自己写回数据库，于是删掉的
// 账号转眼又有了身份。
//
// 值的读法：只按键名取（lib/env.ts 的白名单读取），不打印、不写进别处。

import { configString } from "../config.ts";

/** 推理端点，比如 https://token.sensenova.cn/v1 。 */
export const SENSENOVA_INFER_BASE = configString("SENSENOVA_BASE", "https://token.sensenova.cn/v1").replace(
  /\/+$/,
  "",
);

/** 控制台前端，同时是 OAuth2 的代理端点。 */
export const SENSENOVA_PLATFORM_BASE = configString(
  "SENSENOVA_PLATFORM_BASE",
  "https://platform.sensenova.cn",
).replace(/\/+$/, "");

/** 身份服务：登录、API key。 */
export const SENSENOVA_IAM_BASE = configString("SENSENOVA_IAM_BASE", "https://iam.sensecoreapi.cn").replace(
  /\/+$/,
  "",
);

/**
 * OAuth2 的 client id。
 *
 * 控制台自己也是一个客户端，它的 client id 就是 "nova"；这里借用同一个，
 * 因为只有它被允许跳回控制台自己的地址。
 */
export const SENSENOVA_CLIENT_ID = configString("SENSENOVA_CLIENT_ID", "nova");

/**
 * 登录用的账号与密码。
 *
 * 谁优先：显式传进来的 > 数据库里这个账号自己的那份。
 */
export function senseNovaCredentials(
  explicit?: { user?: string; password?: string },
  stored?: { user?: string; password?: string } | null,
): { user: string; password: string } {
  const user = explicit?.user || stored?.user || "";
  const password = explicit?.password || stored?.password || "";
  return { user, password };
}

/**
 * 推理 key。
 *
 * 只有账号自己那一处：环境变量不是凭据来源（删掉的账号转眼又会有一把）。
 */
export function senseNovaApiKey(fallback?: string | null): string {
  return fallback || "";
}
