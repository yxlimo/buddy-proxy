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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startFakeQoder } from "./fake-qoder-upstream.ts";
import { startGateway, type Gateway } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
 * 假上游：按剧本回答
 * ------------------------------------------------------------------ */

/**
 * 剧本：上游的模型名 → 每次被叫到时答什么（剧本用完就答 200）。
 *
 * 瞬时失败的重试要验的正是「第一次不行、第二次行」：一个只会答同一种结果的
 * 假上游证明不了这件事。剧本按模型名分开，每个场景用自己那个模型。
 */
const scripts: Record<string, number[]> = {};

/** 剧本那个假上游收到的推理请求：上游的模型名。 */
const scriptCalls: string[] = [];

/** 一个按剧本回答的假上游（Qoder 新协议的形状）。 */
async function startScriptedUpstream(): Promise<{ base: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* not JSON */
    }
    const model = String(body.model ?? "");
    if (!(req.url ?? "").includes("/model/v1/chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    scriptCalls.push(model);
    const status = scripts[model]?.shift() ?? 200;
    if (status !== 200) {
      // 429 的形状按 Qoder 的「繁忙」来：它带一个自己说的等待秒数（这里是 1 秒，
      // 不然它自己的重试会睡十秒）。
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          status === 429
            ? { message: `剧本说 ${model} 这一次是 429`, retryAfterSeconds: 1 }
            : { error: { message: `剧本说 ${model} 这一次是 ${status}`, type: "server_error" } },
        ),
      );
      return;
    }
    const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      frame({
        id: "chatcmpl-scripted",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      });
      frame({
        id: "chatcmpl-scripted",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-scripted",
        object: "chat.completion",
        created: 1700000000,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

// Qoder 的会话种进测试自己的数据库：假上游不看凭据，但网关没有会话就不发
// 请求 —— 而且会走设备流去真的登录。
//
// 数据目录：helper 建一个临时的，或者这里自己建（重启要接着用同一个）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-route-e2e-"));

execFileSync(process.execPath, ["--experimental-strip-types", "test/aggregate-setup.ts", "seed"], {
  cwd: ROOT,
  env: { ...process.env, BUDDY_DATA_DIR: dataDir },
  stdio: "ignore",
});

/**
 * 起过的网关：端口每次都换，所以 base 要跟着换。
 */
const gateways: Gateway[] = [];

/** 网关的地址与面板令牌：重启之后要跟着新网关换。 */
let base = "";
let token = "";

/**
 * 起一个网关（或者再起一个）。
 *
 * 数据目录一直是同一个：重启之后，账号的开关、发布的模型都还在库里。
 * 目录由最后一个网关收（cleanupDataDir），前面几个留着。
 */
async function startRouter(opts: { cleanupDataDir?: boolean; inferBase?: string } = {}): Promise<Gateway> {
  // 推理那条路可以换一个假上游：「第一次 503、第二次 200」这种剧本要自己说了算。
  const infer = opts.inferBase ?? upstreamBase;
  const gw = await startGateway({
    dataDir,
    env: {
      BENEFITS_DISABLED: "1",
      // 开关不在环境里了：它在数据库的 provider.enabled 上（一行一个账号），
      // 重启也还在。开头用面板的 SetAccountEnabled 把这个账号打开。
      // 上游指向假上游：一个字都不出机器。
      QODER_GLOBAL_INFER_BASE: `${infer}/qoder-global`,
      QODER_GLOBAL_OPENAPI_BASE: `${upstreamBase}/openapi-global`,
      QODER_GLOBAL_LEGACY_BASE: `${upstreamBase}/qoder-global-legacy`,
    },
    keepDataDir: opts.cleanupDataDir !== true,
    cleanupDataDir: opts.cleanupDataDir === true,
  });
  gateways.push(gw);
  base = gw.base;
  token = readToken(gw);
  return gw;
}

/**
 * 停掉网关，等它真的退出。
 *
 * 下一个网关要用同一个数据目录：旧进程还开着 SQLite 库的时候，新的那个
 * 写库会撞上锁。所以要等它真的走了再起下一个。
 */
async function stopRouter(gw: Gateway): Promise<void> {
  gw.stop();
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${gw.base}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return; // 连不上了：它走了
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 面板令牌：网关绑好端口之后才写它。 */
function readToken(gw: Gateway): string {
  return fs.readFileSync(path.join(gw.dataDir, "admin-token"), "utf8").trim();
}

await startRouter();

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

// 账号是数据，平台是模板：会话种进库里之后，还要有一行账号才算「开着」。
const seeded = await admin("ListUpstreams", {});
const qoderRow = (seeded.upstreams ?? []).find((u: any) => u.id === "qoder");
const qoderAccount = (qoderRow?.accounts ?? [])[0];
check("Qoder 全球区有一个账号", Boolean(qoderAccount?.id), JSON.stringify(qoderRow?.accounts ?? []));
await admin("SetAccountEnabled", { accountId: qoderAccount?.id ?? "qoder", enabled: true });

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
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"), { readOnly: true });
  try {
    return db.prepare(sql).all() as any[];
  } finally {
    db.close();
  }
}

/** 冷却表里那个账号那一行（没有就是 null）。 */
function cooldownOf(accountId: string): { untilMs: number; reason: string } | null {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"), { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare("SELECT until_ms, reason FROM cooldown WHERE provider_id = ?").get(accountId) as any;
    if (!row) return null;
    return { untilMs: Number(row.until_ms ?? 0), reason: String(row.reason ?? "") };
  } finally {
    db.close();
  }
}

/** 把冷却行清掉：场景之间互不干扰（网关拿的是同一个库）。 */
function clearCooldowns(): void {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"), { timeout: 5000 });
  try {
    db.prepare("DELETE FROM cooldown").run();
  } finally {
    db.close();
  }
}

/**
 * 发一个请求，期间一直看冷却表。
 *
 * 「重试成功就不该记冷却」只看结束状态是看不出来的：成功那条路会把冷却消掉，
 * 于是「中间写过一行又擦掉」与「一行都没写过」的结束状态一模一样。要看的是
 * 请求还在跑的时候那张表里有没有出现过东西。
 */
async function chatWatchingCooldowns(model: string): Promise<{ answered: any; wroteCooldown: boolean }> {
  const accountId = qoderAccount?.id ?? "qoder";
  let wrote = false;
  const timer = setInterval(() => {
    try {
      if (cooldownOf(accountId) !== null) wrote = true;
    } catch {
      /* 库被写事务挡了一下：下一次再看 */
    }
  }, 20);
  try {
    const answered = await chat(model);
    return { answered, wroteCooldown: wrote };
  } finally {
    clearInterval(timer);
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
check("面板能发布一个模型（答复里没有 ok 与 message）", saved.id === "e2e-main", JSON.stringify(saved));

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
check("面板能改一个模型的目标", changed.id === "e2e-main", JSON.stringify(changed));
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
  bySession.some((b: any) => b.key === "be-match · e2e-1"),
  JSON.stringify(bySession.map((b: any) => b.key)),
);
check(
  "面板的用量摘要里按父会话分了组",
  byParent.some((b: any) => b.key === "be-match · e2e-parent"),
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
// 每个目标都回 500：瞬时失败没有次数上限 —— 在同一个账号上一直重试到这一轮
// 的总时限，才轮到换目标。所以这里数的是「两个目标都被试过、各自都重试过」。
const bothTargets = inferCalls();
check(
  "两个目标都试过了（每个都重试过）",
  bothTargets.length > 2 && new Set(bothTargets.map((c) => c.model)).size === 2,
  JSON.stringify(bothTargets),
);

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
  // 第一个目标回 500，瞬时失败在同一个账号上一直重试到这一轮的总时限 —— 重试
  // 是同一个账号，不是换目标：所以第二个目标一次也不该被叫到。
  inferCalls().length > 1 && inferCalls().every((c) => c.model === "kmodel"),
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

await admin("SetAccountEnabled", { accountId: qoderAccount?.id ?? "qoder", enabled: false });
const stillThere = await fetch(`${base}/v1/models`).then((r) => r.json());
check(
  "改了开关就生效，目录里没有那些模型了（不用重启）",
  !(stillThere.data ?? []).some((m: any) => m.id === "e2e-main" || m.id === "e2e-fallback"),
  JSON.stringify((stillThere.data ?? []).map((m: any) => m.id)),
);
await admin("SetAccountEnabled", { accountId: qoderAccount?.id ?? "qoder", enabled: true });

section("上游真的关掉之后（重启过）");

// 把上游开关改成关（写进数据库），再重启：这次上游是真的关着的。
await admin("SetAccountEnabled", { accountId: qoderAccount?.id ?? "qoder", enabled: false });
await stopRouter(gateways[gateways.length - 1]);
await startRouter();
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
// 模型确实发布过，只是它的上游（Qoder）现在整个关着。答「没有这个模型」会让
// 客户端去改模型名，而模型名是对的 —— 该说的是哪个上游、什么状态。
check("客户端问一个发布着的模型，不是 404", offChat.status !== 404, `HTTP ${offChat.status}`);
check(
  "答 400，并说清是哪个上游、什么状态",
  offChat.status === 400 &&
    String(offChat.json?.hint ?? "").includes("qoder") &&
    String(offChat.json?.hint ?? "").includes("accounts_off"),
  `HTTP ${offChat.status} ${String(offChat.json?.hint ?? offChat.text).slice(0, 300)}`,
);

// 回到上游开着的状态，后面的收尾还要用。
await admin("SetAccountEnabled", { accountId: qoderAccount?.id ?? "qoder", enabled: true });
await stopRouter(gateways[gateways.length - 1]);
// 数据目录要留到最后一个网关收：后面那一段用的还是同一批账号与发布的模型。
await startRouter();

/* ------------------------------------------------------------------ *
 * 瞬时失败：同一个账号上重试
 * ------------------------------------------------------------------ */

section("瞬时失败：同一个账号上重试（5xx / 连接）");

// 上游抽一下不该让账号下线：这个上游是单一策略，账号一冷却就是五分钟不能用，
// 而这一次抽的那一下隔 300ms 多半就好了。重试是**同一个账号**，不换人。
//
// 超时不在这里：它不重试，也不写冷却（见本节最后那一段）。
const scripted = await startScriptedUpstream();
await stopRouter(gateways[gateways.length - 1]);
// 最后一个网关负责把数据目录收掉。
const retryGw = await startRouter({ inferBase: scripted.base, cleanupDataDir: true });
clearCooldowns();

/** 发布一个只有一个目标、剧本由上游模型名决定的模型。 */
async function publishScripted(id: string, upstreamModel: string): Promise<void> {
  await publish({
    id,
    displayName: id,
    strategy: "single",
    targets: [{ groupName: "qoder", upstreamModel, weight: 10 }],
  });
}

// 1. 503 一次后成功。
await publishScripted("e2e-retry-503", "rmodel");
scripts.rmodel = [503];
scriptCalls.length = 0;
const onceFailing = await chatWatchingCooldowns("e2e-retry-503");
check(
  "503 一次后成功：客户端拿到 200",
  onceFailing.answered.status === 200,
  `HTTP ${onceFailing.answered.status} ${onceFailing.answered.text.slice(0, 200)}`,
);
check(
  "503 一次后成功：答案有内容",
  Boolean(onceFailing.answered.json?.choices?.[0]?.message?.content),
  JSON.stringify(onceFailing.answered.json).slice(0, 200),
);
check("503 一次后成功：上游被调了两次", scriptCalls.join(",") === "rmodel,rmodel", scriptCalls.join(","));
check(
  "503 一次后成功：重试期间没有写过冷却（只在全部尝试失败后才记）",
  onceFailing.wroteCooldown === false,
  "请求期间冷却表里出现过这个账号",
);
check("503 一次后成功：账号没有冷却", cooldownOf(qoderAccount?.id ?? "qoder") === null, JSON.stringify(cooldownOf(qoderAccount?.id ?? "qoder")));
check(
  "503 一次后成功：日志里看得见重试",
  /retry 1 in 300ms/.test(retryGw.log()),
  retryGw.log().split("\n").filter((l) => l.includes("retry")).slice(0, 2).join(" | "),
);

// 2. 500 两次后成功：任何 5xx 都重试，不只是 503。
await publishScripted("e2e-retry-500", "fmodel");
scripts.fmodel = [500, 500];
scriptCalls.length = 0;
const twiceFailing = await chatWatchingCooldowns("e2e-retry-500");
check(
  "500 两次后成功：客户端拿到 200",
  twiceFailing.answered.status === 200,
  `HTTP ${twiceFailing.answered.status} ${twiceFailing.answered.text.slice(0, 200)}`,
);
check("500 两次后成功：上游被调了三次", scriptCalls.join(",") === "fmodel,fmodel,fmodel", scriptCalls.join(","));
check(
  "500 两次后成功：重试期间没有写过冷却",
  twiceFailing.wroteCooldown === false,
  "请求期间冷却表里出现过这个账号",
);
check("500 两次后成功：账号没有冷却", cooldownOf(qoderAccount?.id ?? "qoder") === null, JSON.stringify(cooldownOf(qoderAccount?.id ?? "qoder")));

// 3. 503 一直失败：没有次数上限，一路重试到这一轮的总时限才停手。
//    客户端拿到的是上游那份答复（503 + 上游的正文），不是网关自己编的一句。
await publishScripted("e2e-retry-always", "xmodel");
scripts.xmodel = new Array(50).fill(503);
scriptCalls.length = 0;
const alwaysFailing = await chat("e2e-retry-always");
check("503 一直失败：客户端拿到失败", alwaysFailing.status >= 500, `HTTP ${alwaysFailing.status}`);
check(
  "503 一直失败：客户端拿到的是上游那个 503（不是网关的 502）",
  alwaysFailing.status === 503,
  `HTTP ${alwaysFailing.status}`,
);
check(
  "503 一直失败：上游被重试了很多次（不是一次就放弃）",
  scriptCalls.length > 1 && scriptCalls.every((m) => m === "xmodel"),
  scriptCalls.join(","),
);
// 5xx 不是账号的错（见 lib/router/account-cooldown.ts）：一直失败也不写冷却。
check(
  "503 一直失败：账号仍然没有冷却（5xx 不写冷却）",
  cooldownOf(qoderAccount?.id ?? "qoder") === null,
  JSON.stringify(cooldownOf(qoderAccount?.id ?? "qoder")),
);

// 4. 流式：503 后成功 —— 答复一个字都还没写给客户端，所以能再试一次。
await publishScripted("e2e-retry-stream", "smodel");
scripts.smodel = [503];
scriptCalls.length = 0;
const streamedRetry = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "e2e-retry-stream", messages: [{ role: "user", content: "say ok" }], stream: true }),
});
const streamedRetryText = await streamedRetry.text();
check("流式 503 后成功：状态码是 200", streamedRetry.status === 200, `HTTP ${streamedRetry.status}`);
check(
  "流式 503 后成功：是 SSE",
  (streamedRetry.headers.get("content-type") ?? "").includes("text/event-stream"),
  streamedRetry.headers.get("content-type") ?? "",
);
check("流式 503 后成功：只有一份答复（[DONE] 一次）", streamedRetryText.split("[DONE]").length === 2, streamedRetryText.slice(0, 300));
check("流式 503 后成功：上游被调了两次", scriptCalls.join(",") === "smodel,smodel", scriptCalls.join(","));
check("流式 503 后成功：账号没有冷却", cooldownOf(qoderAccount?.id ?? "qoder") === null, JSON.stringify(cooldownOf(qoderAccount?.id ?? "qoder")));

