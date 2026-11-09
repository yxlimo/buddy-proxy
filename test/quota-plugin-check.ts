// test/quota-plugin-check.ts — 额度插件：注册表、七牛那一份、开放平台怎么用它。
//
//   node --experimental-strip-types test/quota-plugin-check.ts
//
// 离线：门户是假上游（globalThis.fetch 在这里被换掉），凭据是编的，数据库是
// 临时目录。没有任何一次请求出机器。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-quota-plugin";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const {
  allQuotaPlugins,
  assertQuotaPlugins,
  declareNoQuotaPlugin,
  noQuotaPluginReason,
  quotaEndpointBase,
  quotaPluginOf,
  registerQuotaPlugin,
} = await import("../lib/quota-plugins.ts");
// 种类与插件都是导入时登记的：导入它，它们才都在。
await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { parseRespackOverview, fetchQiniuQuota } = await import("../lib/qiniu/quota.ts");
const { QINIU_RESPACK_PATH } = await import("../lib/qiniu/config.ts");
const { qiniuQuotaPlugin } = await import("../lib/qiniu/quota-plugin.ts");
const { writeQiniuAccount, qiniuAccountId } = await import("../lib/qiniu/account.ts");
const { createOpenPlatform, openPlatformOf, updateOpenPlatform } = await import("../lib/open-platforms.ts");
// 旧库里那种「填了个没登记的插件 id」的行，写路径现在拦住了，只能直接写库造出来。
const { store } = await import("../lib/store.ts");

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

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

section("注册表");

check("七牛那个插件在", quotaPluginOf("qiniu") !== null);
check("认得七牛那个插件", quotaPluginOf("qiniu") === qiniuQuotaPlugin);
check("没有登记的插件是 null", quotaPluginOf("no-such-plugin") === null);
check(
  "全部插件里有七牛那个",
  allQuotaPlugins().some((p) => p.id === "qiniu"),
  allQuotaPlugins().map((p) => p.id).join(","),
);

const dummy = {
  id: "dummy-plugin",
  label: "假的",
  fields: [],
  probe: async () => ({ state: "unknown", views: [], recoverAt: null, message: "假的插件没去问" }),
};
registerQuotaPlugin(dummy);
check("新注册的插件认得", quotaPluginOf("dummy-plugin") === dummy);
check(
  "全部插件里有新注册的那个",
  allQuotaPlugins().some((p) => p.id === "dummy-plugin"),
);
let duplicateThrew = false;
try {
  registerQuotaPlugin(dummy);
} catch {
  duplicateThrew = true;
}
check("同一个 id 注册两次 → 抛错", duplicateThrew);
check(
  "重名的那次没有把原来那份顶掉",
  quotaPluginOf("dummy-plugin") === dummy,
);

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

/** 快照里那一份：两个包。 */
const QUOTA = { respacks: parseRespackOverview(OVERVIEW), at: 1767225600000 };

/**
 * 假上游。两台：门户（代码里写死的那台）与自建端点（平台行上填的那台）。
 *
 * 别的地址一律当作出错 —— 一次请求都不许出机器。
 */
const PORTAL_HOST = "portal.qiniu.com";
/** 自建端点。用户会填的形状：带 /v1 前缀。 */
const SELF_HOSTED_BASE = "https://self-hosted.invalid/v1";
/** 门户收到了几次请求。 */
let portalCalls = 0;
/** 自建端点收到了哪些地址（看主机与路径）。 */
const selfCalls: string[] = [];
/** 最近一次门户请求的地址。 */
let lastPortalUrl = "";
/** 门户这一轮答什么（换它来演「一包不剩」）。 */
let portalBody: unknown = OVERVIEW;
globalThis.fetch = (async (input: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? ""));
  const host = new URL(url).host;
  if (host === PORTAL_HOST) {
    lastPortalUrl = url;
    portalCalls++;
    return new Response(JSON.stringify(portalBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith(`${SELF_HOSTED_BASE}/`) || url.startsWith("https://self-hosted.invalid/")) {
    selfCalls.push(url);
    return new Response(JSON.stringify(portalBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`这个测试只认假门户与假自建端点：${url}`);
}) as typeof fetch;

/* ------------------------------------------------------------------ *
 * 七牛那个插件
 * ------------------------------------------------------------------ */

section("七牛的插件");

const { QINIU_INFER_BASE } = await import("../lib/qiniu/config.ts");
// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
// 行上的地址写死成这一类的默认地址（值取自常量）：「行上的地址 == 默认地址
// → 额度问插件自己那台」那条要的就是这个前提。
insertVendorPlatform("qiniu", "qiniu", { baseUrl: QINIU_INFER_BASE });
const QINIU_ACCOUNT = {
  id: "qiniu-plugin-account",
  platform: "qiniu",
  kind: "qiniu",
  region: "",
  alias: "七牛云插件测试账号",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;

// 凭据是编的：门户 cookie 只用来问额度，这里问的是假门户。
writeQiniuAccount(QINIU_ACCOUNT.id, { apiKey: "fake-key", portalCookie: "fake-cookie=1" });

const probed = await qiniuQuotaPlugin.probe(QINIU_ACCOUNT);
check("假门户被问了一次", portalCalls === 1, String(portalCalls));
check("问到了 → ok", probed.state === "ok", JSON.stringify(probed));
check("两个包", probed.views[0]?.credits?.lots?.length === 2, JSON.stringify(probed.views));
check(
  "第一个包剩 3000",
  probed.views[0]?.credits?.lots?.[0]?.remaining === 3000,
  String(probed.views[0]?.credits?.lots?.[0]?.remaining),
);
/** 快照里存的那一份：问回来的结论。 */
const OK_PROBE = { state: probed.state, views: probed.views, recoverAt: probed.recoverAt, message: probed.message };

// 没有门户 cookie 就问不了：那是「没填凭据」，不是「没有资源包」。
const NO_COOKIE = { ...QINIU_ACCOUNT, id: "qiniu-plugin-no-cookie" };
const before = portalCalls;
const nothing = await qiniuQuotaPlugin.probe(NO_COOKIE);
check("没有 cookie → missing", nothing.state === "missing", JSON.stringify(nothing));
check("没有 cookie → 没有额度视图", nothing.views.length === 0, JSON.stringify(nothing.views));
check("没有 cookie → 没有去问门户", portalCalls === before, String(portalCalls));

/**
 * 迁移前的那份实现，留在这儿当尺子。
 *
 * 迁移不许动数字：插件必须给出迁移前 lib/qiniu/register.ts 给出的那一份，一
 * 个字段都不许差。
 */
function legacyQiniuQuotas(provider: any, quota: any): any[] {
  if (!quota || typeof quota !== "object") return [];
  if (!Array.isArray(quota.respacks)) return [];
  const packs = quota.respacks;
  if (!packs.length) return [];
  const lots = packs.map((pack: any) => ({
    id: `${pack.itemCode}@${pack.zoneName}`,
    sourceLabel: `${pack.itemName} · ${pack.zoneName}（${pack.unit}）`,
    remaining: pack.remaining,
    expiresAt: 0,
    status: pack.remaining > 0 ? "可用" : "已用尽",
  }));
  const total = packs.reduce((sum: number, pack: any) => sum + pack.total, 0);
  const used = packs.reduce((sum: number, pack: any) => sum + pack.used, 0);
  const remaining = packs.reduce((sum: number, pack: any) => sum + pack.remaining, 0);
  const unit = packs[0]?.unit ?? "";
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total,
        used,
        remaining,
        lots,
        note: `资源包：${packs.length} 项，剩 ${remaining} ${unit}`,
      },
    },
  ];
}

