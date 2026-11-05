// scripts/workbuddy-catalog.ts — 从 WorkBuddy 桌面客户端的 product config 抽
// 出网关用的 cn 区模型目录（lib/workbuddy/cn-catalog.json）。
//
//   node --experimental-strip-types scripts/workbuddy-catalog.ts            # 写文件并打印差异
//   node --experimental-strip-types scripts/workbuddy-catalog.ts --check    # 只比对：有差异退出码 1
//   node --experimental-strip-types scripts/workbuddy-catalog.ts --dry-run  # 打印要写什么，不落盘
//   node --experimental-strip-types scripts/workbuddy-catalog.ts --config <path>
//
// Where the input comes from, in order: --config, WORKBUDDY_PRODUCT_CONFIG (a
// file) or WORKBUDDY_CACHE_DIR (a directory), ~/.workbuddy/cache, and the
// Windows side's %USERPROFILE% asked over WSL interop. Nothing is guessed and
// no other user's home directory is listed.
//
// Why the client config is the source: the upstream's own GET /v3/config does
// not carry the credit multipliers or the thinking levels for a cn account
// (measured, and no header makes it), so the table the gateway publishes would
// be missing both. The desktop client ships a product config that has them, and
// it is what the official picker is built from — so it is the authority here,
// and the upstream may only override a field it actually sends.
//
// The output has to be stable: the same input renders byte for byte the same
// file (fixed order, no timestamp, no "generated at"). A re-run after a client
// update is then a readable diff of the models and nothing else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_OUT = path.join(ROOT, "lib", "workbuddy", "cn-catalog.json");

/** 客户端缓存的文件名前缀。 */
const CONFIG_PREFIX = "acc-product-config-v3-";

/** 换掉用户名之后留下的那个名字。固定成这个形状，读的人才知道是被掩过的。 */
const MASKED_NAME = "<user>";

/**
 * 带用户名的路径段，从具体的排到笼统的。
 *
 * 打印的输入是客户端缓存，路径里带着本机用户名；这些行会被贴进报告或提交，
 * 用户名不该跟着出去。名字以外的部分不动——盘符、`Users`、文件名里的 uuid 都
 * 不是隐私，还正好说明「这份输入是从哪边来的」。
 *
 * 顺序有意义：`/mnt/c/Users/<名>` 里也含一段 `/Users/<名>`，先让 WSL 那条把名字
 * 换掉，后一条才不会再动手。名字的字符集排除 `<>`，所以这个函数对自己换过的结果
 * 是空操作，重复调用不会越换越短。
 */
const NAME_SEGMENTS: [RegExp, string][] = [
  // WSL 挂进来的 Windows 家目录
  [/(\/mnt\/[A-Za-z]\/[Uu]sers\/)[^/\\<>]+/g, `$1${MASKED_NAME}`],
  // Windows 自己的写法：盘符、反斜杠，正斜杠也认（Node 与 wslpath 都会这么给）
  [/([A-Za-z]:[\\/][Uu]sers[\\/])[^\\/<>]+/g, `$1${MASKED_NAME}`],
  // POSIX 的家目录：这一段本身就是「谁的家」，整个换成 ~
  [/\/(?:home|[Uu]sers)\/[^/\\<>]+/g, "~"],
];

/**
 * 一段文本里所有带用户名的路径都盖住。整串任意位置替换，不是只认行首：这个
 * 函数的输入常常是 Node 自己拼的错误消息（`ENOENT: ..., open '<路径>'`），
 * 路径前面还有半句英文。
 */
export function maskPath(p: string): string {
  let out = maskHome(p, os.homedir());
  for (const [shape, to] of NAME_SEGMENTS) out = out.replace(shape, to);
  return out;
}

/**
 * 本机家目录那一段换成 `~`。上面那三条认形状，这一条认事实：家目录不一定长成
 * `/home/<名>`（容器里是 `/root`，有的发行版是 `/var/home/<名>`）。
 */
function maskHome(p: string, home: string): string {
  const trimmed = String(home ?? "").replace(/[\\/]+$/, "");
  if (!trimmed) return p;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 后面必须紧跟分隔符或到头：否则前缀是 `a` 时，`a1` 这种更长的目录名也会被
  // 当成自己，把不该掩的部分一起吃掉
  return p.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, "g"), "~");
}

