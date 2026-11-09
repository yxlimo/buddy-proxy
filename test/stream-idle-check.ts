// test/stream-idle-check.ts — 上游安静下来的时候，这条请求要有个尽头。
//
//   node --experimental-strip-types test/stream-idle-check.ts
//
// 离线：起一个本地的假上游和一个真的 HTTP 服务，不连任何真平台。
//
// 那两次事故（生产实录）：
//
//   21:00:12 [DELIVER] 发给客户端的错误事件：terminated
//   21:00:12 [REQ] POST /v1/messages model=coder-a → 200 304690ms from=pi
//
// 上游中途不吐数据，我们没有任何自己的空闲超时，靠 undici 默认的
// bodyTimeout: 300_000 兜底：客户端干等 5 分钟，最后收到的是 Node 自己那句
// `terminated` —— 既不是它能看懂的东西，也不该是网关该说的话。
//
// 覆盖：
//   1. 上游说了一帧就安静 → 客户端在空闲上限之后收到一条 error 事件，那句话
//      是「上游不说话了」，不含 terminated；
//   2. 上游一直在吐（每 40ms 一帧，共 10 帧）→ 一帧不少、没有 error 事件
//      （证明上限量的是「两帧之间」，不是总时长）；
//   3. 上游一帧都不吐 → 同样在上限之后报那句话（等第一帧也算安静）；
//   4. clientMessageOf 的判别力：内部字眼翻成人话，别的错误原样返回。
//
// 还有四条是 review 之后补的（都是同一个东西：这道闸只该量上游的安静）：
//   5. 上游一直在吐（Anthropic 入口，tee 那条路）→ 一帧不少；
//   6. 消费方自己停一会儿不读（慢客户端）→ 不算安静，一帧不丢、上游不取消；
//   7. peek 阶段出错（上游在吐出第一帧之前就断了）→ 一条 error 帧，不再往外抛
//      （抛出去路由层会换账号重来，换来的是第二次 sseHead 与一次白打的上游）；
//   8. 空闲上限设成 0 → 闸关掉：上游一帧都不吐也不报超时。
//
// 断言看的是**网关那一侧**加客户端收到的字节：客户端那边一个不读的 socket
// 连服务器关了它都察觉不到。
//
// 空闲上限在模块求值时读一次（`ROUTER_STREAM_IDLE_MS`），所以必须在 import
// 之前设好 —— 见下面那行 `process.env`。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stream-idle-"));
process.env.BUDDY_DATA_DIR = tmp;
// 自测不能真等两分钟。
const IDLE_MS = 150;
process.env.ROUTER_STREAM_IDLE_MS = String(IDLE_MS);

const { deliverOpenAIStream, deliverAnthropicStream, clientMessageOf, StreamIdleError, withStreamIdle, STREAM_IDLE_DEFAULT_MS } =
  await import("../lib/router/deliver.ts");

/** 上游没把话说完就断了：客户端看到的那一句。 */
const CLOSED_EARLY = "upstream closed the connection before the answer finished";

let pass = 0;
let fail = 0;

// 整个测试的总时限。**不 unref**：这条测试里有「上游永远不说话」的场景，真要
// 是哪里挂住了，事件循环空掉之后 node 会直接退出、一条断言都不报 —— 那比红更糟。
const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`\n[FAIL] 整个测试超过 ${WATCHDOG_MS / 1000}s 没跑完（网关可能挂住了）`);
  process.exit(1);
}, WATCHDOG_MS);

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const encoder = new TextEncoder();

