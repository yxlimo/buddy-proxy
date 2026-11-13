// test/credential-plan-check.ts — 每种账号的凭据行，与收敛之前逐条一致。
//
//   node --experimental-strip-types test/credential-plan-check.ts
//
// 离线：临时数据目录，不发请求，不碰真凭据。
//
// 这一份是那次重构的等价性证据：`credentialsOf()` 从「按 kind 写死的 switch」
// 改成「按种类的声明遍历」，唯一能证明「没改坏」的就是这张表 —— 每个平台在面板上
// 出现的行、顺序、label、条数，一条一条对。
//
// 四件事：
//
//   1. 没配凭据时列哪几行（会话型的那几家连没配也要列：面板上要看得见「还没
//      登录」）
//   2. 配齐了以后列哪几行、什么顺序、什么 label、哪一行算推理凭据
//   3. 面板上填凭据那几格的 label 只许是那几种口径（推理 Key / 额度 Cookie /
//      额度凭据 / 插件自己的 label）—— 屏幕上是业务词，不是契约词
//   4. 条数自洽：账号行上的 credentialCount 就是它名下实际列出的行数
//
// 那张表的行、顺序、条数是照收敛之前的实测结果记下来的（不是从新实现推出来的）：
// 照新实现抄一遍就等于什么也没验。label 那一列是这次要收成的目标口径（收敛前
// 同一个平台有几套叫法），不是旧实测的原样。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "credential-plan-"));
process.env.BUDDY_DATA_DIR = tmp;

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log("");
  console.log(name);
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const { addAccount, provider } = await import("../lib/providers.ts");
const { credentialsOf, listAccounts, listCredentials } = await import("../lib/admin/accounts.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { allKinds, credentialsOfKind, selectableKinds } = await import("../lib/provider-kinds.ts");
const { setSecret } = await import("../lib/store.ts");
const { createOpenPlatform } = await import("../lib/open-platforms.ts");
const { insertVendorPlatform } = await import("./vendor-platform.ts");
const { registerQuotaPlugin, allQuotaPlugins, quotaPluginOf } = await import("../lib/quota-plugins.ts");
const { pluginFieldOf } = await import("../lib/quota-plugin-credentials.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

/** 面板上的那一行，取出来比对的三样：label、形态、算不算推理凭据。 */
function rowsOf(accountId: string): [string, string, boolean][] {
  return credentialsOf(accountId).map((row) => [row.label, row.kind, row.inference]);
}

/** 一张表的比对：行、顺序、label 都按这一份。 */
function sameRows(name: string, actual: [string, string, boolean][], expected: [string, string, boolean][]): void {
  check(name, show(actual) === show(expected), `实际 ${show(actual)}，应当 ${show(expected)}`);
}

/* ------------------------------------------------------------------ *
 * 一、那张表：每个平台在面板上列哪几行
 * ------------------------------------------------------------------ */

/**
 * 平台 id → 面板上的行。
 *
 * key 是**平台**而不是 kind：区域不同的那几家（Qoder 全球区与中国区、
 * WorkBuddy 中国区与国际区）是各自的平台，各自一行 —— 面板上它们是四个平台，
 * 凭据形状一样，但每一行都要验。
 */
const PLATFORM_ROWS: Record<string, [string, string, boolean][]> = {
  // 会话型：一行，且那行就是推理凭据。
  minimax: [["登录会话", "session", true]],
  qoder: [["登录会话", "session", true]],
  "qoder-cn": [["登录会话", "session", true]],
  "workbuddy-cn": [["登录会话", "session", true]],
  "workbuddy-global": [["登录会话", "session", true]],
  zcode: [["登录会话", "session", true]],
  // 会话只用来问额度：推理用的是那把 key。
  sensenova: [
    ["登录会话", "session", false],
    ["推理 Key", "api_key", true],
  ],
  "intern-ai": [
    ["登录会话", "session", false],
    ["推理 Key", "api_key", true],
  ],
  // key 先列：干活的那一段在前面。
  tokenrhythm: [
    ["推理 Key", "api_key", true],
    ["登录会话", "session", false],
  ],
  qiniu: [
    ["推理 Key", "api_key", true],
    ["额度 Cookie", "cookie", false],
  ],
  xinghuo: [["推理 Key", "api_key", true]],
};

/** 厂商那几家的平台行是用户在面板上建的：库里没有就是没有，测试自己插一行。 */
const VENDOR_KINDS = ["sensenova", "intern-ai", "tokenrhythm", "qiniu", "xinghuo"];

/** 没配凭据时列哪几行。 */
const EMPTY_ROWS: Record<string, [string, string, boolean][]> = {
  // 会话型：没配也列一行（面板上要看得见「还没登录」）
  minimax: [["登录会话", "session", true]],
  qoder: [["登录会话", "session", true]],
  "qoder-cn": [["登录会话", "session", true]],
  "workbuddy-cn": [["登录会话", "session", true]],
  "workbuddy-global": [["登录会话", "session", true]],
  zcode: [["登录会话", "session", true]],
  // 会话 + 推理 key：没配的 key 不列
  sensenova: [["登录会话", "session", false]],
  "intern-ai": [["登录会话", "session", false]],
  // 登录会话列着，推理 key 没配就不列
  tokenrhythm: [["登录会话", "session", false]],
  // 两段都没有：一条也不列（面板上不能出现「有凭据」却没有凭据的行）
  qiniu: [],
  xinghuo: [],
};

section("没配凭据");

const accountOf: Record<string, string> = {};
/** 账号 → 它所在的平台 id。开放平台那两家与别的平台不在一张表里。 */
const platformOfAccount: Record<string, string> = {};
for (const platform of Object.keys(PLATFORM_ROWS)) {
  // 厂商那几家（七牛云 / 星火 / SenseNova / 端砚 / TokenRhythm）的行是用户在面板
  // 上建的：库里没有就是没有，测试自己插一行。模拟客户端那一族启动时已经播种好了
  // （它们没有 defaultBaseUrl，不是「厂商那几行」的口径）。
  if (VENDOR_KINDS.includes(platform)) insertVendorPlatform(platform);
  const made = addAccount({ platform, alias: `测试 ${platform}` });
  if (!made.ok || !made.id) {
    check(`${platform}：账号建得起来`, false, made.message);
    continue;
  }
  accountOf[platform] = String(made.id);
  platformOfAccount[platform] = platform;
  sameRows(`${platform}：没配凭据时的行`, rowsOf(String(made.id)), EMPTY_ROWS[platform] ?? []);
}

/* ------------------------------------------------------------------ *
 * 二、配齐了以后列哪几行（顺序与 label 也要一致）
 * ------------------------------------------------------------------ */

section("配齐了以后");

/**
 * 会话那一份记录：形状与各家真写进去的一致。
 *
 * 直接写库不绕开什么 —— 会话本来就不是「填 key」那一条路写进来的（它由登录写），
 * 所以这里照着登录写下去的样子造一份。
 */
function seedSession(accountId: string, extra: Record<string, unknown> = {}): void {
  setSecret(`session:provider:${accountId}`, "session", {
    accessToken: "at-TESTONLY-session",
    refreshToken: "rt-TESTONLY-session",
    expiresAtMs: Date.now() + 3600_000,
    generation: 1,
    obtainedAtMs: Date.now(),
    refreshedAtMs: Date.now(),
    ...extra,
  });
}

/** 拿 setProviderKeys 写（面板上真正走的那条路）。 */
function seedKeys(platform: string, values: string[]): void {
  const id = accountOf[platform];
  if (!id) return;
  const result = setProviderKeys(id, values);
  check(`${platform}：面板上写得进去`, result.ok && result.count > 0, result.message);
}

for (const [platform, id] of Object.entries(accountOf)) {
  if (platform === "intern-ai") {
    // 书生·端砚的会话只有一把 token（没有过期的说法）。
    setSecret(`session:provider:${id}`, "session", { token: "tok-TESTONLY", obtainedAtMs: Date.now() });
  } else if (platform === "tokenrhythm") {
    // TokenRhythm 的会话是 cookie + csrf：平台自己那套校验不认 access token
    // 那种形状，写了也不算有会话（旧实现同样把它列成 missing）。所以这里按它
    // 自己的形状播 —— 造一个假的会话凑行数就是骗自己。
    setSecret(`session:provider:${id}`, "session", {
      cookie: "SESSION=TESTONLY",
      csrf: "csrf-TESTONLY",
      userId: "u-TESTONLY",
      name: "测试账号",
      obtainedAtMs: Date.now(),
      expiresAtMs: Date.now() + 3600_000,
    });
  } else {
    seedSession(id);
  }
}
seedKeys("sensenova", ["sk-TESTONLY-sense"]);
seedKeys("intern-ai", ["sk-TESTONLY-discovery"]); // privacy:allow — 编造的样例
seedKeys("tokenrhythm", ["sk-TESTONLY-wallet"]);
seedKeys("qiniu", ["sk-TESTONLY-qiniu", "c=TESTONLY"]);
seedKeys("xinghuo", ["sk-TESTONLY-xinghuo"]); // privacy:allow — 编造的样例

for (const [platform, id] of Object.entries(accountOf)) {
  // 那一行的第三列就是「算不算推理凭据」：sameRows 逐行比过了。原来这里另有一条
  // 拿 canInfer 再算一遍的断言 —— rowOf 里就是它算的，恒真，删了。
  sameRows(`${platform}：配齐后的行（顺序、label、哪一行算推理）`, rowsOf(id), PLATFORM_ROWS[platform] ?? []);
  const rows = credentialsOf(id);
  check(
    `${platform}：配齐后没有 missing 的行`,
    rows.every((row) => row.status !== CredentialState.MISSING),
    show(rows.map((row) => `${row.label}:${row.status}`)),
  );
}

/* ------------------------------------------------------------------ *
 * 三、条数自洽：credentialCount 就是实际列出的行数
 * ------------------------------------------------------------------ */

section("条数自洽");

for (const [platform, id] of Object.entries(accountOf)) {
  // 面板上的两处数字：账号行上的 credentialCount，与凭据表里列出的行数。
  // 这两个是两次读出来的（一次读全部账号，一次读某一个账号的凭据），不一致就是
  // 面板上「3 条」但表里 2 行那种毛病。
  const listed = listCredentials(id).length;
  const view = listAccounts().find((a) => a.id === id);
  check(
    `${platform}：账号行上的 credentialCount 就是列出的行数`,
    view?.credentialCount === listed,
    `账号行 ${view?.credentialCount}，列出 ${listed}`,
  );
}

/* ------------------------------------------------------------------ *
 * 四、开放平台：一把推理 Key + 额度插件各要的那几段
 * ------------------------------------------------------------------ */

section("开放平台");

// 一个要两段凭据的额度插件（只在这个进程里登记）。
//
// 插件声明的 label 就是面板上那一格的名字（一处产出）：凭据行与填凭据的弹窗
// 读的都是它，别处不再按「label 里有没有 cookie」猜一遍。
registerQuotaPlugin({
  id: "test-portal",
  label: "带门户的额度",
  fields: [
    { name: "portal_account", label: "额度凭据", secret: false },
    { name: "portal_cookie", label: "额度 Cookie", secret: true },
  ],
  probe: async () => ({ state: "unknown", views: [], recoverAt: null, message: "测试不出去" }),
});

/** 通用开放平台：两种方言各建一行，插件同一份 —— 凭据形状应该一模一样。 */
const OPEN_PLATFORMS = ["openai", "anthropic"] as const;

for (const kind of OPEN_PLATFORMS) {
  const platformId = `test-open-${kind}`;
  const open = createOpenPlatform({
    id: platformId,
    label: `带两段凭据的 ${kind} 平台`,
    baseUrl: "http://127.0.0.1:1",
    kind,
    quotaPlugin: "test-portal",
  });
  check(`${kind}：开放平台建得起来`, open.ok, open.message);

  const openAccount = addAccount({ platform: platformId, alias: `${kind} 账号` });
  const openId = String(openAccount.id ?? "");
  check(`${kind}：开放平台的账号建得起来`, openAccount.ok && openId !== "", openAccount.message);

  // 没填：插件那两段各占一行（面板上要看得见「这段还没填」），推理 key 不列。
  sameRows(
    `${kind}：没填时只有插件那两行（missing）`,
    rowsOf(openId),
    [
      ["额度凭据", "cookie", false],
      ["额度 Cookie", "cookie", false],
    ],
  );
  check(
    `${kind}：插件那两行是 missing`,
    credentialsOf(openId).every((row) => row.status === CredentialState.MISSING),
    show(credentialsOf(openId).map((row) => [row.label, row.status])),
  );

  // 三项：推理 key + 插件那两段。位置就是顺序。
  const wrote = setProviderKeys(openId, ["sk-TESTONLY-open", "portal-user", "portal-cookie-1"]);
  check(`${kind}：三项都写得进去`, wrote.ok && wrote.count === 3, `${wrote.message} / ${wrote.count}`);
  check(
    `${kind}：插件的第一段读得回来`,
    pluginFieldOf(openId, "portal_account") === "portal-user",
    pluginFieldOf(openId, "portal_account"),
  );
  sameRows(`${kind}：配齐后的行（推理 Key 在最前）`, rowsOf(openId), [
    ["推理 Key", "api_key", true],
    ["额度凭据", "cookie", false],
    ["额度 Cookie", "cookie", false],
  ]);

  const view = listAccounts().find((a) => a.id === openId);
  check(
    `${kind}：开放平台的 credentialCount 就是列出的行数`,
    view?.credentialCount === listCredentials(openId).length,
    `账号行 ${view?.credentialCount}，列出 ${listCredentials(openId).length}`,
  );

  // 拿到真平台行时，格子必须是完整集合：推理 Key + 插件每一段一格，顺序就是
  // 位置。少一格，面板就少发一段，服务端按位置写下去会把那一段清掉。
  const withRow = credentialsOfKind(kind).fields({ id: openId, platform: platformId, kind });
  const pluginFields = quotaPluginOf("test-portal")?.fields ?? [];
  check(
    `${kind}：有平台行时格子是「推理 Key + 插件那几段」`,
    show(withRow.map((f) => f.label)) === show(["推理 Key", ...pluginFields.map((f) => f.label)]),
    `实际 ${show(withRow.map((f) => f.label))}`,
  );

  accountOf[`open:${kind}`] = openId;
  platformOfAccount[`open:${kind}`] = platformId;
}

/* ------------------------------------------------------------------ *
 * 五、种类自己定死的那一格：没有平台上下文也要给
 * ------------------------------------------------------------------ */

section("种类自己定死的那一格（selectableKinds）");

/**
 * 面板问「有哪些种类」时拿到的格子。
 *
 * 这一份没有平台上下文（种类登记表不是平台登记表）：种类自己定死的那一格必须
 * 无条件在里面。开放平台那两家的推理 Key 曾经因为「查不到平台行」整份返回空数组，
 * 于是面板一格也画不出来、保存被段数校验挡下 —— 一个字也写不进去。
 */
const selectable = selectableKinds();
for (const kind of OPEN_PLATFORMS) {
  const row = selectable.find((k) => k.kind === kind);
  check(
    `${kind}：种类登记表里就有「推理 Key」那一格`,
    (row?.credentialFields ?? []).some((f) => f.label === "推理 Key"),
    show(row?.credentialFields ?? []),
  );
  // 插件那几段不在这一份里：它们挂在平台那一行上，这里没有平台行。
  check(
    `${kind}：种类登记表里只有定死的那一格（插件那几段不在）`,
    (row?.credentialFields ?? []).length === 1,
    show((row?.credentialFields ?? []).map((f) => f.label)),
  );
}

/* ------------------------------------------------------------------ *
 * 五、面板上填凭据那几格的 label
 * ------------------------------------------------------------------ */

section("填凭据那几格的 label");

/** 屏幕上允许出现的几种口径（业务词，不是契约词）。 */
const ALLOWED_FIELD_LABELS = new Set(["推理 Key", "额度 Cookie", "额度凭据"]);

// 额度插件自己给的那几格可以有它自己的 label（插件知道它问的是什么）。把它
// 们也算进允许的那几种里 —— 但只算插件登记在册的那些。
for (const plugin of allQuotaPlugins()) {
  for (const field of plugin.fields) ALLOWED_FIELD_LABELS.add(field.label);
}

/** 以前屏幕上的那些叫法：换了口径以后不该再出现。 */
const OLD_LABELS = ["推理 API Key", "门户 Cookie"];

/**
 * 每个平台的凭据格。
 *
 * 开放平台那两类的格子是**平台**说了算的（插件由平台指名）：拿一个不存在的平台
 * 去问，答回来的是空数组 —— 那不是「没有格子」，是没问到。所以这里一个平台一个
 * 平台地问。
 */
for (const [platform, id] of Object.entries(accountOf)) {
  const platformId = platformOfAccount[platform];
  const kind = provider(id)?.kind ?? "";
  const plan = credentialsOfKind(kind);
  const fields = plan.fields({ id, platform: platformId, kind });
  for (const field of fields) {
    check(
      `${platform}：格子「${field.label}」是那几种口径之一`,
      ALLOWED_FIELD_LABELS.has(field.label),
      field.label,
    );
    check(
      `${platform}：格子「${field.label}」不带旧叫法`,
      !OLD_LABELS.includes(field.label),
      field.label,
    );
  }
  // 会话型的几家：一格也不填（贴 key 过来服务端只能拒）。
  const sessionOnly = ["minimax", "qoder", "workbuddy", "zcode"].includes(kind);
  if (sessionOnly) {
    check(`${platform}：不收 key（没有格子）`, fields.length === 0, String(fields.length));
  }
}

/**
 * 每一家都有一行断言。
 *
 * 注册表里多了一个种类而这张表没跟上，那一条就不会被验 —— 所以这里按注册表
 * 自己数：每个 kind 都要有平台在表里。
 */
const COVERED_KINDS = new Set(
  Object.values(accountOf).map((id) => provider(id)?.kind ?? ""),
);
for (const kind of allKinds()) {
  check(`kind ${kind.kind}：有平台在表里（每家都被验到）`, COVERED_KINDS.has(kind.kind), [...COVERED_KINDS].join(","));
}

/* ------------------------------------------------------------------ *
 * 六、按位置写：格子的段数就是写的段数
 * ------------------------------------------------------------------ */

section("按位置写");

const FIELD_COUNT: Record<string, number> = {
  qiniu: 2,
  xinghuo: 1,
  sensenova: 1,
  "intern-ai": 1,
  tokenrhythm: 1,
  openai: 1,
  anthropic: 1,
};

// 开放平台的格子有一格是平台自己指的插件带进来的：这里看的是「没选插件」的那一
// 行 —— 种类自己定死的就是推理那一格，插件那几段由平台那一行接在后面。
createOpenPlatform({
  id: "test-open-plain",
  label: "没选插件的开放平台",
  baseUrl: "http://127.0.0.1:1",
  kind: "openai",
});

for (const [kind, count] of Object.entries(FIELD_COUNT)) {
  const plan = credentialsOfKind(kind);
  const platform = kind === "openai" || kind === "anthropic" ? "test-open-plain" : kind;
  const owner = { id: platform, platform, kind };
  const fields = plan.fields(owner);
  check(`${kind}：要填 ${count} 格`, fields.length === count, String(fields.length));
}

// 清掉：空串表示清掉那一段，全空就是都清掉 —— 与七牛云、讯飞星火一个语义。
{
  const id = accountOf["qiniu"];
  const cleared = setProviderKeys(id, ["", ""]);
  check("七牛云：两段都清掉", cleared.ok && cleared.count === 0, `${cleared.message} / ${cleared.count}`);
  sameRows("七牛云：清掉后一条也不列", rowsOf(id), []);
  const one = setProviderKeys(id, ["sk-TESTONLY-qiniu-2", ""]); // privacy:allow — 编造的样例
  check("七牛云：只写推理 key", one.ok && one.count === 1, `${one.message} / ${one.count}`);
  sameRows("七牛云：只剩推理 Key 那一行", rowsOf(id), [["推理 Key", "api_key", true]]);
}

/* ------------------------------------------------------------------ *
 * 七、会话的状态：过期、被平台拒过、记录在而 token 空
 * ------------------------------------------------------------------ */

section("会话的状态");

/**
 * 这三条是「配齐了就能用」之外的三个分支。
 *
 * 没有它们的话，把 sessionSlot 里的 refused/expiresAt 改成「永不过期、永不作废」
 * 也能全绿 —— 那正是等价性证据里最大的洞。
 */
const { markSessionDead, clearDeadSession } = await import("../lib/session.ts");

// ① 记录在，但 expiresAtMs 已过 → EXPIRED（不是「还能用」，也不是「没配」）。
{
  const id = accountOf["minimax"];
  seedSession(id, { expiresAtMs: Date.now() - 1000 });
  const row = credentialsOf(id).find((c) => c.kind === "session");
  check(
    "会话过期了：状态是 EXPIRED",
    row?.status === CredentialState.EXPIRED,
    `状态 ${row?.status}，到期 ${row?.expiresAt}`,
  );
  // 对照：没过期就是能用（不然上一条可能是「什么都算 EXPIRED」蒙对的）。
  seedSession(id);
  check(
    "会话没过期：状态是 USABLE",
    credentialsOf(id).find((c) => c.kind === "session")?.status === CredentialState.USABLE,
    String(credentialsOf(id).find((c) => c.kind === "session")?.status),
  );
}

// ② 平台拒过这份会话（deadSession）→ EXPIRED，且 lastError 说得出缘故。
{
  const id = accountOf["minimax"];
  const secretId = `session:provider:${id}`;
  markSessionDead(secretId, "平台拒了这份会话");
  const row = credentialsOf(id).find((c) => c.kind === "session");
  check(
    "平台拒过的会话：状态是 EXPIRED",
    row?.status === CredentialState.EXPIRED,
    `状态 ${row?.status}`,
  );
  check(
    "平台拒过的会话：lastError 说的是要重新授权",
    row?.lastError === "这份会话已经失效，需要重新授权",
    String(row?.lastError),
  );
  clearDeadSession(secretId);
  check(
    "忘掉那次拒绝之后：会话又能用了",
    credentialsOf(id).find((c) => c.kind === "session")?.status === CredentialState.USABLE,
    String(credentialsOf(id).find((c) => c.kind === "session")?.status),
  );
}

// ③ 只有一把 token 的会话（书生·端砚）：记录在而 token 空 → MISSING。
// 记录在就算配好了的话，「没配」会被说成「能用」。
{
  const id = accountOf["intern-ai"];
  setSecret(`session:provider:${id}`, "session", { token: "", obtainedAtMs: Date.now() });
  const row = credentialsOf(id).find((c) => c.kind === "session");
  check(
    "token 空的会话：状态是 MISSING（记录在也不算配好）",
    row?.status === CredentialState.MISSING,
    `状态 ${row?.status}`,
  );
  setSecret(`session:provider:${id}`, "session", { token: "tok-TESTONLY", obtainedAtMs: Date.now() });
  check(
    "token 回来了：状态是 USABLE",
    credentialsOf(id).find((c) => c.kind === "session")?.status === CredentialState.USABLE,
    String(credentialsOf(id).find((c) => c.kind === "session")?.status),
  );
}

/* ------------------------------------------------------------------ *
 * 八、面板夹具与后端声明对账
 * ------------------------------------------------------------------ */

section("面板夹具与后端声明对账");

/**
 * 面板测试用的那份种类登记表（web/src/test/provider-kinds-data.ts）。
 *
 * 它曾经手写出后端不会返回的格子（开放平台的推理 Key），于是面板那几条用例绿在
 * 假数据上。这里逐字段比：夹具里有的每一类，后端都得给出一模一样的六样。
 */
const { PROVIDER_KIND_ROWS } = await import("../web/src/test/provider-kinds-data.ts");
const declaredKinds = new Map(selectableKinds().map((row) => [row.kind, row]));
for (const fixture of PROVIDER_KIND_ROWS) {
  const backend = declaredKinds.get(fixture.kind);
  check(`夹具 ${fixture.kind}：后端登记了这一类`, Boolean(backend), fixture.kind);
  if (!backend) continue;
  for (const key of ["label", "login", "credentialTitle"] as const) {
    check(
      `夹具 ${fixture.kind}：${key} 与后端一致`,
      fixture[key] === backend[key],
      `夹具 ${show(fixture[key])}，后端 ${show(backend[key])}`,
    );
  }
  check(
    `夹具 ${fixture.kind}：policies 与后端一致`,
    show(fixture.policies) === show(backend.policies),
    `夹具 ${show(fixture.policies)}，后端 ${show(backend.policies)}`,
  );
  check(
    `夹具 ${fixture.kind}：凭据格子与后端一致（一格不多一格不少）`,
    show(fixture.credentialFields) === show(backend.credentialFields),
    `夹具 ${show(fixture.credentialFields)}，后端 ${show(backend.credentialFields)}`,
  );
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
