// test/route-e2e-check.ts — 主路由（聚合路由）与 fallback 的端到端自测。
//
//   node --experimental-strip-types test/route-e2e-check.ts
//
// 起一个假的上游：它能回答，也能按上游的模型名故意失败（500）。起网关，
// 上游指向这个假上游 —— 不碰任何平台，不花 token。
//
// 然后用面板的口径（Connect）发布模型，再用客户端的口径（OpenAI 方言，
// 根路由 /v1/chat/completions）发请求，看三件事：
//
//   1. 发布的模型出现在 /v1/models 里，客户端用它发请求能通；
//   2. 回来的 model 是客户端问的那个对外 id，不是上游内部的名字；
//   3. 第一个目标失败时第二个接手（fallback），两个都失败时话说得清楚。
//
// 假上游的「模型名」是 Qoder 上游协议里的 key：gmodel 是 GLM-5.3，dmodel 是
// DeepSeek-V4-Pro，kmodel 是 Kimi-K2.8-Preview，mmodel 是 MiniMax-M3.1-Flash。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startFakeQoder } from "./fake-qoder-upstream.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-route-e2e";
const SERVICE = "/buddy.admin.v1.AdminService";
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
 * 假的上游
 * ------------------------------------------------------------------ */

// 假上游收到过的推理请求：路径、上游的模型名、是不是流式。
const fake = await startFakeQoder();
const upstreamBase = fake.base;

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

// Qoder 的会话种进测试自己的数据库：假上游不看凭据，但网关没有会话就不发
// 请求 —— 而且会走设备流去真的登录。
execFileSync(process.execPath, ["--experimental-strip-types", "test/aggregate-setup.ts", "seed"], {
  cwd: ROOT,
  env: { ...process.env, BUDDY_DATA_DIR: DATA_DIR },
  stdio: "ignore",
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

let router: ChildProcess | null = null;
let routerLog = "";

/** 起一个网关（或者再起一个）。 */
function startRouter(): ChildProcess {
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: DATA_DIR,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 上游的开关不在环境里了：它在数据库的 provider.enabled 上，重启也
      // 还在。开头用面板的 SetUpstreamEnabled 把 Qoder 打开。
      // 上游指向假上游：一个字都不出机器。
      QODER_GLOBAL_INFER_BASE: `${upstreamBase}/qoder-global`,
      QODER_GLOBAL_OPENAPI_BASE: `${upstreamBase}/openapi-global`,
      QODER_GLOBAL_LEGACY_BASE: `${upstreamBase}/qoder-global-legacy`,
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

async function waitHealthy(): Promise<void> {
  // A minute, not twenty seconds: the machine may be busy with other tests,
  // and a router that is slow to come up is not a failure.
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Say so: otherwise the next fetch fails with a connection error and the
  // real reason is a hundred lines up.
  throw new Error(`the router did not come up:\n${routerLog.slice(-2000)}`);
}

/**
 * Stop the router and wait for it to let go of the port.
 *
 * The next router binds the same port, so starting it before the old one is
 * really gone means the new one dies on "address in use" — and then the test
 * fails on a connection error that says nothing about the cause.
 */
async function stopRouter(): Promise<void> {
  const child = router;
  router = null;
  if (!child) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const hard = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(hard);
}

function cleanup(): void {
  try {
    router?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  fake.close();
}
process.on("exit", cleanup);

startRouter();
await waitHealthy();

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();

/** 一次 Connect 调用。 */
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

// 上游的开关在数据库里：只有 Qoder 全球区开着，其余的默认就是关的。
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });

/** 客户端发一次请求（OpenAI 方言，根路由）。 */
async function chat(
  model: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "say ok" }],
      ...extra,
    }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

/** 假上游收到过的推理请求（只看推理那条路）。 */
function inferCalls(): { model: string; stream: boolean }[] {
  return fake.seen.map((s) => ({ model: s.model, stream: s.stream }));
}

/** 读数据库里的表。 */
function query(sql: string): any[] {
  const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"), { readOnly: true });
  try {
    return db.prepare(sql).all() as any[];
  } finally {
    db.close();
  }
}