/** 一份目录里的一个模型。字段顺序就是写进 JSON 的顺序。 */
export interface CatalogEntry {
  id: string;
  name: string;
  credits: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  onlyReasoning: boolean;
  efforts: string[];
  defaultEffort: string;
  canDisableThinking: boolean | null;
}

/** 被过滤掉的一个模型，以及为什么。 */
export interface Dropped {
  id: string;
  reason: string;
}

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

/**
 * 探路用的外部事实。全是参数，所以测试不必依赖这台机器有没有 WSL interop。
 */
export interface Probe {
  env: NodeJS.ProcessEnv;
  /** `os.homedir()` */
  home: string;
  /** 问 Windows 侧要 `%USERPROFILE%`；没有 interop 就是 null */
  windowsProfile(): string | null;
  /** Windows 路径 → Linux 路径；`wslpath` 不在就是 null */
  toLinuxPath(win: string): string | null;
}

/** `cmd.exe` 在哪：先按 PATH，再按 WSL 的默认挂载点。两处都没有就是没有 interop。 */
const CMD_CANDIDATES = ["cmd.exe", "/mnt/c/Windows/System32/cmd.exe"];

/** 本机的那份：env 与家目录照实取，Windows 侧靠 interop 问。 */
export function defaultProbe(): Probe {
  return {
    env: process.env,
    home: os.homedir(),
    // 不枚举 /mnt/c/Users/*：那要读别人的家目录，也把「用户名」写进了代码
    windowsProfile: () => {
      for (const exe of CMD_CANDIDATES) {
        try {
          const out = execFileSync(exe, ["/c", "echo", "%USERPROFILE%"], {
            encoding: "latin1",
            stdio: ["ignore", "pipe", "ignore"],
          });
          // 从 UNC 目录启动 cmd.exe 会先喷一行警告，所以取最后一行盘符路径
          const profile = out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^[A-Za-z]:\\/.test(line))
            .pop();
          if (profile) return profile;
        } catch {
          // 换下一个
        }
      }
      return null;
    },
    toLinuxPath: (win) => {
      try {
        const out = execFileSync("wslpath", ["-u", win], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out.trim() || null;
      } catch {
        return null;
      }
    },
  };
}

/** Windows 家目录 → WSL 的 /mnt/<盘符> 形状；不是这个形状就是 null。`wslpath` 的退路。 */
export function windowsToLinux(win: string): string | null {
  const matched = /^([A-Za-z]):[\\/](.*)$/.exec(win.trim());
  if (!matched) return null;
  return `/mnt/${matched[1].toLowerCase()}/${matched[2].replace(/\\/g, "/")}`;
}

/** Windows 侧的缓存目录。问不出 `%USERPROFILE%` 就是 null。 */
export function windowsCacheDir(probe: Probe): string | null {
  const profile = probe.windowsProfile();
  if (!profile) return null;
  const linux = probe.toLinuxPath(profile) ?? windowsToLinux(profile);
  return linux ? path.join(linux, ".workbuddy", "cache") : null;
}

/** 客户端的缓存文件名。别的 json 不是输入。 */
export function isConfigName(name: string): boolean {
  return name.startsWith(CONFIG_PREFIX) && name.endsWith(".json");
}

/** 一份目录里的候选文件。目录不在、不可读就是空的。 */
export function filesIn(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(isConfigName).map((name) => path.join(dir, name));
}

/** 一份候选里最新的那个：客户端每次刷新各存一份，历史都在，现在认的是新的那份。 */
export function newestOf(files: string[]): string | null {
  let newest = -1;
  let chosen: string | null = null;
  for (const file of files) {
    let at: number;
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (at > newest) {
      newest = at;
      chosen = file;
    }
  }
  return chosen;
}

/**
 * 输入文件，按优先级：命令行 → 环境变量 → 家目录 → 问出来的 Windows 家目录。
 *
 * 每一级都是自己的事，拿不到就降到下一级；哪一级都不碰别人的目录，所以
 * 不同机器的默认位置不一样也能自己找到。
 */
