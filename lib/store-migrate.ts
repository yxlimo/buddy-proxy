// lib/store-migrate.ts — 数据库形状的迁移，以及文件权限的收紧。
//
// 从 lib/store.ts 拆出来：那边是凭据的读写，这边是「库是旧形状时怎么搬」。
// 只有 store() 开库时调这里。

import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/** chmod，做不到就算了（不是我们的文件、Windows、文件还不存在）。 */
export function tighten(target: string, mode: number): void {
  try {
    if (fs.existsSync(target)) fs.chmodSync(target, mode);
  } catch {
    /* not ours to change */
  }
}

/**
 * 迁移：要做的时候先留一份备份，再在一个事务里做完。
 *
 * 迁移中途崩掉（旧版没有事务）会留下改了名的 provider_old 与一张半空的
 * provider：账号行就丢了。所以现在整件事在 BEGIN IMMEDIATE 里，要么全做，
 * 要么全不做；动手之前用 VACUUM INTO 拷一份一致的备份（WAL 里的内容也在里
 * 面，直接复制文件会漏掉它）。
 */
export function migrate(db: DatabaseSync, file: string): void {
  if (!migrationNeeded(db)) return;
  const kept = backup(db, file);
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateProviderToAccounts(db);
    migrateProviderWeight(db);
    db.exec("COMMIT");
    clearMarker(file);
    // 备份在「注销 = 删干净」的范围之外：之后删掉的账号，凭据还留在它里面。
    console.warn(
      `[STORE] 迁移完成。迁移前的备份在 ${kept}，里面有那时全部的凭据（会话、key、账号密码）；` +
        `确认迁移无误后请手动删掉它（之后注销的账号，凭据仍留在备份里）。`,
    );
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw e;
  }
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[];
  return rows.map((c) => String(c.name ?? ""));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** 有没有要迁移的东西。 */
function migrationNeeded(db: DatabaseSync): boolean {
  if (tableExists(db, "provider_old")) return true;
  const columns = columnsOf(db, "provider");
  return columns.includes("kind") || !columns.includes("weight");
}

/**
 * 迁移前的备份：同一个目录下的 buddy.db.bak-<时间戳>。返回备份的路径。
 *
 * 迁移失败时事务回滚，库还是拷备份时的样子；而容器是 restart: unless-stopped，
 * 每次重启都再拷一份，几轮下来磁盘就满了。所以拷之前在库旁边记一个
 * buddy.db.migrating（里面是备份的路径），迁移成功才删它：它还在、它指的
 * 备份也还在，就是上一次没迁完，接着用那一份，不再拷。
 *
 * 不认「随便哪一份 buddy.db.bak-*」：上一次迁移成功后人没删的备份是更早的
 * 样子，下一次（新的）迁移拿它当备份就漏了中间那段。
 */
