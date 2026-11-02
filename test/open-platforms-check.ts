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
//   4. 改名字、改地址、改模型目录（手写的目录 source 是 manual）
//   5. 删掉以后平台列表回到基线
//   6. 坏掉的目录 JSON 读成空目录，不抛
//   7. 平台 id 与账号 id 共用一个命名空间：撞了就分不清
//   8. 只加载 lib/open-platforms.ts 的进程里，模板的判重照样生效
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
const { addAccount } = await import("../lib/providers.ts");
const { store } = await import("../lib/store.ts");

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

section("新库");

check("新库里的平台就是模板那些", allPlatforms().length === PLATFORMS.length, `${allPlatforms().length}`);
check("新库里没有开放平台的行", listOpenPlatforms().length === 0, listOpenPlatforms().map((r) => r.id).join(","));
check(
  "平台列表跟数据源对得上",
  allPlatforms().length === expectedPlatformCount(),
  `${allPlatforms().length} vs ${expectedPlatformCount()}`,
);

section("建一行");

const created = createOpenPlatform({
  id: "acme",
  label: "Acme",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "acme",
});
check("开放平台加得进去", created.ok === true, created.message);
check("表里多了一行", listOpenPlatforms().length === 1, listOpenPlatforms().map((r) => r.id).join(","));
check(
  "平台列表多了一条",
  allPlatforms().length === PLATFORMS.length + 1,
  `${allPlatforms().length} vs ${PLATFORMS.length}`,
);
const row = openPlatformOf("acme");
check(
  "这一行读得回来",
  row?.label === "Acme" && row?.baseUrl === "https://api.acme.test/v1" && row?.quotaPlugin === "acme",
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
  listOpenPlatforms().length === 1,
  listOpenPlatforms().map((r) => r.id).join(","),
);

section("模板优先");

// 绕过校验直接插一行（跟模板重名）：这种行代码里不该有，但旧库里可能有。
const templateId = PLATFORMS[0].id;
insertRow(templateId, "残留的行");
check("表里确实多了一行", listOpenPlatforms().length === 2, listOpenPlatforms().map((r) => r.id).join(","));
check(
  "跟模板同 id 的行被忽略",
  allPlatforms().length === PLATFORMS.length + 1,
  `${allPlatforms().length} vs ${PLATFORMS.length}`,
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
check("那行清掉了", listOpenPlatforms().length === 1, listOpenPlatforms().map((r) => r.id).join(","));

section("改");

const renamed = updateOpenPlatform("acme", { label: "Acme Cloud", baseUrl: "https://api.acme.test/v2" });
check("改得掉", renamed.ok === true, renamed.message);
const afterEdit = openPlatformOf("acme");
check("名字改了", afterEdit?.label === "Acme Cloud", String(afterEdit?.label));
check("地址改了", afterEdit?.baseUrl === "https://api.acme.test/v2", String(afterEdit?.baseUrl));
check("没给的字段没动", afterEdit?.quotaPlugin === "acme", String(afterEdit?.quotaPlugin));

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

section("删");

const deleted = deleteOpenPlatform("acme");
check("删得掉", deleted.ok === true, deleted.message);
check("表里没了", listOpenPlatforms().length === 0, listOpenPlatforms().map((r) => r.id).join(","));
check(
  "平台列表回到基线",
  allPlatforms().length === PLATFORMS.length,
  `${allPlatforms().length} vs ${PLATFORMS.length}`,
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
  allPlatforms().length === PLATFORMS.length,
  `${allPlatforms().length} vs ${PLATFORMS.length}`,
);

section("账号 id 与平台 id");

// 账号 id 是 `<平台>-<序号>`，跟平台 id 长得一样：两边各查各的表，撞了面板
// 就分不清那个 id 说的是平台还是账号。
const qoderFirst = addAccount({ platform: "qoder" });
const qoderSecond = addAccount({ platform: "qoder" });
check(
  "qoder 名下的账号 id 是平台 id 加序号",
  qoderFirst.id === "qoder" && qoderSecond.id === "qoder-2",
  JSON.stringify([qoderFirst.id, qoderSecond.id]),
);
const clash = createOpenPlatform({
  id: "qoder-2",
  label: "撞账号",
  baseUrl: "https://clash.test/v1",
});
check("账号占着的 id 平台不能要", clash.ok === false, clash.message);
check(
  "撞账号的没写进表",
  listOpenPlatforms().some((row) => row.id === "qoder-2") === false,
  listOpenPlatforms().map((row) => row.id).join(","),
);

// 反过来：平台表占着的 id，账号也不能要（账号 id 跟平台 id 共用一个命名
// 空间）。
const zephyr = createOpenPlatform({
  id: "zephyr",
  label: "Zephyr",
  baseUrl: "https://zephyr.test/v1",
});
check("开放平台建得起来", zephyr.ok === true, zephyr.message);
const zephyrAccount = addAccount({ platform: "zephyr" });
check(
  "账号 id 跳过了平台表占着的那个",
  zephyrAccount.id === "zephyr-2",
  String(zephyrAccount.id),
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

fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
