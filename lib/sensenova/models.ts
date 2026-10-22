// lib/sensenova/models.ts — 有哪些模型，id 是什么，怎么选。
//
// 三个地方能看到模型，说的不是一回事：
//
//   推理端点 {base}/models       这个 key 真正能调的模型。带 key 才能问，
//                                回的是 OpenRouter 那套字段（OpenAI 的壳）。
//   积分池的 model_ids           套餐覆盖的模型。免费公测的账号在这里能
//                                看到套餐给的全部模型。
//   控制台 {platform}/lite/console/v1/metered/models
//                                按量计费那边的可选模型，Free 账号是空的。
//
// 选模型的时候看两件事：模型在不在这个 key 的清单里，模型落在哪个池子。
// 池子决定它先扣哪一个池的积分（见 lib/sensenova/quota.ts）。

import { SENSENOVA_INFER_BASE } from "./config.ts";

/** 推理端点上的一个模型。 */
export interface SenseNovaModel {
  /** 调模型时用的 id。 */
  id: string;
  name: string;
  /** 上下文长度，token 数。 */
  contextLength: number;
  /** 一次最多输出多少 token。 */
  maxOutputLength: number;
  /** 输入模态，比如 ["text"]。 */
  inputModalities: string[];
  /** 输出模态。 */
  outputModalities: string[];
  /** 支持的能力，比如 tools / json_mode / reasoning。 */
  features: string[];
}

/** 把接口返回的一行读成模型。 */
export function parseModelRow(row: any): SenseNovaModel {
  return {
    id: String(row?.id ?? ""),
    name: String(row?.name ?? row?.id ?? ""),
    contextLength: Number(row?.context_length ?? 0) || 0,
    maxOutputLength: Number(row?.max_output_length ?? 0) || 0,
    inputModalities: Array.isArray(row?.input_modalities) ? row.input_modalities.map(String) : [],
    outputModalities: Array.isArray(row?.output_modalities) ? row.output_modalities.map(String) : [],
    features: Array.isArray(row?.supported_features) ? row.supported_features.map(String) : [],
  };
}

/**
 * 问推理端点要模型清单。
 *
 * 没有 key 就问不了：这个接口是给拿着 key 的调用方用的。
 */
export async function listModels(apiKey: string): Promise<SenseNovaModel[]> {
  const r = await fetch(`${SENSENOVA_INFER_BASE}/models`, {
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
    // 这里的错误形状是上游自己的：{"error":{"code":16,"message":"…"}}
    throw new Error(`问模型清单失败（HTTP ${r.status}）${message ? `：${message}` : ""}`);
  }
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  return rows.map(parseModelRow);
}
