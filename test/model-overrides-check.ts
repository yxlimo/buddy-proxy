// test/model-overrides-check.ts — the model metadata a person writes.
//
//   node --experimental-strip-types test/model-overrides-check.ts
//
// Offline: a temporary data directory, no upstream, no request, no tokens.
//
// What is checked here:
//
//   1. an override on a model the catalogue already has replaces the fields it
//      states and keeps the rest (the multiplier comes from the code table)
//   2. an override naming a model nobody has adds it, at the end, with the
//      minimal shape for everything it does not state
//   3. an override that states nothing but the id changes nothing at all
//   4. no override: every platform's catalogue is what it was, field by field —
//      workbuddy-cn, an open platform, qoder, minimax, zcode
//   5. cn publishes the code table, not the upstream's list: a model only the
//      upstream named is not published (the fetched list still holds it)
//   6. a hand-written override adds it back
//   7. SetModelOverrides replaces: what is not sent is gone, an empty list clears
//   8. a repeated id and an unknown platform are refused, and the database is
//      left as it was
//   9. the other region is untouched: global publishes what its upstream named
//  10. the multiplier is optional: no quote is a missing field, a quote of 0 is 0
//  11. the override carries no "default effort" field
//  12. `effortOptions` has presence: no field = not written, an empty list = "no
//      level at all" — and the answer says which of the two it is
//  13. rendering a catalogue does not query the table every time: one read covers
//      every platform, and the writer clears it
//  14. two silent distortions: a blank display name is not stored, and a row with
//      broken JSON is skipped instead of becoming a model that is nothing but an id

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectError } from "@connectrpc/connect";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-overrides-"));
// The data directory has to be set before the store is imported: the store opens
// the file the first time it is asked for it.
process.env.BUDDY_DATA_DIR = tmp;

const { closeStore, store } = await import("../lib/store.ts");
const { listModelOverrides, upsertModelOverrides, deleteModelOverride, mergeModelOverrides } = await import(
  "../lib/model-overrides.ts"
);
type ModelOverrideRow = import("../lib/model-overrides.ts").ModelOverrideRow;
const { kindOf } = await import("../lib/provider-kinds.ts");
const { addAccount } = await import("../lib/providers.ts");
const { createOpenPlatform, updateOpenPlatform } = await import("../lib/open-platforms.ts");
const {
  workbuddyModel,
  workbuddyModelList,
  setWorkbuddyModelList,
  workBuddyFallbackModels,
  parseRemoteCatalog,
  curateCatalog,
} = await import("../lib/workbuddy/models.ts");
const { create, toJson } = await import("@bufbuild/protobuf");
const {
  ModelOverrideSchema,
  SetModelOverridesRequestSchema,
  DeleteModelOverrideRequestSchema,
  ListModelOverridesRequestSchema,
  ListModelsRequestSchema,
  CatalogModelSchema,
} = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");
const { adminService } = await import("../lib/admin/service.ts");

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
  console.log("");
  console.log(name);
}

