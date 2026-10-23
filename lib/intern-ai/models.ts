// lib/intern-ai/models.ts — 两个子站各自有哪些模型，id 是什么。
//
// 四个清单，说的不是一回事：
//
//   Discovery 推理   GET {discovery-api}/v1/models        这把 key 真正能调的
//   Discovery 控制台 GET {discovery}/api/tokenplan/v1/models  平台在售的模型
//   Chat 推理        GET {chat}/api/v1/models              这把 token 真正能调的
//   Chat 控制台      GET {chat}/puyu/models                平台在售的模型
//
// 推理端点的回答是 OpenAI 的壳 `{object:"list", data:[…]}`，但是 Discovery 的
// 回答里还并列一个 `models` 数组：那是决策模型（SystemOne 接口专用），放在
// `models[].name` 里，不在 `data[].id` 里。
//
// 选模型的时候看三件事：id 是什么、支持哪些协议、落在哪一批墨点里（见
// lib/intern-ai/quota.ts）。

import { INTERN_AI_CHAT_API_BASE, INTERN_AI_CHAT_BASE, INTERN_AI_DISCOVERY_API_BASE, INTERN_AI_DISCOVERY_BASE } from "./config.ts";
import { consoleApi } from "./platform.ts";
import type { InternAiSession } from "./auth.ts";

/** 推理端点上的一个模型。 */
export interface InternAiModel {
  /** 调模型时用的 id。 */
  id: string;
  /** 人看的名字。 */
  name: string;
  /** 上下文长度，token 数。 */
  contextLength: number;
  /** 输入模态，比如 ["text"]。 */
  inputTypes: string[];
  /** 支持的能力。平台给的是中文，比如「工具调用」。 */
  capabilities: string[];
  /** 能力的英文说法。平台给中文的时候这一份是空的。 */
  capabilitiesEn: string[];
  /** 支持的协议，比如 ["OpenAI ChatCompletions"]。 */
  supportedProtocols: string[];
}

/** 决策模型（只支持 SystemOne 接口）。 */
export interface InternAiDecisionModel {
  /** 调模型时用的 id。 */
  name: string;
  description: string;
  releaseDate: string;
}

/** 推理端点的模型清单。 */
export interface InternAiModelList {
  models: InternAiModel[];
  /** 决策模型，和生成模型并列，不在 models 里。 */
  decisionModels: InternAiDecisionModel[];
}

/** 数字：平台给的可能是字符串，坏的当 0。 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 把推理端点的一行读成模型。 */
export function parseModelRow(row: any): InternAiModel {
  return {
    id: String(row?.id ?? ""),
    name: String(row?.name ?? row?.id ?? ""),
    contextLength: num(row?.context_length),
    inputTypes: Array.isArray(row?.input_types) ? row.input_types.map(String) : [],
    capabilities: Array.isArray(row?.capabilities) ? row.capabilities.map(String) : [],
    capabilitiesEn: Array.isArray(row?.capabilities_en) ? row.capabilities_en.map(String) : [],
    supportedProtocols: Array.isArray(row?.supported_protocols) ? row.supported_protocols.map(String) : [],
  };
}

/** 读一次推理端点的模型清单。 */
export function parseModelList(body: any): InternAiModelList {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const decision = Array.isArray(body?.models) ? body.models : [];
  return {
    models: rows.map(parseModelRow),
    decisionModels: decision.map((row: any) => ({
      name: String(row?.name ?? ""),
      description: String(row?.description ?? ""),
      releaseDate: String(row?.release_date ?? ""),
    })),
  };
}

