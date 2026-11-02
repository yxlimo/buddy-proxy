// test/stream-route-check.ts — 主路由与写回客户端的两处边界，对着真网关跑。
//
//   node --experimental-strip-types test/stream-route-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖：
//   1. 客户端连着但不再读：写停滞超过 ROUTER_WRITE_STALL_MS（这里设得很小）后，
//      网关关掉连接，上游的连接也被取消；账号不记冷却，用量表记 499；
//   2. 主路由：第一个 target 答 413（上下文太长）→ 换到第二个 target；
//   3. 主路由：第一个 target 答 400 但说的是模型 → 照旧换到第二个 target；
//   4. 对照：400 是请求本身的错 → 不换。
//
// 走的是 MiniMax Code（Anthropic 方言）那条路：两个账号，降级策略。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";

const SERVICE = "/buddy.admin.v1.AdminService";
const MODEL = "MiniMax-M3.1-Flash";
const OTHER_MODEL = "MiniMax-M3";
const STALL_MS = 400;

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

function section(title: string): void {
  console.log("");
  console.log(title);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

type Mode = "flood" | "too-large" | "model-400" | "bad-request";
let mode: Mode = "flood";
const calls: { model: string }[] = [];
let upstreamClosedAt = 0;

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const head = () =>
  sse("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
  }) + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const delta = (text: string) => sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const tail = () =>
  sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
  sse("message_stop", { type: "message_stop" });

function refuse(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
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
  calls.push({ model: String(body.model ?? "") });
  res.on("close", () => {
    upstreamClosedAt = Date.now();
  });

  // 第一个 target（MODEL）拒；第二个（OTHER_MODEL）正常答。
  if (body.model === MODEL && mode === "too-large") return refuse(res, 413, "prompt is too long for this context window");
  if (body.model === MODEL && mode === "model-400") return refuse(res, 400, "the model MiniMax-M3.1-Flash does not support this parameter");
  if (mode === "bad-request") return refuse(res, 400, "messages: field required");

  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(head());
  if (mode === "flood") {
    // 大帧一直灌：客户端不读，缓冲很快就满了，网关的写只能等 drain。
    const frame = delta("x".repeat(64 * 1024));
    for (let i = 0; i < 2000 && !res.destroyed; i++) {
      if (!res.write(frame)) {
        await new Promise<void>((r) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            r();
          };
          res.on("drain", done);
          res.on("close", done);
        });
      }
    }
  } else {
    res.write(delta("second target"));
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
}

async function call(gw: Gateway, method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text };
  }
}

async function startGateway(): Promise<Gateway> {
  const gw = await startHarness({
    env: {
      MINIMAX_BASE_URL: upstreamBase,
      MINIMAX_API_BASE: upstreamBase,
      MINIMAX_REGION: "cn",
      BENEFITS_DISABLED: "1",
      ROUTER_WRITE_STALL_MS: String(STALL_MS),
    },
  });
  const tokenFile = path.join(gw.dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const local: Gateway = { ...gw, token };
  const seed = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  try {
    for (const index of [1, 2]) {
      const made = await call(local, "AddAccount", { platform: "minimax", alias: `MiniMax ${index}` });
      const id = String(made.body?.id ?? "");
      if (!id) throw new Error(`加不了 MiniMax 的账号：${JSON.stringify(made.body)}`);
      const now = Date.now();
      seed
        .prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)")
        .run(
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
  const saved = await call(local, "SavePublishedModel", {
    model: {
      id: "pub-ra",
      displayName: "RA",
      enabled: true,
      strategy: "fallback",
      targets: [
        { groupName: "minimax", upstreamModel: MODEL, weight: 2, enabled: true },
        { groupName: "minimax", upstreamModel: OTHER_MODEL, weight: 1, enabled: true },
      ],
    },
  });
  check("发布模型成功了", saved.body?.ok === true, JSON.stringify(saved.body));
  return local;
}

function dbRows(dataDir: string, sql: string): any[] {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"));
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  } finally {
    db.close();
  }
}

const ask = (model: string, stream = false) => ({
  model,
  max_tokens: 64,
  stream,
  messages: [{ role: "user", content: "say ok" }],
});

async function postRoot(gw: Gateway): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify(ask("pub-ra", true)),
  });
  return { status: res.status, text: await res.text() };
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

