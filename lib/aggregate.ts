/**
 * The aggregate catalog: the models the root route publishes.
 *
 * Each upstream keeps its own list, reached through its own path. The root
 * route is the other way round: one list, and behind every model id a choice
 * of where the request actually goes. A model can point at one upstream model,
 * or at several of them to share the load between two accounts.
 *
 * The mapping lives in the database, so a panel can change it without a
 * restart and without touching the environment.
 */

import { store } from "./store.ts";

/**
 * The group of a published model's target.
 *
 * It is an upstream id: one row of the provider table, so two services of the
 * same platform can each be a target.
 */
export type AggregateGroup = string;

/**
 * How the targets of a model are used.
 *
 * `single` sends everything to the first target and nowhere else — the same
 * model, the same upstream, every time.
 *
 * `fallback` tries the targets in the order they are listed and stops at the
 * first one that answers. An upstream that runs out of credits then costs the
 * traffic instead of taking the model down with it.
 */
export type AggregateStrategy = "single" | "fallback";

/** One upstream model behind an exposed model. */
export interface AggregateTarget {
  /** The upstream group the model belongs to. */
  group: AggregateGroup;
  /** The model id that upstream knows. */
  upstreamModel: string;
  /**
   * How much of the traffic this target takes, relative to the others.
   *
   * It also decides the order: the bigger the weight, the earlier the target
   * is tried (the fallback goes from the heaviest to the lightest).
   */
  weight: number;
  /**
   * The order the targets were listed in.
   *
   * Kept for the database's column, but the order comes from the weight now.
   */
  position: number;
  enabled: boolean;
}