const pluginViews = probed.views;
// 归属（upstreamId / accountId）是后来修正过的：迁移前的实现把账号 id 当平台
// 写，这条测的是「数字与形状没变」，所以只比数字那一半。归属另有一条断言守着。
const withoutIdentity = (views: any[]): any[] =>
  views.map(({ upstreamId: _upstreamId, accountId: _accountId, ...rest }) => rest);
const legacyViews = legacyQiniuQuotas(QINIU_ACCOUNT, QUOTA);
check(
  "插件的输出与迁移前逐字段相同（归属另测）",
  same(withoutIdentity(pluginViews), withoutIdentity(legacyViews)),
  JSON.stringify(pluginViews),
);

const credits = pluginViews[0]?.credits;
check("报一个额度", pluginViews.length === 1, String(pluginViews.length));
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
check(
  "额度挂在账号上",
  pluginViews[0]?.accountId === QINIU_ACCOUNT.id,
  String(pluginViews[0]?.accountId),
);
check(
  "平台 id 写的是平台，不是账号",
  pluginViews[0]?.upstreamId === QINIU_ACCOUNT.platform,
  `${pluginViews[0]?.upstreamId} / 期望 ${QINIU_ACCOUNT.platform}`,
);

// 门户答「全是 0」：翻成 no_quota，而且不再给数字 —— 数字全零说的是「一包都不剩」，
// 这时候面板要的是一句话。
portalBody = {
  code: 200,
  data: { records: OVERVIEW.data.records.map((row) => ({ ...row, month_remain: "0" })) },
};
const drained = await qiniuQuotaPlugin.probe(QINIU_ACCOUNT);
check("两个包都空了 → no_quota", drained.state === "no_quota", JSON.stringify(drained));
check("见底不给数字", drained.views.length === 0, JSON.stringify(drained.views));
check("见底那句话说了「用尽」", drained.message.includes("用尽"), drained.message);
check("见底没有恢复时刻（资源包不会长回来）", drained.recoverAt === null, String(drained.recoverAt));
portalBody = OVERVIEW;

// 插件要的那一份凭据：门户 cookie 那一段。
const cookieField = qiniuQuotaPlugin.fields.find((f) => f.name === "account");
check("插件要门户 cookie 那一段", cookieField !== undefined);
check("门户 cookie 要遮起来显示", cookieField?.secret === true);
check(
  "字段名就是凭据在库里的那一段",
  qiniuAccountId("some-account").endsWith(`:${cookieField?.name ?? ""}`),
  `${qiniuAccountId("some-account")} / ${cookieField?.name}`,
);

/* ------------------------------------------------------------------ *
 * 种类还是那一份
 * ------------------------------------------------------------------ */

section("种类");

// 七牛的种类也走插件：要不要问写在平台那一行（quota_plugin）。
const qiniuPlatform = updateOpenPlatform("qiniu", { quotaPlugin: qiniuQuotaPlugin.id });
check("七牛的平台行指名了插件", qiniuPlatform.ok === true, qiniuPlatform.message);

const qiniuKind = kindOf("qiniu");
const kindSnapshot = {
  plugins: { [qiniuQuotaPlugin.id]: { [QINIU_ACCOUNT.id]: OK_PROBE } },
} as any;

/** 一组额度，去掉两个「这一条是谁的」的 id：它们由 kind 按当前账号行重新写。 */
function withoutIds(views: any[]): any[] {
  return views.map(({ upstreamId: _upstreamId, accountId: _accountId, ...rest }) => rest);
}

