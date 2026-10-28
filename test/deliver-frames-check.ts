// test/deliver-frames-check.ts — the message_start frame the client can read.
//
//   node --experimental-strip-types test/deliver-frames-check.ts
//
// 离线：只测一个纯函数，不起网关，不连任何上游。
//
// 那个 bug：上游发的 message_start 里 message 是 null，我们原样转给客户端，
// 客户端读 message.usage 就崩了（Cannot read properties of null），整条答复
// 收不到。message_start 缺 message 时补一个最小对象。
//
// 覆盖：
//   1. message 是对象 → 只改 model，其它字段原样；
//   2. message 是 null → 补一个最小对象（model 对、usage 是 0）；
//   3. message 缺失 → 同上；
//   4. 正常的 message 不会被补（content 不被清空、usage 不被抹掉）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deliver-frames-"));
process.env.BUDDY_DATA_DIR = tmp;

const { repairMessageStart } = await import("../lib/router/deliver.ts");

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

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 1. message 是对象：只改 model
 * ------------------------------------------------------------------ */

section("message 是对象：只改 model");

const original = {
  type: "message_start",
  message: {
    id: "msg_original",
    type: "message",
    role: "assistant",
    model: "upstream-model-name",
    content: [{ type: "text", text: "hi" }],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  },
};

const kept = repairMessageStart(structuredClone(original), "client-model-name");

check("没有补对象", kept.repaired === false, String(kept.repaired));
check("model 换成客户端问的那个", kept.json.message.model === "client-model-name", String(kept.json.message?.model));
check("usage 原样", kept.json.message.usage.input_tokens === 7 && kept.json.message.usage.output_tokens === 3);
check("content 没被清空", Array.isArray(kept.json.message.content) && kept.json.message.content.length === 1);
check("id 原样", kept.json.message.id === "msg_original", String(kept.json.message?.id));

/* ------------------------------------------------------------------ *
 * 2. message 是 null：补一个最小对象
 * ------------------------------------------------------------------ */

section("message 是 null：补一个最小对象");

const nulled = repairMessageStart({ type: "message_start", message: null }, "client-model-name");

check("补了对象", nulled.repaired === true, String(nulled.repaired));
check("message 是对象", !!nulled.json.message && typeof nulled.json.message === "object");
check("model 是客户端问的那个", nulled.json.message?.model === "client-model-name", String(nulled.json.message?.model));
check("usage.input_tokens 是 0", nulled.json.message?.usage?.input_tokens === 0, String(nulled.json.message?.usage?.input_tokens));
check("usage.output_tokens 是 0", nulled.json.message?.usage?.output_tokens === 0, String(nulled.json.message?.usage?.output_tokens));
check("content 是空数组", Array.isArray(nulled.json.message?.content) && nulled.json.message.content.length === 0);
check("id 像 msg_", String(nulled.json.message?.id ?? "").startsWith("msg_"), String(nulled.json.message?.id));

/* ------------------------------------------------------------------ *
 * 3. message 缺失：同上
 * ------------------------------------------------------------------ */

section("message 缺失：补一个最小对象");

const missing = repairMessageStart({ type: "message_start" }, "client-model-name");

check("补了对象", missing.repaired === true, String(missing.repaired));
check("message 是对象", !!missing.json.message && typeof missing.json.message === "object");
check("model 是客户端问的那个", missing.json.message?.model === "client-model-name", String(missing.json.message?.model));
check("usage.input_tokens 是 0", missing.json.message?.usage?.input_tokens === 0, String(missing.json.message?.usage?.input_tokens));

/* ------------------------------------------------------------------ *
 * 4. 不是对象的东西不动它
 * ------------------------------------------------------------------ */

section("别的东西不动它");

const notJson = repairMessageStart("hello", "client-model-name");
check("不是对象就不补", notJson.repaired === false && notJson.json === "hello");

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
