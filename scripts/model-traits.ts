// scripts/model-traits.ts — 从各平台的上游 /models 实拉参数，增量并进共性表
// （lib/model-traits.json）。
//
//   node --experimental-strip-types scripts/model-traits.ts            # 拉 → 合并 → 写回 + 打印差异
//   node --experimental-strip-types scripts/model-traits.ts --check    # 只比对：有差异退出码 1
//   node --experimental-strip-types scripts/model-traits.ts --dry-run  # 只打印，不写
//   node --experimental-strip-types scripts/model-traits.ts --platform <id> [--platform <id> …]
//   node --experimental-strip-types scripts/model-traits.ts --table <path>   # 换一份表（测试用）
//
// ## 为什么是增量
//
// 这张表是**人写的**那一份：机器参数（上下文窗口、输出上限、能不能思考）上游会报，
// 但上游常常比实测保守，而表里那条恰恰是量过的。所以这一遍只做两件事 —— 补空字段、
// 加新条目。表里已有的键（哪怕是 `false` 或 `0`）算有主，上游说什么都不动它。
//
// ## 什么算「空」
//
// 表里没有那个键就是空。上游没给的字段也不写：`0` / `false` / `[]` 到了客户端那里
// 都是承诺（0 会被读成免费、false 会被读成不支持），不是「不知道」。
//
// ## 输出必须确定
//
// 同一份输入两次跑出来逐字节相同：模型键按字母序、条目里的键按字母序、`sources`
// 排序去重、不写时间戳。否则 --check 会天天报差异，之后就没人看它了。
//
// ## 从哪读平台
//
// BUDDY_DATA_DIR 指向的那个库（与网关同一个约定，见 lib/paths.ts 的 dbPath()）：
// platform 行的 base_url / kind，推理 key 走 kind 登记表的 keyOf —— 与「问上游要
// 模型目录」（lib/open-platform-catalog.ts 的 accountKeyOf）同一个口径，不另写一套
// 凭据解析。
//
// ## 输出里不出现什么
//
// 令牌、cookie、账号 id、本机绝对路径。打出来的只有**平台 id**（它是路径里那一段，
// 不是凭据）与仓库里的相对路径；别的路径只留文件名。拉不到时只报「哪家、什么错」
// （状态码、错误码），不贴响应正文 —— 正文里可能正好是别人的账号信息。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeModelId } from "../lib/common-model-traits.ts";
// 参数 → 上游键路径的那张表只存在一份（TRAIT_PATHS）。这里不按平台写分支，
// 也不重抄一遍路径：新家多报一个名字，改的是那一张表。
import { parseModelList, TRAIT_PATHS } from "../lib/open-platform-catalog.ts";
import { listOpenPlatforms } from "../lib/open-platforms.ts";
import type { ModelTraits } from "../lib/open-platforms.ts";
import { kindOf } from "../lib/provider-kinds.ts";
import { accountsOfPlatform } from "../lib/providers.ts";
// 引用即登记：推理 key 要问各平台模块的 keyOf，而登记发生在求值期。
import "../lib/kinds/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 仓库里那张表。 */
export const DEFAULT_TABLE = path.join(ROOT, "lib", "model-traits.json");

/**
 * 拉一次等多久（毫秒）。
 *
 * 这是维护工具，不在请求路径上，等得起；但上游不说话时也不该一直挂着。
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 上游能提供的字段：就是路径表里那几张。
 *
 * 它决定了「补哪些格」：`credits`（倍率）故意不在里面 —— 上游把倍率、每百万 token
 * 的钱、积分都叫「价格」，差三个数量级，塞进同一格就是猜（见路径表那段注释）。
 */
const UPSTREAM_FIELDS = Object.keys(TRAIT_PATHS) as (keyof ModelTraits)[];

/* ------------------------------------------------------------------ *
 * 表
 * ------------------------------------------------------------------ */

/**
 * 表里的一个条目：参数 + 来源。
 *
 * 不认识的键原样留着：有人手写了一个新字段，这个工具不该把它删掉 —— 它在读取那
 * 一层会被忽略，但文件是数据，不是这个工具的私有状态。
 */
