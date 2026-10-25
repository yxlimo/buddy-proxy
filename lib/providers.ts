// lib/providers.ts — the rows the gateway talks to.
//
// The vocabulary is AGENTS.md's: an **upstream** is one platform's one service
// (MiniMax's open platform, MiniMax Code, Qoder China, ...), and a **provider**
// is one account of an upstream. A row here is an upstream; the accounts
// under it are its providers.
//
// A row has two parts:
//
//   kind   what kind of upstream it is (the behaviour)
//   id     which one it is (the identity)
//
// The kind says how to talk to it; the id says which one. Two accounts of the
// MiniMax open platform are two providers under one upstream — the alias
// tells them apart ("Token Plan" / "M Plan"), and the upstream's own policy
// decides which of them takes a request.
//
// The behaviour lives in a registry (see lib/provider-kinds.ts) instead of a
// switch on the kind: adding a kind is one entry, not seven case branches.

import { markProviderDeleted, providerDeleted, store } from "./store.ts";
import { configFlag } from "./config.ts";
import { kindOf, type ProviderKind } from "./provider-kinds.ts";

/**
 * 一个上游的引用。
 *
 * 认证与传输这些模块只认这三样：它是谁、它是什么种类、它在哪个区域。
 * 传这个而不是整行，是为了让它们不必知道数据库长什么样。
 */
export interface ProviderRef {
  id: string;
  kind: string;
  region: string;
}

