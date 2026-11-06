// test/open-platforms-check.ts — 平台的数据源：表里的行。
//
//   node --experimental-strip-types test/open-platforms-check.ts
//
// 离线：一个临时数据目录，不起服务，不发请求，不碰真凭据。
//
// 平台的唯一数据源是表（lib/open-platforms.ts 那张 platform 表）：模拟客户端那一族
// 由启动时的播种补行（lib/platform-catalog.ts 的 SIMULATED_CLIENTS），厂商那几家由
// 平台模板表补行，用户自己加的就是面板上建的那一行。代码里的模板名单已清空
// （lib/platform-templates.ts 的 PLATFORMS 是空的）。
//
// 这里查的是：
//
//   1. 建一行 → 平台列表多出一条，kind 是 openai
//   2. id 的规矩：不合法、保留字、跟播种进来的行重名、跟账号重名、重名，都不收
//   3. 播种进来的那一族就是普通的行：改得动、删得掉；删过的留墓碑，重启不长
//      回来，用户再建回来就清墓碑
//   4. 改名字、改地址、改模型目录（手写的目录 source 是 manual）；没收登记的
//      额度插件 id（没登记就不写库，原值留着）
//   5. 删掉以后平台列表回到基线
//   6. 坏掉的目录 JSON 读成空目录，不抛
//   7. 账号 id 与平台 id 相互独立：账号 id 是自增数，关联只靠 provider.platform
//   8. 只加载 lib/open-platforms.ts 的进程里，播种照样跑完（不靠谁先引平台层）
//   9. 表里那几行的 kind 是它们自己那一类（不是清一色的 openai）
//  10. 能建的平台种类：建的时候带 kind 写进去的是它、不带是 openai、不在清单
//      里的（厂商那几家）拒收、建好之后换不了类型
//  11. 预置的模拟客户端：按（kind, id）挑预置，建出来地址空、目录不自动拉、
//      区域照目录；id 自己取不收，目录里藏起来的那一条不给建
//  12. 上游模型清单里的参数：按一张路径表取（不按平台分支），取不到就不写；
//      参数跟着清单落在平台行里，行里的优先于代码表；星火的目录归上游
//
// 断言里不写平台的个数：一律跟表里的行数比。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-platforms-"));
// 数据目录要在库被打开之前定下来：库是第一次用的时候才开的。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { allPlatforms, platformOfAny } = await import("../lib/platforms.ts");
const {
  createOpenPlatform,
  updateOpenPlatform,
  deleteOpenPlatform,
  listOpenPlatforms,
  openPlatformOf,
} = await import("../lib/open-platforms.ts");
const { addAccount, provider } = await import("../lib/providers.ts");
const { store, closeStore, migratePlatforms, migrateSimulatedClients, platformPresetRemoved } =
  await import("../lib/store.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
// 引用即登记：这一节要拿 kind.models() 报的代码目录做对照。
await import("../lib/kinds/index.ts");
const { PLATFORM_KIND_OPTIONS, SIMULATED_CLIENTS, platformKindOptionOf, platformKindChoices } =
  await import("../lib/platform-catalog.ts");
// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：后面几节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
const { XINGHUO_MODELS } = await import("../lib/xinghuo/models.ts");

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

/**
 * 平台列表应该有几条。
 *
 * 就是表里的行数（代码里的模板名单已清空）：不写死个数，跟着数据源走。
 */
function expectedPlatformCount(): number {
  return listOpenPlatforms().length;
}

/** 启动时播进来的那几行的 id：目录里 hidden 的不播。 */
const SEEDED_IDS = new Set(SIMULATED_CLIENTS.filter((c) => !c.hidden).map((c) => c.id));

/** 目录里会播种的那几条：hidden 的不播（目录里留着条目，表里没有行）。 */
const SEEDED = SIMULATED_CLIENTS.filter((c) => !c.hidden);
const HIDDEN = SIMULATED_CLIENTS.filter((c) => c.hidden);

/**
 * 用户自己建的行：不是启动时播进来的那几行。
 *
 * 播进来的那几行用的是目录里的 id（minimax、qoder-cn 之类），它们在表里，但不算
 * 「用户加的开放平台」。
 */
function userPlatformRows(): { id: string }[] {
  return listOpenPlatforms().filter((row) => !SEEDED_IDS.has(row.id));
}

/**
 * 一个最小的账号行：这几家的 models() 只看 kind（只有开放平台那一类看平台行）。
 *
 * 造它而不是真去加一个账号：这一节查的是目录，加账号会顺带写凭据。
 */
function codeRow(platform: string) {
  return {
    id: "0",
    platform,
    kind: openPlatformOf(platform)?.kind ?? "",
    region: "",
    alias: "",
    enabled: true,
    weight: 0,
    policy: "single" as const,
    createdAt: 0,
    updatedAt: 0,
  };
}

section("新库");

check(
  "新库里的平台就是模板 + 迁移补进来的那几行",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);
check(
  "新库里没有用户自己建的开放平台行",
  userPlatformRows().length === 0,
  userPlatformRows().map((r) => r.id).join(","),
);
check(
  "平台列表跟数据源对得上",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);

section("厂商那几行：不在表里");

// 厂商那几行（七牛云、星火、SenseNova、端砚、TokenRhythm）不再由代码补：平台行
// 是用户在面板上自己建的，代码里没有模板表了。新库启动后表里只有目录里该播的
// 那几条。
const VENDOR_ROWS = ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"];
check(
  "新库启动后厂商那几行都不在表里",
  VENDOR_ROWS.every((id) => openPlatformOf(id) === null),
  VENDOR_ROWS.filter((id) => openPlatformOf(id) !== null).join(","),
);

// 已有库的行不被任何启动逻辑改写：人工写死的那一份目录，重启之后还是那一份
// （以前那一轮播种会把它按来源判断一遍）。
const manualSeeded = createOpenPlatform({
  id: "seed-manual-row",
  label: "Seed Manual",
  baseUrl: "https://api.manual.test/v1",
});
check("人工目录的行建得起来", manualSeeded.ok === true, manualSeeded.message);
updateOpenPlatform("seed-manual-row", { models: ["hand-1"] });
closeStore();
store();
const manualAfter = openPlatformOf("seed-manual-row");
check(
  "重启没改人工目录的模型",
  (manualAfter?.models.items ?? []).join(",") === "hand-1",
  JSON.stringify(manualAfter?.models),
);
check(
  "重启没把自动那一格打开",
  manualAfter?.models.auto === false,
  JSON.stringify(manualAfter?.models),
);
check(
  "人工目录的来源还是 manual",
  manualAfter?.models.source === "manual",
  JSON.stringify(manualAfter?.models),
);
// 删掉：后面的计数按「用户自己建的行」算。
deleteOpenPlatform("seed-manual-row");

// 模拟客户端那一族：该播的那几条都播成了表里的行，kind、区域与名字跟目录一致。
//
// 「清空模板 + 播种」这一对改动的判别力就在这里：代码里的名单空了，平台仍然
// 在，因为启动时把目录播进了表。
check(
  "该播种的模拟客户端都播成了行",
  SEEDED.length > 0 && SEEDED.every((c) => openPlatformOf(c.id) !== null),
  SEEDED.filter((c) => openPlatformOf(c.id) === null)
    .map((c) => c.id)
    .join(","),
);
for (const client of SEEDED) {
  const seeded = openPlatformOf(client.id);
  check(`${client.id} 的 kind 是目录里的`, seeded?.kind === client.kind, String(seeded?.kind));
  check(
    `${client.id} 的区域是目录里的`,
    seeded?.region === client.region,
    JSON.stringify(seeded?.region),
  );
  check(`${client.id} 的名字是目录里的`, seeded?.label === client.label, String(seeded?.label));
  check(
    `${client.id} 在平台列表里的 kind 也是它`,
    platformOfAny(client.id)?.kind === client.kind,
    String(platformOfAny(client.id)?.kind),
  );
  check(`${client.id} 的地址是空的`, seeded?.baseUrl === "", JSON.stringify(seeded?.baseUrl));
  check(`${client.id} 不自动拉目录`, seeded?.models.auto === false, JSON.stringify(seeded?.models));
}
// hidden 的那一条目录里有、表里没有：播出来就是一个地址、目录、额度全空的平台，
// 面板上看得见却用不了。
check(
  "hidden 的那一条没播成行",
  HIDDEN.length > 0 && HIDDEN.every((c) => openPlatformOf(c.id) === null),
  HIDDEN.map((c) => `${c.id}:${openPlatformOf(c.id) !== null}`).join(","),
);

const countBeforeCreate = allPlatforms().length;
const created = createOpenPlatform({
  id: "acme",
  label: "Acme",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
});
check("开放平台加得进去", created.ok === true, created.message);
check(
  "表里多了一行",
  userPlatformRows().length === 1,
  userPlatformRows().map((r) => r.id).join(","),
);
check(
  "平台列表多了一条",
  allPlatforms().length === countBeforeCreate + 1,
  `${allPlatforms().length} vs ${countBeforeCreate}`,
);
const row = openPlatformOf("acme");
check(
  "这一行读得回来",
  row?.label === "Acme" && row?.baseUrl === "https://api.acme.test/v1" && row?.quotaPlugin === "qiniu",
  JSON.stringify(row),
);
check("查得到这个平台", platformOfAny("acme")?.id === "acme", JSON.stringify(platformOfAny("acme")));
check(
  "开放平台的 kind 是 openai",
  platformOfAny("acme")?.kind === "openai",
  String(platformOfAny("acme")?.kind),
);
check("开放平台没有区域", platformOfAny("acme")?.region === "", JSON.stringify(platformOfAny("acme")?.region));
check("模型目录先是空的", row?.models.items.length === 0, JSON.stringify(row?.models));
check("新库里的目录还自动拉", row?.models.auto === true, JSON.stringify(row?.models));
check("开放平台那一行的 kind 是 openai", row?.kind === "openai", String(row?.kind));
check("开放平台那一行没有区域", row?.region === "", JSON.stringify(row?.region));

section("id 的规矩");

check(
  "同 id 的第二行不收",
  createOpenPlatform({ id: "acme", label: "又一个", baseUrl: "https://api.acme.test/v1" }).ok === false,
);
check(
  "跟播种进来的模拟客户端同 id 的不收",
  createOpenPlatform({
    id: "qoder",
    label: "撞播种",
    baseUrl: "https://api.acme.test/v1",
  }).ok === false,
);
const reserved = ["v1", "admin", "health", "healthz", "metrics"];
check(
  "网关自己占着的 id 不收",
  reserved.every(
    (id) => createOpenPlatform({ id, label: "保留字", baseUrl: "https://api.acme.test/v1" }).ok === false,
  ),
  reserved.join(","),
);
const badIds = ["Acme", "-acme", "ac_me", "acme!", "a".repeat(32), ""];
check(
  "不合法的 slug 不收",
  badIds.every(
    (id) => createOpenPlatform({ id, label: "不合法", baseUrl: "https://api.acme.test/v1" }).ok === false,
  ),
  badIds.join(","),
);
check("地址不收", createOpenPlatform({ id: "nobase", label: "没地址", baseUrl: "" }).ok === false);
check(
  "地址不是网址不收",
  createOpenPlatform({ id: "nobase", label: "地址不对", baseUrl: "api.acme.test" }).ok === false,
);
check(
  "地址不是 http 不收",
  createOpenPlatform({ id: "nobase", label: "协议不对", baseUrl: "ftp://api.acme.test" }).ok === false,
);
check(
  "上面那些都没写进表",
  userPlatformRows().length === 1,
  userPlatformRows().map((r) => r.id).join(","),
);

section("播种的行就是普通的行");

// 上一单里这些行是代码里的模板：改不了、删不了，表里同 id 的那一行当没有。
// 现在它们是表里的行，跟用户自己建的没有区别 —— 差别只在 kind（lib/platform-catalog.ts
// 的 isSimulatedClientKind），面板与路由按 kind 判别，不按「在不在代码名单里」。
const seededId = SIMULATED_CLIENTS[0].id;
// 名字是用户的值（面板、脚本都能写）：模拟客户端那一行也改得动，只是地址不收
// （那一格由预置定死），所以改名字不需要送 base_url。
const seededRename = updateOpenPlatform(seededId, { label: "我改的名字" });
check("模拟客户端的行改得动名字", seededRename.ok === true, seededRename.message);
check(
  "改完地址还是空串（预置定死）",
  openPlatformOf(seededId)?.baseUrl === "",
  JSON.stringify(openPlatformOf(seededId)?.baseUrl),
);
// 再跑一次迁移：已有的行不动 —— 用户改的名字不能被启动时的播种拨回目录值。
migrateSimulatedClients(store());
check(
  "再播种一次不覆盖用户改的名字",
  openPlatformOf(seededId)?.label === "我改的名字",
  String(openPlatformOf(seededId)?.label),
);
const rowsBeforeDelete = listOpenPlatforms().length;
const seededDelete = deleteOpenPlatform(seededId);
check("播种的行删得掉", seededDelete.ok === true, seededDelete.message);
check(
  "表里少了一行",
  listOpenPlatforms().length === rowsBeforeDelete - 1,
  listOpenPlatforms().map((r) => r.id).join(","),
);
// 删预置的行要留墓碑：只删行的话，下次启动播种又插回一个地址、目录、额度全空的
// 平台 —— 「删了就是没了」得由这一行兑现。
//
// 这一条不能只看「行没长回来」：把播种整段去掉也能过，那等于把功能删了也绿。
check("删预置的行留了墓碑", platformPresetRemoved(seededId) === true);
migrateSimulatedClients(store());
check(
  "删掉之后重启不长回来",
  openPlatformOf(seededId) === null,
  String(openPlatformOf(seededId)?.label),
);
// 用户明确要它回来：建回来会清墓碑，否则下次启动播种仍然跳过它 —— 而这一行现在
// 归用户（名字与地址都是他写的），跟播种无关。
const rebuilt = createOpenPlatform({
  id: seededId,
  label: "建回来的 MiniMax",
  baseUrl: "https://rebuilt.test/v1",
});
check("同名建得回来", rebuilt.ok === true, rebuilt.message);
check(
  "建回来之后墓碑清掉了",
  platformPresetRemoved(seededId) === false,
  String(platformPresetRemoved(seededId)),
);
// 再播种一次：行在，播种按 id 跳过，用户写的那两个值留着。
migrateSimulatedClients(store());
check(
  "播种没把建回来的名字盖回目录值",
  openPlatformOf(seededId)?.label === "建回来的 MiniMax",
  String(openPlatformOf(seededId)?.label),
);
check(
  "平台列表跟数据源对得上",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);


section("改");

const renamed = updateOpenPlatform("acme", { label: "Acme Cloud", baseUrl: "https://api.acme.test/v2" });
check("改得掉", renamed.ok === true, renamed.message);
const afterEdit = openPlatformOf("acme");
check("名字改了", afterEdit?.label === "Acme Cloud", String(afterEdit?.label));
check("地址改了", afterEdit?.baseUrl === "https://api.acme.test/v2", String(afterEdit?.baseUrl));
check("没给的字段没动", afterEdit?.quotaPlugin === "qiniu", String(afterEdit?.quotaPlugin));

// 没给 base_url 时地址不能变成空串：这一格的「没给」靠 undefined，写成
// String(x ?? "") 就等于「把地址清空」，只改名字的单会被地址校验挡掉。
const renamedOnly = updateOpenPlatform("acme", { label: "Acme Cloud 改名" });
check("只改名也改得掉", renamedOnly.ok === true, renamedOnly.message);
check(
  "没给的地址没被清成空串",
  openPlatformOf("acme")?.baseUrl === "https://api.acme.test/v2",
  String(openPlatformOf("acme")?.baseUrl),
);
check(
  "名字跟着改了",
  openPlatformOf("acme")?.label === "Acme Cloud 改名",
  String(openPlatformOf("acme")?.label),
);

// 没登记的插件 id：拒收，库里那一格原地不动 —— 存下去之后这个平台一条额度结论
// 都不会有，而面板上看着「已选插件」。
const badPluginId = updateOpenPlatform("acme", { quotaPlugin: "no-such-plugin" });
check("没登记的插件 id 不收", badPluginId.ok === false, badPluginId.message);
check(
  "拒绝的机器码是「没有这个额度插件」，细节里带着那个 id 与登记过的几个",
  badPluginId.code === "QUOTA_PLUGIN_UNKNOWN" &&
    badPluginId.message.includes("no-such-plugin") &&
    badPluginId.message.includes("qiniu"),
  JSON.stringify(badPluginId),
);
check(
  "库里那一格没被改",
  openPlatformOf("acme")?.quotaPlugin === "qiniu",
  String(openPlatformOf("acme")?.quotaPlugin),
);

// null 是「把这一格清空」，不是「别动它」。
const nulled = updateOpenPlatform("acme", { quotaPlugin: null as unknown as string });
check(
  "quotaPlugin 给 null 存成空串",
  nulled.ok === true && openPlatformOf("acme")?.quotaPlugin === "",
  `${nulled.message} / ${String(openPlatformOf("acme")?.quotaPlugin)}`,
);

const modeled = updateOpenPlatform("acme", { models: ["m1", "m2"] });
check("模型目录写得进去", modeled.ok === true, modeled.message);
const withModels = openPlatformOf("acme");
check("模型在", withModels?.models.items.join(",") === "m1,m2", JSON.stringify(withModels?.models));
check("手写的目录 source 是 manual", withModels?.models.source === "manual", JSON.stringify(withModels?.models));
check("手写的目录不再自动拉", withModels?.models.auto === false, JSON.stringify(withModels?.models));
const autoColumn = store().prepare("SELECT models_auto FROM platform WHERE id = ?").get("acme") as any;
check("自动那一列跟目录一致", Number(autoColumn?.models_auto) === 0, JSON.stringify(autoColumn));
check(
  "手写的目录没拉过（fetchedAt 是 0）",
  withModels?.models.fetchedAt === 0,
  JSON.stringify(withModels?.models),
);
const modelsRaw = store().prepare("SELECT models FROM platform WHERE id = ?").get("acme") as any;
let modelsJson: any = null;
try {
  modelsJson = JSON.parse(String(modelsRaw?.models ?? ""));
} catch {
  modelsJson = null;
}
check(
  "目录的 JSON 里没有 auto（那一格在列上）",
  modelsJson !== null && !("auto" in modelsJson),
  JSON.stringify(modelsJson),
);
// 早期存过的 JSON 里带着 auto：忽略它 —— 自动不自动看那一列。
store()
  .prepare("UPDATE platform SET models = ? WHERE id = ?")
  .run(JSON.stringify({ items: ["m1", "m2"], auto: true, fetchedAt: 0, source: "manual" }), "acme");
const oldJson = openPlatformOf("acme");
check(
  "老 JSON 里的 auto 忽略",
  oldJson?.models.items.join(",") === "m1,m2" && oldJson?.models.auto === false,
  JSON.stringify(oldJson?.models),
);

const auto = updateOpenPlatform("acme", { modelsAuto: true });
check("自动那一格改得掉", auto.ok === true, auto.message);
check("自动拉回来了", openPlatformOf("acme")?.models.auto === true, JSON.stringify(openPlatformOf("acme")?.models));
check(
  "翻自动不自动不动 source（source 说的是这份目录哪来的）",
  openPlatformOf("acme")?.models.source === "manual",
  JSON.stringify(openPlatformOf("acme")?.models),
);

check("改不存在的平台不收", updateOpenPlatform("nope", { label: "x" }).ok === false);

/* ------------------------------------------------------------------ *
 * 能建的平台种类
 * ------------------------------------------------------------------ */

section("能建的平台种类");

// 建的时候带 kind：写进库里的是这一格，不是列的默认值。
const typed = createOpenPlatform({
  id: "kinds-demo",
  label: "Kinds Demo",
  baseUrl: "https://kinds.test/v1",
  kind: "anthropic",
});
check("带 kind 的建得起来", typed.ok === true, typed.message);
check(
  "kind 写进库里了",
  openPlatformOf("kinds-demo")?.kind === "anthropic",
  String(openPlatformOf("kinds-demo")?.kind),
);
check(
  "平台列表里报的也是它",
  platformOfAny("kinds-demo")?.kind === "anthropic",
  String(platformOfAny("kinds-demo")?.kind),
);

// 不带 kind：老面板那样建，建出来还是原来那类东西。
const untyped = createOpenPlatform({ id: "kinds-plain", label: "Kinds Plain", baseUrl: "https://plain.test/v1" });
check("不带 kind 建得起来", untyped.ok === true, untyped.message);
check(
  "不带 kind 时是 openai",
  openPlatformOf("kinds-plain")?.kind === "openai",
  String(openPlatformOf("kinds-plain")?.kind),
);
const emptyTyped = createOpenPlatform({
  id: "kinds-empty",
  label: "Kinds Empty",
  baseUrl: "https://empty.test/v1",
  kind: "",
});
check("kind 空串当没带", emptyTyped.ok === true, emptyTyped.message);
check(
  "所以也是 openai",
  openPlatformOf("kinds-empty")?.kind === "openai",
  String(openPlatformOf("kinds-empty")?.kind),
);

// 不在可建清单里的 kind：收下去这个平台就接不了请求（路由按 kind 分派），
// 而面板上看得见它 —— 拦在写库之前。
const badKind = createOpenPlatform({
  id: "kinds-bad",
  label: "Kinds Bad",
  baseUrl: "https://bad.test/v1",
  kind: "no-such-kind",
});
check("没登记的 kind 不收", badKind.ok === false, badKind.message);
check(
  "拒绝的机器码是「没有这一类」，细节里带着那个 kind 与能建的那几类",
  badKind.code === "PLATFORM_KIND_UNKNOWN" &&
    badKind.message.includes("no-such-kind") &&
    badKind.message.includes("openai") &&
    badKind.message.includes("anthropic") &&
    // 厂商五家也列在候选里（它们现在由用户自己建）。
    ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"].every((kind) =>
      badKind.message.includes(kind),
    ),
  badKind.message,
);
check("被拒的那一行没写进表", openPlatformOf("kinds-bad") === null, JSON.stringify(openPlatformOf("kinds-bad")));

