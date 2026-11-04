// test/quota-plugins-three-check.ts — 三家平台的额度插件：SenseNova、TokenRhythm、书生·端砚。
//
//   node --experimental-strip-types test/quota-plugins-three-check.ts
//
// 离线：上游是假的（globalThis.fetch 在这里被换掉），凭据是编的，数据库是临时
// 目录。一次请求都不出机器。
//
// 每家都按同一张表过一遍：拿到了是 ok（数字与旧口径逐字段相同）、上游说用尽是
// no_quota（带恢复时刻）、401/403 是 unauthorized、429 是 rate_limited、其它非
// 2xx 是 unknown；端砚另加 blocked（平台说这个账号不能用）。
//
// 「口径没变」的对照：三个 kind 的额度读法都搬进了插件，register 里不再有第二份
// 计算（具名桶已经删掉）。所以这里两边都走真的那条路：probe() 问一次得到结论，
// 把结论按 refreshOne 的位置放进插件桶，再用 kindOf(...).quotas() 读出来，逐字段
// 对一遍。下面每一条都另外钉住具体的数 —— 两边同时漂的话，「一样」是查不出来的。
//
// 平台行指名插件、以及迁移补默认值这两件事也在这里验：面板读得到数字的前提是
// 平台行与快照两边都到位。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-quota-plugins-three-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { addAccount } = await import("../lib/providers.ts");
// 种类与插件都是导入时登记的：导入它，它们才都在。
await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { allQuotaPlugins, quotaPluginOf } = await import("../lib/quota-plugins.ts");
const { senseNovaPoolsPlugin } = await import("../lib/sensenova/quota-plugin.ts");
const { tokenRhythmWalletPlugin } = await import("../lib/tokenrhythm/quota-plugin.ts");
const { internAiCreditsPlugin } = await import("../lib/intern-ai/quota-plugin.ts");
const { saveSession: saveSenseNovaSession } = await import("../lib/sensenova/auth.ts");
const {
  saveTokenRhythmCredential,
  saveSession: saveTokenRhythmSession,
} = await import("../lib/tokenrhythm/accounts.ts");
const { resetTokenRhythmStatusCache } = await import("../lib/tokenrhythm/wallet.ts");
const { saveSession: saveInternAiSession } = await import("../lib/intern-ai/auth.ts");

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

