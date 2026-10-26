// lib/upstream-session.ts — 客户端的会话 id → 上游的会话 id。
//
// 客户端给的会话 id 什么样都有：pi 给裸 UUID，opencode 给 `ses_xxx`，别的
// 客户端给什么都可能，UUID 的版本也不一样。官方客户端发的是它自己的会话 id，
// 形状固定：`session_` + 32 位小写 hex（桌面端 model IO 里的真值，如
// `session_37e3b015e79c2c05045cacd79a105500`）。
//
// 所以这里**不解析、不区分**：客户端给什么字符串，就映射成一个我们自己生成
// 的、形状固定的 id。同一个客户端会话永远映射到同一个 id —— 落库，重启也在。
//
// 查的顺序：内存缓存 → 数据库 → 生成。缓存只是快路，库才是真的。

import crypto from "node:crypto";
import { store } from "./store.ts";

/** 缓存里最多留多少条。超了就挤掉最老的一条（库里有，不会丢）。 */
const CACHE_MAX = 1000;

/** 官方客户端的会话 id 形状。 */
const SESSION_ID_RE = /^session_[0-9a-f]{32}$/;

/** 内存缓存：key 是「上游\\n客户端会话 id」。 */
const cache = new Map<string, string>();

/**
 * 把任意已存的会话 id 归一成官方形状。
 *
 * 早先存的是裸 UUID；那些行不需要重写就能用（UUID 去掉横线就是 32 位 hex）。
 * 对不上的（任意字符串）用 sha256 派生 —— 确定性，同一个值永远同一个 id。
 */
function normalizeUpstreamSessionId(stored: string): string {
  if (SESSION_ID_RE.test(stored)) return stored;
  const hex = stored.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) return `session_${hex}`;
  return `session_${crypto.createHash("sha256").update(stored).digest("hex").slice(0, 32)}`;
}

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
    const normalized = normalizeUpstreamSessionId(row.session_id);
    if (normalized !== row.session_id) {
      // 旧行是裸 UUID：顺手改成官方形状，以后读到的就是对的。
      store()
        .prepare("UPDATE session_map SET session_id = ? WHERE upstream = ? AND client_session_id = ?")
        .run(normalized, upstream, client);
    }
    remember(key, normalized);
    return normalized;
  }

  // 没有就生成一个，形状跟官方桌面端一样：`session_` + 32 位 hex。
  const created = `session_${crypto.randomBytes(16).toString("hex")}`;
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
  const sessionId = normalizeUpstreamSessionId(winner?.session_id ?? created);
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
