// lib/qiniu/catalog.ts — 模型目录：平台自己公布的那一份。
//
// 七牛云讲 OpenAI 方言，推理端点上有 `/models`，拿回来什么就公布什么。
// 目录落在缓存里（半小时），问失败了就留着上一次的那份：空目录比旧目录更
// 没用（目录空 = 平台在模型列表里整组消失 = 路由不到）。

import { CatalogCache } from "../router/catalog-cache.ts";
import type { CatalogModel } from "../catalog-models.ts";
import { qiniuInferenceKey } from "./account.ts";
import { QINIU_INFER_BASE } from "./config.ts";

/** 清单最多放多久（毫秒）。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;

/** 一次 fetch 的超时。 */
const TIMEOUT_MS = 15_000;

/** 平台自己的一份模型。 */
export interface QiniuCatalogModel {
  id: string;
  name?: string;
}

/** 缓存的模型目录。落库一份：重启后手上就有目录。 */
const catalog = new CatalogCache<QiniuCatalogModel>(CATALOG_TTL_MS, { cacheId: "qiniu:catalog" });

/** 现在这份目录。第一次问上游之前是空的。 */
export function qiniuCatalog(): QiniuCatalogModel[] {
  return catalog.list();
}

/**
 * 目录里的模型，渲染成统一的形状。
 *
 * 平台的 `/models` 是 OpenAI 形状，只说有哪些模型，不说能力：上下文长度、
 * 输出上限都没有，这里也不填（不拿别的数来凑）。
 */
export function qiniuCatalogModels(models: QiniuCatalogModel[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.name || m.id,
    // 平台没说它会不会思考，所以这里不说它会。
    reasoning: false,
    // 工具是 OpenAI 方言本身的一部分：这套端点讲这个协议，就按有工具报。
    toolCall: true,
  }));
}

/**
 * 问平台要模型目录，缓存在这里。
 *
 * 问不到就保持原样（不抛）：拿不到 key、请求失败、回答不是 OpenAI 形状，
 * 都是「这一次没问到」。
 */
export async function refreshQiniuCatalog(providerId: string, force = false): Promise<void> {
  if (!catalog.stale(force)) return;
  const key = qiniuInferenceKey(providerId);
  if (!key) return;
  try {
    const res = await fetch(`${QINIU_INFER_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[QINIU] 模型目录刷新失败（HTTP ${res.status}）`);
      return;
    }
    const body = await res.json().catch(() => null);
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      console.warn("[QINIU] 模型目录的回答不是 OpenAI 形状");
      return;
    }
    const models: QiniuCatalogModel[] = [];
    for (const raw of data) {
      const row = raw as { id?: unknown; name?: unknown } | null;
      const id = String(row?.id ?? "").trim();
      if (!id) continue;
      models.push({ id, ...(row?.name ? { name: String(row.name) } : {}) });
    }
    // 空的不记：上一次的那份比空目录强。
    catalog.update(models);
  } catch (e) {
    console.warn(`[QINIU] 模型目录刷新失败：${(e as Error)?.message}`);
  }
}
