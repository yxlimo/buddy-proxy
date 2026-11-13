// helper/build-model-traits.ts — 从 pi 的内建模型库生成共性表（lib/model-traits.json）。
//
//   node --experimental-strip-types helper/build-model-traits.ts \
//     --from <pi 包目录 | dist/bundle/chunks/chunk-XXXX.js> \
//     --out lib/model-traits.json
//
//   node --experimental-strip-types helper/build-model-traits.ts --out lib/model-traits.json
//                                                              # 自己从 pi 可执行文件推断
//
// ## 为什么拿 pi 的库当参考值
//
// 平台报模型清单时常常只给一个 id（星火的 `/v2/models` 一条参数都不带），而上游
// 没报的那几格（窗口、输出上限、能不能思考、能选哪几档）客户端是要问的。pi 的
// 内建库里每个模型都带着这几格 —— 那是它自己的客户端跑出来的答案，比我们凭空猜
// 准，也比让客户端各自用默认形状强。
//
// ## 这一层只给「近似」，不给「结论」
//
// 生成出来的条目是参考值：合成目录时它排在最后（lib/catalog-models.ts 的顺序），
// 只有上游、代码表、人工都没说话的那一格才会被填上。所以这里宁可少写一格，也不
// 写一个「谁都没确认过」的值 —— 0 会被读成免费、false 会被读成不支持、空数组会
// 被读成「没有档位可选」。
//
// ## 为什么不抽价格
//
// pi 的条目里有 `cost`，但同名模型在不同平台的价钱不一样（中转站、官方、各家
// 套餐价的倍率差好几个数量级）。把 pi 的一份价格借给别的平台就是假账，而账目错
// 了比缺账难查得多。价格只能来自各平台自己的目录，所以这里一个字都不取。
//
// ## 人工那一份在上层
//
// 手写的条目在 lib/model-traits.manual.json：人工整理的是实测值，pi 的库是别人
// 客户端的配置。两层合起来的时候人工优先 —— 人工写了的字段，pi 说什么都不盖。
//
// ## 输出必须确定
//
// 同一份输入两次跑出来逐字节相同：模型键按码位排、条目里的键按码位排、不写本机
// 路径。`generatedAt` 只到日期，同一天重跑 `git diff` 应当是空的。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// 归一化只存在一处（运行期查表用的就是它）：表里的键必须与查询那一侧同一个形状，
// 否则「按 id 完全命中」那一级会悄悄失效，只剩近似兜着。
import { normalizeModelId } from "../lib/common-model-traits.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 仓库里那张表。 */
export const DEFAULT_OUT = path.join(ROOT, "lib", "model-traits.json");

/** 人工那一份。生成的表由它来盖最上层。 */
export const DEFAULT_MANUAL = path.join(ROOT, "lib", "model-traits.manual.json");

/** 从 pi 包里认它的模型库：那一个 chunk 导出了 `getProviders` / `getModels`。 */
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * 档位的先后。
 *
 * 客户端按这个顺序渲染选择器，表里的顺序也该是这个（不是字母序：`high` 在
 * `low` 前面就没人看得懂）。`off` 排第一 —— 它是「不思考」，与 `minimal` 不是
 * 同一件事，但比所有的「思考多少」都更少。
 */
