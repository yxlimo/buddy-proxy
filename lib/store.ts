// lib/store.ts — where the credentials live: one SQLite file.
//
// Everything secret the gateway holds is in here: the sessions of the four
// clients, the keys the clients authenticate with, the relay station's
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
export function getCached<T>(id: string, maxAgeMs: number): Cached<T> | null {
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