/** 发布一个模型。 */
async function publish(model: {
  id: string;
  displayName?: string;
  strategy?: string;
  targets: { groupName: string; upstreamModel: string; weight: number }[];
}): Promise<any> {
  return admin("SavePublishedModel", {
    model: {
      id: model.id,
      displayName: model.displayName ?? model.id,
      enabled: true,
      strategy: model.strategy ?? "single",
      targets: model.targets.map((t, index) => ({
        groupName: t.groupName,
        upstreamModel: t.upstreamModel,
        weight: t.weight,
        position: index,
        enabled: true,
      })),
    },
  });
}

/* ------------------------------------------------------------------ *
 * 一、主路由
 * ------------------------------------------------------------------ */

section("主路由：发布的模型能路由");

const saved = await publish({
  id: "e2e-main",
  displayName: "E2E 主路由",
  strategy: "single",
  targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 10 }],
});
check("面板能发布一个模型", saved.ok === true, JSON.stringify(saved));

const listed = await fetch(`${base}/v1/models`).then((r) => r.json());
const ids = (listed.data ?? []).map((m: any) => m.id);
check("它出现在 /v1/models 里", ids.includes("e2e-main"), JSON.stringify(ids));

const openaiList = await fetch(`${base}/v1/models?dialect=openai`).then((r) => r.json());
check(
  "OpenAI 形状的目录里也是这个对外 id",
  (openaiList.data ?? []).some((m: any) => m.id === "e2e-main"),
  JSON.stringify(openaiList.data ?? []),
);

fake.reset();
const answered = await chat("e2e-main");
check("客户端用它发请求能通", answered.status === 200, `HTTP ${answered.status} ${answered.text.slice(0, 200)}`);
check(
  "请求真的走到了那个上游",
  inferCalls().length === 1 && inferCalls()[0].model === "gmodel",
  JSON.stringify(inferCalls()),
);
check(
  "回来的 model 是客户端问的那个对外 id",
  answered.json?.model === "e2e-main",
  `model=${answered.json?.model}`,
);
check(
  "回来的不是上游内部的名字",
  answered.json?.model !== "gmodel" && answered.json?.model !== "glm-5.3",
  `model=${answered.json?.model}`,
);
check("答案有内容", Boolean(answered.json?.choices?.[0]?.message?.content));
check(
  "用量算出来了",
  Number(answered.json?.usage?.prompt_tokens ?? 0) > 0,
  JSON.stringify(answered.json?.usage ?? {}),
);

// 流式：状态码得是 200（那个 404 的老毛病）。
fake.reset();
const streamed = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "e2e-main",
    messages: [{ role: "user", content: "say ok" }],
    stream: true,
  }),
});
const streamText = await streamed.text();
check("流式的状态码是 200", streamed.status === 200, `HTTP ${streamed.status}`);
check("流式是 SSE", (streamed.headers.get("content-type") ?? "").includes("text/event-stream"));
check("流式有帧", streamText.includes("data: "));
check("流式以 [DONE] 收尾", streamText.includes("data: [DONE]"));
check(
  "流式帧里的 model 也是对外 id",
  streamText.includes('"model":"e2e-main"'),
  streamText.slice(0, 200),
);

// 改一个目标：保存即生效。
const changed = await publish({
  id: "e2e-main",
  displayName: "E2E 主路由",
  strategy: "single",
  targets: [{ groupName: "qoder", upstreamModel: "deepseek-v4-pro", weight: 10 }],
});
check("面板能改一个模型的目标", changed.ok === true, JSON.stringify(changed));
fake.reset();
const afterChange = await chat("e2e-main");
check("改完立刻生效（不用重启）", afterChange.status === 200, `HTTP ${afterChange.status}`);
check(
  "改完走的是新的目标",
  inferCalls().length === 1 && inferCalls()[0].model === "dmodel",
  JSON.stringify(inferCalls()),
);
check(
  "改完回来的还是对外 id",
  afterChange.json?.model === "e2e-main",
  `model=${afterChange.json?.model}`,
);

