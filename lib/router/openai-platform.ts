// lib/router/openai-platform.ts — the inference call of an open platform.
//
// The open platforms (SenseNova, 书生·端砚) all answer in the OpenAI dialect:
// the request goes out as it is, the answer comes back as it is, and the
// account's inference key is what authenticates it. The cookie is the login
// state; the key is what the inference endpoint wants.
//
// What differs between the platforms is the base URL, the name they are called
// in the errors, and where the key comes from — so those are what the caller
// passes in.

import { AuthError } from "../credential.ts";

/** 一个开放平台的推理端点。 */
interface OpenAiPlatform {
  /** 平台在错误里的名字：sensenova、intern-ai。 */
  id: string;
  /** 平台在人看的提示里的名字：SenseNova、书生·端砚。 */
  label: string;
  /** 推理端点的地址（`/chat/completions` 接在后面）。 */
  base: string;
  /** 账号上的推理 key。没有就是空的。 */
  key: string;
}

/**
 * 发一个请求到开放平台的推理端点。
 *
 * 请求体是 OpenAI 形状的，原样发过去；答案也是 OpenAI 形状的，原样回来。
 * 上游报错了就把它的原话带回去 —— 平台自己的话比「上游失败了」有用。
 */
export async function openAiPlatformChat(
  platform: OpenAiPlatform,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!platform.key) {
    throw new AuthError(
      `${platform.id} has no inference key`,
      `${platform.label} 账号上没有推理用的 API key。在面板里重新登录一次，网关会建一把。`,
      500,
    );
  }
  const response = await fetch(`${platform.base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${platform.key}`,
      Accept: body.stream ? "text/event-stream" : "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status === 401) {
    throw new AuthError(
      `${platform.id} rejected the key`,
      `${platform.label} 拒绝了推理用的 API key（HTTP 401）。重新登录一次，网关会换一把。`,
      502,
    );
  }
  return response;
}
