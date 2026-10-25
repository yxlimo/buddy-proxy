// test/provider-policy-e2e-check.ts — 改策略 → 立刻生效 → 请求落到预期账号。
//
//   node --experimental-strip-types test/provider-policy-e2e-check.ts
//
// 离线：平台与推理端点都是本机的假服务，不碰真平台，不花额度。
//
// 网关是真的：起一个真的 router-proxy.ts，用面板那条接口（Connect）改策略，
// 再用面板那条路发一个请求，看它落到哪个账号。断言的是「请求落到哪里」与
// 「失败时是什么错误」，不是「进程没崩」。
//
// 覆盖：
//   1. 单一：第一个账号接不了，不换（只试了一个账号）。
//   2. 降级：第一个账号没钱（402），换到下一个账号。
//   3. 余额到期优先：先用赠金最先到期的那个账号，不换。
//   4. 改策略立刻生效：同一个网关里改一次策略，下一个请求就换人了（不重启）。
//   5. 降级不是什么都换：请求本身的问题（400）不换账号。
//   6. 面板那一层的边界：这一类上游不支持的策略被拒；上游带回来的新策略。
//   7. 面板上改策略 → 立刻生效 → 请求落到预期账号（真浏览器点面板；
//      面板没构建时这一段跳过，用 REQUIRE_BROWSER=1 让它变成失败）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = "/buddy.admin.v1.AdminService";
const MODEL = "deepseek-v4.1-flash-1017";

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
 * 假平台与假推理端点
 * ------------------------------------------------------------------ */

/** 一个账号（租户）在假平台上的样子。 */
interface TenantPlan {
  /** 钱包里还有多少。0 就是没钱。 */
  available: number;
  /** 赠金还有多少。 */
  gift: number;
  /** 赠金什么时候到期 —— 「余额到期优先」看的就是它。 */
  expiry: string;
  /** 推理端点怎么回答。 */
  inference: { status: number; body: unknown };
}

/** 每个租户怎么表现。改这里就是改假平台的样子。 */
let plans: Record<number, TenantPlan> = {};

/** 推理端点被叫了几次，叫的是哪个租户。 */
const inferenceCalls: number[] = [];

/** 租户从 cookie 里认出来：登录时拿到的会话带着租户号。 */
function tenantOfCookie(headers: http.IncomingHttpHeaders): number {
  const cookie = String(headers.cookie ?? "");
  const hit = /tr_session=tr_session_(\d+)/.exec(cookie);
  return hit ? Number(hit[1]) : 0;
}

/** 租户从账号里认出来（登录时）。 */
function tenantOfAccount(account: unknown): number {
  const digits = String(account ?? "").replace(/\D/g, "");
  return digits ? Number(digits.slice(-2)) : 0;
}

