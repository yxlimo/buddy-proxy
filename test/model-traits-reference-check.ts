// test/model-traits-reference-check.ts — 参考值那一层：共性表怎么补、什么时候不许盖。
//
//   mise run test:model-traits:reference
//   node --experimental-strip-types test/model-traits-reference-check.ts
//
// 离线：临时数据目录，一个假的上游目录（用 syncPlatformModels 写进去，与真上游拉
// 回来时走的是同一条路），不发请求、不花额度、不碰真凭据。
//
// 合成目录是四层叠出来的（lib/catalog-models.ts 的顺序）：人工元数据 → 上游报的
// → 代码表 → 共性表 → 最小形状。这一份查的就是最后一层「共性表」真的通电了，并且
// 它只补不盖：
//
//   1. 上游没报的那几格由参考值补上（档位、窗口、输出上限、能不能思考）
//   2. 上游报了的字段上游说了算（哪怕上游报的比参考值少）
//   3. 人工写的元数据盖住参考值
//   4. 反证：上游明确说 `reasoning: false`，参考值说 true —— 结论是 false，近似
//      不许盖明确的结论
//   5. 参考表里没有这个 id：那几格仍然空着（不是 0、不是 false、不是空数组）
//   6. 开关关掉的那一行一点参考值都不吃（同样的 id 开关前后必须不一样）
//   7. 参考表里没有价格：`cost` / `billing` 这类键递归扫一遍，一个都不许有
//
// 最后打印三个 id 的解析结果，当人工验收的证据（参考值补出来的、上游自己报的、
// 两边都没有的）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-traits-reference-"));
// 数据目录要在库被打开之前定下来：库是第一次用的时候才开的。
process.env.BUDDY_DATA_DIR = tmp;

// 引用即登记：kind 登记表在求值期填，不引这一行 kindOf() 全是 null。
await import("../lib/kinds/index.ts");
const { closeStore, migratePlatforms, store } = await import("../lib/store.ts");
const { createOpenPlatform, openPlatformOf, syncPlatformModels, updateOpenPlatform } = await import(
  "../lib/open-platforms.ts"
);
const { kindOf } = await import("../lib/provider-kinds.ts");
const { commonTraitsOf } = await import("../lib/common-model-traits.ts");
const { deleteModelOverride, upsertModelOverrides } = await import("../lib/model-overrides.ts");

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

/** 发布出去的目录：走的是面板与客户端看的那一条路（kind 的 models + 人工元数据）。 */
function published(platform: string) {
  const row = openPlatformOf(platform);
  if (!row) throw new Error(`platform ${platform} is not in the table`);
  const kind = kindOf(row.kind);
  if (!kind) throw new Error(`kind ${row.kind} is not registered`);
  return kind.models({ platform } as Parameters<typeof kind.models>[0]);
}

/** 发布目录里的那一条。 */
function publishedOne(platform: string, id: string) {
  return published(platform).find((model) => model.id === id);
}

/** 上游报了一轮参数：与真拉目录时写回的那一条路一样（syncPlatformModels）。 */
function upstreamReported(platform: string, items: string[], traits: Record<string, unknown> = {}): void {
  syncPlatformModels(platform, items, traits as Parameters<typeof syncPlatformModels>[2]);
}

function platformOk(result: { ok: boolean; message?: string }, what: string): void {
  check(`建平台 ${what}`, result.ok === true, String(result.message));
}

/* ------------------------------------------------------------------ *
 * 参考表本身
 * ------------------------------------------------------------------ */

section("参考表：有粮，且没有价格");

const traitsFile = path.join(ROOT, "lib", "model-traits.json");
const traitsDoc = JSON.parse(fs.readFileSync(traitsFile, "utf8")) as {
  models?: Record<string, Record<string, unknown>>;
};
const traitsCount = Object.keys(traitsDoc.models ?? {}).length;
// 这一层之所以是空的，就是因为它没粮：一条近似都拿不出来。几十条也算「有粮」，
// 但 9 条是手写那一份的数量 —— 那就说明生成没跑。
check("the reference table has entries", traitsCount > 100, String(traitsCount));

