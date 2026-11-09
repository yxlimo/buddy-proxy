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
//   7. 重试：瞬时失败（5xx、连接）在**没有人可换时**没有次数上限 —— 唯一的刹车
//      是总时限；有人可换时试三次就换人；限流按上游说的那个窗口等，最多三回，
//      三回都等不到就停手抛错（那个账号确实被限住了，冷却照记）；超时不重试、
//      也不写冷却（那条错误原样交给客户端）；客户端走了不重试、不再打上游、
//      不记冷却。
//   8. 重试用完以后，客户端拿到的是上游自己的答复（状态码与正文），不是网关
//      编的一句话；上游 5xx 不写冷却（它不是「这个账号不能用了」）。
//   9. 「哪种失败记冷却」只有一处（lib/router/account-cooldown.ts）：派发失败
//      与流式结算对同一个超时是同一种待遇；连接断掉同样不记冷却（它不是
//      「这个账号不能用了」）；预算算上上游花掉的时间。
//  10. 「等过限流」那个标记只贴到「最终那个错误本身还是限流」的错误上，而且
//      只在没等满三回时贴：等满了说明那个账号真的被限住了，冷却要照记。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlatformAvailability } from "../lib/router/availability.ts";
import type { ProviderRow } from "../lib/providers.ts";

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
const { withBusinessCode, withCooldownUntil, withUpstreamStatus, upstreamStatusOf } = await import("../lib/upstream-status.ts");
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

