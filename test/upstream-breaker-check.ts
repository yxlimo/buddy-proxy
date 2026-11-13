// test/upstream-breaker-check.ts — 上游级（平台级）熔断：跳过、探测、翻倍。
//
//   node --experimental-strip-types test/upstream-breaker-check.ts
//
// 离线：两个本机的假上游（Qoder 全球区与中国区），一个真请求都不发到外面，
// 不花任何额度。
//
// 分两半：
//
//   一、模块本身（假时钟）：连续失败开闸、半开只放一个探测、探测成功关闭、
//      探测失败窗口翻倍、不可熔断的失败不熔断、恢复时刻有值/为 null、
//      开关关着时什么都不做。
//
//   二、真的网关（真时钟，假上游）：熔断命中时**不花那次上游往返**（假上游
//      的计数器不增加），靠降级答得出来；窗口到点后并发 5 个请求只放行 1 个
//      探测；探测成功之后照常打上游；开关关着时每个请求都打到上游；
//      不可熔断的失败（400）连打 5 次也不熔断。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";
import {
  legacyChunk,
  legacyEnd,
  legacyErrorFrame,
  legacyQueueMessage,
  legacyStatusErrorFrame,
} from "./legacy-wire.ts";

const SERVICE = "/buddy.admin.v1.AdminService";
/** 假上游用的模型名（两个 Qoder 区域都serve它）。 */
const MODEL = "glm-5.3";

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log("");
  console.log(name);
}

/* ------------------------------------------------------------------ *
 * 一、模块本身（假时钟）
 * ------------------------------------------------------------------ */

// 配置要读库（面板那份设置在数据库里），所以先给一个临时目录。
const UNIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-unit-"));
process.env.BUDDY_DATA_DIR = UNIT_DIR;
// 开关开着：这一半测的就是开着时的行为。
process.env.UPSTREAM_BREAKER_ENABLED = "true";

const { checkBreaker, noteBreakerOutcome, breakerPanelState, resetBreaker } = await import(
  "../lib/upstream-breaker.ts"
);
const { reloadConfig } = await import("../lib/config.ts");

/** 假时钟的起点。 */
const T0 = 1_700_000_000_000;

section("一、模块本身（假时钟）");

{
  resetBreaker();
  // 连续三次排队 → 开闸。
  for (let i = 0; i < 3; i++) noteBreakerOutcome("unit-a", "queued", T0);
  const opened = checkBreaker("unit-a", T0);
  check("连续三次可熔断的失败之后开闸了", opened.allow === false, JSON.stringify(opened));
  check("开闸时说得出恢复时刻", opened.untilMs === T0 + 60_000, String(opened.untilMs));
  check(
    "面板那一格：跳过中，恢复时刻有值",
    (() => {
      const panel = breakerPanelState("unit-a", T0);
      return panel.tripped === true && panel.untilMs === T0 + 60_000;
    })(),
    JSON.stringify(breakerPanelState("unit-a", T0)),
  );
}

{
  resetBreaker();
  for (let i = 0; i < 3; i++) noteBreakerOutcome("unit-b", "queued", T0);
  // 窗口到点：半开，只放一个探测。
  const probeAt = T0 + 60_001;
  const first = checkBreaker("unit-b", probeAt);
  check("窗口到点之后放行一个探测", first.allow === true && first.probe === true, JSON.stringify(first));
  const second = checkBreaker("unit-b", probeAt);
  check("第二个请求抢不到探测名额（单飞）", second.allow === false, JSON.stringify(second));
}

{
  resetBreaker();
  for (let i = 0; i < 3; i++) noteBreakerOutcome("unit-c", "queued", T0);
  const probeAt = T0 + 60_001;
  checkBreaker("unit-c", probeAt);
  // 探测成功 → 关闭。
  noteBreakerOutcome("unit-c", "ok", probeAt + 10);
  const after = checkBreaker("unit-c", probeAt + 20);
  check("探测成功之后关闭了（照常打上游）", after.allow === true && after.probe === false, JSON.stringify(after));
  const panel = breakerPanelState("unit-c", probeAt + 20);
  check("关闭时面板那一格：没跳过、恢复时刻是 null", panel.tripped === false && panel.untilMs === null, JSON.stringify(panel));
}

