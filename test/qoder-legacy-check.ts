// test/qoder-legacy-check.ts — Qoder 老协议：认出「排队」，按它给的秒数等，正文进日志。
//
//   node --experimental-strip-types test/qoder-legacy-check.ts
//
// 离线：帧是本机造的，不起网关，不发一个真请求，不花额度。
//
// 上游对老协议排队时这么答（实测）：
//
//   200，第一帧就是错误帧
//   {"error":{"code":"403","message":"{\"code\":\"10605\",\"message\"
//     :\"{\"errorCode\":0,\"isQueued\":true,…,\"retryAfterSeconds\":60,
//     \"subCode\":\"RESOURCE_LIMIT\"}\",\"subCode\":\"RESOURCE_LIMIT\"}","status":403}}
//
// 人话：模型暂时排不上队，等 60 秒可以再来，服务本身可用。官方 CLI 会重试它。
//
// 覆盖：
//   1. 排队的三种形状（isQueued / subCode RESOURCE_LIMIT / code 10605）都判可重试；
//      403 + pricing 仍走「没额度」；纯粹的 403 仍不可重试；
//   2. 等多久：上游给了 retryAfterSeconds 就按它等，没给退回配置的那个值；
//   3. 上游要 600 秒也最多等 60 秒（单次等待的上限）；
//   4. 帧级错误那一行日志里有上游正文，且不含 cookie / 令牌（两层嵌套也要抹）；
//      嵌套深过三层就不输出正文，打「(正文未解析)」；
//   5. 等过一次仍是排队：抛的是 QueuedError（排队，不是账号坏了）；分类是 queued
//      —— 可降级、不记冷却；而且策略那一层不会在同一个账号上再跑一轮，只等一次；
//      打开 QODER_SKIP_QUEUE_WAIT 则一次都不等，客户端拿到的仍是同一个答复；
//   6. 正常帧照旧通过，重试对客户端不可见（一个字都不多发）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-legacy-"));
process.env.BUDDY_DATA_DIR = tmp;
// 「默认」那几条断言测的是没设置时的行为：部署里钉了这个键的话，它们测的就不是
// 默认值了
delete process.env.QODER_SKIP_QUEUE_WAIT;

/** 录下来的那些上游答复就在这儿（test/fixture-name.ts 的常量同源）。 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const { legacyWithRetry, isRetryableLegacy, legacyWaitMs, legacyError } = await import(
  "../lib/router/upstreams/qoder.ts"
);
const { runWithRetries } = await import("../lib/router/upstreams/policy.ts");
const { classifyUpstreamError } = await import("../lib/router/provider-selection.ts");
const { configOverride, configClear } = await import("../lib/config.ts");

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
 * 造帧
 * ------------------------------------------------------------------ */

/** 老协议的帧壳：`data:{"headers":…,"body":"<json 字符串>"}`。 */
function frame(payload: unknown): string {
  return `data:${JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: JSON.stringify(payload),
  })}\n`;
}

/** 错误帧（跟实测那条同形：错误在 body 里，status 也在里面）。 */
function errorFrame(message: string, code = "403", status = 403): string {
  return frame({ error: { code, message, status } });
}

/** 正常的答复帧。 */
function chunkFrame(content: string): string {
  return frame({ choices: [{ index: 0, delta: { content } }], object: "chat.completion.chunk" });
}

/** 一次上游答复：把这些行当成一条流。 */
function responseOf(...lines: string[]): Response {
  const bytes = new TextEncoder().encode(lines.join(""));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/**
 * 排队那条正文：两层嵌套的 JSON（外层 code/subCode，内层 isQueued/秒数）。
 *
 * 不给秒数时两层都不带 retryAfterSeconds 与 waitTime —— 那就是「上游没说等多久」。
 */
function queueMessage(retryAfterSeconds?: number): string {
  const inner = {
    errorCode: 0,
    isQueued: true,
    modelKey: "gfmodel",
    queueCount: 1,
    queueType: "p4",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds, waitTime: retryAfterSeconds } : {}),
    serviceAvailable: true,
    subCode: "RESOURCE_LIMIT",
  };
  return JSON.stringify({ code: "10605", message: JSON.stringify(inner), subCode: "RESOURCE_LIMIT" });
}

