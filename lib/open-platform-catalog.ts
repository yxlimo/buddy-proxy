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

import { openPlatformKeyOf } from "./open-platform-credentials.ts";
import { openPlatformOf, updateOpenPlatform, type OpenPlatformRow } from "./open-platforms.ts";
// 模板的 id 名单住在叶子模块里（lib/platform-templates.ts）：这一层要判「表里
// 那一行跟代码里的模板重名」，引 lib/platforms.ts 会绕成环（那一层引这一层）。
import { PLATFORMS } from "./platform-templates.ts";
import { accountsOfPlatform } from "./providers.ts";

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

/** 这个 id 是代码里的模板（模板优先：表里那一行不生效）。 */
function isTemplatePlatformId(id: string): boolean {
  return PLATFORMS.some((p) => p.id === id);
}

/**
 * 这个平台的目录要不要去拉。
 *
 * 人写死的目录不动（那是明确的意思，不是默认值）。跟代码里的模板重名的表行也
 * 不动：模板优先，那一行不生效，拉回来的目录写回去也会被拒
 * （lib/open-platforms.ts）。
 *
 * 启动时与请求路径上的刷新用同一套口径：写成两份就会走样 —— 一边跳过了，另一
 * 边还在每 5 分钟带真 key 打一次上游，而写回必然被拒。
 */
export function openPlatformCatalogRefreshable(row: OpenPlatformRow): boolean {
  return row.models.auto && !isTemplatePlatformId(row.id);
}

/**
 * 平台上第一个有 key 的账号的 key。
 *
 * 没有就空字符串：没有 key 就没法问上游（有些平台的 /models 要鉴权），那时
 * 不该发请求 —— 白跑一趟，还像是去扫接口。
 */
function accountKeyOf(platform: string): string {
  for (const account of accountsOfPlatform(platform)) {
    const key = openPlatformKeyOf(account.id);
    if (key?.apiKey) return key.apiKey;
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
 * 上游的模型清单：两种形状都认。
 *
 *   { data: [{ id }] }     OpenAI 的形状
 *   { models: [{ name }] } 另一种常见写法
 *
 * 都不认就是 null：宁可没有目录，也不要一份猜的。
 */
function parseModelList(payload: unknown): string[] | null {
  const body = payload as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : null;
  if (!list) return null;
  const out: string[] = [];
  for (const entry of list) {
    const item = entry as { id?: unknown; name?: unknown } | null;
    const raw = typeof entry === "string" ? entry : String(item?.id ?? item?.name ?? "");
    const id = raw.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
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
): Promise<string[] | null> {
  const base = String(row.baseUrl ?? "").trim();
  if (!base) return null;
  const apiKey = key ?? accountKeyOf(row.id);
  // 没有 key 是正常状态，不是故障：不问，也不吵。
  if (!apiKey) return null;
  let payload: unknown;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[OPEN-PLATFORM] ${row.id} 的模型目录拉不到：HTTP ${res.status}`);
      return null;
    }
    payload = await res.json();
  } catch (e) {
    console.warn(`[OPEN-PLATFORM] ${row.id} 的模型目录拉不到：${(e as Error)?.message ?? e}`);
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
export function refreshOpenPlatformCatalog(id: string): Promise<CatalogOutcome> {
  const running = inFlight.get(id);
  if (running) return running;
  const promise = runRefresh(id).finally(() => {
    inFlight.delete(id);
  });
  inFlight.set(id, promise);
  return promise;
}

/** 真去拉的那一轮。抛出来的东西都在这里归一成 { ok: false }。 */
async function runRefresh(id: string): Promise<CatalogOutcome> {
  try {
    const row = openPlatformOf(id);
    if (!row) return { ok: false, message: `没有这个平台：${id}` };
    if (!row.models.auto) return { ok: false, message: "目录是人写的，不自动拉" };
    // 模板重名：表里这一行不生效（模板优先），拉回来的目录写回去也会被拒。
    // 这个判断与退避都只看 row 与内存里的状态，不读库 —— 放在查 key 前面，
    // 请求路径上就不用为了判重去读 provider 表与凭据。
    if (isTemplatePlatformId(id)) {
      return { ok: false, message: "这个 id 是代码里的平台，表里这一行不生效" };
    }
    // 退避：上次成功之后失败过就先不再问。退避期内不告警 —— 同一个失败反复
    // 告警就是刷屏（请求路径上每个 /v1/models 都会走到这里）。
    const before = catalogState.get(id);
    if (
      before &&
      before.lastAttempt > before.lastSuccess &&
      Date.now() - before.at < FAILURE_BACKOFF_MS
    ) {
      return { ok: false, message: "刚问过上游，先不再问" };
    }
    // 没有 key 是正常状态（平台刚建、还没填 key）：不问上游，也不吵。
    const key = accountKeyOf(id);
    if (!key) {
      return { ok: false, message: "还没有能用的 API key，不去问上游要目录" };
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
    if (!models) return { ok: false, message: "拉不到模型目录，保留原来那份" };
    const written = updateOpenPlatform(id, {
      models,
      modelsAuto: true,
      source: "auto",
      fetchedAt: Date.now(),
    });
    if (!written.ok) {
      // 写不回去是配置或库的问题，不是一般的「拉不到」：把原因写进日志，事后
      // 才查得到「目录为什么没更新」。
      console.warn(`[OPEN-PLATFORM] ${id} 的模型目录没写回：${written.message}`);
      return { ok: false, message: written.message };
    }
    // 成功：这一次的序号就是「上次成功」。
    catalogState.set(id, { ...state, lastSuccess: seq });
    return { ok: true, message: `拉到 ${models.length} 个模型` };
  } catch (e) {
    // 库开不了、SQLITE_BUSY：这一轮拉不成，但不该把整个网关带走。
    const message = (e as Error)?.message ?? String(e);
    console.warn(`[OPEN-PLATFORM] ${id} 的模型目录没拉到：${message}`);
    return { ok: false, message: `拉不到模型目录：${message}` };
  }
}
