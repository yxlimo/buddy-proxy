// lib/session-refresh.ts — 换令牌的骨架。
//
// 从 lib/session.ts 拆出来：那边是会话的读写与死会话的记号，这边是「问平台
// 换一次令牌」那一整套 —— 锁、临期判定、超时、拒绝、写回、留痕。

import crypto from "node:crypto";
import { AuthError, authLog, tokenFingerprint } from "./credential.ts";
import { configNumber } from "./config.ts";
import { dataDir } from "./paths.ts";
import { deadSession, markSessionDead, withSessionLock, type SessionTokens } from "./session.ts";

/**
 * 问平台换一次令牌，最多花多久。
 *
 * 一个账号的平台卡住，不该把后面账号的令牌一起拖住 —— 那些账号是各自独立的
 * 登录态，谁也碰不到谁。
 */
const REFRESH_TIMEOUT_MS = configNumber("SESSION_REFRESH_TIMEOUT_MS", 30_000);

/**
 * 换令牌这件事的骨架。
 *
 * 三个平台换令牌的样子是一样的：判死、取会话、看临期、问平台、成了存回去、
 * 败了记下为什么。差的是问平台的那一下（地址、头、身子）、错误码怎么读、
 * 给操作者看的提示、答复怎么变成新会话、日志里叫什么。
 *
 * 那几样由各家自己出，骨架在这里。骨架里的每一步都是有讲究的，动之前先想
 * 清楚：
 *
 * - 平台拒过的会话不再问：问一次是同样的答复，白白浪费往返。
 * - 没到临期不换：令牌是一次性的，多换一次就多一次被平台当成重放的机会。
 * - 只有一处换令牌：定时器（lib/periodic.ts）。请求那一条路不换。
 * - 换令牌在会话锁里：取令牌、问平台、写回是一整段，同一份会话同一时刻只有
 *   一个持有者在换（跨进程，锁在数据库里）。
 */

/** 平台对换令牌的回答。 */
export interface RefreshAnswer {
  /** 成没成。 */
  ok: boolean;
  /** HTTP 状态码。 */
  status: number;
  /** 平台给的错误码（平台没给就自己写一个）。 */
  code: string;
  /** 平台的答复。 */
  body: any;
}

/** 一家平台换令牌要出的那几样。 */
export interface RefreshFlow<T extends SessionTokens> {
  /** 会话 id：记号与日志都用它。 */
  id: string;
  /** 现在这一份会话。 */
  load: () => T | null;
  /** 令牌离到期还有这么多毫秒以内就该换。 */
  bufferMs: number;
  /**
   * 问平台要新令牌。
   *
   * signal 是超时的闸：平台那边卡住时它会响，调用方就知道该收手了。
   */
  request: (session: T, signal: AbortSignal) => Promise<RefreshAnswer>;
  /** 平台的答复 → 新会话。 */
  parse: (body: any, session: T) => T;
  /** 平台拒了这份令牌吗（401/403/invalid_grant 那些）。 */
  refused: (answer: RefreshAnswer) => boolean;
  /** 拒了的时候给操作者看的话。 */
  hint: (code: string) => string;
  /**
   * 写回新会话。
   *
   * 返回 false 是「没写」（库里有一份更新的）：平台已经换过令牌了，这一份
   * 却没存下来 —— 那要记一笔告警，不能当成成功。
   */
  save: (session: T) => boolean | void;
  /** 日志里的名字。 */
  label: (session: T) => string;
  /** 没有会话时说给操作者听的话。 */
  noSession: string;
  /** 换过令牌：缓存里那份旧凭据作废。 */
  invalidate?: () => void;
  /** 成功之后日志里多说的那句（各家自己那点东西）。 */
  extra?: (session: T) => string;
  /** 这次刷新最多花多久（毫秒）。默认用全局的那个。 */
  timeoutMs?: number;
}

/**
 * 按骨架换一次令牌。
 *
 * 成了返回新会话；没到临期就原样返回现在这一份；平台拒了就把这份会话记成
 * 死的（记 30 分钟），并抛出 503。
 */
export async function refreshSessionFlow<T extends SessionTokens>(flow: RefreshFlow<T>): Promise<T> {
  // 1. 平台拒过这份会话：再问一次也是同样的答复，直接回答。
  //    记的时限会续：定时器每轮都问一次，于是「坏的」这个判断一直是新的。
  const dead = deadSession(flow.id);
  if (dead) {
    markSessionDead(flow.id, dead);
    throw new AuthError("session refused by the platform", dead, 503);
  }
  // 2. 先看一眼：没到临期就不换，也不用去拿锁。
  const glance = flow.load();
  if (!glance) {
    flow.invalidate?.();
    throw new AuthError("no session", flow.noSession, 503);
  }
  if (glance.expiresAtMs - Date.now() > flow.bufferMs) return glance;

  // 3. 到临期了：拿锁，取令牌 → 换令牌 → 写回 都在锁里。
  //
  // 锁是跨进程的（数据库里那张 locks 表）：同一份会话有第二个进程、或者同一
  // 进程里叠了第二次刷新，它们拿着同一张 refresh token 去换，平台会当成重放。
  // 锁的过期时间是刷新超时的两倍：持锁的那个还在等平台时，锁不能先过期。
  const timeoutMs = Math.max(1, flow.timeoutMs ?? REFRESH_TIMEOUT_MS);
  // 拿不到锁时 withSessionLock 交回库里现在那一份：另一个持有者正在换，这一
  // 轮不再重复换。
  return withSessionLock(flow.id, () => refreshLocked(flow, timeoutMs), {
    staleMs: 2 * timeoutMs + 5_000,
  });
}

