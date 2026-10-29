// test/rate-wait-check.ts — TPM 限流：等得起就自己等，到点重试同一个账号。
//
//   node --experimental-strip-types test/rate-wait-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖的是七牛云那种「每分钟 token 超限」（429 + rate_limit_tpm_exceeded）：
//
//   1. 上游说了 retry-after 2 秒 → 网关自己等，到点重试**同一个**账号。客户端
//      拿到的是 200（不该看到 429/503），上游被打了两次，冷却表里没有这个账号；
//   2. 控制组 A：retry-after 120 秒（等不起）→ 客户端拿到失败，走原有的冷却；
//   3. 控制组 B：429 + retry-after 2 秒，但正文说的是 RPM（不是 TPM）→ 不等，
//      照旧失败 + 冷却。
//
// 走的是开放平台那条路（lib/router/upstreams/open-platform.ts）：SenseNova 的
// 推理地址指到本机的假上游，账号与凭据写进这个测试自己的库。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness } from "./harness.ts";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rate-wait-"));
// 本进程要用同一个库（写账号与凭据），所以给它自己的数据目录。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const MODEL = "sensenova-6.8-flash-lite";
const ACCOUNT = "sensenova";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
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
 * 假上游
 * ------------------------------------------------------------------ */

/** 假上游这三种答法。 */
type Mode = "tpm" | "tpm-long" | "rpm";
let mode: Mode = "tpm";
/** 上游被叫过的：每次调用用的哪把 key（哪把 key 就是哪个账号）。 */
const calls: string[] = [];

/** 每分钟 token 超限：七牛云就是这么说的。 */
const TPM_BODY = {
  code: "rate_limit_tpm_exceeded",
  message: "tokens per minute limit exceeded",
};

/** 每分钟请求数超限：等一下没意义，换账号才是对的。 */
const RPM_BODY = {
  code: "rate_limit_rpm_exceeded",
  message: "requests per minute exceeded",
};

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const json = (payload: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  /** 限流：带上上游自己说的「过多久再来」。 */
  const limited = (body: unknown, retryAfter: string): void => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": retryAfter });
    res.end(JSON.stringify(body));
  };

  // 模型清单：网关启动时问一次。
  if (url.pathname === "/sensenova/v1/models" && req.method === "GET") {
    json({
      data: [
        {
          id: MODEL,
          name: "SenseNova 6.8 Flash Lite",
          context_length: 1048576,
          max_output_length: 65536,
          input_modalities: ["text"],
          output_modalities: ["text"],
          supported_features: ["tools", "reasoning"],
        },
      ],
    });
    return;
  }

  // 推理：按场景答。
  if (url.pathname === "/sensenova/v1/chat/completions" && req.method === "POST") {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    calls.push(key);
    if (mode === "tpm-long") {
      // 等不起：上游说了「过两分钟再来」。
      limited(TPM_BODY, "120");
      return;
    }
    if (mode === "rpm") {
      limited(RPM_BODY, "2");
      return;
    }
    if (calls.length === 1) {
      // 第一回超了 TPM。上游答得慢一点：这样「等了 2 秒」在耗时上看得清楚
      // （网关等的是上游说的那个窗口，不含上游自己答话的时间）。
      await new Promise((r) => setTimeout(r, 150));
      limited(TPM_BODY, "2");
      return;
    }
    json({
      id: "c1",
      object: "chat.completion",
      created: 1792585589,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 },
    });
    return;
  }

  // 别的（控制台的额度那些）：答「没有」，免得测试去碰真的平台。
  json({ error: `no fake route for ${req.method} ${url.pathname}` }, 404);
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
const fakeBase = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;

/* ------------------------------------------------------------------ *
 * 账号与凭据：写进这个测试自己的库
 * ------------------------------------------------------------------ */

const { store } = await import("../lib/store.ts");
const db = store();
const now = Date.now();