/** 一条 Anthropic 方言的 SSE 帧。 */
function anthropicFrame(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 一条 Anthropic 的 message_start（客户端要读的那一帧）。 */
function messageStart(): string {
  return anthropicFrame("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  });
}

/** 一条 OpenAI 方言的正文帧。 */
function openaiFrame(content: string): string {
  return (
    "data: " +
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      model: "fake-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }) +
    "\n\n"
  );
}

/**
 * 一个假的上游。
 *
 * `gapMs`：帧与帧之间隔多久（上游是慢慢想、慢慢说的）。
 * `after`：说完之后干什么 —— `close` 收工，`stall` 一直不说话（连接还挂着，
 * 正是「上游卡住了」那个样子），`raw` 直接把 Node 自己那个错扔出来
 * （`TypeError: terminated`，undici 断流时抛的就是它）。
 * `onCancel`：上游那一侧被取消时叫它（安静到上限就该停手，别再占着连接）。
 */
function upstream(
  frames: string[],
  opts: { gapMs?: number; after?: "close" | "stall" | "raw"; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.gapMs) await sleep(opts.gapMs);
      if (sent < frames.length) {
        controller.enqueue(encoder.encode(frames[sent++]));
        return;
      }
      if (opts.after === "stall") {
        // 一直不说话：不 close、不再 enqueue。
        await new Promise<void>(() => {});
        return;
      }
      if (opts.after === "raw") {
        // undici 断流时抛的那个错：message 是 Node 的话，真正的原因在 cause 上。
        throw Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
      }
      controller.close();
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

/** 客户端收到的帧里那句错误话（两种方言的 error 形状都认）。 */
function errorMessageOf(frames: string[]): string {
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json?.type === "error" && json.error?.message) return String(json.error.message);
    if (json?.error?.message) return String(json.error.message);
  }
  return "";
}

interface ServeResult {
  /** 客户端收到的帧。 */
  received: string[];
  /** 网关那个处理器什么时候回来的（ms，从起服务算起）。 */
  handlerMs: number;
  /** 网关有没有抛出来。 */
  handlerError: string | null;
  /** 网关报给调用方的失败（如果有）。 */
  failure: any;
}

/** 起一个服务，把假上游交给网关转发，把客户端收到的帧收回来。 */
async function serve(opts: {
  source: ReadableStream<Uint8Array>;
  entry: "openai" | "anthropic";
  dialect: "openai" | "anthropic";
}): Promise<ServeResult> {
  const started = Date.now();
  let handlerError: string | null = null;
  let failure: any = null;
  let handlerDone: () => void = () => {};
  const handlerFinished = new Promise<void>((resolve) => {
    handlerDone = resolve;
  });

  const server = http.createServer(async (_req, res) => {
    // 一个最小的 Koa 上下文：只用到 res。
    const ctx = { res, status: 200, respond: false } as any;
    const report = (e: unknown) => {
      failure = e;
    };
    try {
      if (opts.entry === "openai") {
        await deliverOpenAIStream(ctx, opts.source, opts.dialect, "fake-model", undefined, undefined, report);
      } else {
        await deliverAnthropicStream(ctx, opts.source, opts.dialect, "fake-model", 0, undefined, report);
      }
    } catch (e) {
      handlerError = (e as Error)?.message ?? String(e);
    } finally {
      handlerDone();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const received: string[] = [];
  const clientDone = new Promise<void>((resolve) => {
    const req = http.request(
      { port, host: "127.0.0.1", path: "/v1/messages", method: "POST" },
      (r) => {
        let buf = "";
        r.on("data", (c) => {
          buf += c.toString();
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            received.push(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        });
        r.on("end", resolve);
        r.on("close", resolve);
        r.on("error", resolve);
      },
    );
    req.on("error", resolve);
    req.end("{}");
  });

  // 网关那一侧先完事：这是断言要看的东西。
  await Promise.race([handlerFinished, new Promise<void>((resolve) => setTimeout(resolve, 20_000))]);
  const handlerMs = Date.now() - started;

  // 客户端那边可能不结束（连接还挂着），给它一个上限，然后放掉。
  await Promise.race([clientDone, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, handlerMs, handlerError, failure };
}

/* ------------------------------------------------------------------ *
 * 1. 上游说了一帧就安静
 * ------------------------------------------------------------------ */

section("上游说了一帧就安静（Anthropic 入口）");

{
  let cancelled = false;
  const r = await serve({
    source: upstream([messageStart()], { after: "stall", onCancel: () => (cancelled = true) }),
    entry: "anthropic",
    dialect: "anthropic",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check("客户端收到了第一帧", text.includes("message_start"), text.slice(0, 120));
  check("客户端收到了一条 error 事件", text.includes("event: error"), text.slice(0, 200));
  check("那句话说的是上游安静了", /upstream sent nothing for \d+/.test(said), said);
  check("那句话带上了是哪个模型", said.includes("model=fake-model"), said);
  check("那句话里没有 terminated", !/terminated/i.test(text), said);
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
  check("网关在空闲上限之后很快就收工了", r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
  check("上游那一侧被取消了", cancelled, "上游还挂着");
  check("网关报了「超时」", r.failure?.name === "TimeoutError", String(r.failure?.name));
}

section("上游说了一帧就安静（OpenAI 入口）");

{
  let cancelled = false;
  const r = await serve({
    source: upstream([openaiFrame("hello")], { after: "stall", onCancel: () => (cancelled = true) }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check("客户端收到了第一帧", text.includes("hello"), text.slice(0, 120));
  check("客户端收到了一条 error 帧", said !== "", text.slice(0, 200));
  check("那句话说的是上游安静了", /upstream sent nothing for \d+/.test(said), said);
  check("那句话里没有 terminated", !/terminated/i.test(text), said);
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
  check("网关在空闲上限之后很快就收工了", r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
  check("上游那一侧被取消了", cancelled, "上游还挂着");
  check("网关报了「超时」", r.failure?.name === "TimeoutError", String(r.failure?.name));
}

/* ------------------------------------------------------------------ *
 * 1c. 上游中途断了：Node 自己那句话不许透给客户端
 * ------------------------------------------------------------------ */

// 生产实录就是这一条：`[DELIVER] 发给客户端的错误事件：terminated`。客户端
// 收到的是 `{"type":"error","error":{"message":"terminated"}}` —— 它既不是
// 「哪一类失败」，也不是客户端能处理的东西。
section("上游中途断了（Node 自己那句话）");

for (const [entry, dialect, first] of [
  ["anthropic", "anthropic", messageStart()],
  ["openai", "openai", openaiFrame("hello")],
] as const) {
  const r = await serve({
    source: upstream([first], { after: "raw" }),
    entry,
    dialect,
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check(`[${entry}] 客户端收到了第一帧`, /hello|message_start/.test(text), text.slice(0, 120));
  check(`[${entry}] 客户端收到了一条 error`, said !== "", text.slice(0, 200));
  check(`[${entry}] 那句话是通用的「连接断了」`, said === CLOSED_EARLY, said);
  check(`[${entry}] 整条答复里没有 terminated`, !/terminated/i.test(text), text.slice(0, 200));
  check(`[${entry}] 网关报了上游的错`, r.failure instanceof TypeError, String(r.failure));
}

/* ------------------------------------------------------------------ *
 * 2. 上游一直在吐：量的是两帧之间，不是总时长
 * ------------------------------------------------------------------ */

section("上游一直在吐（每 40ms 一帧，共 10 帧）");

{
  // 整条流跑了 400ms 以上，比空闲上限（150ms）长得多。每两帧之间只有 40ms，
  // 所以一帧都不许丢 —— 按总时长算的话，这条流早就被砍了。
  const frames = Array.from({ length: 10 }, (_, i) => openaiFrame(`w${i}`));
  const r = await serve({
    source: upstream(frames, { gapMs: 40 }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  const bodies = r.received.filter((frame) => frame.startsWith("data: {"));
  check("十帧都送到了", bodies.length === 10, `${bodies.length} 帧`);
  check("每一帧的内容都在", frames.every((_, i) => text.includes(`w${i}`)), "");
  check("有收尾的 [DONE]", text.includes("[DONE]"), "");
  check("没有 error 帧", said === "", said);
  check("网关没有报失败", r.failure === null, String(r.failure));
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
}

/* ------------------------------------------------------------------ *
 * 2b. 上游一直在吐（Anthropic 入口，tee 那条路）
 * ------------------------------------------------------------------ */

section("上游一直在吐（Anthropic 入口，tee 那条路，每 40ms 一帧，共 10 帧）");

{
  // 同一条事，走 tee：源头被复制成两支（一支给客户端、一支解 usage），两支
  // 都得读到东西，源头才不会因为没人读而挂在那里。整条流跑 400ms 以上，比
  // 上限（150ms）长得多，每两帧之间只有 40ms —— 一帧都不许丢。
  const events = Array.from({ length: 10 }, (_, i) =>
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `w${i}` },
    }),
  );
  const r = await serve({
    source: upstream([messageStart(), ...events], { gapMs: 40 }),
    entry: "anthropic",
    dialect: "anthropic",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check("十帧都送到了", events.every((_, i) => text.includes(`w${i}`)), `${r.received.length} 帧`);
  check("没有 error 事件", said === "", said);
  check("网关没有报失败", r.failure === null, String(r.failure));
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
}

/* ------------------------------------------------------------------ *
 * 3. 上游一帧都不吐
 * ------------------------------------------------------------------ */

section("上游一帧都不吐（一帧都没有的等待也算安静）");

for (const [entry, dialect] of [
  ["anthropic", "anthropic"],
  ["openai", "openai"],
] as const) {
  let cancelled = false;
  const r = await serve({
    source: upstream([], { after: "stall", onCancel: () => (cancelled = true) }),
    entry,
    dialect,
  });
  const said = errorMessageOf(r.received);
  check(`[${entry}] 客户端收到了那句话`, /upstream sent nothing for \d+/.test(said), said);
  check(`[${entry}] 那句话里没有 terminated`, !/terminated/i.test(said), said);
  check(`[${entry}] 网关在空闲上限之后很快就收工了`, r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
  check(`[${entry}] 上游那一侧被取消了`, cancelled, "上游还挂着");
  check(`[${entry}] 网关报了「超时」`, r.failure?.name === "TimeoutError", String(r.failure?.name));
}

/* ------------------------------------------------------------------ *
 * 3b. 消费方自己停一会儿不读：慢客户端不是安静的上游
 * ------------------------------------------------------------------ */

section("消费方停一会儿不读（慢客户端不是安静的上游）");

// 计时只在**有 pending read** 的时候才走：消费方自己停着不读的时候，上游没吐
// 下一帧不是它安静，是没人要。默认的 highWaterMark（1）会预取一帧，于是停读
// 期间 `pull` 照样被叫着、计时照样走 —— 慢客户端被当成安静的上游砍掉，连已经
// 缓冲好的帧一起丢。
//
// 这条用例拿 withStreamIdle 包住的流当顶层消费方：在转发链路上量不到这件事
// （peekStream 与写帧循环一直在读，pending read 总是有的），量得到的是这道闸
// 自己的语义。
{
  const frames = Array.from({ length: 5 }, (_, i) => `data: f${i}\n\n`);
  let cancelled = false;
  // 上游的后续帧等消费方回来读：停读期间上游一句话不说（这是「慢客户端 +
  // 上游在想」那个组合），恢复读了立刻给。
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let sent = 0;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= frames.length) {
        controller.close();
        return;
      }
      if (sent >= 1) await released;
      controller.enqueue(encoder.encode(frames[sent++]));
    },
    cancel() {
      cancelled = true;
    },
  });

  const reader = withStreamIdle(source, "model=fake-model", IDLE_MS).getReader();
  const decoder = new TextDecoder();
  const got: string[] = [];
  let error: unknown = null;

  const first = await reader.read();
  if (!first.done && first.value) got.push(decoder.decode(first.value));

  // 消费方停 3× 上限：这段时间里没有 pending read，计时不该走。
  await sleep(3 * IDLE_MS);
  check("停着不读的时候上游没被取消", !cancelled, "上游在停读期间被取消了");

  release();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) got.push(decoder.decode(value));
    }
  } catch (e) {
    error = e;
  }

  check("全部帧都读到了", got.length === frames.length, `${got.length}/${frames.length} 帧`);
  check("没有超时", error === null, String((error as Error)?.message ?? error));
  check("上游没被取消", !cancelled, "上游被取消了");
}

/* ------------------------------------------------------------------ *
 * 3c. peek 阶段出错：头已经发出去了
 * ------------------------------------------------------------------ */

section("peek 阶段出错：一条 error 帧，不再多打一次上游");

// deliverOpenAIStream 在 peek 之前就发了头（sseHead）。peek 阶段抛出来的别的
// 错（不是「客户端走了」，也不是「上游安静了」）如果继续往外抛，路由层会以为
// 可以换个账号重来 —— 它换来的是第二次 sseHead（头已发过，
// ERR_HTTP_HEADERS_SENT），外加一次白打的上游（还在计费）。这里把路由层那一下
// 重试演一遍：只许打一次上游。
{
  let upstreamCalls = 0;
  let handlerError: string | null = null;
  let retriedError: string | null = null;
  let failure: unknown = null;
  const received: string[] = [];

  const server = http.createServer(async (_req, res) => {
    const ctx = { res, status: 200, respond: false } as any;
    // 路由层那一下：失败就换个账号重来（policy 做的事）。
    for (let attempt = 0; attempt < 2; attempt++) {
      upstreamCalls++;
      try {
        await deliverOpenAIStream(
          ctx,
          upstream([], { after: "raw" }),
          "openai",
          "fake-model",
          undefined,
          undefined,
          (e) => (failure = e),
        );
        return;
      } catch (e) {
        const said = (e as Error)?.message ?? String(e);
        if (attempt === 0) handlerError = said;
        else retriedError = said;
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  await new Promise<void>((resolve) => {
    const req = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST" }, (r) => {
      let buf = "";
      r.on("data", (c) => {
        buf += c.toString();
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          received.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      });
      r.on("end", resolve);
      r.on("close", resolve);
      r.on("error", resolve);
    });
    req.on("error", resolve);
    req.end("{}");
    setTimeout(resolve, 5_000);
  });
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const said = errorMessageOf(received);
  check("网关没有往外抛", handlerError === null, String(handlerError));
  check("只打了一次上游（没有换账号重来）", upstreamCalls === 1, `${upstreamCalls} 次，第二次：${retriedError}`);
  check("客户端收到了一条 error 帧", said === CLOSED_EARLY, said);
  check("报给调用方的还是上游那个错", failure instanceof TypeError, String(failure));
}

/* ------------------------------------------------------------------ *
 * 4. clientMessageOf 的判别力
 * ------------------------------------------------------------------ */

section("clientMessageOf：发给客户端的那句话");

{
  // Node fetch 内部的那句话：客户端看不懂，也不该看到。
  check("TypeError(\"terminated\") → 通用人话", clientMessageOf(new TypeError("terminated")) === CLOSED_EARLY);
  check(
    "fetch failed → 通用人话",
    clientMessageOf(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }) })) ===
      CLOSED_EARLY,
  );
  check(
    "cause 上的 UND_ERR_* → 通用人话",
    clientMessageOf(Object.assign(new Error("boom"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } })) === CLOSED_EARLY,
  );
  check("socket hang up → 通用人话", clientMessageOf(new Error("socket hang up")) === CLOSED_EARLY);
  // 我们自己的空闲超时：它那句话本来就是写给客户端的。
  const idle = new StreamIdleError(IDLE_MS, "model=fake-model");
  check("空闲超时 → 它自己那句", clientMessageOf(idle) === idle.message, clientMessageOf(idle));
  check("空闲超时那句里没有 terminated", !/terminated/i.test(idle.message), idle.message);
  check("空闲超时的 name 是 TimeoutError", idle.name === "TimeoutError", idle.name);
  // 别的错误：既有行为不变，原样发出去。
  check(
    "上游拒绝的话原样",
    clientMessageOf(new Error("upstream rejected the request")) === "upstream rejected the request",
  );
  check("空的 message 不会发出 undefined", clientMessageOf({}) === "upstream failed", clientMessageOf({}));

  // 抛出来的可以就是个字符串（`throw "socket hang up"`）：那时没有 message，
  // 按以前那样直接落到回落值就把原文丢了 —— 而原文往往是唯一的线索。
  check("抛字符串：内部字眼翻成人话", clientMessageOf("socket hang up") === CLOSED_EARLY, clientMessageOf("socket hang up"));
  check(
    "抛字符串：terminated 也翻",
    clientMessageOf("terminated") === CLOSED_EARLY,
    clientMessageOf("terminated"),
  );
  check("抛字符串：原文不是内部字眼就照发", clientMessageOf("quota exhausted") === "quota exhausted", clientMessageOf("quota exhausted"));

  // 空白不是一句话：`new Error("  ")` 不该让客户端收到一个空格。
  check("只有空白的 message → 回落值", clientMessageOf(new Error("   ")) === "upstream failed", `"${clientMessageOf(new Error("   "))}"`);
  check("只有空白的字符串 → 回落值", clientMessageOf("  ") === "upstream failed", `"${clientMessageOf("  ")}"`);
  check(
    "message 两边的空白不再发出去",
    clientMessageOf(new Error("  boom  ")) === "boom",
    `"${clientMessageOf(new Error("  boom  "))}"`,
  );
}

/* ------------------------------------------------------------------ *
 * 5. 生产默认值是 120 秒
 * ------------------------------------------------------------------ */

section("生产默认值是 120 秒");

// 这条测试的进程把上限调成了 150ms，所以默认值只能从模块导出的那个常量确认。
// 调错的默认值（比如忘了改回来）比没有还糟 —— 一条 thinking 的流会被砍在中间。
check("空闲上限的默认值是 120000ms", STREAM_IDLE_DEFAULT_MS === 120_000, String(STREAM_IDLE_DEFAULT_MS));

/* ------------------------------------------------------------------ *
 * 6. 空闲上限设成 0：闸关掉
 * ------------------------------------------------------------------ */

section("空闲上限设成 0：闸关掉");

// 0 是「关闸」：生产旋钮的契约，得钉住。上限在模块求值时读一次，所以只能换个
// 进程跑。同时钉住那句 warn：闸被关掉不能是悄悄的。
{
  const deliverUrl = new URL("../lib/router/deliver.ts", import.meta.url).href;
  const CHILD = `
const http = await import("node:http");
const { deliverOpenAIStream } = await import(process.env.DELIVER_URL);
let cancelled = false;
let failure = null;
let writes = 0;
let started = false;
// 一帧都不吐的上游：谁都不说话。
const body = new ReadableStream({
  async pull() { await new Promise(() => {}); },
  cancel() { cancelled = true; },
});
const server = http.default.createServer(async (_req, res) => {
  const ctx = { res, status: 200, respond: false };
  const write = res.write.bind(res);
  res.write = (chunk, ...rest) => { writes++; return write(chunk, ...rest); };
  started = true;
  await deliverOpenAIStream(ctx, body, "openai", "fake-model", undefined, undefined, (e) => { failure = e; });
});
await new Promise((resolve) => server.listen(0, resolve));
const client = http.default.request({ port: server.address().port, host: "127.0.0.1", path: "/", method: "POST" });
client.on("error", () => {});
client.end("{}");
while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
await new Promise((resolve) => setTimeout(resolve, 3 * ${IDLE_MS}));
console.log("CHILD " + JSON.stringify({ writes, cancelled, failure: failure ? String(failure.name) : null }));
server.closeAllConnections?.();
server.close();
process.exit(0);
`;

  const runChild = (idleMs: number) =>
    new Promise<{ report: any; stderr: string; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", CHILD], {
        env: { ...process.env, DELIVER_URL: deliverUrl, ROUTER_STREAM_IDLE_MS: String(idleMs), BUDDY_DATA_DIR: tmp },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.stderr.on("data", (c) => (err += c.toString()));
      child.on("close", (code) => {
        const line = out.split("\n").find((l) => l.startsWith("CHILD "));
        let report: any = null;
        if (line) {
          try {
            report = JSON.parse(line.slice("CHILD ".length));
          } catch {
            report = null;
          }
        }
        resolve({ report, stderr: err, code });
      });
      // 挂住的子进程不许把整条测试吊住。
      setTimeout(() => child.kill(), 20_000).unref?.();
    });

  const off = await runChild(0);
  check("子进程正常退出了", off.code === 0, `exit ${off.code}：${off.stderr.slice(0, 300)}`);
  check("一帧都没写（没有 error 帧）", off.report?.writes === 0, String(off.report?.writes));
  check("网关没有报超时", off.report?.failure === null, String(off.report?.failure));
  check("上游没被取消", off.report?.cancelled === false, String(off.report?.cancelled));
  check("关闸时打了一行 warn", off.stderr.includes("空闲上限被设成 0"), off.stderr.slice(0, 300));

  // 控制组：同一个子进程、同一个一帧都不吐的上游，上限改成 150ms —— 闸在的
  // 时候它就该报超时。没有这一组，上面那几张 ok 只能证明「什么都没发生」。
  const on = await runChild(IDLE_MS);
  check("控制组：上限是 150ms 时照旧报超时", on.report?.failure === "TimeoutError", String(on.report?.failure));
  check("控制组：客户端收到了一条 error 帧", on.report?.writes === 1, String(on.report?.writes));
  check("控制组：上游被取消了", on.report?.cancelled === true, String(on.report?.cancelled));
}

/* ------------------------------------------------------------------ */

clearTimeout(watchdog);
console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
