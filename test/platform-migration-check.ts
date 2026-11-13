// test/platform-migration-check.ts — 模拟客户端那一族的平台行：播种与幂等。
//
//   node --experimental-strip-types test/platform-migration-check.ts
//
// 离线：临时数据目录，不起服务，不发请求，不碰真凭据。
//
// 平台的唯一数据源是表（lib/open-platforms.ts）。代码里的模板名单已经清空
// （lib/platform-templates.ts 的 PLATFORMS 是空数组），所以模拟客户端那一族
// 靠启动时的播种补行（lib/store.ts 的 migrateSimulatedClients，目录在
// lib/platform-catalog.ts 的 SIMULATED_CLIENTS）。播种晚一步，那个客户端的
// 请求就是 404 —— 这一份查的就是「晚没晚」与「会不会盖掉用户的值」。
//
//   1. 空库启动后 hidden === false 的那几条都在，kind 与 region 跟目录一致；
//      hidden 的那一条（zcode）不播，但目录里的条目还在
//   1.1 厂商那几行不再补：表里只有目录里该播的那几条（平台模板表已删，平台行
//       是用户在面板上自己建的）
//   1.2 已有库的行不被任何启动逻辑改写（目录空着的行，重启之后还是空的）
//   2. 老库升级：已有的一行一个字段都不改（用户改过的名字留着）
//   3. 重启两次：行数与字段都不变
//   4. PLATFORMS 为空时平台仍然在 —— 清空模板与播种这对改动的判别力
//   5. 表里已经有个叫 qoder 的开放平台：播种不覆盖它、也不报错
//   6. 删掉的预置平台不会在重启时长回来（墓碑表），用户自己建回来会清墓碑
//   7. 墓碑表里躺着一个不相干的 id：不影响别的平台播种
//   8. 墓碑与删行同一步生效：删完之后墓碑在、行没有，再播种也补不回来
//   9. 删 → 建 → 删：第二次删要把墓碑重新写上（少了它就重启长回来）
//  10. 删两次：第二次报「没有这个平台」，且不重写墓碑（没删到东西就不记用户删过）
//
// 这一份查的是「删了就是没了」：播种是「表里没有就补一行」，补不出「用户删过它」
// 这件事 —— 不留墓碑的话，删掉的平台下次启动就带着空配置回来。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

// 数据目录要在库被打开之前定下来：库是第一次用的时候才开的。
const FRESH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "platform-migration-fresh-"));
process.env.BUDDY_DATA_DIR = FRESH_DIR;

const { PLATFORMS, allPlatforms } = await import("../lib/platforms.ts");
const { openPlatformOf, listOpenPlatforms, createOpenPlatform, deleteOpenPlatform } = await import(
  "../lib/open-platforms.ts"
);
const { SIMULATED_CLIENTS, platformCategoryOfKind } = await import("../lib/platform-catalog.ts");
const { store, closeStore, migrateSimulatedClients, platformPresetRemoved } = await import(
  "../lib/store.ts"
);

const SEEDED = SIMULATED_CLIENTS.filter((c) => !c.hidden);

/**
 * 表里所有平台行的样子（连时间戳一起）。
 *
 * 用 JSON 字符串比而不是逐字段比：这样「多了什么、少了什么、哪一格变了」都在
 * 一行 diff 里，重启前后有没有动过一眼看得出。
 */
function snapshot(): string {
  return JSON.stringify(
    store()
      .prepare(
        "SELECT id, label, base_url, models, models_auto, quota_plugin, kind, region, " +
          "created_at, updated_at FROM platform ORDER BY id",
      )
      .all(),
  );
}

/* ------------------------------------------------------------------ *
 * 一、空库启动
 * ------------------------------------------------------------------ */

section("空库启动");

check("代码里的模板名单是空的", PLATFORMS.length === 0, String(PLATFORMS.length));

