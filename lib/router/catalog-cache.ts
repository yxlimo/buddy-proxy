// lib/router/catalog-cache.ts — the upstream's own model list, kept for a while.
//
// The upstream's list is fetched, not written down here: it changes on the
// platform's schedule, and the gateway only has to know it well enough to
// tell a client what exists. So it is cached for half an hour, and a fetch
// that fails leaves the previous list in place — an empty list is less use
// than an out-of-date one.

/** 一个上游的模型清单，缓存在这里。 */
export class CatalogCache<T> {
  private items: T[] = [];
  private at = 0;

  /** 清单最多放多久（毫秒）。 */
  constructor(private readonly ttlMs: number) {}

  /** 现在这份清单。第一次问上游之前是空的。 */
  list(): T[] {
    return this.items;
  }

  /** 该不该再问上游了。 */
  stale(force = false): boolean {
    if (force) return true;
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
    return true;
  }
}
