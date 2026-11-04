// test/qiniu-check.ts — 七牛云：门户的资源包怎么读、面板上看到什么、平台登记得对不对。
//
//   node --experimental-strip-types test/qiniu-check.ts
//
// 离线：不问门户，也不问推理端点。回答的形状照门户真的那样，值是编的。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 临时目录走系统的 tmpdir：写死的 /tmp 在 Windows 上落到当前盘的根上，
// 而且两次运行会撞在同一个目录上。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-qiniu-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { parseRespackOverview } = await import("../lib/qiniu/quota.ts");
const { qiniuQuotaPlugin, qiniuQuotas } = await import("../lib/qiniu/quota-plugin.ts");
const { cooldownUntil, listCooldowns } = await import("../lib/cooldown.ts");
const { writeQiniuAccount } = await import("../lib/qiniu/account.ts");
const { kindOf, policiesOfKind } = await import("../lib/provider-kinds.ts");
// 种类登记在注册表里：导入它，种类才都在。
await import("../lib/kinds/index.ts");
const { platformOfAny } = await import("../lib/platforms.ts");
const { updateOpenPlatform } = await import("../lib/open-platforms.ts");
const { addAccount, provider: providerRow } = await import("../lib/providers.ts");
const { refreshHealthSnapshot } = await import("../lib/admin/upstreams.ts");
const { quotaConclusionOf } = await import("../lib/quota-state.ts");
const { peekHealthSnapshot } = await import("../lib/health-cache.ts");

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

/* ------------------------------------------------------------------ *
 * 门户的回答（形状照真的那样，值是编的）
 * ------------------------------------------------------------------ */

const OVERVIEW = {
  code: 200,
  message: "success",
  data: {
    records: [
      {
        item_code: "respack-general",
        item_name: "通用资源包",
        zone_name: "华东",
        total_surplus: "10000",
        month_used: "7000",
        month_remain: "3000",
        respack_unit: "k/tokens",
        update_time: 1767225600,
      },
      {
        item_code: "respack-multimodal",
        item_name: "多模态资源包",
        zone_name: "华北",
        total_surplus: "5000",
        month_used: "3000",
        month_remain: "2000",
        respack_unit: "k/tokens",
        update_time: 1767225600,
      },
    ],
  },
};

