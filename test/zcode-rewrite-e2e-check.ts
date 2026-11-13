// test/zcode-rewrite-e2e-check.ts — the `::code-comment{...}` rewrite, on the wire.
//
//   node --experimental-strip-types test/zcode-rewrite-e2e-check.ts
//
// Offline: the upstream is a server in this process, answering the four
// requests this test makes. No ZCode quota is spent.
//
// lib/zcode/rewrite.ts is checked on its own in test/zcode-rewrite-check.ts
// (the pure function, and its incremental form against every chunking). What
// is checked here is that the rewrite is actually *plugged in* — that a
// directive from the upstream reaches the agent as Markdown, whichever dialect
// the agent asked in and whichever way the answer arrives:
//
//   0. the wrapper itself: it ends, it stops the upstream when the client goes
//      away, and it hands a break in the upstream to the client as an error
//      instead of waiting forever — the three things a stream that never
//      finishes would break
//   1. streamed answer, agent speaking Anthropic (`/v1/messages`)
//   2. streamed answer, agent speaking OpenAI (`/v1/chat/completions`)
//   3. whole answer, both dialects
//   4. the order of frames: a held-back tail leaves *before* the
//      `content_block_stop` of the block it came from
//   5. everything that is not text — `thinking`, `tool_use.input` — comes out
//      byte for byte
//
// Groups 4 and 5 are the reason the fixture carries a directive *inside* the
// thinking block and inside the tool's input: a rewriter that reached into
// those would drop them, and the byte-for-byte comparison would say so. That
// is also why "no directive anywhere in the response" is not the assertion —
// the counted occurrences are: as many as the upstream put outside the text.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log("");
  console.log(name);
}

const show = (text: string) => JSON.stringify(text);

/* ------------------------------------------------------------------ *
 * The fixture: synthetic values, written the way the model writes them
 * ------------------------------------------------------------------ */

const DIRECTIVE =
  '::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." ' +
  'file="/path/to/foo.ts" start=10 end=11 priority=2}';

const INTRO = "Review of the change:\n\n";

/** A trailing partial opener: the streaming rewriter holds it, so there is a held tail to flush */
const TAIL = "\n\nAnything else? ::code-com";

/** What the upstream says */
const ANSWER_TEXT = INTRO + DIRECTIVE + TAIL;

/** What the agent has to read instead */
const BLOCK =
  "> **[P2] Off-by-one**\n>\n> Loop iterates past the end when length is 0.\n>\n> `foo.ts:10-11`";
const RENDERED = INTRO + BLOCK + TAIL;

/**
 * The thinking block, with a directive in it on purpose: thinking is the
 * upstream's own bytes, and a formatter that rewrote them would be corrupting
 * the model's reasoning
 */
const THINKING =
  'The caller wants a review. Keep the ::code-comment{title="not the answer" body="reasoning only"} form out of it.';

/** The tool call's input, also carrying a directive: `input` is not prose */
const TOOL_INPUT = {
  path: "/p/a.ts",
  note: '::code-comment{title="x" body="y"}',
  count: 2,
};
const TOOL_INPUT_JSON = JSON.stringify(TOOL_INPUT);

/**
 * The text deltas the upstream sends. The directive is cut in three, which is
 * what a real stream does: SSE splits wherever the network splits
 */
const TEXT_DELTAS = [
  `${INTRO}::code-com`,
  'ment{title="[P2] Off-by-one" body="Loop iterates',
  ' past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
  TAIL,
];

/** The tool input, cut in two the way `input_json_delta` delivers it */
const INPUT_DELTAS = [TOOL_INPUT_JSON.slice(0, 24), TOOL_INPUT_JSON.slice(24)];

/**
 * The thinking, cut in two as well — and the cut is load-bearing: section 5
 * compares the client's pieces to these, one by one, because two deltas merged
 * into one concatenate to the same text and would go unnoticed
 */
const THINKING_DELTAS = [THINKING.slice(0, 40), THINKING.slice(40)];

const USAGE = { input_tokens: 11, output_tokens: 37 };

/* ------------------------------------------------------------------ *
 * The fake upstream
 * ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every request the gateway made, for the "it really went upstream" assertions */
