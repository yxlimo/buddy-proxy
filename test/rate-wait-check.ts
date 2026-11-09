// test/rate-wait-check.ts — 上游说「过多久再来」：等得起就自己等，到点重试同一个账号。
//
//   node --experimental-strip-types test/rate-wait-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖的是「上游说多久后可以重试」这一个值：
//
//   1. 取值（单元）：`retry-after` 头优先，其次从正文里按语义读（"retry shortly
//      (after 30 s)"、"retry in 45 seconds"、"请 30 秒后重试"）；正文里别处的数字
//      （错误码 3001、模型名 4.5）不当秒数；正文里没有「重试」意思的句子
//      （"Request timed out after 30 seconds"）也不当秒数；正文里读出来的值超过
//      一分钟就当读不懂（头里的值不受这个上限约束）；
//   2. 端到端：上游 429 + retry-after 1 秒 → 网关自己等，到点重试**同一个**
//      账号。客户端拿到的是 200（不该看到 429/503），上游被打了两次，冷却表里
//      没有这个账号；
//   3. 正文里说「过多久再来」：没有头，正文写着 "retry after 1 s" → 照它说的
//      等 1 秒；正文说 2 秒时等的是 2 秒（不是默认的 30 秒）；
//   4. 控制组 A：retry-after 200 秒（等不起，上限是一分钟）→ 客户端拿到失败，
//      single 策略没有别的账号可换，不记冷却；
//   5. 控制组 B：retry-after 90 秒（超过一分钟）→ 不等，失败，上游只被叫一次；
//   6. 控制组 C：限流但上游没说多久 → 等默认的 30 秒（这一条在单元里验：真等
//      三十秒 × 三回的自测太慢，端到端那一条在 test/policy-check.ts 里用假钟
//      验）。
//
// 自测真等，但只等一秒级的窗口：上游说 1 秒就等 1 秒，说 2 秒就等 2 秒。
// 以前有个「把等待按比例缩短」的环境变量（ROUTER_RATE_WAIT_SCALE），它只给
// 自测用，却是生产上的旋钮：误设成 0 就是零间隔连打上游还贴「等过了」的标记。
// 它已经删掉了。
//
// 走的是开放平台那条路（lib/router/upstreams/open-platform.ts）：SenseNova 的
// 推理地址指到本机的假上游，账号与凭据写进这个测试自己的库。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway } from "./harness.ts";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rate-wait-"));
// 本进程要用同一个库（写账号与凭据），所以给它自己的数据目录。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const MODEL = "sensenova-6.8-flash-lite";
// 账号 id：建行的时候才知道（自增整数，与平台名无关）。
let ACCOUNT = "";

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

/** 假上游这几种答法。 */
type Mode = "tpm" | "tpm-long" | "rpm" | "body-wait" | "body-wait-2" | "header-long";
let mode: Mode = "tpm";
/** 上游被叫过的：每次调用用的哪把 key（哪把 key 就是哪个账号）。 */
const calls: string[] = [];

/** 每分钟 token 超限：七牛云就是这么说的。 */
const TPM_BODY = {
  code: "rate_limit_tpm_exceeded",
  message: "tokens per minute limit exceeded",
};

/** 每分钟请求数超限：上游说了多久就等多久，不看它是不是 TPM。 */
const RPM_BODY = {
  code: "rate_limit_rpm_exceeded",
  message: "requests per minute exceeded",
};

/**
 * 线上真实那条：没有 retry-after 头，「多久以后」写在正文里。
 *
 * 这一条只用在单元里（真等三十秒的自测太慢）：端到端那一条用一秒的窗口。
 */
const ONLINE_BODY =
  '{"error":{"type":"server_error","message":"Upstream request failed: ' +
  '[prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)"}}';

/** 正文里说的是 1 秒 —— 端到端真等一秒。 */
const BODY_WAIT_1 =
  '{"error":{"type":"server_error","message":"the cell is at capacity; retry shortly (after 1 s)"}}';

/**
 * 正文里说的是 2 秒 —— 与默认的 30 秒不一样。
 *
 * 这一条分辨得出「等的是上游说的那个数」与「等的是默认值」：默认是 30 秒，
 * 上游说的是 2 秒，日志里写的那个数就是答案。
 */
