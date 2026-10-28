// test/aggregate-usage-check.ts — 聚合路由：没打到上游的失败也要留在用量表里。
//
//   node --experimental-strip-types test/aggregate-usage-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 缺口（2026-10-28）：聚合模型的所有账号都在冷却或者额度用尽时，请求根本没
// 发出去，客户端拿到 503，但 usage_event 里没有这一行 —— 面板的用量页看不到
// 这批失败。真正打到上游的那条路有行（recordRequestUsage），所以要补的是
// 「连发都没发出去」的这一行。
//
// 三件事：
//   1. 账号在冷却 → 客户端拿到 503 → 用量表里有一行（status 503，说得出原因）；
//   2. 上游答 500 → 用量表里也只有一行（不能重复计数）；
//   3. 上游答 200 → 用量表里仍然只有一行（成功那条没被弄坏）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = "/buddy.admin.v1.AdminService";
const MODEL = "MiniMax-M3.1-Flash";
/** 公布出去的模型名：客户端写的是它，用量表里的 agent_model 也是它。 */
const PUBLISHED = "pub-usage";

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
 * 假上游
 * ------------------------------------------------------------------ */

/** 假上游怎么答：答好还是答挂。 */
let mode: "ok" | "server" = "ok";

/** 一个像样的 anthropic 答复。 */
function answerBody(text: string): unknown {
  return {
    id: `msg_${Math.random().toString(16).slice(2)}`,
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    // 只有推理请求算数：余额、套餐那些是健康快照问的。
    if (!req.url?.endsWith("/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [] }));
      return;
    }
    if (mode === "server") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "假上游挂了" } }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answerBody("ok")));
  });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway {
  base: string;
  token: string;
  dataDir: string;
  account: string;
  stop: () => void;
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

/** 起一个真的网关，上游只有 MiniMax Code，指向本机的假服务。 */
async function startGateway(): Promise<Gateway> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-usage-"));
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: dataDir,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 定时器关着：不换令牌、不签到、不扫余额 —— 自测不碰任何平台。
      PERIODIC_ENABLED: "false",
      MINIMAX_BASE_URL: upstreamBase,
      MINIMAX_API_BASE: upstreamBase,
      MINIMAX_REGION: "cn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (c: Buffer) => {
    log += c.toString();
  });
  child.stderr?.on("data", (c: Buffer) => {
    log += c.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        await res.text();
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    child.kill("SIGTERM");
    console.log(log.slice(-1500));
    throw new Error("网关没起来");
  }

  const tokenFile = path.join(dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const gw: Gateway = {
    base,
    token,
    dataDir,
    account: "",
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已经走了 */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };

  // 一个 MiniMax Code 账号：凭据写进这个测试自己的库，与真的那台机器无关。
  const seed = new DatabaseSync(path.join(dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const made = await call(gw, "AddAccount", { platform: "minimax", alias: "MiniMax" });
  const account = String(made.body?.id ?? "");
  if (!account) throw new Error(`加不了 MiniMax 的账号：${JSON.stringify(made.body)}`);
  gw.account = account;
  const now = Date.now();
  insertSecret.run(
    `session:provider:${account}`,
    "session",
    JSON.stringify({
      schemaVersion: 1,
      clientId: "minimax-code",
      audience: "minimax",
      scopes: [],
      region: "cn",
      accessToken: "tok-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAtMs: now + 3600_000,
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );
  seed.close();

  // 公布一个模型：一个 target，指向 MiniMax Code。
  const saved = await call(gw, "SavePublishedModel", {
    model: {
      id: PUBLISHED,
      displayName: "用量的",
      enabled: true,
      strategy: "fallback",
      targets: [{ groupName: "minimax", upstreamModel: MODEL, weight: 1, enabled: true }],
    },
  });
  if (saved.body?.ok !== true) throw new Error(`发布模型失败：${JSON.stringify(saved.body)}`);
  return gw;
}

/** 打一个面板的方法（Connect over HTTP）。 */
async function call(gw: Gateway, method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gw.token}`,
    },
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

/** 打根路由：模型名是发布出来的那个。 */
async function ask(gw: Gateway): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "public",
      "user-agent": "pi/1.0",
      "x-session-id": "ses-usage",
    },
    body: JSON.stringify({
      model: PUBLISHED,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

/** 往库里写一行冷却（测试自己写的，跟网关写的是同一张表）。 */
function writeCooldown(dataDir: string, providerId: string, untilMs: number, reason = "rate-limit"): void {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"));
  try {
    db.prepare(
      "INSERT INTO cooldown (provider_id, until_ms, reason, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(provider_id) DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason",
    ).run(providerId, untilMs, reason, Date.now());
  } finally {
    db.close();
  }
}

/** 用量表里的行。 */
interface UsageRow {
  id: number;
  upstream_id: string;
  upstream_model: string;
  agent_model: string;
  agent: string;
  client: string;
  session_id: string;
  ok: number;
  status: number;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  error: string;
}

function usageRows(dataDir: string): UsageRow[] {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"));
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_event'")
      .get();
    if (!table) return [];
    return db.prepare("SELECT * FROM usage_event ORDER BY id").all() as unknown as UsageRow[];
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

console.log("");
console.log("场景一：账号在冷却 —— 请求没发出去，用量表里也要有一行");

{
  mode = "ok";
  const gw = await startGateway();
  try {
    writeCooldown(gw.dataDir, gw.account, Date.now() + 10 * 60_000, "rate-limit");
    const answered = await ask(gw);
    check("客户端拿到 503", answered.status === 503, `${answered.status} ${answered.text.slice(0, 200)}`);

    const rows = usageRows(gw.dataDir);
    check("用量表里有一行", rows.length === 1, `有 ${rows.length} 行`);
    const row = rows[0];
    check("状态是 503", row?.status === 503, String(row?.status));
    check("没成功", row?.ok === 0, String(row?.ok));
    check("agent_model 是公布出来的那个模型名", row?.agent_model === PUBLISHED, String(row?.agent_model));
    check("上游是那个 group", row?.upstream_id === "minimax", String(row?.upstream_id));
    check("上游模型也在", row?.upstream_model === MODEL, String(row?.upstream_model));
    check(
      "说得出来是冷却（或者额度用尽）",
      /cooling|额度/i.test(row?.error ?? ""),
      String(row?.error),
    );
    check("令牌是 0", row?.prompt_tokens === 0 && row?.completion_tokens === 0, JSON.stringify(row));
    check("客户端认出来了", row?.agent === "pi", String(row?.agent));
    check("会话也在", row?.session_id === "ses-usage", String(row?.session_id));
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景二：上游答 500 —— 用量表里只有一行（不能重复计数）");

{
  mode = "server";
  const gw = await startGateway();
  try {
    const answered = await ask(gw);
    check("客户端没拿到 200", answered.status !== 200, `${answered.status} ${answered.text.slice(0, 200)}`);

    const rows = usageRows(gw.dataDir);
    check("用量表里只有一行", rows.length === 1, `有 ${rows.length} 行`);
    check("没成功", rows[0]?.ok === 0, String(rows[0]?.ok));
    check("agent_model 是公布出来的那个模型名", rows[0]?.agent_model === PUBLISHED, String(rows[0]?.agent_model));
    check("上游是那个 group", rows[0]?.upstream_id === "minimax", String(rows[0]?.upstream_id));
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景三：上游答 200 —— 成功那条仍然只有一行");

{
  mode = "ok";
  const gw = await startGateway();
  try {
    const answered = await ask(gw);
    check("客户端拿到 200", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);

    const rows = usageRows(gw.dataDir);
    check("用量表里只有一行", rows.length === 1, `有 ${rows.length} 行`);
    check("成功了", rows[0]?.ok === 1, String(rows[0]?.ok));
    check("状态是 200", rows[0]?.status === 200, String(rows[0]?.status));
    check("agent_model 是公布出来的那个模型名", rows[0]?.agent_model === PUBLISHED, String(rows[0]?.agent_model));
  } finally {
    gw.stop();
  }
}

upstream.close();

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
