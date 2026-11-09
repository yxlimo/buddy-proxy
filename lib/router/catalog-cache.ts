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

import { syncPlatformModels } from "../open-platforms.ts";
import { peekCached, setCached } from "../store.ts";

/** 一个上游的模型清单，缓存在这里。 */
export class CatalogCache<T> {
  private items: T[] = [];
  private at = 0;
  /** 内存里空的时候问过库没有？ */
  private loaded = false;
  /** 库里那行的 id（没给就不落库）。 */
  private readonly cacheId: string | undefined;
  /**
   * 这份清单属于哪个平台（没给就不往平台行里写）。
   *
   * 目录由平台那一行说了算（各 kind 的 models() 读它，见 lib/catalog-models.ts），
   * 所以上游这份清单到手时要同步到那一行 —— 不写就变成「上游答了、面板还是
   * 空」。哪一行也跟 cacheId 一样是声明出来的，不靠猜 id 的写法。
   */
  private readonly platform: string | undefined;

  /** 清单最多放多久（毫秒）。 */
  private readonly ttlMs: number;

  constructor(ttlMs: number, options: { cacheId?: string; platform?: string } = {}) {
    this.ttlMs = ttlMs;
    this.cacheId = options.cacheId;
    this.platform = options.platform;
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
    this.syncPlatformRow();
    return true;
  }

  /**
   * 目录到手了，平台那一行跟着改。
   *
   * 同步只有这一个落点：拿到新清单的那一处。两个 refresh 函数各自写一遍，就是
   * 两份知识，早晚漂。拉失败时 update() 根本不会被调到，行也就不动 —— 行的内容
   * 只在「真拿到新目录」时变。
   *
   * 写不进去只是面板上那份目录旧一点：清单本身已经在内存与 cache 表里了，所以
   * 不抛。
   */
  private syncPlatformRow(): void {
    if (!this.platform) return;
    const ids = this.items.map((item) => String((item as { id?: unknown } | null)?.id ?? ""));
    // 没有 id 的项不能闷声丢掉：上游若把字段名从 id 改成 model_id，同步会「成功」
    // 而写进平台行的只剩空名字 —— 那看起来像「上游报了空目录」，看不出是名字换来
    // 了。记一句，让人能对上。
    const nameless = ids.filter((id) => !id).length;
    if (nameless) {
      console.warn(
        `[catalog] 上游目录里有 ${nameless} 项没有 id（字段名换了？），这些不会写进平台行`,
      );
    }
    try {
      syncPlatformModels(this.platform, ids);
    } catch (e) {
      console.warn(`[catalog] 把目录写回平台行失败：${(e as Error)?.message}`);
    }
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