/** 一个账号行：这几家的 models() 只看平台、kind 与区域。 */
function bareRow(platform: string, kind: string, region = "") {
  return {
    id: "0",
    platform,
    kind,
    region,
    alias: "",
    enabled: true,
    weight: 100,
    policy: "single" as const,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 一个平台的发布目录。走的就是面板与路由读的那条路（kind.models()）。 */
function published(platform: string, kind: string, region = "") {
  const kindEntry = kindOf(kind);
  if (!kindEntry) throw new Error(`没有这一类：${kind}`);
  return kindEntry.models(bareRow(platform, kind, region));
}
const wbModels = () => published("workbuddy-cn", "workbuddy", "cn");
const entry = (models: any[], id: string) => models.find((m) => m.id === id);
const ids = (models: any[]) => models.map((m) => m.id);

/**
 * 把某个平台的人工条目换成这一份：先显式删干净，再写这几条。
 *
 * 写入口本身是按 id 覆盖、不会替人删；这一份是合并那几段要的「干净起点」——
 * 它们查的是「基础目录 + 人工条目怎么合成」，不是写入口的语义（那在后面的
 * SetModelOverrides 那一段）。
 */
const writeOverrides = (platformId: string, rows: ModelOverrideRow[]) => {
  for (const row of listModelOverrides(platformId)) deleteModelOverride(platformId, row.id);
  return upsertModelOverrides(platformId, rows);
};

/* ------------------------------------------------------------------ *
 * 4. 没有人工条目：逐字段与改动前一样
 * ------------------------------------------------------------------ */

section("没有人工条目时，每个平台的目录与改动前逐字段相同");

// 先造一个开放平台：它走的是「表里那一行说了算」那条路。
const OPEN = "over-probe";
createOpenPlatform({ id: OPEN, label: "Probe", baseUrl: "https://probe.example" });
updateOpenPlatform(OPEN, { models: ["probe-one", "probe-two"], source: "manual" });

const BASELINE = new Map<string, string>();
const capture = (key: string, platform: string, kind: string, region = ""): void => {
  BASELINE.set(key, JSON.stringify(published(platform, kind, region)));
};
capture("workbuddy-cn", "workbuddy-cn", "workbuddy", "cn");
capture("open", OPEN, "openai");
capture("qoder", "qoder", "qoder", "cn");
capture("minimax", "minimax", "minimax", "cn");
capture("zcode", "zcode", "zcode", "cn");

for (const [key, value] of BASELINE) {
  const models = JSON.parse(value);
  check(`${key}：目录不是空的（比得了）`, models.length > 0, String(models.length));
}

// 逐字段、逐顺序与各家自己的输出一致 —— 注册表包了那一层，但对空的人工条目它
// 必须什么都不做。三家自己拼目录的（qoder / minimax / zcode）各查一次。
const { qoderCatalogModels, minimaxCatalogModels, zcodeCatalogModels, workbuddyCatalogModels, catalogModelsFromRow } =
  await import("../lib/catalog-models.ts");
const { qoderModelsForRegion } = await import("../lib/qoder/models.ts");
const { regionOf: qoderRegionOf } = await import("../lib/qoder/auth.ts");
const { MINIMAX_MODELS } = await import("../lib/minimax/models.ts");
const { zcodeModelsInUse } = await import("../lib/zcode/models.ts");
const { workbuddyPublishList } = await import("../lib/workbuddy/models.ts");

const identity: [string, string, string][] = [
  ["qoder", JSON.stringify(published("qoder", "qoder", "cn")), JSON.stringify(qoderCatalogModels(qoderModelsForRegion(qoderRegionOf("qoder"))))],
  ["minimax", JSON.stringify(published("minimax", "minimax", "cn")), JSON.stringify(minimaxCatalogModels(MINIMAX_MODELS))],
  ["zcode", JSON.stringify(published("zcode", "zcode", "cn")), JSON.stringify(zcodeCatalogModels(zcodeModelsInUse()))],
  [
    "workbuddy-cn",
    JSON.stringify(published("workbuddy-cn", "workbuddy", "cn")),
    JSON.stringify(workbuddyCatalogModels(workbuddyPublishList("cn"))),
  ],
  [
    "open",
    JSON.stringify(published(OPEN, "openai")),
    JSON.stringify(catalogModelsFromRow({ platform: OPEN }, () => [])),
  ],
];
for (const [key, fromRegistry, fromSource] of identity) {
  check(`${key}：没有人工条目时与自家输出逐字段逐顺序相同`, fromRegistry === fromSource, `${fromRegistry.slice(0, 160)} / ${fromSource.slice(0, 160)}`);
}

/* ------------------------------------------------------------------ *
 * 1. 改现有模型：写了的字段覆盖，没写的沿用
 * ------------------------------------------------------------------ */

section("改一个已有的模型");

const flashBefore = entry(wbModels(), "deepseek-v4-flash");
const flashCode = workbuddyModel("deepseek-v4-flash");
const wrote = writeOverrides("workbuddy-cn", [
  { id: "deepseek-v4-flash", contextWindow: 4096, effortOptions: ["low", "medium"] },
]);
check("写进去了", wrote.ok, wrote.message);
check("读得回来", JSON.stringify(listModelOverrides("workbuddy-cn")) === JSON.stringify([{ id: "deepseek-v4-flash", contextWindow: 4096, effortOptions: ["low", "medium"] }]), JSON.stringify(listModelOverrides("workbuddy-cn")));

const flashAfter = entry(wbModels(), "deepseek-v4-flash");
check("问的上下文长度按人工那一条", flashAfter?.contextWindow === 4096, String(flashAfter?.contextWindow));
check("档位按人工那一条", JSON.stringify(flashAfter?.effortOptions) === '["low","medium"]', JSON.stringify(flashAfter?.effortOptions));
check(
  "没写的倍率仍是代码表的值",
  flashAfter?.credits === flashCode?.credits && flashAfter?.credits === 0.17,
  `${flashAfter?.credits} / ${flashCode?.credits}`,
);
check(
  "没写的输出上限仍是原来的",
  flashAfter?.maxOutputTokens === flashBefore?.maxOutputTokens,
  `${flashAfter?.maxOutputTokens} / ${flashBefore?.maxOutputTokens}`,
);
check(
  "同一个模型在目录里只有一条",
  ids(wbModels()).filter((id: string) => id === "deepseek-v4-flash").length === 1,
  ids(wbModels()).join(","),
);
check("别的模型没跟着变", JSON.stringify(entry(wbModels(), "glm-5.2")) === JSON.stringify(entry(JSON.parse(BASELINE.get("workbuddy-cn")!), "glm-5.2")));

/* ------------------------------------------------------------------ *
 * 2. 加一个没有的模型
 * ------------------------------------------------------------------ */

section("人工加一个目录里没有的模型");

writeOverrides("workbuddy-cn", [
  { id: "deepseek-v4-flash", contextWindow: 4096 },
  { id: "brand-new-model", contextWindow: 123456, reasoning: true },
]);
const wbWithNew = wbModels();
const invented = entry(wbWithNew, "brand-new-model");
check("它出现在目录里", Boolean(invented), ids(wbWithNew).join(","));
check("在末尾", wbWithNew[wbWithNew.length - 1]?.id === "brand-new-model", ids(wbWithNew).slice(-3).join(","));
check(
  "只写了的那几个字段 + 最小形状",
  JSON.stringify(invented) === JSON.stringify({ id: "brand-new-model", displayName: "brand-new-model", contextWindow: 123456, reasoning: true }),
  JSON.stringify(invented),
);
check("条目数多了一个", wbWithNew.length === JSON.parse(BASELINE.get("workbuddy-cn")!).length + 1, String(wbWithNew.length));

/* ------------------------------------------------------------------ *
 * 3. 只写 id：等于没写
 * ------------------------------------------------------------------ */

section("只写 id 等于没写");

writeOverrides("workbuddy-cn", [{ id: "deepseek-v4-flash" }]);
check(
  "代码表里那一条逐字段一样",
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")) === JSON.stringify(entry(JSON.parse(BASELINE.get("workbuddy-cn")!), "deepseek-v4-flash")),
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")),
);
writeOverrides("workbuddy-cn", [{ id: "deepseek-v4-flash" }]);
check(
  "整份目录逐字段、逐顺序一样",
  JSON.stringify(wbModels()) === BASELINE.get("workbuddy-cn"),
  `${ids(wbModels()).slice(0, 3).join(",")} / ${ids(JSON.parse(BASELINE.get("workbuddy-cn")!)).slice(0, 3).join(",")}`,
);
writeOverrides("workbuddy-cn", []);

section("清空之后回到改动前：每个平台逐字段相同");
for (const [key, platform, kind, region] of [
  ["workbuddy-cn", "workbuddy-cn", "workbuddy", "cn"],
  ["open", OPEN, "openai", ""],
  ["qoder", "qoder", "qoder", "cn"],
  ["minimax", "minimax", "minimax", "cn"],
  ["zcode", "zcode", "zcode", "cn"],
] as [string, string, string, string][]) {
  check(`${key}：逐字段与改动前相同`, JSON.stringify(published(platform, kind, region)) === BASELINE.get(key), JSON.stringify(published(platform, kind, region)).slice(0, 200));
}

// 有人工条目的平台，别的平台也不受影响。
writeOverrides("workbuddy-cn", [{ id: "brand-new-model" }]);
check("qoder 的目录不受 workbuddy 的人工条目影响", JSON.stringify(published("qoder", "qoder", "cn")) === BASELINE.get("qoder"));
writeOverrides("workbuddy-cn", []);

/* ------------------------------------------------------------------ *
 * 5. cn 发布的是代码表，不是上游那一份
 * ------------------------------------------------------------------ */

section("cn：库里的目录是上游说的，公布的是代码表");

// 上游抓回来的那一份（录下来的 /v3/config），就是库里那一行的样子。
const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/get-workbuddy-v3-config.json"), "utf8"));
const fetched = curateCatalog(parseRemoteCatalog(JSON.parse(recorded.body))!, workBuddyFallbackModels().map((m) => m.id));
setWorkbuddyModelList(fetched, "cn");
const table = workBuddyFallbackModels();
const publishedCn = wbModels();
check("库里那份是上游那一份（比代码表宽）", workbuddyModelList("cn").length === fetched.length && fetched.length > table.length, `${workbuddyModelList("cn").length} / ${table.length}`);
check("库里那份确实带着上游独有的模型", fetched.some((m) => m.id === "glm-5v-turbo") && fetched.some((m) => m.id === "kimi-k2.6"), ids(fetched).join(","));
check("公布的正好是代码表那几条", ids(publishedCn).join(",") === table.map((m) => m.id).join(","), `${publishedCn.length} 条`);
check("公布的条数是代码表那几条", publishedCn.length === table.length, `${publishedCn.length} / ${table.length}`);
check("glm-5v-turbo 不在目录里", !ids(publishedCn).includes("glm-5v-turbo"), ids(publishedCn).join(","));
check("kimi-k2.6 不在目录里", !ids(publishedCn).includes("kimi-k2.6"), ids(publishedCn).join(","));
check("库里还留着它们（那是上游说的话）", ids(workbuddyModelList("cn")).includes("glm-5v-turbo"), String(workbuddyModelList("cn").length));
check(
  "代码表里那一条的元数据仍是上游补过的那份",
  entry(publishedCn, "deepseek-v4-flash")?.credits === 0.17,
  JSON.stringify(entry(publishedCn, "deepseek-v4-flash")),
);

/* ------------------------------------------------------------------ *
 * 6. 人工把上游独有的模型加回来
 * ------------------------------------------------------------------ */

section("人工把上游独有的模型加回来");

writeOverrides("workbuddy-cn", [{ id: "glm-5v-turbo", displayName: "GLM-5v-Turbo", credits: 0.71 }]);
const addedBack = entry(wbModels(), "glm-5v-turbo");
check("它回到目录里了", Boolean(addedBack), ids(wbModels()).slice(-2).join(","));
check("写了的字段按人工那一条", addedBack?.displayName === "GLM-5v-Turbo" && addedBack?.credits === 0.71, JSON.stringify(addedBack));
check("在末尾（代码表那几条之后）", wbModels()[wbModels().length - 1]?.id === "glm-5v-turbo", ids(wbModels()).slice(-2).join(","));
check("kimi-k2.6 仍然不在（没人加它）", !ids(wbModels()).includes("kimi-k2.6"));
writeOverrides("workbuddy-cn", []);

/* ------------------------------------------------------------------ *
 * 9. global 不受影响
 * ------------------------------------------------------------------ */

section("global：上游给全了就以上游为准");

const globalRemote = parseRemoteCatalog({
  data: {
    agents: [{ models: ["glm-5v-turbo", "kimi-k2.6"] }],
    models: [
      { id: "glm-5v-turbo", credits: "x0.71 credits", maxInputTokens: 200000, maxOutputTokens: 64000 },
      { id: "kimi-k2.6", credits: "x0.52 credits", maxInputTokens: 256000, maxOutputTokens: 32000 },
    ],
  },
})!;
setWorkbuddyModelList(curateCatalog(globalRemote, []), "global");
const globalIds = ids(published("workbuddy-global", "workbuddy", "global"));
check("上游有、代码表没有的两个 id 都在", globalIds.includes("glm-5v-turbo") && globalIds.includes("kimi-k2.6"), globalIds.join(","));
check("上游的倍率就是公布的倍率", entry(published("workbuddy-global", "workbuddy", "global"), "glm-5v-turbo")?.credits === 0.71, JSON.stringify(entry(published("workbuddy-global", "workbuddy", "global"), "glm-5v-turbo")));

/* ------------------------------------------------------------------ *
 * 7. 覆盖语义（走面板那条路）：发来的按 id 覆盖，没发来的原封不动
 * ------------------------------------------------------------------ */

section("SetModelOverrides 按 id 覆盖");

const impl = adminService as any;

/* ------------------------------------------------------------------ *
 * 面板那条路上的失败
 *
 * 失败是一次 Connect 错误：状态码按语义，机器码在响应头 buddy-error 上。断言
 * 机器码常量，不看错误消息里的中文 —— 文案在面板那一侧。
 * ------------------------------------------------------------------ */

const adminErrors = await import("../lib/admin/error-codes.ts");
const ADMIN_ERROR_HEADER = adminErrors.ADMIN_ERROR_HEADER;

/** 上一条错误。guard 每次开头清掉。 */
let lastError: any = null;

/** 打一次：成功就答复复，失败就给 null（错误留给下面两个读数）。 */
async function guard<T>(run: () => Promise<T>): Promise<T | null> {
  lastError = null;
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ConnectError)) throw e;
    lastError = e;
    return null;
  }
}

