// lib/model-catalog.ts — 外部厂商的已知模型目录：一张随仓库走的静态表。
//
// ## 这份数据管什么，不管什么
//
// 本仓已有代码目录的那几家（qoder、workbuddy、minimax、zcode、sensenova、
// intern-ai、tokenrhythm、qiniu、xinghuo）的模型清单**代码就是唯一事实**：它们
// 各自在 `lib/<kind>/models.ts` 里报上游给的清单和额度。这张表里再抄一份就是
// 「两处各有一份事实」，两边迟早打架，而打架时没人知道该信谁。所以那几家在这
// 张表里一个键都没有，要看它们的模型去读代码。
//
// 这张表只管**本仓没有代码目录的外部厂商**：直连官方 API 的 deepseek、nvidia，
// 以及 opencode zen 这类第三方聚合入口 —— 也就是用 `openai` 这一类 kind 建出来的
// 那些开放平台背后的厂商。键名是厂商的主机名，因为这份数据的语义就是「这个地址
// 指向的厂商有哪些模型」，与我们自己的 kind 无关 —— 我们接哪家、用哪个 kind 接，
// 都不影响厂商叫什么。
//
// ## nvidia 这条的数据来自哪里
//
// 不是 pi 的缓存目录。那份缓存里有 39 个免费端点，其中 22 个（ASR、TTS、视频、
// 媒体检测）连聊天接口都不通，把它们当模型列出来只会误导。nvidia 这条取自一次
// 针对 build.nvidia.com 的调研（2026-10-17）：39 个免费端点里 17 个能走聊天接口，
// 窗口取端点页的 `specifications.contextLength`，输出上限取 OpenAPI 段的
// `max_tokens.maximum`（不是示例请求里的 `default`），以及 cc-switch 导出里
// 那份已实测过的清单。`source` 里的 `research` 指的就是那份调研，`cc-switch` 指
// 本地 cc-switch 的 provider 导出。两边都带 `reasoning` 标志，那个标志的意思是
// 「能开思考」，不抄进来（见下一节）。
//
// 没列进去的：22 个连聊天接口都不通的媒体/语音端点，以及 4 个能连但在调研里就
// 判定为不适合做聊天目标的分类器模型 —— 这张表是给聊天转发看的，列一堆接不上的
// 端点只会把人带到沟里。
//
// ## 三个值域里的一处坑：`reasoning`
//
// 来源（客户端配置）里的 `reasoning` 是「这个入口支持开思考」，本仓
// `CatalogModel.reasoning` 是「这个模型本身会思考」。两者不是一回事：支持思考
// 开关的入口也可能挂着不思考的模型。所以这份数据里 `reasoning` 只在来源明确
// 表示模型本身是推理模型时才写 `true`（模型 id 自带 `reason` 标记那种），其余
// 一律不写这个键。缺键是「不知道」，`false` 也不是断言 —— 宁可少一个字段，不
// 要写错一个。`toolCall` 同理：来源没说能调工具就不写。
//
// 这一层是叶子：只读同目录的 model-catalog.json，不引任何模块。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 一条已知的模型。缺的键就是「不知道」，不是 0 / false。 */
export interface CatalogEntryModel {
  /** 上游认的模型 id。必有。 */
  id: string;
  /** 给人看的名字。 */
  name?: string;
  /** 上下文窗口（token）。 */
  contextWindow?: number;
  /** 输出上限（token）。 */
  maxOutputTokens?: number;
  /** 模型本身是不是推理模型。缺键＝不知道，不代表「不是」。 */
  reasoning?: boolean;
  /** 能不能调工具。缺键＝不知道。 */
  toolCall?: boolean;
}

/** 一个厂商的目录。 */
export interface CatalogEntry {
  /** 这条目录是从哪几处参考数据里抽出来的：`pi` / `pi-store` / `opencode` / `cc-switch` / `research`。 */
  source: string[];
  models: CatalogEntryModel[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 读一次，之后都走内存。
 *
 * 读不到不算错：目录是锦上添花，缺了网关照常转发。所以这里不抛，返回空表 ——
 * 调用方看到的仍然是「这个厂商没有已知目录」，与「文件里就没这个键」一样。
 */
function load(): Map<string, CatalogEntry> {
  const table = new Map<string, CatalogEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(HERE, "model-catalog.json"), "utf8"));
  } catch {
    return table;
  }
  if (!raw || typeof raw !== "object") return table;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<CatalogEntry> | null;
    if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) continue;
    table.set(key.toLowerCase(), {
      source: Array.isArray(entry.source) ? entry.source.map(String) : [],
      models: entry.models.filter((m): m is CatalogEntryModel => !!m && typeof m.id === "string"),
    });
  }
  return table;
}

const CATALOG = load();

/** 按 id 查的索引，第一次用到时才建：绝大多数请求不会查这一层。 */
let index: Map<string, Map<string, CatalogEntryModel>> | null = null;

function indexOf(host: string): Map<string, CatalogEntryModel> | null {
  if (!index) {
    index = new Map();
    for (const [key, entry] of CATALOG) {
      const byId = new Map<string, CatalogEntryModel>();
      for (const model of entry.models) byId.set(model.id, model);
      index.set(key, byId);
    }
  }
  return index.get(host) ?? null;
}

/**
 * 地址里的主机名，查表用。认不出就是 null。
 *
 * 用 `URL` 而不是正则：它会替我们把大小写折叠成小写、把端口摘掉（`hostname`
 * 不含端口），这两件事手写迟早漏一处。只认 http/https —— 这份表是按 HTTP 厂商
 * 地址建的，别的协议（`file:`、`mailto:`）解析出来的「主机名」没有意义。
 */
function hostOf(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname ? url.hostname.toLowerCase() : null;
}

/** 这个地址指向的厂商有没有已知目录。没有就是 null（不代表「这家没有模型」）。 */
export function knownCatalogForBaseUrl(baseUrl: string): CatalogEntry | null {
  const host = hostOf(baseUrl);
  return host === null ? null : (CATALOG.get(host) ?? null);
}

/**
 * 同上，按模型 id 找一条。找不到就是 null，不做模糊匹配。
 *
 * 精确匹配，区分大小写：上游的模型名是大小写敏感的（ZCode 只认小写的
 * `glm-5.3`），模糊匹配会把 `GLM-5.3` 说成有信息，那是错的。
 */
export function knownModelForBaseUrl(baseUrl: string, modelId: string): CatalogEntryModel | null {
  const host = hostOf(baseUrl);
  return host === null ? null : (indexOf(host)?.get(modelId) ?? null);
}