/** 用一把 key 问 Discovery 推理端点要模型清单。 */
export async function listDiscoveryModels(apiKey: string): Promise<InternAiModelList> {
  const r = await fetch(`${INTERN_AI_DISCOVERY_API_BASE}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const message = String(body?.error?.message ?? body?.message ?? "").slice(0, 200);
    throw new Error(`问模型清单失败（HTTP ${r.status}）${message ? `：${message}` : ""}`);
  }
  return parseModelList(body);
}

/** Discovery 控制台上在售的模型。 */
export async function listDiscoveryConsoleModels(
  session: InternAiSession,
  token: string,
  page = 1,
  pageSize = 50,
): Promise<InternAiModel[]> {
  const data = await consoleApi<any>(INTERN_AI_DISCOVERY_BASE, "/api/tokenplan/v1/models", session, token, {
    query: { page, page_size: pageSize },
  });
  // 数组叫 models，不叫 items。
  const items = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  return items.map((row: any) => ({
    id: String(row?.id ?? ""),
    name: String(row?.display_name ?? row?.display_name_en ?? row?.id ?? ""),
    contextLength: num(row?.context_length),
    inputTypes: Array.isArray(row?.input_types) ? row.input_types.map(String) : [],
    capabilities: Array.isArray(row?.capabilities) ? row.capabilities.map(String) : [],
    capabilitiesEn: Array.isArray(row?.capabilities_en) ? row.capabilities_en.map(String) : [],
    supportedProtocols: Array.isArray(row?.supported_protocols) ? row.supported_protocols.map(String) : [],
  }));
}

/** 用一把 token 问 Chat 推理端点要模型清单。 */
export async function listChatModels(apiKey: string): Promise<InternAiModel[]> {
  const r = await fetch(`${INTERN_AI_CHAT_API_BASE}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const message = String(body?.error?.message ?? body?.message ?? "").slice(0, 200);
    throw new Error(`问模型清单失败（HTTP ${r.status}）${message ? `：${message}` : ""}`);
  }
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  return rows.map(parseModelRow);
}

/** Chat 控制台上在售的模型。 */
export async function listChatConsoleModels(session: InternAiSession, token: string): Promise<any[]> {
  const data = await consoleApi<any>(INTERN_AI_CHAT_BASE, "/puyu/models", session, token);
  const rows = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
  return rows.map((row: any) => ({
    id: num(row?.id),
    name: String(row?.name ?? ""),
    /** 调模型时用的 id。 */
    modelId: String(row?.model_id ?? ""),
    shortName: String(row?.short_name ?? ""),
    isDefault: row?.is_default === 1 || row?.is_default === true,
    /** 5 = 通用模型（平台自己的枚举）。 */
    category: num(row?.category),
    /** 支不支持 agent 模式（agent 模式才要查每日额度）。 */
    enableAgent: row?.enable_agent === true || row?.enable_agent === 1,
  }));
}

/* ------------------------------------------------------------------ *
 * 目录
 * ------------------------------------------------------------------ */

/** 目录里的一个模型：面板与客户端看的那些字段。 */
export interface InternAiCatalogModel {
  /** 调模型时用的 id。 */
  id: string;
  /** 人看的名字。 */
  name: string;
  /** 上下文长度，token 数。平台没报就是 0（= 不知道）。 */
  contextLength: number;
  /** 能不能思考。 */
  reasoning: boolean;
  /** 能不能调工具。 */
  toolCall: boolean;
}

/**
 * 平台说的能力里有没有这一样。
 *
 * 平台给的是中文（「工具调用」「深度思考」），也有一份英文的。两份都看，
 * 免得平台哪天只给中文或者只给英文。
 */
export function hasCapability(capabilities: string[], kind: "tool" | "reasoning"): boolean {
  const text = capabilities.join(" ").toLowerCase();
  if (kind === "tool") return /tool|function|工具/.test(text);
  return /reason|think|思考|推理/.test(text);
}

/**
 * 把推理端的清单与控制台在售的清单合成目录里的那一份。
 *
 * 推理端是准的 —— 这把 key 真正能调的就是这些 —— 但它只给 id 与名字。上下文
 * 长度与「能不能思考、能不能调工具」在控制台那份清单里（平台给的是中文的能
 * 力名）。所以两份合起来看：推理端说了算有哪个模型，控制台补上它的脾气。
 *
 * 控制台那份拿不到的时候，工具调用按「有」算：推理端是 OpenAI 方言的接口，
 * 回答里就带着 tool_calls —— 平台在售的模型都接 tools。
 */
export function mergeCatalogModels(
  inference: InternAiModel[],
  consoleModels: InternAiModel[] = [],
): InternAiCatalogModel[] {
  return inference.map((model) => {
    const listed = consoleModels.find((c) => c.id === model.id);
    const capabilities = listed ? [...listed.capabilities, ...listed.capabilitiesEn] : [];
    // 推理端只给 id，名字其实也是 id；有正经名字就用控制台那份的。
    const name = model.name && model.name !== model.id ? model.name : listed?.name;
    return {
      id: model.id,
      name: name || model.id,
      contextLength: Number(model.contextLength || listed?.contextLength || 0),
      reasoning: capabilities.length ? hasCapability(capabilities, "reasoning") : false,
      toolCall: capabilities.length ? hasCapability(capabilities, "tool") : true,
    };
  });
}