// 厂商那几家现在也是用户能建的一类（模板表没了，平台行由用户在面板上建）。
// 建出来的那一格「自动拉目录」跟着 kind 注册表走。
for (const kind of ["sensenova"]) {
  const built = createOpenPlatform({
    id: `kinds-${kind}`,
    label: `Kinds ${kind}`,
    baseUrl: "https://simulated.test/v1",
    kind,
  });
  check(`厂商类型可建：${kind}`, built.ok === true, built.message);
  check(
    `${kind} 的机器码不是「没有这一类」`,
    built.code !== "PLATFORM_KIND_UNKNOWN",
    JSON.stringify(built),
  );
  check(`${kind} 那一行写进表了`, openPlatformOf(`kinds-${kind}`)?.kind === kind);
  check(
    `${kind}：自动拉目录跟着注册表走`,
    openPlatformOf(`kinds-${kind}`)?.models.auto === (kindOf(kind)?.modelsFromUpstream ?? true),
    JSON.stringify(openPlatformOf(`kinds-${kind}`)?.models),
  );
  // 收尾：这一行是这一节自己造的，后面的行数比对不留它。
  deleteOpenPlatform(`kinds-${kind}`);
}

// 预置的模拟客户端：面板上从目录里挑一个，id 与地址都由预置定死。
//
// 挑一条播种过的先删再建：删过的那条留着墓碑，建回来要清掉（否则下次启动
// 播种仍然跳过它）。
const simulatedPreset = SIMULATED_CLIENTS.find((c) => c.id === "workbuddy-global")!;
const rowsBeforeSimulated = listOpenPlatforms().length;
deleteOpenPlatform(simulatedPreset.id);
const simulatedAdded = createOpenPlatform({
  id: simulatedPreset.id,
  label: simulatedPreset.label,
  // 送了也不收：模拟端的地址由 kind 自己算。
  baseUrl: "https://ignored.test/v1",
  kind: simulatedPreset.kind,
});
check("预置的模拟客户端建得起来", simulatedAdded.ok === true, simulatedAdded.message);
const simulatedRow = openPlatformOf(simulatedPreset.id);
check("区域照预置", simulatedRow?.region === simulatedPreset.region, JSON.stringify(simulatedRow?.region));
check("地址是空串（不收请求里那一个）", simulatedRow?.baseUrl === "", JSON.stringify(simulatedRow?.baseUrl));
check("目录不让自动拉", simulatedRow?.models.auto === false, JSON.stringify(simulatedRow?.models));
check("额度插件是空串", simulatedRow?.quotaPlugin === "", JSON.stringify(simulatedRow?.quotaPlugin));
check("kind 就是预置那一类", simulatedRow?.kind === simulatedPreset.kind, JSON.stringify(simulatedRow?.kind));
check(
  "表里的行数回到删之前",
  listOpenPlatforms().length === rowsBeforeSimulated,
  `${listOpenPlatforms().length} vs ${rowsBeforeSimulated}`,
);

