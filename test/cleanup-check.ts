// test/cleanup-check.ts — 这一轮清理的自测。
//
//   node --experimental-strip-types test/cleanup-check.ts
//
// 离线：不碰真上游，不发真请求，不花额度。
//
// 覆盖这一轮改掉的五件事：
//
//   1. 用量表里的「模拟客户端」记的是 kind 的名字（qoder 与 qoder-cn 都是
//      「Qoder」），不是上游的 id —— 这一条是真的发一次请求、读数据库里那一行；
//   2. /health 不再有 enabled 段，开关只在 providers 段里；
//   3. 三家平台的 key 管理是一个接口（list/create/delete/ensure）；
//   4. 模型目录的缓存是一份，缓存到期才问上游，空清单不写进去；
//   5. 开放平台的推理：没有 key 与 401 两种错误。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-check-"));
process.env.BUDDY_DATA_DIR = tmp;

/** 一个假端口。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 假的 SenseNova 控制台。
 *
 * 控制台的地址是在模块加载时读进常量的，所以这个地址必须在导入
 * lib/sensenova/keys.ts 之前设好 —— 下面的 import 都是动态的，正好。
 */
const CONSOLE_PORT = await freePort();
let lastCreateBody: any = null;
const console_ = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    if (req.method === "POST") lastCreateBody = body;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        api_key: {
          id: "key-1",
          displayname: String(body?.displayname ?? ""),
          key_type: String(body?.key_type ?? ""),
          api_key: "sk-1234567890abcdef",
          status: "ACTIVE",
        },
      }),
    );
  });
});
await new Promise<void>((resolve) => console_.listen(CONSOLE_PORT, "127.0.0.1", resolve));
process.env.SENSENOVA_PLATFORM_BASE = `http://127.0.0.1:${CONSOLE_PORT}`;

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
 * 一、模拟客户端的名字
 * ------------------------------------------------------------------ */

section("用量表里的「模拟客户端」");

const { recordUsage, listUsage } = await import("../lib/usage.ts");

recordUsage({
  upstreamId: "qoder-cn",
  upstreamModel: "glm-5.3",
  agentModel: "glm-5.3",
  agent: "pi",
  sessionId: "s1",
  parentSessionId: "",
  agentName: "",
  // 模拟端的名字：Qoder 的中国区与国际区是同一个模拟端。
  client: "Qoder",
  ok: true,
  status: 200,
  promptTokens: 1,
  completionTokens: 1,
  reasoningTokens: 0,
  latencyMs: 1,
  error: "",
});

const events = listUsage();
check("记下一条", events.length === 1, String(events.length));
check("模拟客户端是 Qoder", events[0]?.client === "Qoder", String(events[0]?.client));
check(
  "模拟客户端与上游 id 是两回事",
  events[0]?.client !== events[0]?.upstreamId,
  `${events[0]?.client} vs ${events[0]?.upstreamId}`,
);

/* ------------------------------------------------------------------ *
 * 二、kind 注册表里的名字
 * ------------------------------------------------------------------ */

section("kind 注册表里的 label");

await import("../lib/kinds.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");

check("Qoder 的 label 是 Qoder", kindOf("qoder")?.label === "Qoder", String(kindOf("qoder")?.label));
check(
  "WorkBuddy 的 label 是 WorkBuddy",
  kindOf("workbuddy")?.label === "WorkBuddy",
  String(kindOf("workbuddy")?.label),
);
check(
  "MiniMax Code 与 MiniMax 开放平台是两个名字",
  kindOf("minimax")?.label !== kindOf("minimax-api")?.label,
  `${kindOf("minimax")?.label} / ${kindOf("minimax-api")?.label}`,
);

// 「qoder 与 qoder-cn 是同一个模拟端」这句话本身：两个上游的 id 不同，
// 但它们是同一个 kind，所以模拟端的名字也一样。
const { providerKindOf } = await import("../lib/providers.ts");
check(
  "qoder-cn 的上游 id 是 qoder-cn",
  providerKindOf("qoder-cn") !== null,
  String(providerKindOf("qoder-cn")),
);
check(
  "qoder-cn 的 label 也是 Qoder（与 qoder 同一个模拟端）",
  providerKindOf("qoder-cn")?.label === "Qoder",
  String(providerKindOf("qoder-cn")?.label),
);
check(
  "两个上游的 label 一样，id 不一样",
  providerKindOf("qoder-cn")?.label === providerKindOf("qoder")?.label &&
    providerKindOf("qoder-cn")?.kind !== providerKindOf("qoder-cn")?.label,
  `${providerKindOf("qoder-cn")?.kind} / ${providerKindOf("qoder-cn")?.label}`,
);

/* ------------------------------------------------------------------ *
 * 三、路由层写进用量表的是 label，不是上游 id
 * ------------------------------------------------------------------ */

