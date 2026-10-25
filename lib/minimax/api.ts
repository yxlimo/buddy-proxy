// lib/minimax/api.ts — MiniMax 的开放平台，按 API Key 分租户。
//
// 这跟 MiniMax Code 网关（lib/minimax/transport.ts）是两回事：
//
//   Code 网关   拿桌面端 / 授权流程的 OAuth 会话去请求，平台按 OAuth 授权
//               认它是 MiniMax Code 客户端。
//   开放平台    拿 API Key（sk-cp-… 那种 coding plan 的 key）去请求，走的是
//               普通的 OpenAI 兼容接口。
//
// 一个 key 是一份套餐，所以可以有好几个 key —— 也就是好几个租户。哪个租户
// 出钱由上游自己的策略定（见 lib/router/provider-selection.ts）：单一只调一把
// key，降级按 key 的次序换下一个。

import type { Json } from "../json.ts";
import { configString } from "../config.ts";
import { readEnvValue } from "../env.ts";
import { getSecret, setSecret } from "../store.ts";
import { AuthError } from "../credential.ts";
import { withBusinessCode, withUpstreamStatus } from "../upstream-status.ts";
import { providerSecretId } from "../providers.ts";
import { fetchMiniMaxTokenPlan, minimaxApiHost, type MiniMaxRegion } from "./credits.ts";

/** 最多读几个租户。 */
const MAX_TENANTS = 10;

/** 最多几把 key（也就是几个租户）。 */
export const MAX_MINIMAX_API_TENANTS = MAX_TENANTS;

/** 内置的那个 provider：环境变量里的那几把 key 是它的。 */
const BUILT_IN = "minimax-api";

/**
 * 某个租户的 key 存在数据库里的 id。
 *
 * key 归 provider 所有 —— 两个开放平台账号各有各的几把 key。
 */
export function miniMaxApiTenantSecretId(index: number, providerId = BUILT_IN): string {
  return providerSecretId(providerId, `key-${index}`);
}

/** 一个租户：一把 key。 */
export interface MiniMaxApiTenant {
  index: number;
  key: string;
}

/** key 以前放在这里（只有一个开放平台账号的时候）。 */
function legacyTenantSecretId(index: number): string {
  return `key:minimax-api:${index}`;
}

/**
 * 配置着的租户。
 *
 * 凭据是环境优先：key 在 .env 里换过必须立刻生效。数据库存一份副本，这样
 * 没有 .env 也能跑，面板也读得到配了什么。
 *
 * 环境变量只属于内置的那个 provider：别的 provider 不该拿它的 key。
 */
export function miniMaxApiTenants(providerId = BUILT_IN): MiniMaxApiTenant[] {
  const out: MiniMaxApiTenant[] = [];
  for (let index = 1; index <= MAX_TENANTS; index++) {
    const id = miniMaxApiTenantSecretId(index, providerId);
    // 存的形状有两种：对象（面板写的）与裸字符串（早先写的）。都认。
    // 旧的那份也认：key 是在 provider 这件事之前存的，搬一次，别让人重新配。
    // 但旧的那份是全局的，所以只有内置的那个 provider 认它。
    const raw =
      getSecret<unknown>(id) ??
      (providerId === BUILT_IN ? getSecret<unknown>(legacyTenantSecretId(index)) : null);
    const stored =
      typeof raw === "string" ? raw : raw && typeof raw === "object" && "key" in raw ? String((raw as any).key ?? "") : "";
    const fromEnv = providerId === BUILT_IN ? readEnvValue(`MINIMAX_API_${index}_KEY`) || "" : "";
    const key = fromEnv || stored;
    if (!key) continue;
    if (fromEnv && fromEnv !== stored) setSecret(id, "key", { key: fromEnv });
    out.push({ index, key });
  }
  return out;
}

/** 平台地址。区域决定用哪个主机。 */
export function miniMaxApiBase(region: MiniMaxRegion = "cn"): string {
  return configString("MINIMAX_API_BASE", "") || `${minimaxApiHost(region)}/v1`;
}

/** 平台上的模型。跟 MiniMax Code 网关的是同一批。 */
export interface MiniMaxApiModel {
  id: string;
  displayName: string;
  context: number;
  output: number;
  reasoning: boolean;
  toolCall: boolean;
}

export const MINIMAX_API_MODELS: MiniMaxApiModel[] = [
  {
    id: "MiniMax-M3",
    displayName: "MiniMax M3",
    context: 1_000_000,
    output: 128_000,
    reasoning: true,
    toolCall: true,
  },
  {
    id: "MiniMax-M3.1-Flash",
    displayName: "MiniMax M3.1-Flash",
    context: 1_000_000,
    output: 128_000,
    reasoning: true,
    toolCall: true,
  },
];

/**
 * 上游说这个租户不行了。
 *
 * 402 是套餐用完，401 是 key 不对，429 是这个 key 被限流。三种都要换下一个
 * 租户 —— 这个租户接不了这个请求。
 */
export class MiniMaxApiTenantError extends Error {
  status: number;
  /** 平台自己的业务码（如果它说了）。 */
  code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "MiniMaxApiTenantError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/**
 * 平台在 200 答复里说的失败。
 *
 * 平台有时用 200 回答一个失败的请求（base_resp.status_code 不为 0）。那不是
 * 答复 —— 客户端会以为答完了，所以网关把它变成一个错误。
 */
export class MiniMaxApiBusinessError extends AuthError {
  /** 平台自己的码。 */
  code: number;

