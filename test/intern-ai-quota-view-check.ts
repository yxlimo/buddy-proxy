// test/intern-ai-quota-view-check.ts — 面板看到的端砚额度，以及路由对它的判定。
//
//   node --experimental-strip-types test/intern-ai-quota-view-check.ts
//
// 离线：不问任何上游，快照是造出来的（值按平台 2026-10-28 真实回答的形状编）。
//
// 端砚的额度是两套东西：墨点余额（账号里还剩多少墨点）与滚动窗口（这段时间
// 里能用多少墨点）。面板原先只看得到墨点余额，真正的使用限额（5 小时 / 7 天
// 窗口）看不见；窗口见底时也说不出多久恢复；平台说账号不可用时我们照发请求。
//
// 额度现在由插件问回来（lib/intern-ai/quota-plugin.ts），快照里存的是那一次的
// 结论。所以这里造的是**结论**，不是原样答复：kind 只负责把结论读成面板那几行。
// 结论怎么算调用的是插件自己的那几个函数 —— 与 probe 分支里用的是同一批，口径
// 只有一份。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 临时目录走系统的 tmpdir：写死的 /tmp 在 Windows 上落到当前盘的根上，
// 而且两次运行会撞在同一个目录上。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-intern-ai-quota-view-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { internAiKind } = await import("../lib/intern-ai/register.ts");

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

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("intern-ai", "intern-ai", { quotaPlugin: "intern-ai-credits" });