/** 递归找一个键：`cost` / `billing` / 任何像价格的字段。 */
function priceKeysIn(value: unknown, at: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => priceKeysIn(item, `${at}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/cost|billing|price|pricing/i.test(key)) found.push(`${at}.${key}`);
    priceKeysIn(inner, `${at}.${key}`, found);
  }
  return found;
}
const priceKeys = priceKeysIn(traitsDoc, "$", []);
check(
  "no price field anywhere in the reference table",
  priceKeys.length === 0,
  priceKeys.slice(0, 5).join(", "),
);

// 人工那一份在生成时盖在最上层：`deepseek-v4.1-flash` 的输出上限人工写的是 384000，
// pi 里对应的那几条是 131072。表里留的必须是人工那个数，而 `providers` 说明 pi 那
// 几份也并进来了 —— 两层都在，人工优先。
const manualWins = traitsDoc.models?.["deepseek-v4-1-flash"];
check(
  "the hand-written output limit beats the one pi reports",
  manualWins?.maxOutputTokens === 384000 && (manualWins?.providers as unknown[] | undefined)?.length,
  JSON.stringify([manualWins?.maxOutputTokens, (manualWins?.providers as unknown[] | undefined)?.length]),
);
check(
  "and the hand-written levels too",
  JSON.stringify(manualWins?.efforts) === JSON.stringify(["low", "high", "max"]),
  JSON.stringify(manualWins?.efforts),
);

/* ------------------------------------------------------------------ *
 * 平台
 * ------------------------------------------------------------------ */

/**
 * 插一行「迁移之后」的形状：kind 是 openai，地址在行上。
 *
 * 厂商那几家已经不能经 AddPlatform 建了（lib/platform-catalog.ts 只剩两种方言），
 * 而这一节要的只是「库里有这么一行」。
 */
function insertMigratedPlatform(id: string, label: string, baseUrl: string): void {
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO platform (id, label, base_url, models, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, '', 'openai', '', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET label = excluded.label, base_url = excluded.base_url, " +
        "kind = excluded.kind, updated_at = excluded.updated_at",
    )
    .run(id, label, baseUrl, JSON.stringify({ items: [], traits: {}, fetchedAt: 0 }), now, now);
}

section("参考值补上游没报的那几格");

// 一家原先是中转站的平台，迁移之后就是这个形状（kind 已是 openai、地址在行上）：
// 这一节测的是参考值那一层，不是建平台，所以直接把行插成迁移后的样子。
insertMigratedPlatform("tokenrhythm", "中转站", "https://relay.test/v1");
check("the migrated platform row exists", openPlatformOf("tokenrhythm") !== null);
// 它的目录只有行里那一份（没有代码表），正是这一层的用武之地
const tokenrhythmKind = openPlatformOf("tokenrhythm");
check("the platform row exists", tokenrhythmKind !== null);
check(
  "a new platform has the reference layer on by default",
  tokenrhythmKind?.traitsFromCommon === true,
  String(tokenrhythmKind?.traitsFromCommon),
);

// 上游只给了 id，一个字参数也没报（星火那种上游就是这样）
upstreamReported("tokenrhythm", ["glm-5.3-flash"]);
const referenceTraits = commonTraitsOf("glm-5.3-flash");
check("the reference table knows glm-5.3-flash", referenceTraits !== null, JSON.stringify(referenceTraits));

const fromReference = publishedOne("tokenrhythm", "glm-5.3-flash");
check(
  "the levels come from the reference table",
  JSON.stringify(fromReference?.effortOptions) === JSON.stringify(referenceTraits?.efforts),
  JSON.stringify([fromReference?.effortOptions, referenceTraits?.efforts]),
);
check(
  "and they are low/high/max",
  JSON.stringify(fromReference?.effortOptions) === JSON.stringify(["low", "high", "max"]),
  JSON.stringify(fromReference?.effortOptions),
);
check(
  "the window comes from the reference table",
  fromReference?.contextWindow === referenceTraits?.contextWindow,
  JSON.stringify([fromReference?.contextWindow, referenceTraits?.contextWindow]),
);
check(
  "the output limit comes from the reference table",
  fromReference?.maxOutputTokens === referenceTraits?.maxOutputTokens,
  JSON.stringify([fromReference?.maxOutputTokens, referenceTraits?.maxOutputTokens]),
);
check(
  "and whether it can think",
  fromReference?.reasoning === referenceTraits?.reasoning && fromReference?.reasoning === true,
  JSON.stringify(fromReference?.reasoning),
);

section("上游报了的字段上游说了算");

platformOk(createOpenPlatform({ id: "opencode-go", label: "上游自报", baseUrl: "https://go.test/v1" }), "opencode-go");
// 上游自己报了档位，而且报得比参考值少（少一档 high）：库里那份近似不该把它补齐
upstreamReported("opencode-go", ["deepseek-v4.1-flash"], { "deepseek-v4.1-flash": { efforts: ["low", "max"] } });
const upstreamWins = publishedOne("opencode-go", "deepseek-v4.1-flash");
const referenceDeepseek = commonTraitsOf("deepseek-v4.1-flash");
check(
  "the reference table really has more levels for this id",
  JSON.stringify(referenceDeepseek?.efforts) === JSON.stringify(["low", "high", "max"]),
  JSON.stringify(referenceDeepseek?.efforts),
);
check(
  "the upstream's own list wins, unaugmented",
  JSON.stringify(upstreamWins?.effortOptions) === JSON.stringify(["low", "max"]),
  JSON.stringify(upstreamWins?.effortOptions),
);

section("人工写的元数据盖住参考值");

// 参考值说 glm-5.3-flash 能思考（true），人在面板上写 false：人的结论优先
const override = upsertModelOverrides("tokenrhythm", [{ id: "glm-5.3-flash", reasoning: false }]);
check("the override is stored", override.ok === true, String(override.message));
const afterOverride = publishedOne("tokenrhythm", "glm-5.3-flash");
check(
  "the hand-written false beats the reference's true",
  afterOverride?.reasoning === false,
  JSON.stringify(afterOverride?.reasoning),
);
check(
  "the other fields still come from the reference table",
  JSON.stringify(afterOverride?.effortOptions) === JSON.stringify(["low", "high", "max"]),
  JSON.stringify(afterOverride?.effortOptions),
);
// 收尾：这条人工条目删掉，后面的用例与证据回到参考值那一份。
// （upsert 一个空列表不会删已有条目 —— 那是「没发来就不动」的覆盖语义。）
const removed = deleteModelOverride("tokenrhythm", "glm-5.3-flash");
check("the override is gone again", removed.ok === true, String(removed.message));
check(
  "and the reference values are back",
  publishedOne("tokenrhythm", "glm-5.3-flash")?.reasoning === true,
  JSON.stringify(publishedOne("tokenrhythm", "glm-5.3-flash")?.reasoning),
);

section("反证：近似不许盖明确的结论");

platformOk(createOpenPlatform({ id: "says-no", label: "上游说不能思考", baseUrl: "https://no.test/v1" }), "says-no");
upstreamReported("says-no", ["glm-5.3"], { "glm-5.3": { reasoning: false } });
const upstreamFalse = publishedOne("says-no", "glm-5.3");
check(
  "the reference table says this id can think",
  commonTraitsOf("glm-5.3")?.reasoning === true,
  JSON.stringify(commonTraitsOf("glm-5.3")?.reasoning),
);
check(
  "the upstream's explicit false stays false",
  upstreamFalse?.reasoning === false,
  JSON.stringify(upstreamFalse?.reasoning),
);
check(
  "and the reference still fills the fields nobody stated",
  upstreamFalse?.contextWindow === commonTraitsOf("glm-5.3")?.contextWindow &&
    upstreamFalse?.contextWindow !== undefined,
  JSON.stringify(upstreamFalse?.contextWindow),
);

section("参考表里没有这个 id：那几格仍然是空");

platformOk(createOpenPlatform({ id: "nobody-knows", label: "谁都不知道", baseUrl: "https://none.test/v1" }), "nobody-knows");
const UNKNOWN_ID = "made-up-model-9";
upstreamReported("nobody-knows", [UNKNOWN_ID]);
check("the reference table does not know it", commonTraitsOf(UNKNOWN_ID) === null);
const unknown = publishedOne("nobody-knows", UNKNOWN_ID);
check("the model is still published", unknown !== undefined, JSON.stringify(unknown));
check(
  "nothing is filled in — a missing field is not 0, false or an empty list",
  unknown?.contextWindow === undefined &&
    unknown?.maxOutputTokens === undefined &&
    unknown?.reasoning === undefined &&
    unknown?.toolCall === undefined &&
    unknown?.effortOptions === undefined,
  JSON.stringify(unknown),
);
check(
  "the minimal shape is the id and the name",
  JSON.stringify(unknown) === JSON.stringify({ id: UNKNOWN_ID, displayName: UNKNOWN_ID }),
  JSON.stringify(unknown),
);

section("开关关掉的那一行一点参考值都不吃");

platformOk(createOpenPlatform({ id: "switched-off", label: "关掉共性表", baseUrl: "https://off.test/v1" }), "switched-off");
upstreamReported("switched-off", ["glm-5.3-flash"]);
const offResult = updateOpenPlatform("switched-off", { traitsFromCommon: false });
check("the switch is written", offResult.ok === true, String(offResult.message));
const offModel = publishedOne("switched-off", "glm-5.3-flash");
check(
  "with the switch off the levels stay unknown",
  offModel?.effortOptions === undefined && offModel?.contextWindow === undefined,
  JSON.stringify(offModel),
);
check(
  "the same id is filled in when the switch is on",
  JSON.stringify(publishedOne("tokenrhythm", "glm-5.3-flash")?.effortOptions) ===
    JSON.stringify(["low", "high", "max"]),
  JSON.stringify(publishedOne("tokenrhythm", "glm-5.3-flash")?.effortOptions),
);

section("存量行的一次性回填：只做一次，之后不再动");

// 模拟这一版之前的库：开关列是 0，schema 版本也还是 0
store().exec("UPDATE platform SET traits_from_common = 0");
store().exec("PRAGMA user_version = 0");
migratePlatforms(store());
check(
  "an old database's rows are turned on",
  openPlatformOf("tokenrhythm")?.traitsFromCommon === true && openPlatformOf("switched-off")?.traitsFromCommon === true,
  JSON.stringify([
    openPlatformOf("tokenrhythm")?.traitsFromCommon,
    openPlatformOf("switched-off")?.traitsFromCommon,
  ]),
);
const version = (store().prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version;
check("the schema version is recorded", Number(version) === 1, String(version));

// 回填之后用户关掉一行：再跑一次迁移不许把它打开
store().prepare("UPDATE platform SET traits_from_common = 0 WHERE id = ?").run("switched-off");
migratePlatforms(store());
check(
  "a row turned off after the backfill stays off",
  openPlatformOf("switched-off")?.traitsFromCommon === false,
  String(openPlatformOf("switched-off")?.traitsFromCommon),
);
check(
  "and the rows that were on are still on",
  openPlatformOf("tokenrhythm")?.traitsFromCommon === true,
  String(openPlatformOf("tokenrhythm")?.traitsFromCommon),
);

/* ------------------------------------------------------------------ *
 * 人工验收的证据
 * ------------------------------------------------------------------ */

section("人工验收：三个 id 的解析结果");

const evidence: [string, string][] = [
  ["tokenrhythm", "glm-5.3-flash"],
  ["opencode-go", "deepseek-v4.1-flash"],
  ["nobody-knows", UNKNOWN_ID],
];
for (const [platform, id] of evidence) {
  console.log(`  ${platform} / ${id} → ${JSON.stringify(publishedOne(platform, id))}`);
}

// 上面那一段回填把开关全打开了，收尾时那一行的关要在目录里也看得出来
const finalOff = publishedOne("switched-off", "glm-5.3-flash");
check(
  "the row that stays off publishes no reference values",
  finalOff?.effortOptions === undefined,
  JSON.stringify(finalOff),
);

closeStore();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
