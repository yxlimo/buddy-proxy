// lib/qoder/benefits.ts — the daily campaign of the Qoder account.
//
// The activity service is the same service in both regions; only the host
// differs. The account's own token is enough to claim.

import {
  ENDPOINTS,
  loadSession as loadQoderSession,
  regionOf,
  type QoderRegion,
  type QoderSession,
} from "./auth.ts";
import type { BenefitOutcome } from "../benefits.ts";

interface ApiResult {
  status: number;
  body: any;
}

/**
 * 每个 campaign 最近一次试领过的窗口起点（秒）。
 *
 * 平台不按天重置 claimStatus：同一个 campaign 的 flag 会一直是 CLAIMED，
 * 所以不能拿它当「今天领过」的依据 —— 拿窗口起点比。窗口起点变了就是新的
 * 窗口期，值得再试一次。
 *
 * 进程重启最多多重试一次，平台会回 replayed: true，不会重复加积分。
 */
const claimedWindows = new Map<string, number>();

/**
 * 活动的地址。
 *
 * 取值放在函数里，不在模块这一层：auth.ts 与 kind 注册表之间有环，模块级常量
 * 会在 auth.ts 还没求值完的时候去读 ENDPOINTS，整个进程就起不来了。
 */
function claimBase(region: QoderRegion): string {
  return ENDPOINTS[region].openapi;
}

export function qoderClaimHeaders(session: QoderSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    "User-Agent": "Qoder/claim",
    // Without this one the server answers with an empty list of campaigns.
    "Cosy-ClientType": "10",
  };
  // No machine identity on purpose -- and the reason is not what it looks
  // like.
  //
  // Measured on 2026-10-24, same account, same request, 15 header sets:
  //
  //   the registered machine id, a made-up one, a real sgsdk blob, no
  //   machine headers at all, the full official shape
  //     -> the daily campaign is there in every one of them
  //   Cosy-ClientType 5 (the value the official CLI sends)
  //     -> the list comes back empty
  //   no Cosy-ClientType
  //     -> the list comes back empty
  //
  // So the client type is the switch, not the machine identity: the daily
  // campaign is a desktop-app promotion, and the desktop client type is the
  // one that gets it. The official CLI does not claim it through this API --
  // it shows the promotion in its own growth page instead.
  //
  // The machine identity is not sent because it makes no difference here and
  // a half-finished set of machine headers is what the risk service looks at
  // hardest. The identity itself is available if it is ever needed:
  // lib/qoder/sgsdk.ts can produce a real one (the official component, run
  // on this machine), it is just not used on this path.
  return headers;
}

async function qoderCall(
  session: QoderSession,
  path: string,
  method: "GET" | "POST",
  region: QoderRegion = "cn",
): Promise<ApiResult> {
  try {
    // A GET must not carry a body, so the option is only there for POST.
    const init: RequestInit = { method, headers: qoderClaimHeaders(session) };
    if (method === "POST") init.body = "";
    const res = await fetch(`${claimBase(region)}${path}`, init);
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { msg: (e as Error).message } };
  }
}

/**
 * 哪些活动该领。
 *
 * 平台用 claimStatus 说能不能领：CLAIMABLE 就是能领。actionType 说的是活动
 * 是什么（CLAIM_BENEFIT 是点一下领，VIEW_DETAILS 是打开详情页也发积分）——
 * 两种都能领，所以不能拿它当过滤器。
 *
 * 窗口是秒，不是毫秒。
 */
export function claimableCampaigns(rows: any[], nowSeconds: number): any[] {
  const out: any[] = [];
  for (const row of rows) {
    // The window check and the activity-type check live in one place.
    // Infinity means "no window was ever tried", so only CLAIMABLE rows
    // come out -- which is what this list means.
    if (shouldAttemptClaim(row, nowSeconds, Infinity)) out.push(row);
  }
  return out;
}

/**
 * 这条活动现在要不要发领取请求。
 *
 * 平台不按天重置 claimStatus（同一个 campaign 一直是 CLAIMED），所以窗口起点
 * 变了就要再试一次：上一个窗口领过不代表这个窗口领过。
 *
 * lastAttemptedWindowStart 是这条活动上一次试领时的窗口起点（秒）。0 表示
 * 还没试过。
 */
export function shouldAttemptClaim(
  row: any,
  nowSeconds: number,
  lastAttemptedWindowStart: number,
): boolean {
  // Not every activity grants something. These two do.
  if (row.actionType !== "CLAIM_BENEFIT" && row.actionType !== "VIEW_DETAILS") return false;
  const start = typeof row.startAt === "number" ? row.startAt : 0;
  const end = typeof row.endAt === "number" ? row.endAt : 0;
  // Outside its window the platform has nothing to give.
  if (start && nowSeconds < start) return false;
  if (end && nowSeconds >= end) return false;
  if (row.claimStatus === "CLAIMABLE") return true;
  // CLAIMED does not mean "claimed today" -- the flag survives the window.
  // A window we have not tried yet is worth one attempt; the platform answers
  // "replayed" if it was really taken already.
  if (row.claimStatus === "CLAIMED") return start > lastAttemptedWindowStart;
  return false;
}

/**
 * 发一次领取请求，把平台的话原样记下来。
 *
 * 领取的答复比活动本身说得更准：它说发了多少（或者是重放）。
 */