/** 记下每次等了多久，真的一点都不等。 */
function waiter(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

/** 把这个生成器读完。 */
async function drain(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

/** 跑一次，把抛出来的错误收下（不抛给测试框架）。 */
async function thrownBy(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return e;
  }
}

/** 跑一次，把它打出去的警告收下来。 */
async function warningsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

/* ------------------------------------------------------------------ *
 * 1. 哪些帧算「排队」
 * ------------------------------------------------------------------ */

section("1. 排队的三种形状都可重试，纯粹的 403 不行");

check("实测那条（isQueued: true）可重试", isRetryableLegacy({ code: "403", message: queueMessage(60) }) === true);
check(
  "只有 isQueued: true 也可重试（正文里没有 10605 与 RESOURCE_LIMIT 可看）",
  isRetryableLegacy({
    code: "403",
    message: JSON.stringify({ message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30 }) }),
  }) === true,
);
check(
  "只有 subCode RESOURCE_LIMIT 也可重试",
  isRetryableLegacy({ code: "403", message: JSON.stringify({ code: "other", subCode: "RESOURCE_LIMIT" }) }) ===
    true,
);
check(
  "帧里的 code 就是 10605 也可重试",
  isRetryableLegacy({ code: "10605", message: "排队中" }) === true,
);
check(
  "嵌套那一层只写着 code 10605、没有 subCode / isQueued → 不可重试（只认那个字段）",
  isRetryableLegacy({ code: "403", message: JSON.stringify({ code: "10605", message: "排队中" }) }) === false,
);
check(
  "正文里只含 10605 这些字符、结构上没有 → 不可重试",
  isRetryableLegacy({ code: "403", message: "request id 10605-abc failed, come back later" }) === false,
);
check(
  "正文里含 RESOURCE_LIMIT 但那不是字段（只是一句话里的字）→ 不可重试",
  isRetryableLegacy({ code: "403", message: "upstream log: RESOURCE_LIMIT seen at 12:00" }) === false,
);
check("老的 429 形状照旧可重试", isRetryableLegacy({ status: 429 }) === true);
check("provider_error 照旧可重试", isRetryableLegacy({ code: "provider_error" }) === true);
check(
  "纯粹的 403 不可重试",
  isRetryableLegacy({ code: "403", status: 403, message: "forbidden" }) === false,
);
check(
  "403 + pricing 不判成排队",
  isRetryableLegacy({ code: "403", status: 403, message: "no credits, see https://qoder.sh/pricing" }) === false,
);

section("1b. 403 + pricing 仍然走「没额度」");

{
  const error = legacyError({ code: "403", status: 403, message: "quota gone, see https://qoder.sh/pricing" });
  check("是 402", error.status === 402, String(error.status));
  check("类型是 usage_limit_error", error.type === "usage_limit_error", String(error.type));
  check("说的是没额度", /no credits left/.test(error.message), error.message);
}

/* ------------------------------------------------------------------ *
 * 2. 等多久
 * ------------------------------------------------------------------ */

section("2. 上游给了秒数就按它等，没给退回配置的那个值");

check("retryAfterSeconds 60 → 60 秒", legacyWaitMs({ message: queueMessage(60) }, 10_000) === 60_000);
check("没有秒数 → 配置的那个值", legacyWaitMs({ message: queueMessage() }, 10_000) === 10_000);
check("正文根本不是 JSON → 配置的那个值", legacyWaitMs({ message: "busy" }, 10_000) === 10_000);
check("没有正文 → 配置的那个值", legacyWaitMs({}, 10_000) === 10_000);
check(
  "waitTime 那种写法也认",
  legacyWaitMs({ message: JSON.stringify({ code: "10605", message: JSON.stringify({ waitTime: 30 }) }) }, 10_000) ===
    30_000,
);

section("2b. 重试循环真的等那么久（注入的 sleep，不真等）");

