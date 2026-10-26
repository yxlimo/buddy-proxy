// lib/zcode/credits.ts — ZCode 的额度。
//
// Start Plan 的额度是一个接口：
//
//   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<版本>
//
// 头是 Authorization: Bearer <zcode JWT>。
//
// 答复的信封是 {code, msg, data:{server_time, plans[], balances[]}}，
// balances[] 每项是一个额度桶：meter、unit_type、capabilities（哪些模型能用
// 这个桶）、total_units、used_units、remaining_units、period_start/end。
//
// 依据：docs/zcode/FINDINGS.md §9。

import { ZCODE_BASE, ZCODE_VERSION, loadSession } from "./auth.ts";
import { zcodePlatformHeaders } from "./transport.ts";

export interface ZcodeBucket {
  /** 桶的名字。 */
  showName: string;
  /** 计量方式：token 之类。 */
  meter: string;
  /** 单位类型。 */
  unitType: string;
  /** 这个桶适用哪些模型（`model:GLM-5.3-Flash` 这样）。 */
  capabilities: string[];
  total: number;
  used: number;
  remaining: number;
  periodStart: string | null;
  periodEnd: string | null;
  expiresAt: string | null;
}

export interface ZcodeQuota {
  /** 额度桶。 */
  buckets: ZcodeBucket[];
  /** 平台说的服务器时间。 */
  serverTime: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 平台给的是 unix 秒，别的模块按 ISO 字符串收。
 *
 * 直接 Date.parse 一个数字串会得到 NaN（它不认 unix 时间），到后面
 * BigInt(NaN) 就炸了。
 */
function isoFromSeconds(value: unknown): string | null {
  const seconds = num(value);
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 读额度。没有登录态就没有额度。 */
export async function fetchZcodeQuota(providerId = "zcode"): Promise<ZcodeQuota | null> {
  const session = loadSession(providerId);
  if (!session) return null;
  try {
    const r = await fetch(
      `${ZCODE_BASE}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(ZCODE_VERSION)}`,
      {
        headers: {
          ...zcodePlatformHeaders(session),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!r.ok) return null;
    const body: any = await r.json().catch(() => null);
    if (!body || body?.code !== 0) return null;
    const data = body?.data ?? {};
    const buckets = (Array.isArray(data.balances) ? data.balances : []).map((row: any) => ({
      showName: String(row?.show_name ?? ""),
      meter: String(row?.meter ?? ""),
      unitType: String(row?.unit_type ?? ""),
      capabilities: (Array.isArray(row?.capabilities) ? row.capabilities : []).map((c: any) => String(c)),
      total: num(row?.total_units),
      used: num(row?.used_units),
      remaining: num(row?.remaining_units ?? row?.available_units),
      periodStart: isoFromSeconds(row?.period_start),
      periodEnd: isoFromSeconds(row?.period_end),
      expiresAt: isoFromSeconds(row?.expires_at),
    }));
    return { buckets, serverTime: data?.server_time ?? null };
  } catch {
    return null;
  }
}

/** 额度，问一次就缓存几分钟 —— 面板不该把平台问烦了。 */
export async function zcodeQuota(maxAgeMs = 300_000, providerId = "zcode"): Promise<ZcodeQuota | null> {
  const cached = caches.get(providerId);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.quota;
  const quota = await fetchZcodeQuota(providerId);
  caches.set(providerId, { at: Date.now(), quota });
  return quota;
}

/** The quota of each provider, cached separately: they are different accounts. */
const caches = new Map<string, { at: number; quota: ZcodeQuota | null }>();
