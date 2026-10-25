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
    const res = await fetch(`${claimBase(region)}${path}`, {
      method,
      headers: qoderClaimHeaders(session),
      body: method === "POST" ? "" : undefined,
    });
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
    // Not every activity grants something. These two do.
    if (row.actionType !== "CLAIM_BENEFIT" && row.actionType !== "VIEW_DETAILS") continue;
    if (row.claimStatus !== "CLAIMABLE") continue;
    const start = typeof row.startAt === "number" ? row.startAt : 0;
    const end = typeof row.endAt === "number" ? row.endAt : 0;
    if (start && nowSeconds < start) continue;
    if (end && nowSeconds >= end) continue;
    out.push(row);
  }
  return out;
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
    if (!rows.length) {
      report.push("无可领取的活动");
    }
    const now = Math.floor(Date.now() / 1000);
    let claimable = 0;
    let creditCampaigns = 0;
    // One rule for what to claim: the helper has it, the loop asks it.
    const claimableIds = new Set(
      claimableCampaigns(rows, now).map((r: any) => String(r.campaignKey ?? r.campaignId)),
    );
    for (const row of rows) {
      if (row.actionType !== "CLAIM_BENEFIT" && row.actionType !== "VIEW_DETAILS") continue;
      creditCampaigns += 1;
      const key = String(row.campaignKey ?? row.campaignId);
      if (row.claimStatus === "CLAIMED") {
        report.push(`活动「${key}」已领过`);
        continue;
      }
      if (!claimableIds.has(key)) continue;
      claimable += 1;
      const claim = await qoderCall(
        session,
        `/sash/api/v1/me/campaigns/${row.campaignId}/claim`,
        "POST",
        region,
      );
      if (claim.status >= 200 && claim.status < 300) {
        // The answer says what was granted, which is more than what the
        // campaign offered. A replay means it was granted before and nothing
        // arrives now, so it is not counted.
        const granted = claim.body?.benefit;
        const amount = Number(granted?.amount ?? row.benefit?.amount ?? 0);
        const kind = granted?.kind ?? row.benefit?.kind ?? "";
        if (claim.body?.replayed === true) {
          report.push(`活动「${row.campaignKey ?? row.campaignId}」已经领过了`);
        } else if (amount > 0) {
          credits += amount;
          report.push(`领活动「${row.campaignKey ?? row.campaignId}」+${amount} ${kind}`);
          console.log(`[BENEFITS] ${upstream}: claimed ${row.campaignKey} +${amount} ${kind}`);
        } else {
          // Some campaigns grant nothing (a promo you only have to open).
          // Claiming them is still correct — the platform says it can be
          // claimed — but there is no credit to report.
          report.push(`领活动「${row.campaignKey ?? row.campaignId}」（没有积分）`);
          console.log(`[BENEFITS] ${upstream}: claimed ${row.campaignKey} (no credits)`);
        }
      } else {
        // The platform says why when it refuses. 503 RISK_DEPENDENCY_UNAVAILABLE
        // means it could not find the device behind the machine token, which is
        // a fingerprint problem and not a claim that ran out of time.
        const why =
          claim.body?.errorMessage ??
          claim.body?.msg ??
          claim.body?.message ??
          `HTTP ${claim.status}`;
        report.push(`领活动「${row.campaignKey ?? row.campaignId}」失败：${why}`);
        console.log(`[BENEFITS] ${upstream}: claim ${row.campaignKey} failed (HTTP ${claim.status}): ${why}`);
      }
    }
    if (!creditCampaigns) report.push("无可领取积分的活动");
  } catch (e) {
    report.push(`异常：${(e as Error).message}`);
  }
  return { upstream, ok: true, credits, report, at: new Date().toISOString() };
}
