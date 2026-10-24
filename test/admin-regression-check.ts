// test/admin-regression-check.ts — 面板那批改动之后，代理的路还通不通。
//
//   node --experimental-strip-types test/admin-regression-check.ts
//
// 上游指着 mock server（回放录下来的真实答复），所以这一轮不碰任何平台，
// 也不花 token。查的是四件事：两种方言答得上、流式答得上而且状态码是 200、
// 公布的模型从根路由走得通、面板的用量明细有数据。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-admin-regression";
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

const mockPort = await freePort();
const routerPort = await freePort();
const base = `http://127.0.0.1:${routerPort}`;

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// The sessions the requests need go into the test's own database. The mock
// upstream does not look at the credential, but the router does: without a
// session there is nothing to send.
//
// The store reads the data directory from the environment when it is imported,
// so the environment has to point there first — otherwise this would write into
// the machine's own database.
process.env.BUDDY_DATA_DIR = DATA_DIR;
const { setSecret } = await import("../lib/store.ts");
{
  const now = Date.now();
  setSecret("session:provider:qoder", "session", {
    schemaVersion: 1,
    region: "global",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    accessToken: "dt-test-token",
    refreshToken: "drt-test-token",
    userId: "test-user",
    expiresAtMs: now + 365 * 24 * 3600 * 1000,
    refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
    machineId: "test-machine",
    machineToken: "test-machine-token",
    machineType: "test",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  });
  setSecret("session:provider:workbuddy-cn", "session", {
    accessToken: "wb-test-token",
    refreshToken: "wb-test-refresh",
    uid: "test-user",
    nickname: "tester",
    domain: "127.0.0.1",
    region: "cn",
    generation: 1,
    expiresAtMs: now + 365 * 24 * 3600 * 1000,
    refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
    loginAtMs: now,
    refreshedAtMs: now,
  });
}

