// lib/workbuddy/catalog-store.ts — WorkBuddy 的模型目录住在数据库里。
//
// 上游自己发布目录（GET /v3/config），不发客户端版本就换模型，所以目录是活
// 的东西：昨天上游加的模型，今天就该能被路由到。
//
// 网关把目录落在 cache 表里（`workbuddy:catalog:<region>`）。这一行永远是
// **最后一次成功抓到的**目录，不会因为过期而作废 —— 过期只说明该再抓一次，
// 不说明手上这份是错的。少了它，写死的那张表就会顶上来，而那张表没有上游后
// 来加的模型：已经配好的 target 会被判成「上游不再提供」，模型被丢弃，根路
// 由回 404。
//
// **目录是按区域的，不是按 kind 的。** workbuddy.cn 和 workbuddy.ai 各自发布
// 一份，两边几乎不重叠。早先这里只有一行（`workbuddy:catalog`），于是后抓的
// 那个区把先抓的顶掉，另一个区就拿着一份自己上游根本没有的模型名去点名，上游
// 回 `11102 model [x] service info not found`。现在每个区域一行。
//
// 写死的那份快照（lib/workbuddy/models.ts）只是**引导值**，而且是中国的：
// 全新库里还没有目录时先给 cn 顶上，抓到第一份就换成真的。别的区域没有引导
// 值，抓到之前就是空的。

import { configNumber } from "../config.ts";
import { peekCached, setCached } from "../store.ts";
import { setWorkbuddyModelList, type WorkBuddyModel } from "./models.ts";

/** 所有 WorkBuddy 区域。目录、内存缓存都按它分开。 */
export const WORKBUDDY_REGIONS = ["cn", "global"] as const;

/** 目录在 cache 表里的那一行。一个区域一行。 */
export function catalogId(region = "cn"): string {
  return `workbuddy:catalog:${region}`;
}

/** 目录多久算旧（毫秒）。旧了就该再抓一次 —— 但手上那份仍然算数。 */
export function catalogTtlMs(): number {
  return configNumber("WORKBUDDY_CATALOG_TTL_MS", 48 * 60 * 1000);
}

/** 库里那份目录。 */
export interface StoredCatalog {
  models: WorkBuddyModel[];
  /** 抓到的时刻（毫秒）。 */
  at: number;
}

/**
 * 库里那份目录，不管多旧。
 *
 * 旧的不作废：抓不到上游的时候，这一行就是手上唯一真的那份目录。
 */
export function readStoredCatalog(region = "cn"): StoredCatalog | null {
  const row = peekCached<{ models?: unknown }>(catalogId(region));
  const models = row?.data?.models;
  if (!Array.isArray(models) || !models.length) return null;
  return { models: models as WorkBuddyModel[], at: Number(row?.at ?? 0) };
}

/** 抓到了新的：写进库，也写进内存。 */
export function writeStoredCatalog(models: WorkBuddyModel[], region = "cn", at = Date.now()): StoredCatalog {
  setCached(catalogId(region), { models, at });
  setWorkbuddyModelList(models, region);
  return { models, at };
}

/**
 * 启动时把库里的目录读进内存。
 *
 * 注册表与路由读的是内存里那一份，所以这一步要在第一个请求之前做完：库里
 * 有就用库里的（哪怕它旧），没有就留着引导值，等第一次抓取换掉它。
 *
 * 两个区域都要读 —— 只读 cn 的话，国际区在第一次抓取之前是空的，而那期间
 * 打进来的请求会被判成「没有这个模型」。
 */
export function initWorkBuddyCatalog(): Map<string, StoredCatalog> {
  const loaded = new Map<string, StoredCatalog>();
  for (const region of WORKBUDDY_REGIONS) {
    const stored = readStoredCatalog(region);
    if (stored) {
      setWorkbuddyModelList(stored.models, region);
      loaded.set(region, stored);
    }
  }
  return loaded;
}
