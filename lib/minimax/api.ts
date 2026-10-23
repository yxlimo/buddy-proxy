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
// 出钱由网关定：轮着来，谁都不行了就换下一个。

import { configNumber, configString } from "../config.ts";
import { readEnvValue } from "../env.ts";
import { getSecret, setSecret } from "../store.ts";
import { AuthError } from "../credential.ts";
import { fetchMiniMaxTokenPlan, minimaxApiHost, type MiniMaxRegion } from "./credits.ts";

/** 最多读几个租户。 */
const MAX_TENANTS = 10;

/** 一个租户：一把 key。 */
export interface MiniMaxApiTenant {
  index: number;
  key: string;
}

function tenantSecretId(index: number): string {
  return `key:minimax-api:${index}`;
}

/**
 * 配置着的租户。
 *
 * 凭据是环境优先：key 在 .env 里换过必须立刻生效。数据库存一份副本，这样
 * 没有 .env 也能跑，面板也读得到配了什么。
 */
export function miniMaxApiTenants(): MiniMaxApiTenant[] {
  const out: MiniMaxApiTenant[] = [];
  for (let index = 1; index <= MAX_TENANTS; index++) {
    const fromEnv = readEnvValue(`MINIMAX_API_${index}_KEY`) || "";
    const stored = getSecret<string>(tenantSecretId(index)) || "";
    const key = fromEnv || stored;
    if (!key) continue;
    if (fromEnv && fromEnv !== stored) setSecret(tenantSecretId(index), "key", fromEnv);
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

  constructor(message: string, status: number) {
    super(message);
    this.name = "MiniMaxApiTenantError";
    this.status = status;
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
  body: Record<string, any>,
  region: MiniMaxRegion = "cn",
): Promise<Response> {
  const base = miniMaxApiBase(region);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: body.stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${tenant.key}`,
    },
    body: JSON.stringify({ ...body, model: body.model }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok && (response.status === 401 || response.status === 402 || response.status === 429)) {
    const text = await response.text().catch(() => "");
    throw new MiniMaxApiTenantError(
      `MiniMax 的第 ${tenant.index} 个租户接不了这个请求（HTTP ${response.status}）：${text.slice(0, 200)}`,
      response.status,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthError(
      `upstream HTTP ${response.status}`,
      `MiniMax 开放平台返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
  }
  return response;
}

/**
 * 每个租户的套餐额度。
 *
 * 额度要拿 key 去问（那个接口只认 key），所以一把 key 问一次。
 */
export async function miniMaxApiTenantPlans(
  region: MiniMaxRegion = "cn",
): Promise<{ index: number; plan: unknown }[]> {
  const out: { index: number; plan: unknown }[] = [];
  for (const tenant of miniMaxApiTenants()) {
    const plan = await fetchMiniMaxTokenPlan(tenant.key, region);
    out.push({ index: tenant.index, plan });
  }
  return out;
}

/** 租户轮着来：第一个先上，之后轮着换。 */
let cursor = 0;

export function nextMiniMaxApiTenant(tenants: MiniMaxApiTenant[]): MiniMaxApiTenant | null {
  if (!tenants.length) return null;
  const tenant = tenants[cursor % tenants.length];
  cursor = (cursor + 1) % tenants.length;
  return tenant;
}

/** 一次请求最多试几个租户。 */
export const MAX_ATTEMPTS = configNumber("MINIMAX_API_MAX_ATTEMPTS", 3);
