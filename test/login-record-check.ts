// test/login-record-check.ts — 登录记录合得上。
//
//   node --experimental-strip-types test/login-record-check.ts
//
// 面板点「登录」会在 cache 表里留一行 pending。设备流那条路有轮询，轮询到结果
// 就会把那一行合上；密码这条路没有轮询，没人替它合 —— 记录留着 pending，面板
// 就永远停在「正在登录」，额度栏也空着。
//
// 这里起一个假的上游（不碰任何真平台），走一遍真实的密码登录，看那一行最后是
// 什么状态，以及面板看到的「正在登录」对不对。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startGateway } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = "/buddy.admin.v1.AdminService";

/** 假上游：密码是这个就登录成，别的一律回 401。 */
const GOOD_PASSWORD = "good-password";

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
 * 假的上游
 * ------------------------------------------------------------------ */

let mockBase = "";

const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("content-type", "application/json");
  // 第一步：OAuth2 的门，给一个 login_challenge。
  if (url.pathname === "/oauth2/auth") {
    res.statusCode = 302;
    res.setHeader("location", `${mockBase}/iam/authn/v1/login?login_challenge=CHAL-MOCK`);
    res.end("");
    return;
  }
  // 第二步：账号密码换一个「继续登录」的地址。
  if (url.pathname === "/iam/authn/v1/auth/nova/login") {
    let password = "";
    try {
      password = String(JSON.parse(body || "{}").password ?? "");
    } catch {
      password = "";
    }
    if (password !== GOOD_PASSWORD) {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: 16, message: "账号或密码不对" }));
      return;
    }
    res.end(JSON.stringify({ redirect: `${mockBase}/oauth2/authorize?code=CODE-MOCK` }));
    return;
  }
  // 第三步：走完同意页，地址里带着授权码。
  if (url.pathname === "/oauth2/authorize") {
    res.end("{}");
    return;
  }
  // 第四步：授权码换 token。
  if (url.pathname === "/oauth2/token") {
    res.end(
      JSON.stringify({
        access_token: "at-mock",
        refresh_token: "rt-mock",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    return;
  }
  // 别的（控制台的 key 接口、模型清单）都不给：登录本身不该依赖它们。
  res.statusCode = 404;
  res.end("{}");
});

await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
mockBase = `http://127.0.0.1:${(mock.address() as net.AddressInfo).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

const gateway = await startGateway({
  env: {
    // 上游全关：自测不碰任何平台，也不自动登录。
    MINIMAX_CODE: "",
    QODER_GLOBAL: "",
    QODER_CN: "",
    WORKBUDDY_CN: "",
    TOKENRHYTHM: "",
    // 假的上游。
    MINIMAX_OAUTH_ORIGIN: mockBase,
    WORKBUDDY_CN_BASE: mockBase,
    ZCODE_BASE_URL: mockBase,
    QODER_GLOBAL_OPENAPI_BASE: mockBase,
    QODER_CN_OPENAPI_BASE: mockBase,
    // SenseNova 的三个地址都指到假上游：自测不碰真平台。
    SENSENOVA_BASE: `${mockBase}/v1`,
    SENSENOVA_PLATFORM_BASE: mockBase,
    SENSENOVA_IAM_BASE: mockBase,
    // 轮询快一点：自测不用等上游那一秒。
    ZCODE_POLL_INTERVAL_MS: "200",
    MINIMAX_POLL_INTERVAL_MS: "200",
    QODER_POLL_INTERVAL_MS: "200",
  },
});
const base = gateway.base;
const DATA_DIR = gateway.dataDir;

process.on("exit", () => {
  mock.close();
});

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

/* ------------------------------------------------------------------ *
 * 面板那个进程和网关那个进程看的是同一份 cache 表
 * ------------------------------------------------------------------ */

process.env.BUDDY_DATA_DIR = DATA_DIR;
// 这几个模块之间有循环引用，加载顺序得跟网关一样（router-proxy.ts 就是这个
// 顺序），不然模块顶层会读到还没初始化的东西。
await import(path.join(ROOT, "lib/config.ts"));
await import(path.join(ROOT, "lib/store.ts"));
await import(path.join(ROOT, "lib/platforms.ts"));
await import(path.join(ROOT, "lib/providers.ts"));
const { loginActivity } = await import(path.join(ROOT, "lib/admin/login.ts"));

const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
// The gateway writes in WAL mode; a reader that does not speak WAL sees the
// main file only, which is what a checkpoint has written so far.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

/** cache 表里那一条登录记录。 */
function recordOf(loginId: string): any {
  const row = db.prepare("SELECT data FROM cache WHERE id = ?").get(`login:${loginId}`) as any;
  if (!row?.data) return null;
  try {
    return JSON.parse(String(row.data));
  } catch {
    return null;
  }
}

/** 加一个 SenseNova 账号，返回账号 id。 */
async function addAccount(alias: string): Promise<string> {
  const made = await call("AddAccount", { platform: "sensenova", alias });
  return String(made.body?.id ?? "");
}

/** 面板点「登录」：留一条 pending 的记录。 */
async function beginLogin(accountId: string): Promise<string> {
  const begun = await call("BeginLogin", { upstreamId: "sensenova", accountId });
  if (begun.body?.ok !== true) {
    console.log(`  （开始不了登录：${JSON.stringify(begun.body)}）`);
    return "";
  }
  return String(begun.body?.session?.loginId ?? "");
}

console.log("");
console.log("密码登录：记录要合上");

const goodAccount = await addAccount("密码登录成功");
check("账号加上了", goodAccount.length > 0, goodAccount);

const goodLoginId = await beginLogin(goodAccount);
check("面板点登录留了一条记录", goodLoginId.length > 0, goodLoginId);
check("开始时是 pending", recordOf(goodLoginId)?.status === "pending", JSON.stringify(recordOf(goodLoginId)));

const okLogin = await call("LoginWithPassword", {
  upstreamId: "sensenova",
  accountId: goodAccount,
  username: "user-ok",
  password: GOOD_PASSWORD,
});
check("密码对就登录成", okLogin.body?.ok === true, JSON.stringify(okLogin.body));

const goodRecord = recordOf(goodLoginId);
check("记录合上了：approved", goodRecord?.status === "approved", JSON.stringify(goodRecord));
check(
  "记录里带着这次登录的凭据",
  goodRecord?.credentialId === `session:provider:${goodAccount}`,
  JSON.stringify(goodRecord?.credentialId),
);
check("登录完了就不再说正在登录", loginActivity(goodAccount).loggingIn === false);

console.log("");
console.log("密码错：记录也要合上");

const badAccount = await addAccount("密码登录失败");
const badLoginId = await beginLogin(badAccount);
check("失败也有那条记录", badLoginId.length > 0, badLoginId);

const badLogin = await call("LoginWithPassword", {
  upstreamId: "sensenova",
  accountId: badAccount,
  username: "user-bad",
  password: "wrong-password",
});
check("密码错就不成", badLogin.body?.ok !== true, JSON.stringify(badLogin.body));

const badRecord = recordOf(badLoginId);
check("记录合上了：failed", badRecord?.status === "failed", JSON.stringify(badRecord));
check("失败时说清楚为什么", String(badRecord?.message ?? "").length > 0, JSON.stringify(badRecord?.message));
check("失败了也不再说正在登录", loginActivity(badAccount).loggingIn === false);

console.log("");
console.log("过期的记录不再冒充「正在登录」");

// 面板点过「登录」，但网关重启了、轮询没起来：那条记录就永远 pending。
const staleAccount = await addAccount("过期的那条");
const staleLoginId = await beginLogin(staleAccount);
check("有过期的记录", staleLoginId.length > 0, staleLoginId);
const staleRow = db.prepare("SELECT data FROM cache WHERE id = ?").get(`login:${staleLoginId}`) as any;
const staleData = JSON.parse(String(staleRow?.data ?? "{}"));
staleData.expiresAt = Date.now() - 1000;
db.prepare("UPDATE cache SET data = ? WHERE id = ?").run(JSON.stringify(staleData), `login:${staleLoginId}`);

check("过期的不算正在登录", loginActivity(staleAccount).loggingIn === false);
check("过期的被标成 expired", recordOf(staleLoginId)?.status === "expired", JSON.stringify(recordOf(staleLoginId)));
check(
  "过期时说的是人话",
  String(recordOf(staleLoginId)?.message ?? "").includes("过期"),
  JSON.stringify(recordOf(staleLoginId)?.message),
);

console.log("");
console.log("控制组：还在等的登录仍然算「正在登录」");

const controlAccount = await addAccount("正在登录");
const controlLoginId = await beginLogin(controlAccount);
check("控制组有那条记录", controlLoginId.length > 0, controlLoginId);
check("控制组还是 pending", recordOf(controlLoginId)?.status === "pending", JSON.stringify(recordOf(controlLoginId)));
check("控制组算正在登录", loginActivity(controlAccount).loggingIn === true);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
gateway.stop();
mock.close();
process.exit(fail ? 1 : 0);
