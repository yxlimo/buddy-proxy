// test/workbuddy-catalog-check.ts — the WorkBuddy catalogue that lives in the
// database.
//
//   node --experimental-strip-types test/workbuddy-catalog-check.ts
//
// Offline: a temporary data directory, no upstream, no request, no tokens.
//
// The catalogue is the last one the upstream published, kept in the database
// whatever its age (lib/workbuddy/catalog-store.ts). What is checked here:
//
//   1. a fresh database holds no catalogue, and reading it does not invent one
//   2. what was written comes back
//   3. it survives a restart — another process reads the same directory
//   4. the ttl is 48 minutes, and the environment can pin it
//   5. an old catalogue is still a catalogue: stale means "fetch again", not
//      "nothing to serve"
//   6. an empty list is not a catalogue
//   7. a broken row is not a crash
//   8. the effort levels the upstream declares survive the mapping: a list is
//      the list, a bare `effort` is a fixed level — not a one-item list, and not
//      an empty one that erases the levels the table lists
//   9. the bundled China table carries what the client product config carries
//      (the multiplier and the levels the upstream never sends), and an upstream
//      answer that leaves a field out does not overwrite it

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkBuddyModel } from "../lib/workbuddy/models.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-catalog-"));
// The data directory has to be set before the store is imported: the store
// opens the file the first time it is asked for it.
process.env.BUDDY_DATA_DIR = tmp;

const { catalogId, catalogTtlMs, readStoredCatalog, writeStoredCatalog, initWorkBuddyCatalog } =
  await import("../lib/workbuddy/catalog-store.ts");
const { store, listCached, closeStore } = await import("../lib/store.ts");
const { workbuddyModelList, setWorkbuddyModelList, workbuddyPublishList, parseRemoteCatalog, curateCatalog, workbuddyModel, mergeWorkBuddyCatalog, workBuddyFallbackModels } =
  await import("../lib/workbuddy/models.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const MODELS: WorkBuddyModel[] = [
  {
    id: "wb-alpha",
    display_name: "Alpha",
    credits: 1,
    context: 128000,
    maxOutput: 8192,
    vision: true,
    tools: true,
    reasoning: false,
    onlyReasoning: false,
    efforts: [],
  },
  {
    id: "wb-beta",
    display_name: "Beta",
    credits: 0,
    context: 64000,
    maxOutput: 4096,
    vision: false,
    tools: false,
    reasoning: true,
    onlyReasoning: false,
    efforts: ["low"],
  },
];

const ids = (models: WorkBuddyModel[] | undefined): string[] => (models ?? []).map((m) => m.id);

interface OtherProcess {
  ids: string[] | null;
  at: number;
  ttl: number;
}

