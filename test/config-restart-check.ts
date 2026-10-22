// test/config-restart-check.ts — 配置改了要存下来、读得回来、重启之后才生效。
//
//   node --experimental-strip-types test/config-restart-check.ts
//
// 起网关（上游全关，不碰任何平台），用面板的接口改配置，然后：
//
//   1. 改的值进了数据库；
//   2. 读回来是新值，来源是「数据库覆盖」；
//   3. 还没重启之前，跑着的进程用的还是旧值；
//   4. 重启（RestartSystem 或者自己起一个进程）之后，新值生效；
//   5. 不认识的键、服务内部的键，SetConfig 都要拒绝。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-config-restart";
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");
const SERVICE = "/buddy.admin.v1.AdminService";
const CLIENT_KEY = "oc-test-key-1234567890";
const SECRET_KEY = "oc-test-secret-0987654321";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
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

/* ------------------------------------------------------------------ *
 * 假的上游（只是为了让网关别往外面发请求）
 * ------------------------------------------------------------------ */

const fakeUpstream = http.createServer((req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolve) => fakeUpstream.listen(0, "127.0.0.1", () => resolve()));
const fakeBase = `http://127.0.0.1:${(fakeUpstream.address() as net.AddressInfo).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(KEYS_FILE, JSON.stringify({ test: CLIENT_KEY }, null, 2));

// Qoder 的会话种进测试自己的数据库：等一下要把 Qoder 打开，没有会话的话
// 网关会走设备流去真的登录。
execFileSync(process.execPath, ["--experimental-strip-types", "test/aggregate-setup.ts", "seed"], {
  cwd: ROOT,
  env: { ...process.env, BUDDY_DATA_DIR: DATA_DIR },
  stdio: "ignore",
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

let router: ChildProcess | null = null;
let routerLog = "";

function startRouter(): ChildProcess {
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: DATA_DIR,
      KEYS_FILE,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 上游全关：这一轮只关心配置。
      QODER_GLOBAL: "",
      QODER_CN: "",
      MINIMAX_CODE: "",
      WORKBUDDY_CN: "",
      TOKENRHYTHM: "",
      // 万一有请求打出去，也只打到本机。
      QODER_GLOBAL_INFER_BASE: `${fakeBase}/qoder-global`,
      QODER_GLOBAL_OPENAPI_BASE: `${fakeBase}/openapi-global`,
      QODER_GLOBAL_LEGACY_BASE: `${fakeBase}/qoder-global-legacy`,
      QODER_CN_INFER_BASE: `${fakeBase}/qoder-cn`,
      QODER_CN_OPENAPI_BASE: `${fakeBase}/openapi-cn`,
      WORKBUDDY_CN_BASE: `${fakeBase}/workbuddy`,
      WORKBUDDY_CHAT_BASE: `${fakeBase}/workbuddy`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => {
    routerLog += c.toString();
  });
  child.stderr?.on("data", (c: Buffer) => {
    routerLog += c.toString();
  });
  router = child;
  return child;
}

async function waitHealthy(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function cleanup(): void {
  try {
    router?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  fakeUpstream.close();
}
process.on("exit", cleanup);

startRouter();
check("网关起来了", await waitHealthy());

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();

async function admin(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, httpStatus: res.status };
  }
}

async function health(): Promise<any> {
  return fetch(`${base}/health`).then((r) => r.json());
}

/** 数据库里的配置表。 */
function configRows(): { key: string; value: string }[] {
  const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"), { readOnly: true });
  try {
    return db.prepare("SELECT key, value FROM config").all() as any[];
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * 一、改之前
 * ------------------------------------------------------------------ */

section("改之前");

const before = await admin("GetSystemStatus");
check("pendingRestart 是假", before.pendingRestart === false, JSON.stringify(before.pendingRestart));
check("Qoder 全球区现在是关着的", before.upstreams?.find((u: any) => u.id === "qoder")?.enabled === false);

const configBefore = await admin("ListConfig");
const keys = (configBefore.items ?? []).map((i: any) => i.key);
check("配置项只有 7 个", (configBefore.items ?? []).length === 7, JSON.stringify(keys));
check(
  "公布的是用户能改的那几个",
  ["MINIMAX_CODE", "QODER_GLOBAL", "QODER_CN", "WORKBUDDY_CN", "TOKENRHYTHM", "REQUIRE_API_KEY", "ADMIN_CORS_ORIGINS"].every(
    (k) => keys.includes(k),
  ),
  JSON.stringify(keys),
);
check(
  "服务内部的设置看不见",
  !keys.some((k) =>
    ["QODER_GLOBAL_INFER_BASE", "QODER_POLL_INTERVAL_MS", "HEALTH_CACHE_MS", "ROUTER_PORT", "MINIMAX_API_BASE"].includes(
      k,
    ),
  ),
  JSON.stringify(keys),
);

/* ------------------------------------------------------------------ *
 * 二、改一个上游开关
 * ------------------------------------------------------------------ */

section("改一个上游开关");

const switched = await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });
check("面板能把上游打开", switched.ok === true, JSON.stringify(switched));
check("改完 pendingRestart 变真", switched.pendingRestart === true, JSON.stringify(switched));

const rows = configRows();
const qoderRow = rows.find((r) => r.key === "QODER_GLOBAL");
check("值进了数据库", qoderRow?.value === "true", JSON.stringify(rows));

const listed = await admin("ListConfig");
const qoderItem = (listed.items ?? []).find((i: any) => i.key === "QODER_GLOBAL");
check("读回来是新值", qoderItem?.value === "true", JSON.stringify(qoderItem));
check("来源是数据库覆盖", qoderItem?.source === "database", JSON.stringify(qoderItem));

const upstreams = await admin("ListUpstreams");
const qoderUpstream = (upstreams.upstreams ?? []).find((u: any) => u.id === "qoder");
check("上游列表里的值也是新的", qoderUpstream?.enabled === true, JSON.stringify(qoderUpstream));
check("上游列表标着待重启", qoderUpstream?.pending === true, JSON.stringify(qoderUpstream));

const stillOff = await health();
check(
  "跑着的进程还没换（改了要重启才生效）",
  stillOff.enabled?.qoderGlobal === false,
  JSON.stringify(stillOff.enabled),
);

/* ------------------------------------------------------------------ *
 * 三、重启
 * ------------------------------------------------------------------ */

section("重启");

const restart = await admin("RestartSystem");
check("RestartSystem 答应了", restart.accepted === true, JSON.stringify(restart));

// 进程会在 500 毫秒后退出（容器会把它拉起来；这里自己拉）。
const exited = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 8000);
  router?.once("exit", () => {
    clearTimeout(timer);
    resolve(true);
  });
});
check("进程真的退出了", exited);

startRouter();
check("网关又起来了", await waitHealthy());

const afterRestart = await health();
check(
  "重启之后新值生效了（上游从 off 变 on）",
  afterRestart.enabled?.qoderGlobal === true,
  JSON.stringify(afterRestart.enabled),
);

const statusAfter = await admin("GetSystemStatus");
check(
  "重启之后 pendingRestart 又是假",
  statusAfter.pendingRestart === false,
  JSON.stringify(statusAfter.pendingRestart),
);

/* ------------------------------------------------------------------ *
 * 四、改一个普通的配置项，再重启一次（自己起进程的那种重启）
 * ------------------------------------------------------------------ */

section("改一个配置项，再重启");

const origins = await admin("SetConfig", { key: "ADMIN_CORS_ORIGINS", value: "http://panel.example.test" });
check("面板能改 ADMIN_CORS_ORIGINS", origins.ok === true, JSON.stringify(origins));
check(
  "进了数据库",
  configRows().find((r) => r.key === "ADMIN_CORS_ORIGINS")?.value === "http://panel.example.test",
  JSON.stringify(configRows()),
);
const originsRead = (await admin("ListConfig")).items?.find((i: any) => i.key === "ADMIN_CORS_ORIGINS");
check("读回来是新值", originsRead?.value === "http://panel.example.test", JSON.stringify(originsRead));

// 自己重启：杀掉进程，再起一个。
router?.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
startRouter();
check("网关又起来了", await waitHealthy());
const originsAfter = (await admin("ListConfig")).items?.find((i: any) => i.key === "ADMIN_CORS_ORIGINS");
check(
  "重启之后还是那个值",
  originsAfter?.value === "http://panel.example.test",
  JSON.stringify(originsAfter),
);
check(
  "重启之后 pendingRestart 又是假",
  (await admin("GetSystemStatus")).pendingRestart === false,
);

/* ------------------------------------------------------------------ *
 * 五、拒绝
 * ------------------------------------------------------------------ */

section("拒绝");

const unknown = await admin("SetConfig", { key: "NO_SUCH_SETTING", value: "1" });
check("不认识的键被拒绝", unknown.ok === false, JSON.stringify(unknown));
check("拒绝的话说得清", /不认识/.test(String(unknown.message ?? "")), JSON.stringify(unknown));
check(
  "不认识的键没有进数据库",
  !configRows().some((r) => r.key === "NO_SUCH_SETTING"),
  JSON.stringify(configRows()),
);

for (const key of [
  "QODER_GLOBAL_INFER_BASE",
  "QODER_POLL_INTERVAL_MS",
  "HEALTH_CACHE_MS",
  "ROUTER_PORT",
  "MINIMAX_API_BASE",
  "QODER_POLL_TIMEOUT_MS",
]) {
  const refused = await admin("SetConfig", { key, value: "12345" });
  check(`服务内部的设置改不了：${key}`, refused.ok === false, JSON.stringify(refused));
  check(
    `服务内部的设置没有进数据库：${key}`,
    !configRows().some((r) => r.key === key),
    JSON.stringify(configRows()),
  );
}

/* ------------------------------------------------------------------ *
 * 六、开关 REQUIRE_API_KEY：改了要重启才生效
 * ------------------------------------------------------------------ */

section("前门的开关");

const requireKey = await admin("SetConfig", { key: "REQUIRE_API_KEY", value: "true" });
check("面板能改 REQUIRE_API_KEY", requireKey.ok === true, JSON.stringify(requireKey));

const noKey = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
});
check(
  "还没重启的时候前门还是开着",
  noKey.status !== 401,
  `HTTP ${noKey.status}`,
);

router?.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
startRouter();
check("网关又起来了", await waitHealthy());

const noKeyAfter = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
});
check("重启之后前门要钥匙了", noKeyAfter.status === 401, `HTTP ${noKeyAfter.status}`);

const withKey = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": CLIENT_KEY },
  body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
});
check("带钥匙就过（只是模型不存在，不是 401）", withKey.status !== 401, `HTTP ${withKey.status}`);

// 收尾：把前门关回去。
await admin("SetConfig", { key: "REQUIRE_API_KEY", value: "false" });
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: false });
router?.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
startRouter();
await waitHealthy();
const finalHealth = await health();
check("收尾之后前门又开着", finalHealth.auth === "public", JSON.stringify(finalHealth.auth));
check("收尾之后上游又关着", finalHealth.enabled?.qoderGlobal === false, JSON.stringify(finalHealth.enabled));

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  console.log("查出来的问题：");
  for (const p of problems) console.log(`  - ${p}`);
}
const logins = routerLog.split("\n").filter((l) => l.includes("[AUTH]") || l.includes("device"));
if (logins.length) {
  console.log("");
  console.log("（登录相关的日志：应该只有「会话还在」这一类）");
  console.log(logins.slice(0, 8).join("\n"));
}
cleanup();
process.exit(fail === 0 ? 0 : 1);