check(
  "种类转给插件之后，数字还是那些（两个 id 除外）",
  same(withoutIds(qiniuKind?.quotas(QINIU_ACCOUNT, kindSnapshot) ?? []), withoutIds(pluginViews)),
  JSON.stringify(qiniuKind?.quotas(QINIU_ACCOUNT, kindSnapshot)),
);
// 两个 id 的规矩：upstreamId 是平台（余额页按平台分组），accountId 是这个账号。
const qiniuKindViews = qiniuKind?.quotas(QINIU_ACCOUNT, kindSnapshot) ?? [];
check(
  "upstreamId 是平台、accountId 是账号",
  qiniuKindViews[0]?.upstreamId === QINIU_ACCOUNT.platform && qiniuKindViews[0]?.accountId === QINIU_ACCOUNT.id,
  `${qiniuKindViews[0]?.upstreamId} / ${qiniuKindViews[0]?.accountId}`,
);
check(
  "种类的用尽判定还是那些",
  qiniuKind?.outOfCredits(QINIU_ACCOUNT, kindSnapshot) === false,
);
check(
  "种类没有恢复时间",
  // 分得出「没有钩子」与「钩子答 null」：这里钩子在，答的是 null（不知道）。
  typeof qiniuKind?.recoverAt === "function" && qiniuKind.recoverAt(QINIU_ACCOUNT, kindSnapshot) === null,
  String(qiniuKind?.recoverAt?.(QINIU_ACCOUNT, kindSnapshot)),
);

// 平台行没指名插件：快照里有份也不读 —— 不知道不是 0。
updateOpenPlatform("qiniu", { quotaPlugin: "" });
check(
  "没指名插件 → 没有额度视图",
  (qiniuKind?.quotas(QINIU_ACCOUNT, kindSnapshot) ?? []).length === 0,
  JSON.stringify(qiniuKind?.quotas(QINIU_ACCOUNT, kindSnapshot)),
);
check("没指名插件 → 不算用尽", qiniuKind?.outOfCredits(QINIU_ACCOUNT, kindSnapshot) === false);
check(
  "没指名插件 → 不知道什么时候恢复",
  (qiniuKind?.recoverAt?.(QINIU_ACCOUNT, kindSnapshot) ?? null) === null,
);
updateOpenPlatform("qiniu", { quotaPlugin: qiniuQuotaPlugin.id });

/* ------------------------------------------------------------------ *
 * 开放平台：额度走插件
 * ------------------------------------------------------------------ */

section("开放平台");

createOpenPlatform({ id: "quota-demo", label: "带额度的开放平台", baseUrl: "https://example.invalid/v1", quotaPlugin: "qiniu" });
createOpenPlatform({ id: "quota-demo-none", label: "没有额度的开放平台", baseUrl: "https://example.invalid/v1" });

// 没登记的插件 id：拒收，一个字都不落库 —— 存下去之后这个平台一条额度结论
// 都不会有，而面板上看着「已选插件」。
const badCreate = createOpenPlatform({
  id: "quota-demo-bad",
  label: "填错插件的开放平台",
  baseUrl: "https://example.invalid/v1",
  quotaPlugin: "no-such-plugin",
});
check("没登记的插件 id 建不了平台", badCreate.ok === false, badCreate.message);
check(
  "机器码是「没有这个额度插件」，细节里带着那个 id 与登记过的几个",
  badCreate.code === "QUOTA_PLUGIN_UNKNOWN" && badCreate.message.includes("no-such-plugin") && badCreate.message.includes("qiniu"),
  JSON.stringify(badCreate),
);
check("没登记的插件 id → 表里没有这一行", openPlatformOf("quota-demo-bad") === null, JSON.stringify(openPlatformOf("quota-demo-bad")));

// 旧库里的那一行：绕过写路径，直接塞一个没登记的 id。读的那一头（下面几节与
// 启动校验）还是得容得下它。
createOpenPlatform({ id: "quota-demo-bad", label: "填错插件的开放平台", baseUrl: "https://example.invalid/v1" });
store().prepare("UPDATE platform SET quota_plugin = ? WHERE id = ?").run("no-such-plugin", "quota-demo-bad");
check(
  "旧库里那一格读得回来",
  openPlatformOf("quota-demo-bad")?.quotaPlugin === "no-such-plugin",
  String(openPlatformOf("quota-demo-bad")?.quotaPlugin),
);

function openAccount(id: string): any {
  return {
    id,
    platform: id,
    kind: "openai",
    region: "",
    alias: id,
    enabled: true,
    weight: 0,
    policy: "single",
    createdAt: 0,
    updatedAt: 0,
  };
}

function snapshotWithPlugins(plugins: Record<string, Record<string, unknown>>): any {
  return { plugins };
}

const openKind = kindOf("openai");
const withData = snapshotWithPlugins({ qiniu: { "quota-demo": OK_PROBE } });
const openViews = openKind?.quotas(openAccount("quota-demo"), withData) ?? [];
check("选了插件、快照里有数据 → 有额度视图", openViews.length === 1, String(openViews.length));
check(
  "额度视图与插件算出来的一样",
  same(openViews, probed.views.map((view) => ({ ...view, upstreamId: "quota-demo", accountId: "quota-demo" }))),
);
check(
  "选了插件、快照里有数据 → 用尽判定照插件说的",
  openKind?.outOfCredits(openAccount("quota-demo"), withData) === false,
);
check(
  "选了插件、快照里有数据 → 恢复时间照插件说的",
  (openKind?.recoverAt?.(openAccount("quota-demo"), withData) ?? null) === null,
);

const withoutEntry = snapshotWithPlugins({ qiniu: { "somebody-else": OK_PROBE } });
check(
  "快照里没有这个账号的那一份 → 没有额度视图",
  (openKind?.quotas(openAccount("quota-demo"), withoutEntry) ?? []).length === 0,
);
check(
  "快照里没有这个账号的那一份 → 不算用尽",
  openKind?.outOfCredits(openAccount("quota-demo"), withoutEntry) === false,
);
check(
  "快照里没有这个账号的那一份 → 不知道什么时候恢复",
  (openKind?.recoverAt?.(openAccount("quota-demo"), withoutEntry) ?? null) === null,
);

