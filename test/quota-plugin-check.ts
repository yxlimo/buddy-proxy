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
  fetch: async () => null,
  quotas: () => [],
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
globalThis.fetch = (async (input: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? ""));
  if (!url.startsWith("https://portal.qiniu.com")) {
    throw new Error(`这个测试只认假门户：${url}`);
  }
  portalCalls++;
  return new Response(JSON.stringify(OVERVIEW), {
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

const fetched = await qiniuQuotaPlugin.fetch(QINIU_ACCOUNT);
const fetchedQuota = fetched as typeof QUOTA;
check("假门户被问了一次", portalCalls === 1, String(portalCalls));
check("问回来的是资源包", Array.isArray(fetchedQuota?.respacks), JSON.stringify(fetched));
check("两个包", fetchedQuota?.respacks?.length === 2, String(fetchedQuota?.respacks?.length));
check(
  "第一个包剩 3000",
  fetchedQuota?.respacks?.[0]?.remaining === 3000,
  String(fetchedQuota?.respacks?.[0]?.remaining),
);

// 没有门户 cookie 就问不了：那是「不知道」，不是「没有资源包」。
const NO_COOKIE = { ...QINIU_ACCOUNT, id: "qiniu-plugin-no-cookie" };
const before = portalCalls;
const nothing = await qiniuQuotaPlugin.fetch(NO_COOKIE);
check("没有 cookie → 拿不到额度", nothing === null, JSON.stringify(nothing));
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

const pluginViews = qiniuQuotaPlugin.quotas(QINIU_ACCOUNT, QUOTA);
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

const emptyQuota = {
  respacks: parseRespackOverview({
    code: 200,
    data: { records: OVERVIEW.data.records.map((row) => ({ ...row, month_remain: "0" })) },
  }),
  at: 1767225600000,
};
check(
  "两个包都空了 → 用尽",
  qiniuQuotaPlugin.outOfCredits?.(QINIU_ACCOUNT, emptyQuota) === true,
);
check(
  "还有一个包有剩 → 没用尽",
  qiniuQuotaPlugin.outOfCredits?.(QINIU_ACCOUNT, QUOTA) === false,
);
check(
  "没读到额度 → 不知道，不算用尽",
  qiniuQuotaPlugin.outOfCredits?.(QINIU_ACCOUNT, null) === false,
);
check(
  "读不出来的那一份 → 没有额度",
  qiniuQuotaPlugin.quotas(QINIU_ACCOUNT, null).length === 0,
);
check(
  "恢复时间不知道",
  qiniuQuotaPlugin.recoverAt?.(QINIU_ACCOUNT, emptyQuota) === null,
);

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

const qiniuKind = kindOf("qiniu");
const kindSnapshot = {
  qoder: {},
  minimax: {},
  zcode: {},
  workbuddy: {},
  tokenrhythm: {},
  sensenova: {},
  internAi: {},
  qiniu: { [QINIU_ACCOUNT.id]: { quota: QUOTA } },
  plugins: {},
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
  return {
    qoder: {},
    minimax: {},
    zcode: {},
    workbuddy: {},
    tokenrhythm: {},
    sensenova: {},
    internAi: {},
    qiniu: {},
    plugins,
  };
}

const openKind = kindOf("openai");
const withData = snapshotWithPlugins({ qiniu: { "quota-demo": QUOTA } });
const openViews = openKind?.quotas(openAccount("quota-demo"), withData) ?? [];
check("选了插件、快照里有数据 → 有额度视图", openViews.length === 1, String(openViews.length));
check(
  "额度视图与插件算出来的一样",
  same(openViews, qiniuQuotaPlugin.quotas(openAccount("quota-demo"), QUOTA)),
);
check(
  "选了插件、快照里有数据 → 用尽判定照插件说的",
  openKind?.outOfCredits(openAccount("quota-demo"), withData) === false,
);
check(
  "选了插件、快照里有数据 → 恢复时间照插件说的",
  (openKind?.recoverAt?.(openAccount("quota-demo"), withData) ?? null) === null,
);

const withoutEntry = snapshotWithPlugins({ qiniu: { "somebody-else": QUOTA } });
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
const e2ePayload = await qiniuQuotaPlugin.fetch(e2eAccount);
check("插件从开放平台的账号上问到了额度", e2ePayload !== null, JSON.stringify(e2ePayload));
const e2eViews = qiniuQuotaPlugin.quotas(e2eAccount, e2ePayload);
check("额度读得到", e2eViews.length === 1, JSON.stringify(e2eViews));
check("剩下的还是那些", e2eViews[0]?.credits?.remaining === 5000, JSON.stringify(e2eViews[0]?.credits));

// 只给推理 key：额度是「不知道」，不是「没有」。
const bare = addAccount({ platform: "quota-demo-qiniu" });
const bareId = bare.id ?? "";
check("账号加得起来", bare.ok === true && bareId !== "", bare.message);
const setBare = setProviderKeys(bareId, ["sk-demo-bare"]);
check("只写进去一段", setBare.count === 1, String(setBare.count));
check("门户 cookie 那段是空的", pluginFieldOf(bareId, "account") === "", pluginFieldOf(bareId, "account"));
const bareAccount = provider(bareId) as any;
const barePayload = await qiniuQuotaPlugin.fetch(bareAccount);
check("没有门户 cookie → 拿不到额度", barePayload === null, JSON.stringify(barePayload));
check("没有额度视图", qiniuQuotaPlugin.quotas(bareAccount, barePayload).length === 0);
check("不算用尽", qiniuQuotaPlugin.outOfCredits?.(bareAccount, barePayload) === false);

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