/** 上一次失败的机器码。没有失败就是空串。 */
function errCode(): string {
  return String(lastError?.metadata?.get(ADMIN_ERROR_HEADER) ?? "");
}

/** 上一次失败的状态码。没有失败就是 -1。 */
function errStatus(): number {
  return lastError?.code ?? -1;
}

/** 上一次失败的细节（排查用的事实，不是给用户的文案）。 */
function errDetail(): string {
  return String(lastError?.rawMessage ?? "");
}

const setOverrides = async (platformId: string, overrides: unknown[]): Promise<any> =>
  impl.setModelOverrides(
    create(SetModelOverridesRequestSchema, {
      platformId,
      overrides: (overrides as any[]).map((one) => create(ModelOverrideSchema, one)),
    }),
    {},
  );
const listOverrides = async (platformId: string): Promise<any> =>
  impl.listModelOverrides(create(ListModelOverridesRequestSchema, { platformId }), {});

/** 删一条（走面板那条路）。 */
const deleteOverride = async (platformId: string, modelId: string): Promise<any> =>
  impl.deleteModelOverride(create(DeleteModelOverrideRequestSchema, { platformId, modelId }), {});

// 从一条不剩开始：后面每一条都断言「谁在、谁不在」，不能靠上一段留下的行。
for (const row of listModelOverrides("workbuddy-cn")) deleteModelOverride("workbuddy-cn", row.id);