const mock = spawn(process.execPath, ["--experimental-strip-types", "test/mock-server.ts", String(mockPort)], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let mockLog = "";
mock.stdout.on("data", (c: Buffer) => {
  mockLog += c.toString();
});
mock.stderr.on("data", (c: Buffer) => {
  mockLog += c.toString();
});

// 路由器用 test/run-router.sh 起：上游的地址都指着 mock server。
const router = spawn("bash", ["test/run-router.sh", String(routerPort), `http://127.0.0.1:${mockPort}`], {
  cwd: ROOT,
  env: { ...process.env, BUDDY_DATA_DIR: DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
let routerLog = "";
router.stdout.on("data", (c: Buffer) => {
  routerLog += c.toString();
});
router.stderr.on("data", (c: Buffer) => {
  routerLog += c.toString();
});

const cleanup = () => {
  for (const child of [router, mock]) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已经走了 */
    }
  }
};
process.on("exit", cleanup);

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        await res.text();
        return true;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!(await waitForHealth())) {
  console.log("  FAIL 网关没起来");
  console.log(routerLog.slice(-1500));
  console.log(mockLog.slice(-500));
  process.exit(1);
}

const tokenFile = path.join(DATA_DIR, "admin-token");
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

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

/** 打一次代理的请求。 */
async function proxy(
  p: string,
  body: unknown,
): Promise<{ status: number; type: string; text: string }> {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", text };
}

/** SSE 帧。 */
function frames(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

console.log("");
console.log("增删 Provider");

// 加一个 provider，删掉它，然后确认它真的没了 —— 而且再刷一次也没回来。
const added = await call("AddProvider", { id: "regression-provider", kind: "minimax-api", alias: "回归用" });
check("加了一个 Provider", added.body?.ok === true, JSON.stringify(added.body));

const afterAdd = await call("ListUpstreams", {});
const afterAddRows = (afterAdd.body?.upstreams ?? []) as any[];
check(
  "列表里有它",
  afterAddRows.some((u: any) => u.id === "regression-provider"),
  JSON.stringify(afterAddRows.map((u: any) => u.id)),
);

// 注销一个没有凭据的账号：说清楚，不报错。
const loggedOut = await call("LogoutAccount", { accountId: "regression-provider" });
check("注销了一个账号", loggedOut.body?.ok === true, JSON.stringify(loggedOut.body));

const deleted = await call("DeleteProvider", { id: "regression-provider" });
check("删掉了", deleted.body?.ok === true, JSON.stringify(deleted.body));

const afterDelete = await call("ListUpstreams", {});
const afterDeleteRows = (afterDelete.body?.upstreams ?? []) as any[];
check(
  "列表里没有它了",
  !afterDeleteRows.some((u: any) => u.id === "regression-provider"),
  JSON.stringify(afterDeleteRows.map((u: any) => u.id)),
);

const afterDeleteAgain = await call("ListUpstreams", {});
check(
  "再刷一次它也没回来",
  !((afterDeleteAgain.body?.upstreams ?? []) as any[]).some(
    (u: any) => u.id === "regression-provider",
  ),
  JSON.stringify((afterDeleteAgain.body?.upstreams ?? []).map((u: any) => u.id)),
);

// 删一个内置的：它也不能在刷新之后自己回来。
const builtin = await call("DeleteProvider", { id: "zcode" });
check("删掉一个内置的", builtin.body?.ok === true, JSON.stringify(builtin.body));
const afterBuiltin = await call("ListUpstreams", {});
check(
  "内置的那个删掉之后也没回来",
  !((afterBuiltin.body?.upstreams ?? []) as any[]).some((u: any) => u.id === "zcode"),
  JSON.stringify((afterBuiltin.body?.upstreams ?? []).map((u: any) => u.id)),
);
// 放回去，后面的测试还要用它。
await call("AddProvider", { id: "zcode", kind: "zcode", alias: "ZCode" });

console.log("");
console.log("代理的路");

const health = await fetch(`${base}/health`);
check("/health 答得上来", health.status === 200, String(health.status));
const healthBody = await health.json().catch(() => null);

// The provider list: the unique id (the path segment) and the name the user
// gave it. The client scripts read it from here, so it has to be complete --
// a provider the user added is in it too.
const providerRows = healthBody?.providers;
check("/health 里有 provider 清单", Array.isArray(providerRows) && providerRows.length > 0, String(providerRows?.length));
check(
  "每个 provider 都有唯一 id 和名字",
  Array.isArray(providerRows) &&
    providerRows.every((p: any) => typeof p?.id === "string" && p.id && typeof p?.name === "string" && p.name),
  JSON.stringify(providerRows?.slice(0, 2)),
);
check(
  "唯一 id 是路径里能用的那种",
  Array.isArray(providerRows) && providerRows.every((p: any) => /^[a-z0-9][a-z0-9-]*$/.test(p?.id ?? "")),
  JSON.stringify(providerRows?.map((p: any) => p?.id)?.slice(0, 4)),
);

// The health carries what the snapshot knows. The snapshot is keyed by the
// provider id, so reading it by the kind silently gives null for everything.
const healthUpstreams = healthBody?.upstreams ?? {};
const relay = healthUpstreams?.tokenrhythm ?? {};
check(
  "开着的上游那一段有凭据",
  relay?.enabled === false || relay?.credential?.status !== undefined,
  JSON.stringify(relay),
);
// 快照里那个 Provider 的那一份，health 读的就是它。
const snapshotRelay = (healthBody?.snapshot?.tokenrhythm ?? {})["tokenrhythm"] ?? {};
check(
  "health 里的租户就是快照里那一份",
  JSON.stringify(relay?.tenants ?? null) === JSON.stringify(snapshotRelay.tenants ?? null),
  JSON.stringify({ health: relay?.tenants, snapshot: snapshotRelay.tenants }),
);

const models = await fetch(`${base}/qoder/v1/models`);
const modelsBody = await models.json().catch(() => null);
check("GET /qoder/v1/models 答得上来", models.status === 200, String(models.status));
check("模型列表不是空的", Array.isArray(modelsBody?.data) && modelsBody.data.length > 0, String(modelsBody?.data?.length));

// 根路由在还没有公布的模型时说的话。
const rootModels = await fetch(`${base}/v1/models`);
const rootModelsText = await rootModels.text();
check("根路由没有公布的模型时是 404", rootModels.status === 404, String(rootModels.status));
check("根路由说的是没有公布的模型", rootModelsText.includes("no published models"), rootModelsText.slice(0, 120));

// OpenAI 方言：非流式。
const openaiBody = { model: "glm-5.3", max_tokens: 32, stream: false, messages: [{ role: "user", content: "say ok" }] };
const openai = await proxy("/qoder/v1/chat/completions", openaiBody);
check("POST /qoder/v1/chat/completions 答得上来", openai.status >= 200 && openai.status < 300, String(openai.status));
const openaiJson = JSON.parse(openai.text || "{}");
check("OpenAI 方言有 choices", Array.isArray(openaiJson?.choices) && openaiJson.choices.length > 0, openai.text.slice(0, 120));
check("OpenAI 方言带用量", (openaiJson?.usage?.prompt_tokens ?? 0) > 0, JSON.stringify(openaiJson?.usage));

// Anthropic 方言：非流式。
const anthropicBody = { model: "glm-5.3", max_tokens: 32, stream: false, messages: [{ role: "user", content: "say ok" }] };
const anthropic = await proxy("/qoder/v1/messages", anthropicBody);
check("POST /qoder/v1/messages 答得上来", anthropic.status >= 200 && anthropic.status < 300, String(anthropic.status));
const anthropicJson = JSON.parse(anthropic.text || "{}");
check("Anthropic 方言有 content", Array.isArray(anthropicJson?.content) && anthropicJson.content.length > 0, anthropic.text.slice(0, 120));
check("Anthropic 方言带用量", (anthropicJson?.usage?.input_tokens ?? 0) > 0, JSON.stringify(anthropicJson?.usage));

// 流式：状态码必须是 200，不是 404。
for (const [name, p] of [
  ["OpenAI", "/qoder/v1/chat/completions"],
  ["Anthropic", "/qoder/v1/messages"],
] as const) {
  const res = await proxy(p, { ...openaiBody, stream: true });
  check(`${name} 流式的状态码是 200`, res.status === 200, String(res.status));
  check(`${name} 流式的是 SSE`, res.type.includes("text/event-stream"), res.type);
  const data = frames(res.text);
  check(`${name} 流式有帧`, data.length > 0, `${data.length} 帧`);
  // OpenAI 方言以 [DONE] 收尾，Anthropic 方言以 message_stop 收尾。
  const last = data[data.length - 1] ?? "";
  const endsRight =
    name === "OpenAI" ? last === "[DONE]" : last.includes("message_stop");
  check(`${name} 流式的收尾帧是对的`, endsRight, last.slice(0, 60));
  let bad = "";
  for (const frame of data) {
    if (frame === "[DONE]") continue;
    try {
      JSON.parse(frame);
    } catch {
      bad = frame.slice(0, 60);
      break;
    }
  }
  check(`${name} 流式的帧都是 JSON`, bad === "", bad);
}

// 根路由的 Anthropic 方言：它说得两种方言了（只有面板发布出来的模型）。
const rootAnthropic = await proxy("/v1/messages", anthropicBody);
check("POST /v1/messages 是 404（没有发布出来的模型）", rootAnthropic.status === 404, String(rootAnthropic.status));
check(
  "POST /v1/messages 说清楚了是哪个模型",
  rootAnthropic.text.includes("unknown model"),
  rootAnthropic.text.slice(0, 160),
);

console.log("");
console.log("公布的模型从根路由走");

const save = await call("SavePublishedModel", {
  model: {
    id: "regression-model",
    displayName: "回归测试",
    strategy: "single",
    enabled: true,
    targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
  },
});
check("模型存得进去", save.body?.ok === true, JSON.stringify(save.body));

const publishedModels = await fetch(`${base}/v1/models`);
const publishedBody = await publishedModels.json().catch(() => null);
check("GET /v1/models 答得上来", publishedModels.status === 200, String(publishedModels.status));
check(
  "公布的模型在列表里",
  Array.isArray(publishedBody?.data) && publishedBody.data.some((m: any) => m.id === "regression-model"),
  JSON.stringify(publishedBody?.data),
);

const rootOpenai = await proxy("/v1/chat/completions", { ...openaiBody, model: "regression-model" });
check("POST /v1/chat/completions（根路由）答得上来", rootOpenai.status >= 200 && rootOpenai.status < 300, `${rootOpenai.status} ${rootOpenai.text.slice(0, 120)}`);
const rootOpenaiJson = JSON.parse(rootOpenai.text || "{}");
check("根路由的答复有 choices", Array.isArray(rootOpenaiJson?.choices) && rootOpenaiJson.choices.length > 0, rootOpenai.text.slice(0, 120));

const rootStream = await proxy("/v1/chat/completions", { ...openaiBody, model: "regression-model", stream: true });
check("根路由流式的状态码是 200", rootStream.status === 200, String(rootStream.status));
check("根路由流式的是 SSE", rootStream.type.includes("text/event-stream"), rootStream.type);
const rootFrames = frames(rootStream.text);
check("根路由流式有帧", rootFrames.length > 0, `${rootFrames.length} 帧`);
check("根路由流式以 [DONE] 收尾", rootFrames[rootFrames.length - 1] === "[DONE]", rootFrames[rootFrames.length - 1]?.slice(0, 60) ?? "");

const status = await call("GetSystemStatus");
check("公布的模型数是一个", status.body?.publishedModelCount === 1, String(status.body?.publishedModelCount));

console.log("");
console.log("面板的用量明细");

const events = await call("ListUsageEvents", { limit: 100 });
const rows: any[] = Array.isArray(events.body?.events) ? events.body.events : [];
check("用量明细有数据", rows.length > 0, `${rows.length} 行`);
if (rows.length) {
  check("明细带 ts", rows.every((r) => Number(r.ts) > 1_000_000_000_000), JSON.stringify(rows.map((r) => r.ts)));
  check(
    "明细记着模拟的是哪个客户端",
    rows.every((r) => typeof r.client === "string" && r.client.length > 0),
    JSON.stringify(rows.map((r) => r.client)),
  );
  check(
    "明细记着是谁发来的请求",
    rows.every((r) => typeof r.agent === "string" && r.agent.length > 0),
    JSON.stringify(rows.map((r) => r.agent)),
  );
  check("明细带着上游与模型", rows.every((r) => r.upstreamId && r.model), JSON.stringify(rows.map((r) => [r.upstreamId, r.model])));

  // 游标：一页一页往前翻，不重不漏。
  const pageSize = 1;
  const seen: string[] = [];
  let cursor = 0;
  for (let i = 0; i < rows.length + 2; i++) {
    const page = await call("ListUsageEvents", { limit: pageSize, ...(cursor ? { beforeId: String(cursor) } : {}) });
    const batch: any[] = Array.isArray(page.body?.events) ? page.body.events : [];
    if (!batch.length) break;
    seen.push(...batch.map((e) => String(e.id)));
    cursor = BigInt(batch[batch.length - 1].id);
  }
  check("游标翻页拿到的条数一样多", seen.length === rows.length, `${seen.length} vs ${rows.length}`);
  check("游标翻页不重复", new Set(seen).size === seen.length, JSON.stringify(seen));
  check("游标翻页把每一行都翻了", new Set(seen).size === new Set(rows.map((r) => String(r.id))).size, JSON.stringify(seen));
}

const summary = await call("GetUsageSummary", {});
check("用量合计有请求数", Number(summary.body?.total?.requests ?? 0) > 0, JSON.stringify(summary.body?.total));
check("用量能按上游分组", (summary.body?.byUpstream ?? []).length > 0, JSON.stringify(summary.body?.byUpstream));

const del = await call("DeletePublishedModel", { id: "regression-model" });
check("模型删得掉", del.body?.ok === true, JSON.stringify(del.body));

console.log("");
console.log(`pass=${pass} fail=${fail}`);
cleanup();
process.exit(fail ? 1 : 0);
