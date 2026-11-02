// test/session-race-check.ts — 刷新与锁的几种撞车，以及 intern-ai 的 401 清谁。
//
//   node --experimental-strip-types test/session-race-check.ts
//
// 离线：刷新走 refreshSessionFlow 的骨架，「问平台」是测试自己给的函数；
// intern-ai 的控制台是本机的假上游。
//   1. 刷新途中账号被删（会话那一行没了）：新会话不写回，报 session gone。
//   2. 锁过期被接管：旧持有者收尾时只删自己那一行，新持有者的锁还在。
//   3. 等锁的那一个进锁时，前一个已被平台拒了：不再拿同一张票去问。
//   4. 拿不到锁、用库里那份：auth.log 里留一行 lock busy。
//   5. intern-ai 401：只清持有这把令牌的会话。
//   6. 已有的 auth.log 收紧到 0600（Windows 上 chmod 没有意义，跳过）。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-race-"));
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

function section(title: string): void {
  console.log("");
  console.log(title);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 假的 intern-ai 控制台：认识的令牌答 200，别的答 401。
const fake = http.createServer((req, res) => {
  const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  res.writeHead(auth === "tok-good" ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(auth === "tok-good" ? { code: 0, data: {} } : { msg: "unauthorized" }));
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { getSecret, setSecret, deleteSecret, withLock, store, closeStore } = await import("../lib/store.ts");
const { refreshSessionFlow, withSessionLock, writeSession } = await import("../lib/session.ts");
const { authLog } = await import("../lib/credential.ts");
const { consoleApi } = await import("../lib/intern-ai/platform.ts");

type S = { accessToken: string; refreshToken: string; expiresAtMs: number; generation?: number; obtainedAtMs?: number };

/** 一条测试用的刷新链：问平台那一下由 `ask` 决定。 */
function flow(id: string, ask: (signal: AbortSignal) => Promise<{ ok: boolean; status: number; code: string; body: any }>) {
  return {
    id,
    load: () => getSecret<S>(id),
    bufferMs: 5 * 60_000,
    request: (_s: S, signal: AbortSignal) => ask(signal),
    parse: (body: any, s: S): S => ({ ...s, accessToken: body.access, refreshToken: body.refresh, expiresAtMs: Date.now() + 3_600_000, generation: (s.generation ?? 1) + 1 }),
    refused: (a: { status: number }) => a.status === 401,
    hint: () => "被拒了",
    save: (next: S) => writeSession(id, next),
    label: () => id,
    noSession: "没有会话",
    timeoutMs: 2_000,
  };
}

function dueSession(tag: string): S {
  return { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAtMs: Date.now() + 60_000, generation: 1, obtainedAtMs: 1 };
}

section("刷新途中账号被删");

{
  const id = "session:provider:race-dropped";
  setSecret(id, "session", dueSession("dropped"));
  let error: unknown = null;
  try {
    await refreshSessionFlow<S>(
      flow(id, async () => {
        // 平台答复之前，账号被删了（删账号删的就是这一行）。
        deleteSecret(id);
        return { ok: true, status: 200, code: "", body: { access: "new-access", refresh: "new-refresh" } };
      }),
    );
  } catch (e) {
    error = e;
  }
  check("报 session gone", String((error as Error)?.message) === "session gone", String((error as Error)?.message));
  check("新会话没有写回去", getSecret(id) === null);
  const log = fs.readFileSync(path.join(tmp, "auth.log"), "utf8");
  check("auth.log 里记了 refresh dropped", log.includes(`${id} refresh dropped`));
}

section("锁过期被接管：旧持有者只删自己那一行");

{
  const id = "lock:race-takeover";
  let holderB = "";
  let releaseB = () => {};
  const bHolding = new Promise<void>((r) => {
    releaseB = r;
  });
  const a = withLock(
    id,
    async () => {
      // A 卡住，锁过期，B 接管。
      await sleep(250);
    },
    { staleMs: 100 },
  );
  await sleep(150);
  const b = withLock(
    id,
    async () => {
      holderB = String((store().prepare("SELECT holder FROM locks WHERE id = ?").get(id) as { holder?: string } | undefined)?.holder ?? "");
      await bHolding;
    },
    { staleMs: 100 },
  );
  await a; // A 收尾：释放锁。
  const row = store().prepare("SELECT holder FROM locks WHERE id = ?").get(id) as { holder?: string } | undefined;
  check("B 接管了锁", holderB !== "");
  check("A 收尾之后 B 的锁还在", row?.holder === holderB, `${row?.holder} vs ${holderB}`);
  releaseB();
  await b;
  check("B 收尾之后锁没了", store().prepare("SELECT holder FROM locks WHERE id = ?").get(id) === undefined);
}

section("进锁时前一个已被拒：不再问平台");

{
  const id = "session:provider:race-dead";
  setSecret(id, "session", dueSession("dead"));
  let asks = 0;
  const refuse = async () => {
    asks++;
    await sleep(100);
    return { ok: false, status: 401, code: "invalid_grant", body: {} };
  };
  const results = await Promise.allSettled([refreshSessionFlow<S>(flow(id, refuse)), refreshSessionFlow<S>(flow(id, refuse))]);
  check("平台只被问了一次", asks === 1, String(asks));
  const messages = results.map((r) => (r.status === "rejected" ? String((r.reason as Error)?.message) : "ok"));
  check("两个都报被拒", messages.every((m) => m.includes("refused") || m.includes("rejected")), messages.join(" / "));
}

section("拿不到锁、用库里那份：留一行日志");

{
  const id = "session:provider:race-busy";
  setSecret(id, "session", dueSession("busy"));
  // 别人拿着锁（而且一直不过期）。
  store().prepare("INSERT INTO locks (id, holder, at) VALUES (?, ?, ?)").run(id, "someone-else", Date.now() + 3_600_000);
  let ran = false;
  const got = await withSessionLock<S>(id, async () => {
    ran = true;
    return dueSession("never");
  });
  check("没有进锁", !ran);
  check("交回的是库里那份", got.accessToken === "access-busy", got.accessToken);
  const log = fs.readFileSync(path.join(tmp, "auth.log"), "utf8");
  check("auth.log 里记了 lock busy", log.includes(`${id} lock busy, using stored session`));
  check("日志里没有令牌本身", !log.includes("access-busy"));
  store().prepare("DELETE FROM locks WHERE id = ?").run(id);
}

section("intern-ai 401 只清持有这把令牌的会话");

{
  const sites = (token: string) => [{ name: "discovery", token, clientId: "c" }];
  const a = "session:provider:intern-ai-race-a";
  const b = "session:provider:intern-ai-race-b";
  setSecret(a, "session", { sites: sites("tok-bad"), obtainedAtMs: 1, username: "a" });
  setSecret(b, "session", { sites: sites("tok-good"), obtainedAtMs: 1, username: "b" });
  const sessionA = getSecret<any>(a);
  let error: unknown = null;
  try {
    await consoleApi(base, "/api/x", sessionA, "tok-bad");
  } catch (e) {
    error = e;
  }
  check("401 报出来了", String((error as Error)?.message).includes("401"), String((error as Error)?.message));
  check("A 的会话清了", getSecret(a) === null);
  check("B 的会话还在", getSecret(b) !== null);
  // B 那把令牌好好的：问一次，什么都不清。
  await consoleApi(base, "/api/x", getSecret<any>(b), "tok-good");
  check("能用的令牌不清会话", getSecret(b) !== null);
}

section("已有的 auth.log 收紧到 0600");

if (process.platform === "win32") {
  console.log("  skip Windows 上 chmod 没有意义");
} else {
  const dir = path.join(tmp, "log-mode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth.log");
  fs.writeFileSync(file, "old line\n", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  authLog(dir, "test event");
  check("权限是 0600", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
}

fake.close();
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项\n  ${problems.join("\n  ")}` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