{
  const { waits, sleep } = waiter();
  let calls = 0;
  const chunks = await drain(
    legacyWithRetry(
      async () => {
        calls++;
        return calls === 1 ? responseOf(errorFrame(queueMessage(60))) : responseOf(chunkFrame("ok"));
      },
      10_000,
      sleep,
    ),
  );
  check("等了一次", waits.length === 1, JSON.stringify(waits));
  check("等的是上游说的 60 秒", waits[0] === 60_000, JSON.stringify(waits));
  check("打了两次上游", calls === 2, String(calls));
  check("答复还是发出来了", chunks.length === 1 && chunks[0].choices?.[0]?.delta?.content === "ok");
}

{
  const { waits, sleep } = waiter();
  let calls = 0;
  await drain(
    legacyWithRetry(
      async () => {
        calls++;
        return calls === 1 ? responseOf(errorFrame(queueMessage())) : responseOf(chunkFrame("ok"));
      },
      2_500,
      sleep,
    ),
  );
  check("没给秒数就等配置的那个值", waits[0] === 2_500, JSON.stringify(waits));
}

/* ------------------------------------------------------------------ *
 * 3. 单次等待的上限
 * ------------------------------------------------------------------ */

section("3. 上游要 600 秒，最多等 60 秒");

check("legacyWaitMs 夹到 60 秒", legacyWaitMs({ message: queueMessage(600) }, 10_000) === 60_000);

{
  const { waits, sleep } = waiter();
  let calls = 0;
  await drain(
    legacyWithRetry(
      async () => {
        calls++;
        return calls === 1 ? responseOf(errorFrame(queueMessage(600))) : responseOf(chunkFrame("ok"));
      },
      10_000,
      sleep,
    ),
  );
  check("循环里真的只等 60 秒", waits[0] === 60_000, JSON.stringify(waits));
}

/* ------------------------------------------------------------------ *
 * 4. 帧级错误的日志
 * ------------------------------------------------------------------ */

section("4. 帧内错误那一行日志：有正文，没有凭据");

// 合成正文：顶层一个 cookie 字段，内层一个邮箱与一个令牌 —— 两层都要抹掉。
const syntheticEmail = "queue-operator@example.test"; // privacy:allow — 编造的样例
const syntheticCookie = "acw_tc=SYNTHETICCOOKIEVALUE0123456789"; // privacy:allow — 编造的样例
const syntheticToken = "Bearer sk-TESTONLY0000000000"; // privacy:allow — 编造的样例

function leakyMessage(): string {
  const inner = {
    errorCode: 0,
    isQueued: true,
    queueType: "p4",
    retryAfterSeconds: 60,
    subCode: "RESOURCE_LIMIT",
    account: syntheticEmail,
    authorization: syntheticToken,
  };
  return JSON.stringify({ code: "10605", message: JSON.stringify(inner), subCode: "RESOURCE_LIMIT" });
}

{
  const warnings = await warningsDuring(() =>
    thrownBy(() =>
      drain(legacyWithRetry(async () => responseOf(errorFrame(leakyMessage())), 10_000, waiter().sleep)),
    ),
  );
  const line = warnings.find((w) => w.includes("老协议帧内错误")) ?? "";
  check("打了一行帧内错误", line.length > 0, JSON.stringify(warnings));
  check("行里有上游的 code", line.includes("403"), line);
  check("行里有上游正文（排队的标记）", line.includes("isQueued"), line);
  check("行里有上游正文（subCode）", line.includes("RESOURCE_LIMIT"), line);
  check("行里有上游说的秒数", line.includes("60"), line);
  check("没有邮箱", !line.includes(syntheticEmail), line);
  check("没有令牌", !line.includes("TESTONLY"), line);
  check("没有 cookie", !line.includes("SYNTHETICCOOKIE"), line);
}

