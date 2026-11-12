// test/admin-config-check.ts — the settings the panel shows, and the three
// timeout knobs that used to be environment-only.
//
//   node --experimental-strip-types test/admin-config-check.ts
//
// Offline: one temporary data directory, no network, no upstream.
//
// What it covers:
//   1. the panel's list holds the eleven keys — the three timeouts, the
//      periodic timer, the health snapshot, check-in, Qoder's queue retry;
//   2. each of those eight has a label and one sentence, and the sentence is
//      short enough to read in one line (the panel's own rule: 30 characters);
//   3. the three ROUTER_* defaults are the ones the router itself uses —
//      a number that drifted here would change the routing behaviour without
//      anything else noticing;
//   4. the environment wins: a deployment that pins ROUTER_FIRST_FRAME_MS keeps
//      the deployment's value, whatever the panel says;
//   5. the panel's value really reaches the router: a database override of the
//      idle limit is in force for the next stream — the point of reading the
//      setting per answer instead of once at module load;
//   6. only the settings that are read per request are hot, so the panel says
//      "pending restart" about exactly the ones that need it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-config-"));
process.env.BUDDY_DATA_DIR = tmp;
// This round checks the defaults, so none of the three may be pinned by
// whoever runs the test.
for (const key of ["ROUTER_FIRST_FRAME_MS", "ROUTER_STREAM_IDLE_MS", "ROUTER_RETRY_BUDGET_MS"]) {
  delete process.env[key];
}

const { configItems } = await import("../lib/admin/config.ts");
const { configClear, configNumber, configOverride, configPendingRestart, reloadConfig } = await import(
  "../lib/config.ts"
);
const {
  STREAM_FIRST_FRAME_DEFAULT_MS,
  STREAM_IDLE_DEFAULT_MS,
  StreamIdleError,
  withStreamIdle,
} = await import("../lib/router/deliver.ts");
const { ATTEMPT_BUDGET_DEFAULT_MS } = await import("../lib/router/upstreams/policy.ts");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
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

/** One item on the panel, by key. */
const item = (key: string) => configItems().find((i) => i.key === key);

/* ------------------------------------------------------------------ *
 * 一、面板上有这八个
 * ------------------------------------------------------------------ */

section("面板上的八个键");

const NEW_KEYS = [
  "ROUTER_FIRST_FRAME_MS",
  "ROUTER_STREAM_IDLE_MS",
  "ROUTER_RETRY_BUDGET_MS",
  "PERIODIC_ENABLED",
  "HEALTH_CACHE_MS",
  "BENEFITS_DISABLED",
  "BENEFITS_INTERVAL_MS",
  "QODER_LEGACY_RETRY_MS",
];
const keys = configItems().map((i) => i.key);
for (const key of NEW_KEYS) {
  check(`面板上有 ${key}`, keys.includes(key), JSON.stringify(keys));
}

// 数字型的那几个要把值显示出来：一个空的控件等于告诉用户「现在是多少不知道」，
// 而实际生效的总是某个数（签到间隔是 3600000，其余为下面的默认值）。
for (const key of ["BENEFITS_INTERVAL_MS", "HEALTH_CACHE_MS", "QODER_LEGACY_RETRY_MS"]) {
  check(`${key} 面板上有值`, Number(item(key)?.value) > 0, JSON.stringify(item(key)?.value));
  check(`${key} 面板上有默认值`, Number(item(key)?.fallback) > 0, JSON.stringify(item(key)?.fallback));
}
check("签到间隔默认是一小时", Number(item("BENEFITS_INTERVAL_MS")?.value) === 3_600_000, JSON.stringify(item("BENEFITS_INTERVAL_MS")?.value));

// 一句说明一条控件：没有说明的那一项，面板上只剩一个键名，谁也不知道能改。
for (const key of NEW_KEYS) {
  const row = item(key);
  check(`${key} 有名字`, Boolean(row?.label) && row!.label !== key, JSON.stringify(row?.label));
  check(`${key} 有说明`, Boolean(row?.description), JSON.stringify(row?.description));
  check(
    `${key} 的说明不超过 30 字`,
    (row?.description ?? "").length <= 30,
    `${row?.description?.length} 字：${row?.description}`,
  );
}

/* ------------------------------------------------------------------ *
 * 二、三个旋钮的默认值
 * ------------------------------------------------------------------ */

section("三个超时旋钮的默认值");

// 路由里那份是准的：面板这一份与它必须一样，不然「默认值」有两个说法。
const DEFAULTS: [string, number, number][] = [
  ["ROUTER_FIRST_FRAME_MS", 300_000, STREAM_FIRST_FRAME_DEFAULT_MS],
  ["ROUTER_STREAM_IDLE_MS", 180_000, STREAM_IDLE_DEFAULT_MS],
  ["ROUTER_RETRY_BUDGET_MS", 180_000, ATTEMPT_BUDGET_DEFAULT_MS],
];
for (const [key, want, inRouter] of DEFAULTS) {
  check(`${key} 的默认值是 ${want}`, configNumber(key, -1) === want, String(configNumber(key, -1)));
  check(`${key} 面板显示的默认值也是 ${want}`, item(key)?.fallback === String(want), String(item(key)?.fallback));
  check(`${key} 与路由里那份一致`, inRouter === want, `${key}: 路由 ${inRouter} vs 期望 ${want}`);
  check(`${key} 现在生效的就是默认值`, item(key)?.value === String(want), String(item(key)?.value));
}

/* ------------------------------------------------------------------ *
 * 三、环境变量优先
 * ------------------------------------------------------------------ */

section("环境变量优先");