// id 由预置定死：它是请求路径里那一段，也是调用方 base_url 的那一段。
const wrongSimulatedId = createOpenPlatform({
  id: "my-minimax",
  label: "我的 MiniMax",
  baseUrl: "",
  kind: "minimax",
});
check("模拟客户端的 id 不能自己取", wrongSimulatedId.ok === false, wrongSimulatedId.message);
check("说的是 id 只能是预置那一个", wrongSimulatedId.message.includes("minimax"), wrongSimulatedId.message);
check("被拒的那一行没写进表", openPlatformOf("my-minimax") === null);
check(
  "拒绝时一行都没多",
  listOpenPlatforms().length === rowsBeforeSimulated,
  `${listOpenPlatforms().length} vs ${rowsBeforeSimulated}`,
);

// 目录里藏起来的那一条（zcode）：面板上根本看不到，也不给建。
const hiddenPreset = SIMULATED_CLIENTS.find((c) => c.id === "zcode")!;
const hiddenBuild = createOpenPlatform({
  id: hiddenPreset.id,
  label: hiddenPreset.label,
  baseUrl: "",
  kind: hiddenPreset.kind,
});
check("hidden 的那一条不给建", hiddenBuild.ok === false, hiddenBuild.message);
check("表里也没多出它", openPlatformOf("zcode") === null);

// 一个 kind 名下不止一个平台（Qoder 的全球区与中国区）：id 挑的是哪一条。
const qoderCnPreset = SIMULATED_CLIENTS.find((c) => c.id === "qoder-cn")!;
deleteOpenPlatform(qoderCnPreset.id);
const qoderCn = createOpenPlatform({
  id: qoderCnPreset.id,
  label: qoderCnPreset.label,
  baseUrl: "",
  kind: qoderCnPreset.kind,
});
check("同一个 kind 下按 id 挑预置", qoderCn.ok === true, qoderCn.message);
check("挑中的是中国区那一条", openPlatformOf("qoder-cn")?.region === "cn", JSON.stringify(openPlatformOf("qoder-cn")?.region));
const qoderWrongId = createOpenPlatform({ id: "qoder-xx", label: "Qoder XX", baseUrl: "", kind: "qoder" });
check("同一个 kind 下 id 不对也拒", qoderWrongId.ok === false, qoderWrongId.message);
check("表里没有 qoder-xx", openPlatformOf("qoder-xx") === null);

