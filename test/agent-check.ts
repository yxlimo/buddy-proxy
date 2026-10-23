// test/agent-check.ts — 从请求头认出是谁发来的。
//
//   node --experimental-strip-types test/agent-check.ts
//
// 头是从真的客户端抓的：pi 发 user-agent: pi/1.4.0 (linux; node/…)，
// opencode 发 user-agent: opencode/latest/2.1.3/cli 外加 x-opencode-client。

import { detectAgent } from "../lib/agent.ts";

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

console.log("");
console.log("认得出来的");

// pi 抓包：user-agent: pi/1.4.0 (linux; node/v24.21.0; x64)
const pi = detectAgent({
  "user-agent": "pi/1.4.0 (linux; node/v24.21.0; x64)",
  "x-stainless-package-version": "0.129.0",
  "anthropic-version": "2023-06-01",
});
check("pi 认得出来", pi.name === "pi", pi.name);
check("pi 的版本在头里", pi.version === "1.4.0", pi.version);
check("原始的 user-agent 留着", pi.userAgent.startsWith("pi/1.4.0"));

// opencode 抓包：user-agent: opencode/latest/2.1.3/cli + x-opencode-client: cli
const opencode = detectAgent({
  "user-agent": "opencode/latest/2.1.3/cli",
  "x-opencode-client": "cli",
  "x-opencode-session": "ses_abc",
});
check("opencode 认得出来", opencode.name === "opencode", opencode.name);
check("opencode 的版本在头里", opencode.version === "2.1.3", opencode.version);

// 键名的大小写不该有影响。
const upper = detectAgent({ "User-Agent": "pi/1.4.0 (linux)" });
check("键名大写也认", upper.name === "pi", upper.name);

// 头是数组的时候取第一个。
const array = detectAgent({ "user-agent": ["curl/8.5.0", "curl/8.4.0"] });
check("数组的头取第一个", array.name === "curl", array.name);

console.log("");
console.log("认不出来的");

const curl = detectAgent({ "user-agent": "curl/8.5.0" });
check("curl 报 curl", curl.name === "curl", curl.name);

const node = detectAgent({ "user-agent": "node" });
check("没版本也能报", node.name === "node", node.name);

const empty = detectAgent({});
check("没有头是 unknown", empty.name === "unknown", empty.name);

const browser = detectAgent({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140" });
check("浏览器报第一个词", browser.name === "Mozilla", browser.name);

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
