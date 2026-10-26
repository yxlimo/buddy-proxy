// test/workbuddy-benefits-check.ts — Buddy 的旅行礼物。
//
//   node --experimental-strip-types test/workbuddy-benefits-check.ts
//
// 离线：假平台，不问真的 WorkBuddy。
//
// 三件事：
//
//   1. 平台说有礼物就领（不认平台给状态起的名字）。
//   2. 礼物还在的时候不把 Buddy 派走 —— 派走了那份礼物就没了。
//   3. 在路上的时候说清楚什么时候回来、能拿多少。

import fs from "node:fs";
import http from "node:http";

const DATA_DIR = "/tmp/opencode/test-workbuddy-benefits";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * 假平台
 * ------------------------------------------------------------------ */

/** 平台现在说的旅行状态。 */
let travelState: Record<string, unknown> = {};
/** 领礼物的回答。 */
let claimStatus = 200;
let claimBody: Record<string, unknown> = {};
/** 平台被叫了哪些接口。 */
const calls: string[] = [];

const platform = http.createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  calls.push(`${req.method} ${path}`);
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path.endsWith("/buddy/travel/status")) {
    send(200, { code: 0, msg: "OK", data: travelState });
    return;
  }
  if (path.endsWith("/buddy/travel/claim")) {
    send(claimStatus, { code: 0, msg: "OK", data: claimBody });
    return;
  }
  if (path.endsWith("/buddy/travel/config")) {
    send(200, {
      code: 0,
      msg: "OK",
      data: { locations: [{ id: 1, code: "coffee", name: "咖啡馆" }] },
    });
    return;
  }
  if (path.endsWith("/buddy/travel/depart")) {
    send(200, { code: 0, msg: "OK", data: { location: { name: "咖啡馆" } } });
    return;
  }
  if (path.endsWith("/checkin-activity-status")) {
    send(200, { code: 0, msg: "OK", data: { today_checked_in: true, streak_days: 6 } });
    return;
  }
  // 别的接口（任务、连签、盲盒）不在这一轮的范围里。
  send(200, { code: 0, msg: "OK", data: {} });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const port = (platform.address() as { port: number }).port;
process.env.WORKBUDDY_CHAT_BASE = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ *
 * 一份能用的登录态
 * ------------------------------------------------------------------ */

const { setSecret } = await import("../lib/store.ts");
setSecret("session:provider:workbuddy-cn", "session", {
  accessToken: "access_test",
  refreshToken: "refresh_test",
  expiresAtMs: Date.now() + 24 * 3600 * 1000,
  generation: 1,
  uid: "u1",
  nickname: "n",
  domain: "127.0.0.1",
  region: "cn",
});

const { runWorkBuddyBenefits } = await import("../lib/workbuddy/benefits.ts");

/** 跑一次签到，返回报告。 */
async function run(): Promise<{ report: string[]; calls: string[] }> {
  calls.length = 0;
  const outcome = await runWorkBuddyBenefits("workbuddy-cn");
  return { report: outcome.report, calls: [...calls] };
}

console.log("");
console.log("平台说有礼物就领");

{
  // 平台说：回来了，礼物 8 积分。
  travelState = { state: "arrived", record_id: 7, reward_credit: 8, daily_limit_reached: false };
  claimStatus = 200;
  claimBody = { reward_credit: 8 };
  const { report, calls: hit } = await run();
  check("领了礼物", report.some((l) => l.includes("领旅行礼物 +8 积分")), report.join(" | "));
  check("调了领礼物的接口", hit.some((c) => c.includes("travel/claim")), hit.join(","));
}

{
  // 平台的答复里没有 reward_credit，用状态里说的那个数。
  travelState = { state: "arrived", record_id: 7, reward_credit: 6, daily_limit_reached: false };
  claimStatus = 200;
  claimBody = {};
  const { report } = await run();
  check("答复没给数就用状态里的", report.some((l) => l.includes("领旅行礼物 +6 积分")), report.join(" | "));
}

console.log("");
console.log("礼物还在的时候不把 Buddy 派走");

{
  // 领失败了：礼物还在。这时候派走它，那份礼物就没了。
  travelState = { state: "arrived", record_id: 7, reward_credit: 5, daily_limit_reached: false };
  claimStatus = 500;
  claimBody = { msg: "手气不好" };
  const { report, calls: hit } = await run();
  check("说了领失败", report.some((l) => l.includes("领旅行礼物失败")), report.join(" | "));
  check("没有派 Buddy 走", !hit.some((c) => c.includes("travel/depart")), hit.join(","));
}

{
  // 在路上：说清楚什么时候回来、能拿多少，也不派它走。
  const back = Math.floor(Date.now() / 1000) + 3600;
  travelState = { state: "traveling", record_id: 7, reward_credit: 9, arrive_at: back, daily_limit_reached: false };
  claimStatus = 200;
  claimBody = {};
  const { report, calls: hit } = await run();
  check("说了在路上的事", report.some((l) => l.includes("Buddy 在路上")), report.join(" | "));
  check("说了能拿多少", report.some((l) => l.includes("礼物 9 积分")), report.join(" | "));
  check("没去领", !hit.some((c) => c.includes("travel/claim")), hit.join(","));
  check("没有派 Buddy 走", !hit.some((c) => c.includes("travel/depart")), hit.join(","));
}

console.log("");
console.log("状态名靠不住，回来的时刻靠得住");

{
  // 平台把状态换了个名字，但回来的时刻已经过了：礼物该领。
  travelState = {
    state: "returned",
    record_id: 7,
    reward_credit: 4,
    arrive_at: Math.floor(Date.now() / 1000) - 60,
    daily_limit_reached: false,
  };
  claimStatus = 200;
  claimBody = { reward_credit: 4 };
  const { report, calls: hit } = await run();
  check("领了礼物", report.some((l) => l.includes("领旅行礼物 +4 积分")), report.join(" | "));
  check("调了领礼物的接口", hit.some((c) => c.includes("travel/claim")), hit.join(","));
}

{
  // 状态名也不认识，但回来的时刻还没到：它在路上，不能领。
  travelState = {
    state: "on_trip",
    record_id: 7,
    reward_credit: 4,
    arrive_at: Math.floor(Date.now() / 1000) + 600,
    daily_limit_reached: false,
  };
  claimStatus = 200;
  claimBody = { reward_credit: 4 };
  const { report, calls: hit } = await run();
  check("没有去领", !hit.some((c) => c.includes("travel/claim")), hit.join(","));
  check("说了在路上的事", report.some((l) => l.includes("Buddy 在路上")), report.join(" | "));
}

console.log("");
console.log("闲着才派它出去");

{
  travelState = { state: "idle", record_id: 0, reward_credit: 0, daily_limit_reached: false };
  claimStatus = 200;
  claimBody = {};
  const { report, calls: hit } = await run();
  check("派它出去了", hit.some((c) => c.includes("travel/depart")), hit.join(","));
  check("说了去哪", report.some((l) => l.includes("派 Buddy 去咖啡馆")), report.join(" | "));
}

{
  // 今天的出发名额用完了：不动它。
  travelState = { state: "idle", record_id: 0, reward_credit: 0, daily_limit_reached: true };
  const { report, calls: hit } = await run();
  check("没有派它走", !hit.some((c) => c.includes("travel/depart")), hit.join(","));
  check("说了它的状态", report.some((l) => l.includes("Buddy 状态：idle")), report.join(" | "));
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