// 建好之后换不了类型：换类型要连它名下的凭据一起重算，那是另一件事。
const switched = updateOpenPlatform("kinds-demo", { kind: "openai", label: "Kinds Demo 改" });
check("换类型被拒", switched.ok === false, switched.message);
check("机器码说的是类型定死了", switched.code === "PLATFORM_KIND_FIXED", JSON.stringify(switched));
check(
  "库里 kind 没变",
  openPlatformOf("kinds-demo")?.kind === "anthropic",
  String(openPlatformOf("kinds-demo")?.kind),
);
check(
  "被拒的那一次别的字段也没动（整单一起拒）",
  openPlatformOf("kinds-demo")?.label === "Kinds Demo",
  String(openPlatformOf("kinds-demo")?.label),
);

// 同一类当没传：别的字段照常改。
const sameKind = updateOpenPlatform("kinds-demo", { kind: "anthropic", label: "Kinds Demo 改" });
check("同 kind 当没传，改得掉", sameKind.ok === true, sameKind.message);
check("名字改了", openPlatformOf("kinds-demo")?.label === "Kinds Demo 改", String(openPlatformOf("kinds-demo")?.label));
check(
  "kind 还是原来那个",
  openPlatformOf("kinds-demo")?.kind === "anthropic",
  String(openPlatformOf("kinds-demo")?.kind),
);

// 那张表本身：两种方言（向上游讲 OpenAI 格式，还是讲 Anthropic Messages）加
// 厂商五家 —— 模板表没了，厂商那几行也由用户在面板上自己建。
const VENDOR_KINDS = ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"];
check("能建的一共七类", PLATFORM_KIND_OPTIONS.length === 7, String(PLATFORM_KIND_OPTIONS.length));
check(
  "两种方言在前，openai 在最前",
  PLATFORM_KIND_OPTIONS.slice(0, 2).map((o) => o.kind).join(",") === "openai,anthropic",
  PLATFORM_KIND_OPTIONS.slice(0, 2).map((o) => o.kind).join(","),
);
check(
  "厂商五家也在表里",
  VENDOR_KINDS.every(
    (kind) => platformKindOptionOf(kind) !== null && PLATFORM_KIND_OPTIONS.some((o) => o.kind === kind),
  ),
  PLATFORM_KIND_OPTIONS.map((o) => o.kind).join(","),
);
check(
  "第一条是 openai",
  PLATFORM_KIND_OPTIONS[0]?.kind === "openai",
  String(PLATFORM_KIND_OPTIONS[0]?.kind),
);
check(
  "第二条是 anthropic（排在 openai 后面）",
  PLATFORM_KIND_OPTIONS[1]?.kind === "anthropic" && PLATFORM_KIND_OPTIONS[1]?.label === "Anthropic 兼容",
  String(PLATFORM_KIND_OPTIONS[1]?.kind),
);
check(
  "默认地址那一格在这张表里是空的（地址在 kind 注册表）",
  PLATFORM_KIND_OPTIONS.every((o) => o.defaultBaseUrl === ""),
  JSON.stringify(PLATFORM_KIND_OPTIONS.map((o) => o.defaultBaseUrl)),
);
check(
  "能不能从上游拉目录跟着 kind 注册表",
  PLATFORM_KIND_OPTIONS.every(
    (o) => o.modelsFromUpstream === (kindOf(o.kind)?.modelsFromUpstream ?? true),
  ),
  JSON.stringify(PLATFORM_KIND_OPTIONS.map((o) => [o.kind, o.modelsFromUpstream])),
);
check("认不出的 kind 是 null", platformKindOptionOf("no-such-kind") === null, JSON.stringify(platformKindOptionOf("no-such-kind")));

// 面板上那一份（两族）：先方言，再目录里没藏起来的模拟客户端。
const choices = platformKindChoices();
const dialectChoices = choices.filter((c) => c.category === "dialect");
const simulatedChoices = choices.filter((c) => c.category === "simulated");
check(
  "先方言后模拟客户端",
  choices.slice(0, dialectChoices.length).every((c) => c.category === "dialect") &&
    choices.slice(dialectChoices.length).every((c) => c.category === "simulated"),
  choices.map((c) => `${c.category}:${c.kind}`).join(","),
);
check(
  "方言那一族就是表里那些",
  dialectChoices.map((c) => c.kind).join(",") === PLATFORM_KIND_OPTIONS.map((o) => o.kind).join(","),
  dialectChoices.map((c) => c.kind).join(","),
);
check(
  "两类方言的 preset_id 与 region 都是空串",
  dialectChoices
    .filter((c) => c.kind === "openai" || c.kind === "anthropic")
    .every((c) => c.presetId === "" && c.region === ""),
  JSON.stringify(dialectChoices.map((c) => [c.kind, c.presetId, c.region])),
);
const visible = SIMULATED_CLIENTS.filter((c) => !c.hidden);
check(
  "模拟客户端那一族就是目录里看得见的那几条",
  simulatedChoices.map((c) => c.presetId).join(",") === visible.map((c) => c.id).join(","),
  simulatedChoices.map((c) => c.presetId).join(","),
);
check(
  "每一条的 kind与区域照目录",
  simulatedChoices.every((c) => {
    const preset = visible.find((p) => p.id === c.presetId)!;
    return preset.kind === c.kind && preset.region === c.region && preset.label === c.label;
  }),
  JSON.stringify(simulatedChoices.map((c) => [c.presetId, c.kind, c.region])),
);
check(
  "模拟客户端没有默认地址、不从上游拉目录",
  simulatedChoices.every((c) => c.defaultBaseUrl === "" && c.modelsFromUpstream === false),
  JSON.stringify(simulatedChoices.map((c) => [c.defaultBaseUrl, c.modelsFromUpstream])),
);
check(
  "hidden 的 zcode 不在里面",
  !choices.some((c) => c.kind === "zcode" || c.presetId === "zcode"),
  choices.map((c) => c.presetId).join(","),
);
check(
  "厂商那几家也在里面（用户自己建的一类）",
  VENDOR_KINDS.every((kind) => choices.some((c) => c.kind === kind)),
  choices.map((c) => c.kind).join(","),
);

// 上面建的几行删掉：后面的小节按行数比。
for (const id of ["kinds-demo", "kinds-plain", "kinds-empty"]) deleteOpenPlatform(id);
check(
  "收尾删干净了",
  ["kinds-demo", "kinds-plain", "kinds-empty"].every((id) => openPlatformOf(id) === null),
  userPlatformRows()
    .map((r) => r.id)
    .join(","),
);

section("删");

const deleted = deleteOpenPlatform("acme");
check("删得掉", deleted.ok === true, deleted.message);
check(
  "表里没了",
  userPlatformRows().length === 0,
  userPlatformRows().map((r) => r.id).join(","),
);
check(
  "平台列表回到基线",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);
check("删不存在的会说没有", deleteOpenPlatform("acme").ok === false);
check("查不到了", platformOfAny("acme") === null, JSON.stringify(platformOfAny("acme")));

section("坏掉的目录");

createOpenPlatform({ id: "broken", label: "坏目录", baseUrl: "https://broken.test/v1" });
store().prepare("UPDATE platform SET models = ? WHERE id = ?").run("{ 这不是 JSON", "broken");
const broken = openPlatformOf("broken");
check("坏目录读成空目录", broken?.models.items.length === 0, JSON.stringify(broken?.models));
check(
  "坏目录那一行还是读到了（不是没读到）",
  broken !== null && broken.label === "坏目录" && broken.baseUrl === "https://broken.test/v1",
  JSON.stringify(broken),
);
check(
  "平台列表照旧",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);

// 存的是单纯的数组（早期那样）也读得出来：模型名在，别的按缺省算。
store().prepare("UPDATE platform SET models = ? WHERE id = ?").run('["x1","x2"]', "broken");
const legacy = openPlatformOf("broken");
check("数组也读得出来", legacy?.models.items.join(",") === "x1,x2", JSON.stringify(legacy?.models));

deleteOpenPlatform("broken");
check(
  "清干净了，平台列表回到基线",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);

section("账号 id 与平台 id 相互独立");

// 账号 id 是一个独立的自增数，不派生自平台：两边各查各的表，账号靠
// provider.platform 关联到平台。
const qoderFirst = addAccount({ platform: "qoder" });
const qoderSecond = addAccount({ platform: "qoder" });
check(
  "同一平台的两个账号 id 不同，都是自增数",
  Boolean(qoderFirst.id && qoderSecond.id) &&
    qoderFirst.id !== qoderSecond.id &&
    /^\d+$/.test(qoderFirst.id!) &&
    /^\d+$/.test(qoderSecond.id!),
  JSON.stringify([qoderFirst.id, qoderSecond.id]),
);
check(
  "两个账号都挂在 qoder 上",
  provider(qoderFirst.id!)?.platform === "qoder" && provider(qoderSecond.id!)?.platform === "qoder",
  JSON.stringify([provider(qoderFirst.id!)?.platform, provider(qoderSecond.id!)?.platform]),
);
check(
  "账号 id 里没有平台的名字",
  [qoderFirst.id!, qoderSecond.id!].every((id) => !id.includes("qoder")),
  JSON.stringify([qoderFirst.id, qoderSecond.id]),
);