db.prepare(
  "INSERT OR REPLACE INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) " +
    "VALUES (?, ?, ?, 1, 100, ?, ?)",
).run(ACCOUNT, "sensenova", "假账号", now, now);

db.prepare(
  "INSERT OR REPLACE INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)",
).run(
  "session:provider:sensenova",
  "session",
  JSON.stringify({
    cookie: "oauth2_authentication_session=abc",
    accessToken: "sense-token",
    refreshToken: "sense-refresh",
    expiresAtMs: now + 3600_000,
    obtainedAtMs: now,
    username: "someone",
  }),
  now,
);

db.prepare(
  "INSERT OR REPLACE INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)",
).run(
  "key:provider:sensenova:account",
  "account",
  JSON.stringify({ user: "someone", password: "", apiKey: "sk-sensenova-test" }),
  now,
);

// 模型清单：先写好一份，网关问上游之前就有目录可路由。
db.prepare("INSERT OR REPLACE INTO cache (id, data, at) VALUES (?, ?, ?)").run(
  "sensenova:catalog",
  JSON.stringify({
    items: [
      {
        id: MODEL,
        name: "SenseNova 6.8 Flash Lite",
        contextLength: 1048576,
        maxOutputLength: 65536,
        inputModalities: ["text"],
        outputModalities: ["text"],
        features: ["tools", "reasoning"],
      },
    ],
    at: now,
  }),
  now,
);

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

const gw = await startHarness({
  dataDir: DATA_DIR,
  // 目录归这个测试：helper 不许删。
  keepDataDir: true,
  env: {
    BENEFITS_DISABLED: "1",
    // 推理端点与控制台都指向假上游：一个字都不出机器。
    SENSENOVA_BASE: `${fakeBase}/sensenova/v1`,
    SENSENOVA_PLATFORM_BASE: `${fakeBase}/sensenova`,
    SENSENOVA_IAM_BASE: `${fakeBase}/sensenova-iam`,
    INTERN_AI_DISCOVERY_API_BASE: `${fakeBase}/intern-ai/v1`,
    INTERN_AI_DISCOVERY_BASE: `${fakeBase}/intern-ai`,
    TOKENRHYTHM_API_BASE: `${fakeBase}/tokenrhythm`,
    MINIMAX_API_BASE: `${fakeBase}/minimax`,
    MINIMAX_BASE_URL: `${fakeBase}/minimax`,
  },
});

function cleanup(): void {
  gw.stop();
  fake.close();
}
process.on("exit", cleanup);

/** 等目录出来：目录是问上游要来的，要一小会儿。 */
async function waitForModels(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${gw.base}/sensenova/v1/models`);
    const body = await res.json().catch(() => null);
    if ((body?.data ?? []).length > 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

check("网关起来了", (await fetch(`${gw.base}/health`).then((r) => r.ok)) === true);
check("模型目录出来了", await waitForModels());

/** 客户端发一次请求。 */
async function chat(): Promise<{ status: number; text: string; elapsed: number }> {
  const started = Date.now();
  const res = await fetch(`${gw.base}/sensenova/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "say ok" }] }),
  });
  const text = await res.text();
  return { status: res.status, text, elapsed: Date.now() - started };
}

/** 库里那一行冷却。 */
function cooldownRow(providerId: string): { untilMs: number; reason: string } | null {
  const conn = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
  try {
    const row = conn
      .prepare("SELECT until_ms, reason FROM cooldown WHERE provider_id = ?")
      .get(providerId) as { until_ms?: number; reason?: string } | undefined;
    if (!row) return null;
    return { untilMs: Number(row.until_ms ?? 0), reason: String(row.reason ?? "") };
  } finally {
    conn.close();
  }
}