// 同一个码，写成数字还是写成字符串，分类得一样。
//
// WorkBuddy 的渠道校验 11128 就是这么个码：它跟用哪个账号无关，换一个账号
// 再试必然再错一次。写成字符串的时候要是查不到表，就落回状态码那一条 ——
// 走 200 那条路时状态是 502，成了「上游挂了」，降级会把另一个账号也烧掉
// （2026-11-03，作者复查发现）。
{
  const asNumber = withBusinessCode(new AuthError("x", "x", 502), 11128);
  const asString = withBusinessCode(new AuthError("x", "x", 502), "11128");
  check("11128 → 不降级", classifyUpstreamError(asNumber).degradable === false, classifyUpstreamError(asNumber).kind);
  check("11128 → request", classifyUpstreamError(asNumber).kind === "request", classifyUpstreamError(asNumber).kind);
  check(
    "11128 写成字符串也一样",
    classifyUpstreamError(asString).degradable === false &&
      classifyUpstreamError(asString).kind === "request",
    classifyUpstreamError(asString).kind,
  );
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

console.log("");
console.log("重试：没有人可换时无限重试，有人可换时试三次就换人；限流最多等三回");

{
  const { runWithRetries, settlement, transientRetryPlan, upstreamStatusError, rateLimitWaitMs } =
    await import("../lib/router/upstreams/policy.ts");
  const { cooldownForFailure, rateWaitedOf } = await import("../lib/router/account-cooldown.ts");
  const { cooldownUntil, listCooldowns } = await import("../lib/cooldown.ts");
  const { ClientGoneError } = await import("../lib/router/deliver.ts");

  /** 一个上游错误：状态挂上去，分类器才认得出来。 */
  const statusError = (status: number, said = ""): Error =>
    withUpstreamStatus(new AuthError(`upstream HTTP ${status}${said}`, `上游返回 ${status}`, 502), status);

  /**
   * 一个 TPM 限流：正文里有 tpm 那个标记，上游说了「等这么多毫秒再来」。
   *
   * 引擎要的是毫秒级的 retry-after 而不是分钟：测试不能真的等一分钟。
   * `at` 是钟：注入的钟下「等多久」才算得准（真钟差几毫秒，断言就会飘）。
   */
  const tpmLimit = (waitMs: number, at: () => number = Date.now): Error => {
    const error = statusError(429, " rate_limit_tpm_exceeded");
    return withCooldownUntil(error, at() + waitMs);
  };

  /** 一个网络错误：名字与 code 是分类器认得的那种。 */
  const networkError = (name: string, code = ""): Error => {
    const error = new Error(`假上游的 ${name}`);
    error.name = name;
    if (code) (error as any).code = code;
    return error;
  };

  /** 一个假钟：sleep 不真的等，只把时间推过去。 */
  const fakeClock = () => {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      /** 上游自己花掉的时间。 */
      spent: (ms: number) => {
        t += ms;
      },
      slept,
      at: () => t,
    };
  };

  /** 记下这期间 console.log 打出来的 [ROUTE] 行，其他的照旧打出来。 */
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]) => {
    const line = parts.map(String).join(" ");
    if (line.startsWith("[ROUTE]")) logs.push(line);
    else realLog(...parts);
  };
  const stopLogging = () => {
    console.log = realLog;
  };

  // 1. 503 一次后成功：客户端拿到答复，冷却没有。
  {
    let calls = 0;
    const started = Date.now();
    const value = await runWithRetries({ id: "acct-503-once" }, "瞬时", async () => {
      calls += 1;
      if (calls < 2) throw statusError(503);
      return "answer";
    });
    const elapsed = Date.now() - started;
    check("503 一次后成功：答案是第二次的", value === "answer", String(value));
    check("503 一次后成功：上游被叫了两次", calls === 2, String(calls));
    check("503 一次后成功：等过 300ms", elapsed >= 280, `${elapsed}ms`);
  }

  // 2. 500 两次后成功：任何 5xx 都重试，不只是 503。
  {
    let calls = 0;
    const started = Date.now();
    const value = await runWithRetries({ id: "acct-500-twice" }, "瞬时", async () => {
      calls += 1;
      if (calls < 3) throw statusError(500);
      return "answer";
    });
    const elapsed = Date.now() - started;
    check("500 两次后成功：答案是第三次的", value === "answer", String(value));
    check("500 两次后成功：上游被叫了三次", calls === 3, String(calls));
    check("500 两次后成功：间隔 300ms + 900ms", elapsed >= 1150, `${elapsed}ms`);
  }

  // 3. 连续四次 503 之后成功：没有人可换时瞬时失败**没有次数上限**。
  //
  //    上游抽一下就好了，所以一直试到成功为止 —— 唯一的刹车是总时限。
  {
    const clock = fakeClock();
    let calls = 0;
    const value = await runWithRetries(
      { id: "acct-503-four" },
      "瞬时",
      async () => {
        calls += 1;
        if (calls < 5) throw statusError(503);
        return "answer";
      },
      { budgetMs: 60_000, now: clock.now, sleep: clock.sleep, unbounded: true },
    );
    check("连续四次 503 后成功：答案是第五次的", value === "answer", String(value));
    check("连续四次 503 后成功：上游被叫了五次", calls === 5, String(calls));
    check(
      "连续四次 503 后成功：间隔是 300ms、900ms、2700ms、2700ms",
      JSON.stringify(clock.slept) === JSON.stringify([300, 900, 2700, 2700]),
      JSON.stringify(clock.slept),
    );
  }

  // 4. 连续十二次 503 之后成功：还是没有次数上限。
  {
    const clock = fakeClock();
    let calls = 0;
    const value = await runWithRetries(
      { id: "acct-503-twelve" },
      "瞬时",
      async () => {
        calls += 1;
        if (calls < 13) throw statusError(503);
        return "answer";
      },
      { budgetMs: 60_000, now: clock.now, sleep: clock.sleep, unbounded: true },
    );
    check("连续十二次 503 后成功：答案是第十三次的", value === "answer", String(value));
    check("连续十二次 503 后成功：上游被叫了十三次", calls === 13, String(calls));
  }

  // 5. 一直失败到总时限：停手，客户端拿到的是**上游那份**答复。
  //
  //    网关自己编的一句话（「上游在冷却」）会把上游真的发生了什么盖掉：状态码
  //    与正文都照上游的说。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-until-deadline" },
        "瞬时",
        async () => {
          calls += 1;
          throw upstreamStatusError(503, '{"error":{"message":"upstream is down"}}', "假上游 ");
        },
        { budgetMs: 5_000, now: clock.now, sleep: clock.sleep, unbounded: true },
      );
    } catch (e) {
      caught = e;
    }
    check("一直失败到总时限：停手了（没有再打上游）", calls > 1 && clock.at() <= 5_000, `${calls} 次，${clock.at()}ms`);
    check("一直失败到总时限：客户端拿到的是上游的状态码 503", caught?.status === 503, String(caught?.status));
    check(
      "一直失败到总时限：客户端拿到的是上游自己的正文",
      String(caught?.hint ?? "").includes("upstream is down"),
      String(caught?.hint),
    );
    check(
      "一直失败到总时限：不是网关自己编的「cooling down」",
      !String(caught?.hint ?? "").includes("cooling down") && !String(caught?.message ?? "").includes("cooling down"),
      `${caught?.message} / ${caught?.hint}`,
    );
    check("一直失败到总时限：上游自己的状态还留在错误上", upstreamStatusOf(caught) === 503, String(upstreamStatusOf(caught)));
    // 上游 5xx 不是账号的错：冷却表里不该有这个账号的行。
    const settle = settlement();
    settle.bind("acct-until-deadline", "瞬时");
    settle.failure(caught);
    check(
      "一直失败到总时限：冷却表里没有这个账号的行",
      listCooldowns().every((row: any) => row.providerId !== "acct-until-deadline"),
      JSON.stringify(listCooldowns()),
    );
  }

  // 6. 退避阶梯：300ms、900ms、2700ms；走完以后一直是 2700ms。
  {
    const plan = transientRetryPlan();
    check(
      "阶梯是三档：300ms、900ms、2700ms",
      JSON.stringify(plan.delaysMs) === JSON.stringify([300, 900, 2700]),
      JSON.stringify(plan.delaysMs),
    );
    check("阶梯走完以后一直是最后一档", plan.repeatLastMs === 2700, String(plan.repeatLastMs));
    check("阶梯里没有次数上限了（唯一的刹车是总时限）", !("maxAttempts" in plan), JSON.stringify(plan));
  }

  // 7. 连接断掉：与 5xx 同一类，重试同一个账号。
  {
    let calls = 0;
    const value = await runWithRetries({ id: "acct-conn" }, "瞬时", async () => {
      calls += 1;
      if (calls < 2) throw networkError("Error", "ECONNRESET");
      return "answer";
    });
    check("连接断了之后重试：成功", value === "answer", String(value));
    check("连接断了之后重试：两次", calls === 2, String(calls));
  }

  // 8. 超时：不重试，一次就结束。超时说的是这一条请求等太久了，再等一次只是
  //    再久一次 —— 答复就是那条超时错误，客户端自己决定要不要重发。
  {
    let calls = 0;
    const timedOut = networkError("TimeoutError");
    let caught: any = null;
    try {
      await runWithRetries({ id: "acct-timeout" }, "瞬时", async () => {
        calls += 1;
        throw timedOut;
      });
    } catch (e) {
      caught = e;
    }
    check("超时：上游只被叫了一次（不重试）", calls === 1, String(calls));
    check("超时：抛给客户端的就是超时那条错误", caught === timedOut, String(caught?.message));
    check(
      "超时：不写冷却（记账那一层的答案就是 null）",
      cooldownForFailure("acct-timeout", timedOut) === null,
      JSON.stringify(cooldownForFailure("acct-timeout", timedOut)),
    );
  }

  // 9. 不重试的那几类：请求本身的问题、凭据被拒、客户端走了。
  //
  //    限流不在这里了：上游说了「过多久再来」就等它（见 11），上游什么也没说
  //    也等默认的 30 秒（见 9.1）。
  {
    const noRetry: [string, Error][] = [
      ["400 请求本身的问题", statusError(400)],
      ["401 凭据被拒", statusError(401)],
      ["402 额度用尽", statusError(402)],
      ["客户端走了", new ClientGoneError()],
      ["说不清的错", new Error("something odd")],
    ];
    for (const [name, error] of noRetry) {
      let calls = 0;
      let caught: any = null;
      try {
        await runWithRetries({ id: "acct-no-retry" }, "瞬时", async () => {
          calls += 1;
          throw error;
        });
      } catch (e) {
        caught = e;
      }
      check(`${name}：不重试（只叫了一次）`, calls === 1, String(calls));
      check(`${name}：抛的就是那个错`, caught === error, String(caught?.message));
    }
  }

  // 9.1 限流但上游什么也没说（没有头、正文里也没有时间）：等默认的 30 秒。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    const limited = statusError(429);
    try {
      await runWithRetries(
        { id: "acct-rate-default" },
        "限流",
        async () => {
          calls += 1;
          throw limited;
        },
        { budgetMs: 200_000, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check(
      "限流但上游没说要等多久：上游被叫了四次（等三回 + 最后一回）",
      calls === 4,
      String(calls),
    );
    check(
      "限流但上游没说要等多久：等了三次，每次 30 秒",
      JSON.stringify(clock.slept) === JSON.stringify([30_000, 30_000, 30_000]),
      JSON.stringify(clock.slept),
    );
    check(
      "限流但上游没说要等多久：抛的是 429",
      String(caught?.message ?? "").startsWith("upstream HTTP 429"),
      String(caught?.message),
    );
  }

  // 10. 上游说了「过两分半再来」的 TPM 限流：等不起，也不是瞬时失败 —— 一次就结束。
  {
    let calls = 0;
    let caught: any = null;
    const tpm = withCooldownUntil(statusError(429), Date.now() + 200_000);
    withBusinessCode(tpm, "rate_limit_tpm_exceeded");
    try {
      await runWithRetries({ id: "acct-tpm-long" }, "瞬时", async () => {
        calls += 1;
        throw tpm;
      });
    } catch (e) {
      caught = e;
    }
    check("429 + 200 秒：只叫了一次（等不起，也不叠瞬时重试）", calls === 1, String(calls));
    check("429 + 200 秒：抛的就是那个错", caught === tpm, String(caught?.message));
  }

  // 11. 429 + retry-after 5 秒：等三回，第四次成功。
  //
  //     等多久照上游说的：不取整、不加秒。累计 15 秒。
  {
    const clock = fakeClock();
    let calls = 0;
    const value = await runWithRetries(
      { id: "acct-tpm-three-waits" },
      "限流",
      async () => {
        calls += 1;
        if (calls < 4) throw tpmLimit(5_000, clock.now);
        return "answer";
      },
      { budgetMs: 60_000, now: clock.now, sleep: clock.sleep },
    );
    check("限流等三回：第四次成功了", value === "answer", String(value));
    check("限流等三回：上游被叫了四次", calls === 4, String(calls));
    check("限流等三回：等了恰好三次", clock.slept.length === 3, JSON.stringify(clock.slept));
    check(
      "限流等三回：每次照上游说的等 5 秒（不取整、不加秒）",
      JSON.stringify(clock.slept) === JSON.stringify([5_000, 5_000, 5_000]),
      JSON.stringify(clock.slept),
    );
    check(
      "限流等三回：一共等了 15 秒",
      clock.slept.reduce((sum, ms) => sum + ms, 0) === 15_000,
      String(clock.slept.reduce((sum, ms) => sum + ms, 0)),
    );
  }

  // 12. 连续四次 429：第四回不再等，抛错。
  //
  //     三回都等不到 —— 这个账号是真的被限住了，不是抖一下。所以「等过了」
  //     那个标记不贴：冷却照记（不记的话它会被一直选中重试）。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-tpm-four" },
        "限流",
        async () => {
          calls += 1;
          throw tpmLimit(5_000, clock.now);
        },
        { budgetMs: 60_000, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check("连续四次 429：上游被叫了四次", calls === 4, String(calls));
    check("连续四次 429：只等了三次", clock.slept.length === 3, JSON.stringify(clock.slept));
    check(
      "连续四次 429：抛的是 429",
      String(caught?.message ?? "").startsWith("upstream HTTP 429"),
      String(caught?.message),
    );
    check("连续四次 429：标记不在错误上（冷却要照记）", rateWaitedOf(caught) === false, "标记贴错了");
    check(
      "连续四次 429：冷却照记",
      cooldownForFailure("acct-tpm-four", caught) !== null,
      JSON.stringify(cooldownForFailure("acct-tpm-four", caught)),
    );
    // 落到冷却表这一步：理由是限流。
    const settle = settlement();
    settle.bind("acct-tpm-four", "限流");
    settle.failure(caught);
    const row = listCooldowns().find((r: any) => r.providerId === "acct-tpm-four");
    check("连续四次 429：冷却表里记了这个账号", row !== undefined, JSON.stringify(listCooldowns()));
    check("连续四次 429：理由是限流", row?.reason === "rate-limit", String(row?.reason));
  }

  // 12.1 预算用完时停手：三轮窗口都等完了还是限流 —— 那个账号确实被限住了。
  //
  //      预算 180 秒、上游每次都说「等 60 秒」：三轮刚好把预算用完，第四轮
  //      开始前发现没时间了。这时候最终那个错误不能带「等过了限流窗口」的
  //      标记：那个账号还在限流，冷却要照记（不记的话下一个请求又挑它，
  //      再白等一轮）。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-budget-exhausted" },
        "限流",
        async () => {
          calls += 1;
          // 上游每次都说「等 60 秒再来」。
          throw withCooldownUntil(statusError(429), clock.now() + 60_000);
        },
        { budgetMs: 180_000, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check("预算用完：上游被叫了三次", calls === 3, String(calls));
    check(
      "预算用完：等满三轮才停",
      JSON.stringify(clock.slept) === JSON.stringify([60_000, 60_000, 60_000]),
      JSON.stringify(clock.slept),
    );
    check(
      "预算用完：最终那个错误不带 rateWaited 标记（那个账号还在限流）",
      rateWaitedOf(caught) === false,
      "标记贴错了",
    );
    check(
      "预算用完：冷却照记（那个账号还在限流）",
      cooldownForFailure("acct-budget-exhausted", caught) !== null,
      JSON.stringify(cooldownForFailure("acct-budget-exhausted", caught)),
    );
  }

  // 13. 429 + retry-after 200 秒：等不起，立刻抛错（一次也不多等）。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-tpm-too-long" },
        "限流",
        async () => {
          calls += 1;
          throw tpmLimit(200_000, clock.now);
        },
        { budgetMs: 60_000, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check("429 + 200 秒：只叫了一次", calls === 1, String(calls));
    check("429 + 200 秒：一次也没等", clock.slept.length === 0, JSON.stringify(clock.slept));
    check(
      "429 + 200 秒：抛的就是那个错",
      String(caught?.message ?? "").startsWith("upstream HTTP 429"),
      String(caught?.message),
    );
  }

  // 14. 总时限管着所有等待：等到手也过了这一轮的总时限，就不等也不再试。
  //
  //     第一轮等到了窗口，第二轮的窗口等不起 —— 那一轮**根本没等**。所以最终
  //     那个错误不能带「等过了限流窗口」的标记：那个账号还在限流，冷却要照记
  //     （不记的话下一个请求又会挑它，再白等一轮）。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-deadline" },
        "预算",
        async () => {
          calls += 1;
          // 第一次先花掉 1 秒，第二次上游说「等 59.8 秒」—— 等到手就过了时限。
          throw tpmLimit(calls === 1 ? 1_000 : 59_800, clock.now);
        },
        { budgetMs: 60_000, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check("总时限：不再等第二次（上游被叫了两次）", calls === 2, String(calls));
    check(
      "总时限：抛的是第二次那个 429",
      String(caught?.message ?? "").startsWith("upstream HTTP 429"),
      String(caught?.message),
    );
    check("总时限：只等了那一次", clock.slept.length === 1, JSON.stringify(clock.slept));
    check(
      "总时限：最后一轮没等 → 最终那个错误不带 rateWaited 标记",
      rateWaitedOf(caught) === false,
      "标记贴错了",
    );
    check(
      "总时限：冷却照记（那个账号还在限流）",
      cooldownForFailure("acct-deadline", caught) !== null,
      JSON.stringify(cooldownForFailure("acct-deadline", caught)),
    );
  }

  // 15. 流式结算那条路：同一个超时也是不写冷却。
  //
  //     判据以前只挂在派发的那一处（onAttempt），流式答复在 underPolicy 返回之后
  //     才结算（Settlement.failure），它走的是另一个调用点 —— 同一个超时在那里会
  //     被记成冷却。判据沉到 cooldownForFailure 之后，两边问的是同一个函数。
  //
  //     链式到落库这一步：decision 为 null 就不写，不需要另判一遍。
  {
    const streamed = networkError("TimeoutError");
    const settle = settlement();
    settle.bind("acct-stream-timeout", "流式");
    settle.failure(streamed);
    check(
      "流式结算：超时之后冷却表里没有这个账号的行",
      cooldownUntil("acct-stream-timeout") === null,
      String(cooldownUntil("acct-stream-timeout")),
    );
    // 连接断掉也不记账：连接被上游掐断不是「这个账号不能用了」。
    const broke = networkError("Error", "ECONNRESET");
    const settle2 = settlement();
    settle2.bind("acct-stream-connection", "流式");
    settle2.failure(broke);
    check(
      "流式结算：连接断掉之后冷却表里没有这个账号的行",
      cooldownUntil("acct-stream-connection") === null,
      String(cooldownUntil("acct-stream-connection")),
    );
    // 对照组：凭据被拒照旧记冷却 —— 别把「不写冷却」做成一律不写。
    const settle3 = settlement();
    settle3.bind("acct-stream-refused", "流式");
    settle3.failure(statusError(401));
    check(
      "流式结算：凭据被拒照旧记冷却（对照组）",
      cooldownUntil("acct-stream-refused") !== null,
      String(cooldownUntil("acct-stream-refused")),
    );
  }

  // 16. 预算要算上上游自己花掉的时间。
  //
  //     只看「等之前会不会超时限」的话，一次 30s 的超时不算账，三次就能花掉
  //     90s：60s 的预算名不副实。每轮尝试开始前看剩余多少，没了就不打了。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-call-time" },
        "预算",
        async () => {
          calls += 1;
          // 这一次上游自己花掉 500ms（现实里是超时、慢上游）。
          clock.spent(500);
          throw statusError(503);
        },
        { budgetMs: 800, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check("预算算上上游的时间：上游只被叫了一次（不是三次）", calls === 1, String(calls));
    check("预算算上上游的时间：停手时正好花到预算（800ms）", clock.at() === 800, `${clock.at()}ms`);
    check("预算算上上游的时间：抛的还是上游那个错", caught?.message === "upstream HTTP 503", String(caught?.message));
  }

  // 17. 客户端走了：不重试、不再打上游、不记冷却。
  {
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries({ id: "acct-client-gone" }, "瞬时", async () => {
        calls += 1;
        throw new ClientGoneError();
      });
    } catch (e) {
      caught = e;
    }
    check("客户端走了：上游只被叫了一次（不再打）", calls === 1, String(calls));
    check("客户端走了：抛的就是那个错", caught instanceof ClientGoneError, String(caught?.message));
    check(
      "客户端走了：不记冷却",
      cooldownForFailure("acct-client-gone", caught) === null,
      JSON.stringify(cooldownForFailure("acct-client-gone", caught)),
    );
    const settle = settlement();
    settle.bind("acct-client-gone", "瞬时");
    settle.failure(caught);
    check(
      "客户端走了：冷却表里没有这个账号的行",
      listCooldowns().every((row: any) => row.providerId !== "acct-client-gone"),
      JSON.stringify(listCooldowns()),
    );
  }

  // 19. 无限重试只在「没有别的账号可换」时启用。
  //
  //     单账号的平台（opencode-go 那种）：上游抽一下，多试几次就通 → 无限重试。
  //     降级的平台：第一个账号一直 5xx 时要尽快换人，不能把它打满 180 秒。
  {
    const { underPolicy } = await import("../lib/router/upstreams/policy.ts");
    const { addAccount, provider, updateProvider } = await import("../lib/providers.ts");
    const { setPlatformPolicy } = await import("../lib/platforms.ts");

    // 降级策略：这个平台的生效策略存在 platform_policy 表里。
    setPlatformPolicy("qoder", "fallback");

    const madeA = addAccount({ platform: "qoder", alias: "重试用的甲" });
    const madeB = addAccount({ platform: "qoder", alias: "重试用的乙" });
    if (!madeA.ok || !madeA.id || !madeB.ok || !madeB.id) {
      throw new Error(`加不了 Qoder 的账号：${madeA.message} ${madeB.message}`);
    }
    // 权重决定谁先试：甲先。
    updateProvider(String(madeA.id), { weight: 900 });
    updateProvider(String(madeB.id), { weight: 100 });
    const rowA = provider(String(madeA.id));
    const rowB = provider(String(madeB.id));
    if (!rowA || !rowB) throw new Error("找不到刚建的两个 Qoder 账号");

    /** 一份算好的可用性：这几个账号现在就能接。 */
    function availabilityOf(rows: ProviderRow[]): PlatformAvailability {
      return {
        platform: "qoder",
        kind: "qoder",
        state: "ready",
        usable: rows,
        serving: rows,
        cooling: new Map<string, number>(),
        spent: new Map<string, number | null>(),
        accounts: rows.length,
        rows,
        on: rows.length,
        advice: "测试用的可用性",
        catalog: [],
        ids: [],
        untilMs: null,
        reason: "测试用的可用性",
      };
    }

    // 19.1 单账号：上游连着十二次 503，第十三次成功。
    //      没有人可换 → 无限重试（上游抽一下，多试几次就通）。
    {
      const clock = fakeClock();
      let calls = 0;
      const value = await underPolicy(
        "qoder",
        "单账号",
        async () => {
          calls += 1;
          if (calls < 13) throw statusError(503);
          return "answer";
        },
        undefined,
        availabilityOf([rowA]),
        { now: clock.now, sleep: clock.sleep },
      );
      check("单账号：连续十二次 503 之后成功", value === "answer", String(value));
      check("单账号：上游被叫了十三次（无限重试仍生效）", calls === 13, String(calls));
    }

    // 19.2 降级：第一个账号一直 503 → 只试三次就换人。
    {
      const clock = fakeClock();
      const calls: string[] = [];
      const value = await underPolicy(
        "qoder",
        "降级",
        async (account) => {
          calls.push(account.id);
          if (account.id === rowA.id) throw statusError(503);
          return "answer from b";
        },
        undefined,
        availabilityOf([rowA, rowB]),
        { now: clock.now, sleep: clock.sleep },
      );
      const aCalls = calls.filter((id) => id === rowA.id).length;
      const bCalls = calls.filter((id) => id === rowB.id).length;
      check("降级：第一个账号只被叫了三次", aCalls === 3, String(aCalls));
      check("降级：换到第二个账号并成功", value === "answer from b", String(value));
      check("降级：第二个账号只被叫了一次", bCalls === 1, String(bCalls));
      check("降级：整轮不到三秒", clock.at() < 3_000, `${clock.at()}ms`);
    }

    // 19.3 有人可换的时候：试三次就停手，客户端拿到的是上游自己的答复。
    {
      const clock = fakeClock();
      let calls = 0;
      let caught: any = null;
      try {
        await runWithRetries(
          { id: "acct-bounded" },
          "瞬时",
          async () => {
            calls += 1;
            throw upstreamStatusError(503, '{"error":{"message":"upstream is down"}}', "假上游 ");
          },
          { budgetMs: 60_000, now: clock.now, sleep: clock.sleep },
        );
      } catch (e) {
        caught = e;
      }
      check("有人可换：只试了三次", calls === 3, String(calls));
      check(
        "有人可换：等的间隔是 300ms、900ms",
        JSON.stringify(clock.slept) === JSON.stringify([300, 900]),
        JSON.stringify(clock.slept),
      );
      check("有人可换：客户端拿到的是上游的状态码 503", caught?.status === 503, String(caught?.status));
      check(
        "有人可换：正文也是上游自己的",
        String(caught?.hint ?? "").includes("upstream is down"),
        String(caught?.hint),
      );
    }
  }

  // 20. 只有限流才等：402（额度见底）带着 retry-after 也不等。
  //
  //     上游给的 retry-after 说的是这个**请求**可以再来一次，不是这个**账号**
  //     可以再来一次。额度见底等多久都一样：等下去只是把这一轮的时间吃掉，
  //     fallback 换账号被挤掉。所以照旧交给策略（记冷却、换账号）。
  {
    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    // 402 + retry-after 30 秒：分类不是限流。
    const spent = withCooldownUntil(statusError(402), clock.now() + 30_000);
    try {
      await runWithRetries(
        { id: "acct-402-retry-after" },
        "额度",
        async () => {
          calls += 1;
          throw spent;
        },
        { budgetMs: 60_000, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check("402 带 retry-after：一次也没等", clock.slept.length === 0, JSON.stringify(clock.slept));
    check("402 带 retry-after：上游只被叫了一次", calls === 1, String(calls));
    check("402 带 retry-after：抛的就是那个错", caught === spent, String(caught?.message));
    check(
      "402 带 retry-after：冷却照记（额度见底不是等一等就好）",
      cooldownForFailure("acct-402-retry-after", caught) !== null,
      JSON.stringify(cooldownForFailure("acct-402-retry-after", caught)),
    );
  }

  // 20.1 同一个判据的单元：rateLimitWaitMs 只对限流给数。
  {
    const spent = withCooldownUntil(statusError(402), Date.now() + 30_000);
    check(
      "402 带 retry-after → 不等（null）",
      rateLimitWaitMs(spent) === null,
      String(rateLimitWaitMs(spent)),
    );
    const limited = withCooldownUntil(statusError(429), Date.now() + 30_000);
    check(
      "429 带 retry-after → 等（对照组）",
      rateLimitWaitMs(limited) !== null,
      String(rateLimitWaitMs(limited)),
    );
  }

  stopLogging();

  // 18. 日志：每次重试一行，最后一次失败照旧交给策略。
  {
    const said = logs.filter((line) => line.includes("retry"));
    check("日志里数得清重试了几次", said.some((line) => line.includes("retry 1 in 300ms")), said.join(" | "));
    check("日志里说了是哪个账号", said.every((line) => line.includes("account=")), said.join(" | "));
    check(
      "日志里说了上游答的什么（server HTTP 503）",
      said.some((line) => line.includes("server HTTP 503")),
      said.join(" | "),
    );
    check("第二次重试也在日志里（900ms）", said.some((line) => line.includes("retry 2 in 900ms")), said.join(" | "));
    check(
      "日志里说了这一轮的总时限用完了",
      logs.some((line) => line.includes("out of time")),
      logs.join(" | "),
    );
    check(
      "日志里说了等不到头（总时限）就不等",
      logs.some((line) => line.includes("no time left for a")),
      logs.join(" | "),
    );
    check(
      "日志里说了限流等的是第几回",
      logs.some((line) => line.includes("waiting 5s then retrying (wait 1/3)")),
      logs.join(" | "),
    );
    check(
      "日志里说了三回都等不到就不等了",
      logs.some((line) => line.includes("is still rate limited after 3 waits")),
      logs.join(" | "),
    );
  }
}

// Close the database before removing its directory: on Windows an open
// file cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
