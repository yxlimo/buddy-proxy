// test/policy-check.ts — 上游自己的策略（lib/router/provider-selection.ts）。
//
//   node --experimental-strip-types test/policy-check.ts
//
// 离线：不碰网络，不问任何上游。
//
// 覆盖：
//   1. 三个策略各自的行为：单一不换、降级换、余额到期优先只调一个；
//   2. 账号的次序：余额到期优先按钱包说的，单一与降级按租户次序；
//   3. 钱包变了之后，余额到期优先换到另一个账号；
//   4. 只有一个账号的上游：策略不影响它；
//   5. 降级的分类：服务不可用/429/402/401/403 降级，400/404/413 不降级，
//      以及平台自己的业务码；
//   6. 七牛云的 403「模型不在这个 key 的分组里」：不换账号、不写冷却。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-check-"));
process.env.BUDDY_DATA_DIR = tmp;

const { AuthError } = await import("../lib/credential.ts");
const {
  byOrder,
  classifyUpstreamError,
  describeUpstreamError,
  isDegradableUpstreamError,
  isNoBalanceFailure,
  selectProvider,
} = await import("../lib/router/provider-selection.ts");
const { withBusinessCode, withUpstreamStatus } = await import("../lib/upstream-status.ts");
const { tokenRhythmAccounts } = await import("../lib/router/upstreams/index.ts");

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

/** 一个候选：记下自己试过没有，然后成功或者失败。 */
function candidate(
  id: string,
  outcome: "ok" | Error,
  tried: string[],
): { id: string; weight: number; run: () => Promise<string> } {
  return {
    id,
    weight: 1,
    run: async () => {
      tried.push(id);
      if (outcome === "ok") return `answer from ${id}`;
      throw outcome;
    },
  };
}

/** 三个候选，次序就是传进去的次序。 */
function three(tried: string[], first: "ok" | Error): any[] {
  return byOrder([
    { id: "first", run: async () => candidate("first", first, tried).run() },
    { id: "second", run: async () => candidate("second", "ok", tried).run() },
    { id: "third", run: async () => candidate("third", "ok", tried).run() },
  ]);
}

console.log("");
console.log("单一：只调第一个，不换");

{
  const tried: string[] = [];
  const value = await selectProvider("single", three(tried, "ok"));
  check("只试了一个", tried.join(",") === "first", tried.join(","));
  check("答案是它给的", value === "answer from first", value);
}

{
  const tried: string[] = [];
  const boom = new AuthError("no credit", "没钱了", 402);
  let caught: any = null;
  try {
    await selectProvider("single", three(tried, boom), { degradable: isDegradableUpstreamError });
  } catch (e) {
    caught = e;
  }
  check("失败了就是失败了", caught === boom, String(caught?.message));
  check("没有换到下一个", tried.join(",") === "first", tried.join(","));
}

console.log("");
console.log("降级：不可用的换下一个");

{
  const tried: string[] = [];
  const value = await selectProvider("fallback", three(tried, new AuthError("no credit", "没钱了", 402)), {
    degradable: isDegradableUpstreamError,
  });
  check("402 余额用尽 → 换", tried.join(",") === "first,second", tried.join(","));
  check("答案是第二个给的", value === "answer from second", value);
}

{
  const tried: string[] = [];
  const boom = new AuthError("the request is wrong", "参数错", 400);
  let caught: any = null;
  try {
    await selectProvider("fallback", three(tried, boom), { degradable: isDegradableUpstreamError });
  } catch (e) {
    caught = e;
  }
  check("400 请求本身的问题 → 不换", caught === boom, String(caught?.message));
  check("只试了一个", tried.join(",") === "first", tried.join(","));
}

console.log("");
console.log("余额到期优先：包过的单一——余额不足就换");

{
  const tried: string[] = [];
  const value = await selectProvider("expiry_first", three(tried, "ok"));
  check("只试了一个", tried.join(",") === "first", tried.join(","));
  check("答案是它给的", value === "answer from first", value);
}

{
  const tried: string[] = [];
  const boom = new AuthError("no credit", "没钱了", 402);
  let caught: any = null;
  try {
    await selectProvider("expiry_first", three(tried, boom), {
      degradable: isDegradableUpstreamError,
      insufficient: isNoBalanceFailure,
    });
  } catch (e) {
    caught = e;
  }
  check("余额不足 → 换下一个", tried.join(",") === "first,second", tried.join(","));
  check("答案是第二个给的", caught === null, String(caught?.message));
}