const noPlugin = snapshotWithPlugins({});
check(
  "没有选插件 → 没有额度视图",
  (openKind?.quotas(openAccount("quota-demo-none"), noPlugin) ?? []).length === 0,
);
check(
  "没有选插件 → 不算用尽",
  openKind?.outOfCredits(openAccount("quota-demo-none"), noPlugin) === false,
);
check(
  "没有选插件 → 不知道什么时候恢复",
  (openKind?.recoverAt?.(openAccount("quota-demo-none"), noPlugin) ?? null) === null,
);

let badPluginThrew = false;
let badPluginViews: unknown = null;
try {
  badPluginViews = openKind?.quotas(openAccount("quota-demo-bad"), noPlugin);
} catch {
  badPluginThrew = true;
}
check("插件 id 填错了 → 不抛", !badPluginThrew);
check("插件 id 填错了 → 没有额度视图", (badPluginViews as unknown[])?.length === 0);
check(
  "插件 id 填错了 → 不算用尽",
  openKind?.outOfCredits(openAccount("quota-demo-bad"), noPlugin) === false,
);
check(
  "插件 id 填错了 → 不知道什么时候恢复",
  (openKind?.recoverAt?.(openAccount("quota-demo-bad"), noPlugin) ?? null) === null,
);

// 插件换了名字以后，那个平台就问不到了：额度是「未知」，不是「没有」。
updateOpenPlatform("quota-demo", { quotaPlugin: "dummy-plugin" });
check(
  "换成一个没有额度视图的插件 → 没有额度视图",
  (openKind?.quotas(openAccount("quota-demo"), withData) ?? []).length === 0,
);

/* ------------------------------------------------------------------ *
 * 启动校验
 * ------------------------------------------------------------------ */

section("启动校验");

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => String(a)).join(" "));
};
let assertThrew = false;
try {
  // 旧库里又有一行填错了插件（写路径现在拦住了，直接写库）：启动校验得说它一次，
  // 而且一个进程只一次 —— 这是配置错误，不该跟着启动刷屏。
  createOpenPlatform({
    id: "quota-demo-bad-2",
    label: "填错插件的开放平台二",
    baseUrl: "https://example.invalid/v1",
  });
  store().prepare("UPDATE platform SET quota_plugin = ? WHERE id = ?").run("no-such-plugin-startup", "quota-demo-bad-2");
  assertQuotaPlugins();
  // 第二次：去重就是干这个的。
  assertQuotaPlugins();
} catch {
  assertThrew = true;
} finally {
  console.warn = realWarn;
}
check("填错了插件 id → 不抛", !assertThrew);
/** 说的是这个平台、这个插件的那一行。 */
function startupLines(): string[] {
  return warnings.filter((line) => line.includes("quota-demo-bad-2"));
}
check("旧库里那一行 → warn 一行", startupLines().length === 1, warnings.join(" / "));
check(
  "警告说的是那个 id",
  startupLines().some((line) => line.includes("这个平台填的额度插件没登记：no-such-plugin-startup")),
  warnings.join(" / "),
);
check("启动两次也只说一次", warnings.filter((line) => line.includes("no-such-plugin-startup")).length === 1, warnings.join(" / "));
check(
  "登记的插件不说",
  !warnings.some((line) => line.includes("这个平台填的额度插件没登记：qiniu")),
  warnings.join(" / "),
);

check(
  "星火声明了自己没有额度接口",
  typeof noQuotaPluginReason("xinghuo") === "string" && noQuotaPluginReason("xinghuo")!.length > 0,
  String(noQuotaPluginReason("xinghuo")),
);
check("别的平台没有声明", noQuotaPluginReason("qiniu") === null);
declareNoQuotaPlugin("dummy-declared", "只是测一下");
check(
  "声明了就有理由",
  noQuotaPluginReason("dummy-declared") === "只是测一下",
  String(noQuotaPluginReason("dummy-declared")),
);

/* ------------------------------------------------------------------ *
 * 插件要的那几段凭据：开放平台的账号怎么装得下
 * ------------------------------------------------------------------ */

section("插件凭据");

