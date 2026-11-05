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
//   7. 瞬时重试与限流等待共用一格预算：一个账号最多三次上游调用，总时限管着
//      所有等待；超时不重试、也不写冷却（那条错误原样交给客户端）。
//   8. 「哪种失败记冷却」只有一处（lib/router/account-cooldown.ts）：派发失败
//      与流式结算对同一个超时是同一种待遇；预算算上上游花掉的时间；退避阶梯与
//      次数上限绑在一个不变量里（超出阶梯直接报错，不做静默兜底）。
//   9. 「等过限流」那个标记只贴到「最终那个错误本身还是限流」的错误上：先 429
//      后 401 的账号要按凭据被拒记冷却，不能因为等过一次窗口就永不冷却。

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
const { withBusinessCode, withCooldownUntil, withUpstreamStatus } = await import("../lib/upstream-status.ts");
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
console.log("瞬时失败：同一个账号上再试一次（5xx / 连接 / 超时）");

{
  const { runWithRetries, settlement, transientRetryPlan } = await import("../lib/router/upstreams/policy.ts");
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
   */
  const tpmLimit = (waitMs: number): Error => {
    const error = statusError(429, " rate_limit_tpm_exceeded");
    return withCooldownUntil(error, Date.now() + waitMs);
  };

  /** 一个网络错误：名字与 code 是分类器认得的那种。 */
  const networkError = (name: string, code = ""): Error => {
    const error = new Error(`假上游的 ${name}`);
    error.name = name;
    if (code) (error as any).code = code;
    return error;
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

  // 3. 503 三次都失败：三次为止，抛出去的是最后那个错误。
  {
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries({ id: "acct-503-thrice" }, "瞬时", async () => {
        calls += 1;
        throw statusError(503);
      });
    } catch (e) {
      caught = e;
    }
    check("503 三次都失败：上游被叫了三次", calls === 3, String(calls));
    check("503 三次都失败：抛的是上游那个错", caught?.message === "upstream HTTP 503", String(caught?.message));
  }

  // 4. 连接断掉：与 5xx 同一类，重试同一个账号。
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

  // 5. 超时：不重试，一次就结束。超时说的是这一条请求等太久了，再等一次只是
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

  // 6. 不重试的那几类：请求本身的问题、凭据被拒、限流、客户端走了。
  {
    const noRetry: [string, Error][] = [
      ["400 请求本身的问题", statusError(400)],
      ["401 凭据被拒", statusError(401)],
      ["402 额度用尽", statusError(402)],
      ["429 限流", statusError(429)],
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

  // 7. 上游说了「120 秒后再来」的 TPM 限流：等不起，也不是瞬时失败 —— 一次就结束。
  {
    let calls = 0;
    let caught: any = null;
    const tpm = withCooldownUntil(statusError(429), Date.now() + 120_000);
    withBusinessCode(tpm, "rate_limit_tpm_exceeded");
    try {
      await runWithRetries({ id: "acct-tpm-long" }, "瞬时", async () => {
        calls += 1;
        throw tpm;
      });
    } catch (e) {
      caught = e;
    }
    check("429 + 120 秒：只叫了一次（不叠瞬时重试）", calls === 1, String(calls));
    check("429 + 120 秒：抛的就是那个错", caught === tpm, String(caught?.message));
  }

  // 8. 一个账号上一共就打三次上游：「等限流窗口再来」也算一次尝试。
  //
  //    两套计数各数各的话，这个剧本（限流、5xx、限流、5xx、限流）会打到五次。
  {
    let calls = 0;
    let caught: any = null;
    const plan = ["tpm", "server", "tpm", "server", "tpm"];
    try {
      await runWithRetries({ id: "acct-budget" }, "预算", async () => {
        calls += 1;
        throw plan[calls - 1] === "tpm" ? tpmLimit(20) : statusError(503);
      });
    } catch (e) {
      caught = e;
    }
    check("总次数：上游被叫了恰好三次（不是五次）", calls === 3, String(calls));
    check("总次数：抛出去的是第三次那个错", caught !== null, String(caught?.message));
  }

  // 9. 先限流、后凭据被拒：最终那个错误**不是**限流，标记就不该贴上去。
  //
  //    贴上去的话，记账那一层会把它当成「在等自己的窗口」→ 不写冷却 → 坏凭据
  //    的账号永远被选中重试。这条是这次修复的判别力所在。
  {
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries({ id: "acct-waited-then-refused" }, "预算", async () => {
        calls += 1;
        if (calls === 1) throw tpmLimit(20);
        throw statusError(401);
      });
    } catch (e) {
      caught = e;
    }
    check("先限流后被拒：上游被叫了两次（等完窗口的那一次也算）", calls === 2, String(calls));
    check("先限流后被拒：抛的是最后那个错", caught?.message === "upstream HTTP 401", String(caught?.message));
    check("先限流后被拒：标记没贴到被拒那个错上", rateWaitedOf(caught) === false, "标记贴错了");
    check(
      "先限流后被拒：按凭据被拒记账（结论不是 null）",
      cooldownForFailure("acct-waited-then-refused", caught) !== null,
      JSON.stringify(cooldownForFailure("acct-waited-then-refused", caught)),
    );
    // 落到冷却表这一步：结算那条路写下去的理由必须是 credential。
    const settle = settlement();
    settle.bind("acct-waited-then-refused", "预算");
    settle.failure(caught);
    const row = listCooldowns().find((r: any) => r.providerId === "acct-waited-then-refused");
    check("先限流后被拒：冷却表里记了这个账号", row !== undefined, JSON.stringify(listCooldowns()));
    check("先限流后被拒：理由是按凭据被拒（credential）", row?.reason === "credential", String(row?.reason));
    // 对照组：没被跟过的 401 本来就要记冷却 —— 说明上面的结论不是「一律不记」。
    check(
      "先限流后被拒：没等过的 401 照旧记冷却（对照组）",
      cooldownForFailure("acct-refused-alone", statusError(401)) !== null,
      "对照组不成立",
    );
  }

  // 10. 回归：等过窗口之后仍然是限流 → 最终那个 429 贴着标记，不记冷却。
  //     这是标记本来的语义（这个限流是我们替它等过的），不能因为上面的修复丢掉。
  {
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries({ id: "acct-tpm-thrice" }, "预算", async () => {
        calls += 1;
        throw tpmLimit(20);
      });
    } catch (e) {
      caught = e;
    }
    check("限流三次：上游被叫了三次", calls === 3, String(calls));
    check("限流三次：抛的是 429", caught?.message?.startsWith("upstream HTTP 429") === true, String(caught?.message));
    check("限流三次：标记贴上了", rateWaitedOf(caught) === true, "标记丢了");
    check(
      "限流三次：不写冷却",
      cooldownForFailure("acct-tpm-thrice", caught) === null,
      JSON.stringify(cooldownForFailure("acct-tpm-thrice", caught)),
    );
    // 对照组：同一个 429 没有标记时是要记冷却的（限流一分钟）。
    check(
      "限流三次：不贴标记的话本来会记冷却（对照组）",
      cooldownForFailure("acct-tpm-thrice", tpmLimit(20)) !== null,
      "对照组不成立",
    );
  }

  // 11. 总时限管着所有等待：等到手也过了一分钟，就不等也不再试。
  {
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries({ id: "acct-deadline" }, "预算", async () => {
        calls += 1;
        // 第一次先花掉 1 秒，第二次上游说「等 59.8 秒」—— 等到手就过了一分钟。
        throw tpmLimit(calls === 1 ? 1_000 : 59_800);
      });
    } catch (e) {
      caught = e;
    }
    check("总时限：不再等第二次（上游被叫了两次）", calls === 2, String(calls));
    check("总时限：抛的是第二次那个 429", caught?.message?.startsWith("upstream HTTP 429") === true, String(caught?.message));
  }

  // 11. 流式结算那条路：同一个超时也是不写冷却。
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
    // 对照组：同一个结算句柄（换了账号）遇到连接断掉，该记的还是记 ——
    // 别把「不写冷却」做成一律不写。
    const broke = networkError("Error", "ECONNRESET");
    const settle2 = settlement();
    settle2.bind("acct-stream-connection", "流式");
    settle2.failure(broke);
    check(
      "流式结算：连接断掉照旧记冷却（对照组）",
      cooldownUntil("acct-stream-connection") !== null,
      String(cooldownUntil("acct-stream-connection")),
    );
  }

  /** 一个假锟：sleep 不真的等，只把时间推过去。 */
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

  // 12. 预算要算上上游自己花掉的时间。
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

  // 13. 间隔档数与次数上限绑在一个不变量里：档数 = 次数上限 - 1。
  //
  //     次数被抬到阶梯之外时不做静默兜底（以前 .at(-1) 会复用 900ms，把配
  //     置错误藏起来）；正常路径上取不到 undefined，因为上限是从档数算出来的。
  {
    const plan = transientRetryPlan();
    check("间隔档数 = 次数上限 - 1", plan.delaysMs.length === plan.maxAttempts - 1, JSON.stringify(plan));

    const clock = fakeClock();
    let calls = 0;
    let caught: any = null;
    try {
      await runWithRetries(
        { id: "acct-more-attempts" },
        "退界",
        async () => {
          calls += 1;
          throw statusError(503);
        },
        { maxAttempts: plan.maxAttempts + 1, now: clock.now, sleep: clock.sleep },
      );
    } catch (e) {
      caught = e;
    }
    check(
      "超出阶梯：退避的每一档都来自阶梯（没有静默复用）",
      JSON.stringify(clock.slept) === JSON.stringify([...plan.delaysMs]),
      JSON.stringify(clock.slept),
    );
    check(
      "超出阶梯：报的是配置错误，不是静默 sleep",
      String(caught?.message).includes("has no delay"),
      String(caught?.message),
    );
    check("超出阶梯：没有 sleep(0)", clock.slept.every((ms) => Number.isFinite(ms) && ms > 0), JSON.stringify(clock.slept));
    check("超出阶梯：阶梯用完就停（上游被叫了三次）", calls === 3, String(calls));
  }

  stopLogging();

  // 7. 日志：每次重试一行，最后一次失败照旧交给策略。
  {
    const said = logs.filter((line) => line.includes("retry"));
    check("日志里数得清重试了几次", said.some((line) => line.includes("retry 1/2 in 300ms")), said.join(" | "));
    check("日志里说了是哪个账号", said.every((line) => line.includes("account=")), said.join(" | "));
    check(
      "日志里说了上游答的什么（server HTTP 503）",
      said.some((line) => line.includes("server HTTP 503")),
      said.join(" | "),
    );
    check("第二次重试也在日志里（2/2）", said.some((line) => line.includes("retry 2/2")), said.join(" | "));
    // 只数那个三次都失败、账号默认上限的场景：退界那条测试（上限 4）自己会
    // 走到第三次重试，它的那几行不在这里数。
    const thrice = said.filter((line) => line.includes("account=acct-503-thrice"));
    check("那个账号只重试了两次", thrice.length === 2, thrice.join(" | "));
    check("没有第三次重试", !thrice.some((line) => line.includes("retry 3/")), thrice.join(" | "));
    check(
      "日志里说了这一次的预算用完了（3/3）",
      logs.some((line) => line.includes("no attempt left (3/3)")),
      logs.join(" | "),
    );
    check(
      "日志里说了等不到头（总时限）就不等",
      logs.some((line) => line.includes("no time left for a")),
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