export interface TableEntry extends ModelTraits {
  /** 这份参数是从哪看到的（平台 id；`measured` 表示来源没记下来）。 */
  sources?: string[];
  [extra: string]: unknown;
}

/** 整份表。`version` / `note` 原样带走，只动 `models`。 */
export interface TableDoc {
  version: number;
  note?: string;
  models: Record<string, TableEntry>;
}

/**
 * 打印用的路径。
 *
 * 输出会被贴进报告和交付记录，所以只给三种形态：仓库里的相对路径、`~` 开头的家
 * 目录、其余只留文件名（数据目录、临时目录都是机器事实，说了也没有信息量）。
 */
export function displayPath(file: string): string {
  const resolved = path.resolve(file);
  const rel = path.relative(ROOT, resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const home = os.homedir().replace(/[\\/]+$/, "");
  if (home && (resolved === home || resolved.startsWith(`${home}${path.sep}`))) {
    return `~${resolved.slice(home.length)}`;
  }
  return path.basename(resolved);
}

/**
 * 读表。
 *
 * 读不了就是错，不当空表：这份文件是人工整理的，把「读不到」当成「还没有」再写一
 * 遍，等于把别人写的参数清掉。
 */
export function readTable(file: string): TableDoc {
  const shown = displayPath(file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读不了 ${shown}：${(error as { code?: unknown })?.code ?? "读不到"}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // 不拼 error.message：V8 会在 JSON 语法错误里贴一段文件内容
    throw new Error(`解析不了 ${shown}：不是 JSON`);
  }
  const doc = raw as { version?: unknown; note?: unknown; models?: unknown } | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`解析不了 ${shown}：不是一份表`);
  const models = doc.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new Error(`解析不了 ${shown}：没有 models`);
  }
  const table: Record<string, TableEntry> = {};
  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${shown} 里 ${id} 不是一个对象`);
    }
    table[id] = entry as TableEntry;
  }
  return {
    version: typeof doc.version === "number" ? doc.version : 1,
    note: typeof doc.note === "string" ? doc.note : undefined,
    models: table,
  };
}

/** 键的先后：按码位比，不跟区域设置走（否则同一份表在两台机器上排不同）。 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 只留写了的键，按字母序。空数组照留：那是上游明确说「没有档位」。 */
function sortedEntry(entry: TableEntry): TableEntry {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort(byText)) {
    if (entry[key] === undefined) continue;
    out[key] = entry[key];
  }
  return out as TableEntry;
}

/** 渲染成文件内容。顶层三格保持 version / note / models 的顺序，其余全按字母序。 */
export function render(doc: TableDoc): string {
  const models: Record<string, TableEntry> = {};
  for (const id of Object.keys(doc.models).sort(byText)) models[id] = sortedEntry(doc.models[id]);
  const out: Record<string, unknown> = { version: doc.version };
  if (doc.note !== undefined) out.note = doc.note;
  out.models = models;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * 来源
 * ------------------------------------------------------------------ */

/** 一个平台：往哪问、带哪把 key。 */
export interface PlatformSource {
  /** 平台 id（路径里那一段）。只有它会被打印。 */
  id: string;
  baseUrl: string;
  /** kind 名字：决定鉴权头的形状（Anthropic 那一族不认 Bearer）。 */
  kind: string;
  /** 推理用的 key。只拿去发请求，任何一行输出里都不出现。 */
  apiKey: string;
}

/**
 * 这个平台发推理请求用的那把 key。
 *
 * 与 lib/open-platform-catalog.ts 的 accountKeyOf 同一口径：走 kind 登记表的
 * `keyOf`，不按「key 存在 key:provider:<id>:key」去找 —— 各家的凭据块不一样。
 * 判据是 `inferWith === "api_key"`：配了门户 cookie 的七牛云账号一个推理请求也发
 * 不出去，拿它去问模型清单只会被上游拒。
 */
function inferenceKeyOf(platform: string): string {
  for (const account of accountsOfPlatform(platform)) {
    const kind = kindOf(account.kind);
    if (!kind || kind.inferWith !== "api_key") continue;
    const key = String(kind.keyOf?.(account, account.id) ?? "").trim();
    if (key) return key;
  }
  return "";
}

/** 库里所有的平台行。 */
export function platformSources(): PlatformSource[] {
  return listOpenPlatforms().map((row) => ({
    id: row.id,
    baseUrl: String(row.baseUrl ?? "").trim(),
    kind: row.kind,
    apiKey: inferenceKeyOf(row.id),
  }));
}

/* ------------------------------------------------------------------ *
 * 拉一次
 * ------------------------------------------------------------------ */

/** 一次拉取的结果：要么一份清单，要么一句「哪家、什么错」。 */
export type FetchOutcome =
  | { ok: true; models: { id: string; traits: ModelTraits }[] }
  | { ok: false; reason: string };

/**
 * 一次失败的一句话。
 *
 * 只说错误码与类别，不拼上游的响应正文、也不带地址：正文里可能正好是别人的账号
 * 信息，地址里可能带查询串。
 */
function failureOf(error: unknown): string {
  const name = (error as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "超时";
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === "string" && code) return code;
  return "连不上";
}

/**
 * 问一个平台要模型清单。
 *
 * 参数从 `parseModelList` 里取（它用的就是 TRAIT_PATHS）：清单的形状、取哪几个键都
 * 只有那一处定义。请求本身在这里发，因为 lib/open-platform-catalog.ts 的那一份把
 * 失败折成一个 null（它跑在后台，只记一行日志），而这个工具要说出「哪家、什么错」，
 * 并且不能把失败当差异。鉴权头仍然问 kind 登记表，不自己拼。
 */
export async function fetchTraits(
  source: PlatformSource,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchOutcome> {
  let url: URL;
  try {
    // 结尾的斜杠与 /models 由 URL 拼：手写字符串拼接在 base 以斜杠结尾时拼出 //models
    url = new URL(`${source.baseUrl.replace(/\/+$/, "")}/models`);
  } catch {
    return { ok: false, reason: "地址不是有效的 URL" };
  }
  const auth = kindOf(source.kind)?.catalogAuth?.(source.apiKey) ?? {
    Authorization: `Bearer ${source.apiKey}`,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", ...auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: failureOf(error) };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: "答复不是 JSON" };
  }
  const models = parseModelList(payload);
  if (!models) return { ok: false, reason: "答复认不出来（不是模型清单）" };
  // 空清单当拉不到：拿一份空的去合并没有意义，还容易让人以为上游真的没有模型
  if (!models.length) return { ok: false, reason: "清单是空的" };
  return { ok: true, models };
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

/** 合并的结果：新的表，以及「变了什么」。 */
export interface MergeResult {
  models: Record<string, TableEntry>;
  /** 新加的条目，带上了这次补到的那几个字段名。 */
  added: { id: string; fields: string[] }[];
  /** 表里有这一条、但那一格是空的，这次补上了。 */
  filled: { id: string; field: string; value: unknown }[];
  /** 来源多了平台 id。 */
  sourcesAdded: { id: string; from: string[]; to: string[] }[];
  /** 这次拉到的平台不再报它了。只报，不删。 */
  vanished: string[];
}

/** 值的副本：数组另开一份，免得改写进表里的东西还牵着上游那份对象。 */
function cloneValue<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : value;
}

/**
 * 把这一轮拉到的参数并进表里。
 *
 * 语义只有三条，其余都是这三条的后果：
 *
 *   1. 表里已有的字段不覆盖。上游报了同样的键就跳过 —— 人写的（或量过的）值优先
 *   2. 表里没有的键才补。上游没给的键不写，不拿 0 / false / [] 顶上去
 *   3. 模型 id 一律过 normalizeModelId：上游的压缩写法（`xopdeepseekv4flash0731`）
 *      归一化后原样进表，不在这里做近似匹配 —— 那是 lib/common-model-traits.ts
 *      查询时的事
 *
 * 来源（`sources`）是「谁报过它」的记录：这次报过的平台 id 追加进去、排序去重。
 * 没被这次拉到的条目原样留着，不编来源。
 */
export function mergeTraits(
  existing: Record<string, TableEntry>,
  pulled: { platform: string; models: { id: string; traits: ModelTraits }[] }[],
): MergeResult {
  const models: Record<string, TableEntry> = {};
  for (const [id, entry] of Object.entries(existing)) {
    const copy: TableEntry = { ...entry };
    if (entry.efforts) copy.efforts = [...entry.efforts];
    if (entry.sources) copy.sources = [...entry.sources];
    models[id] = copy;
  }

  const result: MergeResult = { models, added: [], filled: [], sourcesAdded: [], vanished: [] };

  /** 每个平台这一轮报了哪些 id（判定「消失」用）。 */
  const reported = new Map<string, Set<string>>();

  for (const { platform, models: list } of pulled) {
    const ids = new Set<string>();
    for (const model of list) {
      const id = normalizeModelId(model.id);
      if (!id) continue;
      ids.add(id);
      const entry = models[id];
      if (!entry) {
        const created: TableEntry = {};
        const fields: string[] = [];
        for (const field of UPSTREAM_FIELDS) {
          const value = model.traits[field];
          if (value === undefined) continue;
          (created as Record<string, unknown>)[field] = cloneValue(value);
          fields.push(field);
        }
        created.sources = [platform];
        models[id] = created;
        result.added.push({ id, fields });
        continue;
      }
      for (const field of UPSTREAM_FIELDS) {
        const value = model.traits[field];
        if (value === undefined) continue;
        // 有主的字段不动：那是人写的或量过的，上游说什么都保留
        if (entry[field] !== undefined) continue;
        (entry as Record<string, unknown>)[field] = cloneValue(value);
        result.filled.push({ id, field, value });
      }
      const before = entry.sources ? [...entry.sources] : [];
      const after = [...new Set([...before, platform])].sort(byText);
      if (after.length !== before.length || after.some((name, index) => name !== before[index])) {
        entry.sources = after;
        result.sourcesAdded.push({ id, from: before, to: after });
      }
    }
    reported.set(platform, ids);
  }

  // 「消失」只在说得清的时候说：条目的每一个来源都在这一轮拉过，而它们一个都没报
  // 这个 id。有来源这一轮没拉（--platform 只拉了一家、或那一家的「measured」）就
  // 不下结论 —— 那不是消失，是我们没问。
  for (const [id, entry] of Object.entries(models)) {
    const sources = entry.sources ?? [];
    if (!sources.length) continue;
    if (!sources.every((name) => reported.has(name))) continue;
    if (sources.some((name) => reported.get(name)!.has(id))) continue;
    result.vanished.push(id);
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 差异
 * ------------------------------------------------------------------ */

/** 一个值写成人看的样子：数组 `[high,xhigh]`，字符串直接写。 */
export function textOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(String).join(",")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** 差异行。分组顺序固定（补上 → 新增 → 来源 → 消失），组内按 id 排。 */
export function diffLines(result: MergeResult): string[] {
  const lines: string[] = [];
  for (const item of [...result.filled].sort((a, b) => byText(a.id, b.id) || byText(a.field, b.field))) {
    lines.push(`${item.id} ${item.field}: 缺 → ${textOf(item.value)}`);
  }
  for (const item of [...result.added].sort((a, b) => byText(a.id, b.id))) {
    lines.push(item.fields.length ? `新增 ${item.id}：${item.fields.join(", ")}` : `新增 ${item.id}（没有参数）`);
  }
  for (const item of [...result.sourcesAdded].sort((a, b) => byText(a.id, b.id))) {
    lines.push(`${item.id} sources: ${item.from.length ? item.from.join(",") : "（无）"} → ${item.to.join(",")}`);
  }
  for (const id of [...result.vanished].sort(byText)) lines.push(`消失 ${id}（不删，只报）`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * 命令行
 * ------------------------------------------------------------------ */

export interface RunOptions {
  /** 只拉这几家（--platform，可重复）。不给就是库里有的全部。 */
  platforms?: string[];
  /** 换一份表（--table）。默认仓库里那份。 */
  table?: string;
  check?: boolean;
  dryRun?: boolean;
  /** 拉一次的等待上限（毫秒）。测试用小值，命令行不传。 */
  timeoutMs?: number;
  /** 平台来源。测试从外面给，命令行不传。 */
  sources?: PlatformSource[];
}

/**
 * 跑一次。返回退出码。
 *
 *   0  表是新的（或者已经写好了）
 *   1  --check 发现表过期
 *   2  用法或输入有问题（表读不了、平台 id 不认识）
 *
 * 拉不到上游**不是**差异：那是「这一家没问到」，退出码照常 0 —— 否则定时跑
 * --check 的人会天天看到「表要重新生成」，而其实只是某一家上游在维护。
 */
export async function run(options: RunOptions = {}): Promise<number> {
  const table = options.table ?? DEFAULT_TABLE;
  const doc = readTable(table);
  const sources = options.sources ?? platformSources();

  let wanted = sources;
  if (options.platforms?.length) {
    const byId = new Map(sources.map((source) => [source.id, source]));
    const missing = options.platforms.filter((id) => !byId.has(id));
    if (missing.length) {
      console.error(`没有这个平台：${missing.join(", ")}`);
      return 2;
    }
    wanted = options.platforms.map((id) => byId.get(id)!);
  }

  const pulled: { platform: string; models: { id: string; traits: ModelTraits }[] }[] = [];
  for (const source of wanted) {
    // 没有地址、没有 key 都是正常状态（平台刚建、还没填），不是故障：不问，也不吵
    if (!source.baseUrl) {
      console.log(`跳过 ${source.id}：没有地址`);
      continue;
    }
    if (!source.apiKey) {
      console.log(`跳过 ${source.id}：没有可推理的 API key`);
      continue;
    }
    const outcome = await fetchTraits(source, options.timeoutMs);
    if (!outcome.ok) {
      console.log(`跳过 ${source.id}：${outcome.reason}`);
      continue;
    }
    console.log(`拉到 ${source.id}：${outcome.models.length} 个模型`);
    pulled.push({ platform: source.id, models: outcome.models });
  }

  const result = mergeTraits(doc.models, pulled);
  const text = render({ version: doc.version, note: doc.note, models: result.models });
  const shown = displayPath(table);

  if (!pulled.length) console.log("一家都没拉到：这张表保持原样");
  const lines = diffLines(result);
  for (const line of lines) console.log(line);

  if (options.check) {
    if (text === readText(table)) {
      console.log("表没变");
      return 0;
    }
    console.log(`有差异：${shown} 需要重新生成（node --experimental-strip-types scripts/model-traits.ts）`);
    return 1;
  }
  if (options.dryRun) {
    console.log(lines.length ? "" : "表没变");
    console.log(`（--dry-run，不落盘）要写进 ${shown} 的内容：`);
    console.log(text);
    return 0;
  }
  fs.writeFileSync(table, text, "utf8");
  console.log(lines.length ? `写了 ${shown}` : `表没变，${shown} 原样留着`);
  return 0;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const USAGE =
  "用法：node --experimental-strip-types scripts/model-traits.ts [--check] [--dry-run] " +
  "[--platform <id>]… [--table <path>]";

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        check: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        platform: { type: "string", multiple: true },
        table: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    console.error(USAGE);
    console.error((error as Error).message);
    return 2;
  }
  const { values } = parsed;
  if (values.check && values["dry-run"]) {
    console.error("--check 与 --dry-run 选一个：一个是问「过期没有」，一个是问「会写什么」");
    return 2;
  }
  try {
    return await run({
      platforms: values.platform,
      table: values.table,
      check: values.check === true,
      dryRun: values["dry-run"] === true,
    });
  } catch (error) {
    // 唯一的错误出口：整句过一遍脱敏，fs/fetch 冒泡上来的消息里带着路径
    console.error(maskMessage((error as Error)?.message ?? String(error)));
    return 2;
  }
}

/** 一句话里的绝对路径与家目录都盖住。错误消息里常带着 Node 自己拼的路径。 */
function maskMessage(message: string): string {
  const home = os.homedir().replace(/[\\/]+$/, "");
  let out = message;
  if (home) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, "g"), "~");
  }
  return out;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
