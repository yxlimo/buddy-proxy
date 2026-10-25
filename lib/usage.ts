// lib/usage.ts — 请求级的用量日志。
//
// 以前只有 aggregate_usage 那张聚合表：每个「公布的模型 × 上游 × 上游模型」
// 一行，记着累计的请求数与令牌数。它回答不了「今天用了多少」「哪个上游、
// 哪个模型用掉的令牌最多」—— 那张表只有 last_used_at，按天分组只能把一行
// 的全部历史算到它最后一次被用到的那天。
//
// 这张表记的是每一条请求：什么时候、哪个上游、哪个模型、客户端要的是什么、
// 由哪个模拟客户端发出的（模拟端）、成功还是失败、用了多少令牌。面板的用量页和
// 「今日用量」都从这里出。

import { store } from "./store.ts";

/** 一条请求。 */
export interface UsageEvent {
  /** 库里的自增 id，稳定的游标。 */
  id: number;
  /** Unix 毫秒。 */
  ts: number;
  /** 本地时区的天，YYYY-MM-DD。 */
  day: string;
  /** 本地时区的小时，0..23。 */
  hour: number;
  /** 哪个上游：minimax / qoder / qoder-cn / workbuddy-cn / tokenrhythm / sensenova / intern-ai。 */
  upstreamId: string;
  /** 上游认识的那个模型 id。 */
  upstreamModel: string;
  /** 客户端写的模型 id（聚合路由里是公布出来的名字）。 */
  agentModel: string;
  /** 谁发来的请求：pi、opencode、dsh……从请求头认出来的。 */
  agent: string;
  /** 这次请求属于哪个会话（从请求头认出来的）。认不出来就是空的。 */
  sessionId: string;
  /** 父会话 id。只有子代理有；空的就是主代理。 */
  parentSessionId: string;
  /**
   * 子代理的 agent 名（be-match、reviewer……）。
   *
   * 子代理的会话 id 每次运行都不同，所以 agent 名是跨运行能聚合的那一维。
   */
  agentName: string;
  /**
   * 这次请求是由哪个模拟客户端发出的（模拟端）。
   *
   * 填的是 kind 注册表里的 label：Qoder 的全球区与中国区都是「Qoder」，
   * MiniMax Code 与 MiniMax 开放平台是两个名字。找不到那一条（provider 行
   * 不在了、kind 没登记）时退回上游 id。
   *
   * 这一列改过含义：以前填的是上游 id，所以历史行是 id、新行是名字，
   * 面板上会新旧混排。
   */
  client: string;
  /** 成没成。 */
  ok: boolean;
  /** HTTP 状态码。 */
  status: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  /** 失败时的原因。 */
  error: string;
}

/** 写一条之前的东西：id 和时间由这里补。 */
export type UsageEventInput = Omit<UsageEvent, "id" | "day" | "hour" | "ts"> & { ts?: number };

/** 本地时区的天。 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时区的小时。 */
export function localHour(ts: number): number {
  return new Date(ts).getHours();
}

function ensureTable(): void {
  store().exec(
    `CREATE TABLE IF NOT EXISTS usage_event (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL,
      day               TEXT NOT NULL,
      hour              INTEGER NOT NULL,
      upstream_id       TEXT NOT NULL,
      upstream_model    TEXT NOT NULL,
      agent_model       TEXT NOT NULL,
      agent             TEXT NOT NULL,
      session_id        TEXT NOT NULL DEFAULT '',
      parent_session_id TEXT NOT NULL DEFAULT '',
      agent_name        TEXT NOT NULL DEFAULT '',
      client            TEXT NOT NULL,
      ok                INTEGER NOT NULL,
      status            INTEGER NOT NULL,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
      latency_ms        INTEGER NOT NULL DEFAULT 0,
      error             TEXT NOT NULL DEFAULT ''
    )`,
  );
  store().exec("CREATE INDEX IF NOT EXISTS usage_event_ts ON usage_event (ts)");
  store().exec("CREATE INDEX IF NOT EXISTS usage_event_upstream ON usage_event (upstream_id)");
  // 新列要先补上再建它的索引 —— 老库上那一列还没有。
  addMissingColumns();
  try {
    store().exec("CREATE INDEX IF NOT EXISTS usage_event_session ON usage_event (session_id)");
  } catch {
    // 索引建不上不影响统计本身。
  }
}

/**
 * 表已经存在的时候补上后加的列。
 *
 * SQLite 的 `CREATE TABLE IF NOT EXISTS` 不会动已有的表，所以新列要自己加。
 */
