// test/periodic-check.ts — 会话是按客户端的节奏自己刷新的。
//
//   node --experimental-strip-types test/periodic-check.ts
//
// 官方客户端不等请求来了才换令牌：它自己按时间表换。所以网关也这样——
// 一个定时器，令牌快到点就换掉，请求来的时候拿到的令牌一定是还能用的。
//
// 这里登记一个假的种类，看定时器会不会按它的办法去刷；顺便看刷不出来的时候
// 是不是只说一次（别刷屏）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-refresh-"));
process.env.BUDDY_DATA_DIR = tmp;

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

const { addProvider } = await import("../lib/providers.ts");
const { registerKind } = await import("../lib/provider-kinds.ts");
const { runPeriodicOnce } = await import("../lib/periodic.ts");

let refreshed: string[] = [];
let scanned: string[] = [];
let failWith: Error | null = null;
let failScanWith: Error | null = null;

registerKind({
  kind: "test-kind",
  label: "测试种类",
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
    if (failWith) throw failWith;
    refreshed.push(provider.id);
  },
  scan: async (provider) => {
    if (failScanWith) throw failScanWith;
    scanned.push(provider.id);
  },
});

addProvider({ id: "test-one", kind: "test-kind", alias: "第一个" });
addProvider({ id: "test-two", kind: "test-kind", alias: "第二个" });

console.log("定时刷新");

await runPeriodicOnce();
check("两个上游都刷了", refreshed.length === 2, JSON.stringify(refreshed));
check("刷的是 provider 自己的 id", refreshed.includes("test-one") && refreshed.includes("test-two"), JSON.stringify(refreshed));
check("余额也扫了", scanned.length === 2, JSON.stringify(scanned));

console.log("");
console.log("刷不出来的时候别刷屏");

failWith = new Error("refresh rejected (invalid_grant)");
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};
await runPeriodicOnce();
await runPeriodicOnce();
await runPeriodicOnce();
console.warn = originalWarn;

check(
  "每个上游只说一次",
  warnings.filter((w) => w.includes("invalid_grant")).length === 2,
  JSON.stringify(warnings),
);
check("说的是哪个上游", warnings.some((w) => w.includes("test-one")), JSON.stringify(warnings));

console.log("");
console.log("刷得出来之后就不再提这件事");

failWith = null;
const before = warnings.length;
await runPeriodicOnce();
check("没有新的警告", warnings.length === before, JSON.stringify(warnings.slice(before)));

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : "全部通过");
process.exit(fail === 0 ? 0 : 1);
