// lib/router/catalog-cache.ts — the upstream's own model list, kept for a while.
//
// The upstream's list is fetched, not written down here: it changes on the
// platform's schedule, and the gateway only has to know it well enough to
// tell a client what exists. So it is cached for half an hour, and a fetch
// that fails leaves the previous list in place — an empty list is less use
// than an out-of-date one.
//
// With a cache id the list also lives in the database, one row of the cache
// table. That is what keeps a platform visible across a restart: an empty
// list makes the whole platform disappear from the model list, and a
// platform that is invisible cannot be routed to. The row holds the last
// list the upstream published — its age says whether to fetch again, never
// that the list itself is wrong.

import { peekCached, setCached } from "../store.ts";

/** 一个上游的模型清单，缓存在这里。 */
export class CatalogCache<T> {
  private items: T[] = [];
  private at = 0;
  /** 内存里空的时候问过库没有？ */
  private loaded = false;
  /** 库里那行的 id（没给就不落库）。 */
  private readonly cacheId: string | undefined;

  /** 清单最多放多久（毫秒）。 */
  constructor(private readonly ttlMs: number, options: { cacheId?: string } = {}) {
    this.cacheId = options.cacheId;
  }

  /** 现在这份清单。第一次问上游之前是空的。 */
  list(): T[] {
    this.loadIfEmpty();
    return this.items;
  }

  /** 该不该再问上游了。 */
  stale(force = false): boolean {
    if (force) return true;
    this.loadIfEmpty();
    if (!this.items.length) return true;
    return Date.now() - this.at >= this.ttlMs;
  }

  /**
   * 记下新的一份清单。
   *
   * 空的不记 —— 问上游问到了一个空清单，多半是它没答好，留着上一次的那份
   * 比换成空的强。
   */
  update(items: T[]): boolean {
    if (!items.length) return false;
    this.items = items;
    this.at = Date.now();
    this.loaded = true;
    this.persist();
    return true;
  }

  /**
   * 库里空的时候把它读回来。
   *
   * 读库失败按没有清单处理：缓存读不了不该把目录打挂，手上空的也比崩掉强。
   */
  private loadIfEmpty(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.items.length) return;
    if (!this.cacheId) return;
    try {
      const row = peekCached<{ items?: unknown; at?: unknown }>(this.cacheId);
      const items = row?.data?.items;
      if (!Array.isArray(items) || !items.length) return;
      this.items = items as T[];
      const at = Number(row?.data?.at);
      this.at = Number.isFinite(at) && at > 0 ? at : Number(row?.at ?? 0);
    } catch (e) {
      console.warn(`[catalog] 读取模型目录缓存失败：${(e as Error)?.message}`);
    }
  }

  /** 写回库里。写不进去只是丢了下次重启的目录，不影响这一次。 */
  private persist(): void {
    if (!this.cacheId) return;
    try {
      setCached(this.cacheId, { items: this.items, at: this.at });
    } catch (e) {
      console.warn(`[catalog] 写入模型目录缓存失败：${(e as Error)?.message}`);
    }
  }
}
