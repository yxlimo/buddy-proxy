// test/peek-stream-check.ts — the first frame of an upstream answer.
//
//   node --experimental-strip-types test/peek-stream-check.ts
//
// 离线：只测一个纯函数，不起网关，不连任何上游。
//
// 那个 bug：peekStream 先 getReader() 锁住流，上游在正文里报错时又拿
// new Response(body) 把同一个流包了一次读，Node 直接抛
// "Response body object should not be disturbed or locked"，线上变成 500。
// 现在从同一个 reader 读完，并且靠解析（不是靠字符串）判断错误帧。
//
// 覆盖：
//   1. OpenAI 形状的错误帧 → 502，错误文案是上游那句；
//   2. Anthropic 形状的错误帧 → 502；
//   3. 正常的第一帧 → 不抛，字节与原始一致；
//   4. 正文里带引号的 "error" 字样 → 不抛（不再靠字符串判断）；
//   5. 空流 → 原样返回，不抛。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peek-stream-"));
process.env.BUDDY_DATA_DIR = tmp;

const { peekStream } = await import("../lib/router/deliver.ts");
const { AuthError } = await import("../lib/credential.ts");

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

const encoder = new TextEncoder();

/** A stream that hands out the given chunks and then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

/** Every byte a stream gives out, joined. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 1. OpenAI 形状的错误帧
 * ------------------------------------------------------------------ */

{
  const body = streamOf(['data: {"error":{"message":"boom"}}\n\n']);
  let caught: any = null;
  try {
    await peekStream(body);
  } catch (e) {
    caught = e;
  }
  check("上游在正文里报错 → 抛 AuthError", caught instanceof AuthError, String(caught));
  // 上游原话进 hint：分类读 message，客户端读 hint，两边都不能串。
  check("上游原话进了 hint", caught?.hint === "boom", String(caught?.hint));
  check("message 仍是通用那句", caught?.message === "upstream rejected the request", String(caught?.message));
  check("状态是 502", caught?.status === 502, String(caught?.status));
}

/* ------------------------------------------------------------------ *
 * 2. Anthropic 形状的错误帧
 * ------------------------------------------------------------------ */

{
  const body = streamOf(['data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n']);
  let caught: any = null;
  try {
    await peekStream(body);
  } catch (e) {
    caught = e;
  }
  check("Anthropic 的 error 帧 → 抛 AuthError", caught instanceof AuthError, String(caught));
  check("Anthropic 的原话进了 hint", String(caught?.hint ?? "").includes("overloaded"), String(caught?.hint));
  check("Anthropic 的错误状态是 502", caught?.status === 502, String(caught?.status));
}

/* ------------------------------------------------------------------ *
 * 3. 正常的第一帧 → 字节不变
 * ------------------------------------------------------------------ */

{
  const chunks = ['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', "data: [DONE]\n\n"];
  const body = streamOf(chunks);
  let out: ReadableStream<Uint8Array> | null = null;
  let error: unknown = null;
  try {
    out = await peekStream(body);
  } catch (e) {
    error = e;
  }
  check("正常的第一帧 → 不抛", error === null, String(error));
  const got = out ? await readAll(out) : new Uint8Array(0);
  const want = encoder.encode(chunks.join(""));
  check("正常的第一帧 → 字节与原始一致", sameBytes(got, want), `${got.length} vs ${want.length}`);
}

/* ------------------------------------------------------------------ *
 * 4. 正文里带引号的 "error" → 不误判
 * ------------------------------------------------------------------ */

{
  const body = streamOf(['data: {"choices":[{"delta":{"content":"use \\"error\\" here"}}]}\n\n']);
  let error: unknown = null;
  try {
    await peekStream(body);
  } catch (e) {
    error = e;
  }
  check("正文里的 \"error\" 字样 → 不当成失败", error === null, String(error));
}

/* ------------------------------------------------------------------ *
 * 5. 空流 → 原样返回
 * ------------------------------------------------------------------ */

{
  const body = streamOf([]);
  let out: ReadableStream<Uint8Array> | null = null;
  let error: unknown = null;
  try {
    out = await peekStream(body);
  } catch (e) {
    error = e;
  }
  check("空流 → 不抛", error === null, String(error));
  check("空流 → 原样返回", out === body);
}

/* ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
