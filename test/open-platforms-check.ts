// test/open-platforms-check.ts — 平台的数据源：代码里的模板 + 表里的开放平台。
//
//   node --experimental-strip-types test/open-platforms-check.ts
//
// 离线：一个临时数据目录，不起服务，不发请求，不碰真凭据。
//
// 平台有两处数据源：代码里的模板（lib/platforms.ts）与表里的开放平台
// （lib/open-platforms.ts）。模板优先 —— 模板里有的 id，表里的那一行当没有：
// 把模板加回代码时不用先清库，回滚是安全的。
//
// 这里查的是：
//
//   1. 建一行 → 平台列表多出一条，kind 是 openai
//   2. id 的规矩：不合法、保留字、跟模板重名、跟账号重名、重名，都不收
//   3. 绕过校验插进去的一行（跟模板重名）被忽略，还是按模板算
//   4. 改名字、改地址、改模型目录（手写的目录 source 是 manual）；没收登记的
//      额度插件 id（没登记就不写库，原值留着）
//   5. 删掉以后平台列表回到基线
//   6. 坏掉的目录 JSON 读成空目录，不抛
//   7. 账号 id 与平台 id 相互独立：账号 id 是自增数，关联只靠 provider.platform
//   8. 只加载 lib/open-platforms.ts 的进程里，模板的判重照样生效
//   9. 表里那几行的 kind 是它们自己那一类（不是清一色的 openai），模板那一
//      侧（minimax 等）还是模板
//  10. 能建的平台种类：建的时候带 kind 写进去的是它、不带是 openai、不在清单
//      里的（含模拟客户端那类）拒收、建好之后换不了类型
//
// 断言里不写平台的个数：一律跟 PLATFORMS.length 与表里的行数比。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-platforms-"));
// 数据目录要在库被打开之前定下来：库是第一次用的时候才开的。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { PLATFORMS, allPlatforms, platformOfAny } = await import("../lib/platforms.ts");
const {
  createOpenPlatform,
  updateOpenPlatform,
  deleteOpenPlatform,
  listOpenPlatforms,
  openPlatformOf,
} = await import("../lib/open-platforms.ts");
const { addAccount, provider } = await import("../lib/providers.ts");
const { store, migratePlatforms, seedPlatformModels } = await import("../lib/store.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
// 引用即登记：这一节要拿 kind.models() 报的代码目录做对照。
await import("../lib/kinds/index.ts");
const { PLATFORM_TEMPLATES, PLATFORM_KIND_OPTIONS, platformKindOptionOf } = await import(
  "../lib/platform-catalog.ts"
);

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
 * 模板 + 表里那些 id 不撞模板的行：不写死个数，跟着数据源走。
 */
function expectedPlatformCount(): number {
  const rows = listOpenPlatforms();
  return PLATFORMS.length + rows.filter((row) => !PLATFORMS.some((p) => p.id === row.id)).length;
}

/** 迁移补进来的那几行的 id。 */
const SEEDED_IDS = new Set(PLATFORM_TEMPLATES.map((t) => t.key));

/**
 * 用户自己建的行：不是迁移补进来的那几行。
 *
 * 迁移补的那几行用的是模板的 id（qiniu 之类），它们在表里，但不算「用户加的
 * 开放平台」。
 */
function userPlatformRows(): { id: string }[] {
  return listOpenPlatforms().filter((row) => !SEEDED_IDS.has(row.id));
}

/** 往表里直接插一行：绕过校验，用来试「模板优先」。 */
function insertRow(id: string, label: string): void {
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO platform (id, label, base_url, models, models_auto, quota_plugin, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, label, "https://example.test/v1", "[]", 1, "", now, now);
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

// 模板那一侧：模拟端那五家还在代码里，kind 还是它们自己的。
check(
  "minimax 仍是模板",
  PLATFORMS.some((p) => p.id === "minimax") && platformOfAny("minimax")?.kind === "minimax",
  JSON.stringify(platformOfAny("minimax")),
);
check(
  "模板里的 id 不在表里（模板与表各管各的）",
  PLATFORMS.every((p) => openPlatformOf(p.id) === null),
  PLATFORMS.filter((p) => openPlatformOf(p.id) !== null).map((p) => p.id).join(","),
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
  "跟代码模板同 id 的不收",
  createOpenPlatform({
    id: PLATFORMS[0].id,
    label: "撞模板",
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

section("模板优先");

// 绕过校验直接插一行（跟模板重名）：这种行代码里不该有，但旧库里可能有。
const templateId = PLATFORMS[0].id;
const rowsBeforeInsert = listOpenPlatforms().length;
insertRow(templateId, "残留的行");
check(
  "表里确实多了一行",
  listOpenPlatforms().length === rowsBeforeInsert + 1,
  listOpenPlatforms().map((r) => r.id).join(","),
);
check(
  "跟模板同 id 的行被忽略",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);
check(
  "同 id 还是算模板",
  platformOfAny(templateId)?.label === PLATFORMS[0].label,
  JSON.stringify(platformOfAny(templateId)),
);
// 那一行说的是模板：改不了也删不了（假装改成功了更糟）。
const blockedUpdate = updateOpenPlatform(templateId, { label: "改一下" });
check(
  "模板的行改不了",
  blockedUpdate.ok === false && blockedUpdate.message.includes("代码里的平台"),
  blockedUpdate.message,
);
const blockedDelete = deleteOpenPlatform(templateId);
check(
  "模板的行删不了",
  blockedDelete.ok === false && blockedDelete.message.includes("代码里的平台"),
  blockedDelete.message,
);
check(
  "平台列表跟数据源对得上",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);
store().prepare("DELETE FROM platform WHERE id = ?").run(templateId);
check(
  "那行清掉了",
  listOpenPlatforms().length === rowsBeforeInsert,
  listOpenPlatforms().map((r) => r.id).join(","),
);

section("改");

const renamed = updateOpenPlatform("acme", { label: "Acme Cloud", baseUrl: "https://api.acme.test/v2" });
check("改得掉", renamed.ok === true, renamed.message);
const afterEdit = openPlatformOf("acme");
check("名字改了", afterEdit?.label === "Acme Cloud", String(afterEdit?.label));
check("地址改了", afterEdit?.baseUrl === "https://api.acme.test/v2", String(afterEdit?.baseUrl));
check("没给的字段没动", afterEdit?.quotaPlugin === "qiniu", String(afterEdit?.quotaPlugin));

// 没登记的插件 id：拒收，库里那一格原地不动 —— 存下去之后这个平台一条额度结论
// 都不会有，而面板上看着「已选插件」。
const badPluginId = updateOpenPlatform("acme", { quotaPlugin: "no-such-plugin" });
check("没登记的插件 id 不收", badPluginId.ok === false, badPluginId.message);
check(
  "拒绝的话说的是那个 id 与登记过的插件",
  badPluginId.message.includes("没有这个额度插件：no-such-plugin") &&
    badPluginId.message.includes("七牛云资源包"),
  badPluginId.message,
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
  "拒绝的话说的是那个 kind 与能建的两种方言（用 label）",
  badKind.message.includes("没有这一类平台：no-such-kind") &&
    badKind.message.includes("OpenAI 兼容") &&
    badKind.message.includes("Anthropic 兼容") &&
    // 厂商那五家不再列在候选里。
    !["七牛云", "讯飞星火", "SenseNova", "书生·端砚", "TokenRhythm"].some((name) =>
      badKind.message.includes(name),
    ),
  badKind.message,
);
check("被拒的那一行没写进表", openPlatformOf("kinds-bad") === null, JSON.stringify(openPlatformOf("kinds-bad")));

// 厂商与模拟客户端都不是用户能建的一类：厂商是本仓预置的模板（迁移补出来的
// 库行，kind 已经体现了协议差异），模拟客户端是一个客户端一份会话 —— 两种都
// 不该出现在下拉里，同一个理由，所以放在一条里比。
for (const kind of ["minimax", "sensenova"]) {
  const rejected = createOpenPlatform({
    id: `kinds-${kind}`,
    label: `Kinds ${kind}`,
    baseUrl: "https://simulated.test/v1",
    kind,
  });
  check(`厂商或模拟客户端类型不可建：${kind}`, rejected.ok === false, rejected.message);
  check(
    `${kind} 说的是没有这一类`,
    rejected.message.includes(`没有这一类平台：${kind}`),
    rejected.message,
  );
  check(`${kind} 那一行也没写进表`, openPlatformOf(`kinds-${kind}`) === null);
}

// 建好之后换不了类型：换类型要连它名下的凭据一起重算，那是另一件事。
const switched = updateOpenPlatform("kinds-demo", { kind: "openai", label: "Kinds Demo 改" });
check("换类型被拒", switched.ok === false, switched.message);
check("说的是不能换类型", switched.message.includes("不能换类型"), switched.message);
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
check("认不出的 kind 是 null", platformKindOptionOf("minimax") === null, JSON.stringify(platformKindOptionOf("minimax")));

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

// 一个只引 lib/open-platforms.ts 的进程（不引 lib/platforms.ts）：模板的判重
// 照样生效 —— 模板名单在叶子模块里，不靠谁在求值期登记。
const ONLY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-platforms-only-"));
const onlyRun = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "-e",
    `
      const { createOpenPlatform } = await import(${JSON.stringify(path.join(ROOT, "lib/open-platforms.ts"))});
      const res = createOpenPlatform({ id: "qoder", label: "撞模板", baseUrl: "https://only.test/v1" });
      console.log(JSON.stringify({ ok: res.ok, message: res.message }));
    `,
  ],
  {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: ONLY_DIR },
    encoding: "utf8",
  },
);
check("只加载 open-platforms 的进程跑得起来", onlyRun.status === 0, onlyRun.stderr?.slice(-300) ?? "");
let onlyBody: { ok?: boolean; message?: string } = {};
try {
  onlyBody = JSON.parse(onlyRun.stdout.trim().split("\n").pop() ?? "{}");
} catch {
  onlyBody = {};
}
check(
  "那个进程里撞模板的 id 照样被拒",
  onlyBody.ok === false && String(onlyBody.message ?? "").includes("代码里的平台"),
  JSON.stringify(onlyBody),
);
fs.rmSync(ONLY_DIR, { recursive: true, force: true });

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