const booted = allPlatforms();
// 判别力就在这一条：代码里的名单空了，平台仍然在，因为启动时把目录播进了表。
// 播种那一步没了的话，这里红。
check(
  "PLATFORMS 为空时模拟客户端仍然在",
  PLATFORMS.length === 0 && SEEDED.every((c) => booted.some((p) => p.id === c.id)),
  `${PLATFORMS.length} / ${SEEDED.filter((c) => !booted.some((p) => p.id === c.id))
    .map((c) => c.id)
    .join(",")}`,
);
for (const client of SEEDED) {
  const platform = booted.find((p) => p.id === client.id);
  check(`${client.id} 的 kind 是 ${client.kind}`, platform?.kind === client.kind, String(platform?.kind));
  check(
    `${client.id} 的 region 是 ${JSON.stringify(client.region)}`,
    platform?.region === client.region,
    JSON.stringify(platform?.region),
  );
}
// 目录条目全留着，`hidden` 这个开关也留着 —— 收起来的条目没了就没有开关了。
check(
  "目录里每一条都是 hidden: false",
  SIMULATED_CLIENTS.every((c) => c.hidden === false),
  SIMULATED_CLIENTS.map((c) => `${c.id}:${c.hidden}`).join(","),
);
// zcode 放开之后跟别的条目一样播种：表里那一行的 kind 与 region 照目录。
const zcodePreset = SIMULATED_CLIENTS.find((c) => c.id === "zcode");
const zcodeRow = openPlatformOf("zcode");
check(
  "zcode 也按目录播进了表里",
  zcodePreset !== undefined && zcodeRow?.kind === zcodePreset.kind && zcodeRow?.region === zcodePreset.region,
  `${String(zcodeRow?.kind)} / ${JSON.stringify(zcodeRow?.region)}`,
);
// 厂商那几行（七牛云、星火、SenseNova、端砚、TokenRhythm）不再补：平台行是
// 用户在面板上自己建的，代码里没有模板表了。表里只有目录里该播的那几条。
check(
  "新库启动后表里只有目录里该播的那几条",
  booted.map((p) => p.id).sort().join(",") === SEEDED.map((c) => c.id).sort().join(","),
  booted.map((p) => p.id).join(","),
);

// 播种写进去的那几格：地址空串、目录空、不自动拉、没有额度插件。
const seededRow = openPlatformOf(SIMULATED_CLIENTS[0].id);
check("播种的行地址是空串", seededRow?.baseUrl === "", JSON.stringify(seededRow?.baseUrl));
check("播种的行目录是空的", (seededRow?.models.items ?? []).length === 0, JSON.stringify(seededRow?.models));
check(
  "播种的那一行是模拟客户端（目录由代码给出）",
  platformCategoryOfKind(seededRow?.kind ?? "") === "simulated",
  seededRow?.kind ?? "",
);
check("播种的行没有额度插件", seededRow?.quotaPlugin === "", JSON.stringify(seededRow?.quotaPlugin));

// 已有库的行不被任何启动逻辑改写：插一行目录空着的厂商行（以前那一轮播种会
// 把它填上），重启之后它还是那样 —— 空的还是空的，那一格开关也没被动。
store()
  .prepare(
    "INSERT INTO platform " +
      "(id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, '', ?, '', ?, ?)",
  )
  .run(
    "vendor-keep",
    "Vendor Keep",
    "https://vendor.test/v1",
    JSON.stringify({ items: [], fetchedAt: 0, source: "auto" }),
    1,
    "qiniu",
    Date.now(),
    Date.now(),
  );

/* ------------------------------------------------------------------ *
 * 二、重启两次
 * ------------------------------------------------------------------ */

section("重启两次");

const afterBoot = snapshot();
const rowsAfterBoot = listOpenPlatforms().length;
closeStore();
allPlatforms();
check("重启一次行数不变", listOpenPlatforms().length === rowsAfterBoot, String(listOpenPlatforms().length));
check("重启一次字段不变", snapshot() === afterBoot, snapshot());
closeStore();
allPlatforms();
check("重启两次行数不变", listOpenPlatforms().length === rowsAfterBoot, String(listOpenPlatforms().length));
check("重启两次字段不变", snapshot() === afterBoot, snapshot());
// 那一行目录空着的厂商行：启动不改写它（不再有播种这一说）。
const keptRow = openPlatformOf("vendor-keep");
check(
  "已有库的行没被启动改写（目录还是空的）",
  (keptRow?.models.items ?? []).length === 0,
  JSON.stringify(keptRow?.models),
);
check(
  "已有库的行没被启动改写（目录还是空的）",
  (keptRow?.models.items ?? []).length === 0,
  JSON.stringify(keptRow?.models),
);