/** 一行上游。 */
export interface ProviderRow {
  /** 唯一标识，也是路径里那一段：/{id}/v1/messages。 */
  id: string;
  /** 上游的种类：minimax、minimax-api、qoder…… */
  kind: string;
  /** 用来分辨同一个 kind 的两个账号。 */
  alias: string;
  /** 区域：qoder 有全球区与中国区之分。 */
  region: string;
  /** 开关。 */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 建表之后，把内置的那些 provider 放进去。 */
/**
 * The environment switch of each built-in provider.
 *
 * It is the value the row starts with: the database wins as soon as the panel
 * changes it, so a switch in the environment is a starting point, not a fight.
 */
const BUILT_IN_SWITCHES: Record<string, string> = {
  minimax: "MINIMAX_CODE",
  "minimax-api": "MINIMAX_API",
  zcode: "ZCODE",
  qoder: "QODER_GLOBAL",
  "qoder-cn": "QODER_CN",
  "workbuddy-cn": "WORKBUDDY_CN",
  tokenrhythm: "TOKENRHYTHM",
  sensenova: "SENSENOVA",
  "intern-ai": "INTERN_AI",
};

const BUILT_IN: { id: string; kind: string; alias: string; region: string }[] = [
  { id: "minimax", kind: "minimax", alias: "MiniMax Code", region: "cn" },
  { id: "minimax-api", kind: "minimax-api", alias: "MiniMax 开放平台", region: "cn" },
  { id: "zcode", kind: "zcode", alias: "ZCode", region: "cn" },
  // The two Qoder regions are two providers of the same kind: the region says
  // which one.
  { id: "qoder", kind: "qoder", alias: "Qoder（全球区）", region: "global" },
  { id: "qoder-cn", kind: "qoder", alias: "Qoder（中国区）", region: "cn" },
  { id: "workbuddy-cn", kind: "workbuddy", alias: "WorkBuddy（中国区）", region: "cn" },
  { id: "tokenrhythm", kind: "tokenrhythm", alias: "TokenRhythm", region: "" },
  { id: "sensenova", kind: "sensenova", alias: "SenseNova", region: "" },
  { id: "intern-ai", kind: "intern-ai", alias: "书生·端砚", region: "" },
];

/**
 * 内置的那些 provider 放进去。
 *
 * The kind and the region belong to the code, not to the user: a row written by
 * an older version keeps its alias and its switch, but its kind is corrected to
 * the one the registry knows.
 */
export function ensureBuiltinProviders(): void {
  const now = Date.now();
  const insert = store().prepare(
    "INSERT INTO provider (id, kind, alias, region, enabled, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  );
  const fix = store().prepare("UPDATE provider SET kind = ?, region = ?, updated_at = ? WHERE id = ?");
  for (const row of BUILT_IN) {
    // The operator deleted it: it stays deleted.
    if (providerDeleted(row.id)) continue;
    const key = BUILT_IN_SWITCHES[row.id];
    const on = key ? configFlag(key, false) : true;
    insert.run(row.id, row.kind, row.alias, row.region, on ? 1 : 0, now, now);
    const existing = store().prepare("SELECT kind, region FROM provider WHERE id = ?").get(row.id) as
      | { kind?: string; region?: string }
      | undefined;
    if (existing && (existing.kind !== row.kind || existing.region !== row.region)) {
      fix.run(row.kind, row.region, now, row.id);
    }
  }
}

/** 全部 provider。 */
export function listProviders(): ProviderRow[] {
  ensureBuiltinProviders();
  const rows = store()
    .prepare("SELECT id, kind, alias, region, enabled, created_at, updated_at FROM provider ORDER BY id")
    .all() as any[];
  return rows.map(toRow);
}

/** 某一个 provider。 */
export function provider(id: string): ProviderRow | null {
  ensureBuiltinProviders();
  const row = store()
    .prepare("SELECT id, kind, alias, region, enabled, created_at, updated_at FROM provider WHERE id = ?")
    .get(id) as any;
  return row ? toRow(row) : null;
}

/** 按 kind 找（一个 kind 可以有多个账号）。 */
export function providersOfKind(kind: string): ProviderRow[] {
  return listProviders().filter((p) => p.kind === kind);
}

function toRow(row: any): ProviderRow {
  return {
    id: String(row.id),
    kind: String(row.kind),
    alias: String(row.alias ?? ""),
    region: String(row.region ?? ""),
    enabled: Number(row.enabled) !== 0,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 改一个 provider 的别名与开关。 */
export function updateProvider(
  id: string,
  patch: { alias?: string; enabled?: boolean },
): { ok: boolean; message: string } {
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个 Provider：${id}` };
  const alias = patch.alias === undefined ? row.alias : String(patch.alias).trim();
  const enabled = patch.enabled === undefined ? row.enabled : patch.enabled;
  store()
    .prepare("UPDATE provider SET alias = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(alias, enabled ? 1 : 0, Date.now(), id);
  return { ok: true, message: "改好了" };
}

/**
 * 加一个 provider。
 *
 * 同一个 kind 可以加很多个 —— 它们各自有各自的凭据、自己的模型、自己的额度。
 * id 要自己给（路径里就是它），所以给一个好认的：kind 加个后缀。
 */
export function addProvider(input: {
  id: string;
  kind: string;
  alias?: string;
  region?: string;
}): { ok: boolean; message: string } {
  const id = String(input.id ?? "").trim();
  if (!id) return { ok: false, message: "要一个 id" };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { ok: false, message: "id 只能用小写字母、数字和连字符" };
  }
  if (provider(id)) return { ok: false, message: `已经有叫 ${id} 的了` };
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO provider (id, kind, alias, region, enabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .run(id, String(input.kind ?? ""), String(input.alias ?? ""), String(input.region ?? ""), now, now);
  return { ok: true, message: "加好了" };
}

/** 删一个 provider。它名下的凭据也一起删 —— 留着就没人认领了。 */
/**
 * Forget the credentials of a provider.
 *
 * The ids follow the pattern `session:provider:<id>`,
 * `key:provider:<id>…` and `account:<id>…`, so the prefixes are enough.
 */
export function deleteProviderCredentials(id: string): number {
  const db = store();
  const patterns = [`session:provider:${id}`, `key:provider:${id}`, `account:${id}`];
  let dropped = 0;
  for (const pattern of patterns) {
    const result = db
      .prepare("DELETE FROM secrets WHERE id = ? OR id LIKE ?")
      .run(pattern, `${pattern.replace(/[%_]/g, "")}%`);
    dropped += Number(result.changes ?? 0);
  }
  return dropped;
}

export function deleteProvider(id: string): { ok: boolean; message: string } {
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个 Provider：${id}` };
  store().prepare("DELETE FROM provider WHERE id = ?").run(id);
  // The built-in ones are put back on every start, so the deletion has to be
  // remembered -- otherwise the panel said it was gone and the next refresh
  // showed it again.
  markProviderDeleted(id);
  // The credentials go with it: nobody would claim them any more.
  const dropped = deleteProviderCredentials(id);
  return { ok: true, message: dropped > 0 ? `删掉了，连 ${dropped} 条凭据一起` : "删掉了" };
}

/** 开关。 */
export function providerEnabled(id: string): boolean {
  return provider(id)?.enabled ?? false;
}

/** 改开关。 */
export function setProviderEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  return updateProvider(id, { enabled });
}

/**
 * 凭据在数据库里的 id。
 *
 * 每个 provider 的凭据都归它自己 —— 两个同 kind 的账号各有各的会话。
 * 这一处是唯一的算法：会话是 session:provider:<id>，多出来的东西
 * （一把 key、一个租户）往后接一段。
 */
export function providerSecretId(providerId: string, suffix = ""): string {
  return suffix ? `key:provider:${providerId}:${suffix}` : `session:provider:${providerId}`;
}

/** 这个 provider 的 kind 是什么。 */
export function providerKind(id: string): string {
  return provider(id)?.kind ?? "";
}

/** 它的 kind 在注册表里的那一条。 */
export function providerKindOf(id: string): ProviderKind | null {
  const row = provider(id);
  return row ? kindOf(row.kind) : null;
}
