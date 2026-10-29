// lib/health-cache.ts — 额度快照只活在进程内存里。
//
// 为什么不落库：额度是上游的现数，是「此刻」的事实，不是我们自己的状态。
// 落库会带来两个坏结果 ——
//   · 重启之后先拿旧数顶上，用户在面板上看到的是过期额度，比空着更误导；
//   · 上游已经把额度重置/追加了，我们还在展示昨天那 100%。
// 所以这里没有 cache 表那一行：进程起来先问一次上游，问不到就不显示。
//
// 谁在用：/health、面板的额度页（GetBalance）、以及路由层的「这个窗口什么时候
// 结束」（account-cooldown）。它们读的是同一份内存快照。

interface Snapshot<T> {
  data: T;
  at: number;
}

let current: Snapshot<unknown> | null = null;

/** 记下刚问到的额度。 */
export function putHealthSnapshot<T>(data: T): void {
  current = { data, at: Date.now() };
}

/** 现在的快照；没问过就是 null（调用方据此不显示，而不是拿旧数兜底）。 */
export function peekHealthSnapshot<T>(): Snapshot<T> | null {
  return current as Snapshot<T> | null;
}

/**
 * 忘掉这份快照。
 *
 * 一次刷新整体失败时用：宁可不显示，也不留上一份看着像最新的数字。
 */
export function clearHealthSnapshot(): void {
  current = null;
}