// 删掉。
const deleted = await admin("DeletePublishedModel", { id: "e2e-main" });
check("面板能删掉一个模型", deleted.ok === true, JSON.stringify(deleted));
const afterDelete = await fetch(`${base}/v1/models`);
const afterDeleteBody = await afterDelete.json();
check(
  "删掉之后 /v1/models 里没有了",
  !(afterDeleteBody.data ?? []).some((m: any) => m.id === "e2e-main"),
  JSON.stringify(afterDeleteBody.data ?? []),
);
const gone = await chat("e2e-main");
check("删掉之后客户端再问就是 404", gone.status === 404, `HTTP ${gone.status}`);

// 根路由也说得 Anthropic 方言。
await publish({
  id: "e2e-main",
  displayName: "E2E 主路由",
  strategy: "single",
  targets: [{ groupName: "qoder", upstreamModel: "deepseek-v4-pro", weight: 10 }],
});
fake.reset();
const anthropic = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "e2e-main", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
});
const anthropicText = await anthropic.text();
let anthropicJson: any = null;
try {
  anthropicJson = JSON.parse(anthropicText);
} catch {
  /* not JSON */
}
check("根路由的 Anthropic 方言通", anthropic.status === 200, `HTTP ${anthropic.status} ${anthropicText.slice(0, 200)}`);
check(
  "Anthropic 的答复是 Anthropic 形状",
  anthropicJson?.type === "message" && Array.isArray(anthropicJson?.content),
  anthropicText.slice(0, 200),
);
check(
  "Anthropic 的答复里 model 是对外 id",
  anthropicJson?.model === "e2e-main",
  `model=${anthropicJson?.model}`,
);
check(
  "Anthropic 方言也走到了上游",
  inferCalls().length === 1 && inferCalls()[0].model === "dmodel",
  JSON.stringify(inferCalls()),
);
check(
  "Anthropic 方言的请求体是 OpenAI 形状（上游那边是 OpenAI 方言）",
  inferCalls()[0]?.stream === false,
  JSON.stringify(inferCalls()),
);

// Anthropic 方言的流式。
fake.reset();
const anthropicStream = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "e2e-main",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  }),
});
const anthropicStreamText = await anthropicStream.text();
check("Anthropic 流式的状态码是 200", anthropicStream.status === 200, `HTTP ${anthropicStream.status}`);
check(
  "Anthropic 流式是 SSE",
  (anthropicStream.headers.get("content-type") ?? "").includes("text/event-stream"),
  anthropicStream.headers.get("content-type") ?? "",
);
check("Anthropic 流式有 message_start", anthropicStreamText.includes("message_start"), anthropicStreamText.slice(0, 200));
check("Anthropic 流式有 message_stop", anthropicStreamText.includes("message_stop"), anthropicStreamText.slice(0, 200));
check(
  "Anthropic 流式帧里的 model 是对外 id",
  anthropicStreamText.includes('"model":"e2e-main"'),
  anthropicStreamText.slice(0, 300),
);

/* ------------------------------------------------------------------ *
 * 二、fallback
 * ------------------------------------------------------------------ */

section("fallback：第一个失败，第二个接手");

await publish({
  id: "e2e-fallback",
  displayName: "E2E fallback",
  strategy: "fallback",
  targets: [
    { groupName: "qoder", upstreamModel: "kimi-k2.8-preview", weight: 10 },
    { groupName: "qoder", upstreamModel: "glm-5.3", weight: 1 },
  ],
});
fake.reset();
const fell = await chat("e2e-fallback");
check("请求成功", fell.status === 200, `HTTP ${fell.status} ${fell.text.slice(0, 200)}`);
check(
  "第一个目标先被试了（权重大的那个）",
  inferCalls()[0]?.model === "kmodel",
  JSON.stringify(inferCalls()),
);
check(
  "第二个目标接手了",
  inferCalls().some((c) => c.model === "gmodel"),
  JSON.stringify(inferCalls()),
);
check(
  "回来的 model 还是对外 id",
  fell.json?.model === "e2e-fallback",
  `model=${fell.json?.model}`,
);

