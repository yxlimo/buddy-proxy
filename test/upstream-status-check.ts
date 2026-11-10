// test/upstream-status-check.ts — 传输层把上游自己的状态带在错误上。
//
//   node --experimental-strip-types test/upstream-status-check.ts
//
// 离线：假上游，不碰真平台，不花额度。
//
// 为什么要有这个：网关把上游的错误包成自己的错误，客户端看到的是网关的状态。
// 但路由要分清「请求本身的问题」（400/404，换一个账号也一样错）与「这个账号
// 接不了」（401/402/429/5xx，换一个也许行）。分清靠的是上游自己的状态码，
// 所以传输层必须把它带在错误上。
//
// 覆盖：
//   1. Qoder 老协议的 500 / 401：客户端拿到网关的 502/503，而上游的状态与正文进了日志；
//   2. WorkBuddy 的 400：上游的状态在错误上；
//   3. 上游的 400 判成「请求本身的问题」，不降级；
//   4. undici 的 body/headers 超时判成 timeout（不是 connection）。
//
// Qoder 的排队不在这里：它现在是老协议的告诉方式（200 的帧里一个错误帧），
// 认它、等它、据它记 busy 都在 test/qoder-legacy-check.ts 里查。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { legacyStatusErrorFrame } from "./legacy-wire.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-status-"));
process.env.BUDDY_DATA_DIR = tmp;

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

let status = 400;
let body = "the request is wrong";

