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
import os from "node:os";
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

/* ------------------------------------------------------------------ *
 * 两个 kind：上游 429 的原话都要到得了客户端
 * ------------------------------------------------------------------ */

section("两个 kind：上游的原话都到得了客户端（只修一家会露出来）");

{
  // 这一段在进程里直接用路由层。路由层模块加载时就要一个库，所以先给它一个
  // 临时目录 —— 上面那些网关子进程各用自己的那一份，互不影响。
  process.env.BUDDY_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "upstream-answer-"));
  // 两家上游的地址要在 import 之前定下来：workbuddy 是每次调用时读的，
  // tokenrhythm 是模块加载时读的。
  process.env.WORKBUDDY_CHAT_BASE = upstreamBase;
  process.env.TOKENRHYTHM_INFER_BASE = `${upstreamBase}/v1`;
  const { AuthError } = await import("../lib/credential.ts");
  const { upstreamBodyOf, withUpstreamStatus } = await import("../lib/upstream-status.ts");
  const { upstreamStatusError, runWithRetries } = await import("../lib/router/upstreams/policy.ts");
  const { minimaxRejection } = await import("../lib/router/upstreams/minimax.ts");
  const { classifyUpstreamError } = await import("../lib/router/provider-selection.ts");
  const { cooldownForFailure } = await import("../lib/router/account-cooldown.ts");
  const { TokenRhythmBusyError } = await import("../lib/tokenrhythm/transport.ts");

  // 上游拒的时候答的那份正文：它必须原样到客户端手上。
  const text = JSON.stringify(rateLimited().body);
  /** 上游这份答复（带它自己说的「过一秒再来」，好让放弃重试那条路走得快）。 */
  const upstreamAnswer = (status: number): Response =>
    new Response(text, { status, headers: { "content-type": "application/json", "retry-after": "1" } });

  /** 重试用尽之后客户端拿到的 hint —— 客户端能看到的就只有这一条。 */
  const answerHint = async (error: unknown): Promise<string> => {
    try {
      await runWithRetries(
        { id: "1" },
        "test",
        async (): Promise<never> => {
          throw error;
        },
        { sleep: async () => {} },
      );
      return "";
    } catch (e) {
      const hint = (e as { hint?: unknown }).hint;
      return typeof hint === "string" ? hint : "";
    }
  };

  // 两家两种做法：MiniMax 在适配器里自己造错误，其余几家走 policy 的
  // upstreamStatusError。两条路都要留住上游的原话，只修一家就是留了一半。
  const built: { name: string; error: object }[] = [
    { name: "minimax", error: await minimaxRejection(upstreamAnswer(429)) },
    { name: "zcode / tokenrhythm / 开放平台", error: upstreamStatusError(429, text, "ZCode ", 1000) },
  ];

  for (const one of built) {
    check(
      `${one.name}：错误上留着的是上游那份原文`,
      upstreamBodyOf(one.error) === text,
      String(upstreamBodyOf(one.error)),
    );
  }

  for (const one of built) {
    const hint = await answerHint(one.error);
    check(`${one.name}：客户端拿到的 hint 是上游那句原话`, hint.includes(UPSTREAM_MARK), hint.slice(0, 200));
  }

  // 控制组：只有状态、没有正文的错误。这时候 hint 才是网关自己编的那一句 ——
  // 没有这一条，「hint 里有原话」也可能只是因为网关自己把正文拼进去了。
  {
    const shaped = withUpstreamStatus(new AuthError("upstream HTTP 429", "", 502), 429);
    const hint = await answerHint(shaped);
    check("控制组：没有正文时客户端看到的是网关编的那句", hint === "上游返回 429。", hint);
  }

  /* ---------------------------------------------------------------- *
   * 另外两家：错误在传输层里造（workbuddy / tokenrhythm）
   * ---------------------------------------------------------------- */

  const { setSecret } = await import("../lib/store.ts");
  const { addAccount, providerSecretId } = await import("../lib/providers.ts");
  const { insertVendorPlatform } = await import("./vendor-platform.ts");
  const { workbuddyChat } = await import("../lib/workbuddy/transport.ts");
  const { tokenRhythmChat } = await import("../lib/tokenrhythm/transport.ts");

  /** 抛出来的那个错：这几家都是抛，不是返回 Response。 */
  const thrownBy = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
      return null;
    } catch (e) {
      return e;
    }
  };

  // 两个账号：凭据挂在它们自己的 id 上，与真网关一个形状。
  insertVendorPlatform("tokenrhythm", "tokenrhythm", { baseUrl: "https://tokenrhythm.test/v1" });
  const workbuddy = addAccount({ platform: "workbuddy-cn", alias: "WorkBuddy" });
  const tokenrhythm = addAccount({ platform: "tokenrhythm", alias: "TokenRhythm" });
  if (!workbuddy.ok || !tokenrhythm.ok) throw new Error("账号没有建出来");
  const now = Date.now();
  setSecret(providerSecretId(workbuddy.id), "session", {
    accessToken: "tok-wb1",
    refreshToken: "refresh-wb1",
    uid: "u-wb1",
    nickname: "",
    domain: "",
    region: "cn",
    generation: 1,
    expiresAtMs: now + 3600_000,
    refreshExpiresAtMs: now + 7200_000,
    loginAtMs: now,
    refreshedAtMs: now,
  });
  setSecret(providerSecretId(tokenrhythm.id, "account"), "account", {
    account: "",
    password: "",
    apiKey: "tok-tr1",
  });

  const askedBody = { model: "test-model", messages: [{ role: "user", content: "say ok" }] };

  // workbuddy：重试用尽之后的 429（这一条最要紧：客户端是等过三个窗口才拿到它
  // 的），以及拒凭据的 401。
  {
    plans = { wb1: rateLimited() };
    const refused = await thrownBy(() =>
      workbuddyChat(askedBody, { providerId: workbuddy.id, stream: false }),
    );
    check(
      "workbuddy：429 的错误上留着上游那份原文",
      upstreamBodyOf(refused) === JSON.stringify(rateLimited().body),
      String(upstreamBodyOf(refused)),
    );
    const hint = await answerHint(refused);
    check("workbuddy：客户端拿到的 hint 是上游那句原话", hint.includes(UPSTREAM_MARK), hint.slice(0, 200));
  }

  {
    plans = { wb1: { status: 401, body: { code: "UNAUTHORIZED", message: UPSTREAM_MARK } } };
    const refused = await thrownBy(() =>
      workbuddyChat(askedBody, { providerId: workbuddy.id, stream: false }),
    );
    check(
      "workbuddy：401 的错误上留着上游那份原文",
      String(upstreamBodyOf(refused) ?? "").includes(UPSTREAM_MARK),
      String(upstreamBodyOf(refused)),
    );
  }

  // tokenrhythm：503 但不是「繁忙」那个码（那是错误在传输层里造的那一条），
  // 以及拒 key 的 401（以前这里连正文都不读）。
  {
    plans = { tr1: { status: 503, body: { code: "RATE_LIMITED", message: UPSTREAM_MARK } } };
    const refused = await thrownBy(() => tokenRhythmChat(tokenrhythm.id, askedBody));
    check(
      "tokenrhythm：503 的错误上留着上游那份原文",
      String(upstreamBodyOf(refused) ?? "").includes(UPSTREAM_MARK),
      String(upstreamBodyOf(refused)),
    );
    const hint = await answerHint(refused);
    check("tokenrhythm：客户端拿到的 hint 是上游那句原话", hint.includes(UPSTREAM_MARK), hint.slice(0, 200));
  }

  {
    plans = { tr1: { status: 401, body: { message: UPSTREAM_MARK } } };
    const refused = await thrownBy(() => tokenRhythmChat(tokenrhythm.id, askedBody));
    check(
      "tokenrhythm：401 的正文读了并留在错误上",
      String(upstreamBodyOf(refused) ?? "").includes(UPSTREAM_MARK),
      String(upstreamBodyOf(refused)),
    );
  }

  // 中转站「忙」：正文要带，状态不带。
  //
  // 它的 429 讲的是「服务繁忙，过会儿再来」，不是「你这个账号这一分钟被限流
  // 了」。把上游的 429 挂上去，分类就变成 rate-limit：忙时给账号记一分钟冷却，
  // 策略还会在请求里替它等限流窗口 —— 而「等」刚花两单从降级路径上拿掉。所以
  // 状态留类自己的 503，只把上游原话挂上。
  {
    plans = { tr1: { status: 429, body: { code: "SERVICE_BUSY", message: UPSTREAM_MARK } } };
    const busy = await thrownBy(() => tokenRhythmChat(tokenrhythm.id, askedBody));
    check(
      "tokenrhythm 忙：正文留在错误上",
      String(upstreamBodyOf(busy) ?? "").includes(UPSTREAM_MARK),
      String(upstreamBodyOf(busy)),
    );
    check("tokenrhythm 忙：网关状态还是 503", (busy as any)?.status === 503, String((busy as { status?: unknown })?.status));
    // 分类不变才是这条修改的重点：挂上游的 429 会把它变成 rate-limit，于是
    // 忙时多出一条冷却（cooldownForFailure 对 server 给 null）。
    const failure = classifyUpstreamError(busy);
    check("tokenrhythm 忙：分类仍是 server", failure.kind === "server", failure.kind);
    check(
      "tokenrhythm 忙：不写冷却（与改之前一样）",
      cooldownForFailure("tr-busy", busy, Date.now(), true) === null,
      JSON.stringify(cooldownForFailure("tr-busy", busy, Date.now(), true)),
    );
    const hint = await answerHint(busy);
    check("tokenrhythm 忙：客户端读的是上游那句", hint.includes(UPSTREAM_MARK), hint.slice(0, 200));
    // 反证：正文摘掉之后，客户端落回网关编的那一句（证明上面那条的判别力）。
    // 这一条比的是兜底形状，不是分类：忙错的状态就是它自己的 503。
    const bare = new TokenRhythmBusyError("服务繁忙，请稍后重试", 2, "");
    const bareHint = await answerHint(bare);
    check("反证：不挂正文时客户端落回兜底那句", bareHint === "上游返回 503。", bareHint);
  }
}

upstream.close();

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