function backup(db: DatabaseSync, file: string): string {
  const marker = markerOf(file);
  const pending = readMarker(marker);
  if (pending && fs.existsSync(pending)) {
    console.log(`[STORE] 上一次迁移没做完，沿用那时的备份 ${pending}，这次不再拷一份`);
    return pending;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak-${stamp}`;
  // VACUUM INTO 不肯覆盖已有的文件，正好：同一毫秒里不会有第二次迁移。
  db.prepare("VACUUM INTO ?").run(target);
  tighten(target, 0o600);
  fs.writeFileSync(marker, target, { mode: 0o600 });
  console.log(`[STORE] 迁移之前留了一份备份：${target}`);
  return target;
}

/** 「迁移还没做完」的记号放在哪。 */
function markerOf(file: string): string {
  return `${file}.migrating`;
}

function readMarker(marker: string): string {
  try {
    return fs.readFileSync(marker, "utf8").trim();
  } catch {
    return "";
  }
}

/** 迁移做完了：记号删掉，下一次迁移（如果有）重新拷备份。 */
function clearMarker(file: string): void {
  try {
    fs.rmSync(markerOf(file), { force: true });
  } catch {
    /* 留着也只是让下一次迁移沿用旧备份 */
  }
}

/**
 * 把旧的「一行一个上游」改成「一行一个账号」。
 *
 * 旧的行里 `kind` 的值基本上就是平台 id（`minimax`、`qoder`、`qoder-cn`……），
 * 但有两处要修：`workbuddy` 那一行的平台叫 `workbuddy-cn`，`qoder` 那一行要
 * 按 region 分成 `qoder`（全球区）与 `qoder-cn`（中国区）两个平台。
 *
 * 旧行的 `policy` 搬到平台层：一个平台下有多个账号时，取第一个不是默认值的
 * 那个——否则 TokenRhythm 的「余额到期优先」会默默丢掉。
 */
function migrateProviderToAccounts(db: DatabaseSync): void {
  // 上一次迁移（旧版、没有事务）停在半路：旧表已经改了名，新表建了一半。
  // 接着做：旧表里的行补进新表（已经搬过的不重复），再删旧表。
  const resuming = tableExists(db, "provider_old");
  if (!resuming) {
    if (!columnsOf(db, "provider").includes("kind")) return; // 已经是新的形状了。
    db.exec("ALTER TABLE provider RENAME TO provider_old");
  }
  const columns = columnsOf(db, "provider_old");
  if (!columns.includes("id") || !columns.includes("kind")) {
    throw new Error(
      "provider_old 不是旧版的账号表（没有 id / kind 列），不知道怎么续做迁移；" +
        "请对照迁移前的备份（buddy.db.bak-*）手工处理。",
    );
  }
  const has = (name: string) => columns.includes(name);
  // 更老的库没有 region（那时 qoder 只有全球区）、也可能没有 alias / enabled /
  // 时间列：缺的列按默认值读。
  const pick = (name: string, fallback: string) => (has(name) ? name : `${fallback} AS ${name}`);
  const rows = db
    .prepare(
      `SELECT id, kind, ${pick("alias", "''")}, ${pick("enabled", "1")}, ${pick("region", "''")}, ` +
        `${pick("created_at", "NULL")}, ${pick("updated_at", "NULL")}, ${pick("policy", "NULL")} ` +
        "FROM provider_old ORDER BY rowid",
    )
    .all() as any[];

  db.exec(
    `CREATE TABLE IF NOT EXISTS provider (
      id         TEXT PRIMARY KEY,
      platform   TEXT NOT NULL,
      alias      TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      weight     INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  const insert = db.prepare(
    "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO NOTHING",
  );
  const setPolicy = db.prepare(
    "INSERT INTO platform_policy (platform, policy, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(platform) DO NOTHING",
  );
  const now = Date.now();
  let order = 0;

  for (const row of rows) {
    const platform = platformOfLegacyRow(String(row.kind), String(row.region ?? ""));
    insert.run(
      String(row.id),
      platform,
      String(row.alias ?? ""),
      Number(row.enabled ?? 1) ? 1 : 0,
      // 旧行没有权重：按创建先后给一个递减的，顺序跟从前一样。
      100 - order * 10,
      Number(row.created_at ?? now),
      Number(row.updated_at ?? now),
    );
    order++;
    const policy = String(row.policy ?? "single");
    if (policy && policy !== "single") setPolicy.run(platform, policy, now);
  }
  db.exec("DROP TABLE provider_old");
}

/**
 * 权重这一列是后来加的：旧的账号行没有它，先补上。
 *
 * 补的默认值按创建先后递减（第一个 100、第二个 90……），这样顺序跟从前一样，
 * 面板上再让人调。
 */
function migrateProviderWeight(db: DatabaseSync): void {
  if (columnsOf(db, "provider").includes("weight")) return;
  db.exec("ALTER TABLE provider ADD COLUMN weight INTEGER NOT NULL DEFAULT 100");
  const rows = db
    .prepare("SELECT id, platform FROM provider ORDER BY platform, created_at, id")
    .all() as { id?: string; platform?: string }[];
  const perPlatform = new Map<string, number>();
  const set = db.prepare("UPDATE provider SET weight = ? WHERE id = ?");
  for (const row of rows) {
    const platform = String(row.platform ?? "");
    const order = perPlatform.get(platform) ?? 0;
    perPlatform.set(platform, order + 1);
    set.run(100 - order * 10, String(row.id));
  }
}


/** 旧行（kind + region）属于哪个平台。 */
function platformOfLegacyRow(kind: string, region: string): string {
  if (kind === "workbuddy") return "workbuddy-cn";
  if (kind === "qoder") return region === "cn" ? "qoder-cn" : "qoder";
  return kind;
}
