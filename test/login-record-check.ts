// test/login-record-check.ts — 密码型平台退场后的登录语义。
//
//   node --experimental-strip-types test/login-record-check.ts
//
// 原来的密码登录（SenseNova / TokenRhythm 自己的 kind）随厂商 kind 一起退场了：
// 这两类平台迁移成开放平台（kind = openai），凭据就是面板上填的一把推理 Key。
// 面板再点「登录」已经没有意义 —— 网关要拒掉，说清该去填 Key，并且**不留登录
// 记录**：没有 pending 的一行，面板就不会永远停在「正在登录」。
//
// 会话型平台（qoder / zcode / minimax / workbuddy）的设备流登录记录合得上，
// 那条能力由各自的测试管（test:refresh-flow、test:zcode:session 等），这里不重复。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startGateway } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = "/buddy.admin.v1.AdminService";

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

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

const gateway = await startGateway({
  env: {
    // 上游全关：自测不碰任何平台。
    MINIMAX_CODE: "",
    QODER_GLOBAL: "",
    QODER_CN: "",
    WORKBUDDY_CN: "",
    TOKENRHYTHM: "",
  },
});
const base = gateway.base;
const DATA_DIR = gateway.dataDir;

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();

/** 打一个 Connect 方法。 */
async function call(method: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

process.env.BUDDY_DATA_DIR = DATA_DIR;
const lib = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;
// 这几个模块之间有循环引用，加载顺序得跟网关一样（router-proxy.ts 就是这个
// 顺序），不然模块顶层会读到还没初始化的东西。
await import(lib("lib/config.ts"));
await import(lib("lib/store.ts"));
await import(lib("lib/platforms.ts"));
await import(lib("lib/providers.ts"));
const { loginActivity } = await import(lib("lib/admin/login.ts"));

const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

/** cache 表里这个账号名下的登录记录（没有就是 null）。 */
function loginRecordsFor(accountId: string): any[] {
  const rows = db.prepare("SELECT id, data FROM cache WHERE id LIKE 'login:%'").all() as any[];
  return rows
    .map((row) => {
      try {
        return JSON.parse(String(row.data));
      } catch {
        return null;
      }
    })
    .filter((record) => record?.accountId === accountId);
}

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行 —— 迁移后的形状：kind = openai。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("sensenova");

/** 加一个 SenseNova 账号，返回账号 id。 */
async function addAccount(alias: string): Promise<string> {
  const made = await call("AddAccount", { platform: "sensenova", alias });
  return String(made.body?.id ?? "");
}

console.log("");
console.log("点登录：告知去填推理 Key，不留登录记录");

const account = await addAccount("迁移后的账号");
check("账号加上了", /^\d+$/.test(account), account);

const begun = await call("BeginLogin", { upstreamId: "sensenova", accountId: account });
check("点登录被拒了", begun.body?.ok !== true, JSON.stringify(begun.body));
check(
  "说的是这类平台用推理 Key",
  String(begun.body?.message ?? "").includes("推理 Key"),
  JSON.stringify(begun.body),
);

const withPassword = await call("LoginWithPassword", {
  upstreamId: "sensenova",
  accountId: account,
  username: "user-ok",
  password: "whatever",
});
check("账号密码登录也不收", withPassword.body?.ok !== true, JSON.stringify(withPassword.body));
check(
  "说的是这个账号不支持账号密码登录",
  String(withPassword.body?.message ?? "").includes("账号密码登录"),
  JSON.stringify(withPassword.body),
);

check("没有留下登录记录", loginRecordsFor(account).length === 0, JSON.stringify(loginRecordsFor(account)));
check("面板上不说正在登录", loginActivity(account).loggingIn === false);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
db.close();
const { closeStore } = await import(lib("lib/store.ts"));
closeStore();
await gateway.stopAndWait();
process.exit(fail ? 1 : 0);
