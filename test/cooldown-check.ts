// test/cooldown-check.ts — 账号的冷却：失败之后那个账号不再被路由到。
//
//   node --experimental-strip-types test/cooldown-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖的是 2026-10-30 要的那件事：限流的账号（正文里写着「您的限额将在
// 2026-10-30 07:55:44 重置」）在冷却期内不再被路由到，请求落到下一个账号；
// 下一个请求连试都不试它。不可用的账号用固定的 5 分钟；服务成功一次，冷却
// 就没了；冷却落库，重启以后还在。
//
// 断言的是「请求落到了哪个账号」与「库里那一行写了什么」：假上游收到的调用
// 序列必须是 1,2 然后 2，而不是 1,2,1,2。
//
// 末尾还有三条算法上的断言（在本进程里直接跑）：
//   1. 短冷却不能盖掉长冷却；
//   2. 额度见底的窗口说了算（周额度见底就等周窗口，不等 5 小时那个）；
//   3. 额度类的失败取最晚的恢复时间，别的失败取上游说的那个。

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

// 本进程里直接跑几段算法，所以给本进程一个自己的数据目录 —— 跟网关那份、
// 跟真的那份都无关。（网关的子进程各自用自己的目录，这里不传给他们。）
const UNIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-unit-"));
process.env.BUDDY_DATA_DIR = UNIT_DIR;

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
  /** 流式答复：写完第一帧就断（socket destroy），模拟中途断流。 */
  breakStream?: boolean;
}

let plans: Record<string, Plan> = {};
/** 上游被叫过的账号，按先后顺序（只记推理请求）。 */
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

/** 平台按它自己的时区（UTC+8）写的时间：`2026-10-30 07:55:44`。 */
function platformStamp(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

/** 那一行文字解析出来是几点（毫秒）。 */
function parsePlatformStamp(text: string): number {
  return Date.parse(`${text.replace(" ", "T")}+08:00`);
}

/** 限流：正文里写着什么时候重置。 */
function rateLimited(resetAtMs: number): Plan {
  return {
    status: 429,
    body: {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: `您的限额将在 ${platformStamp(resetAtMs)} 重置`,
      },
    },
  };
}

/** 服务挂了。 */
function broken(): Plan {
  return {
    status: 500,
    body: { type: "error", error: { type: "api_error", message: "假上游挂了" } },
  };
}

/** 一个流式答复的几帧（Anthropic 方言）。 */
function sseFrames(): string {
  return (
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message",' +
    '"role":"assistant","model":"minimax-m3.1-flash","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
    '"delta":{"type":"text_delta","text":"ok"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},' +
    '"usage":{"output_tokens":2}}\n\n' +
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
  );
}

/** 那一帧（第一个事件）—— 断流就是断在它后面。 */
function firstFrame(): string {
  const frames = sseFrames();
  return frames.slice(0, frames.indexOf("\n\n") + 2);
}

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    // 只有推理请求算数：余额、套餐那些是健康快照问的，不该混进调用序列。
    if (!req.url?.endsWith("/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [] }));
      return;
    }
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    const who = token.replace(/^tok-/, "");
    calls.push(who);
    const plan = plans[who];
    if (!plan) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `没有这个账号：${who}` } }));
      return;
    }
    // 流式请求答的是帧，不是整块 JSON。
    const raw = Buffer.concat(chunks).toString("utf8");
    let wantsStream = false;
    try {
      wantsStream = JSON.parse(raw || "{}")?.stream === true;
    } catch {
      /* 不是 JSON */
    }
    if (wantsStream) {
      res.writeHead(plan.status, { "content-type": "text/event-stream; charset=utf-8" });
      if (plan.breakStream) {
        // 写完第一帧就断：客户端看到的是「有头有第一帧，然后断了」。
        res.write(firstFrame(), () => {
          setTimeout(() => res.socket?.destroy(), 20);
        });
        return;
      }
      res.end(sseFrames());
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
  dataDir: string;
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
 * 账号是两个：凭据直接写进这个测试自己的库 —— 与真的那台机器无关。
 * 同一个数据目录可以再起一个：那是「重启」，冷却得还在。
 */
async function startGateway(dataDir?: string): Promise<Gateway> {
  const port = await freePort();
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-"));
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: dir,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      MINIMAX_BASE_URL: upstreamBase,
      // 健康快照要问余额与套餐：也指到本机的假服务，别碰真的平台。
      MINIMAX_API_BASE: upstreamBase,
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

  const tokenFile = path.join(dir, "admin-token");
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
    },
    accounts: [],
    dataDir: dir,
  };

  // 账号与凭据：只在这个测试自己的库里。
  const seed = new DatabaseSync(path.join(dir, "buddy.db"));
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

