// test/catalog-persist-check.ts — the model catalogue that lives in the
// database.
//
//   node --experimental-strip-types test/catalog-persist-check.ts
//
// Offline: a temporary data directory, no upstream, no request, no tokens.
//
// The catalogue of an upstream (lib/router/catalog-cache.ts) is fetched, and
// an empty one makes the whole platform disappear from the model list — a
// platform that is invisible cannot be routed to. So the last list the
// upstream published is kept in the database. What is checked here:
//
//   1. a fresh database holds no catalogue
//   2. what was written comes back, in memory and in the database
//   3. it survives a restart, and an old catalogue still asks to be fetched
//      again: stale means "fetch again", not "nothing to serve"
//   4. an empty list does not overwrite the stored one, and a cache without
//      an id stays in memory only

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-persist-"));
// The data directory has to be set before the store is imported: the store
// opens the file the first time it is asked for it.
process.env.BUDDY_DATA_DIR = tmp;

const { CatalogCache } = await import("../lib/router/catalog-cache.ts");
const { store, listCached } = await import("../lib/store.ts");

const TTL = 30 * 60 * 1000;
const CACHE_ID = "sensenova:catalog";

interface Model {
  id: string;
}

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

const ids = (models: Model[] | undefined): string => (models ?? []).map((m) => m.id).join(",");

console.log("");
console.log("a fresh database");

const cache = new CatalogCache<Model>(TTL, { cacheId: CACHE_ID });
check("no catalogue to read", cache.list().length === 0, JSON.stringify(cache.list()));
check("and it is worth fetching", cache.stale() === true, String(cache.stale()));
check("and no row was written", listCached("").length === 0, JSON.stringify(listCached("")));

console.log("");
console.log("what was written comes back");

check("the update is accepted", cache.update([{ id: "m1" }]) === true);
check("it is in memory", ids(cache.list()) === "m1", ids(cache.list()));
check(
  "the row is in the database",
  listCached(CACHE_ID).length === 1,
  JSON.stringify(listCached(CACHE_ID)),
);
const row = store().prepare("SELECT data FROM cache WHERE id = ?").get(CACHE_ID) as
  | { data?: string }
  | undefined;
check("the row holds the models", String(row?.data ?? "").includes("m1"), String(row?.data ?? ""));

console.log("");
console.log("it survives a restart");

// The process starts with an empty memory and the database is what fills it.
const fresh = new CatalogCache<Model>(TTL, { cacheId: CACHE_ID });
check("a new instance reads it back", ids(fresh.list()) === "m1", ids(fresh.list()));
check("and it is not stale yet", fresh.stale() === false, String(fresh.stale()));

// Three days old: the catalogue is still a catalogue, but it is time to ask
// the upstream again.
const old = Date.now() - 3 * 24 * 3600_000;
store()
  .prepare("UPDATE cache SET data = ?, at = ? WHERE id = ?")
  .run(JSON.stringify({ items: [{ id: "m1" }], at: old }), old, CACHE_ID);

const aged = new CatalogCache<Model>(TTL, { cacheId: CACHE_ID });
check("the old catalogue still reads", ids(aged.list()) === "m1", ids(aged.list()));
check("and it is still worth fetching", aged.stale() === true, String(aged.stale()));

console.log("");
console.log("an empty list is not a catalogue");

check("the empty update is refused", aged.update([]) === false);
const afterEmpty = store().prepare("SELECT data FROM cache WHERE id = ?").get(CACHE_ID) as
  | { data?: string }
  | undefined;
check(
  "the row still holds the old catalogue",
  String(afterEmpty?.data ?? "").includes("m1"),
  String(afterEmpty?.data ?? ""),
);
check("and so does the memory", ids(aged.list()) === "m1", ids(aged.list()));

console.log("");
console.log("a cache without an id stays in memory");

const plain = new CatalogCache<Model>(TTL);
check("it starts empty", plain.list().length === 0, JSON.stringify(plain.list()));
check("the update is accepted", plain.update([{ id: "m2" }]) === true);
check("and it is in memory", ids(plain.list()) === "m2", ids(plain.list()));
check(
  "but no row was written for it",
  listCached("").length === 1 && listCached("")[0]?.id === CACHE_ID,
  JSON.stringify(listCached("")),
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
