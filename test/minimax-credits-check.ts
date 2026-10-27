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
//   1. 积分是 credit/details 第一页里未过期条目之和（千分位、小数、过期条目）；
//   2. 满页也不翻页 —— 判定只要一个结论，明细才需要翻页；
//   3. workspace 的 id 字段叫 workspace_id，是数字 0 也认；
//   4. 读不到是 null ——「不知道」，不是「没有」；空明细才是 0；
//   5. 六种判定：积分与开关的四种组合、读不到退回旧行为、plan 有额度、视频窗口。
//
// 假上游的答复形状照真机（2026-10-27 用只读探针录的）：get_user_extra_info 的
// workspaces 在根级，id 叫 workspace_id；credit/details 的金额是字符串。

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

const DAY = 86_400_000;
const now = Date.now();

/** 假上游怎么答：改成 error 就是「读不到」。 */
let mode: "ok" | "error" = "ok";

/** workspace 列表：真机在根级，id 叫 workspace_id，数字。 */
let workspaceRows: any[] | null = [
  {
    workspace_id: 7,
    workspace_name: "other",
    op_group_id: "grp-old",
    selected: false,
  },
  {
    workspace_id: 0,
    workspace_name: "mol",
    workspace_type: 0,
    selected: true,
    personal_plan_type: 3,
    op_group_id: "grp-1",
    // 这两个字段是开放平台的积分，不是 MiniMax Code 的，不该被读
    opcredit_balance: 0,
    total_remains_credit: 0,
    has_token_plan: true,
    token_plan_tier: "Plus",
  },
];

/** 积分明细：一页一行组；返回 null 就是答复里没有 details。 */
let creditPageRows: (page: number) => any[] | null = () => [
  {
    credit_type: 2,
    granted_amount: "500.00",
    remaining_amount: "400.00",
    expire_at_ms: now + 30 * DAY,
  },
  {
    credit_type: 2,
    granted_amount: "2,000.00",
    remaining_amount: "1,234.50",
    expire_at_ms: now + 30 * DAY,
  },
  {
    credit_type: 2,
    granted_amount: "999.00",
    remaining_amount: "999.00",
    expire_at_ms: now - DAY,
  },
];