const PROVIDER = {
  id: "qiniu-test",
  platform: "qiniu",
  kind: "qiniu",
  region: "",
  alias: "七牛云测试账号",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;

/**
 * 一个只带七牛云的快照。别的家是空的。
 *
 * 七牛的额度没有具名桶：它在插件桶里（插件 id → 账号 id → 那一份）。
 */
function snapshotWith(quota: unknown): any {
  return {
    qoder: {},
    minimax: {},
    zcode: {},
    workbuddy: {},
    tokenrhythm: {},
    sensenova: {},
    internAi: {},
    plugins: { [qiniuQuotaPlugin.id]: { [PROVIDER.id]: quota } },
  };
}

/** 快照里那个额度：读出来的那两个包。 */
const QUOTA = { respacks: parseRespackOverview(OVERVIEW), at: Date.now() };

/**
 * 快照里那一份：插件在 ok 的时候给的那一种。
 *
 * 快照存的是结论（状态 + 面板那几行），不是门户的原样答复：怎么读答复是插件的事，
 * 读完了才写进快照。
 */
function okProbe(quota: unknown): any {
  return { state: "ok", views: qiniuQuotas(PROVIDER, quota), recoverAt: null, message: "" };
}

/* ------------------------------------------------------------------ *
 * 门户的回答怎么读
 * ------------------------------------------------------------------ */

section("资源包");

const packs = parseRespackOverview(OVERVIEW);
check("读出两个包", packs.length === 2, String(packs.length));
check(
  "第一个包的名字与地区",
  packs[0]?.itemName === "通用资源包" && packs[0]?.zoneName === "华东",
  `${packs[0]?.itemName} · ${packs[0]?.zoneName}`,
);
check("第一个包的编号", packs[0]?.itemCode === "respack-general", String(packs[0]?.itemCode));
check("第一个包剩 3000", packs[0]?.remaining === 3000, String(packs[0]?.remaining));
check("第二个包剩 2000", packs[1]?.remaining === 2000, String(packs[1]?.remaining));
check("单位是 k/tokens", packs[0]?.unit === "k/tokens", String(packs[0]?.unit));
check("总额是 10000", packs[0]?.total === 10000, String(packs[0]?.total));
check("已用是 7000", packs[0]?.used === 7000, String(packs[0]?.used));
check(
  "更新时刻从秒变成毫秒",
  packs[0]?.updateTime === 1767225600 * 1000,
  String(packs[0]?.updateTime),
);

section("坏数据");

check(
  "门户说不是 200 → 没有包",
  parseRespackOverview({ ...OVERVIEW, code: 500 }).length === 0,
  JSON.stringify(parseRespackOverview({ ...OVERVIEW, code: 500 }).length),
);
check("没有 records → 没有包", parseRespackOverview({ code: 200, data: {} }).length === 0);
check("records 不是数组 → 没有包", parseRespackOverview({ code: 200, data: { records: "x" } }).length === 0);
check("整个回答是空的 → 没有包", parseRespackOverview(null).length === 0);
const dirty = parseRespackOverview({
  code: 200,
  data: { records: [null, 7, { item_code: "x", item_name: "y", month_remain: "10" }] },
});
check("坏行被丢掉，好行留下", dirty.length === 1 && dirty[0]?.remaining === 10, JSON.stringify(dirty));
check(
  "字符串的量转成数字",
  typeof parseRespackOverview(OVERVIEW)[0]?.remaining === "number",
  typeof parseRespackOverview(OVERVIEW)[0]?.remaining,
);

/* ------------------------------------------------------------------ *
 * 面板上看到的额度
 * ------------------------------------------------------------------ */

section("额度");

// 额度只在平台那一行指名了插件的时候才读得出来。
const named = updateOpenPlatform("qiniu", { quotaPlugin: qiniuQuotaPlugin.id });
check("平台行指名了插件", named.ok === true, named.message);

const kind = kindOf("qiniu");
const views = kind?.quotas(PROVIDER, snapshotWith(okProbe(QUOTA))) ?? [];
const credits = views[0]?.credits;
check("报一个额度", views.length === 1, String(views.length));
check("两个包报成两条", credits?.lots?.length === 2, String(credits?.lots?.length));
check("剩下的是两个包之和", credits?.remaining === 5000, String(credits?.remaining));
check("总额也是之和", credits?.total === 15000, String(credits?.total));
check("已用也是之和", credits?.used === 10000, String(credits?.used));
check("说明里写着资源包", String(credits?.note ?? "").includes("资源包"), String(credits?.note));
check("说明里写着剩多少", String(credits?.note ?? "").includes("5000"), String(credits?.note));
check(
  "一条 lot 的编号是包与地区",
  credits?.lots?.[0]?.id === "respack-general@华东",
  String(credits?.lots?.[0]?.id),
);
check(
  "一条 lot 的名字带着单位",
  String(credits?.lots?.[0]?.sourceLabel ?? "").includes("k/tokens"),
  String(credits?.lots?.[0]?.sourceLabel),
);
check("资源包没有到期时间", credits?.lots?.[0]?.expiresAt === 0, String(credits?.lots?.[0]?.expiresAt));

section("用尽了吗");

/** 两个包都空了：门户说的一点不剩。 */
const EMPTY_PROBE = { state: "no_quota", views: [], recoverAt: null, message: "资源包全部用尽" };
check("两个包都空了 → 用尽", kind?.outOfCredits(PROVIDER, snapshotWith(EMPTY_PROBE)) === true);
check(
  "还有一个包有剩 → 没用尽",
  kind?.outOfCredits(PROVIDER, snapshotWith(okProbe(QUOTA))) === false,
);
check(
  "没填门户 cookie（missing）→ 不知道，不算用尽",
  kind?.outOfCredits(PROVIDER, snapshotWith({ state: "missing", views: [], recoverAt: null, message: "" })) === false,
);
check(
  "快照里没有这一份 → 不知道，不算用尽",
  kind?.outOfCredits(PROVIDER, snapshotWith(null)) === false,
);
// 见底不是「还剩 0」：数字全 0 的占位行在说「额度是 0」。用尽这件事由结论的
// 状态与一句话说（lib/quota-state.ts 的 quotaConclusionOf，面板上那三格）。
const emptyViews = kind?.quotas(PROVIDER, snapshotWith(EMPTY_PROBE)) ?? [];
check("见底没有额度视图", emptyViews.length === 0, JSON.stringify(emptyViews));
check(
  "见底的那句话在结论里（说的是「用尽」）",
  String(quotaConclusionOf(PROVIDER, snapshotWith(EMPTY_PROBE), "qiniu").message).includes("用尽"),
  JSON.stringify(quotaConclusionOf(PROVIDER, snapshotWith(EMPTY_PROBE), "qiniu")),
);

section("没指名插件时是不知道");

// 用户还没在面板上选插件：不是「没有资源包」，是「没去问」。
const cleared = updateOpenPlatform("qiniu", { quotaPlugin: "" });
check("插件清掉了", cleared.ok === true, cleared.message);
// 快照里那份数据还在，但没被指名就不该被读成额度 —— 问都没问过，
// 读出一个数字等于替一个没问过的平台说话。
const unasked = snapshotWith(okProbe(QUOTA));
check(
  "没指名插件 → 没有额度视图（快照里有份也不读）",
  (kind?.quotas(PROVIDER, unasked) ?? []).length === 0,
  JSON.stringify(kind?.quotas(PROVIDER, unasked)),
);
check("没指名插件 → 不算用尽", kind?.outOfCredits(PROVIDER, unasked) === false);
check("没指名插件 → 不知道什么时候恢复", (kind?.recoverAt?.(PROVIDER, unasked) ?? null) === null);

/* ------------------------------------------------------------------ *
 * 一整轮刷新：要不要去敲门户由平台那一行说了算
 * ------------------------------------------------------------------ */

section("刷新");

// 门户换成假的：数它被敲了几次、答什么。真门户只认 https://portal.qiniu.com，
// 别的地址一律当错误（不许真的出机器）。
let portalCalls = 0;
let portalStatus = 200;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
let warns: string[] = [];
console.warn = (...args: unknown[]) => {
  warns.push(args.map((arg) => String(arg)).join(" "));
};
globalThis.fetch = (async (input: unknown) => {
  const url = String(
    typeof input === "string" ? input : ((input as { url?: string } | null)?.url ?? ""),
  );
  if (!url.startsWith("https://portal.qiniu.com/")) {
    throw new Error(`这个测试只认假门户：${url}`);
  }
  portalCalls++;
  if (portalStatus !== 200) return new Response("", { status: portalStatus });
  return new Response(JSON.stringify(OVERVIEW), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// 一个真的账号行：整轮刷新只问库里的账号。
const added = addAccount({ platform: "qiniu" });
const accountId = added.id ?? "";
check("账号加得起来", added.ok === true && accountId !== "", added.message);
// 两段都给全：推理 key + （过期了的）门户口令。
writeQiniuAccount(accountId, { apiKey: "fake-inference-key", portalCookie: "fake-cookie=expired" });

/** 这一轮刷新后库里的快照。 */
async function refreshed(): Promise<any> {
  await refreshHealthSnapshot();
  return peekHealthSnapshot<any>()?.data;
}

// ① 平台行没指名插件 + 门户会回 401：一次也不该去敲。
portalStatus = 401;
warns = [];
const callsBeforeNone = portalCalls;
const snapshotNone = await refreshed();
check("没指名插件：一次门户都没敲", portalCalls === callsBeforeNone, String(portalCalls - callsBeforeNone));
check(
  "没指名插件：快照里没有 qiniu 的份",
  !snapshotNone?.plugins?.qiniu?.[accountId],
  JSON.stringify(snapshotNone?.plugins?.qiniu),
);
check(
  "没指名插件：日志里没有额度查询失败",
  !warns.some((line) => line.includes("额度查询失败")),
  warns.join(" | "),
);
const accountRow = providerRow(accountId)!;
check(
  "没指名插件：KIND 读出来是未知（不是 0）",
  (kind?.quotas(accountRow, snapshotNone) ?? []).length === 0,
  JSON.stringify(kind?.quotas(accountRow, snapshotNone)),
);
check(
  "没指名插件：不算用尽",
  kind?.outOfCredits(accountRow, snapshotNone) === false,
);

// ② 指名插件：额度落在插件桶里，键是插件 id 与账号 id。
portalStatus = 200;
const renamed = updateOpenPlatform("qiniu", { quotaPlugin: qiniuQuotaPlugin.id });
check("平台行指名了插件（给真实账号）", renamed.ok === true, renamed.message);
const callsBeforeNamed = portalCalls;
const snapshotNamed = await refreshed();
check("指名插件：门户被问了一次", portalCalls === callsBeforeNamed + 1, String(portalCalls - callsBeforeNamed));
check(
  "指名插件：结论落在 snapshot.plugins[qiniu][账号]",
  snapshotNamed?.plugins?.["qiniu"]?.[accountId]?.state === "ok",
  JSON.stringify(snapshotNamed?.plugins?.["qiniu"]?.[accountId]),
);
check(
  "指名插件：结论里带着面板那几行",
  snapshotNamed?.plugins?.["qiniu"]?.[accountId]?.views?.[0]?.credits?.lots?.length === 2,
  JSON.stringify(snapshotNamed?.plugins?.["qiniu"]?.[accountId]?.views),
);
const fromRefresh = kind?.quotas(accountRow, snapshotNamed) ?? [];
check("指名插件：quotas 读得回来", fromRefresh.length === 1, String(fromRefresh.length));
check(
  "指名插件：读回来的是两个包",
  fromRefresh[0]?.credits?.lots?.length === 2,
  JSON.stringify(fromRefresh[0]?.credits?.lots),
);

// ③ 指名了插件但门户回 401：凭据被拒，不是没钱。
portalStatus = 401;
const snapshotDenied = await refreshed();
check(
  "门户 401：结论是 unauthorized",
  snapshotDenied?.plugins?.qiniu?.[accountId]?.state === "unauthorized",
  JSON.stringify(snapshotDenied?.plugins?.qiniu?.[accountId]),
);
check(
  "门户 401：读出来是未知（不是 0）",
  (kind?.quotas(accountRow, snapshotDenied) ?? []).length === 0,
  JSON.stringify(kind?.quotas(accountRow, snapshotDenied)),
);
check("门户 401：不算用尽", kind?.outOfCredits(accountRow, snapshotDenied) === false);
check("门户 401：不写冷却", cooldownUntil(accountId) === null, String(cooldownUntil(accountId)));

// ④ 门户回 429：额度接口限流。这不是路由冷却 —— 查额度的接口忙一会儿，跟
//    「这个账号能不能接推理请求」是两件事。只记一行日志，冷却表里不能有这一行。
portalStatus = 429;
warns = [];
const snapshotRate = await refreshed();
check(
  "门户 429：结论是 rate_limited",
  snapshotRate?.plugins?.qiniu?.[accountId]?.state === "rate_limited",
  JSON.stringify(snapshotRate?.plugins?.qiniu?.[accountId]),
);
check("门户 429：不算用尽（限流不是没钱）", kind?.outOfCredits(accountRow, snapshotRate) === false);
check("门户 429：不写路由冷却", cooldownUntil(accountId) === null, String(cooldownUntil(accountId)));
check(
  "门户 429：冷却表里没有这个账号的行",
  !listCooldowns().some((row) => row.providerId === accountId),
  JSON.stringify(listCooldowns().filter((row) => row.providerId === accountId)),
);
// 这条日志是唯一的痕迹：说清哪个接口、哪个插件、哪个账号，不拿「冷却」当说法。
const rateLine = warns.find((line) => line.includes("额度接口被限流"));
check(
  "门户 429：记一行日志说额度接口被限流（带插件与账号）",
  rateLine !== undefined && rateLine.includes("qiniu") && rateLine.includes(accountId),
  warns.join(" / "),
);
check("门户 429：那一行不说冷却", rateLine !== undefined && !rateLine.includes("冷却"), String(rateLine));
// 门户不报 Retry-After 的时候不该猜一个别的时长；报了就用它。
check(
  "门户 429：门户没说多久，恢复时刻就不编",
  snapshotRate?.plugins?.qiniu?.[accountId]?.recoverAt === null,
  String(snapshotRate?.plugins?.qiniu?.[accountId]?.recoverAt),
);

// ⑤ 没有任何额度数据：不知道不等于见底。
check(
  "空快照 → 不算用尽",
  kind?.outOfCredits(accountRow, { plugins: {} }) === false,
);
check("空快照 → 没有额度视图", (kind?.quotas(accountRow, { plugins: {} }) ?? []).length === 0);

console.warn = realWarn;
globalThis.fetch = realFetch;

/* ------------------------------------------------------------------ *
 * 平台登记
 * ------------------------------------------------------------------ */

section("登记");

check("种类在", kind !== null, String(kind));
check("名字是七牛云", kind?.label === "七牛云", String(kind?.label));
check("登录方式是 api_key", kind?.login === "api_key", String(kind?.login));
check("平台在", platformOfAny("qiniu") !== null, String(platformOfAny("qiniu")));
check(
  "收 single 与 fallback",
  policiesOfKind("qiniu").join(",") === "single,fallback",
  policiesOfKind("qiniu").join(","),
);
check(
  "推理地址是七牛云的",
  kind?.baseUrl(PROVIDER) === "https://api.qnaigc.com/v1",
  String(kind?.baseUrl(PROVIDER)),
);

/* ------------------------------------------------------------------ *
 * 模型目录：写死的那一份
 * ------------------------------------------------------------------ */

section("目录");

const models = kind?.models(PROVIDER) ?? [];
check("目录是写死的 5 个", models.length === 5, String(models.length));
check(
  "就是这 5 个",
  models.map((m) => m.id).join(",") ===
    "nvidia/nemotron-3-ultra-550b-a55b0-free," +
    "qiniu/conatus-free," +
    "deepseek/deepseek-v4.1-flash-1017," +
    "minimax/minimax-m3.1-flash," +
    "qwen/qwen3.8-flash-next",
  models.map((m) => m.id).join(","),
);
check(
  "没有平台自己报的、key 用不了的那个",
  !models.some((m) => m.id.includes("glm-4.5")),
  models.map((m) => m.id).join(","),
);
check(
  "每个都有名字",
  models.every((m) => !!m.displayName),
  models.map((m) => m.displayName).join(","),
);
check(
  "平台没报的上下文档位不公布",
  models.every((m) => m.contextWindow === undefined && m.maxOutputTokens === undefined),
  JSON.stringify(models.map((m) => [m.contextWindow, m.maxOutputTokens])),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