{
  const tried: string[] = [];
  const boom = new AuthError("the request is wrong", "参数错", 400);
  let caught: any = null;
  try {
    await selectProvider("expiry_first", three(tried, boom), {
      degradable: isDegradableUpstreamError,
      insufficient: isNoBalanceFailure,
    });
  } catch (e) {
    caught = e;
  }
  check("请求本身的问题 → 不换", caught === boom, String(caught?.message));
  check("只试了一个", tried.join(",") === "first", tried.join(","));
}

{
  // 钩子：余额不足时重新扫描，扫描给出下一个账户。
  const scans: string[] = [];
  let pick = 0;
  const next = async () => {
    scans.push("scan");
    const id = pick++ === 0 ? "first" : "second";
    return { id, weight: 0, run: async () => {
      if (id === "first") throw new AuthError("no credit", "没钱了", 402);
      return "answer from second";
    }};
  };
  const value = await selectProvider("expiry_first", [], {
    insufficient: isNoBalanceFailure,
    next,
  });
  check("重新扫描了一次", scans.length === 2, scans.join(","));
  check("第二个账户接了", value === "answer from second", value);
}

console.log("");
console.log("次序");

{
  const ordered = byOrder([
    { id: "a", run: async () => "a" },
    { id: "b", run: async () => "b" },
    { id: "c", run: async () => "c" },
  ]);
  check("第一个最重", ordered[0].weight > ordered[1].weight && ordered[1].weight > ordered[2].weight);
  check("次序就是传进去的次序", ordered.map((c: any) => c.id).join(",") === "a,b,c");
}

console.log("");
console.log("账号的次序（TokenRhythm）");

/** 一个租户的样子。 */
function tenant(
  index: number,
  available: number,
  gift: number,
  nextExpiryAt: string | null,
  extra: Record<string, unknown> = {},
): any {
  return {
    index,
    account: `190***${index}`,
    name: `租户 ${index}`,
    hasKey: true,
    wallet: { availableCny: available, giftAvailableCny: gift },
    credits: nextExpiryAt ? { summary: { nextExpiryAt } } : null,
    error: null,
    ...extra,
  };
}

const soon = "2026-11-19T04:28:10.883Z";
const later = "2026-11-20T04:28:10.883Z";
const never = "2099-12-31T15:59:59.000Z";

const statuses = [
  tenant(1, 100, 0, never), // 只有充值的本金
  tenant(2, 18, 18, soon), // 最先到期
  tenant(3, 18, 18, later),
];

{
  const order = tokenRhythmAccounts(statuses, "expiry_first").map((t: any) => t.index);
  check("余额到期优先：最先到期的先上", order[0] === 2, order.join(","));
  check("余额到期优先：本金排最后", order.join(",") === "2,3,1", order.join(","));
}

{
  const order = tokenRhythmAccounts(statuses, "single").map((t: any) => t.index);
  check("单一：按租户次序", order.join(",") === "1,2,3", order.join(","));
}

{
  const order = tokenRhythmAccounts(statuses, "fallback").map((t: any) => t.index);
  check("降级：按租户次序", order.join(",") === "1,2,3", order.join(","));
}

{
  const mixed = [
    tenant(1, 0, 0, soon), // 余额读到了，是空的 → 没钱
    tenant(2, 18, 18, soon, { hasKey: false }), // 没有 key → 发不出请求
    tenant(3, 18, 18, soon, { error: "登录过期" }), // 查询出错 → 不知道，不是没钱
    tenant(4, 18, 18, later), // 能用
  ];
  const order = tokenRhythmAccounts(mixed, "fallback").map((t: any) => t.index);
  // 没钱的、没 key 的排除；查询出错的照样留着（余额读不到不等于没钱）。
  // 降级按账号行的次序，不按余额排 —— 序号就是行的次序。
  check("没钱、没 key 的排除，查不到余额的留着", order.join(",") === "3,4", order.join(","));
}

console.log("");
console.log("钱包变了之后换账号");

