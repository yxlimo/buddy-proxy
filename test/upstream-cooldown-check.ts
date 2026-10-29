// test/upstream-cooldown-check.ts — 面板要看得见冷却。
//
//   node --experimental-strip-types test/upstream-cooldown-check.ts
//
// 离线：临时数据目录，不起网关，不碰真平台，不花额度。
//
// 为什么要有这个：冷却表里明明记着「这个账号在冷却」，面板却说「就绪」，
// 而网关实际回 503 —— 面板说的与路由做的不一致，排查时只能去翻日志。
//
// 覆盖：
//   1. 正常账号：READY，没有冷却；
//   2. 冷却中：COOLING + 截止时刻 + 理由 + 恢复时间 + 一句话；
//   3. 两个账号只有一个在冷却：平台还是 READY，但账号那一行带冷却；
//   4. 额度用尽 + 冷却：额度优先（OUT_OF_CREDITS），冷却字段仍然填；
//   5. 冷却已过期：回到 READY；
//   6. 平台还能接：原因句说清是几个账号里的几个在冷却；
//   7. 额度用尽：平台自己说得出什么时候回来（Qoder 的重置时间）；
//   8. 额度用尽但平台说不出来（WorkBuddy）：恢复时间留空，不猜；
//   9. 冷却与额度同时存在：恢复时间取早的那个。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-cooldown-"));
process.env.BUDDY_DATA_DIR = tmp;

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