// 部署钉住的东西，部署说了算：面板写的那份在库里等着，但生效的是环境变量。
process.env.ROUTER_FIRST_FRAME_MS = "1234";
reloadConfig();
check("设了 env 之后读到 env 的值", configNumber("ROUTER_FIRST_FRAME_MS", 300_000) === 1234, String(configNumber("ROUTER_FIRST_FRAME_MS", 300_000)));
check("面板显示的是 env 的值", item("ROUTER_FIRST_FRAME_MS")?.value === "1234", String(item("ROUTER_FIRST_FRAME_MS")?.value));
check(
  "面板说这个值来自环境变量",
  item("ROUTER_FIRST_FRAME_MS")?.source === "environment",
  String(item("ROUTER_FIRST_FRAME_MS")?.source),
);

// 撤了环境变量就回到默认值：库里没有覆盖，代码里那份说了算。
delete process.env.ROUTER_FIRST_FRAME_MS;
reloadConfig();
check("撤了 env 之后回到默认值", configNumber("ROUTER_FIRST_FRAME_MS", 300_000) === 300_000, String(configNumber("ROUTER_FIRST_FRAME_MS", -1)));
check("面板显示的也回到默认值", item("ROUTER_FIRST_FRAME_MS")?.value === "300000", String(item("ROUTER_FIRST_FRAME_MS")?.value));

/* ------------------------------------------------------------------ *
 * 四、面板改的那份到了路由手里
 * ------------------------------------------------------------------ */

section("面板改的值真的生效");

configOverride("ROUTER_STREAM_IDLE_MS", "60");
reloadConfig();
check("改完读到的就是新值", configNumber("ROUTER_STREAM_IDLE_MS", 180_000) === 60, String(configNumber("ROUTER_STREAM_IDLE_MS", -1)));

/**
 * 一条先说一句、然后永远沉默的流。
 *
 * 第一帧是真的帧（不是心跳），所以闸从「等第一帧」换到「中途那个窗口」——
 * 中途那个窗口正是面板改的那个数。
 */
const encoder = new TextEncoder();
let sent = false;
const body = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (!sent) {
      sent = true;
      controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
      return;
    }
    return new Promise<void>(() => {
      /* 上游从此不说话 */
    });
  },
});

// 闸自己的定时器是 unref 的：只挂着它，事件循环会空着退出，这个 await 就永远
// 没人叫醒。这个定时器只是把事件循环撑住。
const guard = setTimeout(() => {
  /* 撑住事件循环，收尾时清掉 */
}, 5_000);
let firstFrame = "";
let gateError: unknown = null;
try {
  const gated = withStreamIdle(body, "check");
  const chunks = gated.getReader();
  const first = await chunks.read();
  firstFrame = first.done ? "" : new TextDecoder().decode(first.value);
  await chunks.read();
} catch (e) {
  gateError = e;
}
clearTimeout(guard);

check("第一帧原样交出来了", firstFrame.includes('"a":1'), firstFrame);
check(
  "中途沉默按面板那个数判超时",
  gateError instanceof StreamIdleError && gateError.idleMs === 60,
  gateError instanceof StreamIdleError ? `idleMs=${gateError.idleMs}` : String(gateError),
);
check(
  "句子说清是中途沉默",
  gateError instanceof StreamIdleError && gateError.phase === "mid-stream",
  gateError instanceof StreamIdleError ? gateError.message : String(gateError),
);

configClear("ROUTER_STREAM_IDLE_MS");
reloadConfig();
check("清掉覆盖之后又回到默认值", configNumber("ROUTER_STREAM_IDLE_MS", 180_000) === 180_000, String(configNumber("ROUTER_STREAM_IDLE_MS", -1)));

/* ------------------------------------------------------------------ *
 * 五、热的与要重启的
 * ------------------------------------------------------------------ */

section("热的与要重启的");

// 热的是「每条请求各读一次」的那些：面板改完就是新的值，所以面板不该再说
// 「要重启」。其余的（读一次就定在常量里）面板必须说清楚要重启。
const HOT: [string, string][] = [
  ["ROUTER_FIRST_FRAME_MS", "1111"],
  ["ROUTER_STREAM_IDLE_MS", "2222"],
  ["ROUTER_RETRY_BUDGET_MS", "3333"],
  ["BENEFITS_DISABLED", "true"],
];
const NEEDS_RESTART: [string, string][] = [
  ["PERIODIC_ENABLED", "false"],
  ["HEALTH_CACHE_MS", "60000"],
  ["BENEFITS_INTERVAL_MS", "1800000"],
  ["QODER_LEGACY_RETRY_MS", "5000"],
];

check("一开始没有待重启的东西", configPendingRestart() === false);

for (const [key, value] of HOT) {
  configOverride(key, value);
  reloadConfig();
  check(`${key} 改了不算待重启（它是热的）`, configPendingRestart() === false, String(configPendingRestart()));
  check(`${key} 生效的是新值`, String(item(key)?.value) === value, String(item(key)?.value));
  configClear(key);
  reloadConfig();
  check(`${key} 清掉之后又没有待重启的东西`, configPendingRestart() === false);
}

for (const [key, value] of NEEDS_RESTART) {
  configOverride(key, value);
  reloadConfig();
  check(`${key} 改了算待重启（它读一次就定住）`, configPendingRestart() === true, String(configPendingRestart()));
  configClear(key);
  reloadConfig();
  check(`${key} 清掉之后又没有待重启的东西`, configPendingRestart() === false);
}

check("变得回去：首帧上限又是 300000", configNumber("ROUTER_FIRST_FRAME_MS", 300_000) === 300_000, String(configNumber("ROUTER_FIRST_FRAME_MS", -1)));
check("变得回去：快照间隔又是 300000", configNumber("HEALTH_CACHE_MS", 300_000) === 300_000, String(configNumber("HEALTH_CACHE_MS", -1)));

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail ? 1 : 0);