/** 发一个流式的 anthropic 请求。 */
async function chatStream(gw: Gateway): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/minimax/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

/** 库里那一行冷却。 */
function cooldownRow(dataDir: string, providerId: string): { untilMs: number; reason: string } | null {
  const db = new DatabaseSync(path.join(dataDir, "buddy.db"));
  try {
    const row = db
      .prepare("SELECT until_ms, reason FROM cooldown WHERE provider_id = ?")
      .get(providerId) as { until_ms?: number; reason?: string } | undefined;
    if (!row) return null;
    return { untilMs: Number(row.until_ms ?? 0), reason: String(row.reason ?? "") };
  } finally {
    db.close();
  }
}

/** 往库里写一行冷却（测试自己写的，跟网关写的是同一张表）。 */
function writeCooldown(dataDir: string, providerId: string, untilMs: number, reason = "test"): void {
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

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

console.log("");
console.log("场景一：限流 —— 换到下一个账号，冷却到「重置时间 + 1 分钟」");

{
  const resetAt = Date.now() + 10 * 60_000;
  const resetText = platformStamp(resetAt);
  plans = { 1: rateLimited(resetAt), 2: { status: 200, body: answerBody("second account") } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    const policy = await call(gw, "SetPlatformPolicy", {
      platform: "minimax",
      policy: "PROVIDER_POLICY_FALLBACK",
    });
    check("MiniMax Code 能设成降级", policy.body?.ok === true, JSON.stringify(policy.body));

    const first = await chat(gw);
    check("客户端拿到的是成功", first.status === 200, `${first.status} ${first.text.slice(0, 200)}`);
    check("先试第一个，再试第二个", calls.join(",") === "1,2", calls.join(","));

    const second = await chat(gw);
    check("第二个请求也成功了", second.status === 200, `${second.status} ${second.text.slice(0, 200)}`);
    check(
      "第二个请求没有再试第一个账号（它在冷却）",
      calls.join(",") === "1,2,2",
      calls.join(","),
    );

    const row = cooldownRow(gw.dataDir, gw.accounts[0]);
    check("第一个账号有一行冷却", row !== null, JSON.stringify(row));
    const expected = parsePlatformStamp(resetText) + 60_000;
    check(
      "冷却到正文里写的重置时间 + 1 分钟",
      row !== null && Math.abs(row.untilMs - expected) <= 5_000,
      row ? `${row.untilMs} 与 ${expected} 差了 ${row.untilMs - expected}` : "没有那一行",
    );
    check("冷却的理由写下来了", row?.reason === "rate-limit", String(row?.reason));
    check(
      "日志里看得见冷却",
      /cooling down \(until [^)]+\), trying minimax-2/.test(gw.log()),
      gw.log().slice(-600),
    );
  } finally {
    gw.stop();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log("场景二：不可用 —— 固定的 5 分钟");

{
  plans = { 1: broken(), 2: { status: 200, body: answerBody("second account") } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    const before = Date.now();
    const answered = await chat(gw);
    check("客户端拿到的是成功", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("换了账号", calls.join(",") === "1,2", calls.join(","));

    const row = cooldownRow(gw.dataDir, gw.accounts[0]);
    check("第一个账号有一行冷却", row !== null, JSON.stringify(row));
    const expected = before + 5 * 60_000;
    check(
      "冷却是 5 分钟",
      row !== null && Math.abs(row.untilMs - expected) <= 5_000,
      row ? `${row.untilMs} 与 ${expected} 差了 ${row.untilMs - expected}` : "没有那一行",
    );
    check("理由是服务挂了", row?.reason === "server", String(row?.reason));
  } finally {
    gw.stop();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log("场景三：成功一次，冷却就没了");

{
  plans = { 1: { status: 200, body: answerBody("first account") }, 2: { status: 200, body: answerBody("second") } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    // 一行已经过了期的冷却：过期是惰性的，判定的时候比时间就行。
    writeCooldown(gw.dataDir, gw.accounts[0], Date.now() - 1000, "test");
    const answered = await chat(gw);
    check("客户端拿到的是成功", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("用的是第一个账号", calls.join(",") === "1", calls.join(","));
    check("冷却那一行没了", cooldownRow(gw.dataDir, gw.accounts[0]) === null, "还在");
  } finally {
    gw.stop();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log("场景四：冷却落库 —— 重启以后还在");

{
  const resetAt = Date.now() + 10 * 60_000;
  plans = { 1: rateLimited(resetAt), 2: { status: 200, body: answerBody("second account") } };
  calls.length = 0;

  const gw = await startGateway();
  let dataDir = gw.dataDir;
  try {
    await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    const answered = await chat(gw);
    check("第一个请求换了账号", answered.status === 200 && calls.join(",") === "1,2", calls.join(","));
    check(
      "冷却写进库了",
      cooldownRow(dataDir, gw.accounts[0]) !== null,
      "库里没有那一行",
    );
  } finally {
    gw.stop();
  }

  // 重启：同一个数据目录，另一个进程。
  calls.length = 0;
  const again = await startGateway(dataDir);
  try {
    const answered = await chat(again);
    check("重启以后请求还是成功", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check(
      "重启以后第一个账号仍在冷却（没有再试它）",
      calls.join(",") === "2",
      calls.join(","),
    );
  } finally {
    again.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log("场景五：单一策略 —— 冷却的时候直接说，不去打上游");

{
  plans = { 1: { status: 200, body: answerBody("first account") }, 2: { status: 200, body: answerBody("second") } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_SINGLE" });
    const until = Date.now() + 7 * 60_000;
    writeCooldown(gw.dataDir, gw.accounts[0], until, "rate-limit");
    const answered = await chat(gw);
    check("客户端拿到的是 503", answered.status === 503, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("提示里说了在冷却", answered.text.includes("冷却"), answered.text.slice(0, 300));
    check("提示里说了到什么时候", answered.text.includes("恢复"), answered.text.slice(0, 300));
    check("没有去打上游", calls.length === 0, calls.join(","));
  } finally {
    gw.stop();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log("场景六：流式答复 —— 流完了才算成功，中途断了要记冷却");

{
  // 6a：流正常结束 → 冷却被清掉（成功才清）。
  plans = { 1: { status: 200, body: {} }, 2: { status: 200, body: {} } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    // 一行已经过了期的冷却：流成功一次就该没了。
    writeCooldown(gw.dataDir, gw.accounts[0], Date.now() - 1000, "test");
    const answered = await chatStream(gw);
    check(
      "流正常结束：客户端拿到了答复",
      answered.status === 200 && answered.text.includes("message_stop"),
      `${answered.status} ${answered.text.slice(0, 200)}`,
    );
    check(
      "流正常结束：冷却那一行没了",
      cooldownRow(gw.dataDir, gw.accounts[0]) === null,
      "还在",
    );

    // 6c：非流式那条路没变（成功清冷却）。
    writeCooldown(gw.dataDir, gw.accounts[0], Date.now() - 1000, "test");
    const plain = await chat(gw);
    check(
      "非流式：成功还是清掉冷却",
      plain.status === 200 && cooldownRow(gw.dataDir, gw.accounts[0]) === null,
      `${plain.status} ${plain.text.slice(0, 200)}`,
    );
  } finally {
    gw.stop();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

{
  // 6b：流在第一帧之后断了 → 那个账号要记冷却，而且原来那行冷却不能被清掉。
  plans = { 1: { status: 200, body: {}, breakStream: true }, 2: { status: 200, body: {} } };
  calls.length = 0;

  const gw = await startGateway();
  try {
    await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    // 一行已经过了期的冷却：断流不能把它清掉。
    writeCooldown(gw.dataDir, gw.accounts[0], Date.now() - 1000, "test");
    const answered = await chatStream(gw);
    check(
      "断流：客户端看到的是错误事件",
      answered.text.includes("error"),
      `${answered.status} ${answered.text.slice(0, 300)}`,
    );
    const row = cooldownRow(gw.dataDir, gw.accounts[0]);
    check(
      "断流：那个账号记了冷却，理由看得出是失败",
      row !== null && row.reason === "connection",
      JSON.stringify(row),
    );
    check(
      "断流：日志里看得见冷却",
      /cooling down until/.test(gw.log()),
      gw.log().slice(-600),
    );
  } finally {
    gw.stop();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log("算法：冷却的三条规矩");
{
  const { setCooldown, cooldownUntil } = await import("../lib/cooldown.ts");
  const { cooldownForFailure, planWindowEndsAt } = await import("../lib/router/account-cooldown.ts");
  const { setCached } = await import("../lib/store.ts");
  const { HEALTH_CACHE_ID } = await import("../lib/health-cache.ts");
  const { withUpstreamStatus, withCooldownUntil } = await import("../lib/upstream-status.ts");
  const { AuthError } = await import("../lib/credential.ts");

  // 1. 短冷却不能盖掉长冷却。
  const long = Date.now() + 2 * 3600_000;
  setCooldown("acct-long", long, "rate-limit");
  setCooldown("acct-long", Date.now() + 5 * 60_000, "server");
  const until = cooldownUntil("acct-long");
  const db = new DatabaseSync(path.join(UNIT_DIR, "buddy.db"));
  const reason = String(
    (db.prepare("SELECT reason FROM cooldown WHERE provider_id = ?").get("acct-long") as any)?.reason ?? "",
  );
  db.close();
  check(
    "短冷却没有盖掉长冷却（+2h 仍然是 +2h，理由也是长的那条）",
    until !== null && Math.abs(until - long) <= 1000 && reason === "rate-limit",
    `${until} 与 ${long} 差了 ${until === null ? "?" : until - long}，理由 ${reason}`,
  );

  // 2. 见底的窗口说了算：周额度见底就等周窗口，5 小时那个不算。
  const now = Date.now();
  const intervalEnd = now + 5 * 3600_000;
  const weeklyEnd = now + 7 * 24 * 3600_000;
  setCached(HEALTH_CACHE_ID, {
    minimax: {
      "acct-weekly": {
        tokenPlan: {
          windows: [
            {
              model: "general",
              intervalPercent: 100,
              weeklyPercent: 0,
              intervalEndsAt: new Date(intervalEnd).toISOString(),
              weeklyEndsAt: new Date(weeklyEnd).toISOString(),
            },
          ],
        },
      },
    },
  });
  const endsAt = planWindowEndsAt("acct-weekly", now);
  check(
    "周额度见底 → 恢复时间取周窗口结束（不是 5 小时那个）",
    endsAt === weeklyEnd,
    `${endsAt} 与 ${weeklyEnd} 差了 ${endsAt === null ? "?" : endsAt - weeklyEnd}`,
  );

  // 3. 额度类的失败取最晚的恢复时间；别的失败取上游说的那个（短的）。
  const bodyDate = now + 2 * 24 * 3600_000;
  const quotaError = withCooldownUntil(
    withUpstreamStatus(
      new AuthError(`您的限额将在 ${platformStamp(bodyDate)} 重置`, "", 502),
      429,
    ),
    now + 30_000,
  );
  const quotaDecision = cooldownForFailure("acct-quota", quotaError, now);
  check(
    "额度类失败：retry-after 30s 与正文里的重置时间 → 取更晚的那个",
    quotaDecision !== null &&
      quotaDecision.source === "the body" &&
      Math.abs(quotaDecision.untilMs - (parsePlatformStamp(platformStamp(bodyDate)) + 60_000)) <= 1000,
    JSON.stringify(quotaDecision),
  );

  const serverError = withCooldownUntil(
    withUpstreamStatus(new AuthError("上游挂了", "", 502), 500),
    now + 30_000,
  );
  const serverDecision = cooldownForFailure("acct-server", serverError, now);
  check(
    "非额度类失败：上游说 30 秒 → 就按 30 秒来（不取套餐窗口）",
    serverDecision !== null &&
      serverDecision.source === "the upstream's answer" &&
      Math.abs(serverDecision.untilMs - (now + 30_000)) <= 1000,
    JSON.stringify(serverDecision),
  );
}

upstream.close();
fs.rmSync(UNIT_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
