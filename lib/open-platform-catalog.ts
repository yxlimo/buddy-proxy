// lib/open-platform-catalog.ts — 开放平台的模型目录：问上游拉一份。
//
// 目录是**平台**的，不是账号的：同一个平台下两个账号服务同一批模型。所以拉
// 目录用名下第一个有 key 的账号就够 —— 目录跟是谁付钱无关。
//
// 拉不到不算失败：原来那份目录留着（人写死的那份比自动拉的更值钱），记一
// 行日志。这个函数跑在后台（启动时、目录刷新时），不在请求路径上。
//
// 拉不到还要退避：上游不支持 /models 时目录永远拉不到，而不写 fetchedAt 目录就
// 一直算过期 —— 于是每个 /v1/models 请求都会再问一次上游，一条与客户端轮询
// 频率成正比的外部请求流。
//
// 它不碰额度：额度是那个额度插件的事，还没接。

import { randomUUID } from "node:crypto";
import {
  mergeModelTraits,
  openPlatformOf,
  syncPlatformModels,
  traitNumber,
  type ModelTraits,
  type OpenPlatformRow,
} from "./open-platforms.ts";
// 归因头跟推理那条路用同一个名字：两个地方各写一遍，改一处就会走样。
import { REQUEST_ID_HEADER } from "./router/upstreams/open-platform.ts";
// 平台属于哪一族：方言族（目录从上游拉）与模拟客户端（目录由代码给出）。
// 判据只在一个地方定义（lib/platform-catalog.ts）。
import { platformCategoryOfKind } from "./platform-catalog.ts";
import { kindOf } from "./provider-kinds.ts";
import { accountsOfPlatform } from "./providers.ts";
// 引用即登记：问目录要拿各家的推理 key，而登记发生在各平台模块的求值期。环上
// 的模块不能在这里读别人的常量 —— 这里读的都是函数，调用时才取值（与
// lib/admin/accounts.ts 那条 import 同一个理由）。
import "./kinds/index.ts";

/** 拉目录最多等多久（毫秒）：上游慢的时候不占着后台。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 目录多久算过期（毫秒）：过期了才值得再问上游一次。 */
export const OPEN_PLATFORM_CATALOG_TTL_MS = 30 * 60_000;

/**
 * 拉不到之后多久不再问（毫秒）。
 *
 * 上游不支持 /models 时目录永远拉不到，而拉不到不写 fetchedAt，目录就一直算
 * 过期：每个 /v1/models 请求都会再问一次上游。退避把那条流掐掉。
 *
 * 记在内存里而不是落库：重启后重拉一次无害（上游本来就不支持，再问一次还是
 * 不支持），而把失败的时刻写进目录会污染「目录是什么时候拉的」这个语义 ——
 * fetchedAt 说的必须是目录到手的时刻，不是问过上游的时刻。
 */
const FAILURE_BACKOFF_MS = 5 * 60_000;

/** 一次拉目录的结果。 */
export interface CatalogOutcome {
  ok: boolean;
  message: string;
}

/**
 * 正在拉的那一轮：同一个平台同时只允许一轮在飞。
 *
 * 后来的调用跟着同一轮走（拿到同一个 promise），不是各自去问一次上游。
 */
const inFlight = new Map<string, Promise<CatalogOutcome>>();

/**
 * 每个平台的目录状态：内存里的，退避要用。
 *
 * 记的是**序号**而不是时刻：时刻只有毫秒精度，成功与失败落在同一毫秒时用时
 * 刻比较分不出先后（原来拿目录的 fetchedAt 当判据就有这个洞：fetchedAt 是写
 * 回目录的时刻，比那次尝试开始的时刻晚，`last > fetchedAt` 为假，退避就失效
 * 了，多打一次上游）。序号是单调递增的，同一毫秒里的两次尝试也有先后。
 *
 * 退避的判据是「上次成功之后有没有失败过」：lastAttempt > lastSuccess 就是
 * 失败过（没成功过就是 0，成功过之后又失败了就更大）。
 */
interface PlatformCatalogState {
  /** 最近一次尝试的序号（成功失败都记）。 */
  lastAttempt: number;
  /** 最近一次成功的序号。 */
  lastSuccess: number;
  /** 最近一次尝试的时刻（毫秒）：退避窗口按它算。 */
  at: number;
}

