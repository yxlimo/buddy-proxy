// test/unreachable-check.ts — 主机名解析不出来：一次就够，立刻换人。
//
//   node --experimental-strip-types test/unreachable-check.ts
//
// 离线：起本机的网关，上游地址指向一个 DNS 里查不到的域名（`.invalid` 是
// RFC 2606 保留的，必然是 NXDOMAIN），一个上游请求都不发出去，不花任何额度。
//
// 查的是 2026-11-10 那件事：上游主机 `api2-v2.qoder.sh` 在权威 DNS 里已经是
// NXDOMAIN，而我们的分类把它当成「连接断了」—— 于是同一个账号每 2.7 秒重试
// 一次，打满 180 秒的预算（67 次）才落到下一个目标。一次请求白挂三分钟。
//
// 主机根本解析不出来是**永久**的错：同一个账号再试多少次都一样。所以它一次
// 就够 —— 立刻把机会交给下一个目标，并给那个账号记一段有限的冷却，下一个请求
// 不必再白等。
//
// 三组断言：
//   1. 分类：ENOTFOUND / EAI_FAIL / ERR_INVALID_URL / ENOTSUP → unreachable
//      （可降级）；ECONNRESET / ECONNREFUSED / UND_ERR_SOCKET → 还是 connection，
//      超时还是 timeout（反证：别把「解析不出来」的修复做成「网络错都不重试」）。
//   2. 记账：unreachable 记 5 分钟 —— 没有别的账号可换也记（这是唯一一条这样
//      的失败）；connection 仍然不记。
//   3. 端到端：单一策略一个账号 → 上游只被叫一次、冷却落库、客户端拿到人话，
//      第二个请求立刻被冷却挡住；降级策略两个账号 → 第一个失败立刻换第二个。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";

const SERVICE = "/buddy.admin.v1.AdminService";
const MODEL = "MiniMax-M3.1-Flash";

/**
 * 上游地址：一个 DNS 里必然查不到的域名。
 *
 * `.invalid` 是 RFC 2606 保留给「保证不存在」的，所以它是真的 NXDOMAIN ——
 * 不是靠本机改 hosts、也不靠网络环境。网关往 `<它>/messages` 发请求。
 */
const UNRESOLVABLE_BASE = "http://unreachable.invalid/v1";

/**
 * 重试预算（毫秒）：给网关的子进程用。
 *
 * 生产是 180 秒。测试要能看见「修好了」与「没修好」的差别：没修好时那个账号
 * 会被一直重试到预算用完（300ms、900ms 之后就到点了），所以调小到 1.5 秒 ——
 * 真等三分钟的自测没人跑得下去。
 */
const RETRY_BUDGET_MS = 1500;

const UNIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "unreachable-unit-"));
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

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 一、分类：哪个网络错是「永久不可达」
 * ------------------------------------------------------------------ */

section("分类：解析不出来是 unreachable，别的一律照旧");

