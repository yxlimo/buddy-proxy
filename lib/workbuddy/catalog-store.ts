// lib/workbuddy/catalog-store.ts — WorkBuddy 的模型目录住在数据库里。
//
// 上游自己发布目录（GET /v3/config），不发客户端版本就换模型，所以目录是活
// 的东西：昨天上游加的模型，今天就该能被路由到。
//
// 网关把目录落在 cache 表的一行里（`workbuddy:catalog`）。这一行永远是**最后
// 一次成功抓到的**目录，不会因为过期而作废 —— 过期只说明该再抓一次，不说明
// 手上这份是错的。少了它，写死的那张表就会顶上来，而那张表没有上游后来加的
// 模型：已经配好的 target 会被判成「上游不再提供」，模型被丢弃，根路由回 404。
//
// 写死的那份快照（lib/workbuddy/models.ts）只是**引导值**：全新库里还没有目
// 录时先顶上，抓到第一份就换成真的。

import { configNumber } from "../config.ts";
import { peekCached, setCached } from "../store.ts";
import { setWorkbuddyModelList, type WorkBuddyModel } from "./models.ts";

/** 目录在 cache 表里的那一行。 */
export const CATALOG_ID = "workbuddy:catalog";

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
export function readStoredCatalog(): StoredCatalog | null {
  const row = peekCached<{ models?: unknown }>(CATALOG_ID);
  const models = row?.data?.models;
  if (!Array.isArray(models) || !models.length) return null;
  return { models: models as WorkBuddyModel[], at: Number(row?.at ?? 0) };
}

/** 抓到了新的：写进库，也写进内存。 */
export function writeStoredCatalog(models: WorkBuddyModel[], at = Date.now()): StoredCatalog {
  setCached(CATALOG_ID, { models, at });
  setWorkbuddyModelList(models);
  return { models, at };
}

/**
 * 启动时把库里的目录读进内存。
 *
 * 注册表与路由读的是内存里那一份，所以这一步要在第一个请求之前做完：库里
 * 有就用库里的（哪怕它旧），没有就留着引导值，等第一次抓取换掉它。
 */
export function initWorkBuddyCatalog(): StoredCatalog | null {
  const stored = readStoredCatalog();
  if (stored) setWorkbuddyModelList(stored.models);
  return stored;
}