const seen: { path: string; body: any }[] = [];

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Write `text` in `pieces` pieces, a millisecond apart.
 *
 * The whole point of the streaming rewriter is that it survives frames cut
 * anywhere, so the fixture must not hand them over in one piece: every write
 * is a separate chunk on the gateway's side
 */
async function writeSplit(res: http.ServerResponse, text: string, pieces = 2): Promise<void> {
  const size = Math.ceil(text.length / pieces);
  for (let at = 0; at < text.length; at += size) {
    res.write(text.slice(at, at + size));
    await sleep(1);
  }
}

/** The answer's blocks, in the order the model emits them */
function blocksOf(withTools: boolean): any[] {
  const blocks: any[] = [{ type: "thinking", thinking: THINKING }];
  blocks.push({ type: "text", text: ANSWER_TEXT });
  if (withTools) blocks.push({ type: "tool_use", id: "toolu_fake_zcode_1", name: "read", input: TOOL_INPUT });
  return blocks;
}

/** The streamed answer, as Anthropic SSE frames */
async function writeStream(res: http.ServerResponse, withTools: boolean): Promise<void> {
  let index = 0;
  await writeSplit(
    res,
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake_zcode",
        type: "message",
        role: "assistant",
        model: "glm-5.3-flash",
        content: [],
        stop_reason: null,
        usage: { input_tokens: USAGE.input_tokens, output_tokens: 0 },
      },
    }),
  );

  // thinking
  await writeSplit(res, frame("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
  for (const piece of THINKING_DELTAS) {
    await writeSplit(
      res,
      frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: piece },
      }),
    );
  }
  await writeSplit(res, frame("content_block_stop", { type: "content_block_stop", index }));
  index++;

  // text: the directive, cut in three
  await writeSplit(res, frame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
  for (const piece of TEXT_DELTAS) {
    await writeSplit(
      res,
      frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }),
      3,
    );
  }
  await writeSplit(res, frame("content_block_stop", { type: "content_block_stop", index }));
  index++;

  // tool_use: the input is JSON in pieces, never prose
  if (withTools) {
    await writeSplit(
      res,
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: "toolu_fake_zcode_1", name: "read", input: {} },
      }),
    );
    for (const piece of INPUT_DELTAS) {
      await writeSplit(
        res,
        frame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: piece },
        }),
      );
    }
    await writeSplit(res, frame("content_block_stop", { type: "content_block_stop", index }));
  }

  await writeSplit(
    res,
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: withTools ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: USAGE.output_tokens },
    }),
  );
  await writeSplit(res, frame("message_stop", { type: "message_stop" }));
  res.end();
}

const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any = null;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    body = null;
  }
  seen.push({ path: req.url ?? "", body });

  // The model calls a tool when it is offered one — that is how the tool_use
  // block gets into the answer without a second fixture
  const withTools = Array.isArray(body?.tools) && body.tools.length > 0;

  if (body?.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    await writeStream(res, withTools);
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_fake_zcode",
      type: "message",
      role: "assistant",
      model: String(body?.model ?? ""),
      content: blocksOf(withTools),
      stop_reason: withTools ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: USAGE,
    }),
  );
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

// The gateway reads its data directory and the ZCode base at import time, so
// both are set before anything under lib/ is loaded (same reason as
// test/zcode-headers-check.ts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-rewrite-e2e-"));
process.env.BUDDY_DATA_DIR = tmp;
process.env.ZCODE_BASE_URL = upstreamBase;
process.env.BENEFITS_DISABLED = "1";
process.env.PERIODIC_ENABLED = "false";

const { app } = await import("../lib/router/app.ts");
const { store } = await import("../lib/store.ts");
const { addAccount } = await import("../lib/providers.ts");
const { saveSession } = await import("../lib/zcode/auth.ts");
const { rewriteAnswerStream } = await import("../lib/zcode/rewrite-answer.ts");
const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");
const { platformAvailability } = await import("../lib/admin/platform-state.ts");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/* ------------------------------------------------------------------ *
 * The platform, the account, the published model
 * ------------------------------------------------------------------ */

section("准备：一个 ZCode 账号、一个发布模型");

