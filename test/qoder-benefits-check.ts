// test/qoder-benefits-check.ts — Qoder 的每日活动。
//
//   node --experimental-strip-types test/qoder-benefits-check.ts
//
// 三个坑，都是实打实漏过积分的：
//
//   1. 机器身份的头会让平台把每日活动藏起来（不带头才看得见）。
//   2. 活动的 actionType 不是过滤器：global 区的每日活动是 VIEW_DETAILS，
//      一样能领，一样发积分。
//   3. 平台的 claimStatus 不按天重置：领过了就一直 CLAIMED。拿它当
//      「今天领过」的依据就永远不再试领，所以认的是窗口起点。
//
// 还有一件面板上看错的事：签到了却显示成没签。平台说「重放」（今天已经领过）
// 的时候积分是 0，但今天确实签到了 —— 认的是平台的话，不是积分的数。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// The module under test reaches the store while it loads, and the store wants
// a data dir of its own. Give it a throwaway one so the check never touches a
// real data dir, and never talks to a real upstream.
const previousDataDir = process.env.BUDDY_DATA_DIR;
const scratchDir = mkdtempSync(join(tmpdir(), "buddy-qoder-benefits-"));
process.env.BUDDY_DATA_DIR = scratchDir;

/* ------------------------------------------------------------------ *
 * 假平台
 * ------------------------------------------------------------------ */

/** 每个账号的活动列表：按令牌分（每个账号一份令牌）。 */
const lists: Record<string, any[]> = {};
/** 领取的答复：按活动 id 分。 */
const claims: Record<string, { status: number; body: any }> = {};
/** 平台被叫了哪些接口。 */
const hits: string[] = [];

const platform = http.createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
  hits.push(`${req.method} ${path}`);
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path === "/sash/api/v1/me/campaigns") {
    send(200, { campaigns: lists[token] ?? [] });
    return;
  }
  const claim = /^\/sash\/api\/v1\/me\/campaigns\/([^/]+)\/claim$/.exec(path);
  if (claim) {
    const answer = claims[claim[1]] ?? { status: 200, body: { replayed: true } };
    send(answer.status, answer.body);
    return;
  }
  send(404, { msg: "not found" });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const platformPort = (platform.address() as { port: number }).port;

// Both regions talk to the same fake: the shape of the request is the same,
// the answer differs by the account's token.
process.env.QODER_CN_OPENAPI_BASE = `http://127.0.0.1:${platformPort}`;
process.env.QODER_GLOBAL_OPENAPI_BASE = `http://127.0.0.1:${platformPort}`;

const { claimableCampaigns, qoderClaimHeaders, shouldAttemptClaim, runQoderBenefits } = await import(
  "../lib/qoder/benefits.ts"
);
const { addAccount } = await import("../lib/providers.ts");
const { setSecret } = await import("../lib/store.ts");

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
console.log("窗口记忆：CLAIMED 不等于今天领过");

// 平台不按天重置 claimStatus：同一个 campaign 一直是 CLAIMED。认的是窗口起点。
const claimedRow = {
  campaignKey: "act-claimed",
  claimStatus: "CLAIMED",
  actionType: "CLAIM_BENEFIT",
  startAt: now - 10,
  endAt: now + 10,
};
check(
  "窗口起点比上次记录新 → 要试领",
  shouldAttemptClaim(claimedRow, now, now - 100) === true,
);
check(
  "窗口起点 <= 上次记录 → 不试领",
  shouldAttemptClaim(claimedRow, now, now - 10) === false,
);
check(
  "没试过（记录为 0）→ 要试领",
  shouldAttemptClaim(claimedRow, now, 0) === true,
);
check(
  "CLAIMABLE 即使记录过 → 要领",
  shouldAttemptClaim({ ...claimedRow, claimStatus: "CLAIMABLE" }, now, now + 999) === true,
);
check(
  "窗口没开始 → 不领",
  shouldAttemptClaim({ ...claimedRow, startAt: now + 10, endAt: now + 20 }, now, 0) === false,
);
check(
  "窗口已结束 → 不领",
  shouldAttemptClaim({ ...claimedRow, startAt: now - 20, endAt: now - 1 }, now, 0) === false,
);
check(
  "不是发积分的活动 → 不领",
  shouldAttemptClaim({ ...claimedRow, actionType: "INVITE_FRIENDS" }, now, 0) === false,
);
check(
  "VIEW_DETAILS 也算能领的活动",
  shouldAttemptClaim({ ...claimedRow, actionType: "VIEW_DETAILS" }, now, 0) === true,
);

/* ------------------------------------------------------------------ *
 * 两个账号：一个中国区，一个全球区
 * ------------------------------------------------------------------ */

console.log("");
console.log("签到结果：签到了就是签到了");

