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
//   2. 此时请求这个模型答 503（不是 400/404），带 Retry-After 与恢复时间；
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
const { setCached } = await import("../lib/store.ts");
const { HEALTH_CACHE_ID } = await import("../lib/health-cache.ts");
const { serveModels } = await import("../lib/router/catalog-routes.ts");
const { handle } = await import("../lib/router/handle.ts");
const { routeInGroup } = await import("../lib/router/routes.ts");

const MODEL = "MiniMax-M3.1-Flash";
const added = addAccount({ platform: "minimax" });
if (!added.ok) throw new Error(`cannot seed the account: ${added.message}`);
const accountId = String(added.id);

const now = Date.now();
const windowEndsAt = new Date(now + 3600_000).toISOString();

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
  platforms: new Map([["minimax", { kind: "minimax", enabled: true, accounts: 1, ids: new Set([MODEL]), untilMs: null }]]),
});
check("有额度时路由拿到了目标", healthy.model === `minimax/${MODEL}`, healthy.model);

/* ------------------------------------------------------------------ *
 * 1) 账号没额度：目录不变
 * ------------------------------------------------------------------ */

setCached(HEALTH_CACHE_ID, exhaustedSnapshot());

section("额度用尽：模型还在目录里");

const models = fakeCtx({}, { platform: "minimax" });
serveModels(models as any);
const listed: string[] = (models.body?.data ?? []).map((m: any) => String(m.id));
check("`/v1/models` 仍然列出这个平台的模型", listed.includes(MODEL), JSON.stringify(listed));

/* ------------------------------------------------------------------ *
 * 2) 同一个模型：503 + Retry-After，不是 400/404
 * ------------------------------------------------------------------ */

section("额度用尽：请求答 503 并说什么时候恢复");

const ask = fakeCtx({ model: MODEL });
await handle(ask as any, "anthropic", "minimax");
check("状态是 503", ask.status === 503, String(ask.status));
check("不是 unknown model（400/404）", ask.status !== 400 && ask.status !== 404, String(ask.status));
const hint = String(ask.body?.hint ?? "");
check("提示里说得清什么时候恢复", hint.includes("恢复"), hint);
check("提示里带恢复时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(hint), hint);
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
    platforms: new Map([["minimax", { kind: "minimax", enabled: true, accounts: 1, ids: new Set<string>(), untilMs: null }]]),
  });
  check("目录为空时被拒了", false, "routeInGroup 没有抛错");
} catch (e) {
  const err = e as { status?: number; hint?: string; message?: string };
  check("状态是 503", err.status === 503, String(err.status));
  check("说的是目录还没拿到", String(err.hint ?? "").includes("目录"), String(err.hint ?? ""));
  check("不是 unknown model", !String(err.message ?? "").includes("unknown model"), String(err.message ?? ""));
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