{
  // 顶层的 cookie 字段：按字段名抹（这一层不是嵌套）。
  const warnings = await warningsDuring(() =>
    thrownBy(() =>
      drain(
        legacyWithRetry(
          async () => responseOf(errorFrame(JSON.stringify({ code: "500", cookie: syntheticCookie, message: "boom" }))),
          10_000,
          waiter().sleep,
        ),
      ),
    ),
  );
  const line = warnings.find((w) => w.includes("老协议帧内错误")) ?? "";
  check("顶层 cookie 也被抹掉", line.length > 0 && !line.includes("SYNTHETICCOOKIE"), line);
  check("顶层的正文还在", line.includes("boom"), line);
}

/* ------------------------------------------------------------------ *
 * 4b. 嵌套太深：不输出正文
 * ------------------------------------------------------------------ */

section("4b. 嵌套深过三层就不输出正文（抹不干净的宁可不说）");

// 四层嵌套时第四层里那个 cookie 已经拆不开了：靠文本规则碰运气不算脱敏，所以
// 那一层整段不输出。这里那个字段叫 `auth`（不在抹字段名那张表里），值是一串
// cookie：旧行为下它就原样落到日志里（文本规则只认 `cookie` 这个字段名与令牌
// 形状，不认这串）。
{
  const deepest = JSON.stringify({ auth: syntheticCookie });
  const level3 = JSON.stringify({ level4: deepest });
  const level2 = JSON.stringify({ level3 });
  const level1 = JSON.stringify({ code: "10605", message: level2, subCode: "RESOURCE_LIMIT" });
  const warnings = await warningsDuring(() =>
    thrownBy(() => drain(legacyWithRetry(async () => responseOf(errorFrame(level1)), 10_000, waiter().sleep))),
  );
  const line = warnings.find((w) => w.includes("老协议帧内错误")) ?? "";
  check("打了一行帧内错误", line.length > 0, JSON.stringify(warnings));
  check("那一层打的是「正文未解析」", line.includes("(正文未解析)"), line);
  check("没有 cookie", !line.includes("SYNTHETICCOOKIE"), line);
  check("没有令牌", !line.includes("TESTONLY"), line);
}

/* ------------------------------------------------------------------ *
 * 5. 重试用尽：是排队，不是账号坏了
 * ------------------------------------------------------------------ */

section("5. 等过一次仍是排队：是排队，不是账号坏了");

// 以前这里抛的是 legacyError：403 给 503，分类按 5xx 当「上游挂了」—— 健康账号
// 被记冷却，策略还会在同一个账号上再跑一轮重试（客户端最坏等 240s+）。
{
  const { waits, sleep } = waiter();
  let calls = 0;
  let thrown: any;
  try {
    await drain(
      legacyWithRetry(
        async () => {
          calls++;
          return responseOf(errorFrame(queueMessage(60)));
        },
        10_000,
        sleep,
      ),
    );
  } catch (e) {
    thrown = e;
  }
  const failure = thrown ? classifyUpstreamError(thrown) : null;
  const { cooldownForFailure } = await import("../lib/router/account-cooldown.ts");
  check("抛了", Boolean(thrown));
  check("是排队那个形状（QueuedError）", thrown?.name === "QueuedError", String(thrown?.name));
  check("分类不是 server", failure?.kind !== "server", String(failure?.kind));
  check("分类是 queued", failure?.kind === "queued", String(failure?.kind));
  check("降级（另一个目标有自己的队列）", failure?.degradable === true, String(failure?.degradable));
  check("上游没给过状态（200 的流里说的）", failure?.status === null, String(failure?.status));
  check("不记冷却（账号没坏）", cooldownForFailure("qoder-legacy-test", thrown) === null, "记了冷却");
  check("上游给的秒数带上（夹到 60 秒）", thrown?.retryAfterSec === 60, String(thrown?.retryAfterSec));
  check("message 说等了之后仍是排队", /still queued after 2 attempts/.test(String(thrown?.message)), String(thrown?.message));
  check("hint 说上游把模型排进了队列", String(thrown?.hint ?? "").includes("排队"), String(thrown?.hint));
  check(
    "hint 说上游给的那段时间等过也未必能排上（不是只说一句排队）",
    String(thrown?.hint ?? "").includes("等到它给的时间"),
    String(thrown?.hint),
  );
  check(
    "hint 不说成限流 / 冷却 / 内部术语",
    !/限流|冷却中|cooling down|RESOURCE_LIMIT|10605|p4/.test(String(thrown?.hint ?? "")),
    String(thrown?.hint),
  );
  check("客户端看到的类型是 429 那个类型", thrown?.type === "rate_limit_error", String(thrown?.type));
  check("试了两次（首次 + 等过一次后那一次）", calls === 2, String(calls));
  check("只等了一次", waits.length === 1, JSON.stringify(waits));
  check("按上游说的 60 秒等", waits.every((ms) => ms === 60_000), JSON.stringify(waits));
}

