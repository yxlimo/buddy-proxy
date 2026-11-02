// lib/open-platform-catalog.ts — 开放平台的模型目录：问上游拉一份。
//
// 目录是**平台**的，不是账号的：同一个平台下两个账号服务同一批模型。所以拉
// 目录用名下第一个有 key 的账号就够 —— 目录跟是谁付钱无关。
//
// 拉不到不算失败：原来那份目录留着（人写死的那份比自动拉的更值钱），记一
// 行日志。这个函数跑在后台（启动时、目录刷新时），不在请求路径上。
//
// 它不碰额度：额度是那个额度插件的事，还没接。

import { openPlatformKeyOf } from "./open-platform-credentials.ts";
import { openPlatformOf, updateOpenPlatform, type OpenPlatformRow } from "./open-platforms.ts";
import { accountsOfPlatform } from "./providers.ts";

/** 拉目录最多等多久（毫秒）：上游慢的时候不占着后台。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 目录多久算过期（毫秒）：过期了才值得再问上游一次。 */
export const OPEN_PLATFORM_CATALOG_TTL_MS = 30 * 60_000;

/** 这个平台的目录现在要不要重拉。 */
export function openPlatformCatalogStale(row: OpenPlatformRow, now = Date.now()): boolean {
  return now - row.models.fetchedAt >= OPEN_PLATFORM_CATALOG_TTL_MS;
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
 */
export async function fetchOpenPlatformModels(row: OpenPlatformRow): Promise<string[] | null> {
  const base = String(row.baseUrl ?? "").trim();
  if (!base) return null;
  const key = accountKeyOf(row.id);
  if (!key) {
    console.warn(`[OPEN-PLATFORM] ${row.id} 还没有能用的 API key，不去问上游要目录`);
    return null;
  }
  let payload: unknown;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { accept: "application/json", Authorization: `Bearer ${key}` },
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
 */
export async function refreshOpenPlatformCatalog(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const row = openPlatformOf(id);
  if (!row) return { ok: false, message: `没有这个平台：${id}` };
  if (!row.models.auto) return { ok: false, message: "目录是人写的，不自动拉" };
  const models = await fetchOpenPlatformModels(row);
  if (!models) return { ok: false, message: "拉不到模型目录，保留原来那份" };
  const written = updateOpenPlatform(id, {
    models,
    modelsAuto: true,
    source: "auto",
    fetchedAt: Date.now(),
  });
  if (!written.ok) return { ok: false, message: written.message };
  return { ok: true, message: `拉到 ${models.length} 个模型` };
}
