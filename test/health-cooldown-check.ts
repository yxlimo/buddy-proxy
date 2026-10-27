// test/health-cooldown-check.ts — /health 要说得出哪个账号在冷却。
//
//   node --experimental-strip-types test/health-cooldown-check.ts
//
// 离线：起的是本进程里的网关，只读自己的数据库，不问任何上游。
//
// 查的是面板与网关对不上的那种事：面板说 READY，网关答 503「冷却中」。
// 冷却是按账号记的，所以 /health 的账号那一行要带着它 —— 到什么时候为止、
// 为什么。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-health-cooldown";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const { app } = await import("../lib/router/app.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setCooldown } = await import("../lib/cooldown.ts");

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

/** 起一个真的网关（本进程里）：/health 是它答的。 */
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

async function health(): Promise<any> {
  const res = await fetch(`${base}/health`);
  return res.json();
}

/** /health 里某个平台的某个账号。 */
function accountOf(body: any, platform: string, accountId: string): any {
  const accounts = body?.upstreams?.[platform]?.accounts ?? [];
  return accounts.find((row: any) => row?.id === accountId) ?? null;
}

console.log("");
console.log("/health 看得见冷却");

{
  const cooled = addAccount({ platform: "minimax", alias: "冷却的账号" });
  const plain = addAccount({ platform: "minimax", alias: "没冷却的账号" });
  const until = Date.now() + 5 * 60_000;
  setCooldown(cooled.id!, until, "quota");

  const body = await health();
  check("/health 答了", body?.status === "ok", JSON.stringify(body?.status));

  const cooling = accountOf(body, "minimax", cooled.id!);
  check("冷却的账号在 /health 里", cooling !== null, cooled.id!);
  check(
    "它带着冷却状态",
    cooling?.cooldown?.untilMs === until && cooling?.cooldown?.reason === "quota",
    JSON.stringify(cooling?.cooldown),
  );

  const free = accountOf(body, "minimax", plain.id!);
  check("没冷却的账号 cooldown 是 null", free !== null && free?.cooldown === null, JSON.stringify(free?.cooldown));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
server.close();
process.exit(fail === 0 ? 0 : 1);
