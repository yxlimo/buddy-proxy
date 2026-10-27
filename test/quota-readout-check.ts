// test/quota-readout-check.ts — 额度读出来的那几处。
//
//   node --experimental-strip-types test/quota-readout-check.ts
//
// 覆盖三件事：
//
//   1. MiniMax Code 的套餐额度用会话就能读（每个账号都有，不靠 plan key）；
//   2. SenseNova 池子里的两种积分分开：30 天到期的是积分，5 小时重置的是
//      套餐额度（按百分比）；
//   3. ZCode 的额度接口要 X-Device-Mid 才答，而且上游会用 200 带业务码报
//      「额度用尽」——那不是答复。
//
// 上游那边是假的：本地起一个 HTTP 服务冒充开放平台与 ZCode。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-readout-"));
process.env.BUDDY_DATA_DIR = tmp;

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

let lastBalanceHeaders: Record<string, string> = {};
/** 假上游答模型请求时给的东西：改成业务错误就是错误。 */
let modelReply: unknown = { type: "message", content: [{ type: "text", text: "ok" }] };

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.startsWith("/backend/account/token_plan/remains_percent")) {
    // 会话读的套餐额度：给的是「用了多少」与「总量多少」。
    return send(200, {
      model_remains: [
        {
          model_name: "general",
          start_time: 1792921225554,
          end_time: 1792939225554,
          remains_time: 17999999,
          current_interval_used_percent: "0%",
          current_interval_total_percent: "100%",
          weekly_start_time: 1792857624293,
          weekly_end_time: 1793462424293,
          weekly_remains_time: 541198738,
          current_weekly_used_percent: "10%",
          current_weekly_total_percent: "100%",
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    });
  }

  if (url.startsWith("/api/v1/zcode-plan/billing/balance")) {
    lastBalanceHeaders = req.headers as Record<string, string>;
    // 少了 X-Device-Mid，平台答「参数错误」——这就是没读出额度的原因。
    if (!req.headers["x-device-mid"]) {
      return send(400, { code: 3001, msg: "parameter error" });
    }
    return send(200, {
      code: 0,
      msg: "",
      data: {
        server_time: 1792923642,
        plans: [],
        balances: [
          {
            bucket_id: "bucket_1",
            show_name: "GLM-5.3",
            meter: "model_usage",
            unit_type: "token",
            capabilities: ["model:glm-5.3"],
            total_units: 3000000,
            used_units: 120000,
            remaining_units: 2880000,
            period_start: 1792857600,
            period_end: 1792943999,
            expires_at: 1792943999,
          },
        ],
      },
    });
  }

  if (url.startsWith("/api/v1/zcode-plan/anthropic/v1/messages")) {
    return send(200, modelReply);
  }

  send(404, { code: 404, msg: "not found" });
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake.address() as { port: number }).port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// 平台地址在模块加载时读环境变量，所以要在 import 之前设好。
process.env.MINIMAX_API_BASE = fakeBase;
process.env.ZCODE_BASE_URL = fakeBase;

/* ------------------------------------------------------------------ *
 * 一、MiniMax：会话读套餐额度
 * ------------------------------------------------------------------ */

section("MiniMax Code 的套餐额度");

const { fetchMiniMaxTokenPlanWithSession } = await import("../lib/minimax/credits.ts");

const plan = await fetchMiniMaxTokenPlanWithSession("session-token", "cn");
check("读到了套餐额度", plan !== null, JSON.stringify(plan));
check(
  "一个窗口",
  plan?.windows.length === 1,
  String(plan?.windows.length),
);
check(
  "模型名是 general",
  plan?.windows[0]?.model === "general",
  String(plan?.windows[0]?.model),
);
check(
  "5 小时窗口：用掉 0% 就是还剩 100%",
  plan?.windows[0]?.intervalPercent === 100,
  String(plan?.windows[0]?.intervalPercent),
);
check(
  "周窗口：用掉 10% 就是还剩 90%",
  plan?.windows[0]?.weeklyPercent === 90,
  String(plan?.windows[0]?.weeklyPercent),
);
check(
  "5 小时窗口的结束时刻是 ISO",
  typeof plan?.windows[0]?.intervalEndsAt === "string" && plan.windows[0].intervalEndsAt!.endsWith("Z"),
  String(plan?.windows[0]?.intervalEndsAt),
);
check(
  "周窗口的结束时刻是 ISO",
  typeof plan?.windows[0]?.weeklyEndsAt === "string" && plan.windows[0].weeklyEndsAt!.endsWith("Z"),
  String(plan?.windows[0]?.weeklyEndsAt),
);

/* ------------------------------------------------------------------ *
 * 二、SenseNova：两种积分分开
 * ------------------------------------------------------------------ */

section("SenseNova 的积分池");

// 注册表里的那一条：注册发生在 lib/kinds.ts（import 即注册）。
await import("../lib/kinds/index.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const senseNova = kindOf("sensenova");

const poolUsage = {
  plan: { id: "free", name: "Free Plan", type: "TOKEN_PLAN_PLAN_TYPE_FREE" },
  pools: [
    {
      id: "pool_general",
      name: "通用积分池",
      kind: "general",
      poolType: "default",
      modelIds: ["deepseek-v4-flash"],
      window5h: { limit: 60000, used: 0, remaining: 60000, resetAt: 1792925487 },
      window7d: { limit: 600000, used: 11375.108, remaining: 588624.892, resetAt: 1793163087 },
      grantBalance: 140850.1824,
      nearestGrantExpiry: 1794567600,
      nearestGrantExpiringBalance: 13436.7656,
    },
    {
      id: "pool_lite",
      name: "Flash-Lite积分池",
      kind: "dedicated",
      poolType: "dedicated",
      modelIds: ["sensenova-6.8-flash-lite"],
      window5h: { limit: 60000, used: 0, remaining: 60000, resetAt: 1792925487 },
      window7d: { limit: 600000, used: 1652.5404, remaining: 598347.4596, resetAt: 1793163087 },
      grantBalance: 0,
      nearestGrantExpiry: 0,
      nearestGrantExpiringBalance: 0,
    },
  ],
};

const quotas = senseNova?.quotas?.(
  { id: "sensenova", kind: "sensenova", alias: "", region: "", enabled: true, policy: "single", createdAt: 0, updatedAt: 0 },
  { sensenova: { sensenova: { pools: poolUsage } } } as any,
) ?? [];

const quota = quotas[0];
check("有额度", quota !== undefined, JSON.stringify(quotas));
check(
  "活动积分只剩通用池那一笔",
  quota?.credits?.lots?.length === 1,
  JSON.stringify(quota?.credits?.lots?.map((l: any) => [l.sourceLabel, l.remaining])),
);
check(
  "活动积分的数是 grant_balance，不是混在一起的总数",
  quota?.credits?.lots?.[0]?.remaining === 140850.1824,
  String(quota?.credits?.lots?.[0]?.remaining),
);
check(
  "活动积分的到期日是 30 天后",
  quota?.credits?.lots?.[0]?.expiresAt === 1794567600 * 1000,
  String(quota?.credits?.lots?.[0]?.expiresAt),
);
check(
  "积分总额就是活动积分之和",
  quota?.credits?.remaining === 140850.1824,
  String(quota?.credits?.remaining),
);
check(
  "周期积分报成套餐额度：每个池子一个窗口",
  quota?.tokenPlan?.windows?.length === 2,
  JSON.stringify(quota?.tokenPlan?.windows?.map((w: any) => w.label)),
);
check(
  "5 小时窗口的百分比是 remaining / limit",
  quota?.tokenPlan?.windows?.[0]?.intervalPercent === 100,
  String(quota?.tokenPlan?.windows?.[0]?.intervalPercent),
);
check(
  "7 天窗口的百分比是 remaining / limit",
  quota?.tokenPlan?.windows?.[0]?.weeklyPercent === 98,
  String(quota?.tokenPlan?.windows?.[0]?.weeklyPercent),
);
check(
  "窗口的重置时刻是 unix 毫秒",
  quota?.tokenPlan?.windows?.[0]?.intervalEndsAt === 1792925487 * 1000,
  String(quota?.tokenPlan?.windows?.[0]?.intervalEndsAt),
);
check(
  "专属池也在里面",
  quota?.tokenPlan?.windows?.[1]?.label === "Flash-Lite积分池",
  String(quota?.tokenPlan?.windows?.[1]?.label),
);

/* ------------------------------------------------------------------ *
 * 三、ZCode：额度接口与业务码
 * ------------------------------------------------------------------ */

section("ZCode 的额度");

// 额度要登录态。给它造一个。
const { setSecret } = await import("../lib/store.ts");
const { providerSecretId } = await import("../lib/providers.ts");
const sessionId = providerSecretId("zcode");
setSecret(sessionId, "session", {
  token: "jwt-token",
  accessToken: "jwt-token",
  userId: "u-1",
  provider: "zai",
  deviceId: "device-1234",
  generation: 1,
  loginAtMs: Date.now(),
  expiresAtMs: Date.now() + 3600_000,
});

const { fetchZcodeQuota } = await import("../lib/zcode/credits.ts");
const zcodeQuota = await fetchZcodeQuota("zcode");
check("读到了额度", zcodeQuota !== null, JSON.stringify(zcodeQuota));
check("一个额度桶", zcodeQuota?.buckets.length === 1, String(zcodeQuota?.buckets.length));
check(
  "桶的模型是 GLM-5.3",
  zcodeQuota?.buckets[0]?.showName === "GLM-5.3",
  String(zcodeQuota?.buckets[0]?.showName),
);
check(
  "桶的剩余是 2880000",
  zcodeQuota?.buckets[0]?.remaining === 2880000,
  String(zcodeQuota?.buckets[0]?.remaining),
);
check(
  "到期时刻是 ISO（平台给的是 unix 秒，不能直接 Date.parse）",
  typeof zcodeQuota?.buckets[0]?.expiresAt === "string" &&
    !Number.isNaN(Date.parse(zcodeQuota.buckets[0].expiresAt!)),
  String(zcodeQuota?.buckets[0]?.expiresAt),
);
check(
  "额度请求带着设备 id",
  lastBalanceHeaders["x-device-mid"] === "device-1234",
  JSON.stringify(lastBalanceHeaders["x-device-mid"]),
);
check(
  "额度请求带着客户端的版本头",
  lastBalanceHeaders["x-zcode-app-version"] !== undefined,
  JSON.stringify(lastBalanceHeaders["x-zcode-app-version"]),
);

section("ZCode 的业务码");

const { zcodeChat } = await import("../lib/zcode/transport.ts");

modelReply = { code: 1005, msg: "exceed quota limit" };
let thrown: any = null;
try {
  await zcodeChat({ model: "GLM-5.3-Flash", max_tokens: 16, messages: [] });
} catch (e) {
  thrown = e;
}
check("额度用尽会抛错，不会当成答复", thrown !== null, "没抛");
check("状态是 402", thrown?.status === 402, String(thrown?.status));
check("提示里说额度用尽", String(thrown?.hint ?? "").includes("额度用尽"), String(thrown?.hint));

modelReply = { code: 1007, msg: "something else" };
thrown = null;
try {
  await zcodeChat({ model: "GLM-5.3-Flash", max_tokens: 16, messages: [] });
} catch (e) {
  thrown = e;
}
check("别的业务码也抛错", thrown !== null, "没抛");
check("状态是 502", thrown?.status === 502, String(thrown?.status));

modelReply = { type: "message", content: [{ type: "text", text: "ok" }] };
const ok = await zcodeChat({ model: "GLM-5.3-Flash", max_tokens: 16, messages: [] });
check("正常答复不抛错", ok?.response?.status === 200, String(ok?.response?.status));
const answer = await ok.response.json();
check(
  "答复原样透传",
  answer?.content?.[0]?.text === "ok",
  JSON.stringify(answer),
);

fake.close();

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : "全部通过");
process.exit(fail === 0 ? 0 : 1);
