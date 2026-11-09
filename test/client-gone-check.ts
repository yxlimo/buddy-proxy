// test/client-gone-check.ts — 客户端走了：上游要停，账号不该背锅，也不该换目标。
//
//   node --experimental-strip-types test/client-gone-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 客户端走了（连接断了、它按了取消）不是上游的错。三件事必须对：
//
//   1. 上游要停：上游还在算就是在计费，账号还占着。
//   2. 账号不背锅：不记冷却（那一分钟冷却是「超时」那一类失败才记的，客户端
//      走了却记上一次，账号就白等一分钟）。
//   3. 不换目标：根路由的降级是「换一个上游也许能答出来」—— 客户端都走了，
//      换一个也一样没人要；而且那个上游白花钱。
//
// 这三件事在非流式那条路上最容易坏：答复要等整个上游的答复读完才发出去，客户端
// 正好在这中间走。Qoder 的新协议非流式就是这么消费的（await upstream.json()）；
// WorkBuddy 补的是另一个窗口 —— 上游连答复的头都还没发、workbuddyChat 还挂在
// cliFetch 上的时候（2026-11-03，作者第三轮点名）。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";

const SERVICE = "/buddy.admin.v1.AdminService";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 上游「在想」：收到请求之后很久才答。 */
const THINK_MS = 8_000;

/** 假上游收到 Qoder 那个请求了没有（客户端要走，就等这个）。 */
let qoderGotIt: () => void = () => {};
const qoderGot = new Promise<void>((resolve) => {
  qoderGotIt = resolve;
});

/** Qoder 那个请求被掐断了没有（客户端走了，网关把上游停了）。 */
let qoderAborted = false;

/** Qoder 的 chat 端点被打了几次：客户端走了之后，谁都不该再打第二次。 */
let qoderHits = 0;

/** 假上游收到 WorkBuddy 那个请求了没有（客户端要走，就等这个）。 */
let workbuddyGotIt: () => void = () => {};
const workbuddyGot = new Promise<void>((resolve) => {
  workbuddyGotIt = resolve;
});

/** WorkBuddy 那个请求被掐断了没有（客户端走了，网关把上游停了）。 */
let workbuddyAborted = false;

/** WorkBuddy 的 chat 端点被打了几次：客户端走了之后，谁都不该再打第二次。 */
let workbuddyHits = 0;

/** MiniMax Code 这一轮怎么答。 */
type MinimaxMode = "think" | "reject401";
let minimaxMode: MinimaxMode = "think";

/** 还没有答复的 MiniMax 请求。 */
interface MinimaxPending {
  res: http.ServerResponse;
  /** 测试自己把它掐掉的。 */
  forced: boolean;
  /** 网关把它掐掉的：客户端走了，网关把上游停了。 */
  abortedByGateway: boolean;
}
let minimaxPending: MinimaxPending[] = [];

/** 假上游被 MiniMax 那条路打了几次。 */
let minimaxHits = 0;
/** 每次是谁发的（凭据里的 token 认账号）：客户端走了不该换账号。 */
let minimaxCallers: string[] = [];

/** 假上游收到这一轮的 MiniMax 请求了没有（客户端要走，就等这个）。 */
let minimaxGotIt: () => void = () => {};
let minimaxGot = new Promise<void>((resolve) => {
  minimaxGotIt = resolve;
});

/** 换一轮：计数归零，给一个新的「上游收到了」信号。 */
function freshMinimaxUpstream(mode: MinimaxMode): Promise<void> {
  minimaxMode = mode;
  minimaxHits = 0;
  minimaxCallers = [];
  minimaxPending = [];
  minimaxGot = new Promise<void>((resolve) => {
    minimaxGotIt = resolve;
  });
  return minimaxGot;
}

/**
 * 上游对一条没人要的请求放弃了（生产里它过一会儿会自己断或者回一个错）。
 *
 * 不接信号的时候，网关在这里看到的是一个真的上游失败 —— 于是给账号记一笔
 * 冷却，还可能换下一个账号再打一次。接了信号的话，网关已经先把上游停了，
 * 这里一下也掐不到。
 */
