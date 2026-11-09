// lib/model-overrides.ts — the model metadata a person writes for a platform.
//
// A catalogue has three sources, and this file is where the last one gets its say:
//
//   1. what the platform itself says — the code's table (lib/<kind>/models.ts),
//      the catalogue the upstream published, or the row in the platform table;
//   2. the override written here, field by field: a field it states replaces the
//      one from (1), a field it leaves out keeps it;
//   3. nothing — a model only the override names is published as the minimal
//      shape plus what the override states.
//
// The merge runs once per catalogue, in the registry (lib/provider-kinds.ts wraps
// registerKind): every kind's models() goes through it, so no exit can forget it,
// and nothing is overridden twice — a second pass would make the source of a
// field impossible to explain.
//
// `0` and "not written" are two different things throughout: `credits: 0` is a
// free model, and no `credits` is "nobody says what it costs" — the same split
// CatalogModel carries (see the comment on its fields).

import { store } from "./store.ts";
// 失败的机器码与排查用的事实。文案在面板那一侧，这一层只说哪一格不对。
import type { AdminFailure, AdminResult } from "./admin/error-codes.ts";
// 只为形状：编译后这一行就没有了。catalog-models 引了开放平台那一层，从注册表
// 走过来的链上不能再长（见 registerKind 的注释）。
import type { CatalogModel } from "./catalog-models.ts";

/** int32 那一格能放下的最大值：再大的数字写进契约就是溢出。 */
const INT32_MAX = 2147483647;

/**
 * 一个模型的人工元数据。
 *
 * `undefined` 一律是「没写」：没写的字段沿用原来的来源，写了 `false` / 0 就是
 * 那个值本身。这一条贯穿到库里那一格 JSON —— 只放写了的键。
 */
export interface ModelOverrideRow {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  /**
   * 能选的档位。
   *
   * 没有这一格 = 没写（沿用原来的）。空数组 = 明确「不能选档」（固定一档，或者
   * 不能思考）—— 这与「没写」是两件事，代码表里有档位的模型靠这个区分。
   */
  effortOptions?: string[];
  /** 计费倍率。0 是免费；没有这一格是「不知道」，不是免费。 */
  credits?: number;
}

/**
 * 整表读过的那一份：平台 id → 该平台的人工条目。
 *
 * 整表读一次，而不是一个平台查一次：每个平台的目录都在请求路径上要这一份
 * （lib/router/upstreams/policy.ts → platformAvailability → kind.models()），
 * 按平台查就是每次渲染一次 SELECT。
 *
 * 缓存不会脏：这个进程独占这个库，写入口只有下面 upsertModelOverrides 与
 * deleteModelOverride 两处，写成功就把缓存清掉。将来若有第二个写者（外部进程
 * 直接改库），这里必须换成别的机制（按平台查，或者按 mtime / 通知失效），
 * 否则路由会按旧值走。
 */
let cachedOverrides: Map<string, ModelOverrideRow[]> | null = null;

/** 一个平台的人工条目，按模型 id 排（顺序稳定：发布出去的目录每次都得一样）。 */
export function listModelOverrides(platformId: string): ModelOverrideRow[] {
  const id = String(platformId ?? "").trim();
  if (!id) return [];
  // 交出去的副本（连档位那个数组一起）：调用方改这一份不该动到缓存。
  return [...(overridesByPlatform().get(id) ?? [])].map(copyRow);
}

/** 一条的副本：档位那个数组也要拷，不然改副本就等于改缓存。 */
function copyRow(row: ModelOverrideRow): ModelOverrideRow {
  return row.effortOptions === undefined ? { ...row } : { ...row, effortOptions: [...row.effortOptions] };
}

/** 整表读一次，按平台分组。写坏的行跳过 —— 见 readRow。 */
function overridesByPlatform(): Map<string, ModelOverrideRow[]> {
  if (cachedOverrides) return cachedOverrides;
  const rows = store()
    .prepare("SELECT platform_id, model_id, data FROM platform_model_override ORDER BY platform_id, model_id")
    .all() as any[];
  const grouped = new Map<string, ModelOverrideRow[]>();
  for (const row of rows) {
    const read = readRow(String(row.model_id ?? ""), row.data);
    if (!read) continue;
    const platformId = String(row.platform_id ?? "");
    const list = grouped.get(platformId);
    if (list) list.push(read);
    else grouped.set(platformId, [read]);
  }
  cachedOverrides = grouped;
  return grouped;
}