/** 深比较：键的顺序不算差别。 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => same(item, b[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join(",") !== kb.join(",")) return false;
  return ka.every((key) => same((a as any)[key], (b as any)[key]));
}

const NOW = Date.now();
const HOUR = 3600_000;
/** 平台按 UTC+8 报时间，不带时区。 */
function platformTime(ms: number): string {
  const shifted = new Date(ms + 8 * HOUR);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

/* ------------------------------------------------------------------ *
 * 三家的上游答复（形状照真的那样，值是编的）
 * ------------------------------------------------------------------ */

/** SenseNova 的积分池：一个通用池（有活动积分）+ 一个专属池。 */
const SENSE_POOLS_RAW = {
  plan: { id: "free", name: "Free Plan", type: "TOKEN_PLAN_PLAN_TYPE_FREE" },
  pools: [
    {
      id: "pool_general",
      name: "通用积分池",
      model_ids: ["deepseek-v4-flash", "sensenova-6.8-flash-lite"],
      window_5h: {
        limit: "60000",
        used: "1000",
        remaining: "59000",
        reset_at: String(Math.floor((NOW + HOUR) / 1000)),
      },
      window_7d: {
        limit: "600000",
        used: "10000",
        remaining: "590000",
        reset_at: String(Math.floor((NOW + 7 * 24 * HOUR) / 1000)),
      },
      grant_balance: "5000",
      nearest_grant_expiry: String(Math.floor((NOW + 30 * 24 * HOUR) / 1000)),
      nearest_grant_expiring_balance: "1200",
      pool_type: "default",
    },
    {
      id: "pool_lite",
      name: "Flash-Lite积分池",
      model_ids: ["sensenova-6.8-flash-lite"],
      window_5h: {
        limit: "60000",
        used: "0",
        remaining: "60000",
        reset_at: String(Math.floor((NOW + HOUR) / 1000)),
      },
      window_7d: {
        limit: "600000",
        used: "0",
        remaining: "600000",
        reset_at: String(Math.floor((NOW + 7 * 24 * HOUR) / 1000)),
      },
      grant_balance: "0",
      nearest_grant_expiry: "0",
      nearest_grant_expiring_balance: "0",
      pool_type: "dedicated",
    },
  ],
};

/** 两个池子都空了。 */
const SENSE_POOLS_DRAINED_RAW = {
  ...SENSE_POOLS_RAW,
  pools: SENSE_POOLS_RAW.pools.map((pool) => ({
    ...pool,
    window_5h: { ...pool.window_5h, remaining: "0" },
    window_7d: { ...pool.window_7d, remaining: "0" },
    grant_balance: "0",
  })),
};

/** 书生·端砚的墨点余额。 */
const INTERN_BALANCE_RAW = {
  access_status: 1,
  rpm_limit: 50,
  decision_rpm_limit: 200,
  tpm_limit: 2000000,
  available_credits: "1.698000",
  active_package_count: 1,
  usage_windows: {
    "5h": {
      enabled: true,
      limit_credits: "10.000000",
      used_credits: "0.249000",
      remaining_credits: "9.751000",
      next_recover_at: platformTime(NOW + 5 * HOUR),
    },
    "7d": {
      enabled: true,
      limit_credits: "70.000000",
      used_credits: "0.249000",
      remaining_credits: "69.751000",
      next_recover_at: platformTime(NOW + 7 * 24 * HOUR),
    },
  },
  used: 8.302,
  calculated_at: platformTime(NOW),
};

/** 墨点没了（平台给的样子）。 */
const INTERN_BALANCE_DRAINED_RAW = { ...INTERN_BALANCE_RAW, available_credits: "0" };

/** 平台说这个账号不能用。 */
const INTERN_BALANCE_BLOCKED_RAW = { ...INTERN_BALANCE_RAW, access_status: 0 };

/** 墨点批次。 */
const INTERN_PACKS_RAW = {
  packages: [
    {
      pkg_id: "pkg_free_monthly_base",
      issued_at: platformTime(NOW - 24 * HOUR),
      cycle_type: "monthly",
      current_cycle: { start_at: platformTime(NOW - 24 * HOUR), end_at: platformTime(NOW + 6 * 24 * HOUR) },
      total_credits: "10.000000",
      remaining_credits: "1.698000",
      status: "available",
      income_expense_type: "platform_grant",
      remark: "每月免费基础包",
      effective_at: platformTime(NOW - 24 * HOUR),
      expire_at: "2099-12-31 00:00:00",
    },
  ],
};

/** TokenRhythm 的钱包：赠金两批，一批先到期。 */
const TW_EARLY = new Date(NOW + 2 * 24 * HOUR).toISOString();
const TW_LATE = new Date(NOW + 9 * 24 * HOUR).toISOString();
const TW_SUMMARY_RAW = {
  currency: "CNY",
  availableBalanceCny: 18.5,
  giftAvailableCny: 18.5,
  rechargeBalanceCny: 0,
  giftTotalCny: 20,
  giftStatus: "ACTIVE",
  asOf: new Date(NOW).toISOString(),
};
const TW_CREDITS_RAW = {
  summary: { expiringBalanceCny: 18.5, nextExpiryAt: TW_EARLY },
  list: [
    { id: "gift-a", source: "gift", sourceLabel: "新人赠金", remainingCny: 10, expiresAt: TW_EARLY, status: "active" },
    { id: "gift-b", source: "gift", sourceLabel: "活动赠金", remainingCny: 8.5, expiresAt: TW_LATE, status: "active" },
  ],
};
const TW_DRAINED_SUMMARY_RAW = { ...TW_SUMMARY_RAW, availableBalanceCny: 0, giftAvailableCny: 0 };

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 每一家这一轮怎么答：ok / drained / blocked / 401 / 403 / 429 / 500 / net。 */
const mode: Record<string, string> = { sensenova: "ok", tokenrhythm: "ok", intern: "ok" };
/** 假上游被问了几次（`missing` 不该去问）。 */
const calls: Record<string, number> = { sensenova: 0, tokenrhythm: 0, intern: 0 };

function answer(platform: string, body: unknown): Response {
  switch (mode[platform]) {
    case "401":
      return new Response("{}", { status: 401 });
    case "403":
      return new Response("{}", { status: 403 });
    case "429":
      return new Response(JSON.stringify({ message: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "42" },
      });
    case "500":
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    case "net":
      throw new TypeError("fetch failed");
    default:
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
}

globalThis.fetch = (async (input: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? ""));
  const route = new URL(url).pathname;
  if (route.endsWith("/lite/console/v1/tokenplan/pool-usage")) {
    calls.sensenova++;
    const drained = mode.sensenova === "drained";
    return answer("sensenova", drained ? SENSE_POOLS_DRAINED_RAW : SENSE_POOLS_RAW);
  }
  if (route.endsWith("/api/tokenplan/v1/credits/balance")) {
    calls.intern++;
    const body =
      mode.intern === "drained"
        ? INTERN_BALANCE_DRAINED_RAW
        : mode.intern === "blocked"
          ? INTERN_BALANCE_BLOCKED_RAW
          : INTERN_BALANCE_RAW;
    return answer("intern", { code: 0, msg: "ok", data: body });
  }
  if (route.endsWith("/api/tokenplan/v1/credits/packages")) {
    calls.intern++;
    return answer("intern", { code: 0, msg: "ok", data: INTERN_PACKS_RAW });
  }
  if (route.endsWith("/api/wallet/summary")) {
    calls.tokenrhythm++;
    return answer("tokenrhythm", { code: 0, data: mode.tokenrhythm === "drained" ? TW_DRAINED_SUMMARY_RAW : TW_SUMMARY_RAW });
  }
  if (route.endsWith("/api/wallet/expiring-credits")) {
    calls.tokenrhythm++;
    return answer("tokenrhythm", { code: 0, data: TW_CREDITS_RAW });
  }
  throw new Error(`这个测试只认假上游：${url}`);
}) as typeof fetch;