function addMissingColumns(): void {
  const have = new Set(
    (store().prepare("PRAGMA table_info(usage_event)").all() as any[]).map((c) => String(c.name)),
  );
  for (const [name, type] of [
    ["session_id", "TEXT NOT NULL DEFAULT ''"],
    ["parent_session_id", "TEXT NOT NULL DEFAULT ''"],
    ["agent_name", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (have.has(name)) continue;
    try {
      store().exec(`ALTER TABLE usage_event ADD COLUMN ${name} ${type}`);
    } catch {
      // 加不上就算了：这一列没有也不影响别的统计。
    }
  }
}

/** 记一条请求。 */
export function recordUsage(input: UsageEventInput): void {
  try {
    ensureTable();
    const ts = input.ts ?? Date.now();
    store()
      .prepare(
        "INSERT INTO usage_event (ts, day, hour, upstream_id, upstream_model, agent_model, " +
          "agent, session_id, parent_session_id, agent_name, client, ok, status, prompt_tokens, " +
          "completion_tokens, reasoning_tokens, latency_ms, error) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ts,
        localDay(ts),
        localHour(ts),
        input.upstreamId,
        input.upstreamModel,
        input.agentModel,
        input.agent,
        input.sessionId,
        input.parentSessionId,
        input.agentName,
        input.client,
        input.ok ? 1 : 0,
        input.status,
        input.promptTokens,
        input.completionTokens,
        input.reasoningTokens,
        input.latencyMs,
        input.error,
      );
  } catch {
    // 用量是记账，不是业务：写不进去也不能让请求失败。
  }
}

/** 怎么筛。 */
export interface UsageFilter {
  /** 哪个上游，空表示全部。 */
  upstreamId?: string;
  /** 模型，可以是上游的 id，也可以是客户端写的那个。 */
  model?: string;
  /** 从什么时候开始（含）。 */
  since?: number;
  /** 到什么时候为止（含）。 */
  until?: number;
  /** 只要某一天（本地时区）。 */
  day?: string;
  /** 最多几条，从新到旧。 */
  limit?: number;
  /** 游标：只给 id 比它小的。 */
  beforeId?: number;
}

/** 按条件取事件，从新到旧。 */
export function listUsage(filter: UsageFilter = {}): UsageEvent[] {
  ensureTable();
  const where: string[] = [];
  const args: any[] = [];
  if (filter.upstreamId) {
    where.push("upstream_id = ?");
    args.push(filter.upstreamId);
  }
  if (filter.model) {
    where.push("(upstream_model = ? OR agent_model = ?)");
    args.push(filter.model, filter.model);
  }
  if (filter.since !== undefined) {
    where.push("ts >= ?");
    args.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("ts <= ?");
    args.push(filter.until);
  }
  if (filter.day) {
    where.push("day = ?");
    args.push(filter.day);
  }
  if (filter.beforeId) {
    where.push("id < ?");
    args.push(filter.beforeId);
  }
  const sql =
    "SELECT id, ts, day, hour, upstream_id, upstream_model, agent_model, agent, " +
    "session_id, parent_session_id, agent_name, client, ok, status, prompt_tokens, " +
    "completion_tokens, reasoning_tokens, latency_ms, error " +
    `FROM usage_event${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`;
  const rows = store().prepare(sql).all(...args) as any[];
  const capped = filter.limit && filter.limit > 0 ? rows.slice(0, filter.limit) : rows;
  return capped.map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    day: String(r.day),
    hour: Number(r.hour),
    upstreamId: String(r.upstream_id),
    upstreamModel: String(r.upstream_model),
    agentModel: String(r.agent_model),
    agent: String(r.agent),
    sessionId: String(r.session_id ?? ""),
    parentSessionId: String(r.parent_session_id ?? ""),
    agentName: String(r.agent_name ?? ""),
    client: String(r.client),
    ok: Number(r.ok) !== 0,
    status: Number(r.status),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    latencyMs: Number(r.latency_ms),
    error: String(r.error ?? ""),
  }));
}

/**
 * 上游报的 usage，换成一个形状：总输入、总输出、推理。
 *
 * 两种方言的算法不一样：
 *
 *   OpenAI     prompt_tokens 就是全部输入（cached_tokens 是它的一部分）。
 *   Anthropic  input_tokens 只算没命中缓存的，缓存读到的和缓存写进去的
 *              另外两个字段里，要加起来才是全部输入。
 *
 * 少了这一步，MiniMax 的流式请求会记成 7 个输入令牌，而同一请求的非流式
 * 记成 204 —— 上游把输入拆成了两处报。
 */
export function usageTotals(usage: any): TokenTotals {
  const empty = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  if (!usage || typeof usage !== "object") return empty;
  const promptTokens =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : num(usage.input_tokens) +
        num(usage.cache_read_input_tokens) +
        num(usage.cache_creation_input_tokens);
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : num(usage.output_tokens);
  const reasoningTokens = num(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.thinking_tokens ??
      usage.reasoning_tokens,
  );
  return { promptTokens, completionTokens, reasoningTokens };
}

/** 一个数，不是数就当 0。 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 两份 usage 取大的那个。
 *
 * Anthropic 的流分几次报：输入在 message_start、输出在 message_delta。每份
 * 各自算成总数再取大的 —— 不能把两份的字段加起来，那会把同一批输入算两遍
 * （MiniMax 的 message_start 报 0、message_delta 报 7+197，两种口径）。
 */
export function maxTotals(a: TokenTotals | null, b: TokenTotals): TokenTotals {
  return {
    promptTokens: Math.max(a?.promptTokens ?? 0, b.promptTokens),
    completionTokens: Math.max(a?.completionTokens ?? 0, b.completionTokens),
    reasoningTokens: Math.max(a?.reasoningTokens ?? 0, b.reasoningTokens),
  };
}

/**
 * 丢掉太老的记录。
 *
 * 表是每条请求一行，不删就会一直长。默认留 90 天。
 */
export function pruneUsage(keepDays = 90): number {
  ensureTable();
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const result = store().prepare("DELETE FROM usage_event WHERE ts < ?").run(cutoff);
  return Number(result.changes ?? 0);
}

/** 把用量记录全清掉。 */
export function clearUsage(): void {
  ensureTable();
  store().exec("DELETE FROM usage_event");
}

/** 一段用量的合计。 */
export interface UsageTotals {
  requests: number;
  succeeded: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMsSum: number;
}

/** 只算令牌的合计（上游报的那些数）。 */
export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

/** 空的合计。 */
export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    latencyMsSum: 0,
  };
}

/** 把一条加进合计。 */
export function addToTotals(totals: UsageTotals, event: UsageEvent): void {
  totals.requests += 1;
  if (event.ok) totals.succeeded += 1;
  else totals.failed += 1;
  totals.promptTokens += event.promptTokens;
  totals.completionTokens += event.completionTokens;
  totals.reasoningTokens += event.reasoningTokens;
  totals.latencyMsSum += event.latencyMs;
}
