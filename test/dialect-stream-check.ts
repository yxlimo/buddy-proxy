// test/dialect-stream-check.ts — 上游发来 `data: null` 这一帧时，转换器不能崩。
//
//   node --experimental-strip-types test/dialect-stream-check.ts
//
// 离线：只测一个纯函数（`openaiStreamToAnthropic`），不起网关，不连任何上游。
//
// 那个 bug（线上 2026-10-28，一天 28 次）：上游偶尔发 `data: null` —— 流末尾
// 的哨兵，意思是「没有内容」。转换器第一行就是 `if (chunk.usage)`，`chunk`
// 为 null 时直接抛 TypeError，被 deliver 的 catch 包成
//
//   {"type":"error","error":{"type":"api_error","message":"Cannot read properties of null (reading 'usage')"}}
//
// 客户端看到的是一句话都收不到的断流。null 帧现在直接跳过。
//
// 覆盖：
//   1. 中间夹一个 null 帧 → 不抛，正文照常出来；
//   2. null 帧不吞掉 usage（末尾那帧的 token 数仍要记上）；
//   3. 只有 null 帧 → 不抛，结论是正常收尾（不是错误）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dialect-stream-"));
process.env.BUDDY_DATA_DIR = tmp;

const { openaiStreamToAnthropic } = await import("../lib/dialect/stream.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 把一组帧喂给转换器，返回它吐出来的每一帧。 */
async function frames(chunks: unknown[]): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of openaiStreamToAnthropic(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    "test-model",
  )) {
    out.push(String(frame));
  }
  return out;
}

console.log("");
console.log("中间夹一个 null 帧");

const mixed = await frames([
  { choices: [{ delta: { content: "hello" } }] },
  null,
  { choices: [{ delta: { content: " world" } }] },
]);
const joined = mixed.join("");
check("没有抛错", true);
check("正文照常出来", joined.includes("hello") && joined.includes(" world"), joined.slice(0, 200));
check("最后有 message_stop", joined.includes("message_stop"), joined.slice(-160));

console.log("");
console.log("null 帧不吞掉 usage");

const withUsage = await frames([
  { choices: [{ delta: { content: "hi" } }] },
  null,
  { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
]);
const usageFrame = withUsage.join("");
check("输入 token 记上了", usageFrame.includes('"input_tokens":7'), usageFrame.slice(-300));
check("输出 token 记上了", usageFrame.includes('"output_tokens":3'), usageFrame.slice(-300));

console.log("");
console.log("只有 null 帧");

const onlyNull = await frames([null, null]);
const nullJoined = onlyNull.join("");
check("没有抛错", true);
check("仍然正常收尾", nullJoined.includes("message_stop"), nullJoined.slice(-160));
check("没有 error 帧", !nullJoined.includes('"type":"error"'), nullJoined.slice(0, 200));

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