// ZCode 的平台行在目录里是 `hidden` 的那一条（lib/platform-catalog.ts），启动时不
// 播种 —— 所以这一趟自己造一行，与面板上建一行等价。ZCode 是模拟客户端那一族：
// kind 必须还是 `zcode`（厂商 kind 迁移只波及那五家），地址指向假上游。
{
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO platform (id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES ('zcode', 'zcode', ?, '[]', 0, '', 'zcode', '', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, kind = 'zcode', updated_at = excluded.updated_at",
    )
    .run(upstreamBase, now, now);
}

const account = addAccount({ platform: "zcode", alias: "测试账号" });
const accountId = account.id ?? "";
check("ZCode 账号加得起来", account.ok === true && accountId !== "", account.message);

saveSession(
  {
    token: "jwt-TESTONLY-zcode-session", // privacy:allow — 编造的样例
    provider: "zai",
    deviceId: "11111111-2222-3333-4444-555555555555",
    generation: 1,
    loginAtMs: Date.now(),
    expiresAtMs: Date.now() + 365 * 24 * 3600 * 1000,
  },
  accountId,
);
check("平台就绪（凭据读得到）", platformAvailability("zcode").state === "ready", platformAvailability("zcode").state);

const PUBLISHED = "zcode-rewrite-fake";
saveAggregateModel({
  id: PUBLISHED,
  displayName: PUBLISHED,
  strategy: "single",
  targets: [{ group: "zcode", upstreamModel: "GLM-5.3-Flash", weight: 1, position: 0, enabled: true }],
});
reloadAggregate();

interface Answer {
  status: number;
  text: string;
  json: any;
}

async function post(path: string, body: unknown): Promise<Answer> {
  // A request that never answers has to end up a red line, not a test that
  // hangs: the answer is streamed, so "no answer" and "the stream never
  // finishes" look the same from here
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* SSE */
    }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: `请求没有回完：${(e as Error).message}`, json: null };
  }
}

/** One SSE frame of the client's answer */
interface Frame {
  event: string;
  data: string;
}

/** The client's answer as frames, in the order it read them */
function framesOf(text: string): Frame[] {
  const out: Frame[] = [];
  for (const block of text.split("\n\n")) {
    let event = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event || data.length) out.push({ event, data: data.join("\n") });
  }
  return out;
}

/** The parsed payload of every data-carrying frame */
function payloadsOf(frames: Frame[]): any[] {
  const out: any[] = [];
  for (const item of frames) {
    if (!item?.data || !item.data.startsWith("{")) continue;
    try {
      out.push(JSON.parse(item.data));
    } catch {
      /* not JSON: not ours */
    }
  }
  return out;
}

/** Concatenate the `text_delta` texts of an Anthropic answer, in arrival order */
function textOf(payloads: any[]): string {
  let text = "";
  for (const payload of payloads) {
    if (payload?.type === "content_block_delta" && payload?.delta?.type === "text_delta") {
      text += String(payload.delta.text ?? "");
    }
  }
  return text;
}

/** Concatenate the deltas of one block, by their own field */
function blockDeltas(payloads: any[], type: string, field: string, index: number): string {
  let text = "";
  for (const payload of payloads) {
    if (payload?.type !== "content_block_delta" || payload?.index !== index) continue;
    if (payload?.delta?.type !== type) continue;
    text += String(payload.delta?.[field] ?? "");
  }
  return text;
}

const OCCURRENCES_IN_FIXTURE =
  THINKING.split("::code-comment").length - 1 + TOOL_INPUT_JSON.split("::code-comment").length - 1;

const occurrences = (text: string) => text.split("::code-comment").length - 1;

/**
 * Every field of an Anthropic answer that carries text, concatenated.
 *
 * "How many directives survived" is a question about what the client reads, not
 * about the bytes on the wire: the upstream splits a directive across two
 * frames, so `::co` and `de-comment{...}` sit in two different payloads and a
 * search over the serialised stream finds neither. Takes whole message bodies
 * too, so the buffered answer is counted by the same code
 * (`lib/zcode/rewrite-answer.ts` must leave thinking and tool input alone).
 */
