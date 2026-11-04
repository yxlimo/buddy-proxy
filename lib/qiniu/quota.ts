// lib/qiniu/quota.ts — 七牛云的额度：门户上的资源包。
//
// 额度不在推理端点上：它在门户（portal.qiniu.com）上，而且门户只认会话
// cookie。推理用的那把 key 在这里没有用。
//
// 读不到额度不是错误 —— 推理不需要它。所以这里从不抛：拿不到就说清楚是哪一种
// 拿不到（凭据被拒 / 被限流 / 别的），由调用方翻成状态。「不知道」与「没钱」不是
// 一回事，路由要分得清。
//
// 状态码只在这里看得到：吞掉它就分不出「cookie 过期了」与「门户抽了一下」，那两种
// 在面板上是两件事。

import { QINIU_PORTAL_BASE, QINIU_RESPACK_PATH } from "./config.ts";

/** 一个资源包。 */
export interface QiniuRespack {
  itemCode: string;
  itemName: string;
  zoneName: string;
  /** 剩余量，单位见 unit。 */
  remaining: number;
  used: number;
  total: number;
  /** respack_unit，例如 "k/tokens"。 */
  unit: string;
  /** 平台最后更新这个包的时刻（Unix 毫秒）。 */
  updateTime: number;
}

/** 一个账号的额度。 */
export interface QiniuQuota {
  respacks: QiniuRespack[];
  at: number;
}

/** 门户不快，但也不该无限等。 */
const TIMEOUT_MS = 15_000;

/** 门户看浏览器的头。 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 把门户的回答读成一个个资源包。
 *
 * 门户的量都是字符串（"3000"），这里转成数字。数据不对就少几个包，不抛 ——
 * 额度是给人看的，坏了也不能把网关带崩。
 */
export function parseRespackOverview(body: unknown): QiniuRespack[] {
  if (!body || typeof body !== "object") return [];
  const envelope = body as Record<string, unknown>;
  // 门户的信封上带一个业务码：不是 200 就不是我们要的东西。
  if (envelope.code !== undefined && Number(envelope.code) !== 200) return [];
  const data = envelope.data as Record<string, unknown> | undefined;
  const records = data?.records;
  if (!Array.isArray(records)) return [];
  const out: QiniuRespack[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const itemCode = String(row.item_code ?? row.itemCode ?? "").trim();
    const itemName = String(row.item_name ?? row.itemName ?? "").trim();
    const zoneName = String(row.zone_name ?? row.zoneName ?? "").trim();
    // 名字与编号都没有的行不是一个包：认不出来就别报。
    if (!itemCode && !itemName) continue;
    out.push({
      itemCode,
      itemName,
      zoneName,
      total: numberOf(row.total_surplus),
      used: numberOf(row.month_used),
      remaining: numberOf(row.month_remain),
      unit: String(row.respack_unit ?? row.respackUnit ?? ""),
      // 平台报的是秒。
      updateTime: secondsToMs(row.update_time ?? row.updateTime),
    });
  }
  return out;
}

/**
 * 问门户的结果：拿到了，或者为什么没拿到。
 *
 * message 只写门户说了什么（状态码、业务码、异常的话），不带 cookie 或它的任何
 * 片段 —— 门户 cookie 等价于密码，它会进日志与面板。
 */
export type QiniuQuotaAnswer =
  | { ok: true; quota: QiniuQuota }
  | {
      ok: false;
      /** 凭据被拒 / 被限流 / 别的（网络、超时、解析、业务码）。 */
      reason: "unauthorized" | "rate_limited" | "unknown";
      /** HTTP 状态码；没发出去就是 0。 */
      status: number;
      message: string;
      /** 门户说了多久之后再来（毫秒）；没说就是 null。 */
      retryAfterMs: number | null;
    };

/**
 * 问门户要这个账号的资源包。
 *
 * endpointBase 是门户那一台的根：平台行把地址指到了别处时，调用方换成那一台
 * （主机名换掉，路径、请求头、超时都不动）。
 *
 * 不抛：每一种失败都是一种能说清楚的回答。日志不在这里记 —— 结论由调用方翻成
 * 状态，写日志是那一层的事（一处记，不两处各记一遍）。
 */
export async function fetchQiniuQuota(
  cookie: string,
  endpointBase: string = QINIU_PORTAL_BASE,
): Promise<QiniuQuotaAnswer> {
  const credential = String(cookie ?? "").trim();
  if (!credential) {
    return { ok: false, reason: "unknown", status: 0, message: "没有门户 cookie", retryAfterMs: null };
  }
  const url = new URL(`${QINIU_RESPACK_PATH}?page=1&page_size=10`, endpointBase).toString();
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: credential,
        Accept: "*/*",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { ok: false, reason: "unauthorized", status, message: `门户拒了这份 cookie（HTTP ${status}）`, retryAfterMs: null };
      }
      if (status === 429) {
        return {
          ok: false,
          reason: "rate_limited",
          status,
          message: "门户限流了（HTTP 429）",
          retryAfterMs: retryAfterOf(res),
        };
      }
      return { ok: false, reason: "unknown", status, message: `门户答了 HTTP ${status}`, retryAfterMs: null };
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return { ok: false, reason: "unknown", status: res.status, message: "门户的回答读不出来", retryAfterMs: null };
    }
    const code = (body as Record<string, unknown>).code;
    if (code !== undefined && Number(code) !== 200) {
      return {
        ok: false,
        reason: "unknown",
        status: res.status,
        message: `门户没有给额度（code ${String(code)}）`,
        retryAfterMs: null,
      };
    }
    const respacks = parseRespackOverview(body);
    if (!respacks.length) {
      return { ok: false, reason: "unknown", status: res.status, message: "门户没有给资源包", retryAfterMs: null };
    }
    return { ok: true, quota: { respacks, at: Date.now() } };
  } catch (e) {
    return {
      ok: false,
      reason: "unknown",
      status: 0,
      message: `门户没问到：${(e as Error)?.message ?? String(e)}`,
      retryAfterMs: null,
    };
  }
}

/**
 * 门户说多久之后再来。
 *
 * Retry-After 是秒；没有、或者读不成一个正数，就是「没说」。
 */
function retryAfterOf(res: Response): number | null {
  const seconds = Number(String(res.headers.get("retry-after") ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/** 门户的量是字符串，转成数字；认不出来就是 0。 */
function numberOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 平台报的是秒，这里换成毫秒。 */
function secondsToMs(value: unknown): number {
  const seconds = numberOf(value);
  return seconds ? Math.round(seconds * 1000) : 0;
}
