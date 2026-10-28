// test/intern-ai-quota-view-check.ts — 面板看到的端砚额度，以及路由对它的判定。
//
//   node --experimental-strip-types test/intern-ai-quota-view-check.ts
//
// 离线：不问任何上游，快照是造出来的（值按平台 2026-10-28 真实回答的形状编）。
//
// 端砚的额度是两套东西：墨点余额（账号里还剩多少墨点）与滚动窗口（这段时间
// 里能用多少墨点）。面板原先只看得到墨点余额，真正的使用限额（5 小时 / 7 天
// 窗口）看不见；窗口见底时也说不出多久恢复；平台说账号不可用时我们照发请求。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-intern-ai-quota-view";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

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

function snapshotWith(bal: any, packs: any = PACKS): any {
  return { internAi: { [PROVIDER.id]: { balance: bal, packs } } };
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
console.log("窗口都满时，恢复时间退回批次的到期时间");

{
  const tomorrow = platformStamp(Date.now() + 24 * 3600_000);
  const packs = [{ ...PACKS[0], expireAt: tomorrow, cycleEndAt: tomorrow }];
  const at = internAiKind.recoverAt?.(PROVIDER, snapshotWith(balance(), packs)) ?? null;
  check("取批次最早到期的那个", at === platformMs(tomorrow), `${at} vs ${platformMs(tomorrow)}`);
}

console.log("");
console.log("平台说账号不可用，就不再往它发请求");

{
  const blocked = internAiKind.outOfCredits(PROVIDER, snapshotWith(balance({ accessStatus: 0 })));
  check("access_status = 0 → 当作没钱", blocked === true, String(blocked));

  const normal = internAiKind.outOfCredits(PROVIDER, snapshotWith(balance()));
  check("access_status = 1 且有余额 → 有钱", normal === false, String(normal));

  const legacy = balance();
  delete legacy.accessStatus;
  const legacyOut = internAiKind.outOfCredits(PROVIDER, snapshotWith(legacy));
  check("老数据没有 access_status → 不误判", legacyOut === false, String(legacyOut));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
