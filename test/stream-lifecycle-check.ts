// test/stream-lifecycle-check.ts — a streamed answer, from the first frame to the last.
//
//   node --experimental-strip-types test/stream-lifecycle-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖：
//   1. 慢客户端（暂停读取）+ 大帧：答复完整，没有截断，没有提前的 [DONE]
//      （背压不是断开：write() 返回 false 只是等 drain）；
//   2. 客户端中途断开：假上游看见连接被关掉（几百毫秒内），账号不记冷却，
//      用量表记失败；
//   3. Anthropic 上游 200 但首帧是 `event: error`：主路由换到第二个 target
//      （头还没发出去，所以还能换）；
//   4. 流中途断：用量表记 ok=0（不是 200 成功）；
//   5. 主路由遇到请求本身的 400：不再试下一个 target；
//   6. 多行 data 的帧透传后，客户端照 SSE 规则能解析；
//   7. Qoder 老协议 + Anthropic 客户端：用量回调拿得到数（单元）。
//
// 走的是 MiniMax Code（Anthropic 方言）那条路：两个账号，降级策略。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";

// 本进程里的单元部分也会加载 lib/：给它一个自己的数据目录（网关各有各的）。
const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stream-lifecycle-"));
process.env.BUDDY_DATA_DIR = LOCAL_DIR;

const SERVICE = "/buddy.admin.v1.AdminService";
const MODEL = "MiniMax-M3.1-Flash";
const OTHER_MODEL = "MiniMax-M3";

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

function section(title: string): void {
  console.log("");
  console.log(title);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

type Mode = "big" | "endless" | "first-error" | "break" | "bad-request" | "multiline";
let mode: Mode = "big";
/** 上游被叫过的账号与模型，按先后顺序。 */
const calls: { who: string; model: string }[] = [];
/** 最近一次推理请求的连接什么时候被关掉（毫秒时间戳）。 */
let upstreamClosedAt = 0;

/** 大帧：每帧这么多字，这么多帧。 */
const FRAME_CHARS = 64 * 1024;
const FRAME_COUNT = 40;

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function messageStart(): string {
  return sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "minimax-upstream",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  });
}

function blockStart(): string {
  return sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
}

function delta(text: string): string {
  return sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
}

function tail(): string {
  return (
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 5, output_tokens: 9 },
    }) +
    sse("message_stop", { type: "message_stop" })
  );
}

/** Write and wait for the socket like a well-behaved server would. */
async function put(res: http.ServerResponse, text: string): Promise<void> {
  if (!res.write(text)) await new Promise((r) => res.once("drain", r));
}

const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: any = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    /* not JSON */
  }
  const who = String(req.headers.authorization ?? "").replace(/^Bearer tok-/, "");
  calls.push({ who, model: String(body.model ?? "") });
  res.on("close", () => {
    upstreamClosedAt = Date.now();
  });

  if (mode === "bad-request") {
    // 请求本身的问题：正文里不提模型（提了模型的 400 是「这个 target 没有这个模型」）。
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: field required" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (mode === "first-error" && body.model === MODEL) {
    res.end(sse("error", { type: "error", error: { type: "overloaded_error", message: "fake upstream is overloaded" } }));
    return;
  }
  await put(res, messageStart());
  await put(res, blockStart());
  if (mode === "big") {
    for (let i = 0; i < FRAME_COUNT; i++) await put(res, delta(String(i % 10).repeat(FRAME_CHARS)));
  } else if (mode === "endless") {
    // 一直在想：每 100 毫秒一帧，30 秒。客户端走了之后网关应该把连接关掉。
    for (let i = 0; i < 300 && !res.destroyed; i++) {
      await put(res, delta("."));
      await sleep(100);
    }
  } else if (mode === "break") {
    await put(res, delta("half an answer"));
    await sleep(50);
    // 上游中途断开：连接直接没了，没有 message_stop。
    res.socket?.destroy();
    return;
  } else if (mode === "multiline") {
    // 一帧的 data 分在三行上：SSE 规则是用换行把它们拼起来。
    await put(
      res,
      'event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "index":0,\ndata: "delta":{"type":"text_delta","text":"multi-line"}}\n\n',
    );
  } else {
    await put(res, delta("second account"));
  }
  if (!res.destroyed) res.end(tail());
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway extends HarnessGateway {
  token: string;
  accounts: string[];
}

