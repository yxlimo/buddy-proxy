// test/store-migrate-backup-check.ts — 迁移的备份：失败重启不越拷越多；改了一半也全回滚。
//
//   node --experimental-strip-types test/store-migrate-backup-check.ts
//
// 离线：每一段自己造一个旧形状的库，开 store()，看结果。
//   1. 迁移每次都失败、反复重启（restart: unless-stopped）：只有一份备份。
//   2. 迁移改了一半才失败（旧表已改名、新表已建、行已插了，搬策略时炸）：
//      全回滚，旧表原样、没有 provider_old、平台层没有半截策略。
//   3. 修好之后迁移成功：沿用那份备份，记号收掉，日志说了备份在哪、要手动删。
//   4. 再来一次（新的）迁移：重新拷一份，不拿上一次那份充数。

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-migrate-backup-"));
const { store, closeStore } = await import("../lib/store.ts");

function backups(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.startsWith("buddy.db.bak-")).sort();
}

function tryOpen(dir: string): unknown {
  closeStore();
  process.env.BUDDY_DATA_DIR = dir;
  try {
    store();
    return null;
  } catch (e) {
    return e;
  }
}

/** 收下 console 的输出，好看迁移说了什么。 */
function captured<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const dir = path.join(root, "half");
fs.mkdirSync(dir, { recursive: true });
{
  const db = new DatabaseSync(path.join(dir, "buddy.db"));
  db.exec("CREATE TABLE provider (id TEXT PRIMARY KEY, kind TEXT, alias TEXT, enabled INTEGER, region TEXT, policy TEXT, created_at INTEGER, updated_at INTEGER)");
  db.exec("CREATE TABLE platform_policy (platform TEXT PRIMARY KEY, policy TEXT NOT NULL DEFAULT 'single', updated_at INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO provider VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("minimax", "minimax", "主", 1, "", "single", 1, 1);
  insert.run("qoder", "qoder", "全球", 1, "global", "single", 2, 2);
  // 第三行要把策略搬到平台层，而平台层那张表上挂着一个会炸的触发器：搬到
  // 它的时候，旧表已经改名、新表已经建好、前三行已经插进新表了。
  insert.run("tokenrhythm", "tokenrhythm", "中转", 1, "", "expiry_first", 3, 3);
  db.exec(
    "CREATE TRIGGER boom BEFORE INSERT ON platform_policy WHEN NEW.platform = 'tokenrhythm' " +
      "BEGIN SELECT RAISE(ABORT, 'boom: 迁移中途失败'); END",
  );
  db.exec("CREATE TABLE secrets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO secrets VALUES (?, ?, ?, ?)").run("session:provider:minimax", "session", "{}", 1);
  db.close();
}

console.log("");
console.log("迁移改了一半才失败：全回滚");

{
  const error = tryOpen(dir);
  check("迁移报错了，而且是中途那一下", String((error as Error)?.message ?? "").includes("boom"), String(error));
  closeStore();
  const db = new DatabaseSync(path.join(dir, "buddy.db"));
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  const columns = (db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[]).map((c) => c.name);
  check("没有留下 provider_old", !tables.includes("provider_old"), tables.join(","));
  check("provider 还是旧的形状", columns.includes("kind") && !columns.includes("platform"), columns.join(","));
  check("三行旧行都在", (db.prepare("SELECT COUNT(*) AS n FROM provider").get() as { n: number }).n === 3);
  check("平台层没有半截策略", (db.prepare("SELECT COUNT(*) AS n FROM platform_policy").get() as { n: number }).n === 0);
  check("凭据没动", (db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n === 1);
  db.close();
  check("留了一份备份", backups(dir).length === 1, backups(dir).join(","));
  check("记着「迁移没做完」", fs.existsSync(path.join(dir, "buddy.db.migrating")));
}

console.log("");
console.log("反复重启、反复失败：不再拷备份");

{
  const first = backups(dir);
  for (let i = 0; i < 3; i++) tryOpen(dir);
  check("还是只有那一份备份", backups(dir).join() === first.join(), backups(dir).join(","));
}

console.log("");
console.log("修好之后迁移成功");

{
  closeStore();
  const db = new DatabaseSync(path.join(dir, "buddy.db"));
  db.exec("DROP TRIGGER boom");
  db.close();
  const kept = backups(dir);
  const { value: error, lines } = captured(() => tryOpen(dir));
  check("迁移成功", error === null, String(error));
  const migrated = (store().prepare("SELECT id, platform FROM provider ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  check("三行都搬过来了", migrated.join() === "minimax,qoder,tokenrhythm", migrated.join());
  check("沿用那份备份，没有再拷", backups(dir).join() === kept.join(), backups(dir).join(","));
  check("「没做完」的记号收掉了", !fs.existsSync(path.join(dir, "buddy.db.migrating")));
  const done = lines.find((l) => l.includes("迁移完成")) ?? "";
  check("日志写了备份在哪", done.includes(kept[0] ?? "missing"), done);
  check("日志说了里面有凭据、要手动删", done.includes("凭据") && done.includes("手动删"), done);
}

console.log("");
console.log("下一次（新的）迁移：重新拷一份");

{
  closeStore();
  // 人还没删上一次的备份；库又变回要迁移的样子（少了 weight 列）。
  const db = new DatabaseSync(path.join(dir, "buddy.db"));
  db.exec("CREATE TABLE p2 AS SELECT id, platform, alias, enabled, created_at, updated_at FROM provider");
  db.exec("DROP TABLE provider");
  db.exec("ALTER TABLE p2 RENAME TO provider");
  db.close();
  const before = backups(dir);
  // 时间戳到毫秒：隔开一点，免得同名。
  await new Promise((r) => setTimeout(r, 5));
  const error = tryOpen(dir);
  check("迁移成功", error === null, String(error));
  check("多了一份新备份", backups(dir).length === before.length + 1, backups(dir).join(","));
}

closeStore();
fs.rmSync(root, { recursive: true, force: true });

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项\n  ${problems.join("\n  ")}` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