  constructor(code: number, message: string) {
    super(
      `upstream business error ${code}`,
      `MiniMax 开放平台返回 ${code}：${message}`,
      502,
    );
    this.name = "MiniMaxApiBusinessError";
    this.code = code;
  }
}

/**
 * 平台自己的业务码。
 *
 * 平台把失败写在两个地方：错误信封的 message 末尾括号里的数字，和 200 答复里
 * 的 base_resp.status_code。业务码比 HTTP 状态码说得多：2067 是套餐用完，
 * 2013 是参数错 —— 换一把 key 也没用。
 */
export function miniMaxApiBusinessCode(json: any): number | null {
  const code = Number(json?.base_resp?.status_code ?? 0);
  return Number.isFinite(code) && code !== 0 ? code : null;
}

/** 错误信封里的业务码（message 末尾括号里的数字）。 */
export function miniMaxApiErrorCode(body: any): number | null {
  const message = String(body?.error?.message ?? "");
  const match = /\((\d{3,4})\)\s*$/.exec(message);
  return match ? Number(match[1]) : null;
}

/** 平台有时候回的不是 JSON。 */
function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * 调平台。
 *
 * 平台说的是 OpenAI 方言。Anthropic 方言的转换在方言层做（跟别的上游一样），
 * 这里只管把请求送出去、把答复拿回来。
 */
export async function miniMaxApiChat(
  tenant: MiniMaxApiTenant,
  body: Json,
  region: MiniMaxRegion = "cn",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const base = miniMaxApiBase(region);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: body.stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${tenant.key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ ...body, model: body.model }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok && (response.status === 401 || response.status === 402 || response.status === 429)) {
    const text = await response.text().catch(() => "");
    throw new MiniMaxApiTenantError(
      `MiniMax 的第 ${tenant.index} 个租户接不了这个请求（HTTP ${response.status}）：${text.slice(0, 200)}`,
      response.status,
      miniMaxApiErrorCode(parseJson(text)) ?? undefined,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new AuthError(
      `upstream HTTP ${response.status}`,
      `MiniMax 开放平台返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
    // The client sees the gateway's status; the upstream's own status says
    // whether another tenant would do better (a 400 is the request's fault).
    withUpstreamStatus(error, response.status);
    const code = miniMaxApiErrorCode(parseJson(text));
    if (code !== null) withBusinessCode(error, code);
    throw error;
  }
  return response;
}

/**
 * 平台在流的第一个帧里说的失败。
 *
 * 平台有时用 200 回答一个失败的请求（base_resp.status_code 不为 0）。流式
 * 的答复也一样：那不是答复，是失败 —— 客户端会以为答完了。
 */
export interface MiniMaxApiStreamFailure {
  /** 平台自己的码（没有就是 null）。 */
  code: number | null;
  /** 平台自己说的话。 */
  message: string;
}

/**
 * 平台有时候用 200 回答一个失败的请求 —— 流式的答复也一样，失败在第一个帧里。
 *
 * 第一个帧在写给客户端之前看：答复一旦开始就没有下一个租户可换了。看过的那
 * 些字节放回去，所以答复照旧是流式的。
 */
export async function peekMiniMaxApiStream(response: Response): Promise<Response> {
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const kept: Uint8Array[] = [];
  let text = "";
  let failure: MiniMaxApiStreamFailure | null = null;

  for (;;) {
    const frame = firstFrame(text);
    if (frame) {
      failure = failureInFrame(frame);
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    kept.push(value);
    text += decoder.decode(value, { stream: true });
  }

  if (failure) {
    await reader.cancel().catch(() => {});
    if (failure.code !== null) {
      throw new MiniMaxApiBusinessError(failure.code, failure.message);
    }
    throw new AuthError(
      "upstream business error",
      `MiniMax 开放平台返回了一个错误：${failure.message}`,
      502,
    );
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
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(rest, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "text/event-stream" },
  });
}

/** 第一个说得完的帧（没有就是还没有）。 */
function firstFrame(text: string): any | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload);
    } catch {
      /* 还没说完 */
    }
  }
  // 不是 SSE（平台有时候直接回一个 JSON 对象）。
  try {
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** 这个帧里有没有平台的失败。 */
function failureInFrame(frame: any): MiniMaxApiStreamFailure | null {
  if (!frame || typeof frame !== "object") return null;
  const code = miniMaxApiBusinessCode(frame);
  if (code !== null) {
    return { code, message: String(frame?.base_resp?.status_msg ?? "") };
  }
  const error = frame?.error;
  if (error) {
    return {
      code: miniMaxApiErrorCode(frame),
      message: String(error.message ?? error.type ?? "上游没有答复"),
    };
  }
  return null;
}

/**
 * 每个租户的套餐额度。
 *
 * 额度要拿 key 去问（那个接口只认 key），所以一把 key 问一次。
 */
export async function miniMaxApiTenantPlans(
  providerId = BUILT_IN,
  region: MiniMaxRegion = "cn",
): Promise<{ index: number; plan: unknown }[]> {
  const out: { index: number; plan: unknown }[] = [];
  for (const tenant of miniMaxApiTenants(providerId)) {
    const plan = await fetchMiniMaxTokenPlan(tenant.key, region);
    out.push({ index: tenant.index, plan });
  }
  return out;
}
