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

const { addAccount } = await import("../lib/providers.ts");
const { registerKind } = await import("../lib/provider-kinds.ts");
const { runPeriodicOnce } = await import("../lib/periodic.ts");

let refreshed: string[] = [];
let failWith: Error | null = null;

/**
 * 一个种类，只记下「刷新过」「扫过」。
 *
 * 迁移后两行的 kind 都是 openai：定时器看的是注册表，与上游没有关系，所以
 * 这里直接顶掉 openai 这一个真种类，两个平台的账号都走它。没有凭据时不会
 * 去问上游，测试全程离线。
 */
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
    // 凭据形状不归这些测试管：只登记一个空形状的声明（凭据这一单不在这里验）。
    credentials: { title: "", slots: () => [], fields: () => [], write: () => 0 },
    models: () => [],
    quotas: () => [],
    outOfCredits: () => false,
    refresh: async (provider) => {
      if (failWith) throw failWith;
      refreshed.push(provider.id);
    },
  });
}

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("tokenrhythm");
insertVendorPlatform("qiniu");

stubKind("openai");

const rhythmAccount = addAccount({ platform: "tokenrhythm", alias: "第一个" });
const qiniuAccount = addAccount({ platform: "qiniu", alias: "第二个" });

console.log("定时刷新");

await runPeriodicOnce();
check("两个账号都刷了", refreshed.length === 2, JSON.stringify(refreshed));
check(
  "刷的是账号自己的 id",
  refreshed.includes(rhythmAccount.id!) && refreshed.includes(qiniuAccount.id!),
  JSON.stringify(refreshed),
);

// 余额的定时那一件事不再是 kind.scan：它是「余额到期优先」平台的重新钉号
// （repinBalancedPlatforms，按平台那一行的策略）。给中转站标上这个策略，
// 看定时器真的把它的账号钉住了。
const { setPlatformPolicy } = await import("../lib/platforms.ts");
const { pinnedAccountOf } = await import("../lib/router/balance-order.ts");
setPlatformPolicy("tokenrhythm", "expiry_first");
await runPeriodicOnce();
check(
  "余额到期优先的平台被定时器重新钉号",
  pinnedAccountOf("tokenrhythm") === rhythmAccount.id,
  String(pinnedAccountOf("tokenrhythm")),
);

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
  "每个账号只说一次",
  warnings.filter((w) => w.includes("invalid_grant")).length === 2,
  JSON.stringify(warnings),
);
check(
  "说的是哪个账号",
  warnings.some((w) => w.includes(`[AUTH] ${rhythmAccount.id}:`)),
  JSON.stringify(warnings),
);

console.log("");
console.log("刷得出来之后就不再提这件事");

failWith = null;
const before = warnings.length;
await runPeriodicOnce();
check("没有新的警告", warnings.length === before, JSON.stringify(warnings.slice(before)));

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : "全部通过");
process.exit(fail === 0 ? 0 : 1);