/* ------------------------------------------------------------------ *
 * 账号行与凭据（编的）
 * ------------------------------------------------------------------ */

function accountOf(platform: string, alias: string): any {
  const made = addAccount({ platform, alias });
  if (!made.ok) throw new Error(made.message);
  return { row: made.id as string };
}

const senseAccount = accountOf("sensenova", "SenseNova 插件测试账号");
const twAccount = accountOf("tokenrhythm", "TokenRhythm 插件测试账号");
const internAccount = accountOf("intern-ai", "端砚插件测试账号");

const { provider } = await import("../lib/providers.ts");
const senseRow = provider(senseAccount.row)!;
const twRow = provider(twAccount.row)!;
const internRow = provider(internAccount.row)!;

/** 一组额度，去掉两个「这一条是谁的」的 id。 */
function stripIds(views: any[]): any[] {
  return views.map(({ upstreamId, accountId, ...rest }) => rest);
}

/** 快照里那一家的一份额度：插件 id → 账号 id → 那一次的结论（与 refreshOne 存的位置一样）。 */
function snapshotWithProbe(pluginId: string, accountId: string, probe: any): any {
  return { plugins: { [pluginId]: { [accountId]: probe } } };
}

function senseSession(): void {
  saveSenseNovaSession(
    {
      cookie: "oauth2=cookie",
      accessToken: "access-token-for-test",
      refreshToken: "refresh-token-for-test",
      expiresAtMs: Date.now() + HOUR,
      obtainedAtMs: Date.now(),
      username: "tester",
    },
    senseRow.id,
  );
}

function internSession(): void {
  saveInternAiSession(
    {
      sites: [
        { name: "discovery", token: "discovery-token-for-test", clientId: "cid-discovery" },
        { name: "chat", token: "chat-token-for-test", clientId: "cid-chat" },
      ],
      ssoUid: "1",
      obtainedAtMs: Date.now(),
      username: "tester",
    },
    internRow.id,
  );
}

function twSession(): void {
  saveTokenRhythmCredential(twRow.id, { account: "tester", password: "pw-for-test", apiKey: "key-for-test" });
  saveTokenRhythmSession({
    accountId: twRow.id,
    cookie: "PHPSESSID=cookie-for-test",
    csrf: "csrf-for-test",
    userId: "1",
    name: "tester",
    obtainedAtMs: Date.now(),
    expiresAtMs: Date.now() + 24 * HOUR,
  });
}

/**
 * 问一次 TokenRhythm 的钱包。
 *
 * 账号表是缓存下来的（路由读的是同一份数，几分钟内复用）。换一种上游答复之前把
 * 缓存扔掉 —— 那与等五分钟是同一件事，测试不该真等。
 */