{
  resetBreaker();
  for (let i = 0; i < 3; i++) noteBreakerOutcome("unit-d", "queued", T0);
  const probeAt = T0 + 60_001;
  checkBreaker("unit-d", probeAt);
  // 探测失败 → 重新开闸，窗口翻倍（60s → 120s）。
  noteBreakerOutcome("unit-d", "queued", probeAt + 10);
  const panel = breakerPanelState("unit-d", probeAt + 20);
  check("探测失败之后窗口翻倍（约 120 秒）", panel.untilMs === probeAt + 10 + 120_000, String(panel.untilMs));
  check("翻倍之后还是在跳过", panel.tripped === true, JSON.stringify(panel));
}

{
  resetBreaker();
  // 不可熔断的失败（请求本身的问题）：连打五次也不熔断。
  for (let i = 0; i < 5; i++) noteBreakerOutcome("unit-e", "request", T0);
  const verdict = checkBreaker("unit-e", T0);
  check("不可熔断的失败连打五次也不熔断", verdict.allow === true, JSON.stringify(verdict));
  const panel = breakerPanelState("unit-e", T0);
  check("面板那一格：没跳过、恢复时刻是 null", panel.tripped === false && panel.untilMs === null, JSON.stringify(panel));
}

{
  resetBreaker();
  // 不可熔断的失败不清零已经攒着的失败：三次排队 + 一次 400 仍然熔断。
  for (let i = 0; i < 3; i++) noteBreakerOutcome("unit-f", "queued", T0);
  noteBreakerOutcome("unit-f", "request", T0);
  const verdict = checkBreaker("unit-f", T0);
  check("一次 400 擦不掉攒着的失败", verdict.allow === false, JSON.stringify(verdict));
}

{
  // 开关关着：不记账、不跳过。
  resetBreaker("unit-g");
  process.env.UPSTREAM_BREAKER_ENABLED = "false";
  reloadConfig();
  for (let i = 0; i < 5; i++) noteBreakerOutcome("unit-g", "queued", T0);
  const verdict = checkBreaker("unit-g", T0);
  check("开关关着的时候不跳过", verdict.allow === true, JSON.stringify(verdict));
  const panel = breakerPanelState("unit-g", T0);
  check("开关关着的时候面板上也没有痕迹", panel.tripped === false && panel.untilMs === null, JSON.stringify(panel));
  process.env.UPSTREAM_BREAKER_ENABLED = "true";
  reloadConfig();
  // 开关关着的时候连状态都不留：重新打开时它从零开始。
  resetBreaker("unit-g");
  for (let i = 0; i < 3; i++) noteBreakerOutcome("unit-g", "queued", T0);
  check("重新打开之后从零开始数", checkBreaker("unit-g", T0).allow === false, "");
}

/* ------------------------------------------------------------------ *
 * 二、真的网关（假上游）
 * ------------------------------------------------------------------ */

/** 全球区那个假上游怎么答。 */
type QoderMode = "queued" | "ok" | "bad";
let qoderMode: QoderMode = "queued";
/** 全球区那个假上游被叫了几次（只数推理端点）。 */
let qoderHits = 0;
/** 中国区那个假上游被叫了几次。 */
let cnHits = 0;

/** 一个 Qoder 形状的假上游：老协议那一套。 */
function fakeQoder(onHit: () => void, mode: () => QoderMode): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (!url.includes("/agent_chat_generation")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not a route the test uses" } }));
        return;
      }
      onHit();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const how = mode();
      if (how === "queued") {
        // 排队：上游把这个模型排进了队列（200 的流里说的）。
        res.end(legacyErrorFrame(legacyQueueMessage(1)));
        return;
      }
      if (how === "bad") {
        // 请求本身的问题（400）：不可熔断的那一类。
        res.end(legacyStatusErrorFrame(400, "the request is invalid"));
        return;
      }
      res.end(legacyChunk("ok from the fake upstream") + legacyEnd());
    });
  });
}

const globalServer = fakeQoder(
  () => {
    qoderHits++;
  },
  () => qoderMode,
);
const cnServer = fakeQoder(
  () => {
    cnHits++;
  },
  () => "ok",
);

await new Promise<void>((resolve) => globalServer.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => cnServer.listen(0, "127.0.0.1", resolve));
const globalBase = `http://127.0.0.1:${(globalServer.address() as any).port}`;
const cnBase = `http://127.0.0.1:${(cnServer.address() as any).port}`;

interface Gateway extends HarnessGateway {
  token: string;
}