{
  // 钱包说租户 2 最先到期 → 它先上。
  const before = tokenRhythmAccounts(statuses, "expiry_first").map((t: any) => t.index);
  check("先是租户 2", before[0] === 2, before.join(","));

  // 钱包变了：租户 2 的赠金用完了，租户 3 的最先到期。
  const moved = [
    tenant(1, 100, 0, never),
    tenant(2, 18, 0, never),
    tenant(3, 18, 18, soon),
  ];
  const after = tokenRhythmAccounts(moved, "expiry_first").map((t: any) => t.index);
  check("钱包说了算，换成租户 3", after[0] === 3, after.join(","));
}

console.log("");
console.log("只有一个账号的上游");

/** 一个上游只有一个账号时候选长什么样。 */
function only(tried: string[], outcome: "ok" | Error): any[] {
  return byOrder([{ id: "only", run: async () => candidate("only", outcome, tried).run() }]);
}

{
  for (const policy of ["single", "fallback", "expiry_first"] as const) {
    const tried: string[] = [];
    const value = await selectProvider(policy, only(tried, "ok"));
    check(`${policy}：答案一样`, value === "answer from only", value);
    check(`${policy}：只试了那一个`, tried.join(",") === "only", tried.join(","));
  }
  const tried: string[] = [];
  let caught: any = null;
  try {
    await selectProvider("fallback", only(tried, new AuthError("boom", "boom", 500)), {
      degradable: isDegradableUpstreamError,
    });
  } catch (e) {
    caught = e;
  }
  check("只有一个账号时降级也换不了人", caught?.message === "boom", String(caught?.message));
  check("只试了那一个", tried.join(",") === "only", tried.join(","));
}

console.log("");
console.log("降级的分类");

{
  const cases: [string, unknown, boolean, string][] = [
    ["401 凭据被拒", new AuthError("x", "x", 401), true, "credential"],
    ["403 凭据被拒", new AuthError("x", "x", 403), true, "credential"],
    ["402 余额用尽", new AuthError("x", "x", 402), true, "no-balance"],
    ["429 额度打满", new AuthError("x", "x", 429), true, "rate-limit"],
    ["500 服务不可用", new AuthError("x", "x", 500), true, "server"],
    ["503 服务不可用", new AuthError("x", "x", 503), true, "server"],
    ["400 请求本身的问题", new AuthError("x", "x", 400), false, "request"],
    ["404 请求本身的问题", new AuthError("x", "x", 404), false, "request"],
    ["413 请求本身的问题", new AuthError("x", "x", 413), false, "request"],
  ];
  for (const [name, error, degradable, kind] of cases) {
    const failure = classifyUpstreamError(error);
    check(`${name} → 降级=${degradable}`, failure.degradable === degradable, failure.kind);
    check(`${name} → ${kind}`, failure.kind === kind, failure.kind);
  }
}

{
  // 上游自己的状态：网关包了一层，状态是网关的。
  const wrapped = withUpstreamStatus(new AuthError("x", "x", 502), 400);
  const failure = classifyUpstreamError(wrapped);
  check("上游的 400 盖过网关的 502", failure.degradable === false, failure.kind);
  check("状态是上游那个", failure.status === 400, String(failure.status));
}

{
  // 连接失败：不是请求的问题。
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const failure = classifyUpstreamError(new TypeError("fetch failed", { cause }));
  check("连接失败 → 降级", failure.degradable === true, failure.kind);
  check("连接失败 → connection", failure.kind === "connection", failure.kind);
}

{
  const failure = classifyUpstreamError(Object.assign(new Error("aborted"), { name: "AbortError" }));
  check("超时 → 降级", failure.degradable === true, failure.kind);
  check("超时 → timeout", failure.kind === "timeout", failure.kind);
}

{
  // Qoder 的排队：请求在同一个账号上等，不是额度用尽，所以不换账号。
  const { LimitError } = await import("../lib/qoder/transport.ts");
  const busy = new LimitError("qoder model is queued (HTTP 429)", "排队", 30);
  const failure = classifyUpstreamError(busy);
  check("Qoder 的排队 → 不降级", failure.degradable === false, failure.kind);
  check("Qoder 的排队 → busy", failure.kind === "busy", failure.kind);
}