async function probeWallet(row: any) {
  resetTokenRhythmStatusCache(row.id);
  return tokenRhythmWalletPlugin.probe(row);
}

/* ------------------------------------------------------------------ *
 * 登记
 * ------------------------------------------------------------------ */

section("登记");

check("SenseNova 的插件登记了", quotaPluginOf("sensenova-pools") === senseNovaPoolsPlugin);
check("TokenRhythm 的插件登记了", quotaPluginOf("tokenrhythm-wallet") === tokenRhythmWalletPlugin);
check("端砚的插件登记了", quotaPluginOf("intern-ai-credits") === internAiCreditsPlugin);
check(
  "全部插件里有这三家",
  ["sensenova-pools", "tokenrhythm-wallet", "intern-ai-credits"].every((id) =>
    allQuotaPlugins().some((plugin) => plugin.id === id),
  ),
  allQuotaPlugins().map((plugin) => plugin.id).join(","),
);
check("三家都不要额外的凭据段（查额度用的是登录换来的会话）", [
  senseNovaPoolsPlugin.fields.length,
  tokenRhythmWalletPlugin.fields.length,
  internAiCreditsPlugin.fields.length,
].every((n) => n === 0));
check("插件都有给人看的名字", [senseNovaPoolsPlugin.label, tokenRhythmWalletPlugin.label, internAiCreditsPlugin.label].every((l) => l.length > 0));

/* ------------------------------------------------------------------ *
 * SenseNova
 * ------------------------------------------------------------------ */

section("SenseNova 的积分池");

senseSession();
mode.sensenova = "ok";
const senseOK = await senseNovaPoolsPlugin.probe(senseRow);
check("问到了 → ok", senseOK.state === "ok", JSON.stringify(senseOK));
check("问了一次控制台", calls.sensenova === 1, String(calls.sensenova));
check("报一个额度", senseOK.views.length === 1, JSON.stringify(senseOK.views));
check(
  "活动积分是两池之和（只有通用池有）",
  senseOK.views[0]?.credits?.remaining === 5000,
  String(senseOK.views[0]?.credits?.remaining),
);
check("两个池子各报一个窗口", senseOK.views[0]?.tokenPlan?.windows?.length === 2, JSON.stringify(senseOK.views[0]?.tokenPlan));
check("没有到期时刻也算 ok", senseOK.recoverAt === null, String(senseOK.recoverAt));

// 口径没变：插件桶里那一份经 kind 出来还是这些数。
const senseSnapshot = snapshotWithProbe(senseNovaPoolsPlugin.id, senseRow.id, senseOK);
const senseKindViews = kindOf("sensenova")!.quotas(senseRow, senseSnapshot);
check("插件那一份经 kind 出来与 probe 逐字段相同", same(senseKindViews, senseOK.views), JSON.stringify(senseKindViews));
check(
  "活动积分还是 5000、两个窗口",
  senseKindViews[0]?.credits?.remaining === 5000 && senseKindViews[0]?.tokenPlan?.windows?.length === 2,
  JSON.stringify(senseKindViews[0]),
);
check("ok 不算见底", kindOf("sensenova")!.outOfCredits(senseRow, senseSnapshot) === false);
check("ok 没有恢复时刻", (kindOf("sensenova")!.recoverAt?.(senseRow, senseSnapshot) ?? null) === null);

mode.sensenova = "drained";
const senseDrained = await senseNovaPoolsPlugin.probe(senseRow);
check("两个池子都空了 → no_quota", senseDrained.state === "no_quota", JSON.stringify(senseDrained));
check("见底不给数字（面板上只有那句话）", senseDrained.views.length === 0, JSON.stringify(senseDrained.views));
check("见底有恢复时刻", typeof senseDrained.recoverAt === "number", String(senseDrained.recoverAt));
check(
  "恢复时刻取见底窗口里最晚的那个重置点（7 天窗口）",
  Math.abs((senseDrained.recoverAt ?? 0) - (NOW + 7 * 24 * HOUR)) < 5000,
  String(senseDrained.recoverAt),
);
check("见底那句话说了用尽", senseDrained.message.includes("用尽"), senseDrained.message);
const senseDrainedSnapshot = snapshotWithProbe(senseNovaPoolsPlugin.id, senseRow.id, senseDrained);
check("见底的结论 → kind 也说见底", kindOf("sensenova")!.outOfCredits(senseRow, senseDrainedSnapshot) === true);
check(
  "见底的恢复时刻照结论",
  (kindOf("sensenova")!.recoverAt?.(senseRow, senseDrainedSnapshot) ?? null) === senseDrained.recoverAt,
  String(senseDrained.recoverAt),
);

