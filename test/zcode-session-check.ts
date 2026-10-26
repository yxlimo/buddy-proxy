// test/zcode-session-check.ts — ZCode 的会话：什么时候算有效，到期时间不知道时怎么办。
//
//   node --experimental-strip-types test/zcode-session-check.ts
//
// 官方客户端的 zcode JWT 里没有 exp：有效期由平台说了算，客户端自己也不记
// 到期时间。所以「不知道什么时候过期」是常态，不是异常 —— 早先那个把
// expiresAtMs = 0 当成「已经过期」的判断，会让一份好好在用的会话被判死。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 自己的一份数据目录：下面写的会话不能留在下一次运行里。
process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-session-"));

const { setSecret, deleteSecret, getSecret } = await import("../lib/store.ts");
const { loadSession, forgetSession, zcodeStatus } = await import("../lib/zcode/auth.ts");

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
  const good = Boolean(ok);
  console.log(`  ${good ? "ok  " : "FAIL"} ${name}${good ? "" : ` — ${detail}`}`);
  if (good) pass++;
  else fail++;
}

const SESSION_ID = "session:provider:zcode";

function putSession(fields: Record<string, unknown>): void {
  setSecret(SESSION_ID, "session", {
    token: "jwt_test",
    provider: "bigmodel",
    deviceId: "device_test",
    generation: 1,
    loginAtMs: Date.now() - 3600_000,
    expiresAtMs: 0,
    ...fields,
  });
}

console.log("");
console.log("到期时间不知道（0）：会话照旧能用");

{
  putSession({ expiresAtMs: 0 });
  const session = loadSession();
  check("读得到会话", session !== null);
  check("令牌没变", session?.token === "jwt_test", String(session?.token));

  const status = zcodeStatus();
  check("状态是已认证", status.status === "authenticated", String(status.status));
  check("不给一个假到期日子", status.expiresAt === "", String(status.expiresAt));
  check("剩余时间也是零", status.remainingSec === 0, String(status.remainingSec));
}

console.log("");
console.log("到期时间明确：过了就是过期");

{
  putSession({ expiresAtMs: Date.now() - 1000 });
  check("过期的不算会话", loadSession() === null);
  check("面板上就是没有会话", zcodeStatus().status === "anonymous", String(zcodeStatus().status));
}

{
  putSession({ expiresAtMs: Date.now() + 3600_000 });
  check("还有时间的算会话", loadSession() !== null);
  const status = zcodeStatus();
  check("状态是已认证", status.status === "authenticated", String(status.status));
  check("到期时间报出来", typeof status.expiresAt === "string" && status.expiresAt.endsWith("Z"), String(status.expiresAt));
  check("剩余时间算得出来", Number(status.remainingSec) > 3000, String(status.remainingSec));
}

console.log("");
console.log("旧位置不再认：注销的账号不会带着旧身份回来");

{
  deleteSecret(SESSION_ID);
  // 旧的那份是全局的（只有一个 ZCode 账号的时候放在那里）。
  setSecret("session:zcode", "session", {
    token: "jwt_old",
    provider: "bigmodel",
    deviceId: "device_old",
    generation: 1,
    loginAtMs: Date.now() - 7200_000,
    expiresAtMs: 0,
  });
  check("全局那份不算会话", loadSession() === null);
  check("状态是匿名", zcodeStatus().status === "anonymous", String(zcodeStatus().status));

  // 注销的时候它也要被清掉：留着它，登录的时候会被认出来。
  forgetSession();
  check("旧位置真的没了", getSecret("session:zcode") === null, String(getSecret("session:zcode")));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项`);
if (fail > 0) process.exitCode = 1;