/** 一份 OpenAI 方言的答复。 */
function answerBody(tenant: number): unknown {
  return {
    id: `chatcmpl-fake-${tenant}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content: `ok from tenant ${tenant}` }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

const platform = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    const text = Buffer.concat(chunks).toString();
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, data }));
    };

    // 登录：拿一组账号密码换一个会话 cookie。租户号在账号里。
    if (url.startsWith("/api/auth/login")) {
      let account: unknown = "";
      try {
        account = JSON.parse(text || "{}").account;
      } catch {
        /* 不是 JSON */
      }
      const tenant = tenantOfAccount(account);
      const plan = plans[tenant];
      if (!plan) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "假平台：这个账号没有租户" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [`tr_session=tr_session_${tenant}; Path=/`, `tr_csrf=csrf_${tenant}; Path=/`],
      });
      res.end(JSON.stringify({ code: 0, data: { user: { id: `u${tenant}`, name: `租户 ${tenant}` } } }));
      return;
    }

    const tenant = tenantOfCookie(req.headers);
    const plan = plans[tenant];
    if (!plan) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "假平台：这个会话没有租户" }));
      return;
    }

    // 钱包：还有多少钱。
    if (url.startsWith("/api/wallet/summary")) {
      send(200, {
        currency: "CNY",
        availableBalanceCny: plan.available,
        giftAvailableCny: plan.gift,
        rechargeBalanceCny: 0,
        giftTotalCny: plan.gift,
        giftStatus: "ACTIVE",
        asOf: new Date().toISOString(),
      });
      return;
    }
    // 赠金：什么时候到期。
    if (url.startsWith("/api/wallet/expiring-credits")) {
      send(200, {
        list: [
          {
            id: `lot-${tenant}`,
            source: "GIFT",
            sourceLabel: "赠金",
            remainingCny: plan.gift,
            expiresAt: plan.expiry,
            status: "ACTIVE",
          },
        ],
        summary: { expiringBalanceCny: plan.gift, nextExpiryAt: plan.expiry },
      });
      return;
    }
    // key：网关在没有 key 的时候会来要一把。假平台给一把假的。
    if (url.startsWith("/api/api-keys")) {
      send(200, { list: [] });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND", message: `假平台没有这个接口：${url}` }));
  });
});

const inference = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const key = String(req.headers.authorization ?? "").replace("Bearer ", "");
    const hit = /tenant_(\d+)/.exec(key);
    const tenant = hit ? Number(hit[1]) : 0;
    const plan = plans[tenant];
    inferenceCalls.push(tenant);
    if (!plan) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "INTERNAL_ERROR", message: `假推理端点：没有租户 ${tenant}` }));
      return;
    }
    res.writeHead(plan.inference.status, { "content-type": "application/json" });
    res.end(JSON.stringify(plan.inference.body));
  });
});

await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
const platformBase = `http://127.0.0.1:${(platform.address() as any).port}`;
const inferenceBase = `http://127.0.0.1:${(inference.address() as any).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway {
  base: string;
  token: string;
  /** 网关的日志（用来断言「为什么换了账号」）。 */
  log: () => string;
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

/**
 * 起一个真的网关。
 *
 * 上游只留中转站，其余全关；平台与推理端点都指着本机的假服务。数据目录是
 * 临时的，数据库里的东西（策略、会话、租户）都在里面，与真的那台机器无关。
 */
async function startGateway(): Promise<Gateway> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-e2e-"));
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: dataDir,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 路由日志：策略与租户都打出来，断言「为什么换了账号」有据可查。
      QODER_LOG_ROUTE: "true",
      // 其余上游全关：一条请求也不发出去。
      MINIMAX_CODE: "0",
      MINIMAX_API: "0",
      ZCODE: "0",
      QODER_GLOBAL: "0",
      QODER_CN: "0",
      WORKBUDDY_CN: "0",
      SENSENOVA: "0",
      INTERN_AI: "0",
      // 中转站：两个租户。第三个也配上（.env 里有一个真的），但它没钱，
      // 所以永远轮不到它 —— 测试里也不该有真凭据。
      TOKENRHYTHM: "1",
      TOKENRHYTHM_API_BASE: platformBase,
      TOKENRHYTHM_INFER_BASE: `${inferenceBase}/v1`,
      TOKEN_RHYTHM_1_ACCOUNT: "19000000001",
      TOKEN_RHYTHM_1_PASSWORD: "pw1",
      TOKEN_RHYTHM_1_API_KEY: "sk_tr_tenant_1",
      TOKEN_RHYTHM_2_ACCOUNT: "19000000002",
      TOKEN_RHYTHM_2_PASSWORD: "pw2",
      TOKEN_RHYTHM_2_API_KEY: "sk_tr_tenant_2",
      TOKEN_RHYTHM_3_ACCOUNT: "19000000003",
      TOKEN_RHYTHM_3_PASSWORD: "pw3",
      TOKEN_RHYTHM_3_API_KEY: "sk_tr_tenant_3",
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
  return {
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
  };
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

/** 改一个上游的生效策略 —— 面板上那一下就是它。 */
async function setPolicy(
  gw: Gateway,
  upstreamId: string,
  policy: string,
): Promise<{ status: number; body: any }> {
  return call(gw, "SetProviderPolicy", { upstreamId, policy });
}

/** 上游列表里那一条的策略。 */
async function policyOf(gw: Gateway, upstreamId: string): Promise<string> {
  const res = await call(gw, "ListUpstreams");
  const row = (res.body?.upstreams ?? []).find((u: any) => u.id === upstreamId);
  return String(row?.policy ?? "");
}

/** 发一个请求（面板那条路：/{上游}/v1/chat/completions）。 */
async function chat(gw: Gateway): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${gw.base}/tokenrhythm/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

/** 推理端点被叫过的租户。 */
const calledTenants = (): number[] => inferenceCalls.slice();

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

/** 一个有钱、推理端点答 200 的租户。 */
function richTenant(expiry: string): TenantPlan {
  return {
    available: 18,
    gift: 18,
    expiry,
    inference: { status: 200, body: answerBody(0) },
  };
}

console.log("");
console.log("场景一：单一 —— 第一个账号接不了，不换");

{
  // 租户 1 的推理端点挂（500），租户 2 是好的。
  const tenant1 = richTenant("2026-11-20T00:00:00.000Z");
  tenant1.inference = { status: 500, body: { code: "INTERNAL_ERROR", message: "假上游挂了" } };
  const tenant2 = richTenant("2026-11-19T00:00:00.000Z");
  tenant2.inference = { status: 200, body: answerBody(2) };
  plans = { 1: tenant1, 2: tenant2 };
  inferenceCalls.length = 0;

  const gw = await startGateway();
  try {
    check("上游的默认策略是单一", (await policyOf(gw, "tokenrhythm")) === "PROVIDER_POLICY_SINGLE", await policyOf(gw, "tokenrhythm"));

    const res = await chat(gw);
    check("客户端拿到的是网关的 5xx", res.status >= 500, String(res.status));
    check("错误里说的是上游的 500", res.text.includes("500"), res.text.slice(0, 200));
    check("只试了一个账号", calledTenants().join(",") === "1", calledTenants().join(","));
    check("没有换到第二个账号", !calledTenants().includes(2), calledTenants().join(","));
    check("日志里说的是「不换」", gw.log().includes("not switching"), gw.log().slice(-400));
    check("日志里没有「试下一个」", !gw.log().includes("trying tenant-2"), gw.log().slice(-400));

    console.log("");
    console.log("场景二：改策略立刻生效（同一个网关，不重启）");

    const set = await setPolicy(gw, "tokenrhythm", "PROVIDER_POLICY_FALLBACK");
    check("策略改成了降级", set.body?.ok === true && String(set.body?.message).includes("降级"), JSON.stringify(set.body));
    check("上游带回来的策略是降级", (await policyOf(gw, "tokenrhythm")) === "PROVIDER_POLICY_FALLBACK", await policyOf(gw, "tokenrhythm"));

    inferenceCalls.length = 0;
    const after = await chat(gw);
    check("改完策略，下一个请求就换人了（先 1 后 2）", calledTenants().join(",") === "1,2", calledTenants().join(","));
    check("客户端拿到了答复", after.status === 200, `${after.status} ${after.text.slice(0, 200)}`);
    check("答复是第二个账号给的", String(after.body?.choices?.[0]?.message?.content ?? "").includes("tenant 2"), after.text.slice(0, 200));
    check("日志里说了为什么换", gw.log().includes("trying tenant-2"), gw.log().slice(-400));

    console.log("");
    console.log("场景三：改回单一，立刻又不换了");

    const back = await setPolicy(gw, "tokenrhythm", "PROVIDER_POLICY_SINGLE");
    check("策略改回了单一", back.body?.ok === true, JSON.stringify(back.body));
    inferenceCalls.length = 0;
    const again = await chat(gw);
    check("只试了一个账号", calledTenants().join(",") === "1", calledTenants().join(","));
    check("客户端拿到的是网关的 5xx", again.status >= 500, String(again.status));

    console.log("");
    console.log("场景四：这一类上游不支持的策略被拒");

    const refused = await setPolicy(gw, "qoder", "PROVIDER_POLICY_FALLBACK");
    check("只有一个账号的那一类不给设降级", refused.body?.ok === false, JSON.stringify(refused.body));
    check("拒收的话里说清楚支持哪几个", String(refused.body?.message ?? "").includes("单一"), String(refused.body?.message));
    const unknown = await setPolicy(gw, "no-such-upstream", "PROVIDER_POLICY_SINGLE");
    check("没有这个上游也拒收", unknown.body?.ok === false, JSON.stringify(unknown.body));
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景五：降级 —— 第一个账号没钱，换到下一个");

{
  // 租户 1 没钱（平台自己的 402），租户 2 是好的。
  const tenant1 = richTenant("2026-11-20T00:00:00.000Z");
  tenant1.inference = {
    status: 402,
    body: { code: "INSUFFICIENT_BALANCE", message: "账户余额不足，请充值后重试。", traceId: "trace_fake_402" },
  };
  const tenant2 = richTenant("2026-11-19T00:00:00.000Z");
  tenant2.inference = { status: 200, body: answerBody(2) };
  plans = { 1: tenant1, 2: tenant2 };
  inferenceCalls.length = 0;

  const gw = await startGateway();
  try {
    const set = await setPolicy(gw, "tokenrhythm", "PROVIDER_POLICY_FALLBACK");
    check("策略改成了降级", set.body?.ok === true, JSON.stringify(set.body));

    const res = await chat(gw);
    check("先试了没钱的那个账号", calledTenants().includes(1), calledTenants().join(","));
    check("换到了第二个账号", calledTenants().includes(2), calledTenants().join(","));
    check("客户端拿到了答复", res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
    check("答复是第二个账号给的", String(res.body?.choices?.[0]?.message?.content ?? "").includes("tenant 2"), res.text.slice(0, 200));
    check(
      "日志里说了是没钱所以换",
      gw.log().includes("tenant-1 cannot serve it (no-balance HTTP 402), trying tenant-2"),
      gw.log().slice(-600),
    );
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景六：余额到期优先 —— 先用赠金最先到期的那个账号");

{
  // 租户 2 的赠金先到期：它不是第一个租户，单一策略不会选它。
  const tenant1 = richTenant("2026-11-20T00:00:00.000Z");
  tenant1.inference = { status: 200, body: answerBody(1) };
  const tenant2 = richTenant("2026-11-19T00:00:00.000Z");
  tenant2.inference = { status: 200, body: answerBody(2) };
  plans = { 1: tenant1, 2: tenant2 };
  inferenceCalls.length = 0;

  const gw = await startGateway();
  try {
    const set = await setPolicy(gw, "tokenrhythm", "PROVIDER_POLICY_EXPIRY_FIRST");
    check("策略改成了余额到期优先", set.body?.ok === true && String(set.body?.message).includes("余额到期优先"), JSON.stringify(set.body));

    const res = await chat(gw);
    check("用的是赠金先到期的那个账号", calledTenants().join(",") === "2", calledTenants().join(","));
    check("没有试第一个账号", !calledTenants().includes(1), calledTenants().join(","));
    check("客户端拿到了答复", res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
    check("答复是第二个账号给的", String(res.body?.choices?.[0]?.message?.content ?? "").includes("tenant 2"), res.text.slice(0, 200));
    check("日志里写着用的是余额到期优先", gw.log().includes("policy=expiry_first"), gw.log().slice(-400));
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景七：降级不是什么都换 —— 请求本身的问题不换账号");

{
  // 租户 1 说这个请求不对（400），换个账号也是这个错。
  const tenant1 = richTenant("2026-11-20T00:00:00.000Z");
  tenant1.inference = {
    status: 400,
    body: { error: { code: "invalid_request_error", message: "参数错" } },
  };
  const tenant2 = richTenant("2026-11-19T00:00:00.000Z");
  tenant2.inference = { status: 200, body: answerBody(2) };
  plans = { 1: tenant1, 2: tenant2 };
  inferenceCalls.length = 0;

  const gw = await startGateway();
  try {
    const set = await setPolicy(gw, "tokenrhythm", "PROVIDER_POLICY_FALLBACK");
    check("策略改成了降级", set.body?.ok === true, JSON.stringify(set.body));

    const res = await chat(gw);
    check("只试了一个账号", calledTenants().join(",") === "1", calledTenants().join(","));
    check("没有换到第二个账号", !calledTenants().includes(2), calledTenants().join(","));
    check("客户端拿到的是网关的 5xx", res.status >= 500, String(res.status));
    check("错误里说的是上游的 400", res.text.includes("400"), res.text.slice(0, 200));
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景八：面板上改策略 → 立刻生效 → 请求落到预期账号");

/* ------------------------------------------------------------------ *
 * 面板（真浏览器）
 * ------------------------------------------------------------------ */

/** 跑一条 agent-browser 命令。 */
function ab(session: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("agent-browser", ["--session", session, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.on("error", (e) => resolve({ code: 127, out: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
  });
}

/** 面板刷新的时候元素会短暂不在：多试几次。 */
async function abRetry(
  session: string,
  args: string[],
  times: number,
): Promise<{ code: number; out: string }> {
  let last = { code: 1, out: "" };
  for (let i = 0; i < times; i++) {
    last = await ab(session, args);
    if (last.code === 0) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

const panelBuilt = fs.existsSync(path.join(ROOT, "web/dist/index.html"));
const browserSession = `policy-e2e-${process.pid}`;

if (panelBuilt) {
  // 租户 1 的推理端点挂（500），租户 2 是好的：改成降级之后请求就该落到租户 2。
  const tenant1 = richTenant("2026-11-20T00:00:00.000Z");
  tenant1.inference = { status: 500, body: { code: "INTERNAL_ERROR", message: "假上游挂了" } };
  const tenant2 = richTenant("2026-11-19T00:00:00.000Z");
  tenant2.inference = { status: 200, body: answerBody(2) };
  plans = { 1: tenant1, 2: tenant2 };
  inferenceCalls.length = 0;

  const gw = await startGateway();
  try {
    const opened = await ab(browserSession, ["open", `${gw.base}/admin/`]);
    check("面板打开了", opened.code === 0, opened.out.slice(-200));
    await ab(browserSession, ["wait", "--text", "输入面板令牌"]);
    await ab(browserSession, ["fill", "#admin-token", gw.token]);
    const entered = await ab(browserSession, ["find", "role", "button", "click", "--name", "进入面板"]);
    check("用令牌进得去面板", entered.code === 0, entered.out.slice(-200));
    await ab(browserSession, ["wait", "--text", "网关现在的状态"]);

    const upstreams = await ab(browserSession, ["open", `${gw.base}/admin/upstreams`]);
    check("上游页打开了", upstreams.code === 0, upstreams.out.slice(-200));
    await ab(browserSession, ["wait", "--text", "上游"]);

    const expanded = await ab(browserSession, [
      "find", "role", "button", "click", "--name", "展开 tokenrhythm 的账号与凭据",
    ]);
    check("展开了中转站那一行", expanded.code === 0, expanded.out.slice(-200));

    const openedSelect = await ab(browserSession, ["find", "role", "combobox", "click", "--name", "生效策略"]);
    check("策略选择器点开了", openedSelect.code === 0, openedSelect.out.slice(-200));
    const picked = await ab(browserSession, ["find", "role", "option", "click", "--name", "降级"]);
    check("选了「降级」", picked.code === 0, picked.out.slice(-200));
    const toasted = await ab(browserSession, ["wait", "--text", "策略改成了降级"]);
    check("面板说策略改好了", toasted.code === 0, toasted.out.slice(-200));

    const shown = await abRetry(browserSession, ["find", "role", "combobox", "text", "--name", "生效策略"], 5);
    check("面板上显示的是降级", shown.out.includes("降级"), shown.out.slice(-200));
    check("服务端也记下了降级", (await policyOf(gw, "tokenrhythm")) === "PROVIDER_POLICY_FALLBACK", await policyOf(gw, "tokenrhythm"));

    // 面板改完，下一个请求就该换人。
    const res = await chat(gw);
    check("改完策略，下一个请求换到了第二个账号", calledTenants().join(",") === "1,2", calledTenants().join(","));
    check("客户端拿到了答复", res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
    check("答复是第二个账号给的", String(res.body?.choices?.[0]?.message?.content ?? "").includes("tenant 2"), res.text.slice(0, 200));
  } finally {
    gw.stop();
    await ab(browserSession, ["close"]);
  }
} else {
  const why = "面板没构建（web/dist/index.html 不在）。先 cd web && pnpm build。";
  if (process.env.REQUIRE_BROWSER === "1") {
    check("面板这一段跑了", false, why);
  } else {
    console.log(`  --  ${why} 这一段没跑。`);
  }
}

platform.close();
inference.close();

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