/** A model the root route publishes. */
export interface AggregateModel {
  /** The id the clients use. */
  id: string;
  /** The name the list shows. */
  displayName: string;
  enabled: boolean;
  strategy: AggregateStrategy;
  /**
   * The metadata overrides. `null` means "whatever the target says" — an
   * exposed model that fronts two upstreams takes the smaller of the two
   * context windows, because that is what it can promise.
   */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: boolean | null;
  toolCall: boolean | null;
  effortOptions: string[] | null;
  /** The upstream models behind it. */
  targets: AggregateTarget[];
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * The tables
 * ------------------------------------------------------------------ */

function ensureTables(): void {
  const db = store();
  db.exec(
    `CREATE TABLE IF NOT EXISTS aggregate_model (
      id                TEXT PRIMARY KEY,
      display_name      TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      strategy          TEXT NOT NULL DEFAULT 'single',
      context_window    INTEGER,
      max_output_tokens INTEGER,
      reasoning         INTEGER,
      tool_call         INTEGER,
      effort_options    TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS aggregate_target (
      model_id       TEXT NOT NULL,
      group_name     TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      weight         INTEGER NOT NULL DEFAULT 1,
      position       INTEGER NOT NULL DEFAULT 0,
      enabled        INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (model_id, group_name, upstream_model),
      FOREIGN KEY (model_id) REFERENCES aggregate_model(id) ON DELETE CASCADE
    )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS aggregate_target_model ON aggregate_target (model_id)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS aggregate_usage (
      model_id           TEXT NOT NULL,
      group_name         TEXT NOT NULL,
      upstream_model     TEXT NOT NULL,
      requests           INTEGER NOT NULL DEFAULT 0,
      succeeded          INTEGER NOT NULL DEFAULT 0,
      failed             INTEGER NOT NULL DEFAULT 0,
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,
      completion_tokens  INTEGER NOT NULL DEFAULT 0,
      last_used_at       INTEGER NOT NULL,
      PRIMARY KEY (model_id, group_name, upstream_model)
    )`,
  );
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function parseEffortOptions(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((v) => String(v));
  } catch {
    return null;
  }
}

/** Every published model, with its targets. */
export function listAggregateModels(): AggregateModel[] {
  ensureTables();
  const db = store();
  const models = db
    .prepare(
      "SELECT id, display_name, enabled, strategy, context_window, max_output_tokens, " +
        "reasoning, tool_call, effort_options, created_at, updated_at " +
        "FROM aggregate_model ORDER BY id",
    )
    .all() as any[];
  const targets = db
    .prepare(
      "SELECT model_id, group_name, upstream_model, weight, position, enabled " +
        "FROM aggregate_target ORDER BY model_id, weight DESC, upstream_model",
    )
    .all() as any[];

  const byModel = new Map<string, AggregateTarget[]>();
  for (const row of targets) {
    const list = byModel.get(String(row.model_id)) ?? [];
    list.push({
      group: String(row.group_name) as AggregateGroup,
      upstreamModel: String(row.upstream_model),
      weight: Number(row.weight ?? 1),
      position: Number(row.position ?? 0),
      enabled: Number(row.enabled ?? 1) !== 0,
    });
    byModel.set(String(row.model_id), list);
  }

  return models.map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
    enabled: Number(row.enabled ?? 1) !== 0,
    strategy: String(row.strategy ?? "single") as AggregateStrategy,
    contextWindow: row.context_window === null || row.context_window === undefined
      ? null
      : Number(row.context_window),
    maxOutputTokens: row.max_output_tokens === null || row.max_output_tokens === undefined
      ? null
      : Number(row.max_output_tokens),
    reasoning: row.reasoning === null || row.reasoning === undefined ? null : Number(row.reasoning) !== 0,
    toolCall: row.tool_call === null || row.tool_call === undefined ? null : Number(row.tool_call) !== 0,
    effortOptions: parseEffortOptions(row.effort_options ?? null),
    targets: byModel.get(String(row.id)) ?? [],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

/** One published model, or null when there is none. */
export function getAggregateModel(id: string): AggregateModel | null {
  return listAggregateModels().find((m) => m.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * The cached configuration
 * ------------------------------------------------------------------ */

/**
 * The configured models, read once.
 *
 * The service does not watch the database: a change waits until it is asked
 * for. The panel writes the change and then asks, through the reload
 * endpoint, and the next request sees it.
 */
let cachedModels: AggregateModel[] | null = null;

/** The configured models, from the last read. */
export function aggregateModels(): AggregateModel[] {
  if (cachedModels === null) cachedModels = listAggregateModels();
  return cachedModels;
}

/** Read the configuration again. */
export function reloadAggregate(): number {
  cachedModels = null;
  return aggregateModels().length;
}

/* ------------------------------------------------------------------ *
 * The traffic
 * ------------------------------------------------------------------ */
/** What one request did, and where it went. */
export interface AggregateUsage {
  /** The exposed model the client asked for. */
  modelId: string;
  /** The upstream that served it. */
  group: AggregateGroup;
  /** The model inside that upstream. */
  upstreamModel: string;
  requests: number;
  succeeded: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  lastUsedAt: number;
}

/**
 * Note one request against the target that served it.
 *
 * The count is what tells the panel where the traffic actually went: which
 * upstream is carrying the load, and which one has been failing.
 */
export function recordAggregateUsage(entry: {
  modelId: string;
  group: AggregateGroup;
  upstreamModel: string;
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
}): void {
  ensureTables();
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO aggregate_usage (model_id, group_name, upstream_model, requests, " +
        "succeeded, failed, prompt_tokens, completion_tokens, last_used_at) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(model_id, group_name, upstream_model) DO UPDATE SET " +
        "requests = requests + 1, " +
        "succeeded = succeeded + excluded.succeeded, " +
        "failed = failed + excluded.failed, " +
        "prompt_tokens = prompt_tokens + excluded.prompt_tokens, " +
        "completion_tokens = completion_tokens + excluded.completion_tokens, " +
        "last_used_at = excluded.last_used_at",
    )
    .run(
      entry.modelId,
      entry.group,
      entry.upstreamModel,
      entry.ok ? 1 : 0,
      entry.ok ? 0 : 1,
      entry.promptTokens ?? 0,
      entry.completionTokens ?? 0,
      now,
    );
}

/** The traffic per target, newest first. */
export function listAggregateUsage(): AggregateUsage[] {
  ensureTables();
  const rows = store()
    .prepare(
      "SELECT model_id, group_name, upstream_model, requests, succeeded, failed, " +
        "prompt_tokens, completion_tokens, last_used_at FROM aggregate_usage " +
        "ORDER BY requests DESC",
    )
    .all() as any[];
  return rows.map((r) => ({
    modelId: String(r.model_id),
    group: String(r.group_name) as AggregateGroup,
    upstreamModel: String(r.upstream_model),
    requests: Number(r.requests),
    succeeded: Number(r.succeeded),
    failed: Number(r.failed),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    lastUsedAt: Number(r.last_used_at),
  }));
}

/** Forget the traffic counters. */
export function clearAggregateUsage(): void {
  ensureTables();
  store().prepare("DELETE FROM aggregate_usage").run();
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** What a panel sends when it saves a model. */
export interface AggregateModelInput {
  id: string;
  displayName: string;
  enabled?: boolean;
  strategy?: AggregateStrategy;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  reasoning?: boolean | null;
  toolCall?: boolean | null;
  effortOptions?: string[] | null;
  targets: AggregateTarget[];
}

/** Save a model and the targets behind it. */
export function saveAggregateModel(input: AggregateModelInput): AggregateModel {
  ensureTables();
  const db = store();
  const now = Date.now();
  const existing = db
    .prepare("SELECT created_at FROM aggregate_model WHERE id = ?")
    .get(input.id) as { created_at?: number } | undefined;

  db.prepare(
    "INSERT INTO aggregate_model (id, display_name, enabled, strategy, context_window, " +
      "max_output_tokens, reasoning, tool_call, effort_options, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, " +
      "enabled = excluded.enabled, strategy = excluded.strategy, " +
      "context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens, " +
      "reasoning = excluded.reasoning, tool_call = excluded.tool_call, " +
      "effort_options = excluded.effort_options, updated_at = excluded.updated_at",
  ).run(
    input.id,
    input.displayName,
    input.enabled === false ? 0 : 1,
    input.strategy ?? "single",
    input.contextWindow ?? null,
    input.maxOutputTokens ?? null,
    input.reasoning === null || input.reasoning === undefined ? null : input.reasoning ? 1 : 0,
    input.toolCall === null || input.toolCall === undefined ? null : input.toolCall ? 1 : 0,
    input.effortOptions ? JSON.stringify(input.effortOptions) : null,
    existing?.created_at ?? now,
    now,
  );

  db.prepare("DELETE FROM aggregate_target WHERE model_id = ?").run(input.id);
  const insert = db.prepare(
    "INSERT INTO aggregate_target (model_id, group_name, upstream_model, weight, position, enabled) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  input.targets.forEach((target, index) => {
    insert.run(
      input.id,
      target.group,
      target.upstreamModel,
      target.weight ?? 1,
      target.position ?? index,
      target.enabled === false ? 0 : 1,
    );
  });

  return getAggregateModel(input.id)!;
}

/** Remove a model and its targets. */
export function deleteAggregateModel(id: string): void {
  ensureTables();
  const db = store();
  db.prepare("DELETE FROM aggregate_target WHERE model_id = ?").run(id);
  db.prepare("DELETE FROM aggregate_model WHERE id = ?").run(id);
}