const { setSecret } = await import("../lib/store.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setCooldown, clearCooldown } = await import("../lib/cooldown.ts");
const { putHealthSnapshot } = await import("../lib/health-cache.ts");
const { adminService } = await import("../lib/admin/service.ts");
const { UpstreamState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

const now = Date.now();
const year = now + 365 * 24 * 3600 * 1000;

/** 一份能用的 Qoder 会话（假的，令牌不指向任何真平台）。 */
function qoderSession(id: string, region = "global") {
  return {
    schemaVersion: 1,
    region,
    clientId: "test-client",
    accessToken: `dt-test-access-token-${id}`,
    refreshToken: `drt-test-refresh-token-${id}`,
    userId: "00000000-0000-0000-0000-000000000000",
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    machineId: "00000000-0000-4000-8000-000000000000",
    machineToken: "test-machine-token",
    machineType: "test-machine-type",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

/** 面板上那个时刻的写法（UTC+8，只到分钟）。 */
function stampOf(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
}

/** 平台在面板上的那一条。 */
async function upstreamOf(id: string): Promise<any> {
  const response = await adminService.listUpstreams!();
  const found = response.upstreams.find((u) => u.id === id);
  if (!found) throw new Error(`面板上没有这个上游：${id}`);
  return found;
}

/** 平台名下某个账号在面板上的那一条。 */
function accountOf(upstream: any, accountId: string): any {
  const found = (upstream.accounts ?? []).find((a: any) => a.id === accountId);
  if (!found) throw new Error(`面板上没有这个账号：${accountId}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * 账号：qoder（全球区）一个，qoder-cn 两个
 * ------------------------------------------------------------------ */

const first = addAccount({ platform: "qoder" });
check("账号加得进去", first.ok === true && !!first.id, JSON.stringify(first));
const firstId = first.id!;
setSecret(`session:provider:${firstId}`, "session", qoderSession(firstId));

const cnOne = addAccount({ platform: "qoder-cn" });
const cnTwo = addAccount({ platform: "qoder-cn" });
check("两个账号加得进去", !!cnOne.id && !!cnTwo.id, `${cnOne.id} / ${cnTwo.id}`);
setSecret(`session:provider:${cnOne.id!}`, "session", qoderSession(cnOne.id!, "cn"));
setSecret(`session:provider:${cnTwo.id!}`, "session", qoderSession(cnTwo.id!, "cn"));

console.log("");
console.log("正常账号：没有冷却");

{
  const upstream = await upstreamOf("qoder");
  check("状态是就绪", upstream.state === UpstreamState.READY, String(upstream.state));
  check("没有冷却时刻", upstream.cooldownUntilMs === 0n, String(upstream.cooldownUntilMs));
  check("没有冷却理由", upstream.cooldownReason === "", upstream.cooldownReason);
  check("没有恢复时间", upstream.recoversAtMs === 0n, String(upstream.recoversAtMs));
  check("没有一句话", upstream.stateReason === "", upstream.stateReason);
  const account = accountOf(upstream, firstId);
  check("账号也没有冷却时刻", account.cooldownUntilMs === 0n, String(account.cooldownUntilMs));
}

console.log("");
console.log("冷却中：面板看得见");

{
  const until = now + 5 * 60_000;
  setCooldown(firstId, until, "rate-limit");
  const upstream = await upstreamOf("qoder");
  check("状态是冷却", upstream.state === UpstreamState.COOLING, String(upstream.state));
  check("冷却时刻是那个时刻", upstream.cooldownUntilMs === BigInt(until), String(upstream.cooldownUntilMs));
  check("理由是平台给的说法", upstream.cooldownReason === "rate-limit", upstream.cooldownReason);
  check("恢复时间就是冷却结束", upstream.recoversAtMs === BigInt(until), String(upstream.recoversAtMs));
  check("一句话里有理由", upstream.stateReason.includes("rate-limit"), upstream.stateReason);
  const account = accountOf(upstream, firstId);
  check("账号那一行也带冷却时刻", account.cooldownUntilMs === BigInt(until), String(account.cooldownUntilMs));
  check("账号那一行也带理由", account.cooldownReason === "rate-limit", account.cooldownReason);
}

console.log("");
console.log("额度用尽 + 冷却：额度优先");

{
  // 快照说额度用尽了（Qoder 的平台自己的标记）。
  putHealthSnapshot({ qoder: { [firstId]: { credits: { quotaExceeded: true } } } });
  const upstream = await upstreamOf("qoder");
  check("状态是额度用尽", upstream.state === UpstreamState.OUT_OF_CREDITS, String(upstream.state));
  check("冷却时刻仍然填着", upstream.cooldownUntilMs === BigInt(now + 5 * 60_000), String(upstream.cooldownUntilMs));
  check("冷却理由仍然填着", upstream.cooldownReason === "rate-limit", upstream.cooldownReason);
  check("一句话里说额度用尽", upstream.stateReason.includes("额度用尽"), upstream.stateReason);
  // 快照清掉，后面的判据回到「额度充足」。
  putHealthSnapshot({});
}

console.log("");
console.log("冷却已过期：回到就绪");

{
  clearCooldown(firstId);
  // 一行冷却还在，但已经过期 —— 判定是惰性的：比时间就行。
  setCooldown(firstId, now - 60_000, "rate-limit");
  const upstream = await upstreamOf("qoder");
  check("状态回到就绪", upstream.state === UpstreamState.READY, String(upstream.state));
  check("没有冷却时刻", upstream.cooldownUntilMs === 0n, String(upstream.cooldownUntilMs));
  check("没有一句话", upstream.stateReason === "", upstream.stateReason);
  clearCooldown(firstId);
}

console.log("");
console.log("两个账号只有一个在冷却：平台还是就绪，账号看得出是谁");

{
  const until = now + 3 * 60_000;
  setCooldown(cnTwo.id!, until, "connection");
  const upstream = await upstreamOf("qoder-cn");
  check("平台还是就绪", upstream.state === UpstreamState.READY, String(upstream.state));
  check("平台带着冷却时刻", upstream.cooldownUntilMs === BigInt(until), String(upstream.cooldownUntilMs));
  check("平台带着冷却理由", upstream.cooldownReason === "connection", upstream.cooldownReason);
  const cooling = accountOf(upstream, cnTwo.id!);
  const fine = accountOf(upstream, cnOne.id!);
  check("在冷却的那个账号带冷却时刻", cooling.cooldownUntilMs === BigInt(until), String(cooling.cooldownUntilMs));
  check("在冷却的那个账号带理由", cooling.cooldownReason === "connection", cooling.cooldownReason);
  check("没在冷却的账号没有冷却时刻", fine.cooldownUntilMs === 0n, String(fine.cooldownUntilMs));
  clearCooldown(cnTwo.id!);
}

console.log("");
console.log("平台还能接：一个账号冷却、另一个正常");

{
  const until = now + 7 * 60_000;
  setCooldown(cnOne.id!, until, "connection");
  const upstream = await upstreamOf("qoder-cn");
  check("平台还是就绪", upstream.state === UpstreamState.READY, String(upstream.state));
  check("原因句说清是几个账号里的几个", upstream.stateReason.includes("个账号"), upstream.stateReason);
  check("原因句里有那个冷却时刻", upstream.stateReason.includes(stampOf(until)), upstream.stateReason);
  check("冷却时刻还是那个", upstream.cooldownUntilMs === BigInt(until), String(upstream.cooldownUntilMs));
  clearCooldown(cnOne.id!);
}

console.log("");
console.log("额度用尽：平台自己说得出什么时候回来");

{
  clearCooldown(firstId);
  const resetsAtMs = now + 45 * 60_000;
  putHealthSnapshot({
    qoder: { [firstId]: { credits: { quotaExceeded: true, resetsAt: new Date(resetsAtMs).toISOString() } } },
  });
  const upstream = await upstreamOf("qoder");
  check("状态是额度用尽", upstream.state === UpstreamState.OUT_OF_CREDITS, String(upstream.state));
  check("恢复时间就是平台说的那个", upstream.recoversAtMs === BigInt(resetsAtMs), String(upstream.recoversAtMs));
  check("原因句里有那个时刻", upstream.stateReason.includes(stampOf(resetsAtMs)), upstream.stateReason);
}

console.log("");
console.log("额度用尽：平台说不出来的时候就说不知道");

{
  const wb = addAccount({ platform: "workbuddy-cn" });
  const wbId = wb.id!;
  setSecret(`session:provider:${wbId}`, "session", {
    accessToken: "wb-test-token",
    refreshToken: "wb-test-refresh",
    uid: "test-user",
    nickname: "tester",
    domain: "127.0.0.1",
    region: "cn",
    generation: 1,
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    loginAtMs: now,
    refreshedAtMs: now,
  });
  putHealthSnapshot({ workbuddy: { [wbId]: { credits: { daily: 0 } } } });
  const upstream = await upstreamOf("workbuddy-cn");
  check("状态是额度用尽", upstream.state === UpstreamState.OUT_OF_CREDITS, String(upstream.state));
  check("算不出恢复时间", upstream.recoversAtMs === 0n, String(upstream.recoversAtMs));
  check("原因句只有额度用尽", upstream.stateReason === "额度用尽", upstream.stateReason);
}

console.log("");
console.log("冷却与额度同时存在：恢复时间取早的那个");

{
  const until = now + 10 * 60_000;
  const resetsAtMs = now + 45 * 60_000;
  setCooldown(firstId, until, "quota");
  putHealthSnapshot({
    qoder: { [firstId]: { credits: { quotaExceeded: true, resetsAt: new Date(resetsAtMs).toISOString() } } },
  });
  const upstream = await upstreamOf("qoder");
  check("冷却更早：恢复时间是冷却结束", upstream.recoversAtMs === BigInt(until), String(upstream.recoversAtMs));

  const later = now + 60 * 60_000;
  const soon = now + 5 * 60_000;
  setCooldown(firstId, later, "quota");
  putHealthSnapshot({
    qoder: { [firstId]: { credits: { quotaExceeded: true, resetsAt: new Date(soon).toISOString() } } },
  });
  const again = await upstreamOf("qoder");
  check("额度更早：恢复时间是额度回来的时刻", again.recoversAtMs === BigInt(soon), String(again.recoversAtMs));
  clearCooldown(firstId);
  putHealthSnapshot({});
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