function anthropicCarried(payloads: any[]): string {
  let carried = "";
  for (const payload of payloads) {
    if (Array.isArray(payload?.content)) {
      for (const block of payload.content) {
        if (typeof block?.text === "string") carried += block.text;
        if (typeof block?.thinking === "string") carried += block.thinking;
        // `input` is an object in a buffered answer, and its JSON on the wire
        if (block?.input !== undefined) carried += JSON.stringify(block.input);
      }
    }
    const delta = payload?.delta;
    if (delta?.type === "text_delta") carried += String(delta.text ?? "");
    if (delta?.type === "thinking_delta") carried += String(delta.thinking ?? "");
    if (delta?.type === "input_json_delta") carried += String(delta.partial_json ?? "");
  }
  return carried;
}

/** The same, for an OpenAI answer: a buffered message and a streamed delta are one shape */
function openaiCarried(payloads: any[]): string {
  let carried = "";
  for (const payload of payloads) {
    const choice = payload?.choices?.[0];
    const part = choice?.delta ?? choice?.message;
    if (!part) continue;
    if (typeof part.content === "string") carried += part.content;
    if (typeof part.reasoning_content === "string") carried += part.reasoning_content;
    for (const call of Array.isArray(part.tool_calls) ? part.tool_calls : []) {
      if (typeof call?.function?.arguments === "string") carried += call.function.arguments;
    }
  }
  return carried;
}

/* ------------------------------------------------------------------ *
 * 0. the wrapper itself
 * ------------------------------------------------------------------ */

section("0. 包装流自己会结束，客户端走了就停上游");

/** A stream that hands out `pieces` one read at a time, and records a cancel */
function memoryStream(pieces: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= pieces.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(pieces[at++]));
    },
    cancel() {
      onCancel?.();
    },
  });
}

/**
 * Read a stream to its end, or give up after `ms`.
 *
 * The wrapper holds text back while it could still become a directive, so a
 * bug there shows up as an answer that never ends. That has to be a red line
 * here rather than a test that never returns.
 */
async function readWithTimeout(
  stream: ReadableStream<Uint8Array>,
  ms: number,
): Promise<{ text: string; timedOut: boolean; elapsed: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const started = Date.now();
  const deadline = started + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { text, timedOut: true, elapsed: Date.now() - started };
    const wait = await Promise.race([
      reader.read(),
      sleep(left).then(() => "timeout" as const),
    ]);
    if ((wait as string) === "timeout") return { text, timedOut: true, elapsed: Date.now() - started };
    const result = wait as ReadableStreamReadResult<Uint8Array>;
    if (result.done) return { text, timedOut: false, elapsed: Date.now() - started };
    text += decoder.decode(result.value, { stream: true });
  }
}

/**
 * One read, as an outcome instead of a throw.
 *
 * "Did not settle" has to be an outcome here: a wrapper that stops answering but
 * never ends looks exactly like a test that hangs, and that is the failure this
 * whole section exists to catch
 */
async function readOutcome(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<{ kind: "chunk"; text: string } | { kind: "done" } | { kind: "error"; message: string } | { kind: "hang" }> {
  const decoder = new TextDecoder();
  return Promise.race([
    reader.read().then(
      (result) =>
        result.done
          ? ({ kind: "done" } as const)
          : ({ kind: "chunk", text: decoder.decode(result.value, { stream: true }) } as const),
      (e: unknown) => ({ kind: "error", message: (e as Error)?.message ?? String(e) }) as const,
    ),
    sleep(ms).then(() => ({ kind: "hang" }) as const),
  ]);
}

/**
 * A stream that hands out one piece and then keeps the connection open.
 *
 * This is what the upstream looks like partway through an answer: more is
 * coming, so nothing here ends on its own — the cancel carried down to this
 * reader is the only thing that can stop it
 */
function stalledStream(piece: string, onCancel: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => {});
      sent = true;
      controller.enqueue(encoder.encode(piece));
    },
    cancel() {
      onCancel();
    },
  });
}

/** A stream that hands out one piece and then breaks, the way a dropped socket does */
function breakingStream(piece: string, message: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) throw new Error(message);
      sent = true;
      controller.enqueue(encoder.encode(piece));
    },
  });
}

