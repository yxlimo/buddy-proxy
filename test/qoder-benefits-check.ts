// test/qoder-benefits-check.ts — Qoder 的每日活动。
//
//   node --experimental-strip-types test/qoder-benefits-check.ts
//
// 两个坑，都是实打实漏过积分的：
//
//   1. 机器身份的头会让平台把每日活动藏起来（不带头才看得见）。
//   2. 活动的 actionType 不是过滤器：global 区的每日活动是 VIEW_DETAILS，
//      一样能领，一样发积分。

import { claimableCampaigns, qoderClaimHeaders } from "../lib/qoder/benefits.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("请求头");

const headers = qoderClaimHeaders({
  accessToken: "tok",
  machineId: "mid",
  machineToken: "mtok",
  machineType: "mtype",
} as any);
const machineHeaders = Object.keys(headers).filter((k) => k.toLowerCase().startsWith("cosy-machine"));
check("不发机器身份的头", machineHeaders.length === 0, JSON.stringify(machineHeaders));
check("留了 Cosy-ClientType", headers["Cosy-ClientType"] === "10");
check("留了 User-Agent", !!headers["User-Agent"]);

console.log("");
console.log("该领哪些");

const now = 1_700_000_000;
const rows = [
  // 每日活动（global 区是 VIEW_DETAILS，一样能领）
  { campaignKey: "act-daily", claimStatus: "CLAIMABLE", actionType: "VIEW_DETAILS", startAt: now - 10, endAt: now + 10 },
  { campaignKey: "act-benefit", claimStatus: "CLAIMABLE", actionType: "CLAIM_BENEFIT", startAt: now - 10, endAt: now + 10 },
  // 领过的、没开始的、结束的，都不领
  { campaignKey: "act-claimed", claimStatus: "CLAIMED", actionType: "CLAIM_BENEFIT", startAt: now - 10, endAt: now + 10 },
  { campaignKey: "act-later", claimStatus: "CLAIMABLE", actionType: "CLAIM_BENEFIT", startAt: now + 10, endAt: now + 20 },
  { campaignKey: "act-over", claimStatus: "CLAIMABLE", actionType: "CLAIM_BENEFIT", startAt: now - 20, endAt: now - 1 },
  // 别的动作类型：不是发积分的活动，不领
  { campaignKey: "act-invite", claimStatus: "CLAIMABLE", actionType: "INVITE_FRIENDS", startAt: now - 10, endAt: now + 10 },
];

const picked = claimableCampaigns(rows, now).map((r: any) => r.campaignKey).sort();
check(
  "VIEW_DETAILS 的也能领",
  picked.includes("act-daily"),
  JSON.stringify(picked),
);
check("CLAIM_BENEFIT 的也能领", picked.includes("act-benefit"), JSON.stringify(picked));
check("领过的不领", !picked.includes("act-claimed"), JSON.stringify(picked));
check("没开始的不领", !picked.includes("act-later"), JSON.stringify(picked));
check("结束的不领", !picked.includes("act-over"), JSON.stringify(picked));
check("不是发积分的活动不领", !picked.includes("act-invite"), JSON.stringify(picked));

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