closeStore();
fs.rmSync(FRESH_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 三、老库升级
 * ------------------------------------------------------------------ */

section("老库升级");

// 手搭一个「老库」：平台表还是没迁移之前的样子（没有 kind 与 region 两列），
// 里面已经有一行 minimax（用户改过名字），还有一行叫 qoder 的开放平台 ——
// id 跟模拟客户端撞了，这种库不该有，但播种得容得下它。
const OLD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "platform-migration-old-"));
const OLD_FILE = path.join(OLD_DIR, "buddy.db");
{
  const old = new DatabaseSync(OLD_FILE);
  old.exec(
    `CREATE TABLE platform (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      models       TEXT NOT NULL DEFAULT '[]',
      models_auto  INTEGER NOT NULL DEFAULT 1,
      quota_plugin TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )`,
  );
  const now = Date.now();
  const insert = old.prepare(
    "INSERT INTO platform (id, label, base_url, models, models_auto, quota_plugin, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("minimax", "我改过的名字", "", "[]", 0, "", now, now);
  insert.run("qoder", "我的中转站", "https://relay.test/v1", '["relay-1"]', 0, "", now, now);
  old.close();
}
process.env.BUDDY_DATA_DIR = OLD_DIR;

// 打开库就是跑迁移（openDatabase 里有播种）。
const upgraded = allPlatforms();
// 老库开出来就是「会播种的那几条」：厂商那几行不再补（模板表没了），原本那
// 两行（minimax 与 qoder）本来就是目录里该播的。
const expectedIds = SEEDED.map((c) => c.id).sort();
check(
  "老库里那两行还在，缺的行补上了",
  upgraded.map((p) => p.id).sort().join(",") === expectedIds.join(","),
  upgraded.map((p) => p.id).join(","),
);
const minimaxRow = openPlatformOf("minimax");
check(
  "已有的 minimax 行没被改名",
  minimaxRow?.label === "我改过的名字",
  String(minimaxRow?.label),
);
check(
  "已有的 minimax 行的 kind 没被动（老库里它是默认的 openai）",
  minimaxRow?.kind === "openai",
  String(minimaxRow?.kind),
);
const qoderRow = openPlatformOf("qoder");
check(
  "叫 qoder 的开放平台没被覆盖",
  qoderRow?.label === "我的中转站" && qoderRow?.baseUrl === "https://relay.test/v1",
  JSON.stringify([qoderRow?.label, qoderRow?.baseUrl]),
);
check(
  "它的目录也没被动",
  (qoderRow?.models.items ?? []).join(",") === "relay-1",
  JSON.stringify(qoderRow?.models),
);
check(
  "没撞上的那几条是播种写的（kind 跟目录一致）",
  SEEDED.filter((c) => c.id !== "minimax" && c.id !== "qoder").every(
    (c) => openPlatformOf(c.id)?.kind === c.kind,
  ),
  SEEDED.filter((c) => c.id !== "minimax" && c.id !== "qoder")
    .map((c) => `${c.id}:${String(openPlatformOf(c.id)?.kind)}`)
    .join(","),
);
check(
  "老库里撞车不报错（库开着就说明没抛）",
  qoderRow !== null,
  JSON.stringify(qoderRow?.id),
);

// 再播种一次：一个字段都不动，也不报错。
const beforeRepeat = snapshot();
let repeatError = "";
try {
  migrateSimulatedClients(store());
} catch (e) {
  repeatError = (e as Error)?.message ?? String(e);
}
check("再播种一次不报错", repeatError === "", repeatError);
check("再播种一次一个字段都不动", snapshot() === beforeRepeat, snapshot());

closeStore();
fs.rmSync(OLD_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 三、五、厂商 kind 退场：存量行迁到 openai，凭据搬到新位置
 * ------------------------------------------------------------------ */

section("厂商 kind 退场：存量行迁到 openai");

const VENDOR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "platform-migration-vendor-"));
{
  // 先开一次库拿到完整表结构，再把它改成旧库的样子：一行 kind=qiniu（地址是
  // 一台从未生效过的旧机器）、推理 key 还在 `:account` 的 apiKey 里（门户
  // cookie 与它同住一段）、user_version 归零 —— 重开库时 migrateLegacyVendorKinds
  // 就会跑。
  process.env.BUDDY_DATA_DIR = VENDOR_DIR;
  const fresh = store();
  fresh
    .prepare(
      "INSERT INTO platform (id, label, base_url, models, quota_plugin, kind, created_at, updated_at) " +
        "VALUES ('qiniu', '七牛云', 'https://stale.example/v1', ?, 'qiniu', 'qiniu', 1, 1)",
    )
    .run(JSON.stringify({ items: ["m1"], traits: { m1: { contextWindow: 8192 } }, fetchedAt: 0 }));
  fresh
    .prepare("INSERT INTO provider (id, platform, created_at, updated_at) VALUES ('77', 'qiniu', 1, 1)")
    .run();
  fresh
    .prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, 'account', ?, 1)")
    .run("key:provider:77:account", JSON.stringify({ apiKey: "sk-old-key", portalCookie: "pc=1" }));
  fresh.exec("PRAGMA user_version = 0");
  closeStore();
}