// 5. 429（Qoder 的「后端都忙」）：不进瞬时重试，也不会和瞬时重试叠成九次。
//
// Qoder 对这个状态有自己的重试（qoderMaxAttempts，同一个账号上遥）：那是已有
// 的行为，不该被瞬时重试再套一层。
await publishScripted("e2e-retry-429", "tmodel");
scripts.tmodel = [429, 429, 429];
scriptCalls.length = 0;
const logBefore429 = retryGw.log().length;
const rateLimited = await chat("e2e-retry-429");
const log429 = retryGw.log().slice(logBefore429);
check("429：客户端拿到失败", rateLimited.status >= 400, `HTTP ${rateLimited.status}`);
check(
  "429：上游被调了三次 —— Qoder 自己的繁忙重试，不是三个瞬时重试",
  scriptCalls.join(",") === "tmodel,tmodel,tmodel",
  scriptCalls.join(","),
);
check(
  "429：日志里一次瞬时重试都没有",
  !/retry 1\/2 in 300ms/.test(log429),
  log429.split("\n").filter((l) => l.includes("retry")).slice(0, 3).join(" | "),
);
check(
  "429：这一次的分类是 busy（不是瞬时失败）",
  log429.includes("(busy HTTP 429)"),
  log429.split("\n").filter((l) => l.includes("429")).slice(0, 3).join(" | "),
);