// 上面的断言是「自己写进去再读回来」，那证明不了路由层写的是哪一样。
// 这里真的起一个网关，让它把一条请求发到 qoder-cn（中国区），然后读
// 数据库里那一行：client 那一列必须是「Qoder」，不能是上游的 id
// 「qoder-cn」。

section("路由层写进用量表的是模拟端的名字");

const ROUTER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-router-"));

const UPSTREAM_PORT = await freePort();

/**
 * 假的中国区上游。
 *
 * 中国区说的是老协议：帧是 `data:{"body":"<json>"}`，body 里面是 OpenAI
 * 的 chunk。这里答两帧：一帧带内容，一帧带 usage。
 */
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (body: unknown) =>
      res.write(
        `data:${JSON.stringify({
          headers: { "Content-Type": ["application/json"] },
          body: JSON.stringify(body),
          statusCodeValue: 200,
          statusCode: "OK",
        })}\n\n`,
      );
    frame({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gmodel",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
    });
    frame({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gmodel",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    res.end();
  });
});
await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

// 假会话：qoder-cn 的那一行。
const seeded = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "test/fake-sessions.ts"],
  {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: ROUTER_DIR, TEST_UPSTREAMS: "qoder-cn" },
    encoding: "utf8",
  },
);
if (seeded.status !== 0) {
  throw new Error(`the dummy session could not be written: ${seeded.stderr}`);
}

const ROUTER_PORT = await freePort();
const BASE = `http://127.0.0.1:${ROUTER_PORT}`;

const router: ChildProcess = spawn(process.execPath, ["router-proxy.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    BUDDY_DATA_DIR: ROUTER_DIR,
    ROUTER_PORT: String(ROUTER_PORT),
    BENEFITS_DISABLED: "1",
    // 中国区上游指到本机的假上游：一个字都不出机器。
    QODER_CN_INFER_BASE: `http://127.0.0.1:${UPSTREAM_PORT}`,
    QODER_CN_OPENAPI_BASE: `http://127.0.0.1:${UPSTREAM_PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let routerLog = "";
router.stdout?.on("data", (c) => routerLog += c.toString());
router.stderr?.on("data", (c) => routerLog += c.toString());
process.on("exit", () => {
  try {
    router.kill("SIGTERM");
  } catch {
    /* 已经走了 */
  }
});

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        await res.text();
        return;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the router did not come up:\n${routerLog.slice(-2000)}`);
}

await waitHealthy();

// 面板的令牌：开关现在在数据库里，要用面板把它打开。
const adminToken = fs.readFileSync(path.join(ROUTER_DIR, "admin-token"), "utf8").trim();
const switched = await fetch(`${BASE}/buddy.admin.v1.AdminService/SetUpstreamEnabled`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
  body: JSON.stringify({ upstreamId: "qoder-cn", enabled: true }),
}).then((r) => r.json().catch(() => null));
check("qoder-cn 打开了", switched?.ok === true, JSON.stringify(switched));