section("5b. 策略那一层不会在同一个账号上再跑一轮");

// 这一条才是那个事故：分类成 server（瞬时失败）时，策略在同一个账号上再跑一整
// 轮 legacyWithRetry，客户端最坏等 240s+，而排队根本不是账号的问题。
{
  const { waits, sleep } = waiter();
  let sends = 0;
  let runs = 0;
  let thrown: any;
  try {
    await runWithRetries(
      { id: "qoder-legacy-test" },
      "legacy queue exhausted",
      async () => {
        runs++;
        return drain(
          legacyWithRetry(
            async () => {
              sends++;
              return responseOf(errorFrame(queueMessage(60)));
            },
            10_000,
            sleep,
          ),
        );
      },
      // 策略自己的等待不真等：这一条测的是次数，不是时间。
      { sleep: async () => {} },
    );
  } catch (e) {
    thrown = e;
  }
  check("抛了", Boolean(thrown));
  check("策略只把这个账号跑了一轮", runs === 1, String(runs));
  check("策略没有在同一个账号上再跑一轮（上游被叫两次，就是那一次等待）", sends === 2, String(sends));
  check("这一轮只等了一次", waits.length === 1, JSON.stringify(waits));
  check("抛的是排队那个错", thrown?.name === "QueuedError", String(thrown?.name));
}

section("5c. 不是排队的错误一次都不重试");

{
  const { waits, sleep } = waiter();
  let calls = 0;
  let thrown: any;
  try {
    await drain(
      legacyWithRetry(
        async () => {
          calls++;
          return responseOf(errorFrame("forbidden", "403", 403));
        },
        10_000,
        sleep,
      ),
    );
  } catch (e) {
    thrown = e;
  }
  check("抛了", Boolean(thrown));
  check("只打了一次上游", calls === 1, String(calls));
  check("一次都没等", waits.length === 0, JSON.stringify(waits));
  check("客户端看到 503", thrown?.status === 503, String(thrown?.status));
}

/* ------------------------------------------------------------------ *
 * 5d. QODER_SKIP_QUEUE_WAIT：跳过那一次等待
 * ------------------------------------------------------------------ */

section("5d. 开关关着（默认）等一次；打开就一次都不等，客户端拿到的仍是同一个答复");

/**
 * 一次「每次都排队」的调用：上游被叫了几次、睡了几次、抛了什么。
 *
 * 两个模式各跑一次同一个函数，差别就只剩那个开关。
 */
async function queueOnlyRun(): Promise<{
  calls: number;
  waits: number[];
  thrown: any;
  hint: string;
  retryAfterSec: unknown;
}> {
  const { waits, sleep } = waiter();
  let calls = 0;
  let thrown: any;
  try {
    await drain(
      legacyWithRetry(
        async () => {
          calls++;
          return responseOf(errorFrame(queueMessage(60)));
        },
        10_000,
        sleep,
      ),
    );
  } catch (e) {
    thrown = e;
  }
  return { calls, waits, thrown, hint: String(thrown?.hint ?? ""), retryAfterSec: thrown?.retryAfterSec };
}