// —— 1. 先建两条，然后只发 A 的新值：A 变了，B 还在（不是整体替换）
const firstSet = await guard(() => setOverrides("workbuddy-cn", [
  { id: "deepseek-v4-flash", contextWindow: 2048 },
  { id: "glm-5.2", credits: 0 },
]));
check("第一次发了两条", firstSet !== null && (await listOverrides("workbuddy-cn")).overrides.length === 2, JSON.stringify(firstSet));
check("发 0 就是免费（不是不知道）", entry(wbModels(), "glm-5.2")?.credits === 0, JSON.stringify(entry(wbModels(), "glm-5.2")));

const secondSet = await guard(() => setOverrides("workbuddy-cn", [{ id: "deepseek-v4-flash", contextWindow: 4096 }]));
const afterSecond = (await listOverrides("workbuddy-cn")).overrides;
check(
  "只发 A：A 那一条按发来的换了",
  secondSet !== null && afterSecond.find((row: any) => row.id === "deepseek-v4-flash")?.contextWindow === 4096,
  JSON.stringify(afterSecond),
);
check(
  "没发来的 B 还在（这就是按 id 覆盖，不是整体替换）",
  afterSecond.length === 2 && afterSecond.some((row: any) => row.id === "glm-5.2"),
  JSON.stringify(afterSecond),
);
check(
  "B 的字段一个字没动",
  afterSecond.find((row: any) => row.id === "glm-5.2")?.credits === 0,
  JSON.stringify(afterSecond.find((row: any) => row.id === "glm-5.2")),
);
check(
  "目录里 B 还是免费",
  entry(wbModels(), "glm-5.2")?.credits === 0,
  JSON.stringify(entry(wbModels(), "glm-5.2")),
);

// —— 2. 新增：只发一个目录里没有的 id，前两条不动
const thirdSet = await guard(() => setOverrides("workbuddy-cn", [{ id: "brand-new-model", displayName: "New One" }]));
const afterThird = (await listOverrides("workbuddy-cn")).overrides;
check(
  "只发 C：A、B、C 都在",
  thirdSet !== null &&
    afterThird.length === 3 &&
    ["deepseek-v4-flash", "glm-5.2", "brand-new-model"].every((id) => afterThird.some((row: any) => row.id === id)),
  JSON.stringify(afterThird),
);
check(
  "新加的那条带着发来的字段",
  afterThird.find((row: any) => row.id === "brand-new-model")?.displayName === "New One",
  JSON.stringify(afterThird.find((row: any) => row.id === "brand-new-model")),
);
check("它进了发布目录", ids(wbModels()).includes("brand-new-model"), ids(wbModels()).slice(-3).join(","));

// —— 3. 删除要显式说：删 A，B 与 C 留着
const removedA = await guard(() => deleteOverride("workbuddy-cn", "deepseek-v4-flash"));
const afterRemove = (await listOverrides("workbuddy-cn")).overrides;
check("删 A：没抛错，答复里是空的（没有 ok 与 message）", removedA !== null && !("ok" in removedA) && !("message" in removedA), JSON.stringify(removedA));
check(
  "A 没了、B 与 C 还在",
  afterRemove.length === 2 && afterRemove.every((row: any) => row.id !== "deepseek-v4-flash"),
  JSON.stringify(afterRemove),
);
check(
  "目录里 A 的那一格退回代码表",
  entry(wbModels(), "deepseek-v4-flash")?.contextWindow === flashBefore?.contextWindow,
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")),
);

