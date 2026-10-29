// lib/xinghuo/config.ts — 讯飞星火 MaaS 的推理地址。
//
// 它有三套方言，我们只接 OpenAI Chat 那条（/v2/chat/completions）。
// 另外两条先不接：/v1/responses 与 /anthropic/v1/messages。

/** 推理端点的根。`/chat/completions` 由工厂接上。 */
export const XINGHUO_INFER_BASE = "https://maas-api.cn-huabei-1.xf-yun.com/v2";