console.log("");
console.log("平台自己的业务码（200 答复里的）");

{
  const { MiniMaxApiBusinessError, miniMaxApiBusinessCode } = await import("../lib/minimax/api.ts");

  const quota = miniMaxApiBusinessCode({ base_resp: { status_code: 2067, status_msg: "套餐额度已用完" } });
  check("200 里的业务码被认出来", quota === 2067, String(quota));
  const quotaFailure = classifyUpstreamError(new MiniMaxApiBusinessError(quota!, "套餐额度已用完"));
  check("2067 → 降级", quotaFailure.degradable === true, quotaFailure.kind);
  check("2067 → quota", quotaFailure.kind === "quota", quotaFailure.kind);

  const wrong = miniMaxApiBusinessCode({ base_resp: { status_code: 2013, status_msg: "参数错误" } });
  check("2013 被认出来", wrong === 2013, String(wrong));
  const wrongFailure = classifyUpstreamError(new MiniMaxApiBusinessError(wrong!, "参数错误"));
  check("2013 → 不降级", wrongFailure.degradable === false, wrongFailure.kind);
  check("2013 → request", wrongFailure.kind === "request", wrongFailure.kind);

  check("没有业务码就是没有", miniMaxApiBusinessCode({ base_resp: { status_code: 0 } }) === null);
}

console.log("");
console.log("平台自己的业务码");

{
  const quota = withBusinessCode(new AuthError("x", "x", 502), 2067);
  const failure = classifyUpstreamError(quota);
  check("2067 套餐用完 → 降级", failure.degradable === true, failure.kind);
  check("2067 → quota", failure.kind === "quota", failure.kind);
}

{
  const wrong = withBusinessCode(new AuthError("x", "x", 502), 2013);
  const failure = classifyUpstreamError(wrong);
  check("2013 参数错 → 不降级", failure.degradable === false, failure.kind);
  check("2013 → request", failure.kind === "request", failure.kind);
}

{
  const key = withBusinessCode(new AuthError("x", "x", 502), 1004);
  check("1004 key 不对 → 降级", classifyUpstreamError(key).degradable === true);
  check("1004 → credential", classifyUpstreamError(key).kind === "credential");
}

{
  const quota = withBusinessCode(new AuthError("x", "x", 429), "quota_exceeded");
  const failure = classifyUpstreamError(quota);
  check("quota_exceeded → 降级", failure.degradable === true, failure.kind);
  check("quota_exceeded → quota", failure.kind === "quota", failure.kind);
}

{
  const limit = withBusinessCode(new AuthError("x", "x", 429), "rate_limit_exceeded");
  const failure = classifyUpstreamError(limit);
  check("rate_limit_exceeded → 降级", failure.degradable === true, failure.kind);
  check("rate_limit_exceeded → rate-limit", failure.kind === "rate-limit", failure.kind);
}

{
  const wrong = withBusinessCode(new AuthError("x", "x", 404), "model_not_available");
  const failure = classifyUpstreamError(wrong);
  check("model_not_available → 不降级", failure.degradable === false, failure.kind);
}

console.log("");
console.log("七牛云：模型不在这个 key 的分组里");

{
  const { cooldownForFailure } = await import("../lib/router/account-cooldown.ts");
  const body = JSON.stringify({
    error: {
      code: "model_group_access_denied",
      message: "model glm-4.5 is not available in your assigned model groups",
    },
  });
  // 上游的样子：403，业务码说「这个模型不在你的分组里」。
  const denied = withBusinessCode(
    withUpstreamStatus(new AuthError("upstream HTTP 403", `七牛云上游返回 403：${body}`, 502), 403),
    "model_group_access_denied",
  );
  const failure = classifyUpstreamError(denied);
  check("403 + 分组拒绝 → 不降级", failure.degradable === false, failure.kind);
  check("403 + 分组拒绝 → model", failure.kind === "model", failure.kind);
  check(
    "403 + 分组拒绝 → 不写冷却",
    cooldownForFailure("acct-qiniu-denied", denied) === null,
    "写了冷却",
  );

  // 信封里没解出码时，正文里写着也算。
  const textOnly = withUpstreamStatus(
    new AuthError("upstream HTTP 403", `七牛云上游返回 403：${body}`, 502),
    403,
  );
  const textFailure = classifyUpstreamError(textOnly);
  check("正文里写着分组拒绝 → 不降级", textFailure.degradable === false, textFailure.kind);
  check("正文里写着分组拒绝 → model", textFailure.kind === "model", textFailure.kind);
  check(
    "正文里那个也不写冷却",
    cooldownForFailure("acct-qiniu-text", textOnly) === null,
    "写了冷却",
  );

  // 控制组：403 没有业务码 —— 那还是凭据被拒。不能把 403 一律放开。
  const plain = withUpstreamStatus(
    new AuthError("upstream HTTP 403", "七牛云上游返回 403：forbidden", 502),
    403,
  );
  const plainFailure = classifyUpstreamError(plain);
  check("403 没有业务码 → 降级", plainFailure.degradable === true, plainFailure.kind);
  check("403 没有业务码 → credential", plainFailure.kind === "credential", plainFailure.kind);
  check(
    "403 没有业务码 → 照旧写冷却",
    cooldownForFailure("acct-plain-403", plain) !== null,
    "没写冷却",
  );
}

