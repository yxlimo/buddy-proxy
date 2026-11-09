// lib/router/upstreams/client-gone.ts — 客户端走了的时候，怎么把上游停掉。
//
// 客户端走了（连接断了、它按了取消）：上游还在算就是在计费，账号还占着。所以
// 要把上游停掉 —— 停掉靠的是一个信号，fetch 与读流都听它的。
//
// 这一层管三件事，它们必须一起做，所以只开一个口子（runUnderClientGone）：
//   · 建：连接断了就中断那个信号；
//   · 翻：被我们掐断的上游抛的是 AbortError，而那个名字在别处被当成
//     「超时」（可以降级、换一个账号再试）。客户端都走了还降级，就是再打一个
//     白花钱的上游，还给账号记一次不该记的冷却；
//   · 收：监听器一定要摘（一次请求一个，不摘就漏）。

import type Koa from "koa";
import { ClientGoneError } from "../deliver.ts";

/** 盯着「客户端走了」这件事。 */
interface ClientGoneWatch {
  /** 客户端走了就中断的信号：交给上游的 fetch 与读流的那个循环。 */
  readonly signal: AbortSignal;
  /** 客户端已经走了吗。 */
  gone(): boolean;
  /** 不再盯了（答复已经送出去，或者上游的失败另有原因）。 */
  stop(): void;
}

/**
 * 一次上游请求在「客户端走了」这件事下的样子。
 *
 * 由 {@link runUnderClientGone} 交进来：那头负责建信号与收尾，这头只管用。
 */
export interface ClientGoneGuard {
  /** 交给上游的 fetch 与读流：客户端走了它就中断。 */
  readonly signal: AbortSignal;
  /** 客户端已经走了吗（现在没有走不代表以后不走）。 */
  gone(): boolean;
  /**
   * 把上游的失败翻成「客户端走了」：是我们掐断的就给出那个错误，不是就是
   * null。
   *
   * 不是掐断造成的（上游自己的 503、上游自己的超时）给 null —— 那种账还是要
   * 照记。翻译要读信号，所以必须在收尾之前调。
   */
  fail(error: unknown): ClientGoneError | null;
  /** 答复已经送出、或者这一路已经交给下一层了：不再盯。 */
  done(): void;
}

/**
 * 在这条请求的「客户端走了」之下跑完一次上游请求。
 *
 * 三件事必须一起做，所以只有这一个入口：
 *
 *   · 建：挂上监听器，给上游一个信号（不在调用方各自 `new AbortController`）；
 *   · 翻：上游的失败先过一遍「是不是客户端走了」再交出去。顺序不能反 ——
 *     停了监听就没法再判，AbortError 于是落回「超时」，账号记一次不属于它
 *     的冷却；
 *   · 收：无论成败都把监听器摘掉（一次请求一个监听器，不摘就漏）。
 *
 * 以前 qoder 与 workbuddy 各写了一遍这三件事，open-platform 一遍也没写，
 * 于是客户端走了在那里被算成上游的错（2026-11 的 opencode-go 冷却事故）。
 */
export async function runUnderClientGone<T>(
  out: Koa.Context,
  run: (guard: ClientGoneGuard) => Promise<T>,
): Promise<T> {
  const watch = watchClientGone(out);
  // 答复已经交给下一层（deliver.ts）了吗：交给它之后的事不归这一层判（那条
  // 路上的客户端走了由答复那一层自己的监听器与看门狗管，与从前一样）
  let handedOver = false;
  const guard: ClientGoneGuard = {
    signal: watch.signal,
    gone: watch.gone,
    fail: (error) => clientGoneOf(error, watch),
    done: () => {
      handedOver = true;
      watch.stop();
    },
  };
  try {
    return await run(guard);
  } catch (e) {
    // 先翻再收：`gone()` 靠那个信号判，信号要先在才能判准
    throw handedOver ? e : (clientGoneOf(e, watch) ?? e);
  } finally {
    watch.stop();
  }
}

/**
 * 盯住「客户端走了」这件事。
 *
 * 监听器挂在响应上：响应没写完就断了，才是客户端走了。
 *
 * 连接可能在我们挂上监听器**之前**就断了 —— 那个事件已经发过了，谁也没听见。
 * 那就当它已经走了（不然这一段没人管：上游接着算到超时，账号照付这笔钱）。
 */
function watchClientGone(out: Koa.Context): ClientGoneWatch {
  const abort = new AbortController();
  const onClose = () => {
    // `close` 在正常收尾时也会响（答复写完了、socket 关了）：那一响不代表客户端
    // 走了。不先看 `writableFinished`，已经送达的答复就被记成「客户端走了」，此后
    // 同一请求里任何 Abort 形状的错都被豁免成「客户端走了」—— 真故障于是不记账。
    // 要的是 `writableFinished`（数据全刷出去了）而不是 `writableEnded`（只是
    // end() 调过了）：后者为真时缓冲里还可能压着没送出去的帧。
    if (out.res.writableFinished) return;
    if (!abort.signal.aborted) abort.abort();
  };
  out.res.once("close", onClose);
  // 连接可能在挂监听器之前就断了：那个事件已经发过了，谁也没听见。
  if (out.res.destroyed) onClose();
  return {
    signal: abort.signal,
    gone: () => abort.signal.aborted,
    stop: () => out.res.off("close", onClose),
  };
}

/**
 * 这个失败是「客户端走了」吗：是就给出那个错误，不是就是 null。
 *
 * 上游的 fetch 是被我们的信号掐掉的，所以它抛的是 AbortError。那个名字在
 * `lib/router/provider-selection.ts` 里被算成「超时」—— 是「可以降级、换一个
 * 账号再试」的错。那样一来：客户端都走了，却给账号记一分钟冷却，还要再打一
 * 个上游（那个上游白花钱，而且客户端已经不要了）。
 *
 * 所以这里把它换成 ClientGoneError：它的意思就是「不是上游的错，别降级」。
 *
 * 判据只有一条：客户端真的走了（`watch.gone()`）而且这个错是掐断造成的。
 * 少判前者，客户端还在时上游真断了也会被豁免 —— 真故障就不记账了。
 */
function clientGoneOf(error: unknown, watch: ClientGoneWatch): ClientGoneError | null {
  if (error instanceof ClientGoneError) return error;
  if (!watch.gone()) return null;
  if (!isAbortError(error)) return null;
  return new ClientGoneError();
}

/**
 * 这个错是「被掐断了」吗。
 *
 * 只认 AbortError：超时也是掐断，但那个是上游的错（上游太久没回），该记冷却
 * 就记冷却 —— 换了账号也许能答得更快。
 */
function isAbortError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown; cause?: unknown } | null;
  if (!e) return false;
  if (e.name === "AbortError") return true;
  if (e.name === "TimeoutError") return false;
  if (typeof e.message === "string" && /abort/i.test(e.message)) return true;
  const cause = e.cause as { name?: unknown } | undefined;
  return cause?.name === "AbortError";
}