{
  const { classifyUpstreamError, describeUpstreamError } = await import("../lib/router/provider-selection.ts");

  /**
   * undici 抛的那个形状：`TypeError("fetch failed")`，真正的原因在 cause 里。
   *
   * 只造一层就测不到真实路径 —— 「fetch failed」这句话本身什么都没说，外层
   * 看起来与一次断连一模一样（2026-11-10 就是在这里认错对象的）。
   */
  const fetchFailed = (code: string, message: string): TypeError =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

  // 生产上那条：getaddrinfo ENOTFOUND 那台主机。
  const notFound = fetchFailed("ENOTFOUND", `getaddrinfo ENOTFOUND api2-v2.example-host`);
  check("ENOTFOUND → unreachable", classifyUpstreamError(notFound).kind === "unreachable", classifyUpstreamError(notFound).kind);
  check("ENOTFOUND → 可降级（立刻换下一个目标）", classifyUpstreamError(notFound).degradable === true);
  check("ENOTFOUND → 日志里写 unreachable", describeUpstreamError(notFound) === "unreachable", describeUpstreamError(notFound));

  // 同一个码挂在错误自己身上（不是每种 fetch 都包一层 cause）也要认。
  const direct = Object.assign(new Error("getaddrinfo ENOTFOUND somewhere"), { code: "ENOTFOUND" });
  check("码在错误自己身上也算", classifyUpstreamError(direct).kind === "unreachable", classifyUpstreamError(direct).kind);

  check(
    "EAI_FAIL → unreachable",
    classifyUpstreamError(Object.assign(new Error("EAI_FAIL"), { code: "EAI_FAIL" })).kind === "unreachable",
  );
  check(
    "ERR_INVALID_URL → unreachable",
    classifyUpstreamError(Object.assign(new Error("Invalid URL"), { code: "ERR_INVALID_URL" })).kind === "unreachable",
  );
  check(
    "ENOTSUP → unreachable",
    classifyUpstreamError(Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" })).kind === "unreachable",
  );

  // 反证：别把「解析不出来」的修复做成「网络错都不重试」。
  check(
    "ECONNRESET → 还是 connection（不被带着改）",
    classifyUpstreamError(fetchFailed("ECONNRESET", "socket hang up")).kind === "connection",
    classifyUpstreamError(fetchFailed("ECONNRESET", "socket hang up")).kind,
  );
  check(
    "ECONNREFUSED → 还是 connection",
    classifyUpstreamError(fetchFailed("ECONNREFUSED", "connect ECONNREFUSED")).kind === "connection",
  );
  check(
    "undici 的 socket 断开 → 还是 connection",
    classifyUpstreamError(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) })).kind === "connection",
  );
  check(
    "EAI_AGAIN（解析暂时不通）→ 还是 connection",
    classifyUpstreamError(Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" })).kind === "connection",
  );
  check(
    "headers timeout → 还是 timeout",
    classifyUpstreamError(new TypeError("terminated", { cause: Object.assign(new Error("Headers Timeout Error"), { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" }) })).kind === "timeout",
  );
  check(
    "光一句 fetch failed（底下什么都没有）→ 还是 connection",
    classifyUpstreamError(new TypeError("fetch failed")).kind === "connection",
  );

  // 客户端看到的那句话要用 reason 那一层，不是外层那句 fetch failed。
  const { networkDetailOf } = await import("../lib/router/provider-selection.ts");
  const detail = networkDetailOf(notFound);
  check(
    "带出去的是 cause 里那句话（不是外层那句 fetch failed）",
    detail.includes("ENOTFOUND") && !detail.includes("fetch failed"),
    detail,
  );
}

/* ------------------------------------------------------------------ *
 * 二、记账：多久、在哪些情况下记
 * ------------------------------------------------------------------ */

section("记账：unreachable 记 5 分钟，没有别的账号可换也记");

{
  const { cooldownForFailure } = await import("../lib/router/account-cooldown.ts");
  const now = Date.now();
  const unreachable = new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api2-v2.example-host"), { code: "ENOTFOUND" }),
  });

  const alone = cooldownForFailure("acct-unreachable", unreachable, now, false);
  check("没有别的账号可换 → 也记（唯一一条这样的失败）", alone !== null, JSON.stringify(alone));
  check("理由是 unreachable", alone?.reason === "unreachable", String(alone?.reason));
  check(
    "时长是「不可用」那个 5 分钟",
    alone !== null && Math.abs(alone.untilMs - (now + 5 * 60_000)) <= 1_000,
    JSON.stringify(alone),
  );

  const withOthers = cooldownForFailure("acct-unreachable", unreachable, now, true);
  check("有别的账号可换 → 同样记", withOthers !== null, JSON.stringify(withOthers));

  // 反证：连接断掉仍然不记账（那条修复不能带跑）。
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  check("ECONNRESET → 还是不记", cooldownForFailure("acct-reset", reset, now, true) === null);
  check("ECONNRESET 且没有别人可换 → 也不记", cooldownForFailure("acct-reset", reset, now, false) === null);
}

/* ------------------------------------------------------------------ *
 * 三、端到端：一个真的网关 + 一个解析不出来的地址
 * ------------------------------------------------------------------ */

const upstreamCalls: string[] = [];

interface Gateway extends HarnessGateway {
  token: string;
  accounts: string[];
}

/**
 * 起一个真的网关：MiniMax Code 的上游指向那个查不到的域名。
 *
 * 账号几个由调用方说：一条要一个（单一策略），一条要两个（降级策略）。
 */
async function startGateway(accountCount: number): Promise<Gateway> {
  const gw = await startHarness({
    env: {
      MINIMAX_BASE_URL: UNRESOLVABLE_BASE,
      MINIMAX_REGION: "cn",
      // 生产是 180 秒。测试要看见「一次就停」与「一直试到预算用完」的差别，
      // 所以把预算调小（自测不能真等三分钟）。
      ROUTER_RETRY_BUDGET_MS: String(RETRY_BUDGET_MS),
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
        // 一小时后才过期：这一条请求不该被刷新流程插一脚（刷新也要打那个
        // 不存在的地址，会把断言指向错的地方）。
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

/** 这一段日志里出现了几次某个说法。 */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/* ------------------------------------------------------------------ *
 * 场景一：单一策略、一个账号 —— 一次就够
 * ------------------------------------------------------------------ */

section("单一策略（一个账号）：主机解析不出来，上游只被叫一次");

{
  upstreamCalls.length = 0;
  const gw = await startGateway(1);
  try {
    const policy = await call(gw, "SetPlatformPolicy", {
      platform: "minimax",
      policy: "PROVIDER_POLICY_SINGLE",
    });
    check("能设成单一", policy.body?.ok === true, JSON.stringify(policy.body));

    const before = gw.log().length;
    const answered = await chat(gw);
    const out = gw.log().slice(before);

    check("客户端拿到的是失败", answered.status !== 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    // 一个账号只打一次上游：这条日志一行就是一次尝试。
    check(
      "上游只被叫了一次（没有第二条尝试）",
      countOf(out, "cannot serve it (unreachable") === 1,
      out.slice(-600),
    );
    check(
      "没有任何一次重试（`retry N in ...`）",
      !/\bretry \d+ in \d+ms\b/.test(out),
      out.slice(-600),
    );
    check("分类在日志里是 unreachable", out.includes("(unreachable"), out.slice(-600));
    // 日志要能回答「为什么换」：光一个 unreachable 说不出是哪台主机不通。
    check(
      "日志里带着真正的原因（那台主机解析不出来）",
      out.includes("unreachable.invalid"),
      out.slice(-600),
    );

    // 客户端拿到的是人话：主机解析不出来。Node 与 undici 自己的说法（terminated、
    // 空串）既看不懂，也不是它能处理的东西。
    const said = answered.text.toLowerCase();
    check("答复里说了主机解析不出来", answered.text.includes("解析不出来"), answered.text.slice(0, 300));
    check("答复里没有 terminated", !said.includes("terminated"), answered.text.slice(0, 300));
    check("答复里没有 Node 自己那句 fetch failed", !said.includes("fetch failed"), answered.text.slice(0, 300));
    check("答复不是空的", answered.text.trim().length > 0);

    // 冷却：这个上游现在用不了，放它下去几分钟 —— 下一个请求不必再白等。
    const rows = cooldownRows(gw, gw.accounts[0]);
    check("冷却表里有这个账号", rows.length === 1, JSON.stringify(rows));
    check("冷却的理由是 unreachable", rows[0]?.reason === "unreachable", JSON.stringify(rows));
    const until = Number(rows[0]?.until_ms ?? 0);
    check(
      "冷却到 5 分钟后（不是「永远」）",
      until > Date.now() && until <= Date.now() + 5 * 60_000 + 5_000,
      String(until - Date.now()),
    );

    // 第二个请求：被冷却挡住，一个上游请求都不发。
    const beforeSecond = gw.log().length;
    const second = await chat(gw);
    const outSecond = gw.log().slice(beforeSecond);
    check("第二个请求也是失败", second.status !== 200, `${second.status} ${second.text.slice(0, 200)}`);
    check(
      "第二个请求没有再打那个地址（没有新的尝试）",
      countOf(outSecond, "cannot serve it") === 0,
      outSecond.slice(-600),
    );
    check(
      "第二个请求说的是「冷却中」",
      outSecond.includes("cooling down") || second.text.includes("冷却中"),
      `${second.text.slice(0, 200)} / ${outSecond.slice(-300)}`,
    );
  } finally {
    gw.stop();
  }
}

/* ------------------------------------------------------------------ *
 * 场景二：降级策略、两个账号 —— 立刻换下一个
 * ------------------------------------------------------------------ */

section("降级策略（两个账号）：第一个失败，立刻换第二个（两个各一次）");

{
  upstreamCalls.length = 0;
  const gw = await startGateway(2);
  try {
    const policy = await call(gw, "SetPlatformPolicy", {
      platform: "minimax",
      policy: "PROVIDER_POLICY_FALLBACK",
    });
    check("能设成降级", policy.body?.ok === true, JSON.stringify(policy.body));

    const before = gw.log().length;
    const answered = await chat(gw);
    const out = gw.log().slice(before);

    check("客户端拿到的是失败", answered.status !== 200, `${answered.status} ${answered.text.slice(0, 200)}`);
    // 两个账号各一次：换人是「立刻」的，没有一次重试插在中间。
    check(
      "两个账号各被叫了一次",
      countOf(out, "cannot serve it (unreachable") === 2,
      out.slice(-800),
    );
    check("第一个失败时说了换到第二个", out.includes("trying "), out.slice(-800));
    check("没有任何一次重试", !/\bretry \d+ in \d+ms\b/.test(out), out.slice(-800));

    const first = cooldownRows(gw, gw.accounts[0]);
    const other = cooldownRows(gw, gw.accounts[1]);
    check("第一个账号记了冷却", first.length === 1, JSON.stringify(first));
    check("第二个账号也记了冷却（同一个地址都不通）", other.length === 1, JSON.stringify(other));
    check(
      "两个都是 unreachable",
      first[0]?.reason === "unreachable" && other[0]?.reason === "unreachable",
      `${JSON.stringify(first)} ${JSON.stringify(other)}`,
    );
  } finally {
    gw.stop();
  }
}

console.log("");
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(UNIT_DIR, { recursive: true, force: true });

console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