// 重开库：迁移在开库时跑。
allPlatforms();

const vendorRow = openPlatformOf("qiniu");
check("kind 改成了 openai", vendorRow?.kind === "openai", String(vendorRow?.kind));
check(
  "base_url 是七牛的常量推理地址（不是行里原来那台旧机器）",
  vendorRow?.baseUrl === "https://api.qnaigc.com/v1",
  String(vendorRow?.baseUrl),
);
check("quota_plugin 原样留着（插件按行挂，不随 kind 迁移）", vendorRow?.quotaPlugin === "qiniu", String(vendorRow?.quotaPlugin));
check(
  "models（含 traits）原样留着（目录在行里，不属于 kind）",
  (vendorRow?.models.items ?? []).join(",") === "m1" &&
    (vendorRow?.models.traits?.m1 as any)?.contextWindow === 8192,
  JSON.stringify(vendorRow?.models),
);
{
  // 推理 key 搬到开放平台读的那一处：`key:provider:<账号>:key` 的 {apiKey}。
  // 目标已有就不覆盖（ON CONFLICT DO NOTHING），这里目标本来没有。
  const moved = store()
    .prepare("SELECT data FROM secrets WHERE id = 'key:provider:77:key'")
    .get() as { data?: string } | undefined;
  check(
    "推理 key 到了 key:provider:77:key",
    JSON.parse(moved?.data ?? "{}").apiKey === "sk-old-key",
    String(moved?.data),
  );
  // 原来那段一律不动：额度插件读的就是它（门户 cookie 在里面）。
  const kept = store()
    .prepare("SELECT data FROM secrets WHERE id = 'key:provider:77:account'")
    .get() as { data?: string } | undefined;
  const keptData = JSON.parse(kept?.data ?? "{}") as Record<string, unknown>;
  check(
    ":account 的门户 cookie 还在，apiKey 也没被抹掉",
    keptData.portalCookie === "pc=1" && keptData.apiKey === "sk-old-key",
    String(kept?.data),
  );
}

// 幂等：再跑一遍迁移，什么都不要再动。
closeStore();
allPlatforms();
const vendorRowAgain = openPlatformOf("qiniu");
check(
  "重跑一遍迁移：行还是迁移后的样子",
  vendorRowAgain?.kind === "openai" && vendorRowAgain?.baseUrl === "https://api.qnaigc.com/v1",
  JSON.stringify([vendorRowAgain?.kind, vendorRowAgain?.baseUrl]),
);

closeStore();
fs.rmSync(VENDOR_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 四、删掉的预置平台不会长回来
 * ------------------------------------------------------------------ */

section("墓碑：删了就是没了");

const TOMB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "platform-tombstone-"));
process.env.BUDDY_DATA_DIR = TOMB_DIR;
allPlatforms();

// 脏墓碑：一个目录里根本没有的 id（早先删过、目录里早就不存在了）。它不该拖累
// 别人 —— 播种是按 id 比对的，比不到就当没这一条。
//
// 先把平台行清空：行还在的话「播种没被挡住」这一条恒真，什么也证不了。
store().exec("DELETE FROM platform");
store()
  .prepare("INSERT OR REPLACE INTO platform_preset_removed (id, removed_at) VALUES (?, ?)")
  .run("ghost-preset", Date.now());
closeStore();
allPlatforms();
check(
  "墓碑表里的脏 id 不影响别的平台播种",
  SEEDED.every((c) => openPlatformOf(c.id) !== null),
  SEEDED.filter((c) => openPlatformOf(c.id) === null)
    .map((c) => c.id)
    .join(","),
);
check("脏 id 自己也没被播成平台", openPlatformOf("ghost-preset") === null, "ghost-preset");