function minimaxGivesUp(): void {
  for (const entry of minimaxPending) {
    if (entry.forced || entry.abortedByGateway) continue;
    entry.forced = true;
    if (entry.res.writableEnded || entry.res.destroyed) continue;
    entry.res.writeHead(502, { "content-type": "application/json" });
    entry.res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream gave up" } }));
  }
}

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    const json = (status: number, payload: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.includes("/model/v1/chat/completions")) {
      // Qoder：上游在想。客户端在这个窗口里走掉。
      qoderHits++;
      qoderGotIt();
      const timer = setTimeout(() => {
        json(200, {
          id: "chatcmpl-fake",
          object: "chat.completion",
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }, THINK_MS);
      res.on("close", () => {
        // 答复还没写出来连接就断了：网关把上游掐掉了。
        if (!res.writableEnded) qoderAborted = true;
        clearTimeout(timer);
      });
      return;
    }
    if (url.includes("/v2/chat/completions")) {
      // WorkBuddy：上游在想 —— 连答复的头都还没发。客户端在这个窗口里走掉
      // （workbuddyChat 还在等 cliFetch，这是作者第三轮指名要补的那条）。
      workbuddyHits++;
      workbuddyGotIt();
      const timer = setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        // 上游永远先回一条流（非流式也是流聚合出来的），答什么都行：客户端早走了。
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"chatcmpl-fake","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
            "data: [DONE]\n\n",
        );
      }, THINK_MS);
      res.on("close", () => {
        // 答复还没写出来连接就断了：网关把上游掐掉了。
        if (!res.writableEnded) workbuddyAborted = true;
        clearTimeout(timer);
      });
      return;
    }
    if (url.endsWith("/messages")) {
      // MiniMax Code：客户端在这个窗口里走掉。模式决定上游怎么答。
      minimaxHits++;
      minimaxCallers.push(String(req.headers.authorization ?? "").replace("Bearer ", ""));
      minimaxGotIt();
      if (minimaxMode === "reject401") {
        // 头先给：客户端在这一刻之后才走。
        const timer = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "token rejected" } }));
        }, 100);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      const entry: MinimaxPending = { res, forced: false, abortedByGateway: false };
      minimaxPending.push(entry);
      res.on("close", () => {
        // 答复还没写出来连接就断了：谁掐的？网关掐的就是修好了，测试掐的是反证。
        if (!entry.forced) entry.abortedByGateway = true;
      });
      return;
    }
    json(404, { error: { message: "not a route the test uses" } });
  });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway extends HarnessGateway {
  token: string;
  qoderId: string;
  workbuddyId: string;
  minimaxIds: string[];
}