/** 锁里的那一段：重新读会话、再判一次临期、问平台、存回去。 */
async function refreshLocked<T extends SessionTokens>(flow: RefreshFlow<T>, timeoutMs: number): Promise<T> {
  // 等锁的时候，前一个持有者可能已经拿同一张 refresh token 问过平台、被拒了：
  // 再问一次是同样的拒绝（还可能被当成重放）。进锁后再判一次死。
  const dead = deadSession(flow.id);
  if (dead) throw new AuthError("session refused by the platform", dead, 503);
  // 拿到锁之后重新读：等锁的时候，前一个持有者可能已经换好了。
  const session = flow.load();
  if (!session) {
    flow.invalidate?.();
    throw new AuthError("no session", flow.noSession, 503);
  }
  if (session.expiresAtMs - Date.now() > flow.bufferMs) return session;

  // 4. 问平台。挂个超时：一个账号的平台卡住，不该把后面账号的令牌一起拖住。
  //
  // 超时之后不重试：令牌是一次性的，平台可能已经换了令牌，再问一次就是重放，
  // 平台会把整份会话撤掉。定时器下一轮会再来一遍，那时候再说。
  // 自己拿一个闸，不用 AbortSignal.timeout：它那个定时器不占着事件循环，
  // 空闲的时候它可能根本不会响 —— 收手就收不成。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let answer: RefreshAnswer;
  try {
    answer = await flow.request(session, controller.signal);
  } catch (e) {
    if (controller.signal.aborted) {
      throw new AuthError(
        `refresh timed out after ${timeoutMs} ms`,
        `刷新超时（${Math.round(timeoutMs / 1000)} 秒），这一轮没成；定时器下一轮会再试。`,
        503,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  // 5. 平台拒了？
  if (!answer.ok) {
    flow.invalidate?.();
    authLog(
      dataDir(),
      `${flow.label(session)} refresh rejected`,
      `${answer.code} (HTTP ${answer.status}), body ${JSON.stringify(answer.body).slice(0, 300)}`,
    );
    if (flow.refused(answer)) {
      const hint = flow.hint(answer.code);
      // 别再拿这份会话去问平台了：每一次都是同样的拒绝。
      markSessionDead(flow.id, hint);
      throw new AuthError(`refresh rejected (${answer.code})`, hint, 503);
    }
    throw new AuthError(`refresh failed (${answer.code})`, `刷新失败（${answer.code}），稍后重试。`, 502);
  }

  // 6. 存新的。
  //
  // 平台答应了，就是已经换过令牌了：旧的 refresh token 作废。所以先把答复
  // 留个痕（只有形状与指纹，不是令牌本身），读不懂、存不下的时候，事后能
  // 看出来平台当时给了什么。
  authLog(dataDir(), `${flow.label(session)} refresh answered`, answerDigest(answer));
  let next: T;
  try {
    next = flow.parse(answer.body, session);
  } catch (e) {
    flow.invalidate?.();
    authLog(
      dataDir(),
      `${flow.label(session)} refresh answer unreadable`,
      `${(e as Error)?.message ?? e}; the platform has rotated the token, the new one is lost`,
    );
    throw new AuthError(
      "refresh answer unreadable",
      "平台换了令牌，但答复读不懂，新令牌没存下来；这份会话多半要重新登录。",
      502,
    );
  }
  // 账号在换令牌的途中被删了（会话那一行已经没了）：新会话没有主人，不写。
  // 这一问与 save 之间没有 await。
  if (!flow.load()) {
    flow.invalidate?.();
    authLog(dataDir(), `${flow.label(next)} refresh dropped`, "the session was deleted while the platform answered");
    throw new AuthError("session gone", flow.noSession, 503);
  }
  const saved = flow.save(next);
  flow.invalidate?.();
  if (saved === false) {
    authLog(
      dataDir(),
      `${flow.label(next)} refresh NOT SAVED`,
      `the store kept a newer session; this answer's access ${tokenFingerprint(next.accessToken)}, ` +
        `refresh ${tokenFingerprint(next.refreshToken)} was dropped`,
    );
    console.warn(`[AUTH] ${flow.label(next)}: 换来的令牌没有存下来（库里有一份更新的）`);
    return next;
  }
  authLog(
    dataDir(),
    `${flow.label(next)} refresh ok`,
    `generation ${next.generation ?? 1}, access ${tokenFingerprint(next.accessToken)}, ` +
      `refresh ${tokenFingerprint(next.refreshToken)}, ` +
      `${flow.extra ? `${flow.extra(next)}, ` : ""}` +
      `${Math.round(next.expiresAtMs / 1000 - Date.now() / 1000)}s left`,
  );
  return next;
}

/**
 * 平台答复的摘要：有哪些字段、每个值的指纹。令牌本身不进日志。
 *
 * 只看最外一层与 `data` 那一层（各家把令牌放在这两处之一）。
 */
function answerDigest(answer: RefreshAnswer): string {
  const describe = (value: unknown): string => {
    if (!value || typeof value !== "object") return typeof value;
    return Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => {
        if (typeof v === "string") return `${key}=${tokenFingerprint(v)}`;
        if (v && typeof v === "object" && !Array.isArray(v)) return `${key}={${describe(v)}}`;
        return `${key}=${JSON.stringify(v)?.slice(0, 40)}`;
      })
      .join(", ");
  };
  const raw = JSON.stringify(answer.body ?? null) ?? "";
  const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `HTTP ${answer.status}, ${raw.length} bytes #${hash}: ${describe(answer.body)}`;
}