// 默认：没设置，就是现在线上的行为 —— 等一次、再打一次、仍排队就交出去。
configClear("QODER_SKIP_QUEUE_WAIT");
const defaultRun = await queueOnlyRun();
check("默认：上游被叫了两次（首次 + 等过一次后那一次）", defaultRun.calls === 2, String(defaultRun.calls));
check("默认：睡了一次", defaultRun.waits.length === 1, JSON.stringify(defaultRun.waits));
check("默认：睡的是上游说的 60 秒", defaultRun.waits[0] === 60_000, JSON.stringify(defaultRun.waits));
check("默认：抛的是排队那个错", defaultRun.thrown?.name === "QueuedError", String(defaultRun.thrown?.name));

// 打开开关：第一帧排队就是最后一次尝试，一秒都不等。
configOverride("QODER_SKIP_QUEUE_WAIT", "true");
const skipRun = await queueOnlyRun();
check("打开开关：上游只被叫了一次", skipRun.calls === 1, String(skipRun.calls));
check("打开开关：一次都没睡（那 60 秒没花出去）", skipRun.waits.length === 0, JSON.stringify(skipRun.waits));
check("打开开关：抛的还是排队那个错", skipRun.thrown?.name === "QueuedError", String(skipRun.thrown?.name));
check(
  "两种模式下 hint 一模一样（客户端不因这个开关换说法）",
  skipRun.hint === defaultRun.hint && skipRun.hint.length > 0,
  `skip=${skipRun.hint} default=${defaultRun.hint}`,
);
check(
  "两种模式下 retryAfterSec 一样（都是上游说的 60 秒）",
  skipRun.retryAfterSec === 60 && defaultRun.retryAfterSec === 60,
  `skip=${String(skipRun.retryAfterSec)} default=${String(defaultRun.retryAfterSec)}`,
);
check(
  "跳过模式下仍然可降级（分类是 queued）",
  classifyUpstreamError(skipRun.thrown)?.kind === "queued",
  String(classifyUpstreamError(skipRun.thrown)?.kind),
);

// 控制组：开关只管排队，别的错一次都不重试（开着开关也一样）。
{
  const { waits, sleep } = waiter();
  let calls = 0;
  let thrown: any;
  try {
    await drain(
      legacyWithRetry(
        async () => {
          calls++;
          return responseOf(errorFrame("forbidden", "403", 403));
        },
        10_000,
        sleep,
      ),
    );
  } catch (e) {
    thrown = e;
  }
  check("控制组（开关开着）：纯粹的 403 只打一次上游", calls === 1, String(calls));
  check("控制组（开关开着）：一次都没等", waits.length === 0, JSON.stringify(waits));
  check("控制组（开关开着）：仍是 503 那个错", thrown?.status === 503, String(thrown?.status));
}

// 交回去：后面的那几节测的是默认行为。
configClear("QODER_SKIP_QUEUE_WAIT");
check(
  "交回默认：上游又被叫两次了",
  (await queueOnlyRun()).calls === 2,
  "清除覆盖值之后没有回到「等一次」",
);

/* ------------------------------------------------------------------ *
 * 6. 正常帧照旧
 * ------------------------------------------------------------------ */

section("6. 正常答复照旧通过，重试对客户端不可见");

{
  const { waits, sleep } = waiter();
  const chunks = await drain(
    legacyWithRetry(async () => responseOf(chunkFrame("hello "), chunkFrame("world")), 10_000, sleep),
  );
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  check("两帧都出来了", text === "hello world", text);
  check("一次都没等", waits.length === 0, JSON.stringify(waits));
}

/* ------------------------------------------------------------------ *
 * 7. 录下来的那份上游答复里没有真东西
 * ------------------------------------------------------------------ */

section("7. 录下来的那份答复：上游给的值都是同形状的合成值");