// 平台表的 id 跟账号表不相干：开放平台叫什么，跟它名下账号叫什么没有关系。
const zephyr = createOpenPlatform({
  id: "zephyr",
  label: "Zephyr",
  baseUrl: "https://zephyr.test/v1",
});
check("开放平台建得起来", zephyr.ok === true, zephyr.message);
const zephyrAccount = addAccount({ platform: "zephyr" });
check(
  "新平台下的账号 id 也是自增数，不接平台 id",
  Boolean(zephyrAccount.id) && /^\d+$/.test(zephyrAccount.id!) && zephyrAccount.id !== "zephyr",
  String(zephyrAccount.id),
);
check(
  "账号挂在它自己的平台上",
  provider(zephyrAccount.id!)?.platform === "zephyr",
  String(provider(zephyrAccount.id!)?.platform),
);

section("只加载 open-platforms 的进程");

// 一个只引 lib/open-platforms.ts 的进程（不引 lib/platforms.ts）：播种照样跑完 ——
// 播种在开库那一步（lib/store.ts 的 openDatabase），不靠谁先引平台层。
const ONLY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-platforms-only-"));
const onlyRun = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "-e",
    `
      const { createOpenPlatform, listOpenPlatforms } = await import(${JSON.stringify(path.join(ROOT, "lib/open-platforms.ts"))});
      const res = createOpenPlatform({ id: "qoder", label: "撞播种", baseUrl: "https://only.test/v1" });
      console.log(JSON.stringify({ ok: res.ok, code: res.ok ? "" : res.code, message: res.message, rows: listOpenPlatforms().map((r) => r.id) }));
    `,
  ],
  {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: ONLY_DIR },
    encoding: "utf8",
  },
);
check("只加载 open-platforms 的进程跑得起来", onlyRun.status === 0, onlyRun.stderr?.slice(-300) ?? "");
let onlyBody: { ok?: boolean; code?: string; message?: string; rows?: string[] } = {};
try {
  onlyBody = JSON.parse(onlyRun.stdout.trim().split("\n").pop() ?? "{}");
} catch {
  onlyBody = {};
}
check(
  "那个进程里该播种的模拟客户端已经在了",
  SEEDED.every((c) => (onlyBody.rows ?? []).includes(c.id)),
  JSON.stringify(onlyBody.rows),
);
check(
  "那个进程里撞已有行的 id 照样被拒，机器码是「已有」",
  onlyBody.ok === false && onlyBody.code === "PLATFORM_ALREADY_EXISTS",
  JSON.stringify(onlyBody),
);
fs.rmSync(ONLY_DIR, { recursive: true, force: true });

section("模拟客户端不拉目录");

// 平台行只按 kind 分开（lib/platform-catalog.ts 的 isSimulatedClientKind）：模拟
// 客户端那一族的行长得跟开放平台一样，但它们的目录归各 kind 自己的代码，不能拿去
// 问上游要 —— 那会带着真 key 去打一个封闭客户端的接口。
//
// 把它们那一格「自动拉」打开：播种写的是 0，老库里那几行是 1（播种改口径之前写进去
// 的），所以只有按 kind 判别才拦得住。
// 目录归谁管只看行自己那一格（models_auto）：播种给模拟客户端写的也是 0，平时
// 这几行根本走不到拉目录那一步。这里把那一格打开，验的是另一件事 —— 行说拉也
// 不拉得到：模拟客户端的目录是那个封闭客户端自己的，不从上游来。
const { openPlatformCatalogRefreshable, refreshOpenPlatformCatalog } = await import(
  "../lib/open-platform-catalog.ts"
);
// 用一条没被动过的播种行：上面那条（minimax）删过又建回来了，现在是一条用户建的
// 开放平台，kind 已经不是模拟端那一族，拿它验不到这里要验的东西。
const simId = SEEDED.find((c) => c.id !== SIMULATED_CLIENTS[0].id)!.id;
// 播出来的那一行本来就是 0。
check(
  "播出来的模拟客户端那几行 models_auto 是 0",
  openPlatformOf(simId)?.models.auto === false,
  JSON.stringify(openPlatformOf(simId)?.models),
);
check(
  "models_auto 是 0：不问上游",
  openPlatformCatalogRefreshable(openPlatformOf(simId)!) === false,
  JSON.stringify(openPlatformOf(simId)?.models),
);
store().prepare("UPDATE platform SET models_auto = 1 WHERE id = ?").run(simId);
const simRow = openPlatformOf(simId);
check(
  "把那一格打开，刷新那条闸就放行（判据只有这一格）",
  openPlatformCatalogRefreshable(simRow!) === true,
  JSON.stringify(simRow?.models),
);
const simRefresh = await refreshOpenPlatformCatalog(simId);
check(
  "说要拉的那一次被挡下了",
  simRefresh.ok === false && simRefresh.message.includes("不需要从上游获取目录"),
  JSON.stringify(simRefresh),
);
// 对照：同一个判断在开放平台上放行（不然上面那条只能说「什么都不刷新」）。
const plainRow = openPlatformOf("zephyr");
check(
  "开放平台的目录照旧要拉",
  plainRow !== null && openPlatformCatalogRefreshable(plainRow) === true,
  JSON.stringify(plainRow?.models),
);
store().prepare("UPDATE platform SET models_auto = 0 WHERE id = ?").run(simId);

section("地址的结尾斜杠");

// 存进去之前去掉结尾的斜杠：将来拼路径时不会拼出 `//v1`。
const slashy = createOpenPlatform({
  id: "slashy",
  label: "Slashy",
  baseUrl: "https://slashy.test/v1/",
});
check("带结尾斜杠的地址建得起来", slashy.ok === true, slashy.message);
check(
  "结尾斜杠去掉了",
  openPlatformOf("slashy")?.baseUrl === "https://slashy.test/v1",
  String(openPlatformOf("slashy")?.baseUrl),
);
const slashyEdit = updateOpenPlatform("slashy", { baseUrl: "https://slashy.test/v2/" });
check(
  "改地址也去斜杠",
  slashyEdit.ok === true && openPlatformOf("slashy")?.baseUrl === "https://slashy.test/v2",
  String(openPlatformOf("slashy")?.baseUrl),
);

section("模型参数：按路径表取");

// 各家上游同一件事用不同的名字报。这里不按平台验形状：同一张路径表喂不同的
// JSON，取到了就是取到了；换一份表也换一个结果（证明取的是表，不是另写的判断）。
const { parseModelList, traitsFromEntry, TRAIT_PATHS } = await import("../lib/open-platform-catalog.ts");
const { catalogModelsFromRow, tokenRhythmCatalogModels } = await import("../lib/catalog-models.ts");

/** 一条清单条目自己的参数（名字都叫 m，只比参数）。 */
function traitsOf(entry: object): Record<string, unknown> {
  const parsed = parseModelList({ data: [{ id: "m", ...entry }] });
  return (parsed?.[0]?.traits ?? {}) as Record<string, unknown>;
}