// —— 4. 删不存在的：ok=false 说清，库里不变
const beforeMissing = JSON.stringify(listModelOverrides("workbuddy-cn"));
const missingDelete = await guard(() => deleteOverride("workbuddy-cn", "no-such-model"));
check("删不存在的条目：抛错，机器码是 MODEL_OVERRIDE_NOT_FOUND", missingDelete === null && errCode() === adminErrors.MODEL_OVERRIDE_NOT_FOUND, `${errCode()} / ${errDetail()}`);
check("状态码是 NotFound", errStatus() === 5, String(errStatus()));
check("细节里带着那个模型 id", errDetail().includes("no-such-model"), errDetail());
check("删不到的时候库里一点没动", JSON.stringify(listModelOverrides("workbuddy-cn")) === beforeMissing, JSON.stringify(listModelOverrides("workbuddy-cn")));
const emptyModelId = await guard(() => deleteOverride("workbuddy-cn", "   "));
check("空 model_id 被拒：MODEL_ID_MISSING", emptyModelId === null && errCode() === adminErrors.MODEL_ID_MISSING, `${errCode()} / ${errDetail()}`);
const unknownPlatformDelete = await guard(() => deleteOverride("no-such-platform", "x"));
check(
  "不存在的平台：删也说没有这个平台（PLATFORM_NOT_FOUND）",
  unknownPlatformDelete === null && errCode() === adminErrors.PLATFORM_NOT_FOUND,
  `${errCode()} / ${errDetail()}`,
);

// 档位那一格有 presence（契约里裹在 EffortList 里）：没给 = 没写，给了空列表 =
// 明确不能选档。两件事读回来、发出去都得能分开。
// 先把平台收回到只有这一条，后面 `[0]` 才是它。
for (const row of listModelOverrides("workbuddy-cn")) deleteModelOverride("workbuddy-cn", row.id);
await guard(() => setOverrides("workbuddy-cn", [{ id: "deepseek-v4-flash" }]));
const roundTripped = listModelOverrides("workbuddy-cn")[0];
check("只带 id 的条目读回来没有档位这一格", !("effortOptions" in roundTripped), JSON.stringify(roundTripped));
check(
  "读回来再存一遍不抹掉代码表里的档位",
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")?.effortOptions) === '["high","xhigh"]',
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")),
);

// 写一个空列表：这一格在，列表是空的；目录里那个模型就是不能选档。
await guard(() => setOverrides("workbuddy-cn", [{ id: "deepseek-v4-flash", effortOptions: { levels: [] } }]));
const writtenEmpty = (await listOverrides("workbuddy-cn")).overrides[0];
check(
  "写了空列表：答复里这一格还在，列表是空的",
  writtenEmpty?.effortOptions !== undefined && writtenEmpty.effortOptions.levels.length === 0,
  JSON.stringify(writtenEmpty),
);
check(
  // proto3 的 JSON 不写空 repeated：这一格在（presence 有了），里面没有档位。
  "线上的答复也是「写了、列表空」",
  "effortOptions" in toJson(ModelOverrideSchema, writtenEmpty) &&
    JSON.stringify(toJson(ModelOverrideSchema, writtenEmpty).effortOptions) === "{}",
  JSON.stringify(toJson(ModelOverrideSchema, writtenEmpty)),
);
check(
  "发布目录里那个模型不能选档",
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")?.effortOptions) === "[]",
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")),
);
// 同一个平台里一条写了空列表、一条没写：两者不能混。
await guard(() => setOverrides("workbuddy-cn", [
  { id: "deepseek-v4-flash", effortOptions: { levels: [] } },
  { id: "glm-5.2" },
]));
const twoRows = (await listOverrides("workbuddy-cn")).overrides;
check(
  "同一份里一条写了空列表、一条没写，读回来仍然分得开",
  twoRows.length === 2 &&
    twoRows.some((row: any) => row.id === "deepseek-v4-flash" && row.effortOptions !== undefined && row.effortOptions.levels.length === 0) &&
    twoRows.some((row: any) => row.id === "glm-5.2" && row.effortOptions === undefined),
  JSON.stringify(twoRows),
);

// 再写回「没写」：档位回到代码表那一份。
await guard(() => setOverrides("workbuddy-cn", [{ id: "deepseek-v4-flash" }]));
check(
  "改回没写之后，档位回到代码表",
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")?.effortOptions) === '["high","xhigh"]',
  JSON.stringify(entry(wbModels(), "deepseek-v4-flash")),
);

// 空列表什么都不改：删要靠 DeleteModelOverride，不能靠「没发来」。
const emptied = await guard(() => setOverrides("workbuddy-cn", []));
check(
  "发空列表：ok，但一条都不删",
  emptied !== null && (await listOverrides("workbuddy-cn")).overrides.length === 2,
  JSON.stringify(emptied),
);
for (const row of listModelOverrides("workbuddy-cn")) deleteModelOverride("workbuddy-cn", row.id);
check("一条条删干净之后一条不剩", (await listOverrides("workbuddy-cn")).overrides.length === 0, JSON.stringify((await listOverrides("workbuddy-cn")).overrides));

/* ------------------------------------------------------------------ *
 * 8. 校验
 * ------------------------------------------------------------------ */

section("校验：重复的 id 与不存在的平台");

// 先放两条现成的：一次被拒的请求不能把已经在库里的东西写坏，也不能写进去一半。
await guard(() => setOverrides("workbuddy-cn", [
  { id: "keep-a", contextWindow: 111 },
  { id: "keep-b", contextWindow: 222 },
]));
const beforeDuplicate = JSON.stringify(listModelOverrides("workbuddy-cn"));
const duplicate = await guard(() => setOverrides("workbuddy-cn", [
  { id: "same-one", contextWindow: 1 },
  { id: "same-one", contextWindow: 2 },
]));
check("重复的 id 被拒：MODEL_ID_DUPLICATE", duplicate === null && errCode() === adminErrors.MODEL_ID_DUPLICATE, `${errCode()} / ${errDetail()}`);
check("拒的时候库里一点没动", JSON.stringify(listModelOverrides("workbuddy-cn")) === beforeDuplicate, JSON.stringify(listModelOverrides("workbuddy-cn")));
check(
  // 整份不写：同一批里前面那条合法（first-new）也不能落库。
  "一批里混了重复 id：连同那一批里合法的条目也一条没写",
  !ids(listModelOverrides("workbuddy-cn")).includes("same-one") &&
    JSON.stringify(listModelOverrides("workbuddy-cn")) === beforeDuplicate,
  JSON.stringify(listModelOverrides("workbuddy-cn")),
);