/**
 * 起一个真的网关，两个 Qoder 区域都指着本机的假服务。
 *
 * 熔断的旋钮由调用方给：关着的那个场景要证明「开关真的管用」。
 */
async function startGateway(breaker: boolean): Promise<Gateway> {
  const running = await startHarness({
    env: {
      QODER_GLOBAL_LEGACY_BASE: globalBase,
      QODER_CN_INFER_BASE: cnBase,
      // 排队不等：自测不真等那一分钟（等的是上游说的时间，不是网关的错）。
      QODER_SKIP_QUEUE_WAIT: "true",
      QODER_LEGACY_RETRY_MS: "10",
      UPSTREAM_BREAKER_ENABLED: breaker ? "true" : "false",
      UPSTREAM_BREAKER_FAILURES: "3",
      // 窗口给得短：自测不等一分钟。
      UPSTREAM_BREAKER_OPEN_MS: "1500",
      UPSTREAM_BREAKER_MAX_OPEN_MS: "60000",
    },
  });
  const tokenFile = path.join(running.dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const gw: Gateway = { ...running, token };

  // 两个账号：一个在全球区，一个在中国区。凭据挂在账号行上（不填就发不出去）。
  const seed = new DatabaseSync(path.join(running.dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const now = Date.now();
  for (const [platform, region] of [
    ["qoder", "global"],
    ["qoder-cn", "cn"],
  ] as const) {
    const made = await call(gw, "AddAccount", { platform, alias: `${platform} 测试账号` });
    const id = String(made.body?.id ?? "");
    if (!id) throw new Error(`加不了 ${platform} 的账号：${JSON.stringify(made.body)}`);
    insertSecret.run(
      `session:provider:${id}`,
      "session",
      JSON.stringify({
        schemaVersion: 1,
        region,
        clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
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
  }
  seed.close();

  // 发布一个模型：全球区先试（权重大），中国区接着。
  const saved = await call(gw, "SavePublishedModel", {
    model: {
      id: "pub-brk",
      displayName: "熔断测试",
      enabled: true,
      strategy: "fallback",
      targets: [
        { groupName: "qoder", upstreamModel: MODEL, weight: 2, enabled: true },
        { groupName: "qoder-cn", upstreamModel: MODEL, weight: 1, enabled: true },
      ],
    },
  });
  if (!saved.body?.id) throw new Error(`发布模型失败：${JSON.stringify(saved.body)}`);
  return gw;
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

/** 打根路由：模型名是发布出来的那个。 */
async function ask(gw: Gateway, model = "pub-brk"): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

/** 面板上那个平台的一句话。 */
async function stateReasonOf(gw: Gateway, platform: string): Promise<string> {
  const res = await call(gw, "ListUpstreams");
  const row = (res.body?.upstreams ?? []).find((u: any) => u.id === platform);
  return String(row?.stateReason ?? "");
}

/** 用量表里某个平台有几行（跳过的那些也算进去）。 */
function usageRowsOf(gw: Gateway, platform: string): number {
  const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM usage_event WHERE upstream_id = ?")
      .get(platform) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

section("二、真的网关：熔断命中时不花那次上游往返");

{
  qoderMode = "queued";
  qoderHits = 0;
  cnHits = 0;
  const gw = await startGateway(true);
  try {
    for (let i = 0; i < 3; i++) {
      const res = await ask(gw);
      check(`第 ${i + 1} 个请求由降级的目标答了`, res.status === 200, `${res.status} ${res.text.slice(0, 160)}`);
    }
    check("全球区那个上游被叫了三次", qoderHits === 3, String(qoderHits));

    const before = qoderHits;
    const fourth = await ask(gw);
    check("第四个请求照样答得出来（降级）", fourth.status === 200, `${fourth.status} ${fourth.text.slice(0, 160)}`);
    check(
      "第四个请求没有再打那个被熔断的上游",
      qoderHits === before,
      `打上游次数从 ${before} 变成 ${qoderHits}`,
    );
    check("降级的那个上游接了手", cnHits === 4, String(cnHits));

    const reason = await stateReasonOf(gw, "qoder");
    check("面板上写着「已跳过，恢复时间」", reason.includes("已跳过，恢复时间"), reason);
    check("面板上写的是时刻而不是「未知」", /恢复时间 \d{2}:\d{2}/.test(reason), reason);
    // 跳过的那一次也要留一行用量：不然面板上会少一条记录。
    const rows = usageRowsOf(gw, "qoder");
    check("用量表里那个平台有四行（三次打上去 + 一次跳过）", rows === 4, String(rows));
  } finally {
    gw.stop();
  }
}

section("三、半开：到点之后只放一个探测");

{
  qoderMode = "queued";
  qoderHits = 0;
  cnHits = 0;
  const gw = await startGateway(true);
  try {
    for (let i = 0; i < 3; i++) await ask(gw);
    check("先攒够三次失败", qoderHits === 3, String(qoderHits));
    // 窗口是 1.5 秒：等它过去。
    await sleep(2000);
    const before = qoderHits;
    const answers = await Promise.all([ask(gw), ask(gw), ask(gw), ask(gw), ask(gw)]);
    check("五个并发请求都答得出来", answers.every((a) => a.status === 200), answers.map((a) => a.status).join(","));
    check("只放了一个探测出去", qoderHits === before + 1, `打上游次数从 ${before} 变成 ${qoderHits}`);
  } finally {
    gw.stop();
  }
}

section("四、探测成功之后关闭");

{
  qoderMode = "queued";
  qoderHits = 0;
  cnHits = 0;
  const gw = await startGateway(true);
  try {
    for (let i = 0; i < 3; i++) await ask(gw);
    check("先攒够三次失败", qoderHits === 3, String(qoderHits));
    // 这一次上游答得出来了。
    qoderMode = "ok";
    await sleep(2000);
    const probe = await ask(gw);
    check("探测那个请求由全球区那个上游答了", probe.status === 200, `${probe.status} ${probe.text.slice(0, 160)}`);
    check("探测确实打上去了", qoderHits === 4, String(qoderHits));
    const after = await ask(gw);
    check("探测成功之后照常打上游", qoderHits === 5, String(qoderHits));
    check("那个请求也答得出来", after.status === 200, `${after.status} ${after.text.slice(0, 160)}`);
    const reason = await stateReasonOf(gw, "qoder");
    check("面板上不再说「已跳过」", !reason.includes("已跳过"), reason);
  } finally {
    gw.stop();
  }
}

section("五、控制组：开关关着的时候每个请求都打到上游");

{
  qoderMode = "queued";
  qoderHits = 0;
  cnHits = 0;
  const gw = await startGateway(false);
  try {
    for (let i = 0; i < 5; i++) {
      const res = await ask(gw);
      check(`第 ${i + 1} 个请求答得出来（降级）`, res.status === 200, `${res.status} ${res.text.slice(0, 160)}`);
    }
    check("五个请求都打到了那个上游", qoderHits === 5, String(qoderHits));
    const reason = await stateReasonOf(gw, "qoder");
    check("面板上也没有「已跳过」", !reason.includes("已跳过"), reason);
  } finally {
    gw.stop();
  }
}

section("六、不可熔断的失败（400）连打五次也不熔断");

{
  qoderMode = "bad";
  qoderHits = 0;
  cnHits = 0;
  const gw = await startGateway(true);
  try {
    // 只发布一个目标（全球区）：它答 400，请求本身的问题。
    const saved = await call(gw, "SavePublishedModel", {
      model: {
        id: "pub-bad",
        displayName: "请求本身有问题",
        enabled: true,
        strategy: "fallback",
        targets: [{ groupName: "qoder", upstreamModel: MODEL, weight: 2, enabled: true }],
      },
    });
    check("发布模型成功了", Boolean(saved.body?.id), JSON.stringify(saved.body));
    for (let i = 0; i < 5; i++) {
      const res = await ask(gw, "pub-bad");
      // 老协议把上游那个 400 包成网关的 5xx（见 lib/qoder/legacy.ts）：这里要
      // 断言的是「这个失败没有被熔断」（五次都打到了上游），不是状态码。
      check(
        `第 ${i + 1} 个请求说的是上游那个 400`,
        res.status >= 500 && res.text.includes("400"),
        `${res.status} ${res.text.slice(0, 160)}`,
      );
    }
    check("五次都打到了上游（没有跳过）", qoderHits === 5, String(qoderHits));
    const reason = await stateReasonOf(gw, "qoder");
    check("面板上也没有「已跳过」", !reason.includes("已跳过"), reason);
  } finally {
    gw.stop();
  }
}

globalServer.close();
cnServer.close();

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
