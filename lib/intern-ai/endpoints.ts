// lib/intern-ai/endpoints.ts — 两个子站的推理端点，各是什么方言。
//
// 两个子站都同时提供 OpenAI 方言和 Anthropic 方言，但**路径前缀不一样**，
// 这是最容易接错的地方：
//
//   Discovery  OpenAI     https://discovery-api.intern-ai.org.cn/v1
//              Anthropic  https://discovery-api.intern-ai.org.cn/v1
//              两者同一个前缀，路径分别是 /chat/completions 和 /messages。
//
//   Chat       OpenAI     https://chat.intern-ai.org.cn/api/v1
//              Anthropic  https://chat.intern-ai.org.cn
//              Anthropic 那边**不带 /api**。
//
// 鉴权两边都收两种：
//
//   OpenAI     Authorization: Bearer <key>
//   Anthropic  x-api-key: <key> + anthropic-version: 1.0
//
// 实测 Chat 的 Anthropic 端点也认 `Authorization: Bearer`，但按标准发
// `x-api-key` 更保险（Claude Code 就是这么发的）。

import {
  INTERN_AI_CHAT_ANTHROPIC_BASE,
  INTERN_AI_CHAT_API_BASE,
  INTERN_AI_DISCOVERY_API_BASE,
} from "./config.ts";

/** 一个子站的推理端点形状。 */
export interface InternAiDialect {
  /** 子站名。 */
  site: "discovery" | "chat";
  /** OpenAI 方言的基地址。 */
  openaiBase: string;
  /** Anthropic 方言的基地址。 */
  anthropicBase: string;
  /** 模型清单的路径（拼在 openaiBase 后面）。 */
  modelsPath: string;
  /** OpenAI 对话的路径。 */
  chatPath: string;
  /** Anthropic 对话的路径。 */
  messagesPath: string;
}

/** 一个子站的端点。 */
export function dialectFor(site: "discovery" | "chat"): InternAiDialect {
  if (site === "discovery") {
    return {
      site,
      openaiBase: INTERN_AI_DISCOVERY_API_BASE,
      anthropicBase: INTERN_AI_DISCOVERY_API_BASE,
      modelsPath: "/models",
      chatPath: "/chat/completions",
      messagesPath: "/messages",
    };
  }
  return {
    site,
    openaiBase: INTERN_AI_CHAT_API_BASE,
    anthropicBase: INTERN_AI_CHAT_ANTHROPIC_BASE,
    modelsPath: "/models",
    chatPath: "/chat/completions",
    messagesPath: "/v1/messages",
  };
}