const answered = await fetch(`${BASE}/qoder-cn/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "glm-5.3",
    max_tokens: 32,
    messages: [{ role: "user", content: "say ok" }],
  }),
});
const answerBody = await answered.text();
check("请求走通了", answered.status === 200, `HTTP ${answered.status} ${answerBody.slice(0, 160)}`);

// 读数据库里那一行：client 必须是「Qoder」，upstream_id 是「qoder-cn」。
const routerDb = new DatabaseSync(path.join(ROUTER_DIR, "buddy.db"), { readOnly: true });
const rows = routerDb
  .prepare("SELECT upstream_id, client FROM usage_event ORDER BY id DESC LIMIT 5")
  .all() as any[];
routerDb.close();

const row = rows.find((r) => r.upstream_id === "qoder-cn");
check("用量表里有一行 qoder-cn 的", Boolean(row), JSON.stringify(rows));
check("那一行的 client 是 Qoder（不是上游 id）", row?.client === "Qoder", JSON.stringify(row));
check("那一行的 upstream_id 是 qoder-cn", row?.upstream_id === "qoder-cn", JSON.stringify(row));
check(
  "两列不一样：模拟端的名字与上游的 id 是两回事",
  row?.client !== row?.upstream_id,
  `${row?.client} vs ${row?.upstream_id}`,
);

try {
  router.kill("SIGTERM");
} catch {
  /* 已经走了 */
}
upstream.close();
fs.rmSync(ROUTER_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 四、三家平台的 key 管理是一个接口
 * ------------------------------------------------------------------ */

section("key 管理的统一接口");

const { senseNovaKeys } = await import("../lib/sensenova/keys.ts");
const { internAiKeys } = await import("../lib/intern-ai/keys.ts");
const { tokenRhythmKeys } = await import("../lib/tokenrhythm/keys.ts");

const platforms = [
  ["SenseNova", senseNovaKeys],
  ["书生·端砚", internAiKeys],
  ["TokenRhythm", tokenRhythmKeys],
] as const;

for (const [name, keys] of platforms) {
  check(
    `${name}：list/create/delete/ensure 都在`,
    ["list", "create", "delete", "ensure"].every((k) => typeof (keys as any)[k] === "function"),
    Object.keys(keys).join(","),
  );
  check(`${name}：有名字`, typeof keys.what === "string" && keys.what.length > 0, String(keys.what));
}

// SenseNova 的 create 认 ctx.keyType：同一族接口里 ensure 认、create 也认，
// 形状才是一套（这一轮改的）。
const { KEY_TYPE_METERED, KEY_TYPE_TOKEN_PLAN } = await import("../lib/sensenova/keys.ts");
const fakeSession = {
  cookie: "c",
  accessToken: "t",
  refreshToken: "r",
  expiresAtMs: Date.now() + 3_600_000,
  obtainedAtMs: Date.now(),
  username: "u",
};
await senseNovaKeys.create({ session: fakeSession, keyType: KEY_TYPE_METERED }, "buddy");
check(
  "create 把 ctx.keyType 传给了平台",
  lastCreateBody?.key_type === KEY_TYPE_METERED,
  JSON.stringify(lastCreateBody),
);
await senseNovaKeys.create({ session: fakeSession }, "buddy");
check(
  "ctx 里没有 keyType 时用默认的（积分池）",
  lastCreateBody?.key_type === KEY_TYPE_TOKEN_PLAN,
  JSON.stringify(lastCreateBody),
);
console_.close();

/* ------------------------------------------------------------------ *
 * 五、模型目录的缓存
 * ------------------------------------------------------------------ */

section("模型目录的缓存");

const { CatalogCache } = await import("../lib/router/catalog-cache.ts");

const cache = new CatalogCache<string>(60_000);
check("一开始是空的", cache.list().length === 0, String(cache.list().length));
check("空的缓存是要问上游的", cache.stale() === true);

check("空的清单不记下来", cache.update([]) === false);
check("还是空的", cache.list().length === 0);

check("有内容的才记", cache.update(["a", "b"]) === true);
check("记下来了", cache.list().join(",") === "a,b", cache.list().join(","));
check("刚问过不用再问", cache.stale() === false);
check("强要刷新就刷新", cache.stale(true) === true);

// 空清单被拒之后，TTL 不重置 —— 端砚原来的「空目录也写进去并重置 TTL」
// 就是靠这条改掉的：问空了不能把缓存当成刚问过的。
const ttl = new CatalogCache<string>(1);
ttl.update(["a"]);
check("刚记下的时候不用再问", ttl.stale() === false);
await new Promise((r) => setTimeout(r, 20));
check("过了有效期要再问", ttl.stale() === true);
check("空清单被拒", ttl.update([]) === false);
check("被拒之后还是要问（TTL 没被重置）", ttl.stale() === true, String(ttl.stale()));
check("被拒之后旧的那份还在", ttl.list().join(",") === "a", ttl.list().join(","));

/* ------------------------------------------------------------------ *
 * 六、开放的推理调用
 * ------------------------------------------------------------------ */

section("开放平台的推理调用");

const { openAiPlatformChat } = await import("../lib/router/openai-platform.ts");
const { AuthError } = await import("../lib/credential.ts");

let caught: any = null;
try {
  await openAiPlatformChat(
    { id: "sensenova", label: "SenseNova", base: "http://127.0.0.1:1/v1", key: "" },
    { model: "x" },
  );
} catch (e) {
  caught = e;
}
check("没有推理 key 就报错", caught instanceof AuthError, String(caught));
check(
  "错误里说的是没有 key",
  String(caught?.message).includes("no inference key"),
  String(caught?.message),
);
check("提示里说的是平台的名字", String(caught?.hint).includes("SenseNova"), String(caught?.hint));

// 401 特判：这一轮把它从两个 transport 搬到了 openai-platform.ts，
// 搬完得有人看着。
const REJECT_PORT = await freePort();
const rejecting = http.createServer((req, res) => {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "invalid api key" } }));
});
await new Promise<void>((resolve) => rejecting.listen(REJECT_PORT, "127.0.0.1", resolve));

let rejected: any = null;
try {
  await openAiPlatformChat(
    {
      id: "sensenova",
      label: "SenseNova",
      base: `http://127.0.0.1:${REJECT_PORT}/v1`,
      key: "sk-not-accepted",
    },
    { model: "x" },
  );
} catch (e) {
  rejected = e;
}
check("上游答 401 就报错", rejected instanceof AuthError, String(rejected));
check("客户端拿到的是 502", rejected?.status === 502, String(rejected?.status));
check(
  "提示里说的是 401",
  String(rejected?.hint).includes("HTTP 401"),
  String(rejected?.hint),
);
check(
  "提示里说的是平台的名字",
  String(rejected?.hint).includes("SenseNova"),
  String(rejected?.hint),
);
rejecting.close();

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