const BODY_WAIT_2 =
  '{"error":{"type":"server_error","message":"the cell is at capacity; retry shortly (after 2 s)"}}';

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
  /** 限流：上游什么也没说（没有头，正文里也没有时间）。 */
  const bare = (body: unknown): void => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(body);
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
      // 等不起：上游说了「过三分多钟再来」（上限是一分钟）。
      limited(TPM_BODY, "200");
      return;
    }
    if (mode === "rpm") {
      limited(RPM_BODY, "1");
      return;
    }
    if (mode === "header-long") {
      // 上游说了「过 90 秒再来」：超过一分钟，不等。
      limited(TPM_BODY, "90");
      return;
    }
    if (mode === "body-wait") {
      // 没有头，「多久以后」在正文里（一秒）。第二回答 200。
      if (calls.length === 1) {
        bare(BODY_WAIT_1);
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
    if (mode === "body-wait-2") {
      // 正文里说的是 2 秒：第二回答 200。
      if (calls.length === 1) {
        bare(BODY_WAIT_2);
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
    if (calls.length === 1) {
      // 第一回超了 TPM。上游答得慢一点：这样「等了 1 秒」在耗时上看得清楚
      // （网关等的是上游说的那个窗口，不含上游自己答话的时间）。
      await new Promise((r) => setTimeout(r, 150));
      limited(TPM_BODY, "1");
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
const { addAccount: addRateAccount } = await import("../lib/providers.ts");
const db = store();
const now = Date.now();

// 账号行在，然后把会话与推理 key 挂在它自己的 id 上。
// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("sensenova");

const rateAccount = addRateAccount({ platform: "sensenova", alias: "假账号" });
if (!rateAccount.ok || !rateAccount.id) throw new Error(`加不了账号：${rateAccount.message}`);
ACCOUNT = rateAccount.id;

db.prepare(
  "INSERT OR REPLACE INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)",
).run(
  `session:provider:${ACCOUNT}`,
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
  `key:provider:${ACCOUNT}:account`,
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

/** 网关的环境：推理端点与控制台都指向假上游，一个字都不出机器。 */
const GATEWAY_ENV = {
  BENEFITS_DISABLED: "1",
  SENSENOVA_BASE: `${fakeBase}/sensenova/v1`,
  SENSENOVA_PLATFORM_BASE: `${fakeBase}/sensenova`,
  SENSENOVA_IAM_BASE: `${fakeBase}/sensenova-iam`,
  INTERN_AI_DISCOVERY_API_BASE: `${fakeBase}/intern-ai/v1`,
  INTERN_AI_DISCOVERY_BASE: `${fakeBase}/intern-ai`,
  TOKENRHYTHM_API_BASE: `${fakeBase}/tokenrhythm`,
  MINIMAX_API_BASE: `${fakeBase}/minimax`,
  MINIMAX_BASE_URL: `${fakeBase}/minimax`,
};

const gw: Gateway = await startHarness({
  dataDir: DATA_DIR,
  // 目录归这个测试：helper 不许删。
  keepDataDir: true,
  env: GATEWAY_ENV,
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

section("场景一：限流 + retry-after 1 秒 —— 网关自己等，重试同一个账号");
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
  check("真的等了（≥ 1 秒）", answered.elapsed >= 900, `${answered.elapsed}ms`);
  check("冷却表里没有这个账号", cooldownRow(ACCOUNT) === null, JSON.stringify(cooldownRow(ACCOUNT)));
  check(
    "日志里看得见在等",
    /is rate limited, waiting 1s then retrying/.test(gw.log()),
    gw.log().slice(-600),
  );
}

section("场景二（控制组 A）：retry-after 200 秒 —— 等不起，照旧报错 + 不记冷却");
{
  mode = "tpm-long";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是失败（不是 200）", answered.status !== 200, `HTTP ${answered.status}`);
  check("没有等（< 5 秒）", answered.elapsed < 5000, `${answered.elapsed}ms`);
  check("上游只被打了 1 次", calls.length === 1, String(calls.length));
  check("single 策略没有别的账号可换，不记冷却", cooldownRow(ACCOUNT) === null, JSON.stringify(cooldownRow(ACCOUNT)));
}

section("场景三：429 + retry-after 1 秒，正文是 RPM —— 上游说了多久就等多久");
{
  // 限流不再只认 TPM：上游说了「过 1 秒再来」就等那 1 秒。等三回还是限流，
  // 才停手（那个账号是真的被限住了）。
  mode = "rpm";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是失败（不是 200）", answered.status !== 200, `HTTP ${answered.status}`);
  check("上游被打了 4 次（等三回 + 最后一回）", calls.length === 4, String(calls.length));
  check(
    "日志里说了等的是 1 秒",
    /is rate limited, waiting 1s then retrying \(wait 1\/3\)/.test(gw.log()),
    gw.log().slice(-600),
  );
  check("single 策略没有别的账号可换，不记冷却", cooldownRow(ACCOUNT) === null, JSON.stringify(cooldownRow(ACCOUNT)));
}

section("场景四：429 + 没有头 + 正文说「retry after 1 s」—— 照它说的等");
{
  mode = "body-wait";
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
  check("真的等了（≥ 1 秒）", answered.elapsed >= 900, `${answered.elapsed}ms`);
  check("冷却表里没有这个账号", cooldownRow(ACCOUNT) === null, JSON.stringify(cooldownRow(ACCOUNT)));
  check(
    "日志里看得见在等 1 秒",
    /is rate limited, waiting 1s then retrying/.test(gw.log()),
    gw.log().slice(-600),
  );
}

section("场景五（正文里说的是 2 秒）：等的是上游说的那个数，不是默认值");
{
  // 默认是 30 秒（上游什么也没说时的保守值），上游说的是 2 秒 —— 日志里写
  // 的那个数就是分辨的依据。
  mode = "body-wait-2";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是 200（没看到 429/503）", answered.status === 200, `HTTP ${answered.status} ${answered.text.slice(0, 200)}`);
  check("上游被打了两次", calls.length === 2, String(calls.length));
  check(
    "日志里等的是 2 秒（不是默认的 30 秒）",
    /is rate limited, waiting 2s then retrying/.test(gw.log()),
    gw.log().slice(-600),
  );
}

section("场景六（控制组 B）：retry-after 90 秒 —— 超过一分钟，不等");
{
  mode = "header-long";
  calls.length = 0;
  clearCooldowns();

  const answered = await chat();
  check("客户端拿到的是失败（不是 200）", answered.status !== 200, `HTTP ${answered.status}`);
  check("没有等（< 5 秒）", answered.elapsed < 5000, `${answered.elapsed}ms`);
  check("上游只被打了 1 次", calls.length === 1, String(calls.length));
  check("single 策略没有别的账号可换，不记冷却", cooldownRow(ACCOUNT) === null, JSON.stringify(cooldownRow(ACCOUNT)));
}

section("算法：等多久（单元）");
{
  const { rateLimitWaitMs } = await import("../lib/router/upstreams/policy.ts");
  const { withCooldownUntil, withUpstreamStatus } = await import("../lib/upstream-status.ts");
  const { AuthError } = await import("../lib/credential.ts");

  const limited = withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429", 502), 429);
  check(
    "限流但上游没说要等多久 → 等 30 秒（老默认值）",
    rateLimitWaitMs(limited) === 30_000,
    String(rateLimitWaitMs(limited)),
  );

  const withRetry = withCooldownUntil(
    withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429", 502), 429),
    Date.now() + 5_000,
  );
  const wait = rateLimitWaitMs(withRetry);
  check("上游说了 5 秒 → 等 5 秒上下", wait !== null && wait >= 4_000 && wait <= 5_000, String(wait));

  const oneMinute = withCooldownUntil(
    withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429", 502), 429),
    Date.now() + 60_000,
  );
  check(
    "上游说了 60 秒 → 等得起（上限就是一分钟）",
    rateLimitWaitMs(oneMinute) !== null,
    String(rateLimitWaitMs(oneMinute)),
  );

  const tooLong = withCooldownUntil(
    withUpstreamStatus(new AuthError("upstream HTTP 429", "上游返回 429", 502), 429),
    Date.now() + 90_000,
  );
  check("上游说了 90 秒 → 等不起（null）", rateLimitWaitMs(tooLong) === null, String(rateLimitWaitMs(tooLong)));

  const bad = withUpstreamStatus(new AuthError("upstream HTTP 400", "上游返回 400", 502), 400);
  check("不是限流、上游也没说时间 → 不等（null）", rateLimitWaitMs(bad) === null, String(rateLimitWaitMs(bad)));

  // 额度见底（402）也带 retry-after：照样不等。
  //
  // 上游给的 retry-after 说的是这个**请求**可以再来一次，不是这个**账号**可以
  // 再来一次。额度见底等多久都一样，等下去只是把这一轮的时间吃掉，fallback
  // 换账号被挤掉。
  const spent = withCooldownUntil(
    withUpstreamStatus(new AuthError("upstream HTTP 402", "上游返回 402", 502), 402),
    Date.now() + 30_000,
  );
  check(
    "402 带 retry-after → 不等（null）",
    rateLimitWaitMs(spent) === null,
    String(rateLimitWaitMs(spent)),
  );
}

section("取值：头优先，其次正文里的语义（单元）");
{
  const { retryAfterMs } = await import("../lib/upstream-status.ts");

  /** 一个只有头的答复。 */
  const withHeader = (retryAfter?: string): Response =>
    new Response("{}", { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });

  check(
    "头说 5 秒、正文说 30 秒 → 取头的那 5 秒",
    retryAfterMs(withHeader("5"), "retry after 30 seconds") === 5_000,
    String(retryAfterMs(withHeader("5"), "retry after 30 seconds")),
  );
  check(
    "没有头 + 线上那条原文 → 30 秒",
    retryAfterMs(withHeader(), ONLINE_BODY) === 30_000,
    String(retryAfterMs(withHeader(), ONLINE_BODY)),
  );
  check(
    "没有头 + retry shortly (after 30 s) → 30 秒",
    retryAfterMs(withHeader(), "the cell is at capacity; retry shortly (after 30 s)") === 30_000,
    String(retryAfterMs(withHeader(), "the cell is at capacity; retry shortly (after 30 s)")),
  );
  check(
    "没有头 + Please retry in 45 seconds → 45 秒",
    retryAfterMs(withHeader(), "Please retry in 45 seconds") === 45_000,
    String(retryAfterMs(withHeader(), "Please retry in 45 seconds")),
  );
  check(
    "没有头 + try again in 20s → 20 秒",
    retryAfterMs(withHeader(), "try again in 20s") === 20_000,
    String(retryAfterMs(withHeader(), "try again in 20s")),
  );
  check(
    "没有头 + wait 30s → 30 秒",
    retryAfterMs(withHeader(), "wait 30s") === 30_000,
    String(retryAfterMs(withHeader(), "wait 30s")),
  );
  check(
    "没有头 + 请 30 秒后重试 → 30 秒",
    retryAfterMs(withHeader(), "请求过于频繁，请 30 秒后重试") === 30_000,
    String(retryAfterMs(withHeader(), "请求过于频繁，请 30 秒后重试")),
  );
  check(
    "没有头 + 正文里只有错误码与模型名 → 没有时间",
    retryAfterMs(withHeader(), '{"error":{"code":3001,"message":"model 4.5 is overloaded"}}') === null,
    String(retryAfterMs(withHeader(), '{"error":{"code":3001,"message":"model 4.5 is overloaded"}}')),
  );
  check(
    "没有头 + 说的是两小时 → 读不懂（null）",
    retryAfterMs(withHeader(), "retry after 2 hours") === null,
    String(retryAfterMs(withHeader(), "retry after 2 hours")),
  );

  // 没有「重试」意思的句子不是等待窗口：那是超时文案。
  //
  // 读出来的秒数会被写进冷却表：一句普通英文把账号关掉半小时，那不是上游的
  // 意思。
  const notRetry: [string, string][] = [
    ["超时文案", "Request timed out after 30 seconds"],
    ["凭据过期", "the key expires in 30 minutes"],
    ["任务完成", "the job completes in 30 seconds"],
    ["等太久（超过一分钟）", "wait 2 minutes for the model to load"],
  ];
  for (const [name, body] of notRetry) {
    const got = retryAfterMs(withHeader(), body);
    check(`没有头 + ${name} → 没有时间（null）`, got === null, String(got));
  }

  // 头里的值不受一分钟那个上限约束：等不等是 policy 的事。
  check(
    "头说 120 秒 → 读出来还是 120 秒（上限是 policy 判的）",
    retryAfterMs(withHeader("120"), "") === 120_000,
    String(retryAfterMs(withHeader("120"), "")),
  );
}

// 等网关进程真的退了再删它的目录：Windows 上它开着的库删不掉（EPERM）。
await gw.stopAndWait();
cleanup();
// Close the database before removing its directory: on Windows an open
// file cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
if (problems.length) {
  console.log("查出来的问题：");
  for (const p of problems) console.log(`  - ${p}`);
}
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