/** 参数表与预期一模一样：多一格少一格都算不对。 */
function checkTraits(name: string, entry: object, want: Record<string, unknown>): void {
  const got = traitsOf(entry);
  const diff = [
    ...Object.entries(want).filter(([key, value]) => JSON.stringify(got[key]) !== JSON.stringify(value)),
    ...Object.keys(got).filter((key) => !(key in want)),
  ];
  check(name, diff.length === 0, `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
}

checkTraits("平铺的上下文与输出上限", { context_length: 256000, max_tokens: 320000 }, {
  contextWindow: 256000,
  maxOutputTokens: 320000,
});
checkTraits(
  "塞在输入模态里的上下文长度（数组任一条取到就算）",
  {
    input_modalities: [
      { type: "image", supported_inputs: {} },
      { type: "text", supported_inputs: { max_context_length: { value: 262144, unit: "token" } }, capacity: [] },
    ],
    output_modalities: [{ type: "text" }],
  },
  { contextWindow: 262144 },
);
checkTraits(
  "嵌套的 limit 与 capabilities",
  {
    limit: { context: 200000, output: 64000 },
    capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high", "max"] } },
  },
  {
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: true,
    toolCall: true,
    efforts: ["low", "high", "max"],
  },
);
checkTraits(
  "supports_* 与输出上限",
  { supports_reasoning: true, supports_tools: true, max_completion_tokens: 8192 },
  { reasoning: true, toolCall: true, maxOutputTokens: 8192 },
);
// 倍率不从上游取：上游把倍率、每百万 token 的钱、积分都叫「价格」，单位差三个
// 数量级，塞进同一格就是猜。宁可没有 —— 人工写的那一份（行里的参数、共性表）
// 照旧生效。
checkTraits(
  "各种「价格」都不取（单位不同，不猜）",
  { pricing: "8.00000000", multiplier: 2, credits: 100 },
  {},
);
check(
  "路径表里没有倍率那一项",
  !("credits" in TRAIT_PATHS),
  JSON.stringify(Object.keys(TRAIT_PATHS)),
);

// 判据：上游没说就是没说 —— 不是 0、不是 false。
checkTraits("只有名字的条目：参数一格都不写", {}, {});
check(
  "没给的字段是 undefined（不是 0 / false）",
  ["contextWindow", "maxOutputTokens", "reasoning", "toolCall", "efforts"].every(
    (key) => traitsOf({})[key] === undefined,
  ),
  JSON.stringify(traitsOf({})),
);
check(
  "整个参数表就是空对象（不是一堆 undefined 的键）",
  JSON.stringify(traitsOf({})) === "{}",
  JSON.stringify(traitsOf({})),
);

// 反过来：上游明确说的 0、false、空数组照收 —— 0 不是「免费」的反面，false 不是
// 「不知道」，空数组是「这个模型没有档位」。
checkTraits(
  "0 与 false 照收（上游明确说的）",
  {
    max_output_tokens: 0,
    supports_reasoning: false,
    supports_tools: false,
    capabilities: { reasoning: { effort: [] } },
  },
  { maxOutputTokens: 0, reasoning: false, toolCall: false, efforts: [] },
);
checkTraits("null 与类型不对的算没有", { context_length: null, max_output_tokens: "很多", supports_reasoning: null }, {});

// 路径表就是全部取法：拿掉一条，对应那一格就取不到。
const narrowerPaths = {
  ...TRAIT_PATHS,
  contextWindow: TRAIT_PATHS.contextWindow.filter((p) => p !== "context_length"),
};
check(
  "拿掉一条路径，那一格就没有了（取的是这张表）",
  traitsFromEntry({ context_length: 1000 }, narrowerPaths).contextWindow === undefined &&
    traitsFromEntry({ context_length: 1000 }).contextWindow === 1000,
  JSON.stringify([
    traitsFromEntry({ context_length: 1000 }, narrowerPaths),
    traitsFromEntry({ context_length: 1000 }),
  ]),
);

// 清单本身：另一种常见写法（models + name）也认，重号取第一条（它的参数也跟着第一条）。
const named = parseModelList({ models: [{ name: "a", context_length: 10 }, { name: "a" }, { name: "b" }] });
check(
  "{models:[{name}]} 也认，重号取第一条",
  named?.map((model) => model.id).join(",") === "a,b" && named?.[0]?.traits.contextWindow === 10,
  JSON.stringify(named),
);

section("模型参数落在平台那一行");

const traitsRow = createOpenPlatform({ id: "traits-demo", label: "参数", baseUrl: "https://traits.test/v1" });
check("建一行来放参数", traitsRow.ok === true, traitsRow.message);
const codeModel = tokenRhythmCatalogModels()[0];
const byId = (id: string) => (id === codeModel.id ? codeModel : undefined) as any;
const written = updateOpenPlatform("traits-demo", {
  models: [codeModel.id],
  traits: { [codeModel.id]: { contextWindow: 12345 }, ghost: { contextWindow: 2 } },
});
check("参数跟着清单写进去", written.ok === true, written.message);
check(
  "读得回来",
  openPlatformOf("traits-demo")?.models.traits[codeModel.id]?.contextWindow === 12345,
  JSON.stringify(openPlatformOf("traits-demo")?.models),
);
check(
  "清单里没有的 id 的参数不落库",
  openPlatformOf("traits-demo")?.models.traits.ghost === undefined,
  JSON.stringify(openPlatformOf("traits-demo")?.models.traits),
);

// 行里的参数优先于代码表；代码表里还说得出的字段照旧从代码表来。
const shown = catalogModelsFromRow({ platform: "traits-demo" }, () => [], byId);
check("行里的上下文长度优先", shown[0]?.contextWindow === 12345, JSON.stringify(shown[0]));
check(
  "代码表里其它字段还在（档位、输出上限、名字）",
  shown[0]?.effortOptions?.join(",") === "low,high,max" &&
    shown[0]?.maxOutputTokens === codeModel.maxOutputTokens &&
    shown[0]?.displayName === codeModel.displayName,
  JSON.stringify(shown[0]),
);

// 面板只改清单、不带参数：已经是同一个 id 的参数留着。
updateOpenPlatform("traits-demo", { models: [codeModel.id, "second"] });
check(
  "只改清单时已有模型的参数留着",
  openPlatformOf("traits-demo")?.models.traits[codeModel.id]?.contextWindow === 12345,
  JSON.stringify(openPlatformOf("traits-demo")?.models.traits),
);

// 老行：JSON 里没有 traits 那一格。读成空对象，不发明参数。
store()
  .prepare("UPDATE platform SET models = ? WHERE id = ?")
  .run(JSON.stringify({ items: ["only-name"], fetchedAt: 0, source: "auto" }), "traits-demo");
const legacyTraits = openPlatformOf("traits-demo")?.models.traits;
check(
  "老行（JSON 里没有 traits）读成空对象",
  legacyTraits !== null && typeof legacyTraits === "object" && Object.keys(legacyTraits ?? {}).length === 0,
  JSON.stringify(legacyTraits),
);
const bare = catalogModelsFromRow({ platform: "traits-demo" }, () => [], byId);
check(
  "参数缺席时只剩最小形状（没有 0 也没有 false）",
  bare[0]?.contextWindow === undefined &&
    bare[0]?.maxOutputTokens === undefined &&
    bare[0]?.reasoning === undefined &&
    bare[0]?.toolCall === undefined,
  JSON.stringify(bare[0]),
);

deleteOpenPlatform("traits-demo");
check("收尾删干净了", openPlatformOf("traits-demo") === null, String(openPlatformOf("traits-demo")));

section("星火的目录归上游");

const xinghuoKind = kindOf("xinghuo");
check("星火能从上游拉目录", xinghuoKind?.modelsFromUpstream === true, String(xinghuoKind?.modelsFromUpstream));
// 一个指向不存在的平台行的账号：目录归上游之后，读不到行就是空 —— 代码目录不是目录。
const xinghuoBare = {
  id: "0",
  platform: "no-such-platform",
  kind: "xinghuo",
  region: "",
  alias: "",
  enabled: true,
  weight: 0,
  policy: "single" as const,
  createdAt: 0,
  updatedAt: 0,
};
const noRow = xinghuoKind?.models(xinghuoBare as any) ?? [];
check("行读不到时不退回代码目录（空就是空）", noRow.length === 0, JSON.stringify(noRow.map((m) => m.id)));

section("刷新模型目录：自动拉关着的不拉");

// 一台假上游：回答模型清单，并把被问过的路径记下来。“有没有真的去问”得是可数
// 的 —— 光看答复里的 ok=false 分不清是拦下了还是问过之后失败。
const hits: string[] = [];
// 假上游这次答什么：下面有几节要换目录（换目录、少报参数），所以是可改的。
let fakeModels: any[] = [{ id: "xinghuo-upstream-1", context_length: 8192 }];
const fakeUpstream = http.createServer((req, res) => {
  hits.push(String(req.url ?? ""));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: fakeModels }));
});
fakeUpstream.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => fakeUpstream.once("listening", () => resolve()));
const fakeBase = `http://127.0.0.1:${(fakeUpstream.address() as { port: number }).port}`;

const { adminService } = await import("../lib/admin/service.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { deleteAccount } = await import("../lib/admin/accounts.ts");

/** 面板那个按钮走的就是这一个方法（force 在里面写死）。 */
async function refreshViaPanel(id: string): Promise<{ ok?: boolean; message?: string; models?: string[] }> {
  return (await (adminService as any).refreshPlatformModels({ platformId: id }, {})) as any;
}

// 后面几节要用的厂商行：行是表里的一行，测试自己造一行（生产里是用户在面板
// 上建的 —— 代码里没有模板表了）。
//
// 七牛与星火的目录是代码挑的那一份（上游那份更宽，盖上来会出现被上游拒的模型），
// 所以那两行的「自动拉」那一格关着。
insertVendorPlatform("qiniu");
insertVendorPlatform("xinghuo", "xinghuo", { modelsAuto: false, models: XINGHUO_MODELS.map((m) => m.id) });
check(
  "造出来的两行厂商平台在表里",
  openPlatformOf("qiniu") !== null && openPlatformOf("xinghuo") !== null,
  [openPlatformOf("qiniu"), openPlatformOf("xinghuo")].map((r) => String(r?.id)).join(","),
);

// 七牛云：目录是代码挑的那一份（七牛报 78 个模型，拿上游那份盖上来会出现被上游
// 拒的模型），所以插这一行时那一格写的就是 0。把地址指向假上游，于是“有没有真的
// 去问”就有据可查。
const qiniuUrlBefore = String(openPlatformOf("qiniu")?.baseUrl);
const qiniuModelsBefore = JSON.stringify(openPlatformOf("qiniu")?.models);
const qiniuAutoBefore = openPlatformOf("qiniu")?.models.auto;
check("七牛云的目录不是自动拉的那一类", qiniuAutoBefore === false, String(qiniuAutoBefore));
updateOpenPlatform("qiniu", { baseUrl: `${fakeBase}/v1` });
hits.length = 0;
const qiniuRefresh = await refreshViaPanel("qiniu");
check(
  "七牛云的刷新被拒（说的是目录手工维护，不是拉失败）",
  qiniuRefresh.ok === false && qiniuRefresh.message.includes("手工维护"),
  JSON.stringify(qiniuRefresh),
);
check("没去问上游", hits.length === 0, JSON.stringify(hits));
check(
  "目录一字节没动",
  JSON.stringify(openPlatformOf("qiniu")?.models) === qiniuModelsBefore,
  JSON.stringify(openPlatformOf("qiniu")?.models),
);
check(
  "自动拉那一格没被翻",
  openPlatformOf("qiniu")?.models.auto === qiniuAutoBefore,
  String(openPlatformOf("qiniu")?.models.auto),
);
updateOpenPlatform("qiniu", { baseUrl: qiniuUrlBefore });

// 讯飞星火：目录来自代码常量表（XINGHUO_MODELS）—— 这一行那一格写的是 0，
// 要拉上游由人在面板上把那一格打开，不由代码替它决定。
const xinghuoUrlBefore = String(openPlatformOf("xinghuo")?.baseUrl);
updateOpenPlatform("xinghuo", { baseUrl: `${fakeBase}/v2` });
check(
  "星火这一行不自动拉（目录是代码挑的那份）",
  openPlatformOf("xinghuo")?.models.auto === false,
  String(openPlatformOf("xinghuo")?.models.auto),
);
updateOpenPlatform("xinghuo", { modelsAuto: true });
check(
  "人打开那一格之后才拉",
  openPlatformOf("xinghuo")?.models.auto === true,
  String(openPlatformOf("xinghuo")?.models.auto),
);
const xinghuoAccount = addAccount({ platform: "xinghuo" });
check("星火的账号加得起来", xinghuoAccount.ok === true, xinghuoAccount.message);
setProviderKeys(xinghuoAccount.id ?? "", ["sk-TESTONLY-xinghuo-catalog"]); // privacy:allow — 编造的样例
hits.length = 0;
const xinghuoRefresh = await refreshViaPanel("xinghuo");
check("星火的目录拉得到", xinghuoRefresh.ok === true, JSON.stringify(xinghuoRefresh));
check("问的是 /v2/models", hits.includes("/v2/models"), JSON.stringify(hits));
check(
  "目录是上游答的那份",
  openPlatformOf("xinghuo")?.models.items.join(",") === "xinghuo-upstream-1",
  JSON.stringify(openPlatformOf("xinghuo")?.models.items),
);
check(
  "拉完 models_auto 还是 1（刷新不该改这个开关）",
  openPlatformOf("xinghuo")?.models.auto === true,
  String(openPlatformOf("xinghuo")?.models.auto),
);

// 反过来：那一格关着的时候——即使人点了刷新（force）——也不拉。写回若写死
// modelsAuto: true，用户关掉的开关就会被一次刷新重新拨开。
updateOpenPlatform("xinghuo", { modelsAuto: false });
const xinghuoItemsBefore = JSON.stringify(openPlatformOf("xinghuo")?.models.items);
hits.length = 0;
const xinghuoForced = await refreshViaPanel("xinghuo");
check(
  "开关关着：人点也不拉（force 只穿退避）",
  xinghuoForced.ok === false && String(xinghuoForced.message).includes("手工维护"),
  JSON.stringify(xinghuoForced),
);
check("开关关着：没去问上游", hits.length === 0, JSON.stringify(hits));
check(
  "开关关着：目录没被动过",
  JSON.stringify(openPlatformOf("xinghuo")?.models.items) === xinghuoItemsBefore,
  JSON.stringify(openPlatformOf("xinghuo")?.models.items),
);
check(
  "开关关着：那一格还是关的",
  openPlatformOf("xinghuo")?.models.auto === false,
  String(openPlatformOf("xinghuo")?.models.auto),
);
updateOpenPlatform("xinghuo", { modelsAuto: true });

// 收尾：把星火那行拨回模板的样子（后面的老库模拟对模板行的地址有断言）。
updateOpenPlatform("xinghuo", { baseUrl: xinghuoUrlBefore });
if (xinghuoAccount.id) deleteAccount(xinghuoAccount.id);

section("手写的目录不被后台冲刷");

// 人写了一份目录（source=manual），又在面板上把「自动拉」打开：那个开关说的是
// 「以后允许自动拉覆盖」，不等于这份目录现在算自动拉来的
// （lib/open-platforms.ts 的 updatePlatform 就是这么做的）。后台那条刷新（不带
// force）不许冲掉手写那份，只有人点刷新（force）才盖它 —— 盖完 source 才变 auto。
fakeModels = [{ id: "hand-up-1", context_length: 8192 }];
const handRow = createOpenPlatform({ id: "hand-catalog", label: "手写目录", baseUrl: `${fakeBase}/v1` });
check("建一行来放手写目录", handRow.ok === true, handRow.message);
updateOpenPlatform("hand-catalog", {
  models: ["hand-written-1"],
  traits: { "hand-written-1": { contextWindow: 4096 } },
});
const handAccount = addAccount({ platform: "hand-catalog" });
check("手写目录那行的账号加得起来", handAccount.ok === true, handAccount.message);
setProviderKeys(handAccount.id ?? "", ["sk-TESTONLY-hand-catalog"]); // privacy:allow — 编造的样例
check(
  "手写目录：开关默认关着",
  openPlatformOf("hand-catalog")?.models.auto === false,
  String(openPlatformOf("hand-catalog")?.models.auto),
);
updateOpenPlatform("hand-catalog", { modelsAuto: true });
check(
  "开关打开之后来源还是 manual（开关说的是以后）",
  openPlatformOf("hand-catalog")?.models.source === "manual",
  JSON.stringify(openPlatformOf("hand-catalog")?.models),
);
check(
  "开关开着：面板上那个按钮可用",
  openPlatformCatalogRefreshable(openPlatformOf("hand-catalog")!) === true,
  JSON.stringify(openPlatformOf("hand-catalog")?.models),
);
hits.length = 0;
const handBackground = await refreshOpenPlatformCatalog("hand-catalog");
check(
  "后台刷新跳过手写的目录（也没去问上游）",
  handBackground.ok === false && handBackground.message.includes("手写的") && hits.length === 0,
  JSON.stringify([handBackground, hits]),
);
check(
  "手写那份一个字没动",
  openPlatformOf("hand-catalog")?.models.items.join(",") === "hand-written-1" &&
    openPlatformOf("hand-catalog")?.models.traits["hand-written-1"]?.contextWindow === 4096 &&
    openPlatformOf("hand-catalog")?.models.source === "manual",
  JSON.stringify(openPlatformOf("hand-catalog")?.models),
);
const handForced = await refreshViaPanel("hand-catalog");
check("人点刷新：盖掉了手写那份", handForced.ok === true, JSON.stringify(handForced));
check(
  "盖完来源变成 auto",
  openPlatformOf("hand-catalog")?.models.items.join(",") === "hand-up-1" &&
    openPlatformOf("hand-catalog")?.models.source === "auto",
  JSON.stringify(openPlatformOf("hand-catalog")?.models),
);

section("刷新保留上游这次没报的参数");

// 上游这次报了一个模型、对另一个一个字不说：没说话不是「参数变成空」—— 上次
// 拿到的那份留着。cache 那一侧（syncPlatformModels）与刷新同一个口径。
fakeModels = [{ id: "hand-up-1" }, { id: "hand-up-2", context_length: 2000 }];
const secondRefresh = await refreshViaPanel("hand-catalog");
check("第二次刷新到手两个模型", secondRefresh.ok === true, JSON.stringify(secondRefresh));
const keptTraits = openPlatformOf("hand-catalog")?.models.traits ?? {};
check(
  "这次没报参数的那个：上一次那份留着",
  keptTraits["hand-up-1"]?.contextWindow === 8192,
  JSON.stringify(keptTraits),
);
check(
  "这次报了的那个：写的是这次的",
  keptTraits["hand-up-2"]?.contextWindow === 2000,
  JSON.stringify(keptTraits),
);
if (handAccount.id) deleteAccount(handAccount.id);
fakeModels = [{ id: "xinghuo-upstream-1", context_length: 8192 }];
fakeUpstream.close();

section("共性表开关");

// 合成顺序：人工元数据（外层）→ 行里的参数 → 代码表 → 共性表（开关开着且命中，
// 只补仍然没有的字段）→ 最小形状。按字段取，不是整条替换；判据是「这个键在不
// 在」，所以上游明确的 false 与空档位也算说过了。
//
// longcat-flash-lite 在共性表里报窗口与输出上限，不报能不能思考、能不能调工具、
// 档位；下面那行给它写了 reasoning=false 与一个更小的输出上限，代码表给它工具与
// 档位。
// glm-5-1 在共性表里是 reasoning=true：行里明确说 false，共性表不许把它翻过来。
// tiers-demo-1 不在共性表里，行里明确说「没有档位」（空数组）：代码表那三档不许回
// 来。
const COMMON_ID = "longcat-flash-lite";
const REASONING_ID = "glm-5-1";
const NO_TIERS_ID = "tiers-demo-1";
const UNKNOWN_ID = "not-in-the-common-table-at-all";
// 代码表（假的）：只给这两条，且只给共性表里没有的那几格。
const demoKnown = (id: string): any =>
  id === COMMON_ID
    ? { id, displayName: "LongCat Flash Lite", toolCall: true, effortOptions: ["low", "high"] }
    : id === NO_TIERS_ID
      ? { id, displayName: "Tiers Demo", toolCall: true, effortOptions: ["low", "high", "max"] }
      : undefined;

const commonRow = createOpenPlatform({ id: "common-demo", label: "共性表", baseUrl: "https://common.test/v1" });
check("建一行来查共性表", commonRow.ok === true, commonRow.message);
const commonWritten = updateOpenPlatform("common-demo", {
  models: [COMMON_ID, NO_TIERS_ID, REASONING_ID, UNKNOWN_ID],
  traits: {
    [COMMON_ID]: { maxOutputTokens: 4096, reasoning: false },
    [NO_TIERS_ID]: { efforts: [] },
    [REASONING_ID]: { reasoning: false },
    [UNKNOWN_ID]: { contextWindow: 7777 },
  },
});
check("目录与参数写进去了", commonWritten.ok === true, commonWritten.message);
check(
  "开关默认关着",
  openPlatformOf("common-demo")?.traitsFromCommon === false,
  String(openPlatformOf("common-demo")?.traitsFromCommon),
);

const mergedOff = catalogModelsFromRow({ platform: "common-demo" }, () => [], demoKnown);
check(
  "开关关：行里的参数盖代码表（输出上限、能不能思考）",
  mergedOff[0]?.maxOutputTokens === 4096 && mergedOff[0]?.reasoning === false,
  JSON.stringify(mergedOff[0]),
);
check(
  "开关关：行里没说的那几格回代码表（能不能调工具、档位、名字）",
  mergedOff[0]?.toolCall === true &&
    mergedOff[0]?.effortOptions?.join(",") === "low,high" &&
    mergedOff[0]?.displayName === "LongCat Flash Lite" &&
    mergedOff[0]?.contextWindow === undefined,
  JSON.stringify(mergedOff[0]),
);
check(
  "开关关：上游说没有档位就是没有（代码表那三档不回来）",
  Array.isArray(mergedOff[1]?.effortOptions) && mergedOff[1]?.effortOptions?.length === 0,
  JSON.stringify(mergedOff[1]),
);
check(
  "开关关：空档位的那条与另外几格无关（工具与名字照旧）",
  mergedOff[1]?.toolCall === true && mergedOff[1]?.displayName === "Tiers Demo",
  JSON.stringify(mergedOff[1]),
);
check(
  "开关关：行里只说了 false 的那一条就是最小形状加 false",
  JSON.stringify(mergedOff[2]) === JSON.stringify({ id: REASONING_ID, displayName: REASONING_ID, reasoning: false }),
  JSON.stringify(mergedOff[2]),
);
check(
  "开关关：行里的窗口与未命中那一条",
  JSON.stringify(mergedOff[3]) === JSON.stringify({ id: UNKNOWN_ID, displayName: UNKNOWN_ID, contextWindow: 7777 }),
  JSON.stringify(mergedOff[3]),
);

// 面板上把那个勾打开（presence：给了才写）。
const commonOn = await (adminService as any).updatePlatform({ id: "common-demo", traitsFromCommon: true }, {});
check("勾打开了", (commonOn as any)?.platform !== undefined, String((commonOn as any)?.platform?.id));
check(
  "库里记下了",
  openPlatformOf("common-demo")?.traitsFromCommon === true,
  String(openPlatformOf("common-demo")?.traitsFromCommon),
);
const listedCommon = ((await (adminService as any).listUpstreams({}, {})) as any).upstreams.find(
  (u: any) => u.id === "common-demo",
);
check(
  "ListUpstreams 把这一格报给面板",
  listedCommon?.traitsFromCommon === true,
  JSON.stringify([listedCommon?.traitsFromCommon, listedCommon?.modelsAuto]),
);

const mergedOn = catalogModelsFromRow({ platform: "common-demo" }, () => [], demoKnown);
check("开关开：只补字段，不造模型", mergedOn.length === mergedOff.length, JSON.stringify(mergedOn));
check(
  "开关开 + 命中：窗口取自共性表（前两层都没说过）",
  mergedOn[0]?.contextWindow === 256000,
  JSON.stringify(mergedOn[0]),
);
check(
  "共性表报得再大也不盖行里明确的输出上限",
  mergedOn[0]?.maxOutputTokens === 4096,
  JSON.stringify(mergedOn[0]),
);
check(
  "共性表说的 reasoning=true 不盖行里明确的 false",
  mergedOn[2]?.reasoning === false,
  JSON.stringify(mergedOn[2]),
);
check(
  "共性表仍然补行里没有的那几格（窗口、输出上限、能不能调工具）",
  mergedOn[2]?.contextWindow === 200000 &&
    mergedOn[2]?.maxOutputTokens === 128000 &&
    mergedOn[2]?.toolCall === true,
  JSON.stringify(mergedOn[2]),
);
check(
  "共性表不把空档位顶回代码表那几档",
  Array.isArray(mergedOn[1]?.effortOptions) && mergedOn[1]?.effortOptions?.length === 0,
  JSON.stringify(mergedOn[1]),
);
check(
  "共性表没说的字段回行里（能不能思考）",
  mergedOn[0]?.reasoning === false,
  JSON.stringify(mergedOn[0]),
);
check(
  "共性表没说的字段回代码表（能不能调工具、档位、名字）",
  mergedOn[0]?.toolCall === true &&
    mergedOn[0]?.effortOptions?.join(",") === "low,high" &&
    mergedOn[0]?.displayName === "LongCat Flash Lite",
  JSON.stringify(mergedOn[0]),
);
check(
  "开关开 + 未命中：与关着的时候一样",
  JSON.stringify(mergedOn[3]) === JSON.stringify(mergedOff[3]),
  JSON.stringify([mergedOn[3], mergedOff[3]]),
);

// 只改别的字段的单子不能把这个开关清零（presence：没给 = 别动）。
const commonRename = await (adminService as any).updatePlatform({ id: "common-demo", label: "改个名字" }, {});
check("改名那一单存下去了", (commonRename as any)?.platform !== undefined, String((commonRename as any)?.platform?.id));
check(
  "没给这一格就不动它（名字改了，开关还开着）",
  openPlatformOf("common-demo")?.label === "改个名字" && openPlatformOf("common-demo")?.traitsFromCommon === true,
  JSON.stringify({ label: openPlatformOf("common-demo")?.label, on: openPlatformOf("common-demo")?.traitsFromCommon }),
);
const mergedAfterRename = catalogModelsFromRow({ platform: "common-demo" }, () => [], demoKnown);
check(
  "改名不影响合成",
  JSON.stringify(mergedAfterRename) === JSON.stringify(mergedOn),
  JSON.stringify(mergedAfterRename),
);

// 显式关掉：回到改动前那一份。
await (adminService as any).updatePlatform({ id: "common-demo", traitsFromCommon: false }, {});
check(
  "显式关掉",
  openPlatformOf("common-demo")?.traitsFromCommon === false,
  String(openPlatformOf("common-demo")?.traitsFromCommon),
);
check(
  "关掉之后又跟改动前一样",
  JSON.stringify(catalogModelsFromRow({ platform: "common-demo" }, () => [], demoKnown)) === JSON.stringify(mergedOff),
  JSON.stringify(catalogModelsFromRow({ platform: "common-demo" }, () => [], demoKnown)),
);

deleteOpenPlatform("common-demo");
check("收尾删干净了", openPlatformOf("common-demo") === null, String(openPlatformOf("common-demo")));

section("老库模拟");

// 老库的平台表没有 kind 与 region 两列：迁移得把它们补上。
store().exec("ALTER TABLE platform DROP COLUMN kind");
store().exec("ALTER TABLE platform DROP COLUMN region");
// 共性表那个开关也是后来加的列，老库里没有 —— 迁移要补成关。
store().exec("ALTER TABLE platform DROP COLUMN traits_from_common");
// 用户改过的名字：迁移不能把它盖掉（已有的行不动）。
store().prepare("UPDATE platform SET label = ? WHERE id = ?").run("我改过的名字", "qiniu");
migratePlatforms(store());

check(
  "老库里那一行没被覆盖",
  openPlatformOf("qiniu")?.label === "我改过的名字",
  String(openPlatformOf("qiniu")?.label),
);
check(
  "老库那一行的地址也没被覆盖",
  openPlatformOf("qiniu")?.baseUrl === "https://api.qnaigc.com/v1",
  String(openPlatformOf("qiniu")?.baseUrl),
);
check("kind 列补回来了", openPlatformOf("qiniu")?.kind === "openai", String(openPlatformOf("qiniu")?.kind));
check("region 列补回来了", openPlatformOf("qiniu")?.region === "", JSON.stringify(openPlatformOf("qiniu")?.region));
check(
  "共性表那一列补回来了，默认关",
  openPlatformOf("qiniu")?.traitsFromCommon === false,
  String(openPlatformOf("qiniu")?.traitsFromCommon),
);
check(
  "别的厂商行没被补上（模板表没了，迁移不插行）",
  VENDOR_ROWS.filter((id) => id !== "qiniu" && id !== "xinghuo").every((id) => openPlatformOf(id) === null),
  VENDOR_ROWS.filter((id) => id !== "qiniu" && id !== "xinghuo" && openPlatformOf(id) !== null).join(","),
);
check(
  "用户自己建的那行没被动",
  openPlatformOf("slashy")?.label === "Slashy" && openPlatformOf("slashy")?.kind === "openai",
  JSON.stringify(openPlatformOf("slashy")),
);

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
