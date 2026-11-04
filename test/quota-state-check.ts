// test/quota-state-check.ts — 额度探测的七种结论，以及平台按结论做的那一次处理。
//
//   node --experimental-strip-types test/quota-state-check.ts
//
// 离线：临时数据目录，不碰网络，不碰真凭据。这里只测通用那一层
// （lib/quota-state.ts）—— 每家插件的翻译由各自的测试管。
//
// 七种状态各自要回答四件事：面板上有没有数字、算不算见底、什么时候恢复、有没有
// 副作用。副作用只查冷却那一行（库里真的写了什么），因为别的副作用都不该有。
//
// 反证（改坏 lib/quota-state.ts 之后这个文件必须红）：
//   1. outOfCreditsOf 改成「有插件就算见底」→ ok 与 missing/unknown 两节红
//   2. applyProbeEffect 里 unauthorized 也走写冷却那条分支 → unauthorized 一节红

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quota-state-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { applyProbeEffect, outOfCreditsOf, probeOf, quotaProbe, quotaViewsOf, recoverAtOf } = await import(
  "../lib/quota-state.ts"
);
const { cooldownUntil, rateCooldownMs, setCooldown } = await import("../lib/cooldown.ts");

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
  console.log(name);
}

/** 一个账号行：这一层只用到 id。 */
function account(id: string): any {
  return {
    id,
    platform: "qiniu",
    kind: "qiniu",
    region: "",
    alias: id,
    enabled: true,
    weight: 0,
    policy: "single",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 一个只带插件桶的快照：这一层读不到别的桶。 */
function snapshotOf(plugins: Record<string, Record<string, unknown>>): any {
  return { plugins };
}

/** 一份有数字的额度（插件在 ok 的时候给的那一种）。 */
function creditView(accountId: string, remaining: number): any {
  return {
    upstreamId: accountId,
    accountId,
    credits: {
      total: 15000,
      used: 10000,
      remaining,
      lots: [{ id: "respack-general@华东", sourceLabel: "通用资源包", remaining, expiresAt: 0, status: "可用" }],
      note: `资源包：2 项，剩 ${remaining} k/tokens`,
    },
  };
}

/** 一条额度里有没有数字（余额/积分/套餐）。 */
function hasNumbers(view: any): boolean {
  if (!view) return false;
  const credits = view.credits;
  if (credits && (credits.total || credits.used || credits.remaining || credits.lots?.length)) return true;
  const balance = view.balance;
  if (balance && (balance.availableCny || balance.lots?.length)) return true;
  if (view.tokenPlan?.windows?.length) return true;
  return false;
}

/** 这个账号此刻的冷却；没有就是 null。 */
function cooldownOf(id: string): number | null {
  return cooldownUntil(id);
}

/* ------------------------------------------------------------------ *
 * ok：问到了
 * ------------------------------------------------------------------ */

section("ok");

const OK_ID = "quota-state-ok";
const okRow = account(OK_ID);
const okProbe = quotaProbe("ok", "资源包：2 项，剩 5000 k/tokens", {
  // 快照里那一份的 id 故意写成别人的：面板分组按当前账号，读的时候要改回来。
  views: [creditView("somebody-else", 5000)],
});
const okSnapshot = snapshotOf({ qiniu: { [OK_ID]: okProbe } });

const okViews = quotaViewsOf(okRow, okSnapshot, "qiniu");
check("有额度视图", okViews.length === 1, String(okViews.length));
check("视图里有数字", hasNumbers(okViews[0]), JSON.stringify(okViews[0]));
check("剩下的照插件说的", okViews[0]?.credits?.remaining === 5000, String(okViews[0]?.credits?.remaining));
check(
  "视图挂在当前账号上",
  okViews[0]?.upstreamId === OK_ID && okViews[0]?.accountId === OK_ID,
  `${okViews[0]?.upstreamId} / ${okViews[0]?.accountId}`,
);
check("不算见底", outOfCreditsOf(okRow, okSnapshot, "qiniu") === false);
check("没有恢复时刻", recoverAtOf(okRow, okSnapshot, "qiniu") === null);
applyProbeEffect(okRow, okProbe, () => {});
check("不写冷却", cooldownOf(OK_ID) === null, String(cooldownOf(OK_ID)));

/* ------------------------------------------------------------------ *
 * no_quota：上游说钱用完了
 * ------------------------------------------------------------------ */

section("no_quota");

const NO_QUOTA_ID = "quota-state-no-quota";
const noQuotaRow = account(NO_QUOTA_ID);
const RECOVER_AT = Date.now() + 3 * 60 * 60_000;
const noQuotaProbe = quotaProbe("no_quota", "资源包全部用尽：资源包：2 项，剩 0 k/tokens", {
  recoverAt: RECOVER_AT,
});
const noQuotaSnapshot = snapshotOf({ qiniu: { [NO_QUOTA_ID]: noQuotaProbe } });

const noQuotaViews = quotaViewsOf(noQuotaRow, noQuotaSnapshot, "qiniu");
check(
  "不算有数字",
  noQuotaViews.every((view) => !hasNumbers(view)),
  JSON.stringify(noQuotaViews),
);
check(
  "但有那句说明",
  String(noQuotaViews[0]?.credits?.note ?? "").includes("用尽"),
  String(noQuotaViews[0]?.credits?.note),
);
check("算见底", outOfCreditsOf(noQuotaRow, noQuotaSnapshot, "qiniu") === true);
check(
  "恢复时刻是快照里那个",
  recoverAtOf(noQuotaRow, noQuotaSnapshot, "qiniu") === RECOVER_AT,
  String(recoverAtOf(noQuotaRow, noQuotaSnapshot, "qiniu")),
);
applyProbeEffect(noQuotaRow, noQuotaProbe, () => {});
check("见底不写冷却", cooldownOf(NO_QUOTA_ID) === null, String(cooldownOf(NO_QUOTA_ID)));

/* ------------------------------------------------------------------ *
 * blocked：上游说这个账号不能用
 * ------------------------------------------------------------------ */

section("blocked");

const BLOCKED_ID = "quota-state-blocked";
const blockedRow = account(BLOCKED_ID);
const blockedProbe = quotaProbe("blocked", "账号被停用（access_status 0）", { recoverAt: RECOVER_AT });
const blockedSnapshot = snapshotOf({ qiniu: { [BLOCKED_ID]: blockedProbe } });

const blockedViews = quotaViewsOf(blockedRow, blockedSnapshot, "qiniu");
check("算不能接", outOfCreditsOf(blockedRow, blockedSnapshot, "qiniu") === true);
check(
  "恢复时刻是快照里那个",
  recoverAtOf(blockedRow, blockedSnapshot, "qiniu") === RECOVER_AT,
  String(recoverAtOf(blockedRow, blockedSnapshot, "qiniu")),
);
check(
  "面板分得出「不能用」与「用完了」",
  Boolean(blockedViews[0]?.credits?.note) && blockedViews[0]?.credits?.note !== noQuotaViews[0]?.credits?.note,
  `${blockedViews[0]?.credits?.note} / ${noQuotaViews[0]?.credits?.note}`,
);
check(
  "「不能用」那条没有数字",
  blockedViews.every((view) => !hasNumbers(view)),
  JSON.stringify(blockedViews),
);
applyProbeEffect(blockedRow, blockedProbe, () => {});
check("不能接不写冷却", cooldownOf(BLOCKED_ID) === null, String(cooldownOf(BLOCKED_ID)));

/* ------------------------------------------------------------------ *
 * unauthorized：凭据被拒
 * ------------------------------------------------------------------ */

section("unauthorized");

const UNAUTH_ID = "quota-state-unauthorized";
const unauthRow = account(UNAUTH_ID);
const unauthProbe = quotaProbe("unauthorized", "门户拒了这份 cookie（HTTP 401）");
const unauthSnapshot = snapshotOf({ qiniu: { [UNAUTH_ID]: unauthProbe } });

check("没有额度视图", quotaViewsOf(unauthRow, unauthSnapshot, "qiniu").length === 0);
check("不算见底", outOfCreditsOf(unauthRow, unauthSnapshot, "qiniu") === false);
check("没有恢复时刻", recoverAtOf(unauthRow, unauthSnapshot, "qiniu") === null);
const unauthLog: string[] = [];
applyProbeEffect(unauthRow, unauthProbe, (line) => unauthLog.push(line));
check("不写冷却", cooldownOf(UNAUTH_ID) === null, String(cooldownOf(UNAUTH_ID)));
check(
  "记一行，说的是凭据被拒",
  unauthLog.length === 1 && unauthLog[0].includes("凭据被拒"),
  unauthLog.join(" / "),
);
check(
  "那一行不说额度用尽",
  !unauthLog.some((line) => line.includes("用尽") || line.includes("冷却")),
  unauthLog.join(" / "),
);

/* ------------------------------------------------------------------ *
 * rate_limited：被限流
 * ------------------------------------------------------------------ */

section("rate_limited");

const RATE_ID = "quota-state-rate-limited";
const rateRow = account(RATE_ID);
const RETRY_AT = Date.now() + 120_000;
const rateProbe = quotaProbe("rate_limited", "门户限流了（HTTP 429）", { recoverAt: RETRY_AT });
const rateSnapshot = snapshotOf({ qiniu: { [RATE_ID]: rateProbe } });

check("没有额度视图", quotaViewsOf(rateRow, rateSnapshot, "qiniu").length === 0);
check("限流不是没钱", outOfCreditsOf(rateRow, rateSnapshot, "qiniu") === false);
check(
  "恢复时刻是快照里那个",
  recoverAtOf(rateRow, rateSnapshot, "qiniu") === RETRY_AT,
  String(recoverAtOf(rateRow, rateSnapshot, "qiniu")),
);
applyProbeEffect(rateRow, rateProbe, () => {});
check("写了冷却", cooldownOf(RATE_ID) !== null, String(cooldownOf(RATE_ID)));
check(
  "冷却到门户说的那个时刻",
  cooldownOf(RATE_ID) === RETRY_AT,
  `${cooldownOf(RATE_ID)} / ${RETRY_AT}`,
);

// 门户没说多久之后再来：按平台的默认时长。
const RATE_DEFAULT_ID = "quota-state-rate-default";
const rateDefaultRow = account(RATE_DEFAULT_ID);
const before = Date.now();
applyProbeEffect(rateDefaultRow, quotaProbe("rate_limited", "门户限流了（HTTP 429）"), () => {});
const defaultUntil = cooldownOf(RATE_DEFAULT_ID);
check("没说时长也写冷却", defaultUntil !== null, String(defaultUntil));
check(
  "时长按平台默认",
  defaultUntil !== null && Math.abs(defaultUntil - (before + rateCooldownMs())) < 5_000,
  `${defaultUntil} / ${before + rateCooldownMs()}`,
);

/* ------------------------------------------------------------------ *
 * missing / unknown：没填凭据、问不到
 * ------------------------------------------------------------------ */

section("missing / unknown");

for (const state of ["missing", "unknown"] as const) {
  const id = `quota-state-${state}`;
  const row = account(id);
  const probe = quotaProbe(state, state === "missing" ? "账号上没有门户 cookie" : "门户没问到：超时");
  const snapshot = snapshotOf({ qiniu: { [id]: probe } });
  check(`${state}：没有额度视图`, quotaViewsOf(row, snapshot, "qiniu").length === 0);
  check(`${state}：不算见底`, outOfCreditsOf(row, snapshot, "qiniu") === false);
  check(`${state}：没有恢复时刻`, recoverAtOf(row, snapshot, "qiniu") === null);
  const lines: string[] = [];
  applyProbeEffect(row, probe, (line) => lines.push(line));
  check(`${state}：不写冷却`, cooldownOf(id) === null, String(cooldownOf(id)));
  if (state === "missing") {
    check("missing：不记日志（用户还没填）", lines.length === 0, lines.join(" / "));
  } else {
    check("unknown：记一行说问不到", lines.length === 1 && lines[0].includes("问不到"), lines.join(" / "));
  }
}

/* ------------------------------------------------------------------ *
 * probeOf：快照里那一份怎么读
 * ------------------------------------------------------------------ */

section("probeOf");

const PROBE_ID = "quota-state-probe-of";
const probeRow = account(PROBE_ID);
check(
  "没指名插件 → 没有答案",
  probeOf(snapshotOf({ qiniu: { [PROBE_ID]: okProbe } }), "", PROBE_ID) === null,
);
check(
  "插件没登记（快照里没这一桶）→ 没有答案",
  probeOf(snapshotOf({}), "qiniu", PROBE_ID) === null,
);
check(
  "快照里没有这个账号 → 没有答案",
  probeOf(snapshotOf({ qiniu: {} }), "qiniu", PROBE_ID) === null,
);
check(
  "空快照 → 没有答案",
  probeOf(null, "qiniu", PROBE_ID) === null,
);
check(
  "认不出的状态 → 没有答案（不当成 ok）",
  probeOf(snapshotOf({ qiniu: { [PROBE_ID]: { state: "half-ok", views: [], recoverAt: null, message: "" } } }), "qiniu", PROBE_ID) === null,
);
const readBack = probeOf(snapshotOf({ qiniu: { [PROBE_ID]: okProbe } }), "qiniu", PROBE_ID);
check("认得的状态原样读回来", readBack === okProbe);
check(
  "读不出来的那份不算见底",
  outOfCreditsOf(probeRow, snapshotOf({ qiniu: { [PROBE_ID]: { state: "half-ok" } } }), "qiniu") === false,
);

// 冷却那一行清掉，别的断言才不会看到上一节的残留。
setCooldown(PROBE_ID, Date.now() - 1_000, "test");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