/** 把冷却清掉：每个场景从干净的状态开始。 */
function clearCooldowns(): void {
  const conn = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
  try {
    conn.exec("DELETE FROM cooldown");
  } finally {
    conn.close();
  }
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

section("场景一：TPM 限流（retry-after 2 秒）—— 网关自己等，重试同一个账号");
{
  mode = "tpm";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是 200（没看到 429/503）", answered.status === 200, `HTTP ${answered.status} ${answered.text.slice(0, 200)}`);
  check("答案有内容", answered.text.includes("ok"), answered.text.slice(0, 200));
  check("上游被打了两次", calls.length === 2, String(calls.length));
  check(
    "两次都是同一个账号（没换账号）",
    calls.length === 2 && calls[0] === calls[1] && calls[0] !== "",
    calls.join(","),
  );
  check("真的等了（≥ 2 秒）", answered.elapsed >= 2000, `${answered.elapsed}ms`);
  check("冷却表里没有这个账号", cooldownRow(ACCOUNT) === null, JSON.stringify(cooldownRow(ACCOUNT)));
  check(
    "日志里看得见在等",
    /is rate limited on tokens, waiting \d+s then retrying/.test(gw.log()),
    gw.log().slice(-600),
  );
}

section("场景二（控制组 A）：retry-after 120 秒 —— 等不起，照旧报错 + 冷却");
{
  mode = "tpm-long";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是失败（不是 200）", answered.status !== 200, `HTTP ${answered.status}`);
  check("没有等（< 5 秒）", answered.elapsed < 5000, `${answered.elapsed}ms`);
  check("上游只被打了 1 次", calls.length === 1, String(calls.length));
  const row = cooldownRow(ACCOUNT);
  check("走了原有的冷却路径", row !== null, "库里没有那一行");
  check("冷却的理由是限流", row?.reason === "rate-limit", String(row?.reason));
  check(
    "冷却到上游说的时间（120 秒上下）",
    row !== null && Math.abs(row.untilMs - (Date.now() + 120_000)) <= 5_000,
    row ? String(row.untilMs) : "没有那一行",
  );
}

section("场景三（控制组 B）：429 + retry-after 2 秒，但正文是 RPM —— 不等");
{
  mode = "rpm";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是失败（不是 200）", answered.status !== 200, `HTTP ${answered.status}`);
  check("没有等（< 1 秒）", answered.elapsed < 1000, `${answered.elapsed}ms`);
  check("上游只被打了 1 次", calls.length === 1, String(calls.length));
  const row = cooldownRow(ACCOUNT);
  check("走了原有的冷却路径", row !== null, "库里没有那一行");
  check("冷却的理由是限流", row?.reason === "rate-limit", String(row?.reason));
}

section("算法：等多久（单元）");
{
  const { rateLimitWaitMs } = await import("../lib/router/upstreams/policy.ts");
  const { withCooldownUntil, withUpstreamStatus } = await import("../lib/upstream-status.ts");
  const { AuthError } = await import("../lib/credential.ts");

  const tpm = withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429：tpm 超了", 502), 429);
  check("TPM → 等 30 秒（上游没说要等多久时的保守值）", rateLimitWaitMs(tpm) === 30_000, String(rateLimitWaitMs(tpm)));

  const withRetry = withCooldownUntil(
    withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429：tpm 超了", 502), 429),
    Date.now() + 5_000,
  );
  const wait = rateLimitWaitMs(withRetry);
  check("上游说了 5 秒 → 等 5 秒上下", wait !== null && wait >= 4_000 && wait <= 5_000, String(wait));

  const tooLong = withCooldownUntil(
    withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429：tpm 超了", 502), 429),
    Date.now() + 120_000,
  );
  check("上游说了 120 秒 → 等不起（null）", rateLimitWaitMs(tooLong) === null, String(rateLimitWaitMs(tooLong)));

  const rpm = withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429：requests per minute", 502), 429);
  check("RPM → 不等（null）", rateLimitWaitMs(rpm) === null, String(rateLimitWaitMs(rpm)));
}

cleanup();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
if (problems.length) {
  console.log("查出来的问题：");
  for (const p of problems) console.log(`  - ${p}`);
}
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