/** 每一次尝试一个序号：整个进程一个计数器就够了。 */
let attemptSeq = 0;

/** 每个平台的目录状态。 */
const catalogState = new Map<string, PlatformCatalogState>();

/** 这个平台的目录现在要不要重拉。 */
export function openPlatformCatalogStale(row: OpenPlatformRow, now = Date.now()): boolean {
  return now - row.models.fetchedAt >= OPEN_PLATFORM_CATALOG_TTL_MS;
}

/**
 * 这个平台的目录要不要去拉。
 *
 * 判据是平台的族：方言族的目录归上游，模拟客户端那一族的目录由代码给出（拉了也
 * 没人用）。行上不再有「要不要自动拉」那一格 —— 目录归谁不是行说了算的。
 */
export function openPlatformCatalogRefreshable(row: OpenPlatformRow): boolean {
  return platformCategoryOfKind(row.kind) === "dialect";
}

/**
 * 平台上第一个能推理的账号的那把明文 key。
 *
 * 走注册表的 `keyOf`，不按「key 存在 `key:provider:<id>:key`」找：那只是通用
 * 开放平台存 key 的位置，七牛云、讯飞星火、SenseNova、书生·端砚、TokenRhythm
 * 各有各的凭据块（七牛还分「推理 key」与「门户 cookie」两段）。按 kind 问，
 * 这几家与以后新添的方言类都走同一条路。
 *
 * 判据是 `inferWith === "api_key"`：配了门户 cookie 的七牛云账号一个推理请求
 * 也发不出去，拿 cookie 去问模型清单只会被上游拒（还像是去扫接口）。
 *
 * 没有就空字符串：没有 key 就没法问上游（有些平台的 /models 要鉴权），那时
 * 不该发请求 —— 白跑一趟，还像是去扫接口。
 */
function accountKeyOf(platform: string): string {
  for (const account of accountsOfPlatform(platform)) {
    const kind = kindOf(account.kind);
    if (!kind || kind.inferWith !== "api_key") continue;
    const key = String(kind.keyOf?.(account, account.id) ?? "").trim();
    if (key) return key;
  }
  return "";
}

/**
 * 这个平台有没有能用的 API key。
 *
 * 没有是正常状态（平台刚建、还没填 key），不是故障：这样的平台不该去问上游，
 * 也不该为它写一行告警。
 */
export function openPlatformHasKey(platform: string): boolean {
  return accountKeyOf(platform) !== "";
}

/**
 * 上游报的一个模型：名字 + 它自己说的参数。
 *
 * traits 里只出现取到了的那几格 —— 没取到与「0」「false」「空档位」不是一回事，
 * 所以不能写成 `?? 0` / `?? false`。
 */
export interface ParsedModel {
  id: string;
  traits: ModelTraits;
}

/**
 * 参数 → 上游可能用的键路径，按优先级排；第一个取到的胜出。
 *
 * 各家上游同一件事用不同的名字报（`context_length` / `limit.context` /
 * `input_modalities[].supported_inputs.max_context_length.value`……）。这里不按平台
 * 写分支：新家多报一个名字，本来也只需要往列表里加一条路径。
 *
 * 路径里 `a[].b` 是「数组任一条取到就算」：平台把上下文长度塞在模态列表里，
 * 我们只关心那几个位置里第一个说得出的值。
 *
 * 倍率（credits）**不在这张表里**：上游把三种不同单位的东西都叫「价格」—
 * 倍率（`pricing: "8.00000000"`）、每百万 token 的钱、积分 — 差三个数量级，
 * 塞进同一格就是猜。宁可没有。
 */
export const TRAIT_PATHS = {
  contextWindow: [
    "context_length",
    "max_context_length",
    "limit.context",
    "input_modalities[].supported_inputs.max_context_length.value",
    "context_window",
    "max_input_tokens",
  ],
  maxOutputTokens: [
    "max_output_tokens",
    "max_output_length",
    "max_completion_tokens",
    "max_tokens",
    "limit.output",
  ],
  reasoning: ["supports_reasoning", "capabilities.reasoning.supported"],
  toolCall: ["supports_tools", "capabilities.tools.supported"],
  efforts: ["capabilities.reasoning.effort", "supported_efforts", "supportedEfforts"],
  defaultEffort: ["default_effort", "reasoning.effort"],
} as const satisfies TraitPathTable;