// 1. 删 minimax → 重启不长回来
check("删之前 minimax 在", openPlatformOf("minimax") !== null);
const deletedMinimax = deleteOpenPlatform("minimax");
check("minimax 删得掉", deletedMinimax.ok === true, deletedMinimax.message);
check("删完之后行没了", openPlatformOf("minimax") === null);
check("删预置平台留了墓碑", platformPresetRemoved("minimax") === true);
closeStore();
allPlatforms();
check("删掉的不会被重启播种长回来", openPlatformOf("minimax") === null, JSON.stringify(openPlatformOf("minimax")));
// 3. 回归：没删过的照常播种，且一个字段都没被动。
check(
  "没删过的照旧在",
  SEEDED.filter((c) => c.id !== "minimax").every((c) => openPlatformOf(c.id)?.kind === c.kind),
  SEEDED.filter((c) => c.id !== "minimax")
    .map((c) => `${c.id}:${String(openPlatformOf(c.id)?.kind)}`)
    .join(","),
);
check(
  "重启没把名字拨回目录值",
  SEEDED.filter((c) => c.id !== "minimax").every((c) => openPlatformOf(c.id)?.label === c.label),
  SEEDED.filter((c) => c.id !== "minimax")
    .map((c) => `${c.id}:${String(openPlatformOf(c.id)?.label)}`)
    .join(","),
);

// 2. 用户明确把它建回来：墓碑清掉，行是用户的（名字、地址都是他写的）
const rebuilt = createOpenPlatform({
  id: "minimax",
  label: "我的 MiniMax",
  baseUrl: "https://minimax.test/v1",
});
check("同名建得回来", rebuilt.ok === true, rebuilt.message);
check("建回来之后墓碑清掉了", platformPresetRemoved("minimax") === false);
closeStore();
allPlatforms();
check("重启之后行还在", openPlatformOf("minimax") !== null);
check(
  "重启之后名字还是用户起的那个（没被播种盖成目录值）",
  openPlatformOf("minimax")?.label === "我的 MiniMax",
  String(openPlatformOf("minimax")?.label),
);
check(
  "重启之后地址也是用户填的",
  openPlatformOf("minimax")?.baseUrl === "https://minimax.test/v1",
  String(openPlatformOf("minimax")?.baseUrl),
);

closeStore();
fs.rmSync(TOMB_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 五、墓碑与删行是一件事
 * ------------------------------------------------------------------ */

section("墓碑与删行是一件事");

// 两句分开写（先删行、后写墓碑）时，中间被杀就出现「行没了、墓碑也没了」——
// 下面是那个残局的反面：删完这一下读回来，墓碑与「行没了」必须同时成立。
// 判断的判别力在预置 id 上：非预置的 id 不写墓碑，比了也证不了什么。
const ATOMIC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "platform-tombstone-atomic-"));
process.env.BUDDY_DATA_DIR = ATOMIC_DIR;
allPlatforms();

check("删之前 qoder-cn 在", openPlatformOf("qoder-cn") !== null);
const deletedQoderCn = deleteOpenPlatform("qoder-cn");
check("qoder-cn 删得掉", deletedQoderCn.ok === true, deletedQoderCn.message);
check(
  "删完之后墓碑在、行没有（两件事一起成立）",
  platformPresetRemoved("qoder-cn") === true && openPlatformOf("qoder-cn") === null,
  JSON.stringify([platformPresetRemoved("qoder-cn"), openPlatformOf("qoder-cn")]),
);
// 不重启，直接再播一次：播种读的就是墓碑，读到就跳。
migrateSimulatedClients(store());
check(
  "删完之后直接播种也补不回来",
  platformPresetRemoved("qoder-cn") === true && openPlatformOf("qoder-cn") === null,
  JSON.stringify([platformPresetRemoved("qoder-cn"), openPlatformOf("qoder-cn")]),
);
closeStore();
allPlatforms();
check("重启之后 qoder-cn 仍然没有", openPlatformOf("qoder-cn") === null, "qoder-cn");