export const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 表里的一条：参数 + 溯源。 */
export interface TableEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  efforts?: string[];
  defaultEffort?: string;
  credits?: number;
  /** pi 里这个 id 出现在哪些 provider 下（排序去重）。 */
  providers?: string[];
  /** 人工那条记的来源（平台 id；`measured` 表示来源没记下来）。 */
  sources?: string[];
  [extra: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * 找输入的模型库
 * ------------------------------------------------------------------ */

/**
 * 往上找一个包，返回它的目录与 name/version。找不到就 null。
 *
 * 两层都看：`<这一层>/package.json`（文件就在包里），以及
 * `<这一层>/lib/node_modules/<包名>/package.json`（文件在包外，nix 这类安装方式
 * 把可执行文件放在 `<包根>/bin`、真正的包装在 `lib/node_modules` 下面）。
 * 给了 `wantName` 就只认这个名字：往上爬会经过一堆别的包，名字不对的那份不是要的。
 */
function packageAbove(file: string, wantName?: string): { dir: string; name: string; version: string } | null {
  const readOne = (dir: string): { dir: string; name: string; version: string } | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      const name = typeof parsed.name === "string" ? parsed.name : "";
      if (wantName && name !== wantName) return null;
      return { dir, name, version: typeof parsed.version === "string" ? parsed.version : "" };
    } catch {
      return null;
    }
  };
  let current = path.dirname(path.resolve(file));
  for (;;) {
    const direct = readOne(current);
    if (direct) return direct;
    if (wantName) {
      for (const nested of [path.join(current, "lib", "node_modules"), path.join(current, "node_modules")]) {
        const found = readOne(path.join(nested, wantName));
        if (found) return found;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 一个目录里所有 chunk 里挑出导出模型库的那一个。 */
function modelChunkIn(chunksDir: string): string {
  const files = fs
    .readdirSync(chunksDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  // 判据是「这个文件里定义了内建模型表」，不是「文件名像」：文件名是哈希，换一个
  // 版本就变，而这两个标识符是模型库自己的形状。
  const hits = files.filter((name) => {
    const text = fs.readFileSync(path.join(chunksDir, name), "utf8");
    return text.includes("getBuiltinModels") && text.includes("thinkingLevelMap");
  });
  if (hits.length !== 1) {
    throw new Error(
      `${chunksDir} 里找到 ${hits.length} 个像模型库的 chunk（要找恰好一个）：${hits.join(", ") || "没有"}`,
    );
  }
  return path.join(chunksDir, hits[0]);
}

/**
 * `pi` 可执行文件指到的那些包。
 *
 * 一行 `command -v pi` 常常指到一个 wrapper 脚本（nix / home-manager 生成的启动器
 * 就是这样：它 set 几个环境变量，最后 exec 真正的那个包）。所以文件本身、以及
 * 脚本里出现的每一个绝对路径都算候选，取第一个包名对得上的。
 */
function packagesFromExecutable(): { dir: string; name: string; version: string }[] {
  let exe: string;
  try {
    exe = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("找不到 pi 可执行文件：用 --from 指明 pi 包目录或那个 chunk 文件");
  }
  if (!exe) throw new Error("找不到 pi 可执行文件：用 --from 指明 pi 包目录或那个 chunk 文件");
  const candidates = [fs.realpathSync(exe)];
  try {
    const text = fs.readFileSync(candidates[0], "utf8");
    // 二进制（`bun build --compile` 那种）里没有可读的路径，不看它
    if (!text.includes("\u0000")) {
      for (const match of text.matchAll(/(\/[^\s"'`;|&)]+)/g)) candidates.push(match[1]);
    }
  } catch {
    /* 读不了就看文件本身 */
  }
  const found: { dir: string; name: string; version: string }[] = [];
  for (const candidate of candidates) {
    // 名字对得上才算：脚本里还有 bash、node 那些别的包的路径
    const pkg = packageAbove(candidate, PACKAGE_NAME);
    if (pkg && !found.some((other) => other.dir === pkg.dir)) found.push(pkg);
  }
  if (!found.length) {
    throw new Error(`${PACKAGE_NAME} 不在 pi 可执行文件的路径上：用 --from 指明 pi 包目录或那个 chunk 文件`);
  }
  return found;
}

/**
 * `--from` 的三种写法：那个 chunk 文件、包目录、chunks 目录。
 *
 * 不写 `--from` 就跟着 pi 可执行文件走。推断不出来时抛错而不是用空表往下走 ——
 * 空表会覆盖仓库里那张表，把那几十条实测值一次抹掉。
 */
export function locateModelModule(from?: string): {
  module: string;
  pkg: { name: string; version: string };
} {
  const source = String(from ?? "").trim();
  if (!source) {
    // 有几个候选包就试几个：wrapper 那条通常指不到，真正那个在后头
    const problems: string[] = [];
    for (const pkg of packagesFromExecutable()) {
      try {
        return { module: modelChunkIn(path.join(pkg.dir, "dist", "bundle", "chunks")), pkg };
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    throw new Error(`从 pi 可执行文件推断不出模型库：${problems.join("；")}。用 --from 指明那个 chunk 文件`);
  }
  const resolved = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`--from 指的路径读不到：${path.basename(resolved)}`);
  }
  if (stat.isFile()) {
    if (!resolved.endsWith(".js")) throw new Error(`--from 指的文件不是 .js：${path.basename(resolved)}`);
    const found = packageAbove(resolved);
    return {
      module: resolved,
      pkg: { name: found?.name ?? "", version: found?.version ?? "" },
    };
  }
  // 目录：包目录（里面有 dist/bundle/chunks）或者 chunks 目录本身
  const nested = path.join(resolved, "dist", "bundle", "chunks");
  const chunksDir = fs.existsSync(nested) ? nested : resolved;
  if (!fs.existsSync(chunksDir)) {
    throw new Error(`--from 指的目录里没有 dist/bundle/chunks：${path.basename(resolved)}`);
  }
  const found = packageAbove(chunksDir);
  return {
    module: modelChunkIn(chunksDir),
    pkg: { name: found?.name ?? "", version: found?.version ?? "" },
  };
}

/* ------------------------------------------------------------------ *
 * 抽参数
 * ------------------------------------------------------------------ */

/** pi 的一条模型（只列用得着的几格）。 */
interface PiModel {
  id?: unknown;
  provider?: unknown;
  reasoning?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  thinkingLevelMap?: unknown;
}

/**
 * 一个 thinkingLevelMap 支持的档位。
 *
 * 判据是「这一档的值不是 null」：pi 用 null 表示这个模型没有这一档，用
 * `"none"`（或档位名本身）表示有。所以 `deepseek-v4.1-flash` 在 radius 那一条
 * 把 `off` 映射成 `"none"`，它就算支持 off —— 那不是 null，是「有，名字叫 none」。
 *
 * 一个非 null 档位都没有时返回 undefined，不返回空数组：pi 的 map 里有 54 条是全
 * null（其中 52 条要是照写就变成「这个能思考的模型没有任何档位」），那更像是这张
 * map 没填完，而不是「没有档位可选」的结论。空数组是要写给客户端看的断言，
 * 这张近似表不该替上游下这个结论。
 */
export function effortsOf(map: unknown): string[] | undefined {
  if (!map || typeof map !== "object") return undefined;
  const levels = map as Record<string, unknown>;
  const picked = LEVEL_ORDER.filter((level) => levels[level] !== null && levels[level] !== undefined);
  return picked.length ? [...picked] : undefined;
}

/** 一个 pi 条目能提供的那几格。缺的键不写（缺 = 不知道，不是 0 / false）。 */
export function traitsOf(model: PiModel): Omit<TableEntry, "providers" | "sources"> {
  const traits: Omit<TableEntry, "providers" | "sources"> = {};
  if (typeof model.reasoning === "boolean") traits.reasoning = model.reasoning;
  const contextWindow = Number(model.contextWindow);
  if (Number.isFinite(contextWindow) && contextWindow > 0) traits.contextWindow = contextWindow;
  const maxOutputTokens = Number(model.maxTokens);
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) traits.maxOutputTokens = maxOutputTokens;
  const efforts = effortsOf(model.thinkingLevelMap);
  if (efforts) traits.efforts = efforts;
  return traits;
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

export interface MergeOutcome {
  models: Record<string, TableEntry>;
  /** 归一化后同一个 id 出现在多个 provider 下、参数又不一样的那几条。 */
  conflicts: { id: string; providers: string[] }[];
}

/** 值的副本：数组另开一份，免得写出去的东西还牵着上游那份对象。 */
function cloneValue<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : value;
}

/** 键的先后：按码位比，不跟区域设置走（同一份表在两台机器上要排得一样）。 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 排序用的一份参数指纹：判「意见一样」与「不一样」。 */
function fingerprint(traits: Omit<TableEntry, "providers" | "sources">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(traits).sort(byText)) ordered[key] = traits[key];
  return JSON.stringify(ordered);
}

/**
 * pi 的条目并成一张表：按归一化后的 id 合，取档位最多的那一条。
 *
 * 为什么要取档位最多：同一个模型在不同 provider 下的窗口与档位会差一点（`radius`
 * 给 `glm-5.3-flash` 的窗口是 1048575，别的给 1000000），而档位少的那一条往往是
 * 客户端没填全。档位一样多时按 provider 名、id 排取第一个 —— 只为确定性，不为
 * 判断谁更对。差得多的那几条记进 conflicts，打给人看。
 */
export function mergePi(entries: { provider: string; model: PiModel }[]): MergeOutcome {
  const grouped = new Map<string, { provider: string; id: string; traits: Omit<TableEntry, "providers" | "sources"> }[]>();
  for (const { provider, model } of entries) {
    const raw = String(model.id ?? "").trim();
    if (!raw) continue;
    const id = normalizeModelId(raw);
    if (!id) continue;
    const list = grouped.get(id) ?? [];
    list.push({ provider, id: raw, traits: traitsOf(model) });
    grouped.set(id, list);
  }

  const models: Record<string, TableEntry> = {};
  const conflicts: { id: string; providers: string[] }[] = [];
  for (const [id, list] of grouped) {
    const ranked = [...list].sort((a, b) => {
      const byEfforts = (b.traits.efforts?.length ?? 0) - (a.traits.efforts?.length ?? 0);
      return byEfforts !== 0 ? byEfforts : byText(a.provider, b.provider) || byText(a.id, b.id);
    });
    const winner = ranked[0];
    const entry: TableEntry = { ...winner.traits };
    const providers = [...new Set(list.map((item) => item.provider))].sort(byText);
    entry.providers = providers;
    models[id] = entry;
    if (new Set(list.map((item) => fingerprint(item.traits))).size > 1) conflicts.push({ id, providers });
  }
  return { models, conflicts };
}

/** 读人工那一份。读不了就是错：把「读不到」当「还没有」会把实测值一次抹掉。 */
export function readManual(file: string): Record<string, TableEntry> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读不了人工那份（${path.basename(file)}）：${(error as { code?: unknown })?.code ?? "读不到"}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`解析不了人工那份（${path.basename(file)}）：不是 JSON`);
  }
  const models = (raw as { models?: unknown } | null)?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new Error(`解析不了人工那份（${path.basename(file)}）：没有 models`);
  }
  return models as Record<string, TableEntry>;
}

/**
 * 人工那几条盖在 pi 那份上面：人工写了的字段，pi 说什么都不动。
 *
 * 判据是「这个键在不在」而不是「是不是真值」：人工写 `reasoning: false` 是结论，
 * pi 说 true 也不该翻回去。人工没写的字段继续用 pi 的（那是这类表存在的意义）。
 */
export function mergeManual(
  base: Record<string, TableEntry>,
  manual: Record<string, TableEntry>,
): Record<string, TableEntry> {
  const models: Record<string, TableEntry> = {};
  for (const [id, entry] of Object.entries(base)) {
    const copy: TableEntry = { ...entry };
    if (entry.efforts) copy.efforts = [...entry.efforts];
    if (entry.providers) copy.providers = [...entry.providers];
    models[id] = copy;
  }
  for (const [rawId, entry] of Object.entries(manual)) {
    const id = normalizeModelId(rawId);
    if (!id) continue;
    const merged: TableEntry = { ...(models[id] ?? {}) };
    for (const [field, value] of Object.entries(entry)) {
      if (value === undefined) continue;
      merged[field] = cloneValue(value);
    }
    models[id] = merged;
  }
  return models;
}

/* ------------------------------------------------------------------ *
 * 写文件
 * ------------------------------------------------------------------ */

/** 只留写了的键，按码位排。空数组照留：那是明确的结论，不是空。 */
function sortedEntry(entry: TableEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort(byText)) {
    if (entry[key] === undefined) continue;
    out[key] = entry[key];
  }
  return out;
}

/** 渲染成文件内容：顶层固定 version / source / note / models，其余按码位排。 */
export function render(doc: {
  version: number;
  source: { package: string; version: string; generatedAt: string };
  note: string;
  models: Record<string, TableEntry>;
}): string {
  const models: Record<string, unknown> = {};
  for (const id of Object.keys(doc.models).sort(byText)) models[id] = sortedEntry(doc.models[id]);
  const out = {
    version: doc.version,
    source: { package: doc.source.package, version: doc.source.version, generatedAt: doc.source.generatedAt },
    note: doc.note,
    models,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** 今天是哪天，只到日期（同一份输入同一天重跑，diff 是空的）。 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const NOTE =
  "参考值：模型 id → 能做什么，由 helper/build-model-traits.ts 从 pi 的内建模型库生成，" +
  "人工整理的那一份在 lib/model-traits.manual.json（合并在上层，人工写了的字段不改）。" +
  "这里只放近似值，不放进价格：同名模型在不同平台的价钱不一样。合成目录时它排在最后，只补上游与代码表都没说的字段（lib/catalog-models.ts）。" +
  "id 是归一化后的写法（小写、去厂商前缀、去日期尾巴、点与下划线折成连字符）。";

/* ------------------------------------------------------------------ *
 * 跑一次
 * ------------------------------------------------------------------ */

export interface RunOptions {
  from?: string;
  out?: string;
  manual?: string;
  /** 不落盘，只打印。 */
  dryRun?: boolean;
}

export interface RunResult {
  text: string;
  total: number;
  withEfforts: number;
  withReasoning: number;
  conflicts: { id: string; providers: string[] }[];
  pkg: { name: string; version: string };
  /** 与磁盘上那份是否一样（`--dry-run` 与「没变化」的提示要用）。 */
  changed: boolean;
}

/** 抽 pi 的模型清单。导出：测试可以喂一份造出来的 chunk，不必装 pi。 */
export async function readPiModels(module: string): Promise<{ provider: string; model: PiModel }[]> {
  const loaded = (await import(pathToFileURL(module).href)) as {
    getProviders?: () => string[];
    getModels?: (...args: unknown[]) => PiModel[];
  };
  if (typeof loaded.getModels !== "function") {
    throw new Error("这个文件没导出 getModels：不是一个 pi 的模型库 chunk");
  }
  const providers = typeof loaded.getProviders === "function" ? loaded.getProviders() : [];
  const out: { provider: string; model: PiModel }[] = [];
  if (!providers.length) {
    // 老版本只导出 getModels()：那时它自己返回全部条目，provider 在条目里
    for (const model of loaded.getModels()) {
      out.push({ provider: String(model.provider ?? ""), model });
    }
    return out;
  }
  for (const provider of providers) {
    for (const model of loaded.getModels(provider)) {
      out.push({ provider: String(model.provider ?? provider), model });
    }
  }
  return out;
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const out = path.resolve(options.out ?? DEFAULT_OUT);
  const manualFile = path.resolve(options.manual ?? DEFAULT_MANUAL);
  const located = locateModelModule(options.from);
  const entries = await readPiModels(located.module);
  if (!entries.length) throw new Error("pi 的模型库里一条模型都没有：拒绝用空表覆盖");

  const { models: base, conflicts } = mergePi(entries);
  const merged = mergeManual(base, readManual(manualFile));
  const pkg = {
    package: located.pkg.name || PACKAGE_NAME,
    version: located.pkg.version || "unknown",
  };
  const text = render({ version: 2, source: { ...pkg, generatedAt: today() }, note: NOTE, models: merged });

  let current = "";
  try {
    current = fs.readFileSync(out, "utf8");
  } catch {
    /* 还没有这份文件，写出来就是新的 */
  }
  const changed = current !== text;
  if (!options.dryRun) fs.writeFileSync(out, text, "utf8");

  const ids = Object.keys(merged);
  return {
    text,
    total: ids.length,
    withEfforts: ids.filter((id) => merged[id].efforts !== undefined).length,
    withReasoning: ids.filter((id) => merged[id].reasoning !== undefined).length,
    conflicts: conflicts.sort((a, b) => byText(a.id, b.id)),
    pkg,
    changed,
  };
}

const USAGE =
  "用法：node --experimental-strip-types helper/build-model-traits.ts " +
  "[--from <pi 包目录 | chunk 文件>] [--out <路径>] [--manual <路径>] [--dry-run]";

/** 打印给人看的一句：只有相对路径与条数，没有本机绝对路径。 */
function shownPath(file: string): string {
  const rel = path.relative(ROOT, path.resolve(file));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(file);
}

async function main(argv: string[]): Promise<number> {
  let values;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        out: { type: "string" },
        manual: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values;
  } catch (error) {
    console.error(USAGE);
    console.error((error as Error).message);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await run({
      from: values.from,
      out: values.out,
      manual: values.manual,
      dryRun: values["dry-run"] === true,
    });
    console.log(
      `${result.pkg.package}@${result.pkg.version}：${result.total} 条，` +
        `带档位 ${result.withEfforts} 条，带 reasoning ${result.withReasoning} 条，` +
        `冲突 ${result.conflicts.length} 条`,
    );
    for (const conflict of result.conflicts.slice(0, 20)) {
      console.log(`  冲突 ${conflict.id}：${conflict.providers.join(", ")}`);
    }
    if (result.conflicts.length > 20) console.log(`  （还有 ${result.conflicts.length - 20} 条冲突没打）`);
    console.log(
      values["dry-run"] === true
        ? `（--dry-run，不落盘）会写进 ${shownPath(values.out ?? DEFAULT_OUT)}`
        : result.changed
          ? `写了 ${shownPath(values.out ?? DEFAULT_OUT)}`
          : `${shownPath(values.out ?? DEFAULT_OUT)} 没变`,
    );
    return 0;
  } catch (error) {
    console.error((error as Error)?.message ?? String(error));
    return 2;
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) process.exit(await main(process.argv.slice(2)));