const gw = await startGateway();
try {
  section("1. 客户端连着但不读 —— 写停滞超过上限后网关关连接、取消上游");
  {
    mode = "flood";
    calls.length = 0;
    upstreamClosedAt = 0;
    const before = dbRows(gw.dataDir, "SELECT id FROM usage_event").length;
    let gotHead = false;
    let response: http.IncomingMessage | null = null;
    const payload = JSON.stringify(ask(MODEL, true));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: gw.port,
        path: "/minimax/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "public", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        gotHead = true;
        response = res;
        // 拿到头就不读了，连接也不断。
        res.pause();
      },
    );
    req.on("error", () => {});
    req.end(payload);
    for (let i = 0; i < 200 && !upstreamClosedAt; i++) await sleep(50);
    check("客户端拿到了头", gotHead);
    check("上游的连接被取消了（10 秒内）", upstreamClosedAt > 0, "上游一直没被关");
    // 再读：网关已经把连接关了，读到的是一个没写完的答复（aborted / 出错），
    // 不是正常的结尾。
    const cut = await new Promise<string>((resolve) => {
      const res = response as http.IncomingMessage | null;
      if (!res) return resolve("no response");
      const timer = setTimeout(() => resolve("still open"), 5000);
      const done = (how: string) => {
        clearTimeout(timer);
        resolve(how);
      };
      res.on("aborted", () => done("aborted"));
      res.on("error", () => done("aborted"));
      res.on("end", () => done(res.complete ? "complete" : "aborted"));
      res.resume();
    });
    check("网关关掉了客户端的连接（答复没写完就断了）", cut === "aborted", cut);
    check("只打了一个账号（没换人）", calls.length === 1, JSON.stringify(calls));
    req.destroy();
    let row: any;
    for (let i = 0; i < 40; i++) {
      const rows = dbRows(gw.dataDir, "SELECT ok, status FROM usage_event ORDER BY id");
      if (rows.length > before) {
        row = rows.at(-1);
        break;
      }
      await sleep(50);
    }
    check("用量表记的是 499（客户端那边的问题）", row?.status === 499 && row?.ok === 0, JSON.stringify(row));
    check("账号没记冷却", dbRows(gw.dataDir, "SELECT * FROM cooldown").length === 0, JSON.stringify(dbRows(gw.dataDir, "SELECT * FROM cooldown")));
    check("日志写明了原因", gw.log().includes("has not read for"), gw.log().slice(-500));
  }

  if (fail > 0) console.log(gw.log().slice(-4000));
  section("2. 第一个 target 413（上下文太长）—— 换到第二个");
  {
    mode = "too-large";
    calls.length = 0;
    const answered = await postRoot(gw);
    check("客户端拿到 200", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("两个 target 都试了", calls.map((c) => c.model).join(",") === `${MODEL},${OTHER_MODEL}`, JSON.stringify(calls));
    check("答案来自第二个 target", answered.text.includes("second target"), answered.text.slice(0, 300));
  }

  section("3. 第一个 target 400 但说的是模型 —— 照旧换");
  {
    mode = "model-400";
    calls.length = 0;
    const answered = await postRoot(gw);
    check("客户端拿到 200", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("两个 target 都试了", calls.map((c) => c.model).join(",") === `${MODEL},${OTHER_MODEL}`, JSON.stringify(calls));
  }

  section("4. 对照：400 是请求本身的错 —— 不换");
  {
    mode = "bad-request";
    calls.length = 0;
    const answered = await postRoot(gw);
    check("客户端拿到失败", answered.status >= 400, String(answered.status));
    check("只试了第一个 target", calls.length === 1 && calls[0].model === MODEL, JSON.stringify(calls));
  }
} finally {
  gw.stop();
  upstream.close();
}

if (fail > 0) console.log(gw.log().slice(-3000));
console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