/**
 * 一张路径表：写了的那几格才从上游取。
 *
 * 没写的格（现在只有 credits）意思跟空数组一样：这一格不从上游取。写成可选
 * 而不是要求每格都有，是因为「不取」是一张表里的一等状态 —— 不是忘了写，是
 * 故意不取，不该靠一个空数组去猜。
 */
export type TraitPathTable = { readonly [K in keyof ModelTraits]?: readonly string[] };

/** JSON 里可能出现的东西：路径逐段走的就是它。 */
type JsonNode = string | number | boolean | null | JsonNode[] | { [key: string]: JsonNode };

/**
 * 沿一条路径取值。
 *
 * `a[].b` 里的 `[]` 表示「数组里任一条」：展开成多条候选，后面的段逐条走。
 * 走到空、null、类型不对就是没取到 —— 不拿一个占位值顶上去。
 */
function valueAtPath(root: unknown, path: string): JsonNode | undefined {
  let current: JsonNode[] = [root as JsonNode];
  for (const segment of path.split(".")) {
    const wildcard = segment.endsWith("[]");
    const key = wildcard ? segment.slice(0, -2) : segment;
    const next: JsonNode[] = [];
    for (const node of current) {
      if (node === null || typeof node !== "object") continue;
      const value = (node as { [key: string]: JsonNode })[key];
      if (wildcard) {
        if (Array.isArray(value) && value.length) next.push(...value);
      } else if (value !== undefined && value !== null) {
        next.push(value);
      }
    }
    if (!next.length) return undefined;
    current = next;
  }
  return current[0];
}