console.log("");
console.log("七牛云：免费模型被限流");

{
  const { cooldownForFailure } = await import("../lib/router/account-cooldown.ts");
  // 上游的样子：429，业务码说是限流，正文说是这个免费模型被限流。
  const body = JSON.stringify({
    error: {
      code: "rate_limit_exceeded_error",
      message: "Too many requests for this free model",
    },
  });
  const limited = withBusinessCode(
    withUpstreamStatus(new AuthError("upstream HTTP 429", `七牛云上游返回 429：${body}`, 502), 429),
    "rate_limit_exceeded_error",
  );
  const failure = classifyUpstreamError(limited);
  check("429 + 免费模型 → 不降级", failure.degradable === false, failure.kind);
  check("429 + 免费模型 → model", failure.kind === "model", failure.kind);
  check(
    "429 + 免费模型 → 不写冷却",
    cooldownForFailure("acct-qiniu-free", limited) === null,
    "写了冷却",
  );

  // 控制组一：同一个业务码，但没说免费模型 —— 那还是普通的限流，照旧降级。
  const plainBody = JSON.stringify({
    error: {
      code: "rate_limit_exceeded_error",
      message: "Too many requests",
    },
  });
  const plain = withBusinessCode(
    withUpstreamStatus(new AuthError("upstream HTTP 429", `七牛云上游返回 429：${plainBody}`, 502), 429),
    "rate_limit_exceeded_error",
  );
  const plainFailure = classifyUpstreamError(plain);
  check("429 没提免费模型 → 降级", plainFailure.degradable === true, plainFailure.kind);
  check("429 没提免费模型 → rate-limit", plainFailure.kind === "rate-limit", plainFailure.kind);
  check(
    "429 没提免费模型 → 照旧写冷却",
    cooldownForFailure("acct-qiniu-plain-429", plain) !== null,
    "没写冷却",
  );

  // 控制组二：普通 429，什么业务码都没有 —— 同样是限流。
  const bare = withUpstreamStatus(new AuthError("upstream HTTP 429", "七牛云上游返回 429：too many requests", 502), 429);
  const bareFailure = classifyUpstreamError(bare);
  check("普通 429 → 降级", bareFailure.degradable === true, bareFailure.kind);
  check("普通 429 → rate-limit", bareFailure.kind === "rate-limit", bareFailure.kind);
}

console.log("");
console.log("不认识的策略");

{
  let caught: any = null;
  try {
    await selectProvider("typo" as any, three([], "ok"));
  } catch (e) {
    caught = e;
  }
  check("报错，不静默按降级跑", caught instanceof Error, String(caught?.message));
  check("说的是不认识的策略", String(caught?.hint ?? caught?.message).includes("生效策略"), String(caught?.hint));
}

console.log("");
console.log("日志里说得清");

{
  const wrapped = withUpstreamStatus(withBusinessCode(new AuthError("x", "x", 502), 2067), 429);
  check("分类与状态都在日志里", describeUpstreamError(wrapped).includes("HTTP 429"), describeUpstreamError(wrapped));
  check("业务码也在日志里", describeUpstreamError(wrapped).includes("2067"), describeUpstreamError(wrapped));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
