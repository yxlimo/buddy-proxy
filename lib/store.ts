// lib/store.ts — where the credentials live: one SQLite file.
//
// Everything secret the gateway holds is in here: the sessions of the eight
// upstreams, the keys the clients authenticate with, the relay station's
// accounts, the salt the device fingerprint is derived from. The file itself
// is 0600, the same as the session files it replaces.
//
// Two more tables live beside them:
//   locks  one writer at a time, because a refresh token rotates on every
//          refresh and two writers would log each other out
//   cache  the snapshot /health serves, so it does not have to ask the
//          upstreams every time somebody looks
//
// And one that is not a secret:
//   config the settings, so the service reads them from here at startup
//          instead of from the environment, and a management panel can
//          write them
//
// Node 24 ships SQLite, so there is no native module to compile.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./paths.ts";

/** What kind of secret a row holds. */
export type SecretKind = "session" | "key" | "account" | "salt";

export interface SecretRow {
  id: string;
  kind: string;
  data: any;
  updatedAt: number;
}

let db: DatabaseSync | null = null;

export { dbPath };

/**
 * The open database.
 *
 * A database that cannot be opened is a hard failure: the credentials are in
 * here, and carrying on without them would look like a lost login.
 */
export function store(): DatabaseSync {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    // An empty file is a valid new database, and creating it ourselves is the
    // only way to get the mode right.
    fs.writeFileSync(file, "", { mode: 0o600 });
  } else {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not ours to change */
    }
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // The aggregate catalog's targets hang off its models, and the database has
  // to know that to clean up after a model is deleted.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    `CREATE TABLE IF NOT EXISTS secrets (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS locks (
      id     TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      at     INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS cache (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      at   INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  // 账号：一行一个账号。`platform` 是代码里的模板（九个平台之一，也是请求
  // 路径里那一段），同一平台下可以有多行。
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
  // 客户端会话 → 上游会话的映射。
  //
  // 客户端给的会话 id 什么样都有（pi 给裸 UUID，opencode 给 `ses_xxx`），
  // 而上游只认自己客户端那种形状。所以映射一次，落在这里：同一个客户端会话
  // 永远是同一个上游会话 id。
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_map (
      upstream          TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (upstream, client_session_id)
    )`,
  );
  // 平台层的生效策略：一行一个平台，没有行就是默认。
  //
  // 这张表要在迁移之前就存在：迁移会把旧行上的策略搬进来。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_policy (
      platform   TEXT PRIMARY KEY,
      policy     TEXT NOT NULL DEFAULT 'single',
      updated_at INTEGER NOT NULL
    )`,
  );
  // 账号的冷却：失败之后一段时间不再路由到那个账号。
  //
  // 落库：网关重启以后它还在 —— 一个刚被限流的账号不该因为重启又被试一次。
  // 过期是惰性的：判定的时候比时间就行，不需要定时器去「恢复」。
  db.exec(
    `CREATE TABLE IF NOT EXISTS cooldown (
      provider_id TEXT PRIMARY KEY,
      until_ms    INTEGER NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    )`,
  );
  migrateProviderToAccounts(db);
  migrateProviderWeight(db);
  return db;
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
  const columns = db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has("kind")) return; // 已经是新的形状了。

  const rows = db
    .prepare("SELECT id, kind, alias, enabled, region, created_at, updated_at FROM provider")
    .all() as any[];
  const policies = has("policy")
    ? (db.prepare("SELECT id, policy FROM provider").all() as any[])
    : [];

  db.exec("ALTER TABLE provider RENAME TO provider_old");
  db.exec(
    `CREATE TABLE provider (
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
    "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const setPolicy = db.prepare(
    "INSERT INTO platform_policy (platform, policy, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(platform) DO NOTHING",
  );
  const policyOf = new Map(policies.map((r) => [String(r.id), String(r.policy ?? "single")]));
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
    const policy = policyOf.get(String(row.id));
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
  const columns = db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  if (columns.some((c) => c.name === "weight")) return;
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

/* ------------------------------------------------------------------ *
 * The secrets
 * ------------------------------------------------------------------ */

/** Read a secret; a broken row counts as no secret. */
export function getSecret<T>(id: string): T | null {
  const row = store().prepare("SELECT data FROM secrets WHERE id = ?").get(id) as
    | { data?: string }
    | undefined;
  if (!row?.data) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** Write a secret. */
export function setSecret(id: string, kind: SecretKind, data: unknown): void {
  store()
    .prepare(
      "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, " +
        "updated_at = excluded.updated_at",
    )
    .run(id, kind, JSON.stringify(data), Date.now());
}

/** Forget a secret — the way back to a fresh login. */
export function deleteSecret(id: string): void {
  store().prepare("DELETE FROM secrets WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ *
 * The deleted providers
 * ------------------------------------------------------------------ */

/** A provider the operator deleted: it stays deleted. */
export function markProviderDeleted(id: string): void {
  store()
    .prepare("INSERT INTO deleted_provider (id, deleted_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .run(id, Date.now());
}

/** Was this provider deleted? */
export function providerDeleted(id: string): boolean {
  const row = store().prepare("SELECT id FROM deleted_provider WHERE id = ?").get(id);
  return row !== undefined;
}

/** Every secret whose id starts with the prefix. */
export function listSecrets(prefix = ""): SecretRow[] {
  const rows = store()
    .prepare("SELECT id, kind, data, updated_at FROM secrets WHERE id LIKE ? ORDER BY id")
    .all(`${prefix.replace(/[%_]/g, "")}%`) as any[];
  return rows.map((r) => {
    let data: any = null;
    try {
      data = JSON.parse(r.data);
    } catch {
      data = null;
    }
    return { id: r.id, kind: r.kind, data, updatedAt: Number(r.updated_at) };
  });
}

/* ------------------------------------------------------------------ *
 * The settings
 * ------------------------------------------------------------------ */

/** One setting, and when it was last written. */
export interface ConfigRow {
  key: string;
  value: string;
  updatedAt: number;
}

/**
 * A setting that was written to the database.
 *
 * The environment is the fallback: the deployment still sets what it always
 * did, and the database is where a panel writes a change. `null` means the
 * database has nothing to say about this key.
 */
export function getConfig(key: string): string | null {
  const row = store().prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

/** Write a setting to the database. */
export function setConfig(key: string, value: string): void {
  store()
    .prepare(
      "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, Date.now());
}

/** Forget a setting — back to whatever the environment says. */
export function deleteConfig(key: string): void {
  store().prepare("DELETE FROM config WHERE key = ?").run(key);
}

/** Every setting the database holds. */
export function listConfig(): ConfigRow[] {
  const rows = store()
    .prepare("SELECT key, value, updated_at FROM config ORDER BY key")
    .all() as any[];
  return rows.map((r) => ({ key: String(r.key), value: String(r.value), updatedAt: Number(r.updated_at) }));
}

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

/** A cached value, with the time it was written. */
export interface Cached<T> {
  data: T;
  at: number;
}

/** The cached value, if it is not older than the given age. */
function getCached<T>(id: string, maxAgeMs: number): Cached<T> | null {
  const row = store().prepare("SELECT data, at FROM cache WHERE id = ?").get(id) as
    | { data?: string; at?: number }
    | undefined;
  if (!row?.data) return null;
  const at = Number(row.at ?? 0);
  if (maxAgeMs >= 0 && Date.now() - at > maxAgeMs) return null;
  try {
    return { data: JSON.parse(row.data) as T, at };
  } catch {
    return null;
  }
}

/** The cached value, however old it is. */
export function peekCached<T>(id: string): Cached<T> | null {
  return getCached<T>(id, -1);
}

/** Write a cached value. */
export function setCached(id: string, data: unknown): void {
  store()
    .prepare(
      "INSERT INTO cache (id, data, at) VALUES (?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at",
    )
    .run(id, JSON.stringify(data), Date.now());
}

/** The cached rows whose id starts with the prefix. */
export function listCached(prefix = ""): { id: string; at: number }[] {
  const rows = store()
    .prepare("SELECT id, at FROM cache WHERE id LIKE ? ORDER BY at")
    .all(`${prefix}%`) as { id?: string; at?: number }[];
  return rows.map((row) => ({ id: String(row.id ?? ""), at: Number(row.at ?? 0) }));
}

/** Forget a cached value. */
export function deleteCached(id: string): void {
  store().prepare("DELETE FROM cache WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ *
 * The lock
 * ------------------------------------------------------------------ */

/** A lock older than this counts as abandoned. */
const LOCK_STALE_MS = 30_000;

/** The lock could not be taken: somebody else is mid-refresh. */
export class LockUnavailableError extends Error {}

/**
 * Single writer around a refresh.
 *
 * Two holders of the same refresh token would rotate it twice and one of them
 * would be logged out, so a refresh takes this lock first. The other writer
 * waits; when the lock is gone it reads the session and finds the fresh token.
 */
export async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  for (let i = 0; i < 3 && !acquired; i++) {
    try {
      store()
        .prepare("INSERT INTO locks (id, holder, at) VALUES (?, ?, ?)")
        .run(id, String(process.pid), Date.now());
      acquired = true;
    } catch (e) {
      const message = String((e as Error)?.message ?? "");
      if (!message.includes("UNIQUE") && !message.includes("constraint")) throw e;
      const row = store().prepare("SELECT at FROM locks WHERE id = ?").get(id) as { at?: number } | undefined;
      const age = row?.at ? Date.now() - Number(row.at) : LOCK_STALE_MS;
      if (age > LOCK_STALE_MS) {
        try {
          store().prepare("DELETE FROM locks WHERE id = ?").run(id);
        } catch {
          /* someone else won the race */
        }
        continue;
      }
      // Another writer is mid-refresh: wait for its result instead of racing it.
      await new Promise((r) => setTimeout(r, Math.min(LOCK_STALE_MS - age, 2000)));
    }
  }
  if (!acquired) {
    throw new LockUnavailableError(`could not acquire the credential lock (${id})`);
  }
  try {
    return await fn();
  } finally {
    try {
      store().prepare("DELETE FROM locks WHERE id = ?").run(id);
    } catch {
      /* already gone */
    }
  }
}

/** Close the database — only for the tools that open it and are done. */
export function closeStore(): void {
  try {
    db?.close();
  } catch {
    /* nothing to close */
  }
  db = null;
}