/** 数：0 照收（上游明确说的），非数、负数、null 算没有。 */
function firstNumber(root: unknown, paths: readonly string[] | undefined): number | undefined {
  for (const path of paths ?? []) {
    const value = traitNumber(valueAtPath(root, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 布尔：false 照收，非布尔算没有。 */
function firstBoolean(root: unknown, paths: readonly string[] | undefined): boolean | undefined {
  for (const path of paths ?? []) {
    const value = valueAtPath(root, path);
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/** 字符串：空的算没有。 */
function firstString(root: unknown, paths: readonly string[] | undefined): string | undefined {
  for (const path of paths ?? []) {
    const value = valueAtPath(root, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 字符串列表：空数组照收（上游明确说没有档位），去掉空的与重号的。 */
function firstStringList(root: unknown, paths: readonly string[] | undefined): string[] | undefined {
  for (const path of paths ?? []) {
    const value = valueAtPath(root, path);
    if (!Array.isArray(value)) continue;
    const out: string[] = [];
    for (const raw of value) {
      const name = String(raw ?? "").trim();
      if (!name || out.includes(name)) continue;
      out.push(name);
    }
    return out;
  }
  return undefined;
}

/**
 * 一条模型清单条目里的参数。
 *
 * 路径表可以换进来（测试用：拿掉一条路，对应那一格就该是空的）—— 取的是表，
 * 不是另写的分支。
 */
export function traitsFromEntry(entry: unknown, paths: TraitPathTable = TRAIT_PATHS): ModelTraits {
  const traits: ModelTraits = {};
  const contextWindow = firstNumber(entry, paths.contextWindow);
  if (contextWindow !== undefined) traits.contextWindow = contextWindow;
  const maxOutputTokens = firstNumber(entry, paths.maxOutputTokens);
  if (maxOutputTokens !== undefined) traits.maxOutputTokens = maxOutputTokens;
  const reasoning = firstBoolean(entry, paths.reasoning);
  if (reasoning !== undefined) traits.reasoning = reasoning;
  const toolCall = firstBoolean(entry, paths.toolCall);
  if (toolCall !== undefined) traits.toolCall = toolCall;
  const efforts = firstStringList(entry, paths.efforts);
  if (efforts !== undefined) traits.efforts = efforts;
  const defaultEffort = firstString(entry, paths.defaultEffort);
  if (defaultEffort !== undefined) traits.defaultEffort = defaultEffort;
  return traits;
}

/**
 * 上游的模型清单：两种形状都认。
 *
 *   { data: [{ id, …}] }     OpenAI 的形状
 *   { models: [{ name, …}] } 另一种常见写法
 *
 * 名字以外的东西也一起取（见 TRAIT_PATHS）：参数就在同一份答复里，丢掉它就得
 * 再问一次上游，而很多家根本没有第二个问得清参数的端点。
 *
 * 都不认就是 null：宁可没有目录，也不要一份猜的。
 */
export function parseModelList(payload: unknown): ParsedModel[] | null {
  const body = payload as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : null;
  if (!list) return null;
  const out: ParsedModel[] = [];
  for (const entry of list) {
    const item = entry as { id?: unknown; name?: unknown } | null;
    const raw = typeof entry === "string" ? entry : String(item?.id ?? item?.name ?? "");
    const id = raw.trim();
    if (!id || out.some((model) => model.id === id)) continue;
    out.push({ id, traits: traitsFromEntry(entry) });
  }
  return out;
}

/**
 * 问上游要模型目录。
 *
 * 拉不到就是 null（网络、非 2xx、认不出来的形状都是）：调用方保留原来那份
 * 目录。空清单也当拉不到 —— 用一份空目录盖掉能用的那份，客户端就一个模型都
 * 看不见了。
 *
 * key 可以从外面带进来：查 key 要读 provider 表与凭据，读两遍是白读。
 */
export async function fetchOpenPlatformModels(
  row: OpenPlatformRow,
  key?: string,
): Promise<ParsedModel[] | null> {
  const base = String(row.baseUrl ?? "").trim();
  if (!base) return null;
  const apiKey = key ?? accountKeyOf(row.id);
  // 没有 key 是正常状态，不是故障：不问，也不吵。
  if (!apiKey) return null;
  let url: URL;
  try {
    // new URL 会替我们把结尾的斜杠拼对：手写 `base + "/models"` 在 base 以斜杠
    // 结尾时拼出 `//models`，有些上游对那个路径答 404。
    url = new URL(`${base.replace(/\/+$/, "")}/models`);
  } catch {
    return null;
  }
  let payload: unknown;
  // 这一次拉目录的 id：它没有账号上下文（目录是平台的），所以只带 request id。
  // 上游对 /models 回 4xx/5xx 时，日志里那一行与这次请求能对上号。
  const requestId = randomUUID();
  try {
    // 鉴权头跟着方言走：Anthropic 那一族只认 x-api-key 加版本头，发 Bearer
    // 回的是 401 —— 看着像 key 不对，其实是头不对。
    const auth = kindOf(row.kind)?.catalogAuth?.(apiKey) ?? { Authorization: `Bearer ${apiKey}` };
    const res = await fetch(url, {
      headers: { accept: "application/json", ...auth, [REQUEST_ID_HEADER]: requestId },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[OPEN-PLATFORM] ${row.id} 的模型目录拉不到：HTTP ${res.status} (request=${requestId})`);
      return null;
    }
    payload = await res.json();
  } catch (e) {
    console.warn(
      `[OPEN-PLATFORM] ${row.id} 的模型目录拉不到：${(e as Error)?.message ?? e} (request=${requestId})`,
    );
    return null;
  }
  const models = parseModelList(payload);
  if (!models) {
    console.warn(`[OPEN-PLATFORM] ${row.id} 的模型目录认不出来：上游答的不是模型清单`);
    return null;
  }
  if (!models.length) {
    console.warn(`[OPEN-PLATFORM] ${row.id} 的模型目录是空的，保留原来那份`);
    return null;
  }
  return models;
}

/** 拉一次目录的选项。 */
export interface RefreshCatalogOptions {
  /**
   * 人手动点的那一次：跳过失败退避，直接去问上游。
   *
   * 退避是给「没人看着的调用」用的 —— 定时器、启动、`/v1/models` 上顺手拉，
   * 那些调用失败了再来一次只会把失败变成一条稳定的外部请求流。人点「刷新模型
   * 目录」是明确的意思：他要的是现在就去问一次，退避说的「刚问过」在这个语境
   * 里不是答案。
   *
   * 它只跳退避：目录归谁管（平台的族）不由它决定。
   *
   * 去重仍然生效：同一时刻只拉一轮，后来的跟着这一轮走 —— 点两下不该发两份。
   */
  force?: boolean;
}

/**
 * 拉一次这个平台的目录，写回表里。
 *
 * 人写死的目录（models.auto 为 false）不动：那是明确的意思，不是默认值。
 * 什么时候该拉由调用方判（目录多久算过期），这个函数拉一次就拉一次。
 *
 * 同一个平台同时只拉一轮（后来的跟着这一轮走），拉不到之后有退避
 * （见 FAILURE_BACKOFF_MS）。
 *
 * 它不 reject：库开不了、SQLITE_BUSY 这些都归一成 { ok: false }。它跑在后台，
 * reject 出去就是一次没人接的 promise —— Node 把未处理的 rejection 当致命错误，
 * 网关就退了。调用点仍然各带一个 .catch：那是第二道防线，不是冗余。
 */
export function refreshOpenPlatformCatalog(
  id: string,
  options?: RefreshCatalogOptions,
): Promise<CatalogOutcome> {
  const running = inFlight.get(id);
  if (running) return running;
  const promise = runRefresh(id, options?.force === true).finally(() => {
    inFlight.delete(id);
  });
  inFlight.set(id, promise);
  return promise;
}

/** 真去拉的那一轮。抛出来的东西都在这里归一成 { ok: false }。 */
async function runRefresh(id: string, force: boolean): Promise<CatalogOutcome> {
  try {
    const row = openPlatformOf(id);
    if (!row) return { ok: false, message: `没有这个平台：${id}` };
    // 模拟客户端那一族：目录是各 kind 自己的代码目录，不从上游拉。与退避一样
    // 只看 row 与内存里的状态，不读库 —— 放在查 key 前面，请求路径上就不用为了
    // 判别去读 provider 表与凭据。
    if (platformCategoryOfKind(row.kind) !== "dialect") {
      return { ok: false, message: "这个平台不需要从上游获取目录" };
    }
    // 退避：上次成功之后失败过就先不再问。退避期内不告警 —— 同一个失败反复
    // 告警就是刷屏（请求路径上每个 /v1/models 都会走到这里）。
    //
    // force 跳过它：手动点的那一次是明确的意思，见 RefreshCatalogOptions。
    const before = catalogState.get(id);
    if (
      !force &&
      before &&
      before.lastAttempt > before.lastSuccess &&
      Date.now() - before.at < FAILURE_BACKOFF_MS
    ) {
      return { ok: false, message: "刚刚查询过上游，暂不重复查询" };
    }
    // 没有 key 是正常状态（平台刚建、还没填 key）：不问上游，也不吵。
    const key = accountKeyOf(id);
    if (!key) {
      return { ok: false, message: "还没有可用的 API key，不向上游获取目录" };
    }
    // 这一次尝试先记上：序号分出先后，时刻留给退避窗口。
    const seq = ++attemptSeq;
    const at = Date.now();
    const state: PlatformCatalogState = {
      lastAttempt: seq,
      lastSuccess: before?.lastSuccess ?? 0,
      at,
    };
    catalogState.set(id, state);
    const models = await fetchOpenPlatformModels(row, key);
    if (!models) return { ok: false, message: "无法获取模型目录，保留原有的一份" };
    const ids = models.map((model) => model.id);
    // 只收这次真报了的参数：「不知道」不占一格，没报的那几个模型由
    // mergeModelTraits 留着行里原来那份。
    const reported: Record<string, ModelTraits> = {};
    for (const model of models) {
      if (Object.keys(model.traits).length) reported[model.id] = model.traits;
    }
    try {
      // 写回那一行：这次报了的参数用这次的，没报的按 id 留着行里原来那份。
      syncPlatformModels(id, ids, mergeModelTraits(row.models.traits, ids, reported));
    } catch (e) {
      // 写不回去是配置或库的问题，不是一般的「拉不到」：把原因写进日志，事后
      // 才查得到「目录为什么没更新」。
      const detail = (e as Error)?.message ?? String(e);
      console.warn(`[OPEN-PLATFORM] ${id} 的模型目录没写回：${detail}`);
      return { ok: false, message: `模型目录没写回：${detail}` };
    }
    // 成功：这一次的序号就是「上次成功」。
    catalogState.set(id, { ...state, lastSuccess: seq });
    return { ok: true, message: `已获取 ${models.length} 个模型` };
  } catch (e) {
    // 库开不了、SQLITE_BUSY：这一轮拉不成，但不该把整个网关带走。
    const message = (e as Error)?.message ?? String(e);
    console.warn(`[OPEN-PLATFORM] ${id} 的模型目录没拉到：${message}`);
    return { ok: false, message: `无法获取模型目录：${message}` };
  }
}
