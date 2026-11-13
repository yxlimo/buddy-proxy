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
 * 5) 发布层：推理关掉就只有 `off` 这一档
 *
 * `off` 是一个档位，不是布尔开关，它在阶梯的最浅处。一个关掉推理的主路由
 * 模型本来就只有这一档，可库里那列 `effort_options` 是推理还开着的时候写的，
 * 不会跟着开关变 —— 照它发布 `low/high/max`，客户端会以为能调，选出来的是这个
 * 模型没有的档位。发布层因此把这两件事对齐：`reasoning:false` 就只发 `["off"]`。
 *
 * 库里的列一个字不动（重新打开推理时那些档位还要用），`reasoning` 为 NULL
 * （没写）的模型也不是「关」，照旧发库里那列。
 * ------------------------------------------------------------------ */

section("发布层：推理关掉就只有 off 一档");

const { aggregateCatalog, aggregateAnthropicCatalog } = await import("../lib/router/catalog.ts");

const TIERS = ["low", "high", "max"];

/** 一个目标，上游目录里带 TIERS 那几档。 */
function publishOne(model: { reasoning: boolean | null; effortOptions: string[] | null }, targetReasoning = true): any {
  const groups = [
    {
      group: "minimax",
      models: [{ id: "m", displayName: "M", reasoning: targetReasoning, toolCall: true, effortOptions: TIERS }],
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

const offPublished = publishOne({ reasoning: false, effortOptions: TIERS });
check("关掉推理：档位只剩 off", JSON.stringify(offPublished.effort_options) === '["off"]', JSON.stringify(offPublished.effort_options));
check("关掉推理：仍然说 reasoning:false", offPublished.reasoning === false, JSON.stringify(offPublished.reasoning));

const onPublished = publishOne({ reasoning: true, effortOptions: TIERS });
check("开着推理：库里那列原样", JSON.stringify(onPublished.effort_options) === JSON.stringify(TIERS), JSON.stringify(onPublished.effort_options));

const noneSaid = publishOne({ reasoning: null, effortOptions: ["low", "high"] });
check(
  "没写 reasoning（NULL）不算关：照旧发库里那列",
  JSON.stringify(noneSaid.effort_options) === '["low","high"]',
  JSON.stringify(noneSaid.effort_options),
);

const noColumn = publishOne({ reasoning: false, effortOptions: null });
check("关掉推理且库里没有档位列：也是 off，不是不发", JSON.stringify(noColumn.effort_options) === '["off"]', JSON.stringify(noColumn.effort_options));

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
