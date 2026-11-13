// test/model-visibility-check.ts — 额度用尽/冷却不让模型从目录里消失。
//
//   node --experimental-strip-types test/model-visibility-check.ts
//
// 离线：只有一份手写的健康快照，一个上游都不问。
//
// 2026-10-31 的那个 bug：账号额度用尽时 routingContext 把整个平台的模型 id
// 集合清空，于是 `POST /v1/messages {"model":"MiniMax-M3.1-Flash"}` 被答成
// 400 `unknown model`，`可用：` 后面是空的。模型确实存在，只是这个平台现在
// 接不了这个请求 —— 该答的是 503 加恢复时间。
//
// 覆盖：
//   1. 账号没额度时，`/v1/models` 仍然列出这个平台的模型；
//   2. 此时请求这个模型答 402（不是 400/404/503），带 Retry-After 与恢复时间；
//      额度用尽是客户端能动手的事（充值或等额度），所以是 402；
//   3. 真正不存在的模型名仍然答 400 unknown model；
//   4. 平台目录为空（还没拿到目录）答 503，不是 400。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-visibility-"));
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

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 一个假的 Koa 上下文：只带 handle / serveModels 用得着的那些
 * ------------------------------------------------------------------ */

interface FakeCtx {
  status: number;
  body: any;
  headers: Record<string, string>;
  request: { body: unknown; headers: Record<string, string> };
  query: Record<string, string>;
  params: Record<string, string>;
  res: { headersSent: boolean; setHeader: (k: string, v: string) => void; end: () => void };
  set: (name: unknown, value?: string) => void;
}

function fakeCtx(body: unknown = {}, params: Record<string, string> = {}): FakeCtx {
  const headers: Record<string, string> = {};
  const ctx: FakeCtx = {
    status: 200,
    body: undefined,
    headers,
    request: { body, headers: {} },
    query: {},
    params,
    res: { headersSent: false, setHeader: () => {}, end: () => {} },
    set(name: unknown, value?: string) {
      if (name && typeof name === "object") Object.assign(headers, name as Record<string, string>);
      else headers[String(name)] = String(value ?? "");
    },
  };
  return ctx;
}

/* ------------------------------------------------------------------ *
 * 一个真的账号，一份「文本额度用尽」的快照
 * ------------------------------------------------------------------ */