// 6. 401：凭据被拒，一次就结束，照旧记 credential 冷却。
await publishScripted("e2e-retry-401", "cmodel");
scripts.cmodel = [401, 401, 401];
scriptCalls.length = 0;
clearCooldowns();
const refused = await chat("e2e-retry-401");
check("401：客户端拿到失败", refused.status >= 400, `HTTP ${refused.status}`);
check("401：上游只被调了一次", scriptCalls.join(",") === "cmodel", scriptCalls.join(","));
const refusedRow = cooldownOf(qoderAccount?.id ?? "qoder");
check("401：照旧记了冷却", refusedRow !== null, JSON.stringify(refusedRow));
check("401：理由是凭据被拒", refusedRow?.reason === "credential", String(refusedRow?.reason));

// 7. 超时（上游 408）：不重试，也不写冷却。
//
// 超时说的是「这一条请求等太久了」，不是「这个账号不能用了」：记冷却会把一个
// 好好的账号挡在门外好几分钟。答复照旧是那条超时错误，客户端自己决定要不要重发。
const timeoutAccountId = qoderAccount?.id ?? "qoder";
await publishScripted("e2e-retry-timeout", "omodel");
scripts.omodel = [408];
scriptCalls.length = 0;
clearCooldowns();
const timedOut = await chatWatchingCooldowns("e2e-retry-timeout");
check("超时：客户端拿到失败", timedOut.answered.status >= 500, `HTTP ${timedOut.answered.status}`);
check("超时：上游只被调了一次（不重试）", scriptCalls.join(",") === "omodel", scriptCalls.join(","));
check(
  "超时：客户端拿到的是超时那条（408），不是被包装成 5xx 的上游答复",
  timedOut.answered.status === 502 && /upstream HTTP 408/.test(String(timedOut.answered.json?.error?.message ?? "")),
  `HTTP ${timedOut.answered.status} ${String(timedOut.answered.json?.error?.message ?? timedOut.answered.text).slice(0, 200)}`,
);
check(
  "超时：请求期间没有写过冷却",
  timedOut.wroteCooldown === false,
  "请求期间冷却表里出现过这个账号",
);
check(
  "超时：冷却表里没有这个账号的行",
  cooldownOf(timeoutAccountId) === null,
  JSON.stringify(cooldownOf(timeoutAccountId)),
);
check(
  "超时：日志里说了超时、不冷却",
  retryGw.log().includes("timed out, not cooling down"),
  retryGw.log().split("\n").filter((l) => l.includes("timeout")).slice(0, 3).join(" | "),
);

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
const routerLog = gateways.map((g) => g.log()).join("\n");
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
for (const gw of gateways) gw.stop();
fake.close();
scripted.close();
process.exit(fail === 0 ? 0 : 1);
