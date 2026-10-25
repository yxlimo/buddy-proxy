// test/catalog-parity-check.ts — 面板上的主路由模型，与根路由公布的，是同一套算出来的。
//
//   node --experimental-strip-types test/catalog-parity-check.ts
//
// 面板上每个主路由模型都写着它能用多少上下文、多少输出 token、哪些思考档位。
// 根路由的 /v1/models 公布同一批模型。两者必须一致 —— 不是「看起来一致」，
// 是同一个函数算出来的同一个数。
//
// 这个测试起一个网关（上游只开 Qoder，用它自己那份模型目录），配几个主路由
// 模型，然后把两边的数拿来比。
//
// 面板上有两个数：contextWindow 是**库里存的那个**（继承时是空的），effective
// 是**现算出来的**（继承时就是目标合出来的那个）。根路由公布的是现算的那个，
// 所以比的是 effective 与根路由 —— 拿 contextWindow 去比会以为两边不一致，
// 其实面板只是把「存着的」与「算出来的」分开报。

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const DATA_DIR = "/tmp/opencode/test-catalog-parity";

/** A free port: the tests run in parallel, so nobody gets a fixed one. */
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

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// The router wants a credential for every upstream it serves: without one it
// starts the device flow, which opens a browser and asks qoder.com for a
// challenge. The dummy sessions go into this test's own database.
const fakeSessions = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "test/fake-sessions.ts"],
  { cwd: ROOT, env: { ...process.env, BUDDY_DATA_DIR: DATA_DIR }, stdio: "ignore" },
);
if (fakeSessions.status !== 0) {
  throw new Error("the dummy sessions could not be written");
}

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
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