mode.sensenova = "401";
const senseUnauthorized = await senseNovaPoolsPlugin.probe(senseRow);
check("401 → unauthorized", senseUnauthorized.state === "unauthorized", JSON.stringify(senseUnauthorized));
check("401 不给数字", senseUnauthorized.views.length === 0);

mode.sensenova = "403";
const senseForbidden = await senseNovaPoolsPlugin.probe(senseRow);
check("403 → unauthorized", senseForbidden.state === "unauthorized", JSON.stringify(senseForbidden));

senseSession();
mode.sensenova = "429";
const senseRate = await senseNovaPoolsPlugin.probe(senseRow);
check("429 → rate_limited", senseRate.state === "rate_limited", JSON.stringify(senseRate));
check(
  "429 的恢复时刻按 retry-after 换算（42 秒）",
  typeof senseRate.recoverAt === "number" && Math.abs(senseRate.recoverAt - (Date.now() + 42_000)) < 5000,
  String(senseRate.recoverAt),
);

mode.sensenova = "500";
const senseUnknown = await senseNovaPoolsPlugin.probe(senseRow);
check("500 → unknown", senseUnknown.state === "unknown", JSON.stringify(senseUnknown));
check("unknown 的那句话写了是哪一种（HTTP 500）", senseUnknown.message.includes("500"), senseUnknown.message);

mode.sensenova = "net";
const senseNet = await senseNovaPoolsPlugin.probe(senseRow);
check("连不上 → unknown", senseNet.state === "unknown", JSON.stringify(senseNet));
check("连不上的那句话说了连不上", senseNet.message.includes("连不上"), senseNet.message);

mode.sensenova = "ok";
const { clearSession: clearSenseSession } = await import("../lib/sensenova/auth.ts");
clearSenseSession(senseRow.id);
const senseNoBefore = calls.sensenova;
const senseMissing = await senseNovaPoolsPlugin.probe(senseRow);
check("没有会话 → missing", senseMissing.state === "missing", JSON.stringify(senseMissing));
check("没有会话就不去问", calls.sensenova === senseNoBefore, String(calls.sensenova));

/* ------------------------------------------------------------------ *
 * TokenRhythm
 * ------------------------------------------------------------------ */

section("TokenRhythm 的钱包");

twSession();
mode.tokenrhythm = "ok";
const twOK = await probeWallet(twRow);
check("问到了 → ok", twOK.state === "ok", JSON.stringify(twOK));
check("报一个余额", twOK.views.length === 1, JSON.stringify(twOK.views));
check("余额是钱包里的那个数", twOK.views[0]?.balance?.availableCny === 18.5, String(twOK.views[0]?.balance?.availableCny));
check("两批赠金", twOK.views[0]?.balance?.lots?.length === 2, JSON.stringify(twOK.views[0]?.balance?.lots));
check("额度挂在账号上", twOK.views[0]?.accountId === twRow.id, String(twOK.views[0]?.accountId));

const twSnapshot = snapshotWithProbe(tokenRhythmWalletPlugin.id, twRow.id, twOK);
const twKindViews = kindOf("tokenrhythm")!.quotas(twRow, twSnapshot);
// 两个 id 不比：插件那一份写的是平台（钱包挂平台），kind 读的时候一律按账号写
// （与开放平台同一条规矩，面板靠 accountId 分清是哪一条余额）。
check(
  "插件那一份经 kind 出来与 probe 逐字段相同（两个 id 除外）",
  same(stripIds(twKindViews), stripIds(twOK.views)),
  JSON.stringify(twKindViews),
);
check(
  "余额还是钱包里的 18.5、两批赠金",
  twKindViews[0]?.balance?.availableCny === 18.5 && twKindViews[0]?.balance?.lots?.length === 2,
  JSON.stringify(twKindViews[0]),
);
check("额度挂在账号上", twKindViews[0]?.accountId === twRow.id, String(twKindViews[0]?.accountId));
check("有钱不算见底", kindOf("tokenrhythm")!.outOfCredits(twRow, twSnapshot) === false);