async function startGateway(): Promise<Gateway> {
  const gw = await startHarness({
    env: { MINIMAX_BASE_URL: upstreamBase, MINIMAX_API_BASE: upstreamBase, MINIMAX_REGION: "cn", BENEFITS_DISABLED: "1" },
  });
  const tokenFile = path.join(gw.dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const local: Gateway = { ...gw, token, accounts: [] };
  const seed = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  try {
    for (const index of [1, 2]) {
      const made = await call(local, "AddAccount", { platform: "minimax", alias: `MiniMax ${index}` });
      const id = String(made.body?.id ?? "");
      if (!id) throw new Error(`加不了 MiniMax 的账号：${JSON.stringify(made.body)}`);
      local.accounts.push(id);
      const now = Date.now();
      insertSecret.run(
        `session:provider:${id}`,
        "session",
        JSON.stringify({
          schemaVersion: 1,
          clientId: "minimax-code",
          audience: "minimax",
          scopes: [],
          region: "cn",
          accessToken: `tok-${index}`,
          refreshToken: `refresh-${index}`,
          tokenType: "Bearer",
          expiresAtMs: now + 3600_000,
          generation: 1,
          loginAtMs: now,
          refreshedAtMs: now,
        }),
        now,
      );
    }
  } finally {
    seed.close();
  }
  const policy = await call(local, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
  check("MiniMax Code 设成了降级", policy.body?.ok === true, JSON.stringify(policy.body));
  return local;
}

async function call(gw: Gateway, method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.token}` },
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

/** 一个流式请求。`pauseMs`：拿到头之后先不读这么久（慢客户端）。 */
function streamRequest(
  gw: Gateway,
  urlPath: string,
  body: unknown,
  opts: { pauseMs?: number; hangUpAfterFirstChunk?: boolean } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${gw.base}${urlPath}`);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "public", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        if (opts.pauseMs) {
          res.pause();
          setTimeout(() => res.resume(), opts.pauseMs);
        }
        res.on("data", (chunk: string) => {
          text += chunk;
          if (opts.hangUpAfterFirstChunk && text.includes("content_block_delta")) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, text });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", (e) => (opts.hangUpAfterFirstChunk ? undefined : reject(e)));
    req.end(payload);
  });
}

/** 照 SSE 规则读帧：data 行用换行拼起来。 */
function parseSse(text: string): { event?: string; data: string }[] {
  const out: { event?: string; data: string }[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) out.push({ event, data: data.join("\n") });
  }
  return out;
}

interface UsageRow {
  ok: number;
  status: number;
  error: string;
  prompt_tokens: number;
  completion_tokens: number;
}

function usageRows(dataDir: string): UsageRow[] {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"));
  // 网关同时开着这个库：等它的写锁，别直接报 database is locked。
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_event'").get();
    if (!table) return [];
    return db.prepare("SELECT * FROM usage_event ORDER BY id").all() as unknown as UsageRow[];
  } finally {
    db.close();
  }
}

function cooldownRows(dataDir: string): unknown[] {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"));
  // 网关同时开着这个库：等它的写锁，别直接报 database is locked。
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    return db.prepare("SELECT * FROM cooldown").all();
  } finally {
    db.close();
  }
}

/** 用量表要等网关写完：最多等一秒。 */
async function lastUsage(dataDir: string, count: number): Promise<UsageRow | undefined> {
  for (let i = 0; i < 20; i++) {
    const rows = usageRows(dataDir);
    if (rows.length >= count) return rows[rows.length - 1];
    await sleep(50);
  }
  return usageRows(dataDir).at(-1);
}

const ask = (stream: boolean, model = MODEL) => ({
  model,
  max_tokens: 64,
  stream,
  messages: [{ role: "user", content: "say ok" }],
});

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

