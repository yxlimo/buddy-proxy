// lib/common-model-traits.ts — 共性表：一个模型 id，能做什么。
//
// 平台报模型清单时常常只给 id：星火的 `/v2/models` 就是这样，一条参数也不带。
// 客户端问窗口多大、能不能思考、输出上限多少，代码里除了这一个 id 什么都没有。
// 这张表就是最后一层答案：人工整理、实测出来的 id → 参数。面板在平台自己没说
// 的时候才用它，优先级是 用户自定义 > 共性表 > 代码表 > 上游 > 最小形状。
//
// 这一层是叶子：只读同目录的 model-traits.json，不引任何模块，也不发请求（与
// lib/model-catalog.ts 同一个位置的角色）。
//
// ## 为什么还要一层「近似」
//
// 星火把上游的名字压成 `xopdeepseekv4flash0731`、`xopglm51` 这种形态。把它们
// 逐个手写进表里，等于在仓库里养一份会腐烂的映射：平台改一次名字，表里就多一条
// 死条目。所以表里只收标准写法（`deepseek-v4-flash`、`glm-5-1`），查询时把两边
// 都压成「只留字母数字」的形态，表里的键是查的 id 的前缀或后缀就算候选。
//
// ## 数字是身份的一部分
//
// `deepseek-v4-flash` 与 `deepseek-v4.1-flash` 是两个模型，窗口都不一样。一个
// 「数字无关」的比较会把前者的参数借给后者 —— 这正是上一轮把 v4 与 v4.1 混起
// 来的那个坑，所以这里数字一律照字面比。
//
// 候选不止一个时答案是 null：宁可没有（客户端用自己那份默认形状，转发照旧），
// 也不要配错（把错的窗口写进公布出去的目录）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 一个模型的参数。缺的键就是「不知道」，不是 0 / false / 空数组。 */
export interface CommonTraits {
  /** 上下文窗口（token）。 */
  contextWindow?: number;
  /** 输出上限（token）。 */
  maxOutputTokens?: number;
  /** 模型本身会不会思考。 */
  reasoning?: boolean;
  /** 能不能调工具。 */
  toolCall?: boolean;
  /** 能选的思考档位。 */
  efforts?: string[];
  /** 默认档位。 */
  defaultEffort?: string;
  /** 按什么倍率计费：0 是免费。 */
  credits?: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "model-traits.json");

/**
 * 表里的键长什么样。步骤顺序固定，改一处等于改所有已入库的键：
 *
 *   1. 小写
 *   2. 去厂商前缀：最后一个 `/` 之前的部分（`meituan/longcat-flash-lite`）
 *   3. 去日期/版本尾巴：末尾 4 位或 8 位数字，带不带连字符都算
 *      （`-1017`、`-0731`、`-20250731`，以及压缩写法里粘着的 `...flash0731`）。
 *      只有剩下的还是名字才去：整串数字、或者去完最后一位还是数字的，不动
 *   4. 点与下划线折成连字符，`--` 收成一个
 *   5. 去首尾连字符
 */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  const tail = /-?(?:\d{8}|\d{4})$/.exec(s);
  if (tail && tail.index > 0 && !/\d$/.test(s.slice(0, tail.index))) s = s.slice(0, tail.index);
  s = s.replace(/[._]/g, "-").replace(/-{2,}/g, "-");
  return s.replace(/^-+|-+$/g, "");
}

/** 认一个 id 用的形态：只留字母数字，大小写无关。 */
function compressed(id: string): string {
  return id.replace(/[^a-z0-9]/g, "");
}

/**
 * 比这还短的键太笼统，前缀/后缀都能蹭上，不算证据。
 *
 * 5 是 `glm51` 的长度：星火的 `xopglm51` 要能靠它接到表里的 `glm-5-1`。
 */
const MIN_APPROX_LENGTH = 5;

/** 表里的这个键，是不是查的这个 id 的近似写法。两边的 id 都得是归一化后的。 */
function approximates(wanted: string, key: string): boolean {
  const keyForm = compressed(normalizeModelId(key));
  if (keyForm.length < MIN_APPROX_LENGTH) return false;
  const wantedForm = compressed(wanted);
  return wantedForm !== keyForm && (wantedForm.startsWith(keyForm) || wantedForm.endsWith(keyForm));
}

/**
 * 按 id 找表里的键，两级：
 *
 *   1. 归一化后完全相同
 *   2. 前缀/后缀近似，命中唯一一个才算
 *
 * `keys` 是表里的键（按归一化形态存的）。导出是为了能拿一份造出来的键集去测歧义，
 * 不必为了造一个冲突往真表里加条目。
 */
export function lookupModelId(id: string, keys: Iterable<string>): string | null {
  const wanted = normalizeModelId(id);
  if (wanted === "") return null;
  const list = [...keys];
  if (list.includes(wanted)) return wanted;
  const hits = list.filter((key) => approximates(wanted, key));
  return hits.length === 1 ? hits[0] : null;
}

/** 只有这几个键会进表：JSON 里写错的字段名在读取这一层就被丢掉。 */
type TraitField =
  | "contextWindow"
  | "maxOutputTokens"
  | "reasoning"
  | "toolCall"
  | "efforts"
  | "defaultEffort"
  | "credits";

function readTraits(raw: Record<string, unknown>): CommonTraits {
  const traits: CommonTraits = {};
  for (const [field, value] of Object.entries(raw) as [TraitField, unknown][]) {
    switch (field) {
      case "contextWindow":
      case "maxOutputTokens":
      case "credits":
        if (typeof value === "number" && Number.isFinite(value)) traits[field] = value;
        break;
      case "reasoning":
      case "toolCall":
        if (typeof value === "boolean") traits[field] = value;
        break;
      case "efforts":
        if (Array.isArray(value)) traits.efforts = value.map(String);
        break;
      case "defaultEffort":
        if (typeof value === "string") traits.defaultEffort = value;
        break;
      default:
        // `sources` 只是溯源，不参与逻辑，其余是写错的字段名
        break;
    }
  }
  return traits;
}

/**
 * 读一次，之后都走内存。
 *
 * 读不到不算错：表是锦上添花，缺了网关照常转发。所以这里不抛，返回空表 —— 调用
 * 方看到的仍然是「这个 id 不认识」。
 */
function load(): Map<string, CommonTraits> {
  const table = new Map<string, CommonTraits>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return table;
  }
  const models = (raw as { models?: unknown } | null)?.models;
  if (!models || typeof models !== "object") return table;
  for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const key = normalizeModelId(id);
    if (key === "") continue;
    // 空壳（`{}`）也要留：它说的是「这个 id 是已知模型」，只是参数不知道
    table.set(key, readTraits(value as Record<string, unknown>));
  }
  return table;
}

const TABLE = load();

/** 表是只读的：交出去的是副本，调用方改它不该影响下一次查询。 */
function copyOf(traits: CommonTraits): CommonTraits {
  const copy: CommonTraits = { ...traits };
  if (traits.efforts) copy.efforts = [...traits.efforts];
  return copy;
}

/**
 * 这个 id 的能力参数。表里没有就是 null —— 不造最小形状，那一步在合成那一层。
 *
 * 命中一条空壳时返回 `{}`：与 null 的区别是「认识这个模型」与「不认识」。
 */
export function commonTraitsOf(id: string): CommonTraits | null {
  const key = lookupModelId(id, TABLE.keys());
  if (key === null) return null;
  return copyOf(TABLE.get(key) ?? {});
}