// The first account of a platform gets the platform's id as its own id.
const cn = addAccount({ platform: "qoder-cn" });
const global = addAccount({ platform: "qoder" });
check("加好了中国区的账号", cn.ok === true && cn.id === "qoder-cn", JSON.stringify(cn));
check("加好了全球区的账号", global.ok === true && global.id === "qoder", JSON.stringify(global));

setSecret("session:provider:qoder-cn", "session", {
  accessToken: "cn-token",
  refreshToken: "cn-refresh",
  expiresAtMs: Date.now() + 3600_000,
  generation: 1,
  region: "cn",
});
setSecret("session:provider:qoder", "session", {
  accessToken: "global-token",
  refreshToken: "global-refresh",
  expiresAtMs: Date.now() + 3600_000,
  generation: 1,
  region: "global",
});

const nowSec = Math.floor(Date.now() / 1000);

/** 一条每日签到活动。 */
function daily(key: string, status: string, startAt = nowSec - 60, endAt = nowSec + 3600): any {
  return {
    campaignKey: key,
    campaignId: key,
    claimStatus: status,
    actionType: "CLAIM_BENEFIT",
    startAt,
    endAt,
    benefit: { amount: 100, kind: "RESOURCE_PACKAGE_SOURCE_BONUS" },
  };
}

// The platform says it was already taken: no credits this round, but today is
// signed in. The panel used to say "nothing new" here.
{
  lists["cn-token"] = [daily("act-replay", "CLAIMABLE")];
  claims["act-replay"] = { status: 200, body: { replayed: true } };
  hits.length = 0;
  const outcome = await runQoderBenefits("qoder-cn");
  check("重放：发了一次领取请求", hits.includes("POST /sash/api/v1/me/campaigns/act-replay/claim"), hits.join(","));
  check("重放：没有积分", outcome.credits === 0, String(outcome.credits));
  check("重放：今天算签到了", outcome.signedIn === true, JSON.stringify(outcome));
  check("重放：签到状态是看得见的", outcome.statusUnavailable === false, JSON.stringify(outcome));
  check("重放：不说平台没有每日签到", outcome.noDailyCheckin === undefined, JSON.stringify(outcome));
}

// The credits did land.
{
  lists["cn-token"] = [daily("act-grant", "CLAIMABLE")];
  claims["act-grant"] = {
    status: 200,
    body: { benefit: { amount: 100, kind: "RESOURCE_PACKAGE_SOURCE_BONUS" } },
  };
  const outcome = await runQoderBenefits("qoder-cn");
  check("到账：积分是 100", outcome.credits === 100, String(outcome.credits));
  check("到账：今天算签到了", outcome.signedIn === true, JSON.stringify(outcome));
}

// The window was already tried: the platform says CLAIMED and we do not ask
// again -- but today is still signed in.
{
  lists["cn-token"] = [daily("act-memo", "CLAIMED")];
  claims["act-memo"] = { status: 200, body: { replayed: true } };
  hits.length = 0;
  const first = await runQoderBenefits("qoder-cn");
  check("第一轮：发了一次领取请求", hits.includes("POST /sash/api/v1/me/campaigns/act-memo/claim"), hits.join(","));
  hits.length = 0;
  const second = await runQoderBenefits("qoder-cn");
  check("第二轮：没有再发领取请求", !hits.some((h) => h.includes("/claim")), hits.join(","));
  check("第二轮：说了已领过", second.report.some((l) => l.includes("已领过")), second.report.join(" | "));
  check("第二轮：没有积分", second.credits === 0, String(second.credits));
  check("第二轮：今天还是算签到了", second.signedIn === true, JSON.stringify(second));
  void first;
}

// The global region's list only carries VIEW_DETAILS campaigns: its daily
// check-in lives on the web host, which does not answer for us. So the state
// of today's check-in is unknown -- that is not "there is no daily check-in".
{
  lists["global-token"] = [
    {
      campaignKey: "act-view",
      campaignId: "act-view",
      claimStatus: "CLAIMED",
      actionType: "VIEW_DETAILS",
      startAt: nowSec - 86400,
      endAt: nowSec - 3600,
    },
  ];
  const outcome = await runQoderBenefits("qoder");
  check("全球区：签到状态看不到", outcome.statusUnavailable === true, JSON.stringify(outcome));
  check("全球区：不说平台没有每日签到", outcome.noDailyCheckin === undefined, JSON.stringify(outcome));
  check("全球区：没有签到", outcome.signedIn === false, JSON.stringify(outcome));
  check("全球区：没有积分", outcome.credits === 0, String(outcome.credits));
  check(
    "全球区：说了签到状态不在这个接口里",
    outcome.report.some((l) => l.includes("列表里没有每日签到活动")),
    outcome.report.join(" | "),
  );
}

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
if (previousDataDir === undefined) delete process.env.BUDDY_DATA_DIR;
else process.env.BUDDY_DATA_DIR = previousDataDir;
rmSync(scratchDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
