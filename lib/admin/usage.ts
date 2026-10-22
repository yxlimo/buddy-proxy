// lib/admin/usage.ts — 用量：现在只有聚合表，没有逐条事件。
//
// 原始的用量事件还没有落库（那是另外一轮的事），所以面板看到的用量是从
// aggregate_usage 聚合出来的：每个「公布的模型 × 上游 × 上游模型」一行，
// 记着请求数、成功数、失败数和 token 数。
//
// 明细先给这张表里的行：每一行算一条事件，时间是它最后一次被用到的时间。
// 所以「明细」是聚合过的，不是真的逐请求记录 —— 这一点面板要知道。

import { listAggregateUsage, type AggregateUsage } from "../aggregate.ts";

/** 一段用量的合计。 */
export interface UsageSummaryView {
  requests: number;
  succeeded: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMsSum: number;
}

/** 按某个维度分组的用量。 */
export interface UsageBucketView {
  key: string;
  summary: UsageSummaryView;
}

/** 一条用量事件（现在是聚合表的一行）。 */
export interface UsageEventView {
  id: number;
  ts: number;
  upstreamId: string;
  model: string;
  agentModel: string;
  dialect: string;
  /** 这次请求模拟的是哪个桌面客户端。 */
  client: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  status: string;
  error: string;
}

/** 空白的合计。 */
function emptySummary(): UsageSummaryView {
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

/** 把一行累加进合计。 */
function add(summary: UsageSummaryView, row: AggregateUsage): void {
  summary.requests += row.requests;
  summary.succeeded += row.succeeded;
  summary.failed += row.failed;
  summary.promptTokens += row.promptTokens;
  summary.completionTokens += row.completionTokens;
}

/** 窗口有多长（毫秒）。空的是全部。 */
function windowMs(window: string): number {
  const key = String(window ?? "").trim().toLowerCase();
  if (!key || key === "all" || key === "total") return 0;
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  switch (key) {
    case "hour":
    case "1h":
      return hour;
    case "day":
    case "24h":
    case "1d":
      return day;
    case "week":
    case "7d":
      return 7 * day;
    case "month":
    case "30d":
      return 30 * day;
  }
  const m = /^(\d+)([hdw])$/.exec(key);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "h") return n * hour;
    if (m[2] === "d") return n * day;
    return n * 7 * day;
  }
  return 0;
}

/** 一天的键：本地时区的年月日。 */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 筛选过的聚合行。 */
function rows(upstreamId = "", window = ""): AggregateUsage[] {
  const all = listAggregateUsage();
  const span = windowMs(window);
  const since = span ? Date.now() - span : 0;
  return all.filter((row) => {
    if (upstreamId && row.group !== upstreamId) return false;
    // 聚合表只记着最后一次用到的时间，所以窗口是按它筛的：窗口之前用过的
    // 请求算在窗口之外。这是这张表能给的最好的答案。
    if (since && row.lastUsedAt < since) return false;
    return true;
  });
}

/**
 * 用量的合计与分组。
 *
 * 按上游、按模型、按天各一份。表里没有逐条记录，所以按天的那份是按每一行
 * 最后一次用到的时间归的，不是真正的逐日曲线。
 */
export function usageSummary(
  upstreamId = "",
  window = "",
): { total: UsageSummaryView; byUpstream: UsageBucketView[]; byModel: UsageBucketView[]; byDay: UsageBucketView[] } {
  const picked = rows(upstreamId, window);
  const total = emptySummary();
  const upstreams = new Map<string, UsageSummaryView>();
  const models = new Map<string, UsageSummaryView>();
  const days = new Map<string, UsageSummaryView>();

  for (const row of picked) {
    add(total, row);
    const up = upstreams.get(row.group) ?? emptySummary();
    add(up, row);
    upstreams.set(row.group, up);
    const model = models.get(row.modelId) ?? emptySummary();
    add(model, row);
    models.set(row.modelId, model);
    const day = dayKey(row.lastUsedAt || 0);
    const bucket = days.get(day) ?? emptySummary();
    add(bucket, row);
    days.set(day, bucket);
  }

  const byUpstream = [...upstreams.entries()].map(([key, summary]) => ({ key, summary }));
  const byModel = [...models.entries()].map(([key, summary]) => ({ key, summary }));
  const byDay = [...days.entries()].map(([key, summary]) => ({ key, summary })).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { total, byUpstream, byModel, byDay };
}

/**
 * 用量的明细。
 *
 * 现在是聚合表里的行：一行一个「公布的模型 × 上游模型」。
 *
 * id 是**按最后一次使用的时间排出来的序号**，不是数据库的自增 id（聚合表
 * 本来就没有自增 id）：越早用的 id 越小。所以游标（before_id）就是
 * 「只返回 id 比它小的」—— 拿上一页最小的那条 id 当游标，下一页就是更早的
 * 那些，不重不漏。表里的行变了，序号也会跟着变 —— 这是聚合表能给的最好
 * 答案。
 */
export function usageEvents(upstreamId = "", model = "", limit = 0, beforeId = 0): UsageEventView[] {
  const picked = rows(upstreamId, "");
  const filtered = picked.filter((row) => {
    if (!model) return true;
    // 模型可以按公布的 id 筛，也可以按上游的 id 筛。
    return row.modelId === model || row.upstreamModel === model;
  });
  // 序号按时间往上排：早的 id 小。
  const sorted = [...filtered].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const numbered = sorted.map((row, index) => ({ row, id: index + 1 }));
  const cursor = Number(beforeId) || 0;
  const older = cursor > 0 ? numbered.filter((n) => n.id < cursor) : numbered;
  // 取最新的几条，答复按新的在前。
  const capped = limit > 0 ? older.slice(Math.max(older.length - limit, 0)) : older;
  return capped
    .slice()
    .reverse()
    .map(({ row, id }) => ({
      id,
      ts: row.lastUsedAt,
      upstreamId: row.group,
      model: row.upstreamModel,
      agentModel: row.modelId,
      dialect: "",
      // 模拟的是哪个桌面客户端：用量是聚合出来的，没有逐请求的记录，这一栏
      // 现在拿不到。真的记下来要另做一轮（usage_event 表）。
      client: "",
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      reasoningTokens: 0,
      latencyMs: 0,
      status: row.failed > 0 && row.succeeded === 0 ? "failed" : "ok",
      error: "",
    }));
}