const PROVIDER = {
  id: "intern-ai-test",
  platform: "intern-ai",
  kind: "intern-ai",
  region: "",
  alias: "端砚测试账号",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;

/** 平台的时刻是「本地时间（UTC+8），没有时区」。 */
function platformStamp(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 平台时刻对应的毫秒（按 UTC+8 解析）。 */
function platformMs(stamp: string): number {
  return Date.parse(`${stamp.replace(" ", "T")}+08:00`);
}

const WINDOW_5H = {
  window: "5h",
  enabled: true,
  limitCredits: 10,
  remainingCredits: 9.751,
  usedCredits: 0.249,
  nextRecoverAt: "2026-10-28 20:56:38",
};

const WINDOW_7D = {
  window: "7d",
  enabled: true,
  limitCredits: 50000,
  remainingCredits: 25000,
  usedCredits: 25000,
  nextRecoverAt: "2026-10-29 12:56:38",
};

function balance(over: Record<string, unknown> = {}): any {
  return {
    availableCredits: 506.179,
    activePackageCount: 1,
    window5h: { ...WINDOW_5H },
    window7d: { ...WINDOW_7D },
    used: 0,
    accessStatus: 1,
    rpmLimit: 50,
    decisionRpmLimit: 200,
    tpmLimit: 2000000,
    calculatedAt: "2026-10-28 19:35:13",
    ...over,
  };
}

const PACKS = [
  {
    id: "pkg-1",
    issuedAt: "2026-10-01 00:00:00",
    cycleType: "monthly",
    cycleStartAt: "2026-10-01 00:00:00",
    cycleEndAt: "2026-11-01 00:00:00",
    totalCredits: 1000,
    remainingCredits: 506.179,
    status: "available",
    incomeExpenseType: "platform_grant",
    remark: "每月免费基础包",
    effectiveAt: "2026-10-01 00:00:00",
    expireAt: "2026-11-01 00:00:00",
  },
];

const {
  internAiCreditsViews,
  internAiBlocked,
  internAiOutOfCredits,
  internAiRecoverAt,
} = await import("../lib/intern-ai/quota-plugin.ts");

/** 插件 id：快照里那一份按它存。 */
const PLUGIN_ID = "intern-ai-credits";

/** 一份结论（与 probe 落进快照的那一份同一个形状）。 */
function snapshotWith(bal: any, packs: any = PACKS): any {
  const credits = { balance: bal, packs };
  let probe;
  if (!bal) {
    probe = { state: "missing", views: [], recoverAt: null, message: "没有会话" };
  } else if (internAiBlocked(bal)) {
    probe = { state: "blocked", views: [], recoverAt: internAiRecoverAt(credits), message: "账号不能用" };
  } else if (internAiOutOfCredits(bal)) {
    probe = { state: "no_quota", views: [], recoverAt: internAiRecoverAt(credits), message: "墨点用完了" };
  } else {
    probe = { state: "ok", views: internAiCreditsViews(PROVIDER, credits), recoverAt: null, message: "" };
  }
  return { plugins: { [PLUGIN_ID]: { [PROVIDER.id]: probe } } };
}

console.log("");
console.log("面板看得到窗口（那才是端砚的使用限额）");

{
  const views = internAiKind.quotas(PROVIDER, snapshotWith(balance()));
  const view = views[0];
  const win = view?.tokenPlan?.windows?.[0];

  check("报出一个套餐窗口", Boolean(win), JSON.stringify(view?.tokenPlan));
  check(
    "5 小时窗口的剩余百分比",
    Math.abs((win?.intervalPercent ?? 0) - 97.51) < 0.01,
    String(win?.intervalPercent),
  );
  check(
    "7 天窗口的剩余百分比",
    Math.abs((win?.weeklyPercent ?? 0) - 50) < 0.01,
    String(win?.weeklyPercent),
  );
  check(
    "5 小时窗口的恢复时刻",
    win?.intervalEndsAt === platformMs("2026-10-28 20:56:38"),
    String(win?.intervalEndsAt),
  );
  check(
    "7 天窗口的恢复时刻",
    win?.weeklyEndsAt === platformMs("2026-10-29 12:56:38"),
    String(win?.weeklyEndsAt),
  );
}

console.log("");
console.log("墨点与窗口不混（余额是钱，窗口是限额）");

{
  const credits = internAiKind.quotas(PROVIDER, snapshotWith(balance()))[0]?.credits;
  check("余额就是 available_credits", credits?.remaining === 506.179, String(credits?.remaining));
  check("总额只由批次求和", credits?.total === 1000, String(credits?.total));
  check("窗口的 10000 不混进总额", credits?.total !== 10000, String(credits?.total));
  check("note 里写着限流", String(credits?.note ?? "").includes("RPM 50"), String(credits?.note));
}

console.log("");
console.log("窗口见底时，恢复时间取窗口自己的时刻");

{
  const only5h = balance({ window5h: { ...WINDOW_5H, remainingCredits: 0 } });
  const at5h = internAiKind.recoverAt?.(PROVIDER, snapshotWith(only5h)) ?? null;
  check(
    "5 小时窗口见底 → 取 5 小时窗口的 next_recover_at",
    at5h === platformMs("2026-10-28 20:56:38"),
    String(at5h),
  );

  const both = balance({
    window5h: { ...WINDOW_5H, remainingCredits: 0 },
    window7d: { ...WINDOW_7D, remainingCredits: 0 },
  });
  const atBoth = internAiKind.recoverAt?.(PROVIDER, snapshotWith(both)) ?? null;
  check(
    "两个窗口都见底 → 取较晚的那个",
    atBoth === platformMs("2026-10-29 12:56:38"),
    String(atBoth),
  );
}

console.log("");
console.log("额度没用完时没有恢复时刻（那不是「下次重置」）");

{
  const tomorrow = platformStamp(Date.now() + 24 * 3600_000);
  const packs = [{ ...PACKS[0], expireAt: tomorrow, cycleEndAt: tomorrow }];
  const snapshot = snapshotWith(balance(), packs);
  const at = internAiKind.recoverAt?.(PROVIDER, snapshot) ?? null;
  // 恢复时刻只在账号确实见底时有意义：还有墨点时它答 null，不拿批次的到期时间
  // 顶上（那不是「等多久能再用」）。
  check("还有额度 → 不知道什么时候恢复", at === null, String(at));
  const lot = internAiKind.quotas(PROVIDER, snapshot)[0]?.credits?.lots?.[0];
  check("批次的到期时间还在批次上", lot?.expiresAt === platformMs(tomorrow), `${lot?.expiresAt} vs ${platformMs(tomorrow)}`);
}

console.log("");
console.log("平台说账号不可用，就不再往它发请求");

{
  const blocked = internAiKind.outOfCredits(PROVIDER, snapshotWith(balance({ accessStatus: 0 })));
  check("access_status = 0 → 当作没钱", blocked === true, String(blocked));

  const normal = internAiKind.outOfCredits(PROVIDER, snapshotWith(balance()));
  check("access_status = 1 且有余额 → 有钱", normal === false, String(normal));

  // 平台没报这个字段时是 null，不是 0。「没说」不能当成「说不行」—— 0 会被
  // 当成账号不可用，把整条路的请求全拦死。
  const unreported = balance({ accessStatus: null });
  const unreportedOut = internAiKind.outOfCredits(PROVIDER, snapshotWith(unreported));
  check("平台没报 access_status（null）→ 不拦", unreportedOut === false, String(unreportedOut));

  const legacy = balance();
  delete legacy.accessStatus;
  const legacyOut = internAiKind.outOfCredits(PROVIDER, snapshotWith(legacy));
  check("老数据没有 access_status → 不误判", legacyOut === false, String(legacyOut));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