const noId = await guard(() => setOverrides("workbuddy-cn", [{ id: "   ", contextWindow: 1 }]));
check("空白 id 被拒：MODEL_ID_MISSING", noId === null && errCode() === adminErrors.MODEL_ID_MISSING, `${errCode()} / ${errDetail()}`);

// 空 id 与纯空白 id 是两句话，都带序号（面板一次发一整份，得找得到是哪一条）。
const emptyId = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one" }, { id: "" }]));
check(
  "空 id 被拒：MODEL_ID_MISSING，细节带序号（第 2 条）",
  emptyId === null && errCode() === adminErrors.MODEL_ID_MISSING && errDetail().includes("entry 2"),
  `${errCode()} / ${errDetail()}`,
);
const blankId = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one" }, { id: "  " }]));
check(
  "纯空白 id 也是 MODEL_ID_MISSING，细节说它是空白那一种",
  blankId === null && errCode() === adminErrors.MODEL_ID_MISSING && errDetail().includes("blank"),
  `${errCode()} / ${errDetail()}`,
);

// 路由匹配模型 id 不分大小写（lib/router/catalog.ts），只差大小写的两条是同一个。
const caseDuplicate = await guard(() => setOverrides("workbuddy-cn", [{ id: "Glm-5.2" }, { id: "glm-5.2" }]));
check(
  "只差大小写的两条被拒：MODEL_ID_DUPLICATE，细节说出是哪两条",
  caseDuplicate === null &&
    errCode() === adminErrors.MODEL_ID_DUPLICATE &&
    errDetail().includes("entry 2") &&
    errDetail().includes("entry 1"),
  `${errCode()} / ${errDetail()}`,
);

// 数值字段的范围：负数与超过 int32 的都写不进契约里那一格，写入这边挡掉。
const negativeContext = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one", contextWindow: -1 }]));
check("负的上下文长度被拒：MODEL_NUMBER_OUT_OF_RANGE 且说了是哪一格", negativeContext === null && errCode() === adminErrors.MODEL_NUMBER_OUT_OF_RANGE && errDetail().includes("contextWindow"), `${errCode()} / ${errDetail()}`);
const negativeOutput = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one", maxOutputTokens: -5 }]));
check("负的输出上限被拒：MODEL_NUMBER_OUT_OF_RANGE", negativeOutput === null && errCode() === adminErrors.MODEL_NUMBER_OUT_OF_RANGE && errDetail().includes("maxOutputTokens"), `${errCode()} / ${errDetail()}`);
const bigContext = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one", contextWindow: 2147483648 }]));
check("超过 int32 的上下文长度被拒：MODEL_NUMBER_OUT_OF_RANGE", bigContext === null && errCode() === adminErrors.MODEL_NUMBER_OUT_OF_RANGE, `${errCode()} / ${errDetail()}`);
const bigOutput = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one", maxOutputTokens: 2147483648 }]));
check("超过 int32 的输出上限被拒：MODEL_NUMBER_OUT_OF_RANGE", bigOutput === null && errCode() === adminErrors.MODEL_NUMBER_OUT_OF_RANGE, `${errCode()} / ${errDetail()}`);
const negativeCredits = await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one", credits: -0.5 }]));
check("负的倍率被拒：MODEL_CREDITS_INVALID", negativeCredits === null && errCode() === adminErrors.MODEL_CREDITS_INVALID, `${errCode()} / ${errDetail()}`);
check(
  "上边界本身是能写的（2147483647）",
  (await guard(() => setOverrides("workbuddy-cn", [{ id: "ok-one", contextWindow: 2147483647 }]))) !== null,
  JSON.stringify(listModelOverrides("workbuddy-cn")),
);

// 不是列表的 overrides：说清楚，不是 TypeError 冒成 500。
const notList = await guard(() => impl.setModelOverrides({ platformId: "workbuddy-cn", overrides: "x" } as any, {}));
check(
  "面板这一层：overrides 不是列表时给 MODEL_OVERRIDE_LIST_INVALID",
  notList === null && errCode() === adminErrors.MODEL_OVERRIDE_LIST_INVALID,
  `${errCode()} / ${errDetail()}`,
);
const notListDirect = upsertModelOverrides("workbuddy-cn", { id: "x" } as any);
check(
  "库这一层也挡得住不是列表的输入（同一个码）",
  notListDirect.ok === false && notListDirect.code === adminErrors.MODEL_OVERRIDE_LIST_INVALID,
  JSON.stringify(notListDirect),
);

check(
  "一路拒下来，库里还是那两条加一条上边界的",
  JSON.stringify(listModelOverrides("workbuddy-cn")) !== beforeDuplicate &&
    JSON.stringify(listModelOverrides("workbuddy-cn")) ===
      JSON.stringify([
        { id: "keep-a", contextWindow: 111 },
        { id: "keep-b", contextWindow: 222 },
        { id: "ok-one", contextWindow: 2147483647 },
      ]),
  JSON.stringify(listModelOverrides("workbuddy-cn")),
);
writeOverrides("workbuddy-cn", []);