/** What another process sees in the same data directory. */
function readInAnotherProcess(env: NodeJS.ProcessEnv = {}): OtherProcess {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lib/workbuddy/catalog-store.ts")).href)});
    const c = m.readStoredCatalog();
    console.log(JSON.stringify({
      ids: c ? c.models.map((x) => x.id) : null,
      at: c ? c.at : 0,
      ttl: m.catalogTtlMs(),
    }));
  `;
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      cwd: ROOT,
      env: { ...process.env, BUDDY_DATA_DIR: tmp, ...env },
      encoding: "utf8",
    },
  );
  if (res.status !== 0) throw new Error(`the other process failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

console.log("");
console.log("a fresh database");

check("no catalogue to read", readStoredCatalog() === null, JSON.stringify(readStoredCatalog()));
check("nothing to load at startup", initWorkBuddyCatalog().size === 0, JSON.stringify([...initWorkBuddyCatalog()]));
check(
  "reading it did not write a row",
  listCached(catalogId()).length === 0,
  JSON.stringify(listCached(catalogId())),
);
// 写死的那张表是中国的：只有 cn 能拿它当引导值。国际区要是也拿到它，就会
// 拿着一批自己上游没有的模型名去点名，上游回 11102。
check("新库里 cn 有引导值", workbuddyModelList("cn").length > 0, String(workbuddyModelList("cn").length));
check("新库里 global 没有引导值", workbuddyModelList("global").length === 0, String(workbuddyModelList("global").length));

console.log("");
console.log("what was written comes back");

writeStoredCatalog(MODELS);
const stored = readStoredCatalog();
check("the catalogue is there", stored !== null);
check(
  "the same models",
  ids(stored?.models).join(",") === "wb-alpha,wb-beta",
  ids(stored?.models).join(","),
);
check(
  "the row is in the database",
  listCached(catalogId()).length === 1,
  JSON.stringify(listCached(catalogId())),
);

// The startup path: the process starts with an empty registry and the
// database is what fills it.
setWorkbuddyModelList([]);
const loaded = initWorkBuddyCatalog();
check(
  "the startup reads it back",
  ids(loaded.get("cn")?.models).join(",") === "wb-alpha,wb-beta",
  ids(loaded.get("cn")?.models).join(","),
);
check(
  "the registry is the stored one",
  ids(workbuddyModelList()).join(",") === "wb-alpha,wb-beta",
  ids(workbuddyModelList()).join(","),
);

console.log("");
console.log("it survives a restart");

const afterRestart = readInAnotherProcess();
check(
  "another process finds it",
  afterRestart.ids?.join(",") === "wb-alpha,wb-beta",
  JSON.stringify(afterRestart),
);
check("and it is not empty there", (afterRestart.ids?.length ?? 0) > 0, JSON.stringify(afterRestart));

console.log("");
console.log("the two regions do not overwrite each other");

// 这是这次修的 bug：目录按区域存，一份不能顶掉另一份。早先只有一行
// (`workbuddy:catalog`)，后抓的那个区把先抓的顶掉，另一个区就被喂了一份自己
// 上游没有的模型名 —— 上游回 `11102 model [x] service info not found`。
const GLOBAL_MODELS: WorkBuddyModel[] = [{ ...MODELS[0], id: "wb-global-alpha" }];
writeStoredCatalog(MODELS, "cn");
writeStoredCatalog(GLOBAL_MODELS, "global");
check(
  "cn keeps its own",
  ids(readStoredCatalog("cn")?.models).join(",") === "wb-alpha,wb-beta",
  ids(readStoredCatalog("cn")?.models).join(","),
);
check(
  "global keeps its own",
  ids(readStoredCatalog("global")?.models).join(",") === "wb-global-alpha",
  ids(readStoredCatalog("global")?.models).join(","),
);
check(
  "two rows in the database",
  listCached(catalogId("cn")).length === 1 && listCached(catalogId("global")).length === 1,
  `${listCached(catalogId("cn")).length} / ${listCached(catalogId("global")).length}`,
);
check(
  "the registry holds both",
  ids(workbuddyModelList("cn")).join(",") === "wb-alpha,wb-beta" &&
    ids(workbuddyModelList("global")).join(",") === "wb-global-alpha",
  `${ids(workbuddyModelList("cn"))} / ${ids(workbuddyModelList("global"))}`,
);
check(
  "startup loads both regions",
  (() => {
    setWorkbuddyModelList([], "cn");
    setWorkbuddyModelList([], "global");
    const both = initWorkBuddyCatalog();
    return (
      both.size === 2 &&
      ids(both.get("cn")?.models).join(",") === "wb-alpha,wb-beta" &&
      ids(both.get("global")?.models).join(",") === "wb-global-alpha"
    );
  })(),
  "",
);

console.log("");
console.log("the ttl");

check("48 minutes by default", catalogTtlMs() === 48 * 60 * 1000, String(catalogTtlMs()));
const pinned = readInAnotherProcess({ WORKBUDDY_CATALOG_TTL_MS: "60000" });
check("the environment can pin it", pinned.ttl === 60_000, String(pinned.ttl));

console.log("");
console.log("an old catalogue is still a catalogue");

// The age of the row is what the transport looks at
// (lib/workbuddy/transport.ts: Date.now() - stored.at < catalogTtlMs()).
const old = Date.now() - 30 * 24 * 3600_000;
store().prepare("UPDATE cache SET at = ? WHERE id = ?").run(old, catalogId());
const stale = readStoredCatalog();
check("a stale row still reads", stale !== null);
check(
  "with the same models",
  ids(stale?.models).join(",") === "wb-alpha,wb-beta",
  ids(stale?.models).join(","),
);
check("and it is really stale", Date.now() - (stale?.at ?? 0) > catalogTtlMs(), String(stale?.at));

// The `at` a caller hands to writeStoredCatalog is kept in the payload, but
// the age a reader sees is the row's own timestamp: the row is written now, so
// it reads as fresh whatever the argument said.
writeStoredCatalog(MODELS, "cn", old);
const rewritten = readStoredCatalog();
check(
  "writing an old catalogue keeps the models",
  ids(rewritten?.models).join(",") === "wb-alpha,wb-beta",
  ids(rewritten?.models).join(","),
);
check(
  "the age comes from the row, not from the argument",
  Math.abs((rewritten?.at ?? 0) - Date.now()) < 60_000,
  String(rewritten?.at),
);

console.log("");
console.log("an empty list is not a catalogue");

// The guard against an empty catalogue is in the caller
// (lib/workbuddy/transport.ts: `if (!models.length) return stored?.models`),
// not in the store. What the store does is recorded here: it takes the empty
// list, and it replaces what was there.
writeStoredCatalog([]);
check("nothing to read after an empty write", readStoredCatalog() === null, JSON.stringify(readStoredCatalog()));
check(
  "the row now holds the empty list",
  String(store().prepare("SELECT data FROM cache WHERE id = ?").get(catalogId())?.data ?? "").includes("[]"),
  String(store().prepare("SELECT data FROM cache WHERE id = ?").get(catalogId())?.data ?? ""),
);
check("the registry is empty too", workbuddyModelList().length === 0, String(workbuddyModelList().length));

console.log("");
console.log("a broken row is not a crash");

store().prepare("UPDATE cache SET data = ? WHERE id = ?").run("{not json", catalogId());
check("a broken row reads as nothing", readStoredCatalog() === null, JSON.stringify(readStoredCatalog()));

store()
  .prepare("UPDATE cache SET data = ? WHERE id = ?")
  .run(JSON.stringify({ models: 42 }), catalogId());
check("a row of the wrong shape reads as nothing", readStoredCatalog() === null, JSON.stringify(readStoredCatalog()));

store()
  .prepare("UPDATE cache SET data = ? WHERE id = ?")
  .run(JSON.stringify({ models: [] }), catalogId());
check("an empty list in the row reads as nothing", readStoredCatalog() === null, JSON.stringify(readStoredCatalog()));

console.log("");
console.log("the effort levels the upstream declares");

// The upstream answers two shapes. `supportedEfforts` is the list the user can
// pick from; a bare `effort` is a model that always thinks at that one level.
// The single-item list is what a fixed level must not become: the client renders
// its picker on `supportedEfforts?.length`, so `["high"]` shows a dropdown with
// one choice in it. An empty list is the other trap: it is a value, so the merge
// takes it over the table's list — the model then loses the levels it can pick.
const catalogueOf = (entries: any[]): WorkBuddyModel[] => {
  const remote = parseRemoteCatalog({ data: { agents: [{ models: entries.map((e) => e.id) }], models: entries } });
  if (!remote) throw new Error("the payload has no catalogue in it");
  return curateCatalog(remote);
};
const effortsOf = (models: WorkBuddyModel[], id: string): string =>
  JSON.stringify(models.find((m) => m.id === id)?.efforts ?? null);
const defaultEffortOf = (models: WorkBuddyModel[], id: string): string =>
  JSON.stringify(models.find((m) => m.id === id)?.defaultEffort ?? null);

const fixed = catalogueOf([{ id: "tm-fixed", reasoning: { effort: "high", summary: "auto" } }]);
check(
  // Nobody lists this model's levels, so there is nothing to pick — only the
  // level it always runs at.
  "a fixed effort on a model nobody lists is no pickable level",
  effortsOf(fixed, "tm-fixed") === "[]" && defaultEffortOf(fixed, "tm-fixed") === '"high"',
  `${effortsOf(fixed, "tm-fixed")} / ${defaultEffortOf(fixed, "tm-fixed")}`,
);

const listed = catalogueOf([
  { id: "tm-listed", reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high", effort: "low" } },
]);
check(
  "a list of levels is the list, not the single effort beside it",
  effortsOf(listed, "tm-listed") === '["low","high","max"]',
  effortsOf(listed, "tm-listed"),
);

const silent = catalogueOf([{ id: "tm-silent", reasoning: {} }, { id: "tm-nothing" }]);
check("no reasoning at all is no levels", effortsOf(silent, "tm-silent") === "[]", effortsOf(silent, "tm-silent"));
check("an absent reasoning is no levels", effortsOf(silent, "tm-nothing") === "[]", effortsOf(silent, "tm-nothing"));

// The recorded answer from workbuddy.cn, through the same mapping the gateway
// uses. This is the shape that made the bug visible: a model whose level is
// fixed at `high` came out as a one-item picker, and a model with no `credits`
// in the answer came out free.
const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/get-workbuddy-v3-config.json"), "utf8"));
const recordedPayload = JSON.parse(recorded.body);
const recordedRemote = parseRemoteCatalog(recordedPayload);
check("the recorded catalogue parses", recordedRemote !== null);
// `deepseek-v4-flash` rides only in the metadata array, not in the picker list,
// so it is read from the metadata the mapping builds. A fixed level must not
// turn into `[]`: an empty list is a value, and the merge takes it over the
// table's — the mapping has to say nothing about the levels instead.
const fixedEntry = recordedRemote?.meta["deepseek-v4-flash"] ?? {};
check(
  "a recorded fixed effort says the level and not the levels",
  !("efforts" in fixedEntry) && fixedEntry.defaultEffort === "high",
  JSON.stringify(recordedRemote?.meta["deepseek-v4-flash"] ?? null),
);
const recordedModels = curateCatalog(recordedRemote!);
// What the gateway publishes for cn: the transport hands the bundled table's ids
// in as extras (lib/workbuddy/transport.ts), so `deepseek-v4-flash` is in the
// catalogue and this is the list an agent sees.
const publishedCn = curateCatalog(recordedRemote!, workBuddyFallbackModels().map((m) => m.id));
check(
  "a recorded fixed effort keeps the levels the table lists",
  effortsOf(publishedCn, "deepseek-v4-flash") === '["high","xhigh"]' &&
    defaultEffortOf(publishedCn, "deepseek-v4-flash") === '"high"',
  `${effortsOf(publishedCn, "deepseek-v4-flash")} / ${defaultEffortOf(publishedCn, "deepseek-v4-flash")}`,
);
check(
  "a recorded list of levels is the list",
  effortsOf(recordedModels, "deepseek-v4.1-flash") === '["low","high","max"]',
  effortsOf(recordedModels, "deepseek-v4.1-flash"),
);
check(
  "a recorded medium sets the default level and keeps the table's levels",
  effortsOf(recordedModels, "glm-5.2") === '["high","xhigh"]' &&
    defaultEffortOf(recordedModels, "glm-5.2") === '"medium"',
  `${effortsOf(recordedModels, "glm-5.2")} / ${defaultEffortOf(recordedModels, "glm-5.2")}`,
);

console.log("");
console.log("the bundled China table comes from the client product config");

// The table is generated from the desktop client's own product config
// (scripts/workbuddy-catalog.ts -> lib/workbuddy/cn-catalog.json), because the
// upstream's /v3/config does not carry these numbers for a cn account.
const tableEntry = (id: string): WorkBuddyModel | undefined => workbuddyModel(id);
const describe = (id: string): string => JSON.stringify(tableEntry(id) ?? null);

check(
  "deepseek-v4.1-flash: 0.11, low/high/max, default high, thinking can be off",
  tableEntry("deepseek-v4.1-flash")?.credits === 0.11 &&
    JSON.stringify(tableEntry("deepseek-v4.1-flash")?.efforts) === '["low","high","max"]' &&
    tableEntry("deepseek-v4.1-flash")?.defaultEffort === "high" &&
    tableEntry("deepseek-v4.1-flash")?.canDisableThinking === true,
  describe("deepseek-v4.1-flash"),
);
check(
  "deepseek-v4-flash: 0.17, high/xhigh",
  tableEntry("deepseek-v4-flash")?.credits === 0.17 &&
    JSON.stringify(tableEntry("deepseek-v4-flash")?.efforts) === '["high","xhigh"]',
  describe("deepseek-v4-flash"),
);
check(
  "deepseek-v4-pro: 0.51, high/xhigh",
  tableEntry("deepseek-v4-pro")?.credits === 0.51 &&
    JSON.stringify(tableEntry("deepseek-v4-pro")?.efforts) === '["high","xhigh"]',
  describe("deepseek-v4-pro"),
);
check(
  "glm-5.2: 0.79, high/xhigh",
  tableEntry("glm-5.2")?.credits === 0.79 && JSON.stringify(tableEntry("glm-5.2")?.efforts) === '["high","xhigh"]',
  describe("glm-5.2"),
);

// The judgement this whole file exists for: an upstream answer without
// `credits` used to write 0 into the catalogue, so every model looked free.
const withoutCredits = parseRemoteCatalog({
  data: {
    agents: [{ models: ["deepseek-v4.1-flash"] }],
    models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", maxInputTokens: 1000000, maxOutputTokens: 128000 }],
  },
})!;
check("the answer really has no credits in it", withoutCredits.meta["deepseek-v4.1-flash"]?.credits === undefined, JSON.stringify(withoutCredits.meta));
const keptCredits = curateCatalog(withoutCredits).find((m) => m.id === "deepseek-v4.1-flash");
check("an answer without credits keeps the table's multiplier", keptCredits?.credits === 0.11, describe("deepseek-v4.1-flash") + " -> " + JSON.stringify(keptCredits ?? null));

const withoutEfforts = parseRemoteCatalog({
  data: {
    agents: [{ models: ["deepseek-v4.1-flash"] }],
    models: [{ id: "deepseek-v4.1-flash", credits: "x0.11 credits", reasoning: { summary: "auto" } }],
  },
})!;
const keptEfforts = curateCatalog(withoutEfforts).find((m) => m.id === "deepseek-v4.1-flash");
check(
  "an answer without supportedEfforts keeps the table's levels",
  JSON.stringify(keptEfforts?.efforts) === '["low","high","max"]',
  JSON.stringify(keptEfforts ?? null),
);

// The other direction has to keep working: when the upstream does list the
// levels, that list is the one published, whatever the table says.
const listedOnATableModel = curateCatalog(
  parseRemoteCatalog({
    data: {
      agents: [{ models: ["deepseek-v4.1-flash"] }],
      models: [
        { id: "deepseek-v4.1-flash", reasoning: { supportedEfforts: ["minimal", "low"], defaultEffort: "low" } },
      ],
    },
  })!,
).find((m) => m.id === "deepseek-v4.1-flash");
check(
  "the upstream's list of levels wins over the table's",
  JSON.stringify(listedOnATableModel?.efforts) === '["minimal","low"]' &&
    listedOnATableModel?.defaultEffort === "low",
  JSON.stringify(listedOnATableModel ?? null),
);

// The other region: workbuddy.ai is not covered by the bundled table, so its
// catalogue is the upstream's own list and the upstream's own values.
const globalRemote = parseRemoteCatalog({
  data: {
    agents: [{ models: ["glm-5.2"] }],
    models: [{ id: "glm-5.2", credits: "x9.99 credits", reasoning: { supportedEfforts: ["low"], defaultEffort: "low" } }],
  },
})!;
const globalModels = curateCatalog(globalRemote, []);
check("global publishes only what its upstream names", ids(globalModels).join(",") === "glm-5.2", ids(globalModels).join(","));
check(
  "global takes the upstream's multiplier and levels over the table's",
  globalModels[0]?.credits === 9.99 && JSON.stringify(globalModels[0]?.efforts) === '["low"]',
  JSON.stringify(globalModels[0] ?? null),
);
check(
  "the bundled table holds chat models only",
  workBuddyFallbackModels().length > 0 &&
    workBuddyFallbackModels().every((m) => !/^codewise-|^completion-|image|video/.test(m.id)),
  String(workBuddyFallbackModels().length),
);

// An upstream entry for a model the table does not know is still usable, and it
// says nothing about the price rather than claiming it is free.
const unknown = mergeWorkBuddyCatalog(["tm-unknown"], { "tm-unknown": { display_name: "Unknown", context: 4096 } })[0];
check("a model nobody prices is null, not free", unknown?.credits === null, JSON.stringify(unknown ?? null));

console.log("");
console.log("cn 公布的是代码表，不是上游那一份");

// What was fetched is the record of what the upstream said, and it keeps every
// model the answer named. What a cn agent is offered is the bundled table: a
// model the upstream added and the table does not have is not published — that
// is the whole point of this region being code-side. The two lists are therefore
// different on purpose, and both are checked here so neither can drift silently.
const fetchedCn = curateCatalog(recordedRemote!, workBuddyFallbackModels().map((m) => m.id));
setWorkbuddyModelList(fetchedCn, "cn");
check(
  "库里的那份比代码表宽（上游多出来的模型留在记录里）",
  workbuddyModelList("cn").length === fetchedCn.length && fetchedCn.length > workBuddyFallbackModels().length,
  `${workbuddyModelList("cn").length} / ${workBuddyFallbackModels().length}`,
);
check(
  "库里那份带着上游独有、代码表没有的模型",
  ids(workbuddyModelList("cn")).includes("glm-5v-turbo") && ids(workbuddyModelList("cn")).includes("kimi-k2.6"),
  ids(workbuddyModelList("cn")).join(","),
);
const shownCn = workbuddyPublishList("cn");
check(
  "公布的正好是代码表那几条（id 与顺序）",
  ids(shownCn).join(",") === workBuddyFallbackModels().map((m) => m.id).join(","),
  `${ids(shownCn).length} / ${workBuddyFallbackModels().length}`,
);
check("glm-5v-turbo 不公布", !ids(shownCn).includes("glm-5v-turbo"));
check("kimi-k2.6 不公布", !ids(shownCn).includes("kimi-k2.6"));
check(
  "代码表里那一条的元数据仍是上游补过的那份",
  shownCn.find((m) => m.id === "deepseek-v4-flash")?.credits === 0.17,
  JSON.stringify(shownCn.find((m) => m.id === "deepseek-v4-flash") ?? null),
);
// 另一个区不受这条规矩管：那边没有代码表，上游给全了就是全部。
setWorkbuddyModelList(globalModels, "global");
check("global 公布的仍是上游那一份", ids(workbuddyPublishList("global")).join(",") === "glm-5.2", ids(workbuddyPublishList("global")).join(","));

// Close the database before removing its directory: on Windows an open handle
// makes the removal fail with EPERM. On Linux it makes no difference.
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