async function claimCampaign(
  session: QoderSession,
  row: any,
  region: QoderRegion,
  upstream: string,
): Promise<{ credits: number; lines: string[] }> {
  const lines: string[] = [];
  const key = String(row.campaignKey ?? row.campaignId);
  const claim = await qoderCall(
    session,
    `/sash/api/v1/me/campaigns/${row.campaignId}/claim`,
    "POST",
    region,
  );
  if (claim.status >= 200 && claim.status < 300) {
    const granted = claim.body?.benefit;
    const amount = Number(granted?.amount ?? row.benefit?.amount ?? 0);
    const kind = granted?.kind ?? row.benefit?.kind ?? "";
    if (claim.body?.replayed === true) {
      lines.push(`活动「${key}」已经领过了`);
      return { credits: 0, lines };
    }
    if (amount > 0) {
      lines.push(`领活动「${key}」+${amount} ${kind}`);
      console.log(`[BENEFITS] ${upstream}: claimed ${key} +${amount} ${kind}`);
      return { credits: amount, lines };
    }
    // Some campaigns grant nothing (a promo you only have to open). Claiming
    // them is still correct -- the platform says it can be claimed -- but
    // there is no credit to report.
    lines.push(`领活动「${key}」（没有积分）`);
    console.log(`[BENEFITS] ${upstream}: claimed ${key} (no credits)`);
    return { credits: 0, lines };
  }
  // The platform says why when it refuses. 503 RISK_DEPENDENCY_UNAVAILABLE
  // means it could not find the device behind the machine token, which is a
  // fingerprint problem and not a claim that ran out of time.
  const why =
    claim.body?.errorMessage ??
    claim.body?.msg ??
    claim.body?.message ??
    `HTTP ${claim.status}`;
  lines.push(`领活动「${key}」失败：${why}`);
  console.log(`[BENEFITS] ${upstream}: claim ${key} failed (HTTP ${claim.status}): ${why}`);
  return { credits: 0, lines };
}

/**
 * 把列表里的活动逐个处理：能领的发一次请求，不能领的说清楚为什么。
 *
 * 每个窗口期最多试一次：试过了就把窗口起点记下来，窗口起点变了才再试。
 */
async function claimAll(
  session: QoderSession,
  rows: any[],
  now: number,
  region: QoderRegion,
  upstream: string,
): Promise<{ credits: number; lines: string[] }> {
  const lines: string[] = [];
  let credits = 0;
  for (const row of rows) {
    if (row.actionType !== "CLAIM_BENEFIT" && row.actionType !== "VIEW_DETAILS") continue;
    const key = String(row.campaignKey ?? row.campaignId);
    const startAt = typeof row.startAt === "number" ? row.startAt : 0;
    const windowKey = `${upstream}:${key}`;
    const lastAttempted = claimedWindows.get(windowKey) ?? 0;
    if (!shouldAttemptClaim(row, now, lastAttempted)) {
      // Current behaviour: a campaign that is already claimed says so, and
      // anything else is skipped quietly.
      if (row.claimStatus === "CLAIMED") {
        lines.push(`活动「${key}」已领过`);
      }
      continue;
    }
    const outcome = await claimCampaign(session, row, region, upstream);
    // One attempt per window, no matter how the attempt went: a failed
    // attempt must not turn into a retry loop against the platform.
    claimedWindows.set(windowKey, startAt);
    credits += outcome.credits;
    lines.push(...outcome.lines);
  }
  return { credits, lines };
}

export async function runQoderBenefits(providerId = "qoder-cn"): Promise<BenefitOutcome> {
  // The provider id, not the region: the session lives under
  // `session:provider:<provider id>`, and the region comes from it.
  const region = regionOf(providerId);
  const upstream = providerId;
  const report: string[] = [];
  const session = loadQoderSession(providerId);
  if (!session) {
    return { upstream, ok: false, credits: 0, report: ["未找到 Qoder 登录态"], at: new Date().toISOString() };
  }
  let credits = 0;
  try {
    const campaigns = await qoderCall(session, "/sash/api/v1/me/campaigns", "GET", region);
    if (campaigns.status !== 200) {
      report.push(`查活动失败（HTTP ${campaigns.status}）`);
      return { upstream, ok: false, credits, report, at: new Date().toISOString() };
    }
    const rows: any[] = Array.isArray(campaigns.body?.campaigns) ? campaigns.body.campaigns : [];
    // The list is worth a line of its own: when the daily campaign is missing
    // from it there is nothing to claim, and that is invisible in the report
    // unless the campaigns are named.
    console.log(
      `[BENEFITS] ${upstream}: ${rows.length} campaign(s)` +
        (rows.length
          ? ` — ${rows.map((r: any) => `${r.campaignKey}:${r.claimStatus}`).join(", ")}`
          : ""),
    );
    // "No daily check-in activity" is a different thing from "already
    // claimed": the platform sometimes has no CLAIM_BENEFIT campaign at all
    // (the global region only carries VIEW_DETAILS ones), and saying
    // "claimed" there would claim a win that never happened. This line comes
    // first so it is not hidden behind the per-campaign lines.
    if (!rows.some((r: any) => r.actionType === "CLAIM_BENEFIT")) {
      report.push("平台没有每日签到活动（列表里没有 CLAIM_BENEFIT 活动）");
    }
    if (!rows.length) {
      report.push("无可领取的活动");
    }
    const now = Math.floor(Date.now() / 1000);
    const creditCampaigns = rows.filter(
      (r: any) => r.actionType === "CLAIM_BENEFIT" || r.actionType === "VIEW_DETAILS",
    ).length;
    const outcome = await claimAll(session, rows, now, region, upstream);
    credits += outcome.credits;
    report.push(...outcome.lines);
    if (!creditCampaigns) report.push("无可领取积分的活动");
  } catch (e) {
    report.push(`异常：${(e as Error).message}`);
  }
  return { upstream, ok: true, credits, report, at: new Date().toISOString() };
}
