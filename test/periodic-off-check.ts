// test/periodic-off-check.ts — 定时器关掉之后，网关就不动任何登录态。
//
//   node --experimental-strip-types test/periodic-off-check.ts
//
// 为什么要有这个开关：换令牌时 refresh token 会轮换，而它是**一次性的**。
// 同一份会话被换两次，平台会当成重放，把整个会话的令牌一起撤掉。调试、
// 复现、离线测试的时候，宁可让令牌过期，也不要它自己动。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "periodic-off-"));
process.env.BUDDY_DATA_DIR = tmp;
// 开关：环境变量。必须在读配置之前设好（配置读一次就定了）。
process.env.PERIODIC_ENABLED = "false";

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

const { addAccount } = await import("../lib/providers.ts");
const { registerKind } = await import("../lib/provider-kinds.ts");
const { runPeriodicOnce, startPeriodic } = await import("../lib/periodic.ts");

let refreshed: string[] = [];
let scanned: string[] = [];

/** 一个种类，只记下「刷新过」「扫过」。 */
function stubKind(kind: string): void {
  registerKind({
    kind,
    label: `测试种类 ${kind}`,
    login: "device",
    baseUrl: () => "http://127.0.0.1",
    credential: () => ({
      kind: "session",
      status: 0 as never,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "",
      generation: 0,
    }),
    models: () => [],
    quotas: () => [],
    outOfCredits: () => false,
    refresh: async (provider) => {
      refreshed.push(provider.id);
    },
    scan: async (provider) => {
      scanned.push(provider.id);
    },
  });
}

stubKind("tokenrhythm");
stubKind("qiniu");
addAccount({ platform: "tokenrhythm", alias: "第一个" });
addAccount({ platform: "qiniu", alias: "第二个" });

console.log("定时器关了：不换令牌，也不扫余额");

await runPeriodicOnce();
check("没有换令牌", refreshed.length === 0, JSON.stringify(refreshed));
check("没有扫余额", scanned.length === 0, JSON.stringify(scanned));

console.log("");
console.log("startPeriodic 也不起定时器");

const logs: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
};
startPeriodic();
console.log = originalLog;
await new Promise((r) => setTimeout(r, 300));
check("没有换令牌", refreshed.length === 0, JSON.stringify(refreshed));
check("说了为什么不动", logs.some((l) => l.includes("PERIODIC_ENABLED")), JSON.stringify(logs));

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : "全部通过");
process.exit(fail === 0 ? 0 : 1);
