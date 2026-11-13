// test/catalog-billing-panel-check.ts — the billing an upstream reports, all the
// way to the panel's ListModels answer.
//
//   node --experimental-strip-types test/catalog-billing-panel-check.ts
//
// Offline: a temporary data directory, no upstream, no request, no tokens.
//
// Read out of an upstream's /models is one thing (test/catalog-billing-check.ts);
// this is the other half: the reading has to survive the trip. Upstream entries are
// parsed once and thrown away, so the billing is kept with the model's traits on the
// platform row — that is also what makes the panel show a price after a restart
// without asking the upstream again. This checks the whole chain:
//
//   upstream entry → parseModelList → platform row → catalogModels → ListModels
//
// What is checked here:
//
//   1. tokenrhythm's prices arrive as per-million numbers with the currency the
//      platform stated (8 / 28 / 2, CNY) and land in the row, so they are still
//      there for a process that did not fetch the catalogue
//   2. sensenova's all-"0" reply arrives as unknown, with no price field at all —
//      not as a free model
//   3. a platform the table knows nothing about has no billing field: the panel
//      shows nothing for it, and nothing throws

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-billing-panel-"));
// The data directory has to be set before the store is imported: the store opens
// the file the first time it is asked for it.
process.env.BUDDY_DATA_DIR = tmp;

const { closeStore } = await import("../lib/store.ts");
const { createOpenPlatform, openPlatformOf, syncPlatformModels } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { parseModelList } = await import("../lib/open-platform-catalog.ts");
const { create, toJson } = await import("@bufbuild/protobuf");
const { ListModelsRequestSchema, CatalogModelSchema } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");
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
  console.log(`── ${name}`);
}

// The upstream entries: the shapes the platforms really answer with, cut down to
// the fields the reader touches (same fixtures as test/catalog-billing-check.ts).
const tokenrhythmEntry = {
  id: "glm-5.1",
  object: "model",
  currency: "CNY",
  pricing: { currency: "CNY", unit: "per_1m_tokens", prompt: "8.00000000", completion: "28.00000000", cache_read: "2.00000000" },
};

const sensenovaEntry = {
  id: "deepseek-v4-flash",
  context_length: 1048576,
  max_output_length: 65536,
  pricing: { prompt: "0", completion: "0", image: "0", request: "0", input_cache_read: "0" },
};

/**
 * A platform row as the panel would have it, with one model whose catalogue came
 * from the upstream.
 *
 * The traits go through the same door the refresh uses (`parseModelList` then
 * `syncPlatformModels`): writing the traits by hand would test a shape the reader
 * never produces.
 */
function platformWithUpstreamCatalog(
  id: string,
  kind: string,
  entries: object[],
): { ok: boolean; message: string } {
  const created = createOpenPlatform({ id, label: id, baseUrl: `https://${id}.test/v1`, kind });
  if (!created.ok) return created;
  const parsed = parseModelList({ object: "list", data: entries }, { id, kind });
  if (!parsed) return { ok: false, message: "upstream list not parsed" };
  const traits: Record<string, unknown> = {};
  for (const model of parsed) traits[model.id] = model.traits;
  syncPlatformModels(id, parsed.map((model) => model.id), traits as never);
  const added = addAccount({ platform: id });
  if (!added.ok) return added;
  return { ok: true, message: "" };
}

/** The panel's answer for one platform, model by model. */
async function listModels(upstreamId: string): Promise<any[]> {
  const res = await adminService.listModels!(create(ListModelsRequestSchema, { upstreamId }), {} as never);
  return [...res.models];
}

const modelOf = (models: any[], id: string) => models.find((model) => model.id === id);

/* ------------------------------------------------------------------ *
 * 1. tokenrhythm: prices, in the currency the platform stated
 * ------------------------------------------------------------------ */

section("tokenrhythm：上游报的价，原样到面板");

// 一家原来的中转站平台，迁移之后就是这个形状：id 还是原来那个，kind 已经是
// openai、地址在行上（lib/store.ts 的 migrateLegacyVendorKinds）。这里直接从
// 这个形状开始建。
const tokenrhythm = platformWithUpstreamCatalog("tokenrhythm", "openai", [tokenrhythmEntry]);
check("建起一个 tokenrhythm 平台（目录来自上游那一份）", tokenrhythm.ok, tokenrhythm.message);

