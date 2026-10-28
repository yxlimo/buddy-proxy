// lib/qiniu/models.ts — 七牛能用的模型，写死的一份。
//
// 平台自己的 /v1/models 报 78 个，但那把 key 的商品分组只让一部分能用 ——
// 报出去的目录必须是我们真能调的，否则客户端挑一个就撞 403
// model_group_access_denied。等七牛提供「本 key 可用模型」的接口再换回来。
//
// 这 5 个是实测调过的：deepseek / minimax / qwen 三个回 200；nvidia 那个回 502
// （上游那个模型自己不可用）；qiniu/conatus-free 回 429（免费模型被限流 ——
// 那是模型的事，不是账号的事，见 lib/router/provider-selection.ts）。

import type { CatalogModel } from "../catalog-models.ts";

/**
 * 七牛能用的模型。
 *
 * 上下文长度与输出上限不填：平台没报，填了就是编的。
 */
export const QINIU_MODELS: CatalogModel[] = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b0-free",
    displayName: "Nemotron 3 Ultra (free)",
    reasoning: true,
    toolCall: true,
  },
  {
    id: "qiniu/conatus-free",
    displayName: "Conatus (free)",
    reasoning: true,
    toolCall: true,
  },
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    displayName: "DeepSeek V4.1 Flash",
    reasoning: true,
    toolCall: true,
  },
  {
    id: "minimax/minimax-m3.1-flash",
    displayName: "MiniMax M3.1 Flash",
    reasoning: true,
    toolCall: true,
  },
  {
    id: "qwen/qwen3.8-flash-next",
    displayName: "Qwen3.8 Flash Next",
    reasoning: true,
    toolCall: true,
  },
];
