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
  quotaPluginOf,
  registerQuotaPlugin,
} = await import("../lib/quota-plugins.ts");
// 种类与插件都是导入时登记的：导入它，它们才都在。
await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { parseRespackOverview } = await import("../lib/qiniu/quota.ts");
const { qiniuQuotaPlugin } = await import("../lib/qiniu/quota-plugin.ts");
const { writeQiniuAccount, qiniuAccountId } = await import("../lib/qiniu/account.ts");
const { createOpenPlatform, openPlatformOf, updateOpenPlatform } = await import("../lib/open-platforms.ts");

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

/** 假上游：门户只回这一份，别的地址一律当作出错（不许真的出机器）。 */
let portalCalls = 0;
/** 门户这一轮答什么（换它来演「一包不剩」）。 */
let portalBody: unknown = OVERVIEW;
globalThis.fetch = (async (input: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? ""));
  if (!url.startsWith("https://portal.qiniu.com")) {
    throw new Error(`这个测试只认假门户：${url}`);
  }
  portalCalls++;
  return new Response(JSON.stringify(portalBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

/* ------------------------------------------------------------------ *
 * 七牛那个插件
 * ------------------------------------------------------------------ */

section("七牛的插件");

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
const legacyViews = legacyQiniuQuotas(QINIU_ACCOUNT, QUOTA);
check(
  "插件的输出与迁移前逐字段相同",
  same(pluginViews, legacyViews),
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
  pluginViews[0]?.accountId === QINIU_ACCOUNT.id && pluginViews[0]?.upstreamId === QINIU_ACCOUNT.id,
  `${pluginViews[0]?.upstreamId} / ${pluginViews[0]?.accountId}`,
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
check(
  "种类转给插件之后，数字还是那些",
  same(qiniuKind?.quotas(QINIU_ACCOUNT, kindSnapshot), pluginViews),
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
createOpenPlatform({ id: "quota-demo-bad", label: "填错插件的开放平台", baseUrl: "https://example.invalid/v1", quotaPlugin: "no-such-plugin" });

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
  // 又填错一个插件 id：写进去的时候说一次（一个平台的这个插件只说一次）。
  createOpenPlatform({
    id: "quota-demo-bad-2",
    label: "填错插件的开放平台二",
    baseUrl: "https://example.invalid/v1",
    quotaPlugin: "no-such-plugin",
  });
  // 启动校验说的是同一件事：它不再重复说（去重就是干这个的）。
  assertQuotaPlugins();
} catch {
  assertThrew = true;
} finally {
  console.warn = realWarn;
}
check("填错了插件 id → 不抛", !assertThrew);
check(
  "填错了插件 id → warn 一行",
  warnings.length === 1 && warnings[0].includes("这个平台填的额度插件没登记：no-such-plugin"),
  warnings.join(" / "),
);
check(
  "警告说的是那个 id",
  warnings.length === 1 && !warnings[0].includes("这个平台填的额度插件没登记：qiniu"),
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
  baseUrl: "https://example.invalid/v1",
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
check("文案说清了只写了推理 key", setPlain.message.includes("多余的 key 没写"), setPlain.message);
check("第二把没落到任何地方", pluginFieldOf(plainId, "account") === "", pluginFieldOf(plainId, "account"));

// 填错了插件 id：说一声，但照样写进去（用户可能先填 id 再让我们上线那个插件）。
const updateWarnings: string[] = [];
const realUpdateWarn = console.warn;
console.warn = (...args: unknown[]) => {
  updateWarnings.push(args.map((a) => String(a)).join(" "));
};
let updateThrew = false;
try {
  updateOpenPlatform("quota-demo-none", { quotaPlugin: "no-such-plugin-3" });
} catch {
  updateThrew = true;
} finally {
  console.warn = realUpdateWarn;
}
check("填错了插件 id → 不抛", !updateThrew);
check(
  "填错了插件 id → 写进去了",
  (openPlatformOf("quota-demo-none")?.quotaPlugin ?? "") === "no-such-plugin-3",
  String(openPlatformOf("quota-demo-none")?.quotaPlugin),
);
check(
  "填错了插件 id → warn 一行",
  updateWarnings.length === 1 &&
    updateWarnings[0].includes("这个平台填的额度插件没登记：no-such-plugin-3"),
  updateWarnings.join(" / "),
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
  baseUrl: "https://example.invalid/v1",
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
  quotaPlugin: "no-such-plugin-live",
});
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