/**
 * 按 id 覆盖一个平台的人工条目。
 *
 * 发来的每一条：同 id 的换掉、新 id 的加进来；**没发来的原封不动**。删走
 * deleteModelOverride —— 覆盖语义下「没发来」与「删掉」不能再是同一件事，
 * 否则面板想改一条就得先把整份念一遍，漏念一条就是静默删除。
 *
 * 一个事务：任何一条不合格就整份不写 —— 写一半比不写更糟：面板上看着存上了，
 * 目录里却是上一次的一半。
 */
export function upsertModelOverrides(
  platformId: string,
  overrides: readonly ModelOverrideRow[],
): AdminResult {
  const id = String(platformId ?? "").trim();
  if (!id) return { ok: false, code: "PLATFORM_ID_MISSING", message: "platform id is empty" };
  // 走的可能是没经过契约解码的那条路：不是列表就说到这里，别让 TypeError 变成 500。
  if (!Array.isArray(overrides)) {
    return { ok: false, code: "MODEL_OVERRIDE_LIST_INVALID", message: "overrides is not an array" };
  }
  if (!platformExists(id)) {
    return { ok: false, code: "PLATFORM_NOT_FOUND", message: `no platform ${id}` };
  }
  // 先校验完再动库。
  const rows: ModelOverrideRow[] = [];
  // 小写 id → 第一次出现的序号（从 1 起，跟面板上数条目的口径一样）。
  const seen = new Map<string, number>();
  for (let index = 0; index < overrides.length; index++) {
    const checked = checkRow(index + 1, overrides[index], seen);
    if ("code" in checked) return checked;
    rows.push(checked.row);
  }
  const db = store();
  db.exec("BEGIN IMMEDIATE");
  try {
    // 一条 upsert 一句话：INSERT ON CONFLICT 才是「同 id 换掉」的表达，
    // 先删再插在并发与回滚上都是另一件事（中间那一刻库里没有这条）。
    const put = db.prepare(
      "INSERT INTO platform_model_override (platform_id, model_id, data) VALUES (?, ?, ?) " +
        "ON CONFLICT(platform_id, model_id) DO UPDATE SET data = excluded.data",
    );
    for (const row of rows) put.run(id, row.id, writeRow(row));
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经没了 */
    }
    // 回滚了库就还是写之前的样子，缓存也就还是对的 —— 不清。
    return {
      ok: false,
      code: "MODEL_OVERRIDE_WRITE_FAILED",
      message: `write overrides of ${id} failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }
  // 写成功：这份缓存说的已经不是库里那件事了，读下一次时重建。空列表那一次也
  // 作废 —— 这一层独占这个库，一次成功的写入口调用之后不该留着「缓存比调用早」
  // 的状态。
  cachedOverrides = null;
  return { ok: true, message: rows.length ? `已保存 ${rows.length} 个模型的人工元数据` : "没有要写的条目" };
}

/**
 * 删掉一条人工条目。
 *
 * 不存在就说清楚：静默成功会让人以为删掉了，而目录里那条其实还按人工写的走。
 */
export function deleteModelOverride(platformId: string, modelId: string): AdminResult {
  const id = String(platformId ?? "").trim();
  if (!id) return { ok: false, code: "PLATFORM_ID_MISSING", message: "platform id is empty" };
  const model = String(modelId ?? "").trim();
  if (!model) return { ok: false, code: "MODEL_ID_MISSING", message: "model id is empty" };
  if (!platformExists(id)) {
    return { ok: false, code: "PLATFORM_NOT_FOUND", message: `no platform ${id}` };
  }
  const removed = store()
    .prepare("DELETE FROM platform_model_override WHERE platform_id = ? AND model_id = ?")
    .run(id, model);
  if (Number(removed.changes) === 0) {
    return {
      ok: false,
      code: "MODEL_OVERRIDE_NOT_FOUND",
      message: `platform ${id} has no override for ${model}`,
    };
  }
  // 删成功了：缓存跟着作废，否则目录里那条会继续按人工写的走。
  cachedOverrides = null;
  return { ok: true, message: `已删除 ${model} 的人工元数据` };
}

/**
 * 一条发来的条目：校验之后归一成库里那一份。
 *
 * 不合格的都说清是第几条、哪一格不合格 —— 面板一次发一整份，只说「有一条不对」
 * 等于让人自己找。
 */
function checkRow(
  position: number,
  raw: Partial<ModelOverrideRow> | null | undefined,
  seen: Map<string, number>,
): { row: ModelOverrideRow } | AdminFailure {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "MODEL_OVERRIDE_ENTRY_INVALID", message: `entry ${position} is not an object` };
  }
  const written = String(raw.id ?? "");
  const modelId = written.trim();
  if (!written) {
    return { ok: false, code: "MODEL_ID_MISSING", message: `entry ${position} has no model id` };
  }
  if (!modelId) {
    return { ok: false, code: "MODEL_ID_MISSING", message: `entry ${position} has a blank model id` };
  }
  // 路由匹配模型 id 不分大小写（lib/router/catalog.ts），两条只差大小写的 id
  // 说的是同一个模型，存下来会互相打架。
  const folded = modelId.toLowerCase();
  const earlier = seen.get(folded);
  if (earlier !== undefined) {
    return {
      ok: false,
      code: "MODEL_ID_DUPLICATE",
      message: `entry ${position} and entry ${earlier} are the same model id (case only): ${modelId}`,
    };
  }
  const bad = [
    numberError(position, "contextWindow", raw.contextWindow),
    numberError(position, "maxOutputTokens", raw.maxOutputTokens),
    creditsError(position, raw.credits),
  ].find((problem) => problem !== null);
  if (bad) return bad;
  seen.set(folded, position);
  return { row: cleanRow({ ...raw, id: modelId }) };
}

/**
 * 一个平台的目录，叠上它的人工条目。
 *
 * 没有人工条目时把传进来的那份原样交回去（逐字段、逐顺序都不动）。有的话：
 * 基础目录里有的按 id 覆盖，基础目录里没有的追加在后 —— 那正是「人工把上游没
 * 有的模型加回目录」这条路。
 */
export function applyModelOverrides(platform: string, models: readonly CatalogModel[]): CatalogModel[] {
  const overrides = listModelOverrides(platform);
  return mergeModelOverrides(models, overrides);
}

/** 合成：基础目录 + 人工条目。纯函数，不读库，测试直接喂它。 */
export function mergeModelOverrides(
  base: readonly CatalogModel[],
  overrides: readonly ModelOverrideRow[],
): CatalogModel[] {
  if (!overrides.length) return [...base];
  const byId = new Map(overrides.map((row) => [row.id.toLowerCase(), row]));
  const out: CatalogModel[] = [];
  for (const model of base) {
    const override = byId.get(model.id.toLowerCase());
    // 顺序跟着基础目录：面板与路由里的模型次序是那一份说了算。
    out.push(override ? withOverride(model, override) : model);
  }
  const known = new Set(base.map((model) => model.id.toLowerCase()));
  for (const override of overrides) {
    // 只读了一遍的 overrides 按 id 排，所以新加的几条之间也有个稳定的先后。
    if (!known.has(override.id.toLowerCase())) out.push(fromOverride(override));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 合成的那两条路
 * ------------------------------------------------------------------ */

/**
 * 基础目录里的那一条，按人工写了的字段覆盖。
 *
 * 没写的字段原样留着 —— 包括「本来就没有」的那种（`reasoning` 缺键是「不知道」，
 * 不是 false）；所以这里不能拿 `??` 或 `||` 去合并。
 */
function withOverride(base: CatalogModel, override: ModelOverrideRow): CatalogModel {
  const model: CatalogModel = { ...base };
  if (override.displayName !== undefined) model.displayName = override.displayName;
  if (override.contextWindow !== undefined) model.contextWindow = override.contextWindow;
  if (override.maxOutputTokens !== undefined) model.maxOutputTokens = override.maxOutputTokens;
  if (override.reasoning !== undefined) model.reasoning = override.reasoning;
  if (override.toolCall !== undefined) model.toolCall = override.toolCall;
  // 空数组是「不能选档」，写进目录就得是空的 —— 不能因为「假值」跳过。
  if (override.effortOptions !== undefined) model.effortOptions = [...override.effortOptions];
  // 没写就沿用基础那一条（可能也没有：那就是「不知道」）；写了 0 就是免费。
  if (override.credits !== undefined) model.credits = override.credits;
  return model;
}

/** 基础目录里没有的那一条：人工写的字段 + 最小形状。 */
function fromOverride(override: ModelOverrideRow): CatalogModel {
  const model: CatalogModel = { id: override.id, displayName: override.displayName ?? override.id };
  if (override.contextWindow !== undefined) model.contextWindow = override.contextWindow;
  if (override.maxOutputTokens !== undefined) model.maxOutputTokens = override.maxOutputTokens;
  if (override.reasoning !== undefined) model.reasoning = override.reasoning;
  if (override.toolCall !== undefined) model.toolCall = override.toolCall;
  if (override.effortOptions !== undefined) model.effortOptions = [...override.effortOptions];
  if (override.credits !== undefined) model.credits = override.credits;
  return model;
}

/* ------------------------------------------------------------------ *
 * 库里的那一行
 * ------------------------------------------------------------------ */

/**
 * 这个平台存在吗。
 *
 * 平台的唯一数据源是表里的行（模拟客户端、厂商那几家与用户自己加的都在里面）。
 * 这里不引 lib/open-platforms.ts：它把额度插件与判定那一条链拖进来，而这一层
 * 是从 kind 注册表来的 —— 注册表在求值期是最敏感的地方，链上不能再长。查一下
 * 表里有没有这一行就够了。
 */
function platformExists(id: string): boolean {
  return store().prepare("SELECT 1 FROM platform WHERE id = ?").get(id) !== undefined;
}

/** 只放写了的字段。id 在列上，不重复存。 */
function writeRow(row: ModelOverrideRow): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "id" || value === undefined) continue;
    out[key] = value;
  }
  return JSON.stringify(out);
}

/**
 * 读一行。
 *
 * 坏掉的 JSON 返回 null（读的时候跳过），不抛：一条写坏的行不该让整个平台的目
 * 录读不出来。也不能读成「只有 id」的条目 —— 那会让一个谁都没写过的模型进目录。
 * 类型不对的字段当作没写 —— 那是唯一能确定的事。
 */
function readRow(id: string, data: unknown): ModelOverrideRow | null {
  let parsed: any;
  try {
    parsed = JSON.parse(String(data ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row: ModelOverrideRow = { id };
  const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
  row.displayName = text(parsed.displayName);
  row.contextWindow = num(parsed.contextWindow);
  row.maxOutputTokens = num(parsed.maxOutputTokens);
  row.reasoning = bool(parsed.reasoning);
  row.toolCall = bool(parsed.toolCall);
  if (Array.isArray(parsed.effortOptions)) row.effortOptions = parsed.effortOptions.map(String);
  row.credits = num(parsed.credits);
  return cleanRow(row);
}

/**
 * 去掉没写的键：`{ displayName: undefined }` 与没有这一格在语义上是一样的，留着只是噪声。
 *
 * 纯空白的名字按「没写」：落了库读回来也会被当成没写，面板上就是「存了又没了」——
 * 同一件事只在写入这一处下结论。
 */
function cleanRow(row: ModelOverrideRow): ModelOverrideRow {
  const out: ModelOverrideRow = { id: row.id };
  if (row.displayName !== undefined) {
    const name = row.displayName.trim();
    if (name) out.displayName = name;
  }
  if (row.contextWindow !== undefined) out.contextWindow = row.contextWindow;
  if (row.maxOutputTokens !== undefined) out.maxOutputTokens = row.maxOutputTokens;
  if (row.reasoning !== undefined) out.reasoning = row.reasoning;
  if (row.toolCall !== undefined) out.toolCall = row.toolCall;
  if (row.effortOptions !== undefined) out.effortOptions = row.effortOptions.map(String);
  if (row.credits !== undefined) out.credits = row.credits;
  return out;
}

/**
 * 那两个整数格的范围。
 *
 * 负数与超过 int32 的数写进契约都会失真（int32 溢出、负数没有意义），所以在写入
 * 这一处挡掉，不让它落到库里变成一个「读回来不一样」的值。
 */
function numberError(position: number, field: string, value: unknown): AdminFailure | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      ok: false,
      code: "MODEL_NUMBER_INVALID",
      message: `entry ${position} ${field} is not an integer: ${String(value)}`,
    };
  }
  if (value < 0 || value > INT32_MAX) {
    return {
      ok: false,
      code: "MODEL_NUMBER_OUT_OF_RANGE",
      message: `entry ${position} ${field} is out of 0..${INT32_MAX}: ${value}`,
    };
  }
  return null;
}

/**
 * 倍率那一格：不能是负数（负的价钱没有意义），其余由契约那一格（double）兜着。
 */
function creditsError(position: number, value: unknown): AdminFailure | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      code: "MODEL_CREDITS_INVALID",
      message: `entry ${position} credits is not a non-negative number: ${String(value)}`,
    };
  }
  return null;
}
