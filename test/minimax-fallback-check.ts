// test/minimax-fallback-check.ts — MiniMax Code 的 429 会不会让网关换账号。
//
//   node --experimental-strip-types test/minimax-fallback-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖的是 2026-10-27 的那个 bug：平台的拒绝（429 + 业务码）原先在
// underPolicy 外面判断，策略只看得见异常、看不见 Response，所以 429 从来没
// 触发过降级 —— 面板上还显示「剩 2%」，实际 Token Plan 已经 0 了，请求却
// 死在第一个账号上。
//
// 断言的是「请求落到了哪个账号」：第一个账号被拒之后必须换下一个。

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

/** 每个账号（token）怎么回答。 */
interface Plan {
  status: number;
  body: unknown;
}

let plans: Record<string, Plan> = {};
/** 上游被叫过的账号，按先后顺序。 */
const calls: string[] = [];

/** 一个像样的 anthropic 答复。 */
function answerBody(text: string): unknown {
  return {
    id: `msg_${Math.random().toString(16).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "minimax-m3.1-flash",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

/** 平台用完套餐时的回答（真上游就是这个形状，码在正文末尾）。 */
function planExhausted(): Plan {
  return {
    status: 429,
    body: {
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "当前已达到 Token Plan 用量上限。为避免调用中断，请升级 Token Plan 套餐，或购买积分补充用量并开启积分自动消耗。 (2067)",
      },
    },
  };
}

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    const who = token.replace(/^tok-/, "");
    calls.push(who);
    const plan = plans[who];
    if (!plan) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `没有这个账号：${who}` } }));
      return;
    }
    res.writeHead(plan.status, { "content-type": "application/json" });
    res.end(JSON.stringify(plan.body));
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
  log: () => string;
  stop: () => void;
  accounts: string[];
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

/**
 * 起一个真的网关，上游只有 MiniMax Code，指向本机的假服务。
 *
 * 账号是两个：第一个的套餐用完了（429 + 2067），第二个还能用。凭据直接写进
 * 这个测试自己的库 —— 与真的那台机器无关。
 */
async function startGateway(): Promise<Gateway> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-fallback-"));
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: dataDir,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      MINIMAX_BASE_URL: upstreamBase,
      MINIMAX_REGION: "cn",
      // 日志里要看见「为什么换了账号」。
      QODER_LOG_ROUTE: "true",
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
    log: () => log,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已经走了 */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    accounts: [],
  };

  const seed = new DatabaseSync(path.join(dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  for (const index of [1, 2]) {
    const made = await call(gw, "AddAccount", { platform: "minimax", alias: `MiniMax ${index}` });
    const id = String(made.body?.id ?? "");
    if (!id) throw new Error(`加不了 MiniMax 的账号：${JSON.stringify(made.body)}`);
    gw.accounts.push(id);
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
        // 假上游按这个 token 认出是哪个账号。
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
  seed.close();
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

/** 发一个 anthropic 请求（面板那条路：/{上游}/v1/messages）。 */
async function chat(gw: Gateway): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/minimax/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

console.log("");
console.log("场景一：降级 —— 第一个账号的套餐用完了，换到第二个");

{
  plans = { 1: planExhausted(), 2: { status: 200, body: answerBody("second account") } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    const policy = await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    check("MiniMax Code 能设成降级", policy.body?.ok === true, JSON.stringify(policy.body));

    const answered = await chat(gw);
    check("客户端拿到的是成功", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("第一个账号被叫过", calls.includes("1"), calls.join(","));
    check("第二个账号也被叫过（说明换了人）", calls.includes("2"), calls.join(","));
    check("先试第一个，再试第二个", calls.join(",") === "1,2", calls.join(","));
    check("答案来自第二个账号", answered.text.includes("second account"), answered.text.slice(0, 200));
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景二：单一 —— 同样的失败，不换账号（控制组）");

{
  plans = { 1: planExhausted(), 2: { status: 200, body: answerBody("second account") } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    const policy = await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_SINGLE" });
    check("能设回单一", policy.body?.ok === true, JSON.stringify(policy.body));

    const answered = await chat(gw);
    check("客户端拿到的是失败", answered.status !== 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("只试了第一个账号", calls.join(",") === "1", calls.join(","));
    check("错误里带着上游的码", answered.text.includes("2067"), answered.text.slice(0, 200));
  } finally {
    gw.stop();
  }
}

upstream.close();

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