await import("../lib/kinds/index.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setSecret } = await import("../lib/store.ts");
const { putHealthSnapshot } = await import("../lib/health-cache.ts");
const { serveModels } = await import("../lib/router/catalog-routes.ts");
const { handle } = await import("../lib/router/handle.ts");
const { routeInGroup } = await import("../lib/router/routes.ts");

const MODEL = "MiniMax-M3.1-Flash";
const added = addAccount({ platform: "minimax" });
if (!added.ok) throw new Error(`cannot seed the account: ${added.message}`);
const accountId = String(added.id);

const now = Date.now();
const windowEndsAt = new Date(now + 3600_000).toISOString();

// 这个账号得有一份凭据：这个测试问的是「额度用尽/冷却不让模型从目录里消失」，
// 不是「没有凭据的平台」。没有凭据的话平台整个进不了目录（那是另一件事，
// 另一个测试在管）。
setSecret(`session:provider:${accountId}`, "session", {
  schemaVersion: 1,
  clientId: "minimax-code",
  audience: "minimax",
  scopes: ["agent.default"],
  region: "cn",
  accessToken: "test-token",
  refreshToken: "test-refresh",
  tokenType: "Bearer",
  expiresAtMs: now + 3600_000,
  generation: 1,
  loginAtMs: now,
  refreshedAtMs: now,
});

/** 套餐窗口见底的快照：这个账号没文本额度了。 */
function exhaustedSnapshot(): unknown {
  return {
    minimax: {
      [accountId]: {
        balance: 0,
        tokenPlan: {
          windows: [
            { model: "general", intervalPercent: 0, weeklyPercent: 0, intervalEndsAt: windowEndsAt, weeklyEndsAt: windowEndsAt },
          ],
        },
        credits: [],
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 0) 对照组：还有额度时，同一个模型是能路由的
 * ------------------------------------------------------------------ */

section("对照组：有额度就能路由");

const healthy = routeInGroup("minimax", MODEL, {
  platforms: new Map([
    ["minimax", { kind: "minimax", enabled: true, accounts: 1, ids: new Set([MODEL]), untilMs: null, state: "ready" }],
  ]),
});
check("有额度时路由拿到了目标", healthy.model === `minimax/${MODEL}`, healthy.model);

/* ------------------------------------------------------------------ *
 * 1) 账号没额度：目录不变
 * ------------------------------------------------------------------ */

putHealthSnapshot(exhaustedSnapshot());

section("额度用尽：模型还在目录里");

const models = fakeCtx({}, { platform: "minimax" });
serveModels(models as any);
const listed: string[] = (models.body?.data ?? []).map((m: any) => String(m.id));
check("`/v1/models` 仍然列出这个平台的模型", listed.includes(MODEL), JSON.stringify(listed));

/* ------------------------------------------------------------------ *
 * 2) 同一个模型：503 + Retry-After，不是 400/404
 * ------------------------------------------------------------------ */

section("额度用尽：请求答 402 并说什么时候恢复");

const ask = fakeCtx({ model: MODEL });
await handle(ask as any, "anthropic", "minimax");
check("状态是 402", ask.status === 402, String(ask.status));
check("不是 unknown model（400/404）", ask.status !== 400 && ask.status !== 404, String(ask.status));
check(
  "错误类型是 usage_limit_error",
  String(ask.body?.error?.type ?? "") === "usage_limit_error",
  JSON.stringify(ask.body?.error),
);
const hint = String(ask.body?.hint ?? "");
check("提示里说得清什么时候恢复", hint.includes("恢复"), hint);
check("提示里带恢复时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(hint), hint);
check("提示里点名了是哪个上游", hint.includes("minimax"), hint);
check("提示里说的是额度，不是「没有这个模型」", !hint.includes("没有这个模型"), hint);
const retryAfter = Number(ask.headers["retry-after"] ?? 0);
check("Retry-After 是一个秒数", Number.isFinite(retryAfter) && retryAfter > 0, String(ask.headers["retry-after"]));
// 恢复时间取的是套餐窗口结束时间（一小时后），允许几秒误差。
check("Retry-After 与套餐窗口结束时间一致", Math.abs(retryAfter - 3600) <= 5, String(retryAfter));

/* ------------------------------------------------------------------ *
 * 3) 真正不存在的模型名：还是 400
 * ------------------------------------------------------------------ */

section("不存在的模型名还是 400");

const missing = fakeCtx({ model: "MiniMax-No-Such-Model" });
await handle(missing as any, "anthropic", "minimax");
check("状态是 400", missing.status === 400, String(missing.status));
check(
  "错话是 unknown model",
  String(missing.body?.error?.message ?? "").includes("unknown model"),
  JSON.stringify(missing.body?.error),
);
check(
  "可用列表里有这个平台的模型",
  String(missing.body?.hint ?? "").includes(MODEL),
  String(missing.body?.hint ?? ""),
);

/* ------------------------------------------------------------------ *
 * 4) 目录还没拿到：503，不是 400
 * ------------------------------------------------------------------ */

section("目录为空：503，不是 400");

try {
  routeInGroup("minimax", MODEL, {
    platforms: new Map([
      ["minimax", { kind: "minimax", enabled: true, accounts: 1, ids: new Set<string>(), untilMs: null, state: "ready" }],
    ]),
  });
  check("目录为空时被拒了", false, "routeInGroup 没有抛错");
} catch (e) {
  const err = e as { status?: number; hint?: string; message?: string };
  check("状态是 503", err.status === 503, String(err.status));
  check("说的是目录还没拿到", String(err.hint ?? "").includes("目录"), String(err.hint ?? ""));
  check("不是 unknown model", !String(err.message ?? "").includes("unknown model"), String(err.message ?? ""));
}

/* ------------------------------------------------------------------ *
 * 5) 发布层：关掉推理没有档位，能思考的模型都带 `off`
 *
 * `reasoning:false` 只有一个含义：这个模型不会思考，或者不接档位 —— 它没有
 * 档位可给，所以一个档位都不发。发 `["off"]` 是在说反话：那等于告诉客户端
 * 「它有一个可以关掉思考的开关」。库里那列 `effort_options` 是开关还开着的时候
 * 写的，不会跟着关掉，所以不能拿它当真相。
 *
 * `off` 是阶梯最浅的一档，不是布尔开关。客户端能选哪些档位是照我们公布的列表
 * 来的（pi 的 `THINKING_LEVEL_OPTIONS`、opencode 的变体名），不发 `off` 就等于
 * 把「别想了」这个选项从它们手上拿走。所以只要 `reasoning` 不是 false，`off`
 * 一定在列表最前面，且只出现一次；其余档位保持原来的来源与顺序（库里那列优先，
 * 没有就继承目标的公共档位）。
 *
 * 库里的列一个字不动（重新打开推理时那些档位还要用）。`reasoning` 为 NULL
 * （没写）不是「关」：「不知道它能不能思考」不等于「它不能思考」，按能思考处理。
 * ------------------------------------------------------------------ */

section("发布层：关掉推理没有档位，能思考的都带 off");

const { aggregateCatalog, aggregateAnthropicCatalog } = await import("../lib/router/catalog.ts");

const TIERS = ["low", "high", "max"];

/** 一个目标，上游目录里带 TIERS 那几档。 */
function publishOne(
  model: { reasoning: boolean | null; effortOptions: string[] | null },
  targetReasoning = true,
  targetTiers: string[] = TIERS,
): any {
  const groups = [
    {
      group: "minimax",
      models: [{ id: "m", displayName: "M", reasoning: targetReasoning, toolCall: true, effortOptions: targetTiers }],
    },
  ];
  const entries = aggregateCatalog(groups as any, [
    {
      id: "m",
      displayName: "M",
      enabled: true,
      strategy: "single",
      contextWindow: null,
      maxOutputTokens: null,
      reasoning: model.reasoning,
      toolCall: null,
      effortOptions: model.effortOptions,
      targets: [{ group: "minimax", upstreamModel: "m", enabled: true, weight: 1 }],
      createdAt: 0,
      updatedAt: 0,
    },
  ]);
  return aggregateAnthropicCatalog(entries).data[0];
}

// 第 1 条：关掉推理，库里那列写着三档也不发。
const offPublished = publishOne({ reasoning: false, effortOptions: TIERS });
check(
  "关掉推理：一个档位都不发",
  !("effort_options" in offPublished),
  JSON.stringify(offPublished.effort_options),
);
check("关掉推理：仍然说 reasoning:false", offPublished.reasoning === false, JSON.stringify(offPublished.reasoning));

const offNoColumn = publishOne({ reasoning: false, effortOptions: null });
check(
  "关掉推理且库里没有档位列：也不发",
  !("effort_options" in offNoColumn),
  JSON.stringify(offNoColumn.effort_options),
);

// 第 2 条：开着推理，off 在库里那列前面。
const onPublished = publishOne({ reasoning: true, effortOptions: TIERS });
check(
  "开着推理：off 排在最前，其余顺序不变",
  JSON.stringify(onPublished.effort_options) === '["off","low","high","max"]',
  JSON.stringify(onPublished.effort_options),
);

// 第 3 条：库里没写，继承目标那几档，同样带上 off。
const inherited = publishOne({ reasoning: true, effortOptions: null });
check(
  "开着推理、库里没写：继承目标档位，off 在前",
  JSON.stringify(inherited.effort_options) === '["off","low","high","max"]',
  JSON.stringify(inherited.effort_options),
);

// 目标也没有档位：仍然给 off —— 能思考的模型可以被告知别想了。
const noTiersAnywhere = publishOne({ reasoning: true, effortOptions: null }, true, []);
check(
  "开着推理、哪儿都没有档位：只剩 off",
  JSON.stringify(noTiersAnywhere.effort_options) === '["off"]',
  JSON.stringify(noTiersAnywhere.effort_options),
);

// 第 4 条：没写 reasoning 不等于关，也不是「不发」，off 不重复。
const noneSaid = publishOne({ reasoning: null, effortOptions: ["off", "low"] });
check(
  "没写 reasoning（NULL）不算关：照发，且 off 不重复",
  JSON.stringify(noneSaid.effort_options) === '["off","low"]',
  JSON.stringify(noneSaid.effort_options),
);

const offInTheMiddle = publishOne({ reasoning: true, effortOptions: ["low", "off", "high"] });
check(
  "库里那列把 off 写在中间：挪到最前，只出现一次",
  JSON.stringify(offInTheMiddle.effort_options) === '["off","low","high"]',
  JSON.stringify(offInTheMiddle.effort_options),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