const usageRows = query(
  "SELECT model_id, group_name, upstream_model, requests, succeeded, failed " +
    "FROM aggregate_usage WHERE model_id = 'e2e-fallback'",
);
const failRow = usageRows.find((r) => r.upstream_model === "kimi-k2.8-preview");
const okRow = usageRows.find((r) => r.upstream_model === "glm-5.3");
check("aggregate_usage 记下了第一个目标的失败", Number(failRow?.failed ?? 0) >= 1, JSON.stringify(usageRows));
check("aggregate_usage 记下了第二个目标的成功", Number(okRow?.succeeded ?? 0) >= 1, JSON.stringify(usageRows));
check(
  "面板读回来的用量也是这么算的",
  (await admin("ListPublishedModels", {})).models
    ?.find((m: any) => m.id === "e2e-fallback")
    ?.targets?.find((t: any) => t.upstreamModel === "glm-5.3")?.requests >= 1,
  JSON.stringify((await admin("ListPublishedModels", {})).models),
);

section("会话与子代理");

await chat(
  "e2e-fallback",
  {},
  {
    "user-agent": "opencode/latest/2.1.3/cli",
    "x-opencode-client": "cli",
    "x-opencode-session-id": "ses-e2e-1",
    "x-opencode-parent-session-id": "ses-e2e-parent",
    "x-agent-name": "be-match",
  },
);
const sessionRows = query(
  "SELECT agent, session_id, parent_session_id, agent_name FROM usage_event " +
    "WHERE session_id = 'ses-e2e-1' ORDER BY id DESC LIMIT 1",
);
check(
  "用量日志里认出了会话与父会话",
  sessionRows.length === 1 &&
    sessionRows[0].agent === "opencode" &&
    sessionRows[0].parent_session_id === "ses-e2e-parent",
  JSON.stringify(sessionRows),
);
check(
  "用量日志里认出了 agent 名",
  sessionRows.length === 1 && sessionRows[0].agent_name === "be-match",
  JSON.stringify(sessionRows),
);

const summary = await admin("GetUsageSummary", {});
const bySession = (summary as any).bySession ?? [];
const byParent = (summary as any).byParentSession ?? [];
check(
  "面板的用量摘要里按会话分了组",
  bySession.some((b: any) => b.key === "ses-e2e-1"),
  JSON.stringify(bySession.map((b: any) => b.key)),
);
check(
  "面板的用量摘要里按父会话分了组",
  byParent.some((b: any) => b.key === "ses-e2e-parent"),
  JSON.stringify(byParent.map((b: any) => b.key)),
);
const byAgentName = (summary as any).byAgentName ?? [];
const bySubagent = (summary as any).bySubagent ?? [];
check(
  "面板的用量摘要里按 agent 名分了组",
  byAgentName.some((b: any) => b.key === "be-match"),
  JSON.stringify(byAgentName.map((b: any) => b.key)),
);
check(
  "面板的用量摘要里按子代理分了组",
  bySubagent.some((b: any) => b.key === "be-match @ ses-e2e-parent"),
  JSON.stringify(bySubagent.map((b: any) => b.key)),
);

section("fallback：两个都失败");

await publish({
  id: "e2e-dead",
  displayName: "E2E 都失败",
  strategy: "fallback",
  targets: [
    { groupName: "qoder", upstreamModel: "kimi-k2.8-preview", weight: 10 },
    { groupName: "qoder", upstreamModel: "minimax-m3.1-flash", weight: 1 },
  ],
});
fake.reset();
const dead = await chat("e2e-dead");
check("两个都失败时报错", dead.status >= 400, `HTTP ${dead.status}`);
check(
  "错误不是空的",
  typeof dead.json?.error?.message === "string" && dead.json.error.message.trim().length > 0,
  JSON.stringify(dead.json),
);
check(
  "错误说得清是上游的问题",
  /upstream|上游|HTTP/i.test(String(dead.json?.error?.message ?? "")),
  JSON.stringify(dead.json),
);
check("两个目标都试过了", inferCalls().length === 2, JSON.stringify(inferCalls()));

section("single：只走权重最大的那个");

await publish({
  id: "e2e-single",
  displayName: "E2E single",
  strategy: "single",
  targets: [
    { groupName: "qoder", upstreamModel: "glm-5.3", weight: 10 },
    { groupName: "qoder", upstreamModel: "deepseek-v4-pro", weight: 1 },
  ],
});
fake.reset();
const single = await chat("e2e-single");
check("single 的请求成功", single.status === 200, `HTTP ${single.status}`);
check(
  "只走了权重最大的那个",
  inferCalls().length === 1 && inferCalls()[0].model === "gmodel",
  JSON.stringify(inferCalls()),
);