const router: ChildProcess = spawn(process.execPath, ["router-proxy.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    BUDDY_DATA_DIR: DATA_DIR,
    ROUTER_PORT: String(PORT),
    BENEFITS_DISABLED: "1",
    // 上游的开关不在环境里了：它在数据库的 provider.enabled 上。
    // 下面用面板的 SetUpstreamEnabled 把 Qoder 打开（它用自己那份模型目录，
    // 参数是现成的）。
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let routerLog = "";
router.stdout?.on("data", (c) => (routerLog += c.toString()));
router.stderr?.on("data", (c) => (routerLog += c.toString()));

process.on("exit", () => router.kill());

async function waitForRouter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.status) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the router did not come up:\n${routerLog.slice(-2000)}`);
}

async function adminToken(): Promise<string> {
  return fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();
}

async function call(method: string, body: unknown = {}): Promise<any> {
  const token = await adminToken();
  const r = await fetch(`${BASE}/buddy.admin.v1.AdminService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** The panel's view of one published model. */
async function panelModel(id: string): Promise<any> {
  const listed = await call("ListPublishedModels");
  return (listed.body?.models ?? []).find((m: any) => m.id === id);
}

/** The root route's view of one published model. */
async function rootModel(id: string): Promise<any> {
  const body = await (await fetch(`${BASE}/v1/models`)).json();
  return (body.data ?? []).find((m: any) => m.id === id);
}

await waitForRouter();

/**
 * 启动不再插行：新库里一个账号都没有。面板上做的是「加一个账号」，这里照做。
 *
 * 新账号是开着的，所以加完平台就是开着的 —— 面板上的开关改的也是这一行。
 */
const qoderOn = await call("AddAccount", { platform: "qoder", alias: "测试 Qoder" });
check("Qoder 的账号加出来了", qoderOn.body?.ok === true, JSON.stringify(qoderOn.body));
const platformOn = await call("ListUpstreams");
check(
  "Qoder 打开了",
  (platformOn.body?.upstreams ?? []).find((u: any) => u.id === "qoder")?.enabled === true,
  JSON.stringify(platformOn.body).slice(0, 200),
);

/* ------------------------------------------------------------------ *
 * 一、继承来的数
 * ------------------------------------------------------------------ */

console.log("主路由模型继承来的参数");

const save = await call("SavePublishedModel", {
  model: {
    id: "parity-inherit",
    displayName: "继承",
    strategy: "single",
    enabled: true,
    targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
  },
});
check("模型存得进去", save.status === 200 && save.body?.ok === true, JSON.stringify(save.body));

const model = await panelModel("parity-inherit");
check("模型列得出来", Boolean(model), JSON.stringify(model));
check(
  "上下文是继承来的那个（GLM-5.3 的 180000）",
  Number(model?.effective?.contextWindow) === 180000,
  JSON.stringify({ effective: model?.effective?.contextWindow }),
);
check(
  "输出上限是继承来的那个（GLM-5.3 的 131072）",
  Number(model?.effective?.maxOutputTokens) === 131072,
  JSON.stringify({ effective: model?.effective?.maxOutputTokens }),
);
// 继承就是继承：库里存的那个是空的。把现算的值写回库里，「继承」就变成了
// 写死的数字，上游改了也不跟着动（2026-10-24 修过的那个坑）。
check(
  "继承时库里存的那个是空的",
  model?.contextWindow === undefined && model?.maxOutputTokens === undefined,
  JSON.stringify({ contextWindow: model?.contextWindow, maxOutputTokens: model?.maxOutputTokens }),
);

/* ------------------------------------------------------------------ *
 * 二、根路由公布的，就是这些数
 * ------------------------------------------------------------------ */

console.log("");
console.log("根路由公布的");

const root = await rootModel("parity-inherit");
check("根路由公布了它", Boolean(root), JSON.stringify(root));
check(
  "根路由的上下文窗口与面板的一样",
  Number(root?.context_window) === Number(model?.effective?.contextWindow),
  JSON.stringify({ root: root?.context_window, panel: model?.effective?.contextWindow }),
);
check(
  "根路由的输出上限与面板的一样",
  Number(root?.max_output_tokens) === Number(model?.effective?.maxOutputTokens),
  JSON.stringify({ root: root?.max_output_tokens, panel: model?.effective?.maxOutputTokens }),
);
check(
  "显示名也一样",
  root?.display_name === model?.displayName,
  JSON.stringify({ root: root?.display_name, panel: model?.displayName }),
);
check(
  "思考能力也一样",
  Boolean(root?.reasoning) === Boolean(model?.effective?.reasoning),
  JSON.stringify({ root: root?.reasoning, panel: model?.effective?.reasoning }),
);

/* ------------------------------------------------------------------ *
 * 三、几个目标不一致时，取最保守的那个
 * ------------------------------------------------------------------ */

console.log("");
console.log("几个目标不一致时");

await call("SavePublishedModel", {
  model: {
    id: "parity-min",
    displayName: "取最小",
    strategy: "fallback",
    enabled: true,
    targets: [
      { groupName: "qoder", upstreamModel: "deepseek-v4-pro", weight: 1, position: 0, enabled: true },
      { groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 1, enabled: true },
    ],
  },
});
const minModel = await panelModel("parity-min");
check(
  "上下文取最小的那个（180000，不是 1000000）",
  Number(minModel?.effective?.contextWindow) === 180000,
  JSON.stringify({ effective: minModel?.effective?.contextWindow }),
);
check(
  "输出上限取最小的那个（131072，不是 393216）",
  Number(minModel?.effective?.maxOutputTokens) === 131072,
  JSON.stringify({ effective: minModel?.effective?.maxOutputTokens }),
);

const minRoot = await rootModel("parity-min");
check(
  "根路由公布的也是最小值",
  Number(minRoot?.context_window) === 180000 && Number(minRoot?.max_output_tokens) === 131072,
  JSON.stringify(minRoot),
);

/* ------------------------------------------------------------------ *
 * 四、自己写死的数，就是自己写死的
 * ------------------------------------------------------------------ */

console.log("");
console.log("自己写死的数");

await call("SavePublishedModel", {
  model: {
    id: "parity-explicit",
    displayName: "写死",
    strategy: "single",
    enabled: true,
    contextWindow: 123456,
    maxOutputTokens: 6543,
    targets: [{ groupName: "qoder", upstreamModel: "deepseek-v4-pro", weight: 1, position: 0, enabled: true }],
  },
});
const explicitModel = await panelModel("parity-explicit");
check(
  "面板上是自己写的数",
  Number(explicitModel?.contextWindow) === 123456 && Number(explicitModel?.maxOutputTokens) === 6543,
  JSON.stringify(explicitModel),
);
// 自己写死的数就是那个数，现算出来的也是它。
check(
  "现算出来的也是自己写的那个数",
  Number(explicitModel?.effective?.contextWindow) === 123456 &&
    Number(explicitModel?.effective?.maxOutputTokens) === 6543,
  JSON.stringify(explicitModel?.effective),
);
const explicitRoot = await rootModel("parity-explicit");
check(
  "根路由公布的也是自己写的数",
  Number(explicitRoot?.context_window) === 123456 && Number(explicitRoot?.max_output_tokens) === 6543,
  JSON.stringify(explicitRoot),
);

/* ------------------------------------------------------------------ *
 * 五、停用的模型不在根路由里
 * ------------------------------------------------------------------ */

console.log("");
console.log("停用的模型");

await call("SavePublishedModel", {
  model: {
    id: "parity-off",
    displayName: "停用",
    strategy: "single",
    enabled: false,
    targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
  },
});
const offModel = await panelModel("parity-off");
check("面板上列着它", Boolean(offModel), JSON.stringify(offModel));
check("但没公布", offModel?.published === false, JSON.stringify(offModel));
check(
  "根路由里没有它",
  (await rootModel("parity-off")) === undefined,
  JSON.stringify(await rootModel("parity-off")),
);

/* ------------------------------------------------------------------ *
 * 六、这个测试不碰任何平台
 * ------------------------------------------------------------------ */

console.log("");
console.log("这个测试不碰任何平台");

check(
  "没有启动设备登录",
  !/device\/selectAccounts|open in a browser/.test(routerLog),
  routerLog.slice(-400),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
if (fail) {
  console.log(routerLog.slice(-3000));
  process.exit(1);
}
process.exit(0);
