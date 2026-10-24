// test/config-restart-check.ts — 配置改完立刻生效，不用重启。
//
//   node --experimental-strip-types test/config-restart-check.ts
//
// 起网关（上游全关，不碰任何平台），用面板的接口改配置，然后：
//
//   1. 改的值进了数据库；
//   2. 读回来是新值，来源是「数据库覆盖」；
//   3. **不用重启**，跑着的进程立刻用新值（上游的模型、前门的钥匙）；
//   4. 改了没有待重启的东西（面板能改的那几个是热的）；
//   5. 重启之后新值还在（值存在数据库里，与热不热无关）；
//   6. 不认识的键、服务内部的键，SetConfig 都要拒绝。
//
// 这个文件原来叫 config-restart-check —— 那时改配置要重启才生效。现在改完
// 就生效，所以它检查的是热加载；重启那部分也还在里面：改的值要经得起重启。

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

/** 根路由公布的模型。 */
async function publishedOnRoot(): Promise<string[]> {
  const res = await fetch(`${base}/v1/models`);
  if (res.status === 404) return [];
  const body = await res.json().catch(() => ({}));
  return (body?.data ?? []).map((m: any) => String(m.id));
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

/** The provider table: one row per provider, with its switch. */
function providerRows(): { id: string; enabled: number }[] {
  const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, enabled FROM provider").all() as any[];
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
// 上游的开关搬到了上游那一页，配置页不再重复一份。
check("配置项只有网关自己的那几个", (configBefore.items ?? []).length === 3, JSON.stringify(keys));
check(
  "公布的是网关自己能改的那几个",
  ["REQUIRE_API_KEY", "ADMIN_CORS_ORIGINS"].every((k) => keys.includes(k)),
  JSON.stringify(keys),
);
check(
  "上游的开关不在配置页里",
  !keys.some((k) => ["MINIMAX_CODE", "QODER_GLOBAL", "QODER_CN", "WORKBUDDY_CN", "TOKENRHYTHM"].includes(k)),
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

const healthBefore = await health();
check("Qoder 现在是关着的", healthBefore.enabled?.qoderGlobal === false, JSON.stringify(healthBefore.enabled));
check(
  "关着的上游不公布模型",
  (await publishedOnRoot()).length === 0,
  JSON.stringify(await publishedOnRoot()),
);

/* ------------------------------------------------------------------ *
 * 二、改一个上游开关：不用重启
 * ------------------------------------------------------------------ */

section("改一个上游开关");

const switched = await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });
check("面板能把上游打开", switched.ok === true, JSON.stringify(switched));
check("改完没有待重启的东西", switched.pendingRestart === false, JSON.stringify(switched));

// The switch lives in the provider table now, not in the config table.
const rows = providerRows();
const qoderRow = rows.find((r) => r.id === "qoder");
check("值进了数据库", qoderRow?.enabled === 1, JSON.stringify(rows));

// 开关不在配置页里（上游那一页管），所以「读回来」问的是上游列表。
const upstreamList = await admin("ListUpstreams");
const qoderUpstream = (upstreamList.upstreams ?? []).find((u: any) => u.id === "qoder");
check("读回来是新值", qoderUpstream?.enabled === true, JSON.stringify(qoderUpstream));
check(
  "配置页里没有上游的开关",
  !(await admin("ListConfig")).items?.some((i: any) => i.key === "QODER_GLOBAL"),
  JSON.stringify((await admin("ListConfig")).items?.map((i: any) => i.key)),
);

check("上游列表里没有待生效的标志", !("pending" in (qoderUpstream ?? {})), JSON.stringify(qoderUpstream));

// 关键：跑着的进程立刻用新值。
const healthAfter = await health();
check(
  "不用重启，/health 里的上游已经开着了",
  healthAfter.enabled?.qoderGlobal === true,
  JSON.stringify(healthAfter.enabled),
);

const qoderModels = await fetch(`${base}/qoder/v1/models`)
  .then((r) => r.json())
  .catch(() => ({}));
check(
  "不用重启，Qoder 的模型目录已经出来了",
  Array.isArray(qoderModels?.data) && qoderModels.data.length > 0,
  JSON.stringify(qoderModels).slice(0, 200),
);

const statusAfter = await admin("GetSystemStatus");
check("pendingRestart 还是假", statusAfter.pendingRestart === false, JSON.stringify(statusAfter.pendingRestart));

/* ------------------------------------------------------------------ *
 * 三、公布的模型：上游开着才公布
 * ------------------------------------------------------------------ */

section("公布的模型");

const saved = await admin("SavePublishedModel", {
  model: {
    id: "hot",
    displayName: "Hot",
    strategy: "single",
    enabled: true,
    targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, enabled: true }],
  },
});
check("面板能保存一个模型", saved.ok === true, JSON.stringify(saved));

