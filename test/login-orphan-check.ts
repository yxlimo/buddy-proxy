// test/login-orphan-check.ts — 密码登录途中删账号：不留孤儿凭据；注销也取消还在等的登录。
//
//   node --experimental-strip-types test/login-orphan-check.ts
//
// 离线：假的 TokenRhythm 在本机起，登录与建 key 两条路都可以「卡住」，好在
// 卡住的时候删账号。
//   1. 登录请求还在等平台时删账号：平台答复之后写下的账号密码、会话都要删掉。
//   2. 建 key 还在等平台时删账号：同上。
//   3. 没删账号的登录照常落库（对照组）。
//   4. 注销（不删行）也取消还在等的登录。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "login-orphan-"));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 卡住的那一下：测试放行之前，假上游不答。 */
let holdLogin: Promise<void> | null = null;
let holdKey: Promise<void> | null = null;
let loginCalls = 0;
let keyCalls = 0;

const fake = http.createServer(async (req, res) => {
  for await (const _ of req) {
    /* drain */
  }
  const url = req.url ?? "/";
  if (url === "/api/auth/login" && req.method === "POST") {
    loginCalls++;
    if (holdLogin) await holdLogin;
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["tr_session=fake-session; Path=/; HttpOnly", "tr_csrf=fake-csrf; Path=/"],
    });
    res.end(JSON.stringify({ code: 0, data: { user: { id: 7, name: "假账号" } } }));
    return;
  }
  if (url === "/api/api-keys" && req.method === "POST") {
    keyCalls++;
    if (holdKey) await holdKey;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { id: `k${keyCalls}`, name: "buddy", key: `sk-fake-${keyCalls}`, maskedKey: "sk-***" } }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 404 }));
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
process.env.TOKENRHYTHM_API_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { addAccount, provider } = await import("../lib/providers.ts");
const { listSecrets, setCached, peekCached, closeStore } = await import("../lib/store.ts");
const { deleteAccount, logoutAccount } = await import("../lib/admin/accounts.ts");
const { loginWithPassword } = await import("../lib/admin/login.ts");

/** 这个账号名下还剩的凭据 id。 */
function leftovers(id: string): string[] {
  return [...listSecrets(`session:provider:${id}`), ...listSecrets(`key:provider:${id}`), ...listSecrets(`account:${id}`)]
    .map((r) => r.id)
    .filter((rid) => rid === `session:provider:${id}` || rid.startsWith(`key:provider:${id}:`) || rid === `key:provider:${id}` || rid === `account:${id}`);
}

function login(accountId: string) {
  return loginWithPassword({
    upstreamId: "tokenrhythm",
    accountId,
    username: "user@example.invalid",
    password: "not-a-real-password",
    captchaVerifyParam: "",
    captchaSceneId: "",
    captchaPrefix: "",
    remember: true,
  }).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
}

/** 一道闸：返回闸本身和放行的那只手。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

console.log("");
console.log("登录请求还在等平台时删账号");

{
  // 先垫一个账号占住 `tokenrhythm` 这个 id：要测的那个是普通账号。
  addAccount({ platform: "tokenrhythm", alias: "垫底" });
  const id = addAccount({ platform: "tokenrhythm", alias: "登录中删掉" }).id!;
  const g = gate();
  holdLogin = g.wait;
  const before = loginCalls;
  const running = login(id);
  for (let i = 0; i < 50 && loginCalls === before; i++) await sleep(20);
  check("登录请求发出去了", loginCalls === before + 1);
  check("账号删掉了", deleteAccount(id).ok && provider(id) === null);
  g.open();
  holdLogin = null;
  const result = await running;
  check("这次登录报错", !result.ok, result.ok ? JSON.stringify(result.r) : "");
  check("没有留下凭据", leftovers(id).length === 0, leftovers(id).join(","));
}

console.log("");
console.log("建 key 还在等平台时删账号");

{
  const id = addAccount({ platform: "tokenrhythm", alias: "建 key 时删掉" }).id!;
  const g = gate();
  holdKey = g.wait;
  const before = keyCalls;
  const running = login(id);
  for (let i = 0; i < 50 && keyCalls === before; i++) await sleep(20);
  check("建 key 的请求发出去了", keyCalls === before + 1);
  check("账号删掉了", deleteAccount(id).ok && provider(id) === null);
  g.open();
  holdKey = null;
  const result = await running;
  check("这次登录报错", !result.ok, result.ok ? JSON.stringify(result.r) : "");
  check("没有留下凭据", leftovers(id).length === 0, leftovers(id).join(","));
}

console.log("");
console.log("对照组：没删账号的登录照常落库");

{
  const id = addAccount({ platform: "tokenrhythm", alias: "正常登录" }).id!;
  const result = await login(id);
  check("登录成了", result.ok && result.r.ok, result.ok ? result.r.message : String((result as any).e?.message));
  const left = leftovers(id);
  check("会话在", left.includes(`session:provider:${id}`), left.join(","));
  check("账号密码与 key 在", left.includes(`key:provider:${id}:account`), left.join(","));
}

console.log("");
console.log("注销也取消还在等的登录");

{
  const id = addAccount({ platform: "minimax", alias: "注销中" }).id!;
  const loginId = "orphan-check-login-1";
  setCached(`login:${loginId}`, {
    loginId,
    upstreamId: "minimax",
    accountId: id,
    status: "pending",
    method: "device",
    authorizationUrl: "",
    userCode: "U",
    expiresAt: Date.now() + 60_000,
    message: "",
    username: "",
    poll: null,
    credentialId: "",
  });
  const result = logoutAccount(id);
  check("注销了", result.ok, result.message);
  check("账号行还在", provider(id) !== null);
  const status = peekCached<{ status?: string }>(`login:${loginId}`)?.data?.status;
  check("pending 的登录被取消了", status === "cancelled", String(status));
}

fake.close();
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项\n  ${problems.join("\n  ")}` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