async function startGateway(): Promise<Gateway> {
  const gw = await startHarness({
    keepDataDir: true,
    env: {
      QODER_GLOBAL_INFER_BASE: upstreamBase,
      QODER_GLOBAL_OPENAPI_BASE: upstreamBase,
      QODER_MAX_ATTEMPTS: "1",
      WORKBUDDY_CHAT_BASE: upstreamBase,
      // 认证与刷新走的是 ENDPOINTS 的基址，不是 chat 的：也指到假上游，
      // 这样这条用例无论走到哪一步都一个真请求都不会发出去。
      WORKBUDDY_CN_BASE: upstreamBase,
      // MiniMax Code 也只有假上游。
      MINIMAX_BASE_URL: upstreamBase,
      MINIMAX_REGION: "cn",
    },
  });
  const tokenFile = path.join(gw.dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

  const seed = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const now = Date.now();

  const local: Gateway = { ...gw, token, qoderId: "", workbuddyId: "", minimaxIds: [] };
  const qoder = await call(local, "AddAccount", { platform: "qoder", alias: "Qoder" });
  const qoderId = String(qoder.body?.id ?? "");
  insertSecret.run(
    `session:provider:${qoderId}`,
    "session",
    JSON.stringify({
      schemaVersion: 1,
      region: "global",
      clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb", // privacy:allow — 编造的样例（Qoder 客户端 id，已在仓库里）
      accessToken: "dt-test-token",
      refreshToken: "drt-test-token",
      userId: "test-user",
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      machineId: "test-machine",
      machineToken: "test-machine-token",
      machineType: "test",
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );
  // WorkBuddy 的账号与会话：会话形状与 test/fake-sessions.ts 那份一致。
  const workbuddy = await call(local, "AddAccount", { platform: "workbuddy-cn", alias: "WorkBuddy" });
  const workbuddyId = String(workbuddy.body?.id ?? "");
  insertSecret.run(
    `session:provider:${workbuddyId}`,
    "session",
    JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      uid: "test-uid",
      nickname: "test",
      domain: "www.workbuddy.cn",
      region: "cn",
      generation: 1,
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );
  // 账号 id 要在：空的话下面的冷却断言会空转（WHERE provider_id = '' 什么也匹配不到）。
  check("Qoder：账号 id 拿到了", qoderId !== "", qoderId);
  check("WorkBuddy：账号 id 拿到了", workbuddyId !== "", workbuddyId);

  // MiniMax Code 的两个账号：降级策略下，客户端走了不换账号就要紧 —— 换了
  // 就是再打一个白花钱的上游。凭据形状与 test/minimax-fallback-check.ts 一致。
  for (const index of [1, 2]) {
    const made = await call(local, "AddAccount", { platform: "minimax", alias: `MiniMax ${index}` });
    const id = String(made.body?.id ?? "");
    local.minimaxIds.push(id);
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
  check(
    "MiniMax Code：两个账号都建好了",
    local.minimaxIds.length === 2 && local.minimaxIds.every((id) => id !== ""),
    JSON.stringify(local.minimaxIds),
  );
  seed.close();
  return local;
}

/** 冷却表里现在有哪些账号（网关那个进程自己写的库）。 */
function minimaxCooldowns(gw: Gateway): { provider_id: string; reason: string }[] {
  const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const rows = db.prepare("SELECT provider_id, reason FROM cooldown").all() as {
    provider_id: string;
    reason: string;
  }[];
  db.close();
  return rows;
}

/** 清掉冷却表：上一条用例落的账不该算到这一条头上。 */
async function clearMinimaxCooldowns(gw: Gateway): Promise<void> {
  const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("DELETE FROM cooldown").run();
  db.close();
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

/**
 * 发一个请求，然后走掉。
 *
 * 走掉的时机是「上游已经在算了」—— 那正是要测的窗口。
 */
function askAndLeave(
  base: string,
  routePath: string,
  model: string,
  got: Promise<void>,
  stream = false,
): Promise<void> {
  const body = JSON.stringify({
    model,
    max_tokens: 32,
    stream,
    messages: [{ role: "user", content: "say ok" }],
  });
  const url = new URL(routePath, base);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer public",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // 客户端掐断了连接，答复多半到不了这里；到得了也读一下就走。
        res.resume();
        res.on("end", () => resolve());
      },
    );
    // 客户端自己掐断了连接：这个错是预期的。
    req.on("error", () => resolve());
    req.end(body);
    void (async () => {
      await got;
      await sleep(100);
      req.destroy();
    })();
  });
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

console.log("");
console.log("客户端走了：上游停、账号不背锅、不换目标");

{
  const gw = await startGateway();
  try {
    // 只有一个 Qoder 账号、一个目标。客户端走了不该记冷却，也不该换目标。
    // （只有一个目标，所以「不换目标」是「没有第二个可换」—— 但关键是别记冷却。）
    await askAndLeave(gw.base, "/qoder/v1/chat/completions", "glm-5.3", qoderGot);
    // 给网关一点时间收尾（上游被掐断、账记完）。
    await sleep(1_500);

    check("上游被掐断了（它还在算就是在计费）", qoderAborted, "上游还在算");
    check("上游只被打了一次（客户端走了就不该再打）", qoderHits === 1, String(qoderHits));

    const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
    const cooldowns = db
      .prepare("SELECT provider_id FROM cooldown WHERE provider_id = ?")
      .all(gw.qoderId) as unknown[];
    check("账号没有记冷却（客户端走了不是账号的错）", cooldowns.length === 0, JSON.stringify(cooldowns));

    db.close();
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

{
  // WorkBuddy 走的同一条断言：上游在等答复的头的时候客户端走了。这是
  // workbuddyChat 还挂在 cliFetch 上的窗口 —— 作者第三轮点名的那条。
  const gw = await startGateway();
  try {
    await askAndLeave(gw.base, "/workbuddy-cn/v1/chat/completions", "hy3", workbuddyGot);
    await sleep(1_500);

    check("WorkBuddy：上游被掐断了（它还在算就是在计费）", workbuddyAborted, "上游还在算");
    check("WorkBuddy：上游只被打了一次（客户端走了就不该再打）", workbuddyHits === 1, String(workbuddyHits));

    const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
    const cooldowns = db
      .prepare("SELECT provider_id FROM cooldown WHERE provider_id = ?")
      .all(gw.workbuddyId) as unknown[];
    check("WorkBuddy：账号没有记冷却（客户端走了不是账号的错）", cooldowns.length === 0, JSON.stringify(cooldowns));

    db.close();
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * MiniMax Code：这条路上一次都没接过「客户端走了」
 * ------------------------------------------------------------------ */

console.log("");
console.log("MiniMax Code：客户端走了也要停上游、不记冷却、不换账号");

/**
 * 发一个请求，客户端一直等到答复（控制组用）。
 *
 * 窗口里没有「走掉」这件事，所以这一次的失败该记的账必须照记。
 */
async function askMiniMax(gw: Gateway, stream = false): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/minimax/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify({
      model: "MiniMax-M3.1-Flash",
      max_tokens: 32,
      stream,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

{
  // 1. 非流式：答复要等整个上游的答复读完才发出去。客户端正好在这中间走。
  //    两个账号 + 降级策略：不接信号的话，上游放弃那一刻网关会记冷却、换
  //    第二个账号，上游就被打了第二次。
  const gw = await startGateway();
  try {
    const policy = await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    check("MiniMax：能设成降级", policy.body?.ok === true, JSON.stringify(policy.body));
    await clearMinimaxCooldowns(gw);

    const got = freshMinimaxUpstream("think");
    await askAndLeave(gw.base, "/minimax/v1/messages", "MiniMax-M3.1-Flash", got);
    await sleep(600);
    minimaxGivesUp();
    await sleep(600);

    const aborted = minimaxPending.filter((entry) => entry.abortedByGateway).length;
    check("MiniMax 非流式：网关把上游停了", aborted === 1, `${minimaxPending.length} 条，其中 ${aborted} 条是网关掐的`);
    check("MiniMax 非流式：上游只被打了一次（没换账号）", minimaxHits === 1, minimaxCallers.join(","));
    const cooled = minimaxCooldowns(gw);
    check("MiniMax 非流式：账号没有记冷却", cooled.length === 0, JSON.stringify(cooled));
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

{
  // 2. 流式：上游连答复的头都还没发。同一个窗口，客户端走了上游就该停。
  const gw = await startGateway();
  try {
    const policy = await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    check("MiniMax：能设成降级（流式）", policy.body?.ok === true, JSON.stringify(policy.body));
    await clearMinimaxCooldowns(gw);

    const got = freshMinimaxUpstream("think");
    await askAndLeave(gw.base, "/minimax/v1/messages", "MiniMax-M3.1-Flash", got, true);
    await sleep(600);
    minimaxGivesUp();
    await sleep(600);

    const aborted = minimaxPending.filter((entry) => entry.abortedByGateway).length;
    check("MiniMax 流式：网关把上游停了", aborted === 1, `${minimaxPending.length} 条，其中 ${aborted} 条是网关掐的`);
    check("MiniMax 流式：上游只被打了一次（没换账号）", minimaxHits === 1, minimaxCallers.join(","));
    const cooled = minimaxCooldowns(gw);
    check("MiniMax 流式：账号没有记冷却", cooled.length === 0, JSON.stringify(cooled));
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

{
  // 3. 控制组：客户端还在，上游真的拒了凭据。这一次必须照旧记冷却，不然就是拿
  //    「客户端走了」去豁免真的故障。
  //
  //    判据用「凭据被拒」而不是「连接断掉」：连接断掉本来就不算到账号头上
  //    （lib/router/account-cooldown.ts），拿它当判据证明不了任何事。
  const gw = await startGateway();
  try {
    const policy = await call(gw, "SetPlatformPolicy", { platform: "minimax", policy: "PROVIDER_POLICY_FALLBACK" });
    check("MiniMax：能设成降级（控制组）", policy.body?.ok === true, JSON.stringify(policy.body));
    await clearMinimaxCooldowns(gw);

    // 客户端还在，上游拒了这个凭据（401）。
    freshMinimaxUpstream("reject401");
    const answered = await askMiniMax(gw);
    await sleep(300);

    check("MiniMax 控制组：客户端拿到的是失败", answered.status >= 400, `${answered.status} ${answered.text.slice(0, 120)}`);
    const cooled = minimaxCooldowns(gw);
    check(
      "MiniMax 控制组：账号照旧记「凭据被拒」冷却（判据没被放宽）",
      cooled.length > 0 && cooled.every((row) => row.reason === "credential"),
      JSON.stringify(cooled),
    );
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 开放平台：这两条路以前一处都没接
 * ------------------------------------------------------------------ */

console.log("");
console.log("开放平台：客户端走了也要停上游、不记冷却、不换账号");

/**
 * 开放平台的假上游。按路径前缀决定行为：
 *
 *   /think/…     上游在想：一个字节都还没发（客户端在这个窗口里走）
 *   /refuse/…    上游把凭据拒了（401，正文马上就完）
 *   /reject401/… 上游先说 401，正文迟迟不完
 */
interface OpenPending {
  res: http.ServerResponse;
  /** 测试自己把它掐掉的：模拟上游对一条没人要的请求放弃。 */
  forced: boolean;
  /** 网关把它掐掉的：客户端走了，网关把上游停了。 */
  abortedByGateway: boolean;
}

/** 假上游被调了几次。 */
let openHits = 0;
/** 每次被调是哪个账号发的（归因头里那个）。 */
let openAccounts: string[] = [];
/** 还没答的请求。 */
let openPending: OpenPending[] = [];
/** 假上游收到这一轮的请求了没有。 */
let openGotIt: () => void = () => {};
let openGot = new Promise<void>((resolve) => {
  openGotIt = resolve;
});

/** 换一轮：计数归零，给一个新的「上游收到了」信号。 */
function freshOpenUpstream(): Promise<void> {
  openHits = 0;
  openAccounts = [];
  openPending = [];
  openGot = new Promise<void>((resolve) => {
    openGotIt = resolve;
  });
  return openGot;
}

/**
 * 上游对一条没人要的请求放弃了。
 *
 * 不接信号的时候，生产里看到的就是这个：客户端早走了，上游过了一会儿把那条
 * 连接断了，网关看到 ECONNRESET —— 连接被掐断不是账号的错，不记冷却。接了信
 * 号的话，这个时候网关已经先把上游停了，这里一下也掐不到。
 */
function upstreamGivesUp(): void {
  for (const entry of openPending) {
    if (entry.abortedByGateway) continue;
    entry.forced = true;
    entry.res.destroy();
  }
}

const openUpstream = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    openHits++;
    openAccounts.push(String(req.headers["x-account-id"] ?? ""));
    openGotIt();
    if (url.pathname.startsWith("/refuse/")) {
      // 上游把凭据拒了，正文马上就完：这是真的故障，该记的账必须照记。
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "token rejected" } }));
      return;
    }
    const entry: OpenPending = { res, forced: false, abortedByGateway: false };
    openPending.push(entry);
    res.on("close", () => {
      // 答复还没写出来连接就断了：谁掐的？网关掐的就是修好了，测试掐的是反证。
      if (!entry.forced) entry.abortedByGateway = true;
    });
    if (url.pathname.startsWith("/reject401/")) {
      // 头先给：客户端在这一刻之后才走，网关已经拿到 401 了。
      res.writeHead(401, { "content-type": "application/json" });
      res.flushHeaders();
      return;
    }
    // /think/…：上游在想，一个字节都还没有。
  });
});

await new Promise<void>((resolve) => openUpstream.listen(0, "127.0.0.1", resolve));
const openUpstreamBase = `http://127.0.0.1:${(openUpstream.address() as { port: number }).port}`;

/* ------------------------------------------------------------------ *
 * 网关（本进程里）：开放平台是表里的一行，直接建行、建账号、写 key
 * ------------------------------------------------------------------ */

// 必须在 import 之前：数据目录是模块求值时读的。
process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-client-gone-open-"));
process.env.PERIODIC_ENABLED = "false";
process.env.BENEFITS_DISABLED = "1";
// MiniMax Code 的上游只在「客户端走了 + 上游同时报 401」那一条用例里用：指向假
// 上游的 401 分支（base 上多出来的那段路径会原样带到上游的 URL 上）。
process.env.MINIMAX_BASE_URL = `${upstreamBase}/reject401`;
process.env.MINIMAX_REGION = "cn";

const { app } = await import("../lib/router/app.ts");
const { createOpenPlatform, syncPlatformModels } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
const { setPlatformPolicy } = await import("../lib/platforms.ts");
const { store } = await import("../lib/store.ts");
const { anthropicPlatformChat } = await import("../lib/router/upstreams/open-platform.ts");
const { toMinimax } = await import("../lib/router/upstreams/minimax.ts");

const openServer = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => openServer.once("listening", () => resolve()));
const openBase = `http://127.0.0.1:${(openServer.address() as { port: number }).port}`;

/** 一个模型名：请求得问一个平台目录里有的名字。 */
const MODEL = "m-1";

/**
 * 建一个开放平台 + 两个账号（每个账号一把 key），策略设成 fallback。
 *
 * 两个账号是故意的：客户端走了还换账号的话，上游会被打第二次 —— 那就是
 * 「白打一个上游、还给账号记一笔」的现场。
 */
function seedOpenPlatform(id: string, kind: string, prefix: string): string[] {
  const created = createOpenPlatform({ id, label: id, baseUrl: `${openUpstreamBase}${prefix}`, kind });
  if (!created.ok) throw new Error(`${id} 建不起来：${created.message}`);
  // 目录是上游那一份：这里直接写进行里（等价于上游答了一次）。
  syncPlatformModels(id, [MODEL], {});
  setPlatformPolicy(id, "fallback");
  return [1, 2].map((n) => {
    const account = addAccount({ platform: id });
    if (!account.ok || !account.id) throw new Error(`${id} 账号加不起来：${account.message}`);
    writeOpenPlatformKey(account.id, `sk-TESTONLY-${id}-${n}`); // privacy:allow — 编造的样例
    return account.id;
  });
}

/** 冷却表里现在有什么。 */
function cooldownsNow(): { provider_id: string; reason: string }[] {
  return store().prepare("SELECT provider_id, reason FROM cooldown").all() as {
    provider_id: string;
    reason: string;
  }[];
}

/** 清掉冷却表：上一条用例落的账不该算到这一条头上。 */
function clearCooldowns(): void {
  store().prepare("DELETE FROM cooldown").run();
}

const openaiIds = seedOpenPlatform("opencode-go", "openai", "/think/v1");
const anthropicIds = seedOpenPlatform("claude-compat", "anthropic", "/think/v1");
const refusedIds = seedOpenPlatform("walkaway-refused", "anthropic", "/refuse/v1");
check(
  "开放平台与账号都建好了",
  openaiIds.length === 2 && anthropicIds.length === 2 && refusedIds.length === 2,
  JSON.stringify({ openaiIds, anthropicIds, refusedIds }),
);

{
  // 1. OpenAI 方言，非流式：答复要等整个上游的答复读完才发出去。
  clearCooldowns();
  const got = freshOpenUpstream();
  await askAndLeave(openBase, "/opencode-go/v1/chat/completions", MODEL, got);
  // 给网关一点时间收尾，再让上游放弃那条没人要的请求（不接信号时它才会被数到账上）。
  await sleep(600);
  upstreamGivesUp();
  await sleep(600);

  const aborted = openPending.filter((entry) => entry.abortedByGateway).length;
  check("OpenAI 非流式：网关把上游停了", aborted === 1, `${openPending.length} 条，其中 ${openPending.filter((e) => e.abortedByGateway).length} 条是网关掐的`);
  check("OpenAI 非流式：上游只被打了一次（客户端走了不该再换账号）", openHits === 1, String(openHits));
  const cooled = cooldownsNow();
  check("OpenAI 非流式：账号没有记冷却", cooled.length === 0, JSON.stringify(cooled));
}

{
  // 2. OpenAI 方言，流式：上游连第一帧都还没发。
  clearCooldowns();
  const got = freshOpenUpstream();
  await askAndLeave(openBase, "/opencode-go/v1/chat/completions", MODEL, got, true);
  await sleep(600);
  upstreamGivesUp();
  await sleep(600);

  const aborted = openPending.filter((entry) => entry.abortedByGateway).length;
  check("OpenAI 流式：网关把上游停了", aborted === 1, `${openPending.length} 条，其中 ${openPending.filter((e) => e.abortedByGateway).length} 条是网关掐的`);
  check("OpenAI 流式：上游只被打了一次", openHits === 1, String(openHits));
  const cooled = cooldownsNow();
  check("OpenAI 流式：账号没有记冷却", cooled.length === 0, JSON.stringify(cooled));
}

{
  // 3. Anthropic 方言：同一个窗口，换一个方言。
  clearCooldowns();
  const got = freshOpenUpstream();
  await askAndLeave(openBase, "/claude-compat/v1/messages", MODEL, got);
  await sleep(600);
  upstreamGivesUp();
  await sleep(600);

  const aborted = openPending.filter((entry) => entry.abortedByGateway).length;
  check("Anthropic 方言：网关把上游停了", aborted === 1, `${openPending.length} 条，其中 ${openPending.filter((e) => e.abortedByGateway).length} 条是网关掐的`);
  check("Anthropic 方言：上游只被打了一次", openHits === 1, String(openHits));
  const cooled = cooldownsNow();
  check("Anthropic 方言：账号没有记冷却", cooled.length === 0, JSON.stringify(cooled));
}

{
  // 4. 反过来的反证：客户端还在，上游真的拒了凭据。这一次必须照旧记冷却，
  //    不然就是拿「客户端走了」去豁免真的故障。
  //
  //    判据用「凭据被拒」而不是「连接断掉」：连接断掉本来就不算到账号头上
  //    （lib/router/account-cooldown.ts），拿它当判据证明不了任何事。
  clearCooldowns();
  freshOpenUpstream();
  const res = await fetch(`${openBase}/walkaway-refused/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer public" },
    body: JSON.stringify({ model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "say ok" }] }),
  });
  const text = await res.text();
  await sleep(500);

  check("客户端还在：上游拒了凭据，客户端拿到的是失败", res.status >= 400, `HTTP ${res.status} ${text.slice(0, 120)}`);
  const cooled = cooldownsNow();
  check(
    "客户端还在：账号照旧记「凭据被拒」冷却",
    cooled.length > 0 && cooled.every((row) => row.reason === "credential"),
    JSON.stringify(cooled),
  );
}

{
  // 5. 上游的 401 跟「客户端走了」撞在一起：报出去的必须是「客户端走了」，
  //    不能是一笔凭据被拒的账（客户端连这个答复都没要）。
  freshOpenUpstream();
  const controller = new AbortController();
  const answered = anthropicPlatformChat(
    {
      id: "anthropic",
      label: "Anthropic 兼容",
      base: `${openUpstreamBase}/reject401/v1`,
      key: "sk-TESTONLY-401", // privacy:allow — 编造的样例
    },
    { model: MODEL, stream: false },
    {},
    controller.signal,
  );
  await openGot;
  // 401 的头已经到了（fetch 已经回来了），正文还在路上：这时候客户端走了。
  await sleep(300);
  controller.abort();
  const error = await answered.then(
    () => null,
    (e: unknown) => e,
  );
  check(
    "客户端走了：上游的 401 不报成凭据被拒",
    (error as Error | null)?.name === "ClientGoneError",
    String((error as Error | null)?.name ?? "没有报错"),
  );
}

/* ------------------------------------------------------------------ *
 * MiniMax Code：客户端走了 + 上游同时报错
 * ------------------------------------------------------------------ */

console.log("");
console.log("MiniMax Code：客户端走了的时候，上游的那一笔账记不到账号头上");

{
  // MiniMax 的 401 是 transport 里直接抛的 AuthError（不是一张 Response），所以
  // 「客户端走了」与「上游回 401」撞在一起时，错不能是 AuthError —— 包成它，
  // 日志与冷却都把这一笔记到了账号头上，还会触发降级。
  //
  // 这里直接调 toMinimax：客户端已经走了的时候，答复是发不回去的，经由网关
  // 发请求看不到那个错对象。
  const account = addAccount({ platform: "minimax" });
  if (!account.ok || !account.id) throw new Error(`MiniMax 账号加不起来：${account.message}`);
  const now = Date.now();
  store()
    .prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)")
    .run(
      `session:provider:${account.id}`,
      "session",
      JSON.stringify({
        schemaVersion: 1,
        clientId: "minimax-code",
        audience: "minimax",
        scopes: [],
        region: "cn",
        accessToken: "tok-401",
        refreshToken: "refresh-401",
        tokenType: "Bearer",
        expiresAtMs: now + 3600_000,
        generation: 1,
        loginAtMs: now,
        refreshedAtMs: now,
      }),
      now,
    );

  /**
   * 一个够用的假 Koa 上下文：这一条只看「客户端走了」那一件事。
   *
   * `leave()` 就是客户端掐断连接（koa 那边是响应上的 close 事件）。
   */
  function fakeClient(): { out: any; leave: () => void } {
    const res = new EventEmitter() as any;
    res.destroyed = false;
    res.headersSent = false;
    res.writableEnded = false;
    res.setHeader = () => {};
    res.write = () => true;
    res.end = () => {};
    return {
      out: { res, req: {} },
      leave: () => {
        res.destroyed = true;
        res.emit("close");
      },
    };
  }

  const { out, leave } = fakeClient();
  const got = freshMinimaxUpstream("reject401");
  const answered = toMinimax(
    { logRoute: false } as any,
    { model: "MiniMax-M3.1-Flash", max_tokens: 32, stream: false, messages: [{ role: "user", content: "say ok" }] },
    { platform: "minimax", model: "MiniMax-M3.1-Flash" },
    "anthropic",
    false,
    out,
  );
  await got;
  // 上游收到请求了，它的 401 马上就到：客户端在这一刻走掉。
  leave();
  const error = await answered.then(
    () => null,
    (e: unknown) => e,
  );
  check(
    "MiniMax：客户端走了 + 上游 401，拿到的是「客户端走了」",
    (error as Error | null)?.name === "ClientGoneError",
    String((error as Error | null)?.name ?? "没有报错"),
  );
}

/* ------------------------------------------------------------------ *
 * 答复送完之后的那一响 close：不是「客户端走了」
 * ------------------------------------------------------------------ */

console.log("");
console.log("答复送完之后 close 也会响：那一响不是「客户端走了」");

const { runUnderClientGone } = await import("../lib/router/upstreams/client-gone.ts");

/**
 * 一个够用的假响应：`close` 能自己触发，`writableFinished` 可设。
 *
 * 这一条只看「客户端走了」在 close 之后成立不成立，所以不经过网络。
 */
function fakeResponse(writableFinished: boolean): { out: any; close: () => void } {
  const res = new EventEmitter() as any;
  res.destroyed = false;
  res.headersSent = false;
  res.writableEnded = false;
  res.writableFinished = writableFinished;
  res.setHeader = () => {};
  res.write = () => true;
  res.end = () => {};
  return { out: { res, req: {} }, close: () => res.emit("close") };
}

{
  // 答复已经完整刷出去了：这时 close 一响照样来。它不能变成「客户端走了」——
  // 变了的话，此后同一请求里任何 Abort 形状的错都被豁免，真故障就不记账了。
  const { out, close } = fakeResponse(true);
  const seen = await runUnderClientGone(out, async (guard) => {
    close();
    return {
      gone: guard.gone(),
      // 后果：Abort 形状的错还该算上游的错（不可豁免、不可降级）。
      exempted: guard.fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })) !== null,
    };
  });
  check("答复送完之后 close 响了：没被记成「客户端走了」", seen.gone === false, String(seen.gone));
  check("答复送完之后：Abort 形状的错仍算上游的错（没被豁免）", seen.exempted === false, String(seen.exempted));
}

{
  // 反过来的控制组：答复没送完就断了，那才是客户端走了。
  const { out, close } = fakeResponse(false);
  const gone = await runUnderClientGone(out, async (guard) => {
    close();
    return guard.gone();
  });
  check("答复没送完就 close 了：还是「客户端走了」", gone === true, String(gone));
}

console.log("");
console.log(`${pass} ok, ${fail} failed`);
upstream.close();
openUpstream.close();
await new Promise<void>((resolve) => openServer.close(() => resolve()));
fs.rmSync(process.env.BUDDY_DATA_DIR!, { recursive: true, force: true });
if (fail) process.exit(1);
