// test/store-migrate-check.ts — 旧库的迁移：先备份，在事务里做完。
//
//   node --experimental-strip-types test/store-migrate-check.ts
//
// 离线：每一段自己造一个旧形状的库，开一次 store()，看结果。
//   1. 「一行一个上游」的旧库：搬成账号行，留了备份，备份里是原样。
//   2. 更老的库（没有 region 列）：照样搬，qoder 落在全球区。
//   3. 上一次迁移停在半路（provider_old 还在）：续做，不丢行。
//   4. 迁移中途出错：事务回滚，旧表原样还在。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-migrate-"));
const { store, closeStore } = await import("../lib/store.ts");

/** 一个新的数据目录，里面放一个按 `seed` 造出来的库。 */
function legacyDir(name: string, seed: (db: DatabaseSync) => void): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "buddy.db"));
  seed(db);
  db.close();
  return dir;
}

function open(dir: string): DatabaseSync {
  closeStore();
  process.env.BUDDY_DATA_DIR = dir;
  return store();
}

function rows(db: DatabaseSync, sql: string): any[] {
  return db.prepare(sql).all() as any[];
}

function backups(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.startsWith("buddy.db.bak-"));
}

console.log("");
console.log("旧库：一行一个上游");

{
  const dir = legacyDir("legacy", (db) => {
    db.exec(
      "CREATE TABLE provider (id TEXT PRIMARY KEY, kind TEXT, alias TEXT, enabled INTEGER, region TEXT, policy TEXT, created_at INTEGER, updated_at INTEGER)",
    );
    db.exec("CREATE TABLE platform_policy (platform TEXT PRIMARY KEY, policy TEXT NOT NULL DEFAULT 'single', updated_at INTEGER NOT NULL)");
    const insert = db.prepare("INSERT INTO provider VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("qoder", "qoder", "全球", 1, "global", "single", 1, 1);
    insert.run("qoder-cn", "qoder", "中国", 0, "cn", "fallback", 2, 2);
    insert.run("tokenrhythm", "tokenrhythm", "中转", 1, "", "expiry_first", 3, 3);
  });
  const db = open(dir);
  const migrated = rows(db, "SELECT id, platform, enabled, weight FROM provider ORDER BY id");
  check("三行都搬过来了", migrated.length === 3, JSON.stringify(migrated));
  check("qoder 中国区落在 qoder-cn", migrated.find((r) => r.id === "qoder-cn")?.platform === "qoder-cn");
  check("开关原样", migrated.find((r) => r.id === "qoder-cn")?.enabled === 0);
  check("策略搬到平台层", rows(db, "SELECT policy FROM platform_policy WHERE platform = 'tokenrhythm'")[0]?.policy === "expiry_first");
  check("旧表没了", rows(db, "SELECT name FROM sqlite_master WHERE name = 'provider_old'").length === 0);
  const made = backups(dir);
  check("留了一份备份", made.length === 1, made.join(","));
  const bak = new DatabaseSync(path.join(dir, made[0] ?? "missing"));
  const kept = bak.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  check("备份是迁移之前的样子", kept.some((c) => c.name === "kind"));
  bak.close();

  // 再开一次：已经是新形状，不再迁移，也不再备份。
  open(dir);
  check("新形状的库不再备份", backups(dir).length === 1, backups(dir).join(","));
}

console.log("");
console.log("更老的库：没有 region 列");

{
  const dir = legacyDir("no-region", (db) => {
    db.exec("CREATE TABLE provider (id TEXT PRIMARY KEY, kind TEXT, alias TEXT, enabled INTEGER, created_at INTEGER, updated_at INTEGER)");
    db.prepare("INSERT INTO provider VALUES (?, ?, ?, ?, ?, ?)").run("qoder", "qoder", "", 1, 1, 1);
    db.prepare("INSERT INTO provider VALUES (?, ?, ?, ?, ?, ?)").run("workbuddy", "workbuddy", "", 1, 2, 2);
  });
  const db = open(dir);
  const migrated = rows(db, "SELECT id, platform FROM provider ORDER BY id");
  check("搬过来了", migrated.length === 2, JSON.stringify(migrated));
  check("qoder 落在全球区", migrated.find((r) => r.id === "qoder")?.platform === "qoder");
  check("workbuddy 落在 workbuddy-cn", migrated.find((r) => r.id === "workbuddy")?.platform === "workbuddy-cn");
}

console.log("");
console.log("上一次迁移停在半路");

{
  const dir = legacyDir("half", (db) => {
    // 旧版没有事务：改了名、建了新表、搬了一行，就停了。
    db.exec("CREATE TABLE provider_old (id TEXT PRIMARY KEY, kind TEXT, alias TEXT, enabled INTEGER, region TEXT, created_at INTEGER, updated_at INTEGER)");
    db.prepare("INSERT INTO provider_old VALUES (?, ?, ?, ?, ?, ?, ?)").run("minimax", "minimax", "主", 1, "", 1, 1);
    db.prepare("INSERT INTO provider_old VALUES (?, ?, ?, ?, ?, ?, ?)").run("minimax-2", "minimax", "副", 1, "", 2, 2);
    db.exec(
      "CREATE TABLE provider (id TEXT PRIMARY KEY, platform TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO provider VALUES (?, ?, ?, ?, ?, ?, ?)").run("minimax", "minimax", "主", 1, 100, 1, 1);
  });
  const db = open(dir);
  const migrated = rows(db, "SELECT id FROM provider ORDER BY id").map((r) => r.id);
  check("没搬完的那一行补上了", migrated.join() === "minimax,minimax-2", migrated.join());
  check("旧表收掉了", rows(db, "SELECT name FROM sqlite_master WHERE name = 'provider_old'").length === 0);
  check("也留了备份", backups(dir).length === 1);
}

console.log("");
console.log("迁移出错：回滚");

{
  const dir = legacyDir("broken", (db) => {
    db.exec("CREATE TABLE provider (id TEXT PRIMARY KEY, kind TEXT, alias TEXT, enabled INTEGER, created_at INTEGER, updated_at INTEGER)");
    db.prepare("INSERT INTO provider VALUES (?, ?, ?, ?, ?, ?)").run("qoder", "qoder", "", 1, 1, 1);
    // 一张认不出来的 provider_old：续做不了，迁移要报错。
    db.exec("CREATE TABLE provider_old (something TEXT)");
  });
  let error: unknown = null;
  try {
    open(dir);
  } catch (e) {
    error = e;
  }
  check("报错了", error !== null);
  check("说了去看备份", String((error as Error)?.message ?? "").includes("buddy.db.bak-"), String((error as Error)?.message));
  closeStore();
  const db = new DatabaseSync(path.join(dir, "buddy.db"));
  const columns = (db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[]).map((c) => c.name);
  check("旧表原样还在", columns.includes("kind"), columns.join(","));
  check("旧行还在", (db.prepare("SELECT COUNT(*) AS n FROM provider").get() as { n: number }).n === 1);
  db.close();
}

closeStore();
fs.rmSync(root, { recursive: true, force: true });

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项\n  ${problems.join("\n  ")}` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
