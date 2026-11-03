// test/client-gone-translate-check.ts — asClientGone 的分支：有人守。
//
//   node --experimental-strip-types test/client-gone-translate-check.ts
//
// 离线：纯单元测，不起网关、不起假上游、不碰真平台、不花额度。
//
// 适配器层（lib/router/upstreams/{qoder,workbuddy}.ts）的账号回调里各有一行
//   .catch((e) => { throw asClientGone(e, watch); })
// 这行调的就是 asClientGone。本文件守的是 asClientGone 这个**函数**的分支 ——
// 直接喂各种错误形状给它，不经过 transport、不经过适配器。
//
// 这么守是有意为之的，说清楚边界：
//   · WorkBuddy 那行 .catch 今天是「恒等」—— lib/workbuddy/transport.ts:236
//     自己先翻了一遍，到适配器层时 e 已经是 ClientGoneError，asClientGone
//     原样放行。删掉适配器那行，行为不变（作者第四轮实测确认）。
//   · Qoder 那行才是「transport 不翻译」的唯一翻译点 —— lib/qoder/transport.ts
//     没有 ClientGoneError 处理，只把 signal 塞给 fetch。那行由
//     test/client-gone-check.ts 的 Qoder 场景（e2e）守住。
//   · 这个文件守住的是 asClientGone 本身：哪天 transport 形状变了、或者这
//     个函数被人改了（比如误把 TimeoutError 也翻、或者漏了 cause 链），
//     这里当场红。它不替适配器那两行背书，只替函数背书。

import { asClientGone, type ClientGoneWatch } from "../lib/router/upstreams/client-gone.ts";
import { ClientGoneError } from "../lib/router/deliver.ts";
import { AuthError } from "../lib/credential.ts";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 一个不用 Koa 的 watch：gone() 读自己的 signal（与真 watchClientGone 同形），
 * stop() 记一个标志 —— asClientGone 不该碰 stop()，停 watch 是调用方的事。
 */
function watch(gone: boolean): ClientGoneWatch & { stopped: boolean } {
  const controller = new AbortController();
  if (gone) controller.abort();
  let stopped = false;
  return {
    signal: controller.signal,
    gone: () => controller.signal.aborted,
    stop: () => {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
  } as ClientGoneWatch & { stopped: boolean };
}

/** 一个真 AbortError 形状（undici 取消时就是这个）。 */
function abortError(message = "This operation was aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

/** undici 读流取消时常抛成 TypeError，把 abort 放在 cause 上。 */
function terminatedError(): Error {
  const e = new TypeError("terminated");
  (e as { cause?: unknown }).cause = abortError();
  return e;
}

/** 把翻译结果说清楚：原样还是翻成了什么。 */
function describe(out: unknown, original?: unknown): string {
  if (original !== undefined && out === original) return "原样";
  return String((out as Error)?.name ?? out);
}

console.log("");
console.log("asClientGone：客户端走了 + abort 形状 → ClientGoneError");

{
  // 最直接的形状：undici 的 AbortError。客户端走了（watch.gone() 为真）。
  const w = watch(true);
  const out = asClientGone(abortError(), w);
  check("AbortError 翻成 ClientGoneError", out instanceof ClientGoneError, describe(out));
  check("翻译过程没停 watch（停 watch 是调用方的事）", !w.stopped);

  // undici 读流取消时是 TypeError("terminated") + cause=AbortError。
  const term = asClientGone(terminatedError(), watch(true));
  check("TypeError(cause=AbortError) 翻成 ClientGoneError", term instanceof ClientGoneError, describe(term));

  // 消息里带 abort 的普通 Error 也认（cliFetch 的 Error("the request was aborted")）。
  const said = asClientGone(new Error("the request was aborted"), watch(true));
  check("消息里带 abort 的 Error 翻成 ClientGoneError", said instanceof ClientGoneError, describe(said));
}

console.log("");
console.log("不该翻的：原样出去");

{
  // 客户端没走：不管错误是什么形状，都不是客户端的「走」—— 原样。
  const e = abortError();
  const out = asClientGone(e, watch(false));
  check("客户端没走：AbortError 原样出去", out === e, describe(out, e));

  // 上游的超时：TimeoutError 是上游的错（上游太久没回），不是客户端走了 ——
  // 该记冷却就记，换了账号也许能答得更快。不翻。
  //
  // 用真形状：AbortSignal.timeout() 拒绝时 name=TimeoutError、消息里带 "abort"
  // （"The operation was aborted due to timeout"）。isAbortError 里那一行
  // `if (name === "TimeoutError") return false` 就是为此：name 优先于 message，
  // 不然超时会因为消息里的 abort 被翻成客户端走了 → 账号不记冷却 → 反复打。
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const t = asClientGone(timeout, watch(true));
  check("TimeoutError 不翻（上游的错，name 优先于 message）", t === timeout, describe(t, timeout));

  // 顺序钉死：同一个 TimeoutError 如果去掉 name，消息里的 abort 会让它被翻 ——
  // 说明上一条之所以不翻，靠的就是 name 那一行，不是消息里没 abort。
  const noName = new Error("The operation was aborted due to timeout");
  const n = asClientGone(noName, watch(true));
  check("去掉 name 后同一个消息会被翻（证明 name 那行在起作用）", n instanceof ClientGoneError, describe(n));

  // 上游自己回的错（400、401、429、5xx）：不是 abort 形状，原样 ——
  // 那种时候账号的账要照记。
  const upstream = new Error("upstream rejected the credential");
  const u = asClientGone(upstream, watch(true));
  check("上游的业务错原样出去", u === upstream, describe(u, upstream));

  // 空错误不炸也不翻（isAbortError 第一行 `if (!e) return false` 是防崩的）。
  check("空错误不炸也不翻", asClientGone(undefined, watch(true)) === undefined);

  // cause 链只翻一层：isAbortError 只看 e.cause.name，不沿链往上。两层 cause
  // （外层不是 abort、cause.cause 才是）不该被翻 —— 钉住「只翻一层」。
  const outer = new TypeError("terminated");
  const inner = new Error("terminated");
  (inner as { cause?: unknown }).cause = abortError();
  (outer as { cause?: unknown }).cause = inner;
  const deep = asClientGone(outer, watch(true));
  check("cause 链只翻一层（外层不是 abort 就原样）", deep === outer, describe(deep, outer));

  // 已经是 ClientGoneError：原样（幂等，不会再包一层）。
  const already = new ClientGoneError();
  const a = asClientGone(already, watch(true));
  check("已经是 ClientGoneError：原样（幂等）", a === already, describe(a, already));
}

console.log("");
console.log("翻过来的 ClientGoneError：策略层认它");

{
  // 翻出来的那个，策略层靠「是不是 ClientGoneError」区分「账号的错」和「客户端
  // 走了」（policy.ts:551）。所以 instanceof 要对，且不能是 AuthError ——
  // AuthError 带状态码，会被当成账号的失败。
  const out = asClientGone(abortError(), watch(true));
  check("翻出来的是 ClientGoneError 实例", out instanceof ClientGoneError, describe(out));
  check("翻出来的不是 AuthError（不带状态码，不是账号的错）", !(out instanceof AuthError), describe(out));
  check("翻出来的 name 就是 ClientGoneError", (out as Error).name === "ClientGoneError", describe(out));
}

console.log("");
console.log(`${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
