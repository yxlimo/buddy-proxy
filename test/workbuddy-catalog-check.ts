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
//   8. the effort levels the upstream declares survive the mapping: a fixed
//      `effort` is one level, not zero

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
const { workbuddyModelList, setWorkbuddyModelList, parseRemoteCatalog, curateCatalog } = await import(
  "../lib/workbuddy/models.ts"
);

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
// Reading only the list published the fixed-effort models with no levels at
// all, so the clients could not turn thinking on for them.
const catalogueOf = (entries: any[]): WorkBuddyModel[] => {
  const remote = parseRemoteCatalog({ data: { agents: [{ models: entries.map((e) => e.id) }], models: entries } });
  if (!remote) throw new Error("the payload has no catalogue in it");
  return curateCatalog(remote);
};
const effortsOf = (models: WorkBuddyModel[], id: string): string =>
  JSON.stringify(models.find((m) => m.id === id)?.efforts ?? null);

const fixed = catalogueOf([{ id: "tm-fixed", reasoning: { effort: "high", summary: "auto" } }]);
check("a fixed effort is one level", effortsOf(fixed, "tm-fixed") === '["high"]', effortsOf(fixed, "tm-fixed"));

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
// fixed at `high` came out with nothing.
const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/get-workbuddy-v3-config.json"), "utf8"));
const recordedPayload = JSON.parse(recorded.body);
const recordedRemote = parseRemoteCatalog(recordedPayload);
check("the recorded catalogue parses", recordedRemote !== null);
// `deepseek-v4-flash` rides only in the metadata array, not in the picker list,
// so it is read from the metadata the mapping builds.
check(
  "a recorded fixed effort is one level",
  JSON.stringify(recordedRemote?.meta["deepseek-v4-flash"]?.efforts ?? null) === '["high"]',
  JSON.stringify(recordedRemote?.meta["deepseek-v4-flash"]?.efforts ?? null),
);
const recordedModels = curateCatalog(recordedRemote!);
check(
  "a recorded list of levels is the list",
  effortsOf(recordedModels, "deepseek-v4.1-flash") === '["low","high","max"]',
  effortsOf(recordedModels, "deepseek-v4.1-flash"),
);
check(
  "a recorded medium is one level",
  effortsOf(recordedModels, "glm-5.2") === '["medium"]',
  effortsOf(recordedModels, "glm-5.2"),
);

// Close the database before removing its directory: on Windows an open handle
// makes the removal fail with EPERM. On Linux it makes no difference.
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
