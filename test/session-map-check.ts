// test/session-map-check.ts — 客户端会话 id → 上游会话 id 的映射。
//
//   node --experimental-strip-types test/session-map-check.ts
//
// 离线：不问任何平台。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-map-"));

const { upstreamSessionId, clearUpstreamSessionCache } = await import("../lib/upstream-session.ts");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (ok) pass++;
  else fail++;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

console.log("");
console.log("同一个客户端会话，永远是同一个上游会话 id");

{
  const first = upstreamSessionId("zcode", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  const second = upstreamSessionId("zcode", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  check("两次一样", first === second, `${first} vs ${second}`);
  check("是 UUID v4（跟官方同一种）", UUID.test(first), first);
}

console.log("");
console.log("不同客户端会话，不同 id");

{
  const pi = upstreamSessionId("zcode", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  const opencode = upstreamSessionId("zcode", "ses_e8a2b5f99ffesMOpvn7P21If0L");
  check("不一样", pi !== opencode, `${pi} vs ${opencode}`);
  check("opencode 那个也是 UUID 形状", UUID.test(opencode), opencode);
  // 客户端给什么形状都不重要：映射过去都是 UUID。
  const weird = upstreamSessionId("zcode", "not-a-uuid-at-all");
  check("乱七八糟的也映射成 UUID", UUID.test(weird), weird);
}

console.log("");
console.log("缓存不是真的来源：清掉缓存，库里还在");

{
  const before = upstreamSessionId("zcode", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  clearUpstreamSessionCache();
  const after = upstreamSessionId("zcode", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  check("清缓存之后还是同一个", before === after, `${before} vs ${after}`);
}

console.log("");
console.log("不同的上游，各算各的");

{
  const zcode = upstreamSessionId("zcode", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  const other = upstreamSessionId("other-upstream", "01a14f0d-82b6-776d-b410-1e5b2fb4a79f");
  check("不同上游不同 id", zcode !== other, `${zcode} vs ${other}`);
}

console.log("");
console.log("客户端没给会话 id：不给上游 id");

{
  check("空的没有 id", upstreamSessionId("zcode", "") === "");
  check("空白的也没有", upstreamSessionId("zcode", "   ") === "");
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项`);
if (fail > 0) process.exitCode = 1;