let creditHeaders: Record<string, string> = {};
let creditQuery = new URLSearchParams();
let creditPages: number[] = [];
let fallbackHeaders: Record<string, string> = {};

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const collect = (then: () => void) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", then);
  };

  if (mode === "error") return send(500, { base_resp: { status_code: 500 } });

  // workspace 列表：客户端取 selected 那条。
  if (url.startsWith("/matrix/api/v1/user/get_user_extra_info")) {
    return collect(() =>
      send(200, {
        user_extra: {},
        ...(workspaceRows ? { workspaces: workspaceRows } : {}),
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
  }

  // 积分明细：要签名，要分页参数（判定只取第一页），金额是字符串。
  if (url.startsWith("/minimax-cloud/api/v1/credit/details")) {
    creditHeaders = req.headers as Record<string, string>;
    const parsed = new URL(url, "http://fake");
    creditQuery = parsed.searchParams;
    const page = Number(parsed.searchParams.get("page_number") ?? "1");
    creditPages.push(page);
    const rows = creditPageRows(page);
    if (rows === null) return send(200, { base_resp: { status_code: 0 } });
    return send(200, { details: rows, base_resp: { status_code: 0, status_msg: "success" } });
  }

  // 开关：不要签名，要 X-Group-Id。
  if (url.startsWith("/backend/account/token_plan_credit")) {
    fallbackHeaders = req.headers as Record<string, string>;
    return send(200, {
      total_credits: 0,
      used_credits: 0,
      remaining_credits: 0,
      token_plan_credit_fallback_enabled: true,
      base_resp: { status_code: 0 },
    });
  }

  send(404, { base_resp: { status_code: 404 } });
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

// 平台地址在模块加载时读，所以要在 import 之前设好。MINIMAX_API_BASE 是离线
// 测试统一用的那个假上游地址，积分与开关也跟着它走。
process.env.MINIMAX_API_BASE = fakeBase;

/* ------------------------------------------------------------------ *
 * 一、积分求和
 * ------------------------------------------------------------------ */

section("积分是未过期明细之和");

// 先加载注册表：minimax 那一条会把 auth / transport 的循环依赖先跑完。从
// checkin.ts（points.ts 用它签名）先进去会在 AUTH_MODE 初始化之前取它。
await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { fetchMiniMaxPoints, fetchMiniMaxCreditFallback } = await import("../lib/minimax/points.ts");

const points = await fetchMiniMaxPoints("session-token", "cn");
check(
  "未过期积分求和正确（多条、千分位、含小数）",
  points === 1634.5,
  String(points),
);
check(
  "积分请求带了签名和翻页参数",
  Boolean(creditHeaders.yy && creditHeaders["x-timestamp"] && creditHeaders["x-signature"]) &&
    creditQuery.get("page_number") === "1" &&
    creditQuery.get("page_size") === "50" &&
    creditQuery.get("include_expired") === "false",
  JSON.stringify({ keys: Object.keys(creditHeaders), query: creditQuery.toString() }),
);

// 全过期：能答，但一分钱都没有 —— 0，不是 null。
creditPageRows = () => [
  {
    credit_type: 2,
    granted_amount: "999.00",
    remaining_amount: "999.00",
    expire_at_ms: now - DAY,
  },
];
const expiredOnly = await fetchMiniMaxPoints("session-token", "cn");
check("已过期条目被跳过", expiredOnly === 0, String(expiredOnly));

// 空明细：确实没有积分。
creditPageRows = () => [];
const empty = await fetchMiniMaxPoints("session-token", "cn");
check("明细为空数组 → 0（不是 null）", empty === 0, String(empty));

// 满页也不翻：判定只要一个布尔结论，明细才需要翻页。
creditPageRows = () =>
  Array.from({ length: 50 }, () => ({ remaining_amount: "1.00", expire_at_ms: now + DAY }));
creditPages = [];
const fullPage = await fetchMiniMaxPoints("session-token", "cn");
check(
  "满页时用第一页的和，不翻页",
  fullPage === 50 && creditPages.join(",") === "1",
  `${String(fullPage)} pages=${creditPages.join(",")}`,
);

// 答复里没有 details 数组：形状不认识，当作不知道。
creditPageRows = () => null;
const noDetails = await fetchMiniMaxPoints("session-token", "cn");
check("答复里没有 details 数组 → null（不是 0）", noDetails === null, String(noDetails));

/* ------------------------------------------------------------------ *
 * 二、读不到就是 null
 * ------------------------------------------------------------------ */

section("读不到是「不知道」，不是「没有」");

mode = "error";
const noPoints = await fetchMiniMaxPoints("session-token", "cn");
const noFallback = await fetchMiniMaxCreditFallback("session-token", "cn");
check("积分或开关读不到就是 null", noPoints === null && noFallback === null, `${String(noPoints)} ${String(noFallback)}`);
mode = "ok";

/* ------------------------------------------------------------------ *
 * 三、workspace 与开关
 * ------------------------------------------------------------------ */

section("workspace_id 是数字 0 也认");

creditPageRows = () => [{ remaining_amount: "400.00", expire_at_ms: now + DAY }];
const fallback = await fetchMiniMaxCreditFallback("session-token", "cn");
check(
  "workspace_id 为数字 0 仍取到 workspace（开关带上了选中那条的 X-Group-Id）",
  fallback === true && fallbackHeaders["x-group-id"] === "grp-1",
  `${String(fallback)} group=${String(fallbackHeaders["x-group-id"])}`,
);
check(
  "开关请求没带签名",
  !fallbackHeaders.yy && !fallbackHeaders["x-signature"],
  JSON.stringify(Object.keys(fallbackHeaders)),
);

/* ------------------------------------------------------------------ *
 * 四、判定
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
