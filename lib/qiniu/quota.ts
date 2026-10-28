// lib/qiniu/quota.ts — 七牛云的额度：门户上的资源包。
//
// 额度不在推理端点上：它在门户（portal.qiniu.com）上，而且门户只认会话
// cookie。推理用的那把 key 在这里没有用。
//
// 读不到额度不是错误 —— 推理不需要它。所以这里返回 null（不知道），不抛：
// 「不知道」与「没钱」不是一回事，路由要分得清。

import { QINIU_PORTAL_BASE, QINIU_RESPACK_PATH } from "./config.ts";
import { qiniuPortalCookie } from "./account.ts";

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
 * 问门户要这个账号的资源包。
 *
 * 拿不到就 null（不知道），并记一行日志。额度是给人看的，读不到不影响推理。
 */
export async function fetchQiniuQuota(cookie: string): Promise<QiniuQuota | null> {
  if (!cookie) return null;
  const url = `${QINIU_PORTAL_BASE}${QINIU_RESPACK_PATH}?page=1&page_size=10`;
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: cookie,
        Accept: "*/*",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[QINIU] 额度查询失败（HTTP ${res.status}）`);
      return null;
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") {
      console.warn("[QINIU] 额度查询的回答读不出来");
      return null;
    }
    const code = (body as Record<string, unknown>).code;
    if (code !== undefined && Number(code) !== 200) {
      console.warn(`[QINIU] 门户没有给额度（code ${String(code)}）`);
      return null;
    }
    const respacks = parseRespackOverview(body);
    if (!respacks.length) {
      console.warn("[QINIU] 门户没有给资源包");
      return null;
    }
    return { respacks, at: Date.now() };
  } catch (e) {
    console.warn(`[QINIU] 额度查询失败：${(e as Error)?.message}`);
    return null;
  }
}

/**
 * 这个账号的额度（去门户问）。
 *
 * 没有门户 cookie 就问不了：那是「不知道」，不是「没有资源包」。
 */
export async function qiniuQuotaOf(providerId: string): Promise<QiniuQuota | null> {
  const cookie = qiniuPortalCookie(providerId);
  if (!cookie) return null;
  return fetchQiniuQuota(cookie);
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