mode.tokenrhythm = "drained";
const twDrained = await probeWallet(twRow);
check("钱空了 → no_quota", twDrained.state === "no_quota", JSON.stringify(twDrained));
check("见底不给数字", twDrained.views.length === 0, JSON.stringify(twDrained.views));
check(
  "恢复时刻取最先到期的那批赠金",
  twDrained.recoverAt === Date.parse(TW_EARLY),
  `${twDrained.recoverAt} / ${Date.parse(TW_EARLY)}`,
);
check("见底那句话说了见底", twDrained.message.includes("见底"), twDrained.message);

twSession();
mode.tokenrhythm = "401";
const twUnauthorized = await probeWallet(twRow);
check("401 → unauthorized", twUnauthorized.state === "unauthorized", JSON.stringify(twUnauthorized));

twSession();
mode.tokenrhythm = "429";
const twRate = await probeWallet(twRow);
check("429 → rate_limited", twRate.state === "rate_limited", JSON.stringify(twRate));
check(
  "429 的恢复时刻按 retry-after 换算（42 秒）",
  typeof twRate.recoverAt === "number" && Math.abs(twRate.recoverAt - (Date.now() + 42_000)) < 5000,
  String(twRate.recoverAt),
);

mode.tokenrhythm = "500";
const twUnknown = await probeWallet(twRow);
check("500 → unknown", twUnknown.state === "unknown", JSON.stringify(twUnknown));

mode.tokenrhythm = "net";
const twNet = await probeWallet(twRow);
check("连不上 → unknown", twNet.state === "unknown", JSON.stringify(twNet));

// 没有账号密码：那是「还没填」，不是平台拒了。
const twBare = accountOf("tokenrhythm", "TokenRhythm 空账号");
const twBareRow = provider(twBare.row)!;
const twMissing = await probeWallet(twBareRow);
check("没有账号密码 → missing", twMissing.state === "missing", JSON.stringify(twMissing));
check("没有账号密码 → 没有钱包视图", twMissing.views.length === 0, JSON.stringify(twMissing.views));

/* ------------------------------------------------------------------ *
 * 书生·端砚
 * ------------------------------------------------------------------ */

section("书生·端砚的墨点");

internSession();
mode.intern = "ok";
const internOK = await internAiCreditsPlugin.probe(internRow);
check("问到了 → ok", internOK.state === "ok", JSON.stringify(internOK));
check("报一个额度", internOK.views.length === 1, JSON.stringify(internOK.views));
check("余额是平台报的那个数", internOK.views[0]?.credits?.remaining === 1.698, String(internOK.views[0]?.credits?.remaining));
check("一个批次报一条", internOK.views[0]?.credits?.lots?.length === 1, JSON.stringify(internOK.views[0]?.credits?.lots));
check("两个窗口都报了", internOK.views[0]?.tokenPlan?.windows?.length === 1, JSON.stringify(internOK.views[0]?.tokenPlan));

const internSnapshot = snapshotWithProbe(internAiCreditsPlugin.id, internRow.id, internOK);
const internKindViews = kindOf("intern-ai")!.quotas(internRow, internSnapshot);
check("插件那一份经 kind 出来与 probe 逐字段相同", same(internKindViews, internOK.views), JSON.stringify(internKindViews));
check(
  "墨点还是 1.698、一个批次、一个窗口",
  internKindViews[0]?.credits?.remaining === 1.698 &&
    internKindViews[0]?.credits?.lots?.length === 1 &&
    internKindViews[0]?.tokenPlan?.windows?.length === 1,
  JSON.stringify(internKindViews[0]),
);
check("墨点还没用完 → 不算见底", kindOf("intern-ai")!.outOfCredits(internRow, internSnapshot) === false);

mode.intern = "drained";
const internDrained = await internAiCreditsPlugin.probe(internRow);
check("墨点没了 → no_quota", internDrained.state === "no_quota", JSON.stringify(internDrained));
check("见底不给数字", internDrained.views.length === 0, JSON.stringify(internDrained.views));
check("见底有恢复时刻", typeof internDrained.recoverAt === "number", String(internDrained.recoverAt));

