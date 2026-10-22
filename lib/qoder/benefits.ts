// lib/qoder/benefits.ts — the daily campaign of the Qoder account.
//
// The activity service is the same service in both regions; only the host
// differs. The account's own token is enough to claim.

import os from "node:os";
import {
  ENDPOINTS,
  deviceIdentity,
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
  // The machine identity the desktop app sends along; the server is happier
  // with a request that looks like the app's. It is the account's own
  // fingerprint, so it never links two accounts.
  const identity = deviceIdentity("cn");
  if (identity) {
    headers["Cosy-MachineId"] = identity.machineId;
    headers["Cosy-MachineToken"] = identity.machineToken;
    headers["Cosy-MachineType"] = identity.machineType;
    headers["Cosy-MachineCode"] = identity.machineCode;
  }
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
    return { upstream, ok: false, credits: 0, report: ["没有 Qoder 登录态"], at: new Date().toISOString() };
  }
  let credits = 0;
  try {
    const campaigns = await qoderCall(session, "/sash/api/v1/me/campaigns", "GET", region);
    if (campaigns.status !== 200) {
      report.push(`查活动失败（HTTP ${campaigns.status}）`);
      return { upstream, ok: false, credits, report, at: new Date().toISOString() };
    }
    const rows: any[] = Array.isArray(campaigns.body?.campaigns) ? campaigns.body.campaigns : [];
    if (!rows.length) {
      report.push("没有可领的活动");
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
        }
      } else {
        report.push(`领活动「${row.campaignKey ?? row.campaignId}」失败：${claim.body?.msg ?? `HTTP ${claim.status}`}`);
      }
    }
    if (!creditCampaigns) report.push("没有可领积分的活动");
  } catch (e) {
    report.push(`异常：${(e as Error).message}`);
  }
  return { upstream, ok: true, credits, report, at: new Date().toISOString() };
}