const rootModels = await publishedOnRoot();
check("根路由公布了它", rootModels.includes("hot"), JSON.stringify(rootModels));

const listedModels = await admin("ListPublishedModels");
const hot = (listedModels.models ?? []).find((m: any) => m.id === "hot");
check("面板说它已经公布了", hot?.published === true, JSON.stringify(hot));

// 把上游关掉：模型还在库里，但没人能接了。
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: false });
const rootAfterOff = await publishedOnRoot();
check("上游一关，根路由就不公布了", !rootAfterOff.includes("hot"), JSON.stringify(rootAfterOff));
const listedAfterOff = await admin("ListPublishedModels");
const hotAfterOff = (listedAfterOff.models ?? []).find((m: any) => m.id === "hot");
check("面板说它没有公布了", hotAfterOff?.published === false, JSON.stringify(hotAfterOff));
check("模型还在库里", hotAfterOff?.id === "hot", JSON.stringify(hotAfterOff));

// 再打开：立刻又公布了。
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });
const rootAfterOn = await publishedOnRoot();
check("上游再开，根路由又公布了", rootAfterOn.includes("hot"), JSON.stringify(rootAfterOn));
const listedAfterOn = await admin("ListPublishedModels");
check(
  "面板也说它又公布了",
  (listedAfterOn.models ?? []).find((m: any) => m.id === "hot")?.published === true,
  JSON.stringify(listedAfterOn.models),
);

/* ------------------------------------------------------------------ *
 * 四、重启：新值还在
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
  "重启之后新值还在（上游还是开着）",
  afterRestart.enabled?.qoderGlobal === true,
  JSON.stringify(afterRestart.enabled),
);
check(
  "重启之后根路由还公布那个模型",
  (await publishedOnRoot()).includes("hot"),
  JSON.stringify(await publishedOnRoot()),
);

const statusAfterRestart = await admin("GetSystemStatus");
check(
  "重启之后 pendingRestart 又是假",
  statusAfterRestart.pendingRestart === false,
  JSON.stringify(statusAfterRestart.pendingRestart),
);

/* ------------------------------------------------------------------ *
 * 五、改一个别的配置项
 * ------------------------------------------------------------------ */

section("改一个配置项");

const origins = await admin("SetConfig", { key: "ADMIN_CORS_ORIGINS", value: "http://panel.example.test" });
check("面板能改 ADMIN_CORS_ORIGINS", origins.ok === true, JSON.stringify(origins));
check(
  "进了数据库",
  configRows().find((r) => r.key === "ADMIN_CORS_ORIGINS")?.value === "http://panel.example.test",
  JSON.stringify(configRows()),
);
const originsRead = (await admin("ListConfig")).items?.find((i: any) => i.key === "ADMIN_CORS_ORIGINS");
check("读回来是新值", originsRead?.value === "http://panel.example.test", JSON.stringify(originsRead));

// 热加载：不用重启，跨域头立刻就有了。
const cors = await fetch(`${base}${SERVICE}/ListConfig`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin: "http://panel.example.test",
  },
  body: "{}",
});
check(
  "不用重启，允许的来源已经有跨域头了",
  cors.headers.get("access-control-allow-origin") === "http://panel.example.test",
  String(cors.headers.get("access-control-allow-origin")),
);

const corsOther = await fetch(`${base}${SERVICE}/ListConfig`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin: "http://evil.example.test",
  },
  body: "{}",
});
check(
  "不在白名单里的来源没有跨域头",
  !corsOther.headers.get("access-control-allow-origin"),
  String(corsOther.headers.get("access-control-allow-origin")),
);

// 重启之后还是那个值。
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
 * 六、拒绝
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
 * 七、前门的开关：不用重启
 * ------------------------------------------------------------------ */

section("前门的开关");

const requireKey = await admin("SetConfig", { key: "REQUIRE_API_KEY", value: "true" });
check("面板能改 REQUIRE_API_KEY", requireKey.ok === true, JSON.stringify(requireKey));
check("改完没有待重启的东西", requireKey.pendingRestart === false, JSON.stringify(requireKey));

// 不用重启，下一个请求就要钥匙了。
const noKey = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
});
check("不用重启，前门已经要钥匙了", noKey.status === 401, `HTTP ${noKey.status}`);

const withKey = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": CLIENT_KEY },
  body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
});
check("带钥匙就过（只是模型不存在，不是 401）", withKey.status !== 401, `HTTP ${withKey.status}`);

// 收尾：把前门关回去，把 Qoder 也关回去。
await admin("SetConfig", { key: "REQUIRE_API_KEY", value: "false" });
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: false });
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
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail ? 1 : 0);