const server = http.createServer((req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;

// Qoder 的地址是模块加载时读的，所以环境要先把地址换掉。
process.env.QODER_GLOBAL_LEGACY_BASE = `http://127.0.0.1:${port}`;
process.env.WORKBUDDY_CHAT_BASE = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ *
 * 假会话
 * ------------------------------------------------------------------ */

const { setSecret } = await import("../lib/store.ts");
const { addAccount } = await import("../lib/providers.ts");
// 账号是表里的行：先建一行，凭据挂在它的 id 上，请求也带那个 id。
const qoderId = String(addAccount({ platform: "qoder" }).id);
const workbuddyId = String(addAccount({ platform: "workbuddy-cn" }).id);
if (!qoderId || !workbuddyId) throw new Error("账号没有建出来");

const now = Date.now();
const year = now + 365 * 24 * 3600 * 1000;

setSecret(`session:provider:${qoderId}`, "session", {
  schemaVersion: 1,
  region: "global",
  clientId: "test-client",
  accessToken: "dt-test-access-token",
  refreshToken: "drt-test-refresh-token",
  userId: "00000000-0000-0000-0000-000000000000",
  expiresAtMs: year,
  refreshExpiresAtMs: year,
  machineId: "00000000-0000-4000-8000-000000000000",
  machineToken: "test-machine-token",
  machineType: "test-machine-type",
  generation: 1,
  loginAtMs: now,
  refreshedAtMs: now,
});

setSecret(`session:provider:${workbuddyId}`, "session", {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  uid: "test-uid",
  nickname: "test",
  domain: "www.workbuddy.cn",
  region: "cn",
  generation: 1,
  expiresAtMs: year,
  refreshExpiresAtMs: year,
  loginAtMs: now,
  refreshedAtMs: now,
});

const { legacyChatCompletion } = await import("../lib/qoder/legacy.ts");
const { legacyWithRetry } = await import("../lib/router/upstreams/qoder.ts");
const { workbuddyChat } = await import("../lib/workbuddy/transport.ts");
const { upstreamBodyOf, upstreamStatusOf } = await import("../lib/upstream-status.ts");
const { classifyUpstreamError, describeUpstreamError } = await import(
  "../lib/router/provider-selection.ts"
);

/** 调一次，抓住错误。 */
async function caught(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * 跑一段代码，把它打出来的警告收下来。
 *
 * 上游为什么拒只留在日志里（hint 容器一重建就没了），所以日志本身要能查。
 */
async function warningsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await run();
  } catch {
    /* 错误由调用方自己抓 */
  } finally {
    console.warn = original;
  }
  return warnings;
}

/** 把这个生成器读完（错误照样抛出来）。 */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

/**
 * 按网关的样子问一次 Qoder：老协议那条路，正文是该编的码。
 *
 * 上游只答状态与正文，所以这里测的是「上游拒了之后网关怎么说」——
 * 编码与签名不是这个文件的事。
 */
function qoderLegacy(): Promise<Response> {
  return legacyChatCompletion(
    {
      messages: [{ role: "user", content: "hi" }],
      modelKey: "gmodel",
      displayName: "GLM-5.3",
      maxTokens: 32,
      reasoning: true,
    },
    { providerId: qoderId, region: "global" },
  );
}

console.log("");
console.log("Qoder：老协议上游的 500 与 401（状态与正文要进日志）");

// 上游为什么拒，只有正文里有，而日志与用量表只记 message。容器一重建，hint
// 就没了，所以这一行是唯一留得住的地方（2026-11-10 那次排查就卡在这里）。
for (const [code, said] of [
  [500, "internal server error"],
  [401, "token expired"],
] as const) {
  status = code;
  body = JSON.stringify({ error: said });
  const warnings = await warningsDuring(() => caught(() => qoderLegacy()));
  const error = await caught(() => qoderLegacy());
  check(`${code}：客户端拿到的是网关的 502`, error?.status === 502, String(error?.status));
  check(
    `${code}：打了 [UPSTREAM]`,
    warnings.some((w) => w.includes("[UPSTREAM]")),
    JSON.stringify(warnings),
  );
  check(
    `${code}：上游的状态留在了日志里`,
    warnings.some((w) => w.includes(String(code))),
    JSON.stringify(warnings),
  );
  check(
    `${code}：正文留在了日志里`,
    warnings.some((w) => w.includes(said)),
    JSON.stringify(warnings),
  );
  // 状态与正文要么都有要么都没有（见 upstream-status.ts 的 withUpstreamAnswer）：
  // 那个状态是客户端最终看到的那句答复的根据，而重试用尽后上游不会再答一遍。
  check(
    `${code}：正文跟着状态一起留在错误上`,
    upstreamBodyOf(error) === body,
    String(upstreamBodyOf(error)),
  );
}

console.log("");
console.log("Qoder：老协议帧里带的状态也带上那一帧自己的正文");

{
  // 真形状：一条 200 的流，第一帧的壳上写着 500（test/legacy-wire.ts 的
  // legacyStatusErrorFrame）。那个状态与它自己那句话要一起留在错误上。
  status = 200;
  body = legacyStatusErrorFrame(500, "upstream frame failed", "500");
  const error = await caught(() => drain(legacyWithRetry(() => qoderLegacy(), 10_000, async () => {})));
  check("帧里的状态在错误上", upstreamStatusOf(error) === 500, String(upstreamStatusOf(error)));
  check(
    "帧自己的正文跟着状态一起在错误上",
    upstreamBodyOf(error) === JSON.stringify({ code: "500", message: "upstream frame failed" }),
    String(upstreamBodyOf(error)),
  );
  check("客户端拿到的是网关的 502", error?.status === 502, String(error?.status));
}

console.log("");
console.log("WorkBuddy：上游的 400");

{
  status = 400;
  body = "参数不对";
  const error = await caught(() =>
    workbuddyChat(
      { model: "hy3", messages: [{ role: "user", content: "hi" }] },
      { providerId: workbuddyId },
    ),
  );
  check("上游的状态在错误上", upstreamStatusOf(error) === 400, String(upstreamStatusOf(error)));
  check("客户端拿到的还是网关的 502", error?.status === 502, String(error?.status));
  const failure = classifyUpstreamError(error);
  check("400 是请求本身的问题", failure.degradable === false, failure.kind);
  check("日志里说的是 400", failure.status === 400, String(failure.status));
}

console.log("");
console.log("undici 的超时：body / headers 是「上游太久没回」");

/**
 * 复现 undici 抽掉连接时抛的形状。
 *
 * undici 不直接抛自己的错误，它抛 `TypeError("terminated")`，自己的错误放在
 * cause 里 —— 码在下一层，所以只造一层的话测不到真实路径。字段就是 undici
 * 错误的那三个（name、code、message），不编造其它形状。
 */
function terminatedBy(name: string, code: string, message: string): TypeError {
  return new TypeError("terminated", { cause: Object.assign(new Error(message), { name, code }) });
}

{
  // undici 默认 bodyTimeout 300s：上游 5 分钟没吐数据就是它（生产上 304.7s
  // 那次断流就是这种形状，当时被当成 unknown，既不降级也不冷却）。
  const error = terminatedBy("BodyTimeoutError", "UND_ERR_BODY_TIMEOUT", "Body Timeout Error");
  const failure = classifyUpstreamError(error);
  check("body timeout 判成 timeout", failure.kind === "timeout", failure.kind);
  check("body timeout 没有上游状态", failure.status === null, String(failure.status));
  check("body timeout 可降级（换账号也许能接）", failure.degradable === true, String(failure.degradable));
  check(
    "日志里写的是 timeout",
    describeUpstreamError(error) === "timeout",
    describeUpstreamError(error),
  );
}

{
  // 控制组：同一层同样长相，但码是连接类 —— 不能跟着一起变成 timeout。
  const error = terminatedBy("SocketError", "UND_ERR_SOCKET", "other side closed");
  const failure = classifyUpstreamError(error);
  check("socket 断开还是 connection", failure.kind === "connection", failure.kind);
  check(
    "日志里写的是 connection",
    describeUpstreamError(error) === "connection",
    describeUpstreamError(error),
  );
}

{
  const error = terminatedBy("HeadersTimeoutError", "UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error");
  const failure = classifyUpstreamError(error);
  check("headers timeout 判成 timeout", failure.kind === "timeout", failure.kind);
  check("headers timeout 没有上游状态", failure.status === null, String(failure.status));
}

server.close();
// Close the database before removing its directory: on Windows an open
// file cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