const trModels = await listModels("tokenrhythm");
const priced = modelOf(trModels, tokenrhythmEntry.id);
check("模型在答复里", Boolean(priced), JSON.stringify(trModels));
check("计费这一格在", Boolean(priced?.billing), JSON.stringify(priced));
check("模式是 token", priced?.billing?.mode === "token", String(priced?.billing?.mode));
check("币种是平台说的 CNY", priced?.billing?.currency === "CNY", String(priced?.billing?.currency));
check("输入价 8（每百万）", priced?.billing?.inputPerMillion === 8, String(priced?.billing?.inputPerMillion));
check("输出价 28（每百万）", priced?.billing?.outputPerMillion === 28, String(priced?.billing?.outputPerMillion));
check(
  "缓存读价 2（每百万）",
  priced?.billing?.cacheReadPerMillion === 2,
  String(priced?.billing?.cacheReadPerMillion),
);
check("不是 unknown", priced?.billing?.unknown === false, String(priced?.billing?.unknown));
check("没有倍率（这是按 token 算的那一种）", !("credits" in (priced?.billing ?? {})), JSON.stringify(priced?.billing));

// Wire shape: the same numbers, with the optional fields present only where there
// is something to say.
const wire = toJson(CatalogModelSchema, priced);
check(
  "线上也是 mode/currency/8/28/2",
  wire.billing?.mode === "token" &&
    wire.billing?.currency === "CNY" &&
    wire.billing?.inputPerMillion === 8 &&
    wire.billing?.outputPerMillion === 28 &&
    wire.billing?.cacheReadPerMillion === 2,
  JSON.stringify(wire),
);

// Kept with the row: a process that never fetched the catalogue (the panel after a
// restart) still shows the price.
const rowBilling = openPlatformOf("tokenrhythm")?.models.traits[tokenrhythmEntry.id]?.billing;
check(
  "计费落在平台行里（重启后不必再问上游）",
  rowBilling?.mode === "token" && rowBilling?.inputPerMillion === 8,
  JSON.stringify(openPlatformOf("tokenrhythm")?.models.traits),
);

/* ------------------------------------------------------------------ *
 * 2. sensenova: every role is "0", so there is no price to show
 * ------------------------------------------------------------------ */

section("sensenova：全 0 又没有币种与单位 → unknown");

const sensenova = platformWithUpstreamCatalog("sensenova", "openai", [sensenovaEntry]);
check("建起一个 sensenova 平台", sensenova.ok, sensenova.message);

const snPriced = modelOf(await listModels("sensenova"), sensenovaEntry.id);
check("模型在答复里", Boolean(snPriced), JSON.stringify(await listModels("sensenova")));
check("计费这一格在（报了东西，只是不是价格）", Boolean(snPriced?.billing), JSON.stringify(snPriced));
check("是 unknown", snPriced?.billing?.unknown === true, String(snPriced?.billing?.unknown));
check(
  "三个价格字段一个都不在",
  snPriced?.billing?.inputPerMillion === undefined &&
    snPriced?.billing?.outputPerMillion === undefined &&
    snPriced?.billing?.cacheReadPerMillion === undefined,
  JSON.stringify(snPriced?.billing),
);
check("币种不编", !snPriced?.billing?.currency, String(snPriced?.billing?.currency));

const snWire = toJson(CatalogModelSchema, snPriced);
check(
  "线上没有价格字段（不是 0）",
  snWire.billing?.unknown === true &&
    snWire.billing?.inputPerMillion === undefined &&
    snWire.billing?.outputPerMillion === undefined &&
    snWire.billing?.cacheReadPerMillion === undefined,
  JSON.stringify(snWire),
);

/* ------------------------------------------------------------------ *
 * 3. a platform nobody modelled: nothing to say, and nothing thrown
 * ------------------------------------------------------------------ */

section("表里没有的平台：没有这一格");

const madeUp = platformWithUpstreamCatalog("my-relay", "openai", [tokenrhythmEntry]);
check("建起一个自建的开放平台", madeUp.ok, madeUp.message);

const barePrice = modelOf(await listModels("my-relay"), tokenrhythmEntry.id);
check("模型在答复里", Boolean(barePrice), JSON.stringify(barePrice));
check("没有计费这一格", barePrice !== undefined && barePrice.billing === undefined, JSON.stringify(barePrice));
check("线上也没有这一格", !("billing" in toJson(CatalogModelSchema, barePrice)), JSON.stringify(toJson(CatalogModelSchema, barePrice)));

closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
