// lib/qoder/benefits.ts — the daily campaign of the Qoder account.
//
// The activity service is the same service in both regions; only the host
// differs. The account's own token is enough to claim.

import os from "node:os";
import {
  ENDPOINTS,
  loadSession as loadQoderSession,
  type QoderRegion,
  type QoderSession,
} from "./auth.ts";
import type { BenefitOutcome } from "../benefits.ts";

interface ApiResult {
  status: number;
  body: any;
}

const QODER_CLAIM_BASE: Record<QoderRegion, string> = {
  cn: ENDPOINTS.cn.openapi,
  global: ENDPOINTS.global.openapi,
};

function qoderClaimHeaders(session: QoderSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    "User-Agent": "Qoder/claim",
    // Without this one the server answers with an empty list of campaigns.
    "Cosy-ClientType": "10",
  };
  // The machine identity the account registered with, not the derived one.
  //
  // The token is not checked against anything: the real client generates an
  // encrypted blob (the Alibaba sgsdk component, 66 bytes starting with
  // 3f 58 00) and the server never issues one, while the tokens here are
  // plain UUIDs. So the platform cannot tell a real token from a made-up
  // one — it can only tell whether the token was uploaded in the device flow
  // (`/device/selectAccounts?...machine_token=…`), which is the one place a
  // device is registered. The session holds exactly that, so that is what
  // goes out.
  //
  // Two headers that are always wrong are worth more than a right one: a
  // half-finished set of machine headers is what the risk service looks at
  // hardest. When the session has no registered identity, send none of them.
  //
  // When the account has no credit left, the daily campaign is left out of
  // the list and claiming it by id answers 503 RISK_DEPENDENCY_UNAVAILABLE.
  // That is the account's balance, not the identity: /health says so in the
  // credits, and the check-in cannot fix it.
  if (session.machineId) headers["Cosy-MachineId"] = session.machineId;
  if (session.machineToken) headers["Cosy-MachineToken"] = session.machineToken;
  if (session.machineType) headers["Cosy-MachineType"] = session.machineType;
  headers["Cosy-MachineOS"] = `${os.arch()}_linux`;
  headers["Cosy-MachineHostname"] = os.hostname();
  return headers;
}

async function qoderCall(
  session: QoderSession,
  path: string,
  method: "GET" | "POST",
  region: QoderRegion = "cn",
): Promise<ApiResult> {
  try {
    const res = await fetch(`${QODER_CLAIM_BASE[region]}${path}`, {
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

export async function runQoderBenefits(region: QoderRegion = "cn"): Promise<BenefitOutcome> {
  const upstream = region === "cn" ? "qoder-cn" : "qoder-global";
  const report: string[] = [];
  const session = loadQoderSession(region);
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
    for (const row of rows) {
      if (row.actionType !== "CLAIM_BENEFIT") continue;
      creditCampaigns += 1;
      // The window is in seconds, not milliseconds.
      const start = typeof row.startAt === "number" ? row.startAt : 0;
      const end = typeof row.endAt === "number" ? row.endAt : 0;
      if (start && now < start) continue;
      if (end && now >= end) continue;
      if (row.claimStatus === "CLAIMED") {
        report.push(`活动「${row.campaignKey ?? row.campaignId}」已领过`);
        continue;
      }
      if (row.claimStatus !== "CLAIMABLE") continue;
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
        } else {
          credits += amount;
          report.push(`领活动「${row.campaignKey ?? row.campaignId}」+${amount} ${kind}`);
          console.log(`[BENEFITS] ${upstream}: claimed ${row.campaignKey} +${amount} ${kind}`);
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