const { pluginFieldOf, writePluginField } = await import("../lib/quota-plugin-credentials.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { credentialsOf } = await import("../lib/admin/accounts.ts");
const { addAccount, provider } = await import("../lib/providers.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

// 一段字段就是一行凭据：写了读得回，空串清掉，没写过就是空串。
const FIELD_ACCOUNT = "quota-cred-no-account";
check("没写过的字段是空串", pluginFieldOf(FIELD_ACCOUNT, "account") === "", pluginFieldOf(FIELD_ACCOUNT, "account"));
check("写进去说写了", writePluginField(FIELD_ACCOUNT, "account", "fake-cookie=1") === true);
check(
  "读回来是那个值",
  pluginFieldOf(FIELD_ACCOUNT, "account") === "fake-cookie=1",
  pluginFieldOf(FIELD_ACCOUNT, "account"),
);
check("写空串说没写", writePluginField(FIELD_ACCOUNT, "account", "") === false);
check("清掉之后是空串", pluginFieldOf(FIELD_ACCOUNT, "account") === "", pluginFieldOf(FIELD_ACCOUNT, "account"));

// 端到端：开放平台的账号装得下插件要的那一段，额度也真读得到。
// 另建一个平台：上面那节把 quota-demo 的插件换成了没有字段的假插件。
createOpenPlatform({
  id: "quota-demo-qiniu",
  label: "带七牛额度的开放平台",
  // 地址指到自建端点：额度也该问那一台（门户只认它自己那台，自测全靠这一条）。
  baseUrl: SELF_HOSTED_BASE,
  quotaPlugin: "qiniu",
});
const e2e = addAccount({ platform: "quota-demo-qiniu" });
const e2eId = e2e.id ?? "";
check("账号加得起来", e2e.ok === true && e2eId !== "", e2e.message);

const setBoth = setProviderKeys(e2eId, ["sk-demo-inference", "fake-portal-cookie=1"]);
check("两段都写进去了", setBoth.count === 2, String(setBoth.count));
check(
  "文案说的是这两段",
  setBoth.message.includes("API key") && setBoth.message.includes("门户 cookie"),
  setBoth.message,
);

const rows = credentialsOf(e2eId);
check("凭据表里有两行", rows.length === 2, JSON.stringify(rows.map((r) => [r.kind, r.label, r.inference])));
check(
  "第一行是推理 API key",
  rows[0]?.label === "推理 API key" && rows[0]?.inference === true,
  JSON.stringify(rows[0]),
);
check("第二行是门户 cookie", rows[1]?.label === "门户 cookie", JSON.stringify(rows[1]));
check("门户 cookie 不是推理凭据", rows[1]?.inference === false, JSON.stringify(rows[1]));
check("门户 cookie 是能用的", rows[1]?.status === CredentialState.USABLE, String(rows[1]?.status));
check("门户 cookie 有掩码", Boolean(rows[1]?.masked), String(rows[1]?.masked));
check("门户 cookie 有指纹", Boolean(rows[1]?.fingerprint), String(rows[1]?.fingerprint));

const e2eAccount = provider(e2eId) as any;
const e2eProbe = await qiniuQuotaPlugin.probe(e2eAccount);
check("插件从开放平台的账号上问到了额度", e2eProbe.state === "ok", JSON.stringify(e2eProbe));
check("额度读得到", e2eProbe.views.length === 1, JSON.stringify(e2eProbe.views));
check(
  "剩下的还是那些",
  e2eProbe.views[0]?.credits?.remaining === 5000,
  JSON.stringify(e2eProbe.views[0]?.credits),
);

// 只给推理 key：额度是「不知道」，不是「没有」。
// 这个平台选了七牛那个插件（它要一段门户 cookie），所以数组得两段：短的数组
// 服务端整单不改（那是「调用方不知道这个插件要几段」）。第二段留空 = 门户
// cookie 不填。
const bare = addAccount({ platform: "quota-demo-qiniu" });
const bareId = bare.id ?? "";
check("账号加得起来", bare.ok === true && bareId !== "", bare.message);
const setBare = setProviderKeys(bareId, ["sk-demo-bare", ""]);
check("只写进去一段", setBare.count === 1, String(setBare.count));
check("门户 cookie 那段是空的", pluginFieldOf(bareId, "account") === "", pluginFieldOf(bareId, "account"));
const bareAccount = provider(bareId) as any;
const bareProbe = await qiniuQuotaPlugin.probe(bareAccount);
check("没有门户 cookie → missing", bareProbe.state === "missing", JSON.stringify(bareProbe));
check("没有额度视图", bareProbe.views.length === 0, JSON.stringify(bareProbe.views));

// 平台没选插件却给了两把 key：多的那把没地方去，忽略掉，不报错。
const plain = addAccount({ platform: "quota-demo-none" });
const plainId = plain.id ?? "";
check("账号加得起来", plain.ok === true && plainId !== "", plain.message);
const setPlain = setProviderKeys(plainId, ["sk-demo-plain", "should-not-be-written"]);
check("只写了推理 key", setPlain.count === 1, String(setPlain.count));
check("文案说清了只写了推理 key", setPlain.message.includes("多余的 key 未保存"), setPlain.message);
check("第二把没落到任何地方", pluginFieldOf(plainId, "account") === "", pluginFieldOf(plainId, "account"));

// 填错了插件 id：拒收，库里那一格原地不动（存下去之后这个平台一条额度结论都没有）。
const plainBefore = openPlatformOf("quota-demo-none")?.quotaPlugin ?? "";
const refused = updateOpenPlatform("quota-demo-none", { quotaPlugin: "no-such-plugin-3" });
check("没登记的插件 id 改不进去", refused.ok === false, refused.message);
check(
  "机器码是「没有这个额度插件」，细节里带着那个 id 与登记过的几个",
  refused.code === "QUOTA_PLUGIN_UNKNOWN" && refused.message.includes("no-such-plugin-3") && refused.message.includes("qiniu"),
  JSON.stringify(refused),
);
check(
  "库里那一格没动",
  (openPlatformOf("quota-demo-none")?.quotaPlugin ?? "") === plainBefore,
  String(openPlatformOf("quota-demo-none")?.quotaPlugin),
);

/* ------------------------------------------------------------------ *
 * 额度问哪一台
 *
 * 额度接口的地址是代码里写死的（门户那台）。平台行上写的是「这个平台在跟谁
 * 说话」：用户把地址指到别处时，额度也要问同一台 —— 否则自建/自测端点上的
 * 额度永远问不到，e2e 只能靠改写 fetch 的主机名绕过去。
 * ------------------------------------------------------------------ */

section("额度问哪一台");

/** 自建端点收到的那一个地址：插件路径与原有的查询串都在里面。 */
const RESPACK_URL = new URL(`${QINIU_RESPACK_PATH}?page=1&page_size=10`, SELF_HOSTED_BASE).toString();

// 1. 模板平台：行上的地址就是模板的默认值（推理端点），额度照旧问门户那台。
const templatePortalBefore = portalCalls;
const templateSelfBefore = selfCalls.length;
const templateProbe = await qiniuQuotaPlugin.probe(QINIU_ACCOUNT);
check("模板平台问到额度", templateProbe.state === "ok", JSON.stringify(templateProbe));
check("模板平台问的是门户那台", new URL(lastPortalUrl).host === PORTAL_HOST, lastPortalUrl);
check("模板平台问了一次门户", portalCalls === templatePortalBefore + 1, String(portalCalls - templatePortalBefore));
check("模板平台没去问自建端点", selfCalls.length === templateSelfBefore, String(selfCalls.length));

// 2. 自建平台：行上的地址不是模板默认值 → 额度问那一台。
createOpenPlatform({
  id: "quota-endpoint",
  label: "地址指到自建端点的平台",
  baseUrl: SELF_HOSTED_BASE,
  quotaPlugin: "qiniu",
});
const endpointAccount = addAccount({ platform: "quota-endpoint" });
const endpointId = endpointAccount.id ?? "";
check("账号加得起来", endpointAccount.ok === true && endpointId !== "", endpointAccount.message);
setProviderKeys(endpointId, ["sk-demo-endpoint", "fake-portal-cookie=1"]);

const selfBefore = selfCalls.length;
const portalBeforeSelf = portalCalls;
const endpointProbe = await qiniuQuotaPlugin.probe(provider(endpointId) as any);
check("自建平台问到额度", endpointProbe.state === "ok", JSON.stringify(endpointProbe));
check("自建平台问的是自建端点", selfCalls.length === selfBefore + 1, String(selfCalls.length - selfBefore));
check("自建平台没去问门户", portalCalls === portalBeforeSelf, String(portalCalls - portalBeforeSelf));
check(
  // 行上写的是 https://…/v1，路径却从根开始：/v1 是用户自己填的，不替用户拼。
  "自建端点收到的是 origin + 原来的 resppack 路径",
  selfCalls[selfBefore] === RESPACK_URL,
  `${selfCalls[selfBefore]} / ${RESPACK_URL}`,
);

// 3. 行上带尾部斜杠：与不带时一模一样（地址交给 URL 解析，不靠手写裁剪）。
store()
  .prepare("UPDATE platform SET base_url = ? WHERE id = ?")
  .run(`${SELF_HOSTED_BASE}/`, "quota-endpoint");
const slashBefore = selfCalls.length;
const slashProbe = await qiniuQuotaPlugin.probe(provider(endpointId) as any);
check("行上带尾部斜杠也问得通", slashProbe.state === "ok", JSON.stringify(slashProbe));
check(
  "带斜杠与不带斜杠是同一个地址",
  selfCalls[slashBefore] === RESPACK_URL,
  `${selfCalls[slashBefore]} / ${RESPACK_URL}`,
);

// 4. 行上地址是空的（旧库、手改过的库）：退回插件自己那台，不拼空地址。
store().prepare("UPDATE platform SET base_url = '' WHERE id = ?").run("quota-endpoint");
const emptySelfBefore = selfCalls.length;
const emptyPortalBefore = portalCalls;
const emptyProbe = await qiniuQuotaPlugin.probe(provider(endpointId) as any);
check("行上没地址 → 问到额度", emptyProbe.state === "ok", JSON.stringify(emptyProbe));
check("行上没地址 → 退回门户那台", portalCalls === emptyPortalBefore + 1, String(portalCalls - emptyPortalBefore));
check("行上没地址 → 没去问自建端点", selfCalls.length === emptySelfBefore, String(selfCalls.length));
check("行上没地址 → 地址里没有空主机", new URL(lastPortalUrl).host === PORTAL_HOST, lastPortalUrl);
// 改回去：后面的段落还要用这个平台。
store().prepare("UPDATE platform SET base_url = ? WHERE id = ?").run(SELF_HOSTED_BASE, "quota-endpoint");

// 不传 base 的调用点（别处的代码还是这样调）：打的是默认那台，一字不改。
const directBefore = portalCalls;
const direct = await fetchQiniuQuota("fake-portal-cookie=1");
check("不传 base 也能问到", direct.ok === true, JSON.stringify(direct));
check(
  "不传 base 打的是默认门户",
  portalCalls === directBefore + 1 && new URL(lastPortalUrl).host === PORTAL_HOST,
  lastPortalUrl,
);

/* ------------------------------------------------------------------ *
 * 额度真的被拉一次
 *
 * 上面那几节是「快照里有一份，面板读得到」。这一节是另一头：网关真的去问，
 * 问回来的那份真的进了快照。
 * ------------------------------------------------------------------ */

section("额度真的被拉一次");

const { refreshHealthSnapshot, upstreamQuotas } = await import("../lib/admin/upstreams.ts");
const { peekHealthSnapshot } = await import("../lib/health-cache.ts");

/** 快照里的插件桶：插件 id → 账号 id → 那一份。 */
function pluginBucket(): Record<string, Record<string, unknown>> {
  const data = peekHealthSnapshot<any>()?.data;
  return (data?.plugins ?? {}) as Record<string, Record<string, unknown>>;
}

/** 这个账号在插件桶里有没有份（哪个插件下都算）。 */
function hasPluginEntry(accountId: string): boolean {
  return Object.values(pluginBucket()).some((table) => accountId in table);
}

// 一个插件，问的时候故意炸：问失败不许把整轮带挂。
registerQuotaPlugin({
  id: "boom-plugin",
  label: "会炸的插件",
  fields: [],
  // 插件不该 reject（翻不动的都归 unknown）。这里故意违约：网关不许因此把整轮带挂。
  probe: async () => {
    throw new Error("这个插件故意炸");
  },
});

// 一个插件，两个账号用：这一轮谁能问、谁问不到是测试说了算。
const twoState = { failFor: "" };
registerQuotaPlugin({
  id: "two-accounts",
  label: "两个账号的插件",
  fields: [],
  probe: async (account) => {
    if (account.id === twoState.failFor) throw new Error("这一轮这个账号问不到");
    return { state: "ok", views: [], recoverAt: null, message: account.id };
  },
});

// 四种开放平台：选了插件的、没选插件的、插件没登记的、插件会炸的。
createOpenPlatform({
  id: "quota-live",
  label: "额度真被拉的开放平台",
  baseUrl: SELF_HOSTED_BASE,
  quotaPlugin: "qiniu",
});
createOpenPlatform({
  id: "quota-live-none",
  label: "没选插件的开放平台",
  baseUrl: "https://example.invalid/v1",
});
createOpenPlatform({
  id: "quota-live-bad",
  label: "插件没登记的开放平台",
  baseUrl: "https://example.invalid/v1",
});
// 旧库里的形状：插件 id 没登记。写路径现在拦住了，直接写库造出来。
store().prepare("UPDATE platform SET quota_plugin = ? WHERE id = ?").run("no-such-plugin-live", "quota-live-bad");
createOpenPlatform({
  id: "quota-live-boom",
  label: "插件会炸的开放平台",
  baseUrl: "https://example.invalid/v1",
  quotaPlugin: "boom-plugin",
});
createOpenPlatform({
  id: "quota-live-two",
  label: "两个账号的开放平台",
  baseUrl: "https://example.invalid/v1",
  quotaPlugin: "two-accounts",
});

const live = addAccount({ platform: "quota-live" });
const liveId = live.id ?? "";
check("开放平台的账号加得起来", live.ok === true && liveId !== "", live.message);
const liveKeys = setProviderKeys(liveId, ["sk-demo-live", "fake-portal-cookie=1"]);
check("两段凭据写进去了", liveKeys.count === 2, liveKeys.message);

// 没选插件、插件没登记、插件会炸的三个账号：一个凭据都不给。
const noneLive = addAccount({ platform: "quota-live-none" });
const noneLiveId = noneLive.id ?? "";
const badLive = addAccount({ platform: "quota-live-bad" });
const badLiveId = badLive.id ?? "";
const boomLive = addAccount({ platform: "quota-live-boom" });
const boomLiveId = boomLive.id ?? "";
const twoA = addAccount({ platform: "quota-live-two" });
const twoAId = twoA.id ?? "";
const twoB = addAccount({ platform: "quota-live-two" });
const twoBId = twoB.id ?? "";
check(
  "三个账号加得起来",
  noneLiveId !== "" && badLiveId !== "" && boomLiveId !== "" && twoAId !== "" && twoBId !== "",
  `${noneLiveId} ${badLiveId} ${boomLiveId} ${twoAId} ${twoBId}`,
);
check("两个账号不是同一个", twoAId !== twoBId, `${twoAId} ${twoBId}`);

// 刷一轮：问到的写进快照，问不到的就不写。
const refreshWarnings: string[] = [];
const realRefreshWarn = console.warn;
console.warn = (...args: unknown[]) => {
  refreshWarnings.push(args.map((a) => String(a)).join(" "));
};
let refreshThrew = false;
try {
  await refreshHealthSnapshot();
} catch {
  refreshThrew = true;
} finally {
  console.warn = realRefreshWarn;
}
check("刷新不抛", !refreshThrew);

const livePayload = pluginBucket().qiniu?.[liveId] as any;
check("结论被写进插件桶", Boolean(livePayload), JSON.stringify(livePayload));
check("写进去的是 ok", livePayload?.state === "ok", JSON.stringify(livePayload));
check(
  "写进去的带着面板那几行",
  livePayload?.views?.[0]?.credits?.lots?.length === 2,
  JSON.stringify(livePayload?.views),
);
check(
  "凭据表里两段都在",
  credentialsOf(liveId).length === 2,
  JSON.stringify(credentialsOf(liveId).map((r) => [r.kind, r.label])),
);

const liveSnapshot = peekHealthSnapshot<any>()?.data;
const liveViews = openKind?.quotas(provider(liveId) as any, liveSnapshot) ?? [];
check("额度视图读得到", liveViews.length === 1, JSON.stringify(liveViews));
check("剩下的是两个包之和", liveViews[0]?.credits?.remaining === 5000, JSON.stringify(liveViews[0]));

check("没选插件的账号没有份", !hasPluginEntry(noneLiveId));
check("插件没登记的账号没有份", !hasPluginEntry(badLiveId));
check(
  "插件问炸了 → 结论是 unknown（写进去，不冒充没有）",
  (pluginBucket()["boom-plugin"]?.[boomLiveId] as any)?.state === "unknown",
  JSON.stringify(pluginBucket()["boom-plugin"]),
);
check(
  "插件问炸了 → warn 一行，说的是那个账号与那个插件",
  refreshWarnings.some(
    (line) => line.includes(boomLiveId) && line.includes("boom-plugin"),
  ),
  refreshWarnings.join(" / "),
);
check(
  "问炸的账号没把别的平台带挂",
  Boolean(pluginBucket().qiniu?.[liveId]),
  JSON.stringify(pluginBucket().qiniu),
);

// 两个账号同一个插件：这一轮两个都问到了。
check("两个账号都有份", hasPluginEntry(twoAId) && hasPluginEntry(twoBId));
check(
  "两个账号各是各的",
  (pluginBucket()["two-accounts"]?.[twoAId] as any)?.message === twoAId &&
    (pluginBucket()["two-accounts"]?.[twoBId] as any)?.message === twoBId,
  JSON.stringify(pluginBucket()["two-accounts"]),
);

// 下一轮只问得到一个：另一个这一轮问炸了，它那份变成 unknown —— 旧数字不留，
// 也不冒充「问到了」。
twoState.failFor = twoBId;
let mergeThrew = false;
try {
  await upstreamQuotas("quota-live-two", true, true);
} catch {
  mergeThrew = true;
}
check("单平台刷新不抛", !mergeThrew);
const merged = pluginBucket();
check("问到的那个账号还在", Boolean(merged["two-accounts"]?.[twoAId]), JSON.stringify(merged["two-accounts"]));
check(
  "问炸的那个账号，那份变成 unknown",
  (merged["two-accounts"]?.[twoBId] as any)?.state === "unknown",
  JSON.stringify(merged["two-accounts"]?.[twoBId]),
);
// 平台行不再指名插件：这一轮没人去问，两个账号的旧份都该走（与具名桶同语义）。
updateOpenPlatform("quota-live-two", { quotaPlugin: "" });
await upstreamQuotas("quota-live-two", true, true);
check(
  "不再指名插件 → 两个账号的旧份都没了",
  !hasPluginEntry(twoAId) && !hasPluginEntry(twoBId),
  JSON.stringify(pluginBucket()["two-accounts"]),
);
check(
  "别的平台的份没被动",
  Boolean(merged.qiniu?.[liveId]) && Boolean(merged["two-accounts"]?.[twoAId]),
  JSON.stringify(merged),
);

/* ------------------------------------------------------------------ *
 * 默认地址：登记时一次成形
 *
 * 判据是「这一类平台默认指哪台」（适配器自己声明的 defaultBaseUrl）：行上的
 * 地址还等于它时，额度问插件自己那台（门户、控制台、钱包）；用户把行指到别处
 * 时，跟着行走。
 * ------------------------------------------------------------------ */

section("默认地址与额度问哪台");

const { QINIU_PORTAL_BASE } = await import("../lib/qiniu/config.ts");
const { SENSENOVA_INFER_BASE } = await import("../lib/sensenova/config.ts");
const { INTERN_AI_DISCOVERY_API_BASE } = await import("../lib/intern-ai/config.ts");
const { XINGHUO_INFER_BASE } = await import("../lib/xinghuo/config.ts");
const { TOKENRHYTHM_INFER_BASE } = await import("../lib/tokenrhythm/config.ts");

// 五家各自声明的默认地址就是各自的地址常量（值取自常量，不写字面量）。
check(
  "五家的默认地址都登记在注册表里",
  [
    ["qiniu", QINIU_INFER_BASE],
    ["sensenova", SENSENOVA_INFER_BASE],
    ["intern-ai", INTERN_AI_DISCOVERY_API_BASE],
    ["xinghuo", XINGHUO_INFER_BASE],
    ["tokenrhythm", TOKENRHYTHM_INFER_BASE],
  ].every(([kind, base]) => kindOf(String(kind))?.defaultBaseUrl === base),
  ["qiniu", "sensenova", "intern-ai", "xinghuo", "tokenrhythm"]
    .map((kind) => `${kind}=${kindOf(kind)?.defaultBaseUrl ?? ""}`)
    .join(" "),
);

// 方向一：行上的地址还等于这一类的默认地址 → 额度问插件自己那台。
// 拿七牛与星火两家做尺：七牛有额度插件（门户那台），星火没有额度接口（这一格
// 只管「默认指哪台」）。
insertVendorPlatform("xinghuo", "xinghuo-default-base", { baseUrl: XINGHUO_INFER_BASE });
const xinghuoRow = {
  id: "xinghuo-default-base",
  platform: "xinghuo-default-base",
  kind: "xinghuo",
  region: "",
  alias: "",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;
const xinghuoRowBase = String(openPlatformOf("xinghuo-default-base")?.baseUrl ?? "");
check(
  "前提：星火的默认地址就是行上的地址",
  kindOf("xinghuo")?.defaultBaseUrl === xinghuoRowBase,
  `${kindOf("xinghuo")?.defaultBaseUrl ?? ""} / ${xinghuoRowBase}`,
);
check(
  "行上的地址 == 默认地址 → 额度问插件自己那台",
  quotaEndpointBase(xinghuoRow as any, "https://vendor.invalid") === "https://vendor.invalid",
  quotaEndpointBase(xinghuoRow as any, "https://vendor.invalid"),
);

const defaultRow = { ...QINIU_ACCOUNT, platform: "qiniu", kind: "qiniu" };
const qiniuRowBase = String(openPlatformOf("qiniu")?.baseUrl ?? "");
check(
  "前提：七牛的默认地址就是行上的地址",
  kindOf("qiniu")?.defaultBaseUrl === qiniuRowBase,
  `${kindOf("qiniu")?.defaultBaseUrl ?? ""} / ${qiniuRowBase}`,
);
check(
  "七牛：行上的地址 == 默认地址 → 额度问插件自己那台",
  quotaEndpointBase(defaultRow as any, QINIU_PORTAL_BASE) === QINIU_PORTAL_BASE,
  quotaEndpointBase(defaultRow as any, QINIU_PORTAL_BASE),
);

// 方向二：行上的地址被改过 → 额度跟着行走。
store()
  .prepare("UPDATE platform SET base_url = ? WHERE id = ?")
  .run(SELF_HOSTED_BASE, "qiniu");
check(
  "行上的地址被改 → 额度问行上那台",
  quotaEndpointBase(defaultRow as any, QINIU_PORTAL_BASE) === SELF_HOSTED_BASE,
  quotaEndpointBase(defaultRow as any, QINIU_PORTAL_BASE),
);
// 改回去：后面的段落还要用这一行。
store().prepare("UPDATE platform SET base_url = ? WHERE id = ?").run(qiniuRowBase, "qiniu");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