mode.intern = "blocked";
const internBlocked = await internAiCreditsPlugin.probe(internRow);
check("access_status != 1 → blocked", internBlocked.state === "blocked", JSON.stringify(internBlocked));
check("blocked 不是 no_quota（两种原因，两句话）", internBlocked.state !== "no_quota");
check("blocked 那句话说的是账号不能用", internBlocked.message.includes("access_status"), internBlocked.message);
check("blocked 不给数字", internBlocked.views.length === 0, JSON.stringify(internBlocked.views));
check("blocked 有恢复时刻（两个窗口自己说的）", typeof internBlocked.recoverAt === "number", String(internBlocked.recoverAt));

internSession();
mode.intern = "401";
const internUnauthorized = await internAiCreditsPlugin.probe(internRow);
check("401 → unauthorized", internUnauthorized.state === "unauthorized", JSON.stringify(internUnauthorized));

internSession();
mode.intern = "429";
const internRate = await internAiCreditsPlugin.probe(internRow);
check("429 → rate_limited", internRate.state === "rate_limited", JSON.stringify(internRate));
check(
  "429 的恢复时刻按 retry-after 换算（42 秒）",
  typeof internRate.recoverAt === "number" && Math.abs(internRate.recoverAt - (Date.now() + 42_000)) < 5000,
  String(internRate.recoverAt),
);

mode.intern = "500";
const internUnknown = await internAiCreditsPlugin.probe(internRow);
check("500 → unknown", internUnknown.state === "unknown", JSON.stringify(internUnknown));

mode.intern = "net";
const internNet = await internAiCreditsPlugin.probe(internRow);
check("连不上 → unknown", internNet.state === "unknown", JSON.stringify(internNet));

const { clearSession: clearInternSession } = await import("../lib/intern-ai/auth.ts");
clearInternSession(internRow.id);
const internNoBefore = calls.intern;
const internMissing = await internAiCreditsPlugin.probe(internRow);
check("没有会话 → missing", internMissing.state === "missing", JSON.stringify(internMissing));
check("没有会话就不去问", calls.intern === internNoBefore, String(calls.intern));

/* ------------------------------------------------------------------ *
 * 平台行的默认插件（迁移）
 * ------------------------------------------------------------------ */

section("平台行的默认插件");

const { store, migratePlatformQuotaPlugins } = await import("../lib/store.ts");
const { openPlatformOf } = await import("../lib/open-platforms.ts");
const db = store();

/** 表里那一行现在指的插件。 */
function pluginOf(id: string): string {
  return openPlatformOf(id)?.quotaPlugin ?? "<没有这一行>";
}

/** 三家的插件与写入时刻，用来验「再跑一次什么都不变」。 */
function pluginRows(): string {
  const rows = db
    .prepare("SELECT id, quota_plugin, updated_at FROM platform WHERE id IN ('sensenova','intern-ai','tokenrhythm') ORDER BY id")
    .all() as any[];
  return JSON.stringify(rows.map((row) => [row.id, row.quota_plugin, Number(row.updated_at)]));
}

// 模拟老库：三行都在，插件是空的（模板补进表时还不带插件）。
const blank = db.prepare(
  "UPDATE platform SET quota_plugin = '' WHERE id IN ('sensenova','intern-ai','tokenrhythm')",
);
blank.run();
check("清空之后三家都是空的", [pluginOf("sensenova"), pluginOf("intern-ai"), pluginOf("tokenrhythm")].every((id) => id === ""), JSON.stringify([pluginOf("sensenova"), pluginOf("intern-ai"), pluginOf("tokenrhythm")]));

migratePlatformQuotaPlugins(db);
check(
  "空着的补上默认值",
  pluginOf("sensenova") === "sensenova-pools" &&
    pluginOf("intern-ai") === "intern-ai-credits" &&
    pluginOf("tokenrhythm") === "tokenrhythm-wallet",
  JSON.stringify([pluginOf("sensenova"), pluginOf("intern-ai"), pluginOf("tokenrhythm")]),
);

// 用户自己选过的插件不能被启动时的迁移改掉。
db.prepare("UPDATE platform SET quota_plugin = ? WHERE id = 'sensenova'").run("qiniu-portal");
migratePlatformQuotaPlugins(db);
check("已选的不覆盖", pluginOf("sensenova") === "qiniu-portal", pluginOf("sensenova"));
check("没选过的照旧是默认值", pluginOf("tokenrhythm") === "tokenrhythm-wallet", pluginOf("tokenrhythm"));

