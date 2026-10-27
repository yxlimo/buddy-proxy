// test/token-plan-check.ts — 套餐窗口里的视频那一格被无视。
//
//   node --experimental-strip-types test/token-plan-check.ts
//
// 离线：不连上游，只有一份手写的套餐快照。
//
// 网关只服务文本模型。平台按窗口报额度（general 管文本、video 管视频），一个
// 账号的文本额度用完时视频窗口往往还是满的。视频窗口要是被算进「这个账号还有
// 额度」，账号就会显示成可用，而文本请求必然被拒。所以：
//
//   1. 视图里只剩 general（video 不上屏）；
//   2. general 见底就是没钱，视频满着也不算；
//   3. 冷却的「窗口什么时候结束」不取视频窗口的时间。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-plan-"));
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

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 一份套餐：文本窗口见底，视频窗口满着
 * ------------------------------------------------------------------ */

const GENERAL_INTERVAL_ENDS = "2026-10-27T08:15:06.384Z";
const GENERAL_WEEKLY_ENDS = "2026-10-31T16:00:24.293Z";
// 视频窗口结束得比文本窗口早 —— 不排掉的话，冷却会取到这个时间。
const VIDEO_INTERVAL_ENDS = "2026-10-27T08:05:00.000Z";
const VIDEO_WEEKLY_ENDS = "2026-11-01T16:00:00.000Z";

const plan = {
  windows: [
    {
      model: "general",
      intervalPercent: 0,
      weeklyPercent: 70,
      intervalEndsAt: GENERAL_INTERVAL_ENDS,
      weeklyEndsAt: GENERAL_WEEKLY_ENDS,
    },
    {
      model: "video",
      intervalPercent: 100,
      weeklyPercent: 100,
      intervalEndsAt: VIDEO_INTERVAL_ENDS,
      weeklyEndsAt: VIDEO_WEEKLY_ENDS,
    },
  ],
};

/* ------------------------------------------------------------------ *
 * 1) 视图里只剩 general
 * ------------------------------------------------------------------ */

await import("../lib/kinds/index.ts");
const { tokenPlanView } = await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { setCached } = await import("../lib/store.ts");
const { HEALTH_CACHE_ID } = await import("../lib/health-cache.ts");
const { planWindowEndsAt } = await import("../lib/router/account-cooldown.ts");

section("视图里只剩文本窗口");

const view = tokenPlanView(plan);
check("只剩 general", view?.windows?.length === 1, JSON.stringify(view));
check("窗口的名字是 general", view?.windows?.[0]?.label === "general", JSON.stringify(view?.windows?.[0]));
check("文本窗口的百分比没被改", view?.windows?.[0]?.intervalPercent === 0, JSON.stringify(view?.windows?.[0]));

/* ------------------------------------------------------------------ *
 * 2) general 见底就是没钱
 * ------------------------------------------------------------------ */

section("文本额度见底就是没钱");

const account = {
  id: "minimax",
  kind: "minimax",
  alias: "",
  region: "",
  enabled: true,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;
const snapshot = { minimax: { minimax: { balance: 0, tokenPlan: plan, credits: [] } } } as any;
const kind = kindOf("minimax");
const outOfCredits = kind?.outOfCredits?.(account, snapshot);
check("general 0% 就是没额度（视频满着也不算）", outOfCredits === true, String(outOfCredits));

const textFull = {
  minimax: {
    minimax: {
      balance: 0,
      tokenPlan: { windows: [{ ...plan.windows[0], intervalPercent: 80, weeklyPercent: 70 }] },
      credits: [],
    },
  },
} as any;
const textOk = kind?.outOfCredits?.(account, textFull);
check("general 还有额度就是有", textOk === false, String(textOk));

const videoOnly = {
  minimax: { minimax: { balance: 0, tokenPlan: { windows: [plan.windows[1]] }, credits: [] } },
} as any;
const onlyVideo = kind?.outOfCredits?.(account, videoOnly);
check("只有视频窗口就不算没钱", onlyVideo === false, String(onlyVideo));

/* ------------------------------------------------------------------ *
 * 3) 冷却不取视频窗口的结束时间
 * ------------------------------------------------------------------ */

section("冷却不取视频窗口的结束时间");

setCached(HEALTH_CACHE_ID, snapshot);
const now = Date.parse("2026-10-27T08:00:00.000Z");
const endsAt = planWindowEndsAt("minimax", now);
check(
  "取的是文本窗口的 5 小时结束时间",
  endsAt === Date.parse(GENERAL_INTERVAL_ENDS),
  `${endsAt} ${endsAt ? new Date(endsAt).toISOString() : ""}`,
);

const withoutGeneral = {
  minimax: { minimax: { balance: 0, tokenPlan: { windows: [plan.windows[1]] }, credits: [] } },
} as any;
setCached(HEALTH_CACHE_ID, withoutGeneral);
check("只剩视频窗口就没有恢复时间", planWindowEndsAt("minimax", now) === null, String(planWindowEndsAt("minimax", now)));

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
