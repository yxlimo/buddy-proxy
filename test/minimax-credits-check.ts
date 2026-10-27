// test/minimax-credits-check.ts — MiniMax 的「还能不能用」：plan 额度，或者积分加开关。
//
//   node --experimental-strip-types test/minimax-credits-check.ts
//
// 离线：上游是本地起的一个假服务，不碰真接口。
//
// 平台在 Token Plan 窗口达限之后，如果账号里有积分、而且「Token Plan 达限后使用
// 积分」这个开关开着，就会继续答（扣积分）；开关关着才回 2067。所以判定是
//
//   可用 = plan 还有额度  或  (积分 > 0 且 开关开)
//
// 覆盖：
//
//   1. 两个数都读得出来（积分要签名、开关要 X-Group-Id）；
//   2. 读不到时是 null —— 「不知道」，不是「没有」；
//   3. 六种判定：积分与开关的四种组合、读不到退回旧行为、plan 有额度、视频窗口。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-credits-"));
process.env.BUDDY_DATA_DIR = tmp;

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

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 假上游怎么答：改成 error 就是「读不到」。 */
let mode: "ok" | "error" = "ok";
let membershipHeaders: Record<string, string> = {};
let membershipBody: any = null;
let fallbackHeaders: Record<string, string> = {};
let pointsAmount = "1,234.5";

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const collect = (then: (body: any) => void) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        then(raw ? JSON.parse(raw) : null);
      } catch {
        then(null);
      }
    });
  };

  if (mode === "error") return send(500, { base_resp: { status_code: 500 } });

  // workspace 列表：客户端取 selected 那条。
  if (url.startsWith("/matrix/api/v1/user/get_user_extra_info")) {
    return collect(() =>
      send(200, {
        data: {
          workspaces: [
            { id: "ws-old", op_group_id: "grp-old", selected: false },
            { id: "ws-1", op_group_id: "grp-1", selected: true },
          ],
        },
        base_resp: { status_code: 0 },
      }),
    );
  }

  // 积分：要签名，要 workspace_id。
  if (url.startsWith("/matrix/api/v1/commerce/get_membership_info")) {
    membershipHeaders = req.headers as Record<string, string>;
    return collect((body) => {
      membershipBody = body;
      send(200, {
        data: { op_credit_summary: { total_remaining_amount: pointsAmount } },
        base_resp: { status_code: 0 },
      });
    });
  }

  // 开关：不要签名，要 X-Group-Id。
  if (url.startsWith("/backend/account/token_plan_credit")) {
    fallbackHeaders = req.headers as Record<string, string>;
    return send(200, { token_plan_credit_fallback_enabled: true, base_resp: { status_code: 0 } });
  }

  send(404, { base_resp: { status_code: 404 } });
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

// 平台地址在模块加载时读，所以要在 import 之前设好。MINIMAX_API_BASE 是离线
// 测试统一用的那个假上游地址，积分与开关也跟着它走。
process.env.MINIMAX_API_BASE = fakeBase;

/* ------------------------------------------------------------------ *
 * 一、两个数都读得出来
 * ------------------------------------------------------------------ */

section("积分与开关都读得出来");

// 先加载注册表：minimax 那一条会把 auth / transport 的循环依赖先跑完。从
// checkin.ts（points.ts 用它签名）先进去会在 AUTH_MODE 初始化之前取它。
await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { fetchMiniMaxPoints, fetchMiniMaxCreditFallback } = await import("../lib/minimax/points.ts");

const points = await fetchMiniMaxPoints("session-token", "cn");
check("积分读到了", points === 1234.5, String(points));
check(
  "积分请求带了签名",
  Boolean(membershipHeaders.yy && membershipHeaders["x-timestamp"] && membershipHeaders["x-signature"]),
  JSON.stringify(Object.keys(membershipHeaders)),
);
check(
  "积分请求带了 workspace_id（取的是 selected 那条）",
  membershipBody?.workspace_id === "ws-1",
  JSON.stringify(membershipBody),
);

const fallback = await fetchMiniMaxCreditFallback("session-token", "cn");
check("开关读到了", fallback === true, String(fallback));
check("开关请求带了 X-Group-Id", fallbackHeaders["x-group-id"] === "grp-1", String(fallbackHeaders["x-group-id"]));
check("开关请求没带签名", !fallbackHeaders.yy && !fallbackHeaders["x-signature"], JSON.stringify(Object.keys(fallbackHeaders)));