export function locateInput(explicit: string | undefined, probe: Probe = defaultProbe()): string | null {
  if (explicit) return explicit;
  const named = probe.env.WORKBUDDY_PRODUCT_CONFIG;
  if (named) return named;
  const envDir = probe.env.WORKBUDDY_CACHE_DIR;
  if (envDir) {
    const file = newestOf(filesIn(envDir));
    if (file) return file;
  }
  const homeFile = newestOf(filesIn(path.join(probe.home, ".workbuddy", "cache")));
  if (homeFile) return homeFile;
  const winDir = windowsCacheDir(probe);
  return winDir ? newestOf(filesIn(winDir)) : null;
}

export interface Source {
  file: string;
  genieVersion: string;
  config: any;
}

/** 要用的那份配置。没找到返回 null，读不了抛（消息里的路径已经脱敏）。 */
export function resolveSource(explicit: string | undefined, probe: Probe = defaultProbe()): Source | null {
  const chosen = locateInput(explicit, probe);
  if (!chosen) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(chosen, "utf8");
  } catch (error) {
    throw new Error(`读不了 ${maskPath(chosen)}：${errorText(error)}`);
  }
  let config: any;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    // 这里不能拼 error.message：V8 会往 JSON 的错误里贴一段文件内容
    throw new Error(`解析不了 ${maskPath(chosen)}：${parseFailure(error)}`);
  }
  return { file: chosen, genieVersion: String(config?.genieVersion ?? ""), config };
}

/** 一个错误的一句话。`message` 拿不到就退回它的字符串形态。 */
function errorText(error: unknown): string {
  const message = (error as Error)?.message;
  return typeof message === "string" && message ? message : String(error);
}

/**
 * 解析失败的说明：错误类型 + 位置。
 *
 * 不用 `error.message` 原文：V8 在 JSON 的语法错误里贴一段文件内容
 * （`Unexpected token 'x', ..."owner":"…"...`），而输入是客户端配置，贴进日志
 * 就等于把配置里的字段和值一起带出去。位置是纯数字，留着还能定位。
 */
export function parseFailure(error: unknown): string {
  const name = (error as Error)?.name;
  const kind = typeof name === "string" && name ? name : "Error";
  const place = /at (position \d+)(?: \(line (\d+) column (\d+)\))?/.exec(String((error as Error)?.message ?? ""));
  if (!place) return kind;
  return place[2] ? `${kind}（line ${place[2]} column ${place[3]}）` : `${kind}（${place[1]}）`;
}

/* ------------------------------------------------------------------ *
 * 抽取
 * ------------------------------------------------------------------ */

/** `"x0.69"` / `"x0.69 credits"` → 0.69；空串 → null（没有倍率，不是免费）。 */
export function creditValue(raw: unknown): number | null {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^x/, "")
    .replace(/\s*credits\s*$/, "")
    .trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 档位、默认档、能不能关思考。三种 `reasoning` 形状都在这里归。 */
export function effortsOf(reasoning: any): {
  efforts: string[];
  defaultEffort: string;
  canDisableThinking: boolean | null;
} {
  const canDisable = typeof reasoning?.canDisableThinking === "boolean" ? reasoning.canDisableThinking : null;
  const listed = reasoning?.supportedEfforts;
  if (Array.isArray(listed) && listed.length) {
    const efforts = listed.map(String);
    const chosen = reasoning?.defaultEffort ?? reasoning?.effort;
    return {
      efforts,
      defaultEffort: typeof chosen === "string" ? chosen : "",
      canDisableThinking: canDisable,
    };
  }
  // 只给 `effort` 的模型不是一个可选档，而是固定在这一档：客户端的档位选择器
  // 靠 `supportedEfforts?.length` 决定渲不渲染，写成一档的数组会渲出一个只有
  // 一项的下拉。所以这里落成「没有可选项」+「默认这一档」。
  const fixed = reasoning?.effort;
  return {
    efforts: [],
    defaultEffort: typeof fixed === "string" ? fixed : "",
    canDisableThinking: canDisable,
  };
}