const gw = await startGateway();
try {
  section("场景一：慢客户端 + 大帧 —— 答复完整，没有提前的 [DONE]");
  {
    mode = "big";
    calls.length = 0;
    const expected = FRAME_CHARS * FRAME_COUNT;

    const anthropic = await streamRequest(gw, "/minimax/v1/messages", ask(true), { pauseMs: 800 });
    const events = parseSse(anthropic.text);
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => JSON.parse(e.data).delta?.text ?? "")
      .join("");
    check("Anthropic 客户端：200", anthropic.status === 200, String(anthropic.status));
    check("Anthropic 客户端：字一个不少", text.length === expected, `${text.length} / ${expected}`);
    check("Anthropic 客户端：有 message_stop", events.some((e) => e.event === "message_stop"), events.at(-1)?.event ?? "");

    const openai = await streamRequest(gw, "/minimax/v1/chat/completions", ask(true), { pauseMs: 800 });
    const frames = parseSse(openai.text);
    const content = frames
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data).choices?.[0]?.delta?.content ?? "")
      .join("");
    const doneAt = frames.findIndex((e) => e.data === "[DONE]");
    check("OpenAI 客户端：200", openai.status === 200, String(openai.status));
    check("OpenAI 客户端：字一个不少", content.length === expected, `${content.length} / ${expected}`);
    check("OpenAI 客户端：[DONE] 在最后、只有一个", doneAt === frames.length - 1, `${doneAt} / ${frames.length}`);
    check(
      "OpenAI 客户端：[DONE] 之前有 finish_reason",
      frames.some((e) => e.data !== "[DONE]" && JSON.parse(e.data).choices?.[0]?.finish_reason),
    );
  }

  section("场景二：客户端中途断开 —— 网关把上游的连接也关掉");
  {
    mode = "endless";
    calls.length = 0;
    upstreamClosedAt = 0;
    const before = usageRows(gw.dataDir).length;
    const answered = await streamRequest(gw, "/minimax/v1/messages", ask(true), { hangUpAfterFirstChunk: true });
    const hungUpAt = Date.now();
    check("客户端拿到过开头", answered.text.includes("message_start"), answered.text.slice(0, 200));
    for (let i = 0; i < 40 && !upstreamClosedAt; i++) await sleep(50);
    const lag = upstreamClosedAt ? upstreamClosedAt - hungUpAt : -1;
    check("上游的连接被关掉了（2 秒内）", upstreamClosedAt > 0 && lag < 2000, upstreamClosedAt ? `${lag}ms` : "上游一直没被关");
    const row = await lastUsage(gw.dataDir, before + 1);
    check("用量表记的是失败", row?.ok === 0, JSON.stringify(row));
    check("用量表的状态是 499（客户端先走）", row?.status === 499, JSON.stringify(row));
    check("账号没记冷却（客户端走了不是账号的错）", cooldownRows(gw.dataDir).length === 0, JSON.stringify(cooldownRows(gw.dataDir)));
    check("只打了一个账号（没换人）", calls.length === 1, JSON.stringify(calls));
  }

  section("场景三：上游 200 但首帧是 error —— 主路由换到第二个 target");
  {
    mode = "first-error";
    calls.length = 0;
    const saved = await call(gw, "SavePublishedModel", {
      model: {
        id: "pub-first-error",
        displayName: "首帧报错",
        enabled: true,
        strategy: "fallback",
        targets: [
          // 权重大的先试：它的首帧是 error。
          { groupName: "minimax", upstreamModel: MODEL, weight: 2, enabled: true },
          { groupName: "minimax", upstreamModel: OTHER_MODEL, weight: 1, enabled: true },
        ],
      },
    });
    check("发布模型成功了", saved.body?.ok === true, JSON.stringify(saved.body));
    const answered = await streamRequest(gw, "/v1/messages", ask(true, "pub-first-error"));
    check("客户端拿到 200", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check(
      "先试第一个 target，再试第二个",
      calls.map((c) => c.model).join(",") === `${MODEL},${OTHER_MODEL}`,
      JSON.stringify(calls),
    );
    check("答案来自第二个 target", answered.text.includes("second account"), answered.text.slice(0, 300));
    check("客户端没看见第一个 target 的错误帧", !answered.text.includes("overloaded"), answered.text.slice(0, 300));
    const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
    // 网关同时开着这个库：等它的写锁，别直接报 database is locked。
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("DELETE FROM cooldown");
    db.close();
  }

  section("场景四：流中途断 —— 用量表记失败");
  {
    mode = "break";
    calls.length = 0;
    const before = usageRows(gw.dataDir).length;
    const answered = await streamRequest(gw, "/minimax/v1/messages", ask(true));
    check("客户端拿到了错误事件", answered.text.includes("event: error"), answered.text.slice(-300));
    const row = await lastUsage(gw.dataDir, before + 1);
    check("用量表记 ok=0", row?.ok === 0, JSON.stringify(row));
    check("用量表的状态不是 200", row !== undefined && row.status !== 200, JSON.stringify(row));
    check("用量表里有错误文本", Boolean(row?.error), JSON.stringify(row));
    const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
    // 网关同时开着这个库：等它的写锁，别直接报 database is locked。
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("DELETE FROM cooldown");
    db.close();
  }

  section("场景五：主路由遇到请求本身的 400 —— 不再试下一个 target");
  {
    mode = "bad-request";
    calls.length = 0;
    const saved = await call(gw, "SavePublishedModel", {
      model: {
        id: "pub-lifecycle",
        displayName: "生命周期",
        enabled: true,
        strategy: "fallback",
        targets: [
          { groupName: "minimax", upstreamModel: MODEL, weight: 2, enabled: true },
          { groupName: "minimax", upstreamModel: OTHER_MODEL, weight: 1, enabled: true },
        ],
      },
    });
    check("发布模型成功了", saved.body?.ok === true, JSON.stringify(saved.body));
    const res = await fetch(`${gw.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "public" },
      body: JSON.stringify(ask(false, "pub-lifecycle")),
    });
    const text = await res.text();
    check("客户端拿到 400", res.status === 400, `${res.status} ${text.slice(0, 200)}`);
    check("上游只被打了一次", calls.length === 1, JSON.stringify(calls));
    check("错误里是上游的原话", text.includes("field required"), text.slice(0, 300));
    check(
      "日志说了为什么没换",
      gw.log().includes("the request itself is wrong, not trying the next target"),
      gw.log().slice(-600),
    );
  }

  section("场景六：多行 data 的帧透传 —— 客户端能解析");
  {
    mode = "multiline";
    calls.length = 0;
    const answered = await streamRequest(gw, "/minimax/v1/messages", ask(true));
    const events = parseSse(answered.text).filter((e) => e.event === "content_block_delta");
    let parsed: any = null;
    try {
      parsed = JSON.parse(events[0]?.data ?? "");
    } catch {
      /* stays null */
    }
    check("那一帧解析得了", parsed !== null, events[0]?.data ?? answered.text.slice(0, 300));
    check("内容没丢", parsed?.delta?.text === "multi-line", JSON.stringify(parsed));
  }
} finally {
  gw.stop();
  upstream.close();
}

section("单元：重写帧时每行 data 都有前缀");
{
  const { anthropicFrame } = await import("../lib/router/deliver.ts");
  const frame = anthropicFrame("content_block_delta", '{"a":1,\n"b":2}');
  check("每行都以 data: 开头", frame === 'event: content_block_delta\ndata: {"a":1,\ndata: "b":2}\n\n', JSON.stringify(frame));
  check("单行的不变", anthropicFrame(undefined, "{}") === "data: {}\n\n", JSON.stringify(anthropicFrame(undefined, "{}")));
}

section("单元：Qoder 老协议 + Anthropic 客户端 —— 用量回调拿得到数");
{
  const { deliverOpenAIChunks } = await import("../lib/router/deliver.ts");
  let seen: any = null;
  async function* chunks() {
    yield { choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] };
    yield {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    };
  }
  const server = http.createServer(async (req, res) => {
    const ctx: any = { req, res, status: 404, respond: true };
    await deliverOpenAIChunks(ctx, chunks(), "anthropic", "glm-5.3-flash", (u: any) => {
      seen = u;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/`);
  const text = await res.text();
  server.close();
  check("答复是 Anthropic 的帧", text.includes("message_stop"), text.slice(0, 200));
  check("用量回调被叫到了", seen !== null, String(seen));
  check("输入数对", seen?.prompt_tokens === 12 || seen?.input_tokens === 12, JSON.stringify(seen));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