const before = pluginRows();
migratePlatformQuotaPlugins(db);
check("再跑一次不变（连写入时刻都不动）", pluginRows() === before, `${before} / ${pluginRows()}`);

// 后面那一段要三家都指着自己的插件。
blank.run();
migratePlatformQuotaPlugins(db);
check("恢复成默认值", pluginOf("sensenova") === "sensenova-pools" && pluginOf("intern-ai") === "intern-ai-credits");

/* ------------------------------------------------------------------ *
 * refreshOne 走插件
 * ------------------------------------------------------------------ */

section("刷新快照时走的是插件");

const { refreshHealthSnapshot } = await import("../lib/admin/upstreams.ts");
const { peekHealthSnapshot } = await import("../lib/health-cache.ts");

// 三家都答「问到了」：这一轮的份才写得进去。会话先补回来（上面有几段清过）。
senseSession();
internSession();
twSession();
mode.sensenova = "ok";
mode.tokenrhythm = "ok";
mode.intern = "ok";
resetTokenRhythmStatusCache(twRow.id);

const beforeCalls = { ...calls };
await refreshHealthSnapshot();
const snapshot = peekHealthSnapshot<any>()?.data ?? null;

check(
  // 一次 probe 不一定是发一个请求（令牌、钱包、批次各一个）：只要还是「问到了
  // 东西」就说明这一轮确实走到了插件，而不是照旧去读具名桶。
  "三家都被问了（走的是插件，不是具名桶）",
  calls.sensenova > beforeCalls.sensenova &&
    calls.tokenrhythm > beforeCalls.tokenrhythm &&
    calls.intern > beforeCalls.intern,
  JSON.stringify({ beforeCalls, calls }),
);
check(
  "SenseNova 的份在 plugins[sensenova-pools][账号]",
  snapshot?.plugins?.["sensenova-pools"]?.[senseRow.id]?.state === "ok",
  JSON.stringify(snapshot?.plugins?.["sensenova-pools"]),
);
check(
  "TokenRhythm 的份在 plugins[tokenrhythm-wallet][账号]",
  snapshot?.plugins?.["tokenrhythm-wallet"]?.[twRow.id]?.state === "ok",
  JSON.stringify(snapshot?.plugins?.["tokenrhythm-wallet"]),
);
check(
  "端砚的份在 plugins[intern-ai-credits][账号]",
  snapshot?.plugins?.["intern-ai-credits"]?.[internRow.id]?.state === "ok",
  JSON.stringify(snapshot?.plugins?.["intern-ai-credits"]),
);
check(
  "三家都不再写真名桶",
  snapshot?.sensenova === undefined && snapshot?.internAi === undefined && snapshot?.tokenrhythm === undefined,
  JSON.stringify(Object.keys(snapshot ?? {})),
);
check(
  "面板那条路读得到数字",
  (kindOf("sensenova")!.quotas(senseRow, snapshot)[0]?.credits?.remaining ?? 0) === 5000 &&
    (kindOf("tokenrhythm")!.quotas(twRow, snapshot)[0]?.balance?.availableCny ?? 0) === 18.5,
  JSON.stringify({
    sensenova: kindOf("sensenova")!.quotas(senseRow, snapshot),
    tokenrhythm: kindOf("tokenrhythm")!.quotas(twRow, snapshot),
  }),
);

/* ------------------------------------------------------------------ *
 * probe 从不 reject
 * ------------------------------------------------------------------ */

section("probe 从不 reject");

mode.sensenova = "net";
mode.tokenrhythm = "net";
mode.intern = "net";
for (const plugin of [senseNovaPoolsPlugin, tokenRhythmWalletPlugin, internAiCreditsPlugin]) {
  const row = plugin === senseNovaPoolsPlugin ? senseRow : plugin === tokenRhythmWalletPlugin ? twRow : internRow;
  // 上一段把会话清掉了：翻成 missing 也行，reject 不行。
  let threw = false;
  try {
    await plugin.probe(row);
  } catch {
    threw = true;
  }
  check(`${plugin.id} 没抛`, threw === false);
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log(`pass=${pass} fail=${fail}`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