const unknownPlatform = await guard(() => setOverrides("no-such-platform", [{ id: "x" }]));
check(
  "不存在的平台被拒：PLATFORM_NOT_FOUND",
  unknownPlatform === null && errCode() === adminErrors.PLATFORM_NOT_FOUND,
  `${errCode()} / ${errDetail()}`,
);
check("不存在的平台也写不进去", listModelOverrides("no-such-platform").length === 0, JSON.stringify(listModelOverrides("no-such-platform")));
const unknownList = await listOverrides("no-such-platform");
check("不存在的平台查出来是空列表（不报错）", Array.isArray(unknownList.overrides) && unknownList.overrides.length === 0, JSON.stringify(unknownList));

/* ------------------------------------------------------------------ *
 * 合成是纯函数
 * ------------------------------------------------------------------ */

section("合成是一个纯函数");

const base = [{ id: "m", displayName: "M", contextWindow: 1000, effortOptions: ["high"] }];
check("没有条目时原样交回", JSON.stringify(mergeModelOverrides(base, [])) === JSON.stringify(base));
check("写了空档位就是「不能选档」", JSON.stringify(mergeModelOverrides(base, [{ id: "m", effortOptions: [] }])[0]?.effortOptions) === "[]", JSON.stringify(mergeModelOverrides(base, [{ id: "m", effortOptions: [] }])[0]));
const noPrice = mergeModelOverrides([{ id: "m", displayName: "M" }], [{ id: "m", contextWindow: 5 }])[0];
check("基础没有倍率时，不因为有人工条目就冒出 0", !("credits" in (noPrice as any)), JSON.stringify(noPrice));

/* ------------------------------------------------------------------ *
 * 10. ListModels：倍率是 optional，没报价 = 缺格，报价 0 = 0
 * ------------------------------------------------------------------ */

section("ListModels：倍率没有报价就不写这一格");

// 目录只列启用着的平台，而目录的源头是账号行：按面板的做法加一个账号。
const wbAccount = addAccount({ platform: "workbuddy-cn" });
check("加了一个 workbuddy-cn 账号（目录读得到它的模型）", wbAccount.ok, wbAccount.message);

const listModels = async (upstreamId = ""): Promise<any[]> => {
  const res = await impl.listModels(create(ListModelsRequestSchema, { upstreamId }), {});
  return [...res.models];
};
const modelOf = (models: any[], id: string) => models.find((m) => m.id === id);

// 只写 id 的人工条目：把它加回目录，但没人说它多少倍率。
await guard(() => setOverrides("workbuddy-cn", [{ id: "glm-5v-turbo" }]));
const unpriced = modelOf(await listModels("workbuddy-cn"), "glm-5v-turbo");
check("人工加回的模型出现在答复里", Boolean(unpriced), JSON.stringify(unpriced));
check(
  "没有倍率信息：答复里没有 credits 这一格（不是 0）",
  unpriced !== undefined && !("credits" in unpriced),
  JSON.stringify(unpriced),
);
check(
  "发到线上也没有这一格",
  unpriced !== undefined && !("credits" in toJson(CatalogModelSchema, unpriced)),
  unpriced === undefined ? "缺这一条" : JSON.stringify(toJson(CatalogModelSchema, unpriced)),
);
// 代码表里本来就没人报价的那条，同一条路：
const noPriceInTable = modelOf(await listModels("workbuddy-cn"), "hunyuan-2.0-instruct");
check(
  "代码表里没人报价的模型同样缺这一格",
  noPriceInTable !== undefined && !("credits" in noPriceInTable),
  JSON.stringify(noPriceInTable),
);

await guard(() => setOverrides("workbuddy-cn", []));
const priced = modelOf(await listModels("workbuddy-cn"), "deepseek-v4-flash");
check("有倍率的是 0.17，且这一格在答复里", priced !== undefined && "credits" in priced && priced.credits === 0.17, JSON.stringify(priced));
check("线上是 0.17", priced !== undefined && toJson(CatalogModelSchema, priced).credits === 0.17, priced === undefined ? "缺这一条" : JSON.stringify(toJson(CatalogModelSchema, priced)));

// 人工写 0：那是「免费」，与「不知道」是两件事。
await guard(() => setOverrides("workbuddy-cn", [{ id: "glm-5.2", credits: 0 }]));
const free = modelOf(await listModels("workbuddy-cn"), "glm-5.2");
check("人工写 0 就是 0，不是缺格", free !== undefined && "credits" in free && free.credits === 0, JSON.stringify(free));
check("线上也是 0（0 不会被当成缺值丢掉）", free !== undefined && toJson(CatalogModelSchema, free).credits === 0, free === undefined ? "缺这一条" : JSON.stringify(toJson(CatalogModelSchema, free)));
await guard(() => setOverrides("workbuddy-cn", []));

/* ------------------------------------------------------------------ *
 * 11. 人工条目里没有「默认档」这一格
 * ------------------------------------------------------------------ */

section("人工条目里没有「默认档」这一格");

await guard(() => setOverrides("workbuddy-cn", [{ id: "glm-5.2", credits: 0, effortOptions: { levels: ["low"] } }]));
const storedBack = (await listOverrides("workbuddy-cn")).overrides[0];
check("读回来的条目没有 defaultEffort 这一格", storedBack !== undefined && !("defaultEffort" in storedBack), JSON.stringify(storedBack));
check("发到线上也没有这一格", storedBack !== undefined && !("defaultEffort" in toJson(ModelOverrideSchema, storedBack)), storedBack === undefined ? "缺这一条" : JSON.stringify(toJson(ModelOverrideSchema, storedBack)));

// 库里那一行 JSON：一个只带 id 的条目不该多出任何格。
const rawRow = store()
  .prepare("SELECT data FROM platform_model_override WHERE platform_id = ? AND model_id = ?")
  .get("workbuddy-cn", "glm-5.2") as any;