/** 客户端自己的选择器里出现过的模型：只有它家的客户端会发给上游的那批。 */
export function pickerIds(config: any): Set<string> {
  const ids = new Set<string>();
  const agents = Array.isArray(config?.agents) ? config.agents : [];
  for (const agent of agents) {
    if (!Array.isArray(agent?.models)) continue;
    for (const id of agent.models) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** 这个模型不是 chat 模型的理由；空串表示收下。 */
export function rejectReason(entry: any, picker: Set<string>): string {
  const id = String(entry?.id ?? "");
  if (!id) return "no id";
  // 视频模型自己带一份 `videoGeneration`（分辨率、时长、声轨）。
  if (entry?.videoGeneration) return "video";
  if (id.startsWith("codewise-") || id.startsWith("completion-") || id.endsWith("-taco-completion")) {
    return "completion";
  }
  if (id.includes("image")) return "image";
  // `default` / `default-1.2` 是别名，不是模型。
  if (/^default(-[\d.]+)?$/.test(id)) return "alias";
  // 没有上下文窗口的都不是对话模型：小助手、内嵌模型、纯音频图像那些。
  if (!entry?.maxInputTokens && !entry?.maxAllowedSize) return "no chat window";
  // 多云变体（火山 / 腾讯 / 百炼 …）与自建变体只在对应的部署里存在，客户端自己
  // 的选择器也不列它们；发布出去就是让 agent 点名一个上游没有的模型。
  if (/-volc$|-lkeap$|-taiji$/.test(id)) return "multi-cloud variant";
  const labels = Array.isArray(entry?.labels) ? entry.labels.map(String) : [];
  if (labels.includes("enterprise:selfhost") && !picker.has(id)) return "selfhost variant";
  return "";
}

/** 一份配置 → 目录 + 被过滤的名单。 */
export function buildCatalog(config: any): { models: CatalogEntry[]; dropped: Dropped[] } {
  const rows = Array.isArray(config?.models)
    ? config.models
    : Array.isArray(config?.data?.models)
      ? config.data.models
      : [];
  const picker = pickerIds(config);
  const models: CatalogEntry[] = [];
  const dropped: Dropped[] = [];
  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    const why = rejectReason(row, picker);
    if (why) {
      dropped.push({ id, reason: why });
      continue;
    }
    const reasoning = effortsOf(row.reasoning);
    models.push({
      id,
      name: String(row.name ?? id),
      credits: creditValue(row.credits),
      contextWindow: Number(row.maxInputTokens ?? row.maxAllowedSize ?? 0),
      maxOutputTokens: Number(row.maxOutputTokens ?? 0),
      vision: row.supportsImages === true,
      tools: row.supportsToolCall === true,
      reasoning: row.supportsReasoning === true,
      onlyReasoning: row.onlyReasoning === true,
      efforts: reasoning.efforts,
      defaultEffort: reasoning.defaultEffort,
      canDisableThinking: reasoning.canDisableThinking,
    });
  }
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  dropped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { models, dropped };
}

/** 写进文件的那份文档。`source` 里只有输入自带的版本号，没有任何生成时间。 */
export function render(models: CatalogEntry[], genieVersion: string): string {
  const doc = {
    source: genieVersion
      ? `WorkBuddy desktop client product config (genie ${genieVersion})`
      : "WorkBuddy desktop client product config",
    note:
      "cn 区的权威目录：cn 账号的上游 /v3/config 不带倍率与档位（已实测，换请求头无效），" +
      "所以这份以客户端 product config 为准，上游只在真有某个字段时才覆盖。" +
      "由 scripts/workbuddy-catalog.ts 生成，不要手改。",
    models,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * 差异
 * ------------------------------------------------------------------ */

const FIELDS: (keyof CatalogEntry)[] = [
  "name",
  "credits",
  "contextWindow",
  "maxOutputTokens",
  "vision",
  "tools",
  "reasoning",
  "onlyReasoning",
  "efforts",
  "defaultEffort",
  "canDisableThinking",
];

/** 一个值写成人看的样子：数组 `[high,xhigh]`，缺值 `null`。 */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** 旧目录 → 新目录，按模型列变化。 */
export function diffCatalog(previous: CatalogEntry[], next: CatalogEntry[]): string[] {
  const before = new Map(previous.map((entry) => [entry.id, entry]));
  const after = new Map(next.map((entry) => [entry.id, entry]));
  const lines: string[] = [];
  for (const entry of next) {
    const old = before.get(entry.id);
    if (!old) {
      lines.push(`新增 ${entry.id}`);
      continue;
    }
    for (const field of FIELDS) {
      if (textOf(old[field]) === textOf(entry[field])) continue;
      lines.push(`${entry.id} ${field}: ${textOf(old[field])} → ${textOf(entry[field])}`);
    }
  }
  for (const entry of previous) {
    if (!after.has(entry.id)) lines.push(`消失 ${entry.id}`);
  }
  return lines;
}

/** 文件里已经有那份目录，读出来（坏文件、缺文件都当没有）。 */
function readOut(file: string): { models: CatalogEntry[]; source: string } {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      models: Array.isArray(doc?.models) ? (doc.models as CatalogEntry[]) : [],
      source: typeof doc?.source === "string" ? doc.source : "",
    };
  } catch {
    return { models: [], source: "" };
  }
}

/* ------------------------------------------------------------------ *
 * 命令行
 * ------------------------------------------------------------------ */

export interface RunOptions {
  config?: string;
  check?: boolean;
  dryRun?: boolean;
  out?: string;
  /** 探路用的事实；测试传假的，命令行不传 */
  probe?: Probe;
}

/** 没有输入时的那一句：只说怎么给，不猜路径。 */
export const NO_INPUT_HINT =
  "没找到 WorkBuddy 客户端缓存：用 --config <path> 指定，或设 WORKBUDDY_PRODUCT_CONFIG / WORKBUDDY_CACHE_DIR";

/** 跑一次。返回退出码：0 一致/已写，1 有差异（--check）或没有输入。 */
export function run(options: RunOptions = {}): number {
  const source = resolveSource(options.config, options.probe);
  if (!source) {
    console.error(NO_INPUT_HINT);
    return 1;
  }
  const out = options.out ?? DEFAULT_OUT;
  const { models, dropped } = buildCatalog(source.config);
  const text = render(models, source.genieVersion);

  const at = new Date(fs.statSync(source.file).mtimeMs).toISOString();
  const show = (p: string) => maskPath(p);
  console.log(`输入：${show(source.file)}`);
  console.log(`      genie ${source.genieVersion || "?"}，mtime ${at}`);
  console.log(`收下 ${models.length} 个模型，过滤 ${dropped.length} 个`);
  for (const entry of dropped) console.log(`  过滤 ${entry.id}（${entry.reason}）`);

  const previous = readOut(out);
  const lines = diffCatalog(previous.models, models);
  if (previous.source !== "" || previous.models.length > 0) {
    if (text === readText(out)) {
      console.log("目录没变");
      return 0;
    }
    console.log(lines.length ? lines.join("\n") : `只有文件头变了（source / note）`);
  } else {
    console.log("还没有目录，这次会新建一份");
    console.log(lines.join("\n"));
  }

  if (options.check) {
    console.log(`有差异：${show(out)} 需要重新生成（node --experimental-strip-types scripts/workbuddy-catalog.ts）`);
    return 1;
  }
  if (options.dryRun) {
    console.log("");
    console.log("（--dry-run，不落盘）要写进 " + show(out) + " 的内容：");
    console.log(text);
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, "utf8");
  console.log(`写了 ${show(out)}`);
  return 0;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        check: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        out: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    console.error(`用法：node --experimental-strip-types scripts/workbuddy-catalog.ts [--check] [--dry-run] [--config <path>] [--out <path>]`);
    console.error((error as Error).message);
    return 2;
  }
  const { values } = parsed;
  try {
    return run({
      config: values.config,
      check: values.check === true,
      dryRun: values["dry-run"] === true,
      out: values.out,
    });
  } catch (error) {
    // 唯一的错误出口：整句过一遍 maskPath。fs.* 冒泡上来的消息里带着未脱敏的
    // 绝对路径（Node 自己还会再拼一遍），逐处包一层迟早漏一处，所以收在这里
    console.error(maskPath(errorText(error)));
    return 2;
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
