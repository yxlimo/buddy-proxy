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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./paths.ts";
import { migrate, tighten } from "./store-migrate.ts";

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
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 已有的数据目录也收紧：mkdir 的 mode 只管新建的那一次。Windows 上 chmod
  // 没有意义，失败也不报错。
  tighten(dir, 0o700);
  if (!fs.existsSync(file)) {
    // An empty file is a valid new database, and creating it ourselves is the
    // only way to get the mode right.
    fs.writeFileSync(file, "", { mode: 0o600 });
  } else {
    tighten(file, 0o600);
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
  // 每个平台用过的最大账号序号：账号 id 不复用（见 lib/providers.ts 的 nextAccountId）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS account_seq (
      platform TEXT PRIMARY KEY,
      last     INTEGER NOT NULL
    )`,
  );
  // WAL 的两个旁文件里也是凭据：开库之后它们才在，在这里一起收紧。
  tighten(`${file}-wal`, 0o600);
  tighten(`${file}-shm`, 0o600);
  try {
    migrate(db, file);
  } catch (e) {
    // 迁移没成（事务已经回滚）：别留着一个半开的库让后面的调用接着用。
    closeStore();
    throw e;
  }
  return db;
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

/** Every secret whose id starts with the prefix. */
export function listSecrets(prefix = ""): SecretRow[] {
  const rows = store()
    // 前缀按字面比：LIKE 会把 id 里的 `_`、`%` 当通配符。
    .prepare("SELECT id, kind, data, updated_at FROM secrets WHERE substr(id, 1, ?) = ? ORDER BY id")
    .all(prefix.length, prefix) as any[];
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
    .prepare("SELECT id, at FROM cache WHERE substr(id, 1, ?) = ? ORDER BY at")
    .all(prefix.length, prefix) as { id?: string; at?: number }[];
  return rows.map((row) => ({ id: String(row.id ?? ""), at: Number(row.at ?? 0) }));
}

/** Forget a cached value. */
export function deleteCached(id: string): void {
  store().prepare("DELETE FROM cache WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ *
 * The lock
 * ------------------------------------------------------------------ */

/**
 * A lock older than this counts as abandoned.
 *
 * It has to outlive the work it guards: a refresh may take its whole timeout
 * (30 s by default), and a lock that expires while the holder is still asking
 * the platform lets a second writer rotate the same refresh token. Callers
 * that know how long their work can take pass their own (see
 * lib/session.ts); this default is twice the default refresh timeout.
 */
export const LOCK_STALE_MS = 60_000;

/** The lock could not be taken: somebody else is mid-refresh. */
export class LockUnavailableError extends Error {}

/**
 * Single writer around a refresh.
 *
 * Two holders of the same refresh token would rotate it twice and one of them
 * would be logged out, so a refresh takes this lock first. The other writer
 * waits; when the lock is gone it reads the session and finds the fresh token.
 *
 * Each acquisition has its own holder token: the release deletes only the
 * row this holder wrote, so a holder whose lock was declared stale and taken
 * over cannot release the new holder's lock on its way out.
 */
export async function withLock<T>(
  id: string,
  fn: () => Promise<T>,
  options: { staleMs?: number; attempts?: number } = {},
): Promise<T> {
  const staleMs = Math.max(1, options.staleMs ?? LOCK_STALE_MS);
  const attempts = Math.max(1, options.attempts ?? 3);
  const holder = `${process.pid}:${crypto.randomUUID()}`;
  let acquired = false;
  for (let i = 0; i < attempts && !acquired; i++) {
    try {
      store()
        .prepare("INSERT INTO locks (id, holder, at) VALUES (?, ?, ?)")
        .run(id, holder, Date.now());
      acquired = true;
    } catch (e) {
      const message = String((e as Error)?.message ?? "");
      if (!message.includes("UNIQUE") && !message.includes("constraint")) throw e;
      const row = store().prepare("SELECT holder, at FROM locks WHERE id = ?").get(id) as
        | { holder?: string; at?: number }
        | undefined;
      if (!row) continue; // released between the insert and the read
      const age = row.at ? Date.now() - Number(row.at) : staleMs + 1;
      if (age > staleMs) {
        // Only the abandoned row goes: if somebody took the lock in the
        // meantime, its row has another holder and stays.
        try {
          store()
            .prepare("DELETE FROM locks WHERE id = ? AND holder = ? AND at = ?")
            .run(id, String(row.holder ?? ""), Number(row.at ?? 0));
        } catch {
          /* someone else won the race */
        }
        continue;
      }
      // Another writer is mid-refresh: wait for its result instead of racing it.
      await new Promise((r) => setTimeout(r, Math.min(staleMs - age, 2000)));
    }
  }
  if (!acquired) {
    throw new LockUnavailableError(`could not acquire the credential lock (${id})`);
  }
  try {
    return await fn();
  } finally {
    try {
      store().prepare("DELETE FROM locks WHERE id = ? AND holder = ?").run(id, holder);
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