check(
  "库里那一行只有写了的键",
  JSON.stringify(Object.keys(JSON.parse(String(rawRow?.data ?? "{}"))).sort()) === JSON.stringify(["credits", "effortOptions"]),
  String(rawRow?.data),
);
check("库里那一行没有 defaultEffort", !String(rawRow?.data ?? "").includes("defaultEffort"), String(rawRow?.data));
await guard(() => setOverrides("workbuddy-cn", []));

/* ------------------------------------------------------------------ *
 * 13. 目录渲染不每次都查表
 * ------------------------------------------------------------------ */

section("目录渲染不每次都查表");

// 这一份是「没有人工条目时的 cn 目录」，后面两段都拿它当参照（第 5 段改过
// 库里那份上游目录，所以它已经不是开头那份 BASELINE 了）。
writeOverrides("workbuddy-cn", []);
const wbReference = JSON.stringify(wbModels());

// 数一下「SELECT … FROM platform_model_override」发生了多少次。包住共用的那个
// DatabaseSync 就够：模块每次都现拿 store()。
const db = store();
const realPrepare = db.prepare.bind(db);
let overrideSelects = 0;
(db as any).prepare = (sql: string) => {
  const text = String(sql).trimStart();
  if (text.toUpperCase().startsWith("SELECT") && text.includes("platform_model_override")) overrideSelects++;
  return realPrepare(sql);
};

// 装好计数之后再把缓存清一次：接下来每次目录渲染都得落在「冷启动」那一次读上。
writeOverrides("workbuddy-cn", []);

const twoPlatforms = [published("workbuddy-cn", "workbuddy", "cn"), published("qoder", "qoder", "cn")];
check("两个平台的目录：一共只查了 1 次表", overrideSelects === 1, String(overrideSelects));
const thirdPlatform = published("minimax", "minimax", "cn");
check("再来一个平台：还是那 1 次", overrideSelects === 1, String(overrideSelects));
check(
  "目录本身没弄丢（缓存交出来的东西是完整的）",
  ids(twoPlatforms[1]).length > 0 && ids(thirdPlatform).length > 0,
  `${ids(twoPlatforms[1]).length} / ${ids(thirdPlatform).length}`,
);

// 写一次之后再看：读到的是新值 —— 证明写入口把缓存清了。
writeOverrides("workbuddy-cn", [{ id: "brand-new-model" }]);
check("写完读到的是新值", ids(wbModels()).includes("brand-new-model"), ids(wbModels()).slice(-2).join(","));
check("写完之后重建缓存时又读了一次表", overrideSelects === 2, String(overrideSelects));
wbModels();
check("写完再读同一个平台：不再读表", overrideSelects === 2, String(overrideSelects));

// 后面那一段直接写库（绕过写入口），所以先把测量拆了。
delete (db as any).prepare;
check("拆掉测量之后 prepare 回到原型上那个", typeof (db as any).prepare === "function", typeof (db as any).prepare);
writeOverrides("workbuddy-cn", []);

/* ------------------------------------------------------------------ *
 * 14. 两处静默失真
 * ------------------------------------------------------------------ */

section("两处静默失真：纯空白的名字、写坏的一行");

// 纯空白的名字不落库：落了库读回来也会被当成没写，面板上就是「存了又没了」。
await guard(() => setOverrides("workbuddy-cn", [{ id: "glm-5.2", displayName: "   " }]));
const blankName = (await listOverrides("workbuddy-cn")).overrides[0];
check("纯空白的名字读回来是「没写」", blankName !== undefined && !("displayName" in blankName), JSON.stringify(blankName));
const blankRow = store()
  .prepare("SELECT data FROM platform_model_override WHERE platform_id = ? AND model_id = ?")
  .get("workbuddy-cn", "glm-5.2") as any;
check("库里那一行也没有这一格", blankRow !== undefined && !String(blankRow?.data ?? "").includes("displayName"), String(blankRow?.data));
const glmBaseline = entry(JSON.parse(wbReference), "glm-5.2");
check("目录里的名字还是原来那份", JSON.stringify(entry(wbModels(), "glm-5.2")) === JSON.stringify(glmBaseline), JSON.stringify(entry(wbModels(), "glm-5.2")));

// 写坏的一行：读的时候跳过。不能变成一个「只有 id」的模型（那会多出一条谁都没
// 写过的目录条目），也不能让基础目录里本来有那一条跟着变。
const insertRaw = store().prepare("INSERT OR REPLACE INTO platform_model_override (platform_id, model_id, data) VALUES (?, ?, ?)");
insertRaw.run("workbuddy-cn", "broken-row", "{not json");
insertRaw.run("workbuddy-cn", "glm-5.2", "{not json");
// 直接写库绕过了写入口 —— 缓存得靠下一次写操作清掉（注释里「第二个写者」说的
// 就是这种情况：真接上第二个写者，这里得换成别的机制）。
writeOverrides("qoder", []);
check("坏行没有变成目录里的一条模型", !ids(wbModels()).includes("broken-row"), ids(wbModels()).slice(-3).join(","));
check(
  "基础目录里有的那条，坏行等于没写",
  JSON.stringify(entry(wbModels(), "glm-5.2")) === JSON.stringify(glmBaseline),
  JSON.stringify(entry(wbModels(), "glm-5.2")),
);
check(
  "坏行也查不出来（不是一条只有 id 的条目）",
  listModelOverrides("workbuddy-cn").every((row) => row.id !== "broken-row" && row.id !== "glm-5.2"),
  JSON.stringify(listModelOverrides("workbuddy-cn")),
);
writeOverrides("workbuddy-cn", []);
check("清掉之后目录回到改动前", JSON.stringify(wbModels()) === wbReference, JSON.stringify(wbModels()).slice(0, 200));

/* ------------------------------------------------------------------ */

closeStore();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows 上还占着文件时删不掉，下一次用新目录 */
}

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
