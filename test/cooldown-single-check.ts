// test/cooldown-single-check.ts — 没有别的账号可换时，不记冷却。
//
//   node --experimental-strip-types test/cooldown-single-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 查的是这条：只有一个账号（策略是「单一」）时，失败之后给那个账号记冷却有
// 什么用？那一段时间里这个平台一个上游请求都不打，而客户端拿到的还是同一条
// 报错 —— 什么也没换好，只是不打了。所以没有别人可换时不记冷却。
//
// 有别人可换（策略是「降级」且候选不止一个）时照旧记：换人之前先把坏掉的账号
// 放下去，下一个请求不必再试它。
//
// 三条断言：
//   1. 单一策略、一个账号、上游连续 429 → 冷却表里没有这一行，客户端最后拿到
//      的是上游那份 429（不是网关编的 cooling down）；
//   2. 降级策略、两个账号、第一个账号 429 → 仍然写冷却（按策略分，不是一律
//      不记）；
//   3. 单一策略、一个账号、凭据被拒（401）→ 也不写冷却。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";

const SERVICE = "/buddy.admin.v1.AdminService";
const MODEL = "MiniMax-M3.1-Flash";

/** 上游正文里那句话：断言客户端拿到的是上游自己的话。 */
const UPSTREAM_MARK = "TOO MANY REQUESTS FROM UPSTREAM";

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

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

interface Plan {
  status: number;
  body: unknown;
}

let plans: Record<string, Plan> = {};
/** 上游被叫过的账号，按先后顺序。 */
const calls: string[] = [];

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

/** 限流。 */
function rateLimited(): Plan {
  return {
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", message: UPSTREAM_MARK },
    },
  };
}

/** 凭据被拒。 */
function refused(): Plan {
  return {
    status: 401,
    body: { type: "error", error: { type: "api_error", message: "invalid api key" } },
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
const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway extends HarnessGateway {
  token: string;
  accounts: string[];
}

/**
 * 起一个真的网关，上游只有 MiniMax Code，指向本机的假服务。
 *
 * 账号几个由调用方说：一条要一个（单一策略），一条要两个（降级策略）。
 */
async function startGateway(accountCount: number): Promise<Gateway> {
  const gw = await startHarness({
    env: {
      MINIMAX_BASE_URL: upstreamBase,
      MINIMAX_REGION: "cn",
      QODER_LOG_ROUTE: "true",
    },
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
  for (let index = 1; index <= accountCount; index++) {
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
  seed.close();
  return local;
}

/** 打一个面板的方法（Connect over HTTP）。 */
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

/** 冷却表里的行：这个账号有没有被记冷却。 */
function cooldownRows(gw: Gateway, accountId: string): Array<{ until_ms: number; reason: string }> {
  const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db
      .prepare("SELECT until_ms, reason FROM cooldown WHERE provider_id = ?")
      .all(accountId) as Array<{ until_ms: number; reason: string }>;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * 场景一：单一策略、一个账号、连续 429 → 不记冷却
 * ------------------------------------------------------------------ */

section("单一策略（一个账号）：上游连续 429，不记冷却");

{
  plans = { 1: rateLimited() };
  calls.length = 0;

  const gw = await startGateway(1);
  try {
    const policy = await call(gw, "SetPlatformPolicy", {
      platform: "minimax",
      policy: "PROVIDER_POLICY_SINGLE",
    });
    check("能设成单一", policy.body?.ok === true, JSON.stringify(policy.body));

    const first = await chat(gw);
    const second = await chat(gw);

    check("第一次请求打到了上游", calls.includes("1"), calls.join(","));
    check("第二次请求也打到了上游（没被冷却挡住）", calls.length === 2, calls.join(","));

    const rows = cooldownRows(gw, gw.accounts[0]);
    check("冷却表里没有这个账号", rows.length === 0, JSON.stringify(rows));

    check(
      "客户端最后拿到的是上游那份 429",
      second.text.includes(UPSTREAM_MARK),
      `${second.status} ${second.text.slice(0, 200)}`,
    );
    check(
      "客户端拿到的不是网关编的 cooling down",
      !second.text.includes("cooling down") && !second.text.includes("冷却中"),
      `${second.status} ${second.text.slice(0, 200)}`,
    );
    check("第一次也是上游的话", first.text.includes(UPSTREAM_MARK), `${first.status} ${first.text.slice(0, 200)}`);
  } finally {
    gw.stop();
  }
}

/* ------------------------------------------------------------------ *
 * 场景二：降级策略、两个账号 → 仍然记冷却（控制组）
 * ------------------------------------------------------------------ */

section("降级策略（两个账号）：第一个账号 429，仍然记冷却");

{
  plans = { 1: rateLimited(), 2: { status: 200, body: answerBody("second account") } };
  calls.length = 0;

  const gw = await startGateway(2);
  try {
    const policy = await call(gw, "SetPlatformPolicy", {
      platform: "minimax",
      policy: "PROVIDER_POLICY_FALLBACK",
    });
    check("能设成降级", policy.body?.ok === true, JSON.stringify(policy.body));

    const answered = await chat(gw);
    check("客户端拿到的是成功", answered.status === 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    check("先试第一个，再试第二个", calls.join(",") === "1,2", calls.join(","));

    const rows = cooldownRows(gw, gw.accounts[0]);
    check("第一个账号被记了冷却", rows.length === 1, JSON.stringify(rows));
    const other = cooldownRows(gw, gw.accounts[1]);
    check("第二个账号没有冷却", other.length === 0, JSON.stringify(other));
  } finally {
    gw.stop();
  }
}

/* ------------------------------------------------------------------ *
 * 场景三：单一策略、一个账号、凭据被拒 → 也不记冷却
 * ------------------------------------------------------------------ */

section("单一策略（一个账号）：凭据被拒（401），也不记冷却");

{
  plans = { 1: refused() };
  calls.length = 0;

  const gw = await startGateway(1);
  try {
    const policy = await call(gw, "SetPlatformPolicy", {
      platform: "minimax",
      policy: "PROVIDER_POLICY_SINGLE",
    });
    check("能设成单一", policy.body?.ok === true, JSON.stringify(policy.body));

    const answered = await chat(gw);
    check("请求打到了上游", calls.join(",") === "1", calls.join(","));
    check("客户端拿到的是失败", answered.status !== 200, `${answered.status} ${answered.text.slice(0, 200)}`);

    const rows = cooldownRows(gw, gw.accounts[0]);
    check("冷却表里没有这个账号", rows.length === 0, JSON.stringify(rows));
  } finally {
    gw.stop();
  }
}

upstream.close();

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
