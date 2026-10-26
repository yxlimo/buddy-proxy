// lib/upstream-session.ts — 客户端的会话 id → 上游的会话 id。
//
// 客户端给的会话 id 什么样都有：pi 给裸 UUID，opencode 给 `ses_xxx`，别的
// 客户端给什么都可能，UUID 的版本也不一样。官方客户端发的是它自己的会话 id
// （剥掉内部前缀之后），所以那边的形状是固定的：主会话是裸 UUID。
//
// 所以这里**不解析、不区分**：客户端给什么字符串，就映射成一个我们自己生成
// 的、形状固定的 id。同一个客户端会话永远映射到同一个 id —— 落库，重启也在。
//
// 查的顺序：内存缓存 → 数据库 → 生成。缓存只是快路，库才是真的。

import crypto from "node:crypto";
import { store } from "./store.ts";

/** 缓存里最多留多少条。超了就挤掉最老的一条（库里有，不会丢）。 */
const CACHE_MAX = 1000;

/** 内存缓存：key 是「上游\\n客户端会话 id」。 */
const cache = new Map<string, string>();

/**
 * 客户端的会话 id 对应的上游会话 id。
 *
 * 客户端没给会话 id 就返回空：官方这时候也不发那个头（它的
 * `normalizeModelSessionIdForAttribution` 返回 undefined，头就省了）。
 */
export function upstreamSessionId(upstream: string, clientSessionId: string): string {
  const client = String(clientSessionId ?? "").trim();
  if (!client) return "";
  const key = `${upstream}\n${client}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const row = store()
    .prepare("SELECT session_id FROM session_map WHERE upstream = ? AND client_session_id = ?")
    .get(upstream, client) as { session_id?: string } | undefined;
  if (row?.session_id) {
    remember(key, row.session_id);
    return row.session_id;
  }

  // 没有就生成一个。UUID v4，跟官方客户端用的是同一种（crypto.randomUUID）。
  const created = crypto.randomUUID();
  // 并发时两个请求可能同时走到这里：先写的赢，后来的忽略它、再读回来，
  // 所以同一个客户端会话只会对应一个上游会话 id。
  store()
    .prepare(
      "INSERT OR IGNORE INTO session_map (upstream, client_session_id, session_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(upstream, client, created, Date.now());
  const winner = store()
    .prepare("SELECT session_id FROM session_map WHERE upstream = ? AND client_session_id = ?")
    .get(upstream, client) as { session_id?: string } | undefined;
  const sessionId = winner?.session_id ?? created;
  remember(key, sessionId);
  return sessionId;
}

/** 记住一条。满了就挤掉最老的。 */
function remember(key: string, sessionId: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, sessionId);
}

/** 测试用：把缓存清掉（库里的还在）。 */
export function clearUpstreamSessionCache(): void {
  cache.clear();
}
