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
//
// 断言里不写平台的个数：一律跟表里的行数比。

import fs from "node:fs";
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
const { store, migratePlatforms, migrateSimulatedClients, seedPlatformModels, platformPresetRemoved } =
  await import("../lib/store.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
// 引用即登记：这一节要拿 kind.models() 报的代码目录做对照。
await import("../lib/kinds/index.ts");
const { PLATFORM_TEMPLATES, PLATFORM_KIND_OPTIONS, SIMULATED_CLIENTS, platformKindOptionOf, platformKindChoices } =
  await import("../lib/platform-catalog.ts");

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

/** 迁移与播种补进来的那几行的 id：厂商模板 + 会播种的模拟客户端。 */
const SEEDED_IDS = new Set([
  ...PLATFORM_TEMPLATES.map((t) => t.key),
  ...SIMULATED_CLIENTS.filter((c) => !c.hidden).map((c) => c.id),
]);

/** 目录里会播种的那几条：hidden 的不播（目录里留着条目，表里没有行）。 */
const SEEDED = SIMULATED_CLIENTS.filter((c) => !c.hidden);
const HIDDEN = SIMULATED_CLIENTS.filter((c) => c.hidden);

/**
 * 用户自己建的行：不是迁移或播种补进来的那几行。
 *
 * 补进来的那几行用的是目录里的 id（qiniu、minimax 之类），它们在表里，但不算
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

section("迁移补进来的平台行");

// 迁移把那五个还没迁完的平台补成了表里的行：新库一开就有。
check(
  "五个模板都补成了行",
  PLATFORM_TEMPLATES.length === 5 && PLATFORM_TEMPLATES.every((t) => openPlatformOf(t.key) !== null),
  PLATFORM_TEMPLATES.filter((t) => openPlatformOf(t.key) === null).map((t) => t.key).join(","),
);
for (const t of PLATFORM_TEMPLATES) {
  const seeded = openPlatformOf(t.key);
  check(`${t.key} 的 kind 是模板的`, seeded?.kind === t.kind, String(seeded?.kind));
  check(
    `${t.key} 的额度插件是模板的`,
    seeded?.quotaPlugin === t.quotaPlugin,
    JSON.stringify(seeded?.quotaPlugin),
  );
  check(`${t.key} 的名字跟模板一致`, seeded?.label === t.label, String(seeded?.label));
  check(
    `${t.key} 的地址是模板的默认地址`,
    seeded?.baseUrl === t.defaultBaseUrl,
    String(seeded?.baseUrl),
  );
  check(`${t.key} 没有区域`, seeded?.region === "", JSON.stringify(seeded?.region));
  // 目录：播种把手上已有的那一份搬进这一行。有代码目录的三家逐条对（顺序也
  // 对：目录的顺序决定面板与路由里的模型次序）；SenseNova 与书生·端砚的
  // 目录是问上游要来的（落在 cache 表里），这个测试里没有那一行 —— 那种情况
  // 下播种安静地留空，不是「必须为空」。
  const codeCatalog = (kindOf(t.kind)?.models(codeRow(t.key)) ?? []).map((model) => model.id);
  if (codeCatalog.length) {
    check(
      `${t.key} 的目录与代码目录逐条一致`,
      (seeded?.models.items ?? []).join(",") === codeCatalog.join(","),
      `${(seeded?.models.items ?? []).join(",")} / ${codeCatalog.join(",")}`,
    );
  } else {
    check(
      `${t.key}：cache 里没有目录时播种安静地留空`,
      (seeded?.models.items ?? []).length === 0,
      JSON.stringify(seeded?.models),
    );
  }
  // 平台列表里那一行用的是它自己的 kind：填成清一色的 openai 就把这一族
  // （七牛云要两段凭据、书生·端砚要两段）的差别抹掉了。
  check(
    `${t.key} 在平台列表里的 kind 是 ${t.kind}`,
    allPlatforms().find((p) => p.id === t.key)?.kind === t.kind,
    String(allPlatforms().find((p) => p.id === t.key)?.kind),
  );
}

// 播种不许覆盖已有的人工目录。跟 test/open-platform:kind 里那条「非空不覆盖」
// 不是一回事：那条看的是空不空，这条看的是来源 —— 人工那一行（source=manual、
// 自动那格关着）哪怕以后被清空，也不该被一次重启填回来。
const manualSeeded = createOpenPlatform({
  id: "seed-manual-row",
  label: "Seed Manual",
  baseUrl: "https://api.manual.test/v1",
});
check("人工目录的行建得起来", manualSeeded.ok === true, manualSeeded.message);
updateOpenPlatform("seed-manual-row", { models: ["hand-1"] });
seedPlatformModels(store());
const manualAfter = openPlatformOf("seed-manual-row");
check(
  "播种没改人工目录的模型",
  (manualAfter?.models.items ?? []).join(",") === "hand-1",
  JSON.stringify(manualAfter?.models),
);
check(
  "播种没把自动那一格打开",
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
  "拒绝的机器码是「没有这一类」，细节里带着那个 kind 与能建的两种方言",
  badKind.code === "PLATFORM_KIND_UNKNOWN" &&
    badKind.message.includes("no-such-kind") &&
    badKind.message.includes("openai") &&
    badKind.message.includes("anthropic") &&
    // 厂商那五家不再列在候选里。
    !["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"].some((kind) =>
      badKind.message.includes(kind),
    ),
  badKind.message,
);
check("被拒的那一行没写进表", openPlatformOf("kinds-bad") === null, JSON.stringify(openPlatformOf("kinds-bad")));

// 厂商那几家不是用户能建的一类：它们是本仓预置的模板（迁移补出来的库行，
// kind 已经体现了协议差异）。
for (const kind of ["sensenova"]) {
  const rejected = createOpenPlatform({
    id: `kinds-${kind}`,
    label: `Kinds ${kind}`,
    baseUrl: "https://simulated.test/v1",
    kind,
  });
  check(`厂商类型不可建：${kind}`, rejected.ok === false, rejected.message);
  check(
    `${kind} 的机器码说的是没有这一类`,
    rejected.code === "PLATFORM_KIND_UNKNOWN" && rejected.message.includes(kind),
    JSON.stringify(rejected),
  );
  check(`${kind} 那一行也没写进表`, openPlatformOf(`kinds-${kind}`) === null);
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

// 那张表本身：只有两种方言 —— 向上游讲 OpenAI 格式，还是讲 Anthropic Messages。
// 厂商那五家是本仓预置的模板（迁移补出来的库行），不是用户能选的一类，这是
// 本次收敛的判据：表里出现任何一个厂商 kind 都算坏掉。
const VENDOR_KINDS = ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"];
check("能建的一共两类", PLATFORM_KIND_OPTIONS.length === 2, String(PLATFORM_KIND_OPTIONS.length));
check(
  "两类就是两种方言，openai 在前",
  PLATFORM_KIND_OPTIONS.map((o) => o.kind).join(",") === "openai,anthropic",
  PLATFORM_KIND_OPTIONS.map((o) => o.kind).join(","),
);
check(
  "表里不含任何厂商 kind",
  VENDOR_KINDS.every(
    (kind) => platformKindOptionOf(kind) === null && !PLATFORM_KIND_OPTIONS.some((o) => o.kind === kind),
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
  "两类都没有默认地址（哪家服务只有用户知道）",
  PLATFORM_KIND_OPTIONS.every((o) => o.defaultBaseUrl === ""),
  JSON.stringify(PLATFORM_KIND_OPTIONS.map((o) => o.defaultBaseUrl)),
);
check(
  "两类都能从上游拉目录",
  PLATFORM_KIND_OPTIONS.every((o) => o.modelsFromUpstream === true),
  JSON.stringify(PLATFORM_KIND_OPTIONS.map((o) => o.modelsFromUpstream)),
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
  "方言那一族就是那两条",
  dialectChoices.map((c) => c.kind).join(",") === PLATFORM_KIND_OPTIONS.map((o) => o.kind).join(","),
  dialectChoices.map((c) => c.kind).join(","),
);
check(
  "方言类的 preset_id 与 region 都是空串",
  dialectChoices.every((c) => c.presetId === "" && c.region === ""),
  JSON.stringify(dialectChoices.map((c) => [c.presetId, c.region])),
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
  "厂商那几家也不在里面",
  VENDOR_KINDS.every((kind) => !choices.some((c) => c.kind === kind)),
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
const { openPlatformCatalogRefreshable, refreshOpenPlatformCatalog } = await import(
  "../lib/open-platform-catalog.ts"
);
// 用一条没被动过的播种行：上面那条（minimax）删过又建回来了，现在是一条用户建的
// 开放平台，kind 已经不是模拟端那一族，拿它验不到这里要验的东西。
const simId = SEEDED.find((c) => c.id !== SIMULATED_CLIENTS[0].id)!.id;
store().prepare("UPDATE platform SET models_auto = 1 WHERE id = ?").run(simId);
const simRow = openPlatformOf(simId);
check(
  "自动拉开着也不刷新",
  openPlatformCatalogRefreshable(simRow!) === false,
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

section("老库模拟");

// 老库的平台表没有 kind 与 region 两列：迁移得把它们补上。
store().exec("ALTER TABLE platform DROP COLUMN kind");
store().exec("ALTER TABLE platform DROP COLUMN region");
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
  "别的几行补上了",
  PLATFORM_TEMPLATES.filter((t) => t.key !== "qiniu").every((t) => openPlatformOf(t.key) !== null),
  PLATFORM_TEMPLATES.filter((t) => openPlatformOf(t.key) === null).map((t) => t.key).join(","),
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