/* ------------------------------------------------------------------ *
 * 二、读不到就是 null
 * ------------------------------------------------------------------ */

section("读不到是「不知道」，不是「没有」");

mode = "error";
const noPoints = await fetchMiniMaxPoints("session-token", "cn");
check("读不到积分就是 null", noPoints === null, String(noPoints));
const noFallback = await fetchMiniMaxCreditFallback("session-token", "cn");
check("读不到开关就是 null", noFallback === null, String(noFallback));
mode = "ok";

// 积分答复里没有能认的字段：也是不知道，不是 0。
pointsAmount = "";
const blankPoints = await fetchMiniMaxPoints("session-token", "cn");
check("答复里没有积分字段就是 null（不是 0）", blankPoints === null, String(blankPoints));
pointsAmount = "1,234.5";

/* ------------------------------------------------------------------ *
 * 三、判定
 * ------------------------------------------------------------------ */

await import("../lib/kinds/index.ts");

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

const spentPlan = {
  windows: [{ model: "general", intervalPercent: 0, weeklyPercent: 0 }],
};
const freshPlan = {
  windows: [{ model: "general", intervalPercent: 80, weeklyPercent: 70 }],
};

/** 一份快照：plan 窗口 + 积分 + 开关（undefined 就是读不到）。 */
function snapshotWith(plan: unknown, points: unknown, fallback: unknown) {
  return {
    minimax: {
      minimax: {
        balance: 0,
        tokenPlan: plan,
        credits: [],
        points: points === undefined ? undefined : { amount: points, at: Date.now() },
        creditFallbackEnabled: fallback === undefined ? undefined : { enabled: fallback, at: Date.now() },
      },
    },
  } as any;
}

const kind = kindOf("minimax");
const outOfCredits = (snapshot: any) => kind?.outOfCredits?.(account, snapshot);

section("plan 见底之后看积分与开关");

check(
  "plan 见底 + 积分 100 + 开关开 → 还能用",
  outOfCredits(snapshotWith(spentPlan, 100, true)) === false,
  String(outOfCredits(snapshotWith(spentPlan, 100, true))),
);
check(
  "plan 见底 + 积分 0 + 开关开 → 没钱",
  outOfCredits(snapshotWith(spentPlan, 0, true)) === true,
  String(outOfCredits(snapshotWith(spentPlan, 0, true))),
);
check(
  "plan 见底 + 积分 100 + 开关关 → 没钱（积分不许自动花）",
  outOfCredits(snapshotWith(spentPlan, 100, false)) === true,
  String(outOfCredits(snapshotWith(spentPlan, 100, false))),
);
check(
  "plan 见底 + 积分读不到 → 退回只看 plan（没钱）",
  outOfCredits(snapshotWith(spentPlan, undefined, true)) === true,
  String(outOfCredits(snapshotWith(spentPlan, undefined, true))),
);
check(
  "plan 见底 + 开关读不到 → 退回只看 plan（没钱）",
  outOfCredits(snapshotWith(spentPlan, 100, undefined)) === true,
  String(outOfCredits(snapshotWith(spentPlan, 100, undefined))),
);
check(
  "plan 还有额度 → 能用，积分多少都不看",
  outOfCredits(snapshotWith(freshPlan, 0, false)) === false,
  String(outOfCredits(snapshotWith(freshPlan, 0, false))),
);

section("视频窗口照旧不参与判定");

const videoFull = {
  windows: [
    { model: "general", intervalPercent: 0, weeklyPercent: 0 },
    { model: "video", intervalPercent: 100, weeklyPercent: 100 },
  ],
};
check(
  "视频窗口满着也不算有钱",
  outOfCredits(snapshotWith(videoFull, 0, true)) === true,
  String(outOfCredits(snapshotWith(videoFull, 0, true))),
);
check(
  "只有视频窗口就没有判定依据",
  outOfCredits(snapshotWith({ windows: [videoFull.windows[1]] }, 0, false)) === false,
  String(outOfCredits(snapshotWith({ windows: [videoFull.windows[1]] }, 0, false))),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
if (fail > 0) process.exitCode = 1;