// 删 → 建 → 删：建的时候清墓碑、第二次删的时候必须重新写上。少写那一句的话，
// 第二次删之后墓碑是空的，重启把平台带着空配置插回来 —— 用户的删除被吞掉。
const removedOnce = deleteOpenPlatform("workbuddy-cn");
check("workbuddy-cn 第一次删得掉", removedOnce.ok === true, removedOnce.message);
const rebuiltCn = createOpenPlatform({
  id: "workbuddy-cn",
  label: "我又建了一次",
  baseUrl: "https://workbuddy.test/v1",
});
check("workbuddy-cn 建得回来", rebuiltCn.ok === true, rebuiltCn.message);
check("建回来之后墓碑清掉了", platformPresetRemoved("workbuddy-cn") === false);
const removedTwice = deleteOpenPlatform("workbuddy-cn");
check("workbuddy-cn 第二次也删得掉", removedTwice.ok === true, removedTwice.message);
check(
  "第二次删之后墓碑仍在、行仍没有",
  platformPresetRemoved("workbuddy-cn") === true && openPlatformOf("workbuddy-cn") === null,
  JSON.stringify([platformPresetRemoved("workbuddy-cn"), openPlatformOf("workbuddy-cn")]),
);
migrateSimulatedClients(store());
closeStore();
allPlatforms();
check(
  "第二次删之后重启也不长回来（墓碑重写了）",
  platformPresetRemoved("workbuddy-cn") === true && openPlatformOf("workbuddy-cn") === null,
  JSON.stringify([platformPresetRemoved("workbuddy-cn"), openPlatformOf("workbuddy-cn")]),
);

closeStore();
fs.rmSync(ATOMIC_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 六、删不到东西就不该记「用户删过」
 * ------------------------------------------------------------------ */

section("删两次：第二次不动墓碑");

// 存在性检查留在事务外的话，读到行与进事务之间别的进程能把这一行删掉 —— 那一删
// 与这一删落到同一次「删」，下面的断言查的就是这一路：删不到东西的时候既不报
// 成功，也不写墓碑。
const TWICE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "platform-tombstone-twice-"));
process.env.BUDDY_DATA_DIR = TWICE_DIR;
allPlatforms();

/** 墓碑里记的时刻。没有这一行就是 null。 */
function tombstoneAt(id: string): number | null {
  const row = store()
    .prepare("SELECT removed_at FROM platform_preset_removed WHERE id = ?")
    .get(id) as { removed_at?: number } | undefined;
  return row ? Number(row.removed_at ?? 0) : null;
}

check("删之前 minimax 在", openPlatformOf("minimax") !== null);
const twiceFirst = deleteOpenPlatform("minimax");
check("第一次删得掉", twiceFirst.ok === true, twiceFirst.message);
check("第一次删完墓碑在", tombstoneAt("minimax") !== null, String(tombstoneAt("minimax")));
// 重写墓碑用的也是 Date.now()，与第一次同一毫秒的话比时间戳看不出差别。钉一个
// Date.now() 造不出来的值：「墓碑被重写」就一定看得见。
store().prepare("UPDATE platform_preset_removed SET removed_at = 1 WHERE id = ?").run("minimax");
const twiceSecond = deleteOpenPlatform("minimax");
check(
  "第二次删不到东西：机器码是 PLATFORM_NOT_FOUND",
  twiceSecond.ok === false && twiceSecond.code === "PLATFORM_NOT_FOUND",
  JSON.stringify(twiceSecond),
);
check("第二次没重写墓碑", tombstoneAt("minimax") === 1, String(tombstoneAt("minimax")));

// 墓碑留着，行没了：再删一次仍然是这一对状态 —— 墓碑不该被「再删一次」顺手抹掉。
check("删之前 qoder 在", openPlatformOf("qoder") !== null);
const qoderDeleted = deleteOpenPlatform("qoder");
check("预置平台删得掉", qoderDeleted.ok === true, qoderDeleted.message);
check(
  "删完墓碑在、行没有",
  tombstoneAt("qoder") !== null && openPlatformOf("qoder") === null,
  JSON.stringify([tombstoneAt("qoder"), openPlatformOf("qoder")]),
);
const qoderAgain = deleteOpenPlatform("qoder");
check(
  "再删一次仍报没有这个平台（PLATFORM_NOT_FOUND）",
  qoderAgain.ok === false && qoderAgain.code === "PLATFORM_NOT_FOUND",
  JSON.stringify(qoderAgain),
);
check("墓碑仍在", tombstoneAt("qoder") !== null, String(tombstoneAt("qoder")));

closeStore();
fs.rmSync(TWICE_DIR, { recursive: true, force: true });

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