{
  // 仓库是公开的，而这份 fixture 是上游真的答过的那一次。上游给了 cookie、几种
  // request/trace id、一串时间戳、答复自己的 id 与 created，还有那一趟调用的用量
  // （token 数、credits）与耗时 —— 那些都是真的，必须换成同形状的合成值。这一条
  // 是它的判别断言：真值被换回来了就红。
  const recorded = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "post-qoder-legacy-algo-api-v2-service-pro-sse-agent-chat-generation-FetchKeys-llm-model-result-AgentId-agent-common-Encode-1.json"), "utf8"),
  );
  const headers = recorded.headers ?? {};
  // 形状不改（长度、字符集都相近），只把值换成一眼能看出是编的。
  const expected: Record<string, string> = {
    "set-cookie": `acw_tc=SYNTHETIC${"0".repeat(54)};path=/;HttpOnly;Max-Age=1800`,
    "ga-request-id": "0123456789abcdef0123456789abcdef",
    "sw-trace-id": "fedcba9876543210fedcba9876543210",
    "x-request-id": "00000000-0000-4000-8000-000000000000",
    date: "Thu, 01 Jan 2026 00:00:00 GMT",
    "entry-timestamp": "1700000000000",
    "leave-timestamp": "1700000000100",
    "req-arrive-time": "1700000000000",
    "resp-start-time": "1700000001800",
  };
  for (const [name, value] of Object.entries(expected)) {
    check(`录下来的 ${name} 是合成值`, headers[name] === value, String(headers[name]));
  }
  // 答复自己带的 id 与时间戳也是上游给的：整个答复里只应该有一个 id、一个
  // created，而且都是合成值。
  const ids = new Set((recorded.body ?? "").match(/\\"id\\":\\"([0-9a-f]+)\\"/g) ?? []);
  check(
    "答复里只有一个 id，而且是合成的",
    ids.size === 1 && [...ids][0] === '\\"id\\":\\"0123456789abcdef0123456789abcd\\"',
    JSON.stringify([...ids]),
  );
  const created = new Set((recorded.body ?? "").match(/\\"created\\":(\d+)/g) ?? []);
  check(
    "答复里的时间戳是合成的",
    created.size === 1 && [...created][0] === '\\"created\\":1700000000',
    JSON.stringify([...created]),
  );

  // 用量与耗时是同一场录制的真实测量值：只换外形不保留原值，否则这一节名不副实。
  // 逐帧解开（`data:` 前缀、外层壳、内层 body 各一次），取带着 usage 的那一帧。
  const usage = (() => {
    for (const line of String(recorded.body ?? "").split("\n")) {
      if (!line.startsWith("data:{")) continue;
      try {
        const payload = JSON.parse(JSON.parse(line.slice("data:".length)).body);
        if (payload?.usage) return payload.usage;
      } catch {
        // [DONE] 之类不是 JSON 帧，跳过
      }
    }
    return undefined;
  })();
  const usageCase: Array<[string, unknown, unknown]> = [
    ["completion_tokens", 12, usage?.completion_tokens],
    ["prompt_tokens", 8, usage?.prompt_tokens],
    ["total_tokens", 20, usage?.total_tokens],
    ["completion_tokens_details.reasoning_tokens", 8, usage?.completion_tokens_details?.reasoning_tokens],
    ["credits", 0.0785, usage?.credits],
    ["original_credits", 0.0785, usage?.original_credits],
  ];
  check("答复里找得到 usage", Boolean(usage), String(JSON.stringify(usage)));
  for (const [field, expectedValue, actual] of usageCase) {
    check(`录下来的 usage.${field} 是合成值`, actual === expectedValue, `actual=${String(actual)} expected=${String(expectedValue)}`);
  }

  const finish = (() => {
    const matched = /event:finish\ndata:(\{[^\n]*\})/.exec(String(recorded.body ?? ""));
    try {
      return matched ? JSON.parse(matched[1]) : undefined;
    } catch {
      return undefined;
    }
  })();
  const durationCase: Array<[string, unknown]> = [
    ["firstTokenDuration", 1700],
    ["totalDuration", 3800],
    ["serverDuration", 100],
  ];
  check("答复里有收尾那一帧", Boolean(finish), String(JSON.stringify(finish)));
  for (const [field, expectedValue] of durationCase) {
    check(
      `录下来的 ${field} 是合成值`,
      finish?.[field] === expectedValue,
      `actual=${String(finish?.[field])} expected=${String(expectedValue)}`,
    );
  }
}

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
