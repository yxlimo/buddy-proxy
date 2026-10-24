// lib/admin/usage.ts — 面板的用量：请求数、令牌数、每条请求的明细。
//
// 数据来自 lib/usage.ts 的请求级日志：每条走过的请求一行，记着时间、哪个
// 上游、哪个模型、成功还是失败、用了多少令牌。
//
// 时间窗按事件的落库时间筛，所以「今日」是今天真的发出去的请求数，不是把
// 一行的历史按最后一次使用时间摊到某一天。

import {
  addToTotals,
  emptyTotals,
  listUsage,
  localDay,
  type UsageEvent,
  type UsageTotals,
} from "../usage.ts";

export type { UsageEvent, UsageTotals };

/** 按某个维度分组的用量。 */
export interface UsageBucketView {
  key: string;
  summary: UsageTotals;
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

/**
 * 用量的合计与分组。
 *
 * 按上游、按模型、按天各一份。「今天」是从本地零点算起的一段，不是一天
 * （24 小时）—— 早上八点看「今天」，要的是零点到现在。
 */
export function usageSummary(
  upstreamId = "",
  window = "",
): {
  total: UsageTotals;
  byUpstream: UsageBucketView[];
  byModel: UsageBucketView[];
  byDay: UsageBucketView[];
  byAgent: UsageBucketView[];
  bySession: UsageBucketView[];
  byParentSession: UsageBucketView[];
} {
  const key = String(window ?? "").trim().toLowerCase();
  const filter: { upstreamId?: string; since?: number; until?: number } = {};
  if (upstreamId) filter.upstreamId = upstreamId;
  if (key === "today") {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    filter.since = midnight;
    filter.until = now.getTime();
  } else {
    const span = windowMs(key);
    if (span) filter.since = Date.now() - span;
  }

  const events = listUsage(filter);
  const total = emptyTotals();
  const upstreams = new Map<string, UsageTotals>();
  const models = new Map<string, UsageTotals>();
  const days = new Map<string, UsageTotals>();
  const agents = new Map<string, UsageTotals>();
  const sessions = new Map<string, UsageTotals>();
  const parentSessions = new Map<string, UsageTotals>();

  for (const event of events) {
    addToTotals(total, event);
    const up = upstreams.get(event.upstreamId) ?? emptyTotals();
    addToTotals(up, event);
    upstreams.set(event.upstreamId, up);
    // 按模型分组用上游认识的那个 id：那是真正花了令牌的那个模型。
    const model = models.get(event.upstreamModel) ?? emptyTotals();
    addToTotals(model, event);
    models.set(event.upstreamModel, model);
    const day = days.get(event.day) ?? emptyTotals();
    addToTotals(day, event);
    days.set(event.day, day);
    // 谁发来的：pi、opencode、dsh……
    const agent = agents.get(event.agent) ?? emptyTotals();
    addToTotals(agent, event);
    agents.set(event.agent, agent);
    // 会话：认不出来的算一档「未知」。
    const sessionKey = event.sessionId || "未知";
    const session = sessions.get(sessionKey) ?? emptyTotals();
    addToTotals(session, event);
    sessions.set(sessionKey, session);
    // 父会话：空的就是主代理。
    const parentKey = event.parentSessionId || "主代理";
    const parent = parentSessions.get(parentKey) ?? emptyTotals();
    addToTotals(parent, event);
    parentSessions.set(parentKey, parent);
  }

  // 从大到小：令牌多的排前面。天数那一份按日期排 —— 它是一条时间线。
  const byTokens = (a: UsageBucketView, b: UsageBucketView): number => {
    const at = Number(a.summary?.promptTokens ?? 0n) + Number(a.summary?.completionTokens ?? 0n);
    const bt = Number(b.summary?.promptTokens ?? 0n) + Number(b.summary?.completionTokens ?? 0n);
    if (bt !== at) return bt - at;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  const byUpstream = [...upstreams.entries()]
    .map(([key, summary]) => ({ key, summary }))
    .sort(byTokens);
  const byModel = [...models.entries()]
    .map(([key, summary]) => ({ key, summary }))
    .sort(byTokens);
  const byDay = [...days.entries()]
    .map(([key, summary]) => ({ key, summary }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const byAgent = [...agents.entries()]
    .map(([key, summary]) => ({ key, summary }))
    .sort(byTokens);
  const bySession = [...sessions.entries()]
    .map(([key, summary]) => ({ key, summary }))
    .sort(byTokens);
  const byParentSession = [...parentSessions.entries()]
    .map(([key, summary]) => ({ key, summary }))
    .sort(byTokens);
  return { total, byUpstream, byModel, byDay, byAgent, bySession, byParentSession };
}

/** 用量的明细：每条请求一行。 */
export function usageEvents(
  upstreamId = "",
  model = "",
  limit = 0,
  beforeId = 0,
  window = "",
): UsageEvent[] {
  const key = String(window ?? "").trim().toLowerCase();
  const filter: Parameters<typeof listUsage>[0] = {
    upstreamId: upstreamId || undefined,
    model: model || undefined,
    limit: limit > 0 ? limit : undefined,
    beforeId: beforeId > 0 ? beforeId : undefined,
  };
  if (key === "today") {
    const now = new Date();
    filter.since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  } else {
    const span = windowMs(key);
    if (span) filter.since = Date.now() - span;
  }
  return listUsage(filter);
}

/** 今天（本地时区）的键。 */
export function todayKey(): string {
  return localDay(Date.now());
}