section("single：第一个失败的时候");

await publish({
  id: "e2e-single-fail",
  displayName: "E2E single 失败",
  strategy: "single",
  targets: [
    { groupName: "qoder", upstreamModel: "kimi-k2.8-preview", weight: 10 },
    { groupName: "qoder", upstreamModel: "glm-5.3", weight: 1 },
  ],
});
fake.reset();
const singleFail = await chat("e2e-single-fail");
check(
  "single 不该退到第二个目标",
  inferCalls().length === 1 && inferCalls()[0].model === "kmodel",
  `HTTP ${singleFail.status} ${JSON.stringify(inferCalls())}`,
);

section("目标关掉了就不该被试");

await publish({
  id: "e2e-disabled-target",
  displayName: "E2E 目标关掉",
  strategy: "fallback",
  targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 10 }],
});
await admin("SavePublishedModel", {
  model: {
    id: "e2e-disabled-target",
    displayName: "E2E 目标关掉",
    enabled: true,
    strategy: "fallback",
    targets: [
      { groupName: "qoder", upstreamModel: "glm-5.3", weight: 10, enabled: false },
      { groupName: "qoder", upstreamModel: "deepseek-v4-pro", weight: 1, enabled: true },
    ],
  },
});
fake.reset();
const disabled = await chat("e2e-disabled-target");
check("关掉的目标没有被试", inferCalls().every((c) => c.model !== "gmodel"), JSON.stringify(inferCalls()));
check("开着的目标答了", disabled.status === 200, `HTTP ${disabled.status}`);

section("上游关掉的时候");

await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: false });
const stillThere = await fetch(`${base}/v1/models`).then((r) => r.json());
check(
  "改了开关就生效，目录里没有那些模型了（不用重启）",
  !(stillThere.data ?? []).some((m: any) => m.id === "e2e-main" || m.id === "e2e-fallback"),
  JSON.stringify((stillThere.data ?? []).map((m: any) => m.id)),
);
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });

section("上游真的关掉之后（重启过）");

// 把上游开关改成关（写进数据库），再重启：这次上游是真的关着的。
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: false });
await stopRouter();
startRouter();
await waitHealthy();
const offHealth = await fetch(`${base}/health`).then((r) => r.json());
// 开关只有一份：provider 表里的 enabled，/health 的 providers 段报的就是它。
const offQoder = (offHealth.providers ?? []).find((p: any) => p.id === "qoder");
check("上游真的关着了", offQoder?.enabled === false, JSON.stringify(offHealth.providers));
const offCatalog = await fetch(`${base}/v1/models`);
const offBody = await offCatalog.json();
check(
  "上游关着的时候根路由一个模型也公布不出去",
  offCatalog.status === 404 && /no published models/.test(JSON.stringify(offBody)),
  `HTTP ${offCatalog.status} ${JSON.stringify(offBody).slice(0, 160)}`,
);
const status = await admin("GetSystemStatus");
check(
  "面板也说一个模型也没公布（跟根路由一致）",
  Number(status.publishedModelCount) === 0,
  `publishedModelCount=${status.publishedModelCount}`,
);
const offChat = await chat("e2e-fallback");
check("客户端问一个公布出来的模型，答不上来", offChat.status === 404, `HTTP ${offChat.status}`);

// 回到上游开着的状态，后面的收尾还要用。
await admin("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });
await stopRouter();
startRouter();
await waitHealthy();

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  console.log("查出来的问题：");
  for (const p of problems) console.log(`  - ${p}`);
}
if (routerLog.includes("[AUTH]")) {
  console.log("");
  console.log("（网关的登录日志，只看一眼有没有真的去登录）");
  console.log(
    routerLog
      .split("\n")
      .filter((l) => l.includes("[AUTH]"))
      .slice(0, 6)
      .join("\n"),
  );
}
cleanup();
process.exit(fail === 0 ? 0 : 1);