{
  // The same answer, in one piece: message_start, one text block whose
  // directive is cut in two, a held tail that never becomes a directive, the
  // stop, the end of the message — and then the upstream just ends
  const pieces = [
    frame("message_start", { type: "message_start", message: { id: "msg_mem", type: "message", role: "assistant", model: "glm-5.3-flash", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${INTRO}::code-com` } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'ment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}' } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TAIL } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_stop", { type: "message_stop" }),
  ];
  const read = await readWithTimeout(rewriteAnswerStream(memoryStream(pieces)), 1500);
  check("上游结束后流会结束（不是一直挂着）", !read.timedOut, `${read.elapsed}ms 还没完`);
  check("1.5 秒内结束", !read.timedOut && read.elapsed < 1500, `${read.elapsed}ms`);

  const payloads = payloadsOf(framesOf(read.text));
  check("正文是渲染后的 Markdown", textOf(payloads) === RENDERED, `want ${show(RENDERED)}\n     got  ${show(textOf(payloads))}`);

  const stopAt = payloads.findIndex((payload) => payload?.type === "content_block_stop");
  const tailAt = payloads.findIndex(
    (payload) =>
      payload?.type === "content_block_delta" &&
      payload?.delta?.type === "text_delta" &&
      String(payload.delta.text ?? "").endsWith("::code-com"),
  );
  check("扣住的尾巴交出来了", tailAt >= 0, `tail ${tailAt}`);
  check("尾巴在 content_block_stop 之前", tailAt >= 0 && stopAt >= 0 && tailAt < stopAt, `tail ${tailAt}, stop ${stopAt}`);

  // The answer is the last thing out: the residual delta must not come after the
  // frame that closes the block, and nothing may follow the end of the message
  const last = payloads[payloads.length - 1];
  check("最后一帧是 message_stop", last?.type === "message_stop", String(last?.type));

  // The whole order in one line: the held tail is text, so it leaves before the
  // stop of the block it belongs to, then the end of the message, and only then
  // the end of the stream — a client that reads `done` before the tail arrived
  // has lost the tail
  const order = [
    tailAt >= 0 ? "tail" : "no-tail",
    stopAt >= 0 ? "stop" : "no-stop",
    last?.type === "message_stop" ? "end" : String(last?.type),
    read.timedOut ? "hung" : "done",
  ].join(" -> ");
  check("顺序：残留 delta -> content_block_stop -> message_stop -> 流结束", order === "tail -> stop -> end -> done", order);
}

{
  // The client went away while the upstream was still writing. The answer is not
  // finished, so nothing ends the wrapper on its own: the cancel being carried
  // down to the upstream's reader is the only thing that stops the tokens being
  // counted for nobody
  let cancelled = false;
  const stream = rewriteAnswerStream(
    stalledStream(
      frame("message_start", {
        type: "message_start",
        message: { id: "x", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: {} },
      }),
      () => {
        cancelled = true;
      },
    ),
  );
  const reader = stream.getReader();
  const head = await readOutcome(reader, 500);
  check("上游先给了一帧", head.kind === "chunk", head.kind);
  await reader.cancel("the client went away");
  await sleep(50);
  check("客户端取消 -> 上游的 reader 也取消", cancelled, String(cancelled));
  const afterCancel = await readOutcome(reader, 500);
  check("取消之后不再有帧、也不挂住", afterCancel.kind === "done" || afterCancel.kind === "error", afterCancel.kind);
}

{
  // The upstream breaks mid-answer. The client has to be told, once, and the
  // stream has to be finished: a stream that neither yields nor ends is a client
  // that waits for an answer that is never coming
  const stream = rewriteAnswerStream(
    breakingStream(
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an answer" } }),
      "upstream socket reset",
    ),
  );
  const reader = stream.getReader();
  const head = await readOutcome(reader, 500);
  check("断开之前的那一帧交出来了", head.kind === "chunk" && head.text.includes("half an answer"), head.kind);
  const broke = await readOutcome(reader, 500);
  check(
    "上游中途抛错 -> 下游收到 error",
    broke.kind === "error" && broke.message.includes("upstream socket reset"),
    broke.kind === "error" ? broke.message : broke.kind,
  );
  const afterBreak = await readOutcome(reader, 500);
  check("error 只此一次、之后不再挂住", afterBreak.kind === "error" || afterBreak.kind === "done", afterBreak.kind);
}

{
  // A failure on *our* side: the read came back, so the upstream is alive and
  // still writing — it is this file's own work (here the decoder) that throws.
  // The client hearing about it is not enough of an assertion: without a cancel
  // the upstream sits there being billed for an answer nobody will ever read
  let cancelled = 0;
  const encoder = new TextEncoder();
  let reads = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads === 1) {
        controller.enqueue(
          encoder.encode(
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an answer" } }),
          ),
        );
        return;
      }
      // Not bytes at all: the read succeeds and everything after it is ours
      controller.enqueue("not bytes" as unknown as Uint8Array);
    },
    cancel() {
      cancelled++;
    },
  });
  const reader = rewriteAnswerStream(upstream).getReader();
  const head = await readOutcome(reader, 500);
  check("我们这侧抛错之前的帧照常交出来", head.kind === "chunk" && head.text.includes("half an answer"), head.kind);
  const failure = await readOutcome(reader, 500);
  // The value, not the wording: the message has to name what the throw was handed
  check(
    "我们这侧抛错 -> 下游收到 error",
    failure.kind === "error" && failure.message.includes("not bytes"),
    failure.kind === "error" ? failure.message : failure.kind,
  );
  await sleep(50);
  check("我们这侧抛错 -> 上游的 reader 被取消一次", cancelled === 1, `cancel 调用了 ${cancelled} 次`);
  const afterFailure = await readOutcome(reader, 500);
  check("抛错之后不再有帧、也不挂住", afterFailure.kind === "error" || afterFailure.kind === "done", afterFailure.kind);
}

/* ------------------------------------------------------------------ *
 * 1. streamed answer, the agent speaking Anthropic
 * ------------------------------------------------------------------ */

section("1. 流式 /v1/messages");

let anthropicFrames: Frame[] = [];
let anthropicPayloads: any[] = [];

{
  const answer = await post("/v1/messages", {
    model: PUBLISHED,
    max_tokens: 512,
    stream: true,
    tools: [{ name: "read", description: "", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "review this" }],
  });
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check("是 SSE", /^event: /m.test(answer.text), answer.text.slice(0, 200));
  check("上游收到的是流式请求", seen[seen.length - 1]?.body?.stream === true, String(seen[seen.length - 1]?.body?.stream));

  anthropicFrames = framesOf(answer.text);
  anthropicPayloads = payloadsOf(anthropicFrames);
  const text = textOf(anthropicPayloads);

  check("正文是渲染后的 Markdown", text === RENDERED, `want ${show(RENDERED)}\n     got  ${show(text)}`);
  check("正文里有块引用", text.includes(BLOCK), show(text));
  check("正文里没有指令原文", !text.includes("::code-comment"), show(text));
  // How many directives are left is counted over what the client reads, joined
  // back into one string: the upstream splits a directive across two frames, so
  // the serialised stream carries `::co` and `de-comment{...}` apart
  const carried = anthropicCarried(anthropicPayloads);
  check(
    "答复里剩下的指令只在上游放的那两处（思考块与工具入参）",
    occurrences(carried) === OCCURRENCES_IN_FIXTURE,
    `${occurrences(carried)} ≠ ${OCCURRENCES_IN_FIXTURE}`,
  );
  check("流里有收尾", answer.text.includes("message_stop"), answer.text.slice(-200));
}

/* ------------------------------------------------------------------ *
 * 2. streamed answer, the agent speaking OpenAI
 * ------------------------------------------------------------------ */

section("2. 流式 /v1/chat/completions");

{
  const answer = await post("/v1/chat/completions", {
    model: PUBLISHED,
    stream: true,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "review this" }],
  });
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check("是 SSE", /^data: /m.test(answer.text), answer.text.slice(0, 200));
  check("最后有 [DONE]", answer.text.trimEnd().endsWith("data: [DONE]"), answer.text.slice(-200));

  const payloads = payloadsOf(framesOf(answer.text));
  const content = payloads
    .map((payload) => (typeof payload?.choices?.[0]?.delta?.content === "string" ? payload.choices[0].delta.content : ""))
    .join("");
  check("正文是渲染后的 Markdown", content === RENDERED, `want ${show(RENDERED)}\n     got  ${show(content)}`);
  check("正文里没有指令原文", !content.includes("::code-comment"), show(content));

  const reasoning = payloads
    .map((payload) => (typeof payload?.choices?.[0]?.delta?.reasoning_content === "string" ? payload.choices[0].delta.reasoning_content : ""))
    .join("");
  check("思考原样过去", reasoning === THINKING, show(reasoning));

  const args = payloads
    .map((payload) => {
      const call = payload?.choices?.[0]?.delta?.tool_calls?.[0];
      return typeof call?.function?.arguments === "string" ? call.function.arguments : "";
    })
    .join("");
  check("工具入参逐字节没变", args === TOOL_INPUT_JSON, show(args));

  const carried = openaiCarried(payloads);
  check(
    "答复里剩下的指令只在上游放的那两处（思考块与工具入参）",
    occurrences(carried) === OCCURRENCES_IN_FIXTURE,
    `${occurrences(carried)} ≠ ${OCCURRENCES_IN_FIXTURE}`,
  );
}

/* ------------------------------------------------------------------ *
 * 3. the whole answer, both dialects
 * ------------------------------------------------------------------ */

section("3. 非流式");

{
  // Anthropic: the answer carries the tool_use block, so `input` is there to check
  const answer = await post("/v1/messages", {
    model: PUBLISHED,
    max_tokens: 512,
    tools: [{ name: "read", description: "", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "review this" }],
  });
  check("Anthropic：请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  const content: any[] = Array.isArray(answer.json?.content) ? answer.json.content : [];
  const text = content.find((block) => block?.type === "text")?.text ?? "";
  check("Anthropic：正文是渲染后的 Markdown", text === RENDERED, `want ${show(RENDERED)}\n     got  ${show(text)}`);
  check("Anthropic：正文里没有指令原文", !text.includes("::code-comment"), show(text));
  const thinking = content.find((block) => block?.type === "thinking")?.thinking ?? "";
  check("Anthropic：思考原样过去", thinking === THINKING, show(thinking));
  const tool = content.find((block) => block?.type === "tool_use");
  check(
    "Anthropic：工具入参逐字节没变",
    JSON.stringify(tool?.input) === TOOL_INPUT_JSON,
    show(JSON.stringify(tool?.input)),
  );
  const carried = anthropicCarried([answer.json]);
  check(
    "Anthropic：答复里剩下的指令只在上游放的那两处",
    occurrences(carried) === OCCURRENCES_IN_FIXTURE,
    `${occurrences(carried)} ≠ ${OCCURRENCES_IN_FIXTURE}`,
  );
}

{
  // OpenAI, without tools: no tool call, so the answer's text is the message's
  // content (a message with tool calls carries `content: null` — the text
  // would be gone from the answer, and this check would prove nothing)
  const answer = await post("/v1/chat/completions", {
    model: PUBLISHED,
    messages: [{ role: "user", content: "review this" }],
  });
  check("OpenAI：请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  const message = answer.json?.choices?.[0]?.message;
  check("OpenAI：正文是渲染后的 Markdown", message?.content === RENDERED, `want ${show(RENDERED)}\n     got  ${show(String(message?.content))}`);
  check("OpenAI：正文里没有指令原文", !String(message?.content ?? "").includes("::code-comment"), show(String(message?.content)));
  check("OpenAI：思考原样过去", message?.reasoning_content === THINKING, show(String(message?.reasoning_content)));
  // No tools were offered, so the only directive left is the one in the
  // thinking block
  const carried = openaiCarried([answer.json]);
  const expected = THINKING.split("::code-comment").length - 1;
  check(
    "OpenAI：答复里剩下的指令只在上游放的那一处（思考块）",
    occurrences(carried) === expected,
    `${occurrences(carried)} ≠ ${expected}`,
  );
}

/* ------------------------------------------------------------------ *
 * 4. the frames' order
 * ------------------------------------------------------------------ */

section("4. 残留的尾巴在 content_block_stop 之前");

{
  // The upstream cut the answer off in the middle of an opener that never
  // became a directive, so the rewriter still holds `::code-com`. That tail
  // belongs to the text block: a delta after the block's stop arrives at a
  // client that has already closed the block
  const frames = anthropicFrames;
  /** The payload of one frame, or undefined when there is no such frame */
  const payloadOf = (item: Frame | undefined): any => (item ? payloadsOf([item])[0] : undefined);
  const stop = frames.findIndex((item) => {
    const parsed = payloadOf(item);
    return parsed?.type === "content_block_stop" && parsed?.index === 1;
  });
  const tail = frames.findIndex((item) => {
    const parsed = payloadOf(item);
    return (
      parsed?.type === "content_block_delta" &&
      parsed?.delta?.type === "text_delta" &&
      String(parsed.delta.text ?? "").includes("::code-com") &&
      !String(parsed.delta.text ?? "").includes("::code-comment")
    );
  });
  check("有一个只带残留尾巴的帧（增量器确实扣住了东西）", tail >= 0, `tail ${tail}`);
  check("找到了文本块的 content_block_stop", stop >= 0, `stop ${stop}`);
  check("残留尾巴在 content_block_stop 之前", tail >= 0 && stop >= 0 && tail < stop, `tail ${tail}, stop ${stop}`);
  check(
    "尾巴就是上游那半个开头",
    String(payloadOf(frames[tail])?.delta?.text ?? "").endsWith("::code-com"),
    show(String(payloadOf(frames[tail])?.delta?.text ?? "")),
  );
  check(
    "尾巴之后、文本块结束之前没有别的 delta 越过它",
    stop >= 0 && !frames.some((item, at) => {
      const parsed = payloadOf(item);
      return (
        at > stop &&
        parsed?.type === "content_block_delta" &&
        parsed?.delta?.type === "text_delta" &&
        parsed?.index === 1
      );
    }),
    "文本块 stop 之后还有 text_delta",
  );
}

/* ------------------------------------------------------------------ *
 * 5. what is not text comes out byte for byte
 * ------------------------------------------------------------------ */

section("5. 非文本块逐字节");

{
  const thinking = blockDeltas(anthropicPayloads, "thinking_delta", "thinking", 0);
  check("思考块逐字节没变（里面那个指令还在原处）", thinking === THINKING, show(thinking));

  // Segmentation is what gets lost without the bytes being lost: a wrapper that
  // merged two deltas, or re-split one, still concatenates to the same text — so
  // the pieces are compared as pieces, in order, boundaries included. Upstream
  // sent THINKING_DELTAS; the client has to be holding the same ones
  const thinkingPieces = anthropicPayloads
    .filter(
      (payload) =>
        payload?.type === "content_block_delta" &&
        payload?.index === 0 &&
        payload?.delta?.type === "thinking_delta",
    )
    .map((payload) => String(payload.delta.thinking ?? ""));
  check(
    `思考块的分段与上游一致（${THINKING_DELTAS.length} 段、边界相同）`,
    thinkingPieces.length === THINKING_DELTAS.length &&
      thinkingPieces.every((piece, at) => piece === THINKING_DELTAS[at]),
    `上游 ${JSON.stringify(THINKING_DELTAS)}，客户端 ${JSON.stringify(thinkingPieces)}`,
  );

  const input = blockDeltas(anthropicPayloads, "input_json_delta", "partial_json", 2);
  check("工具入参逐字节没变", input === TOOL_INPUT_JSON, show(input));
  check("工具入参还是合法的 JSON", (() => {
    try {
      return JSON.stringify(JSON.parse(input)) === TOOL_INPUT_JSON;
    } catch {
      return false;
    }
  })(), show(input));

  // The one thing that must not change: a tool call whose arguments were
  // reformatted is a tool call that fails at the far end
  check(
    "工具调用的名字与 id 没有被动过",
    anthropicPayloads.some(
      (payload) => payload?.type === "content_block_start" && payload?.content_block?.type === "tool_use" && payload.content_block.name === "read" && payload.content_block.id === "toolu_fake_zcode_1",
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log("");
if (fail) {
  console.log(`FAIL ${fail} 项`);
  for (const problem of problems) console.log(`  - ${problem}`);
} else {
  console.log(`全部通过（${pass} 项）`);
}
server.close();
upstream.close();
process.exit(fail ? 1 : 0);
