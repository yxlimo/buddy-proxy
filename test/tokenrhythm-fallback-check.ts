// test/tokenrhythm-fallback-check.ts — 余额不足时自己换租户。
//
//   node --experimental-strip-types test/tokenrhythm-fallback-check.ts
//
// 场景：两个租户，租户 1 的赠金最先到期，所以它先被选中；平台说它余额不足
// （402），网关应当换到租户 2，而不是把错误原样抛出去。
//
// 平台那边是假的：钱包、赠金、key 都是本地造的；推理端点对第一把 key 回
// 402，对第二把回 200。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tr-fallback-"));
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

/* ------------------------------------------------------------------ *
 * 假平台
 * ------------------------------------------------------------------ */

let platformCalls = 0;
const inferenceCalls: { key: string; status: number }[] = [];
// Which key the fake platform serves; null means every key is out of money.
let serveKey: string | null = "tenant_2";

const platform = http.createServer((req, res) => {
  platformCalls++;
  const chunks: string[] = [];
  req.on("data", (c) => chunks.push(String(c)));
  req.on("end", () => {
    const path = req.url ?? "";
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // 钱包：租户 1 的赠金先到期，租户 2 的后到期。平台用 2099 标记永久。
    if (path.startsWith("/api/wallet/summary")) {
      const first = req.headers["x-fake-tenant"] === "2";
      return send(200, {
        code: 0,
        data: {
          availableBalanceCny: first ? 18 : 18,
          expiringBalanceCny: first ? 18 : 18,
          giftBalanceCny: first ? 18 : 18,
        },
      });
    }
    if (path.startsWith("/api/wallet/expiring-credits")) {
      const first = req.headers["x-fake-tenant"] === "2";
      return send(200, {
        code: 0,
        data: {
          list: [
            {
              id: "lot-1",
              source: "IDENTITY_VERIFICATION_REWARD",
              sourceLabel: "实名认证奖励",
              remainingCny: 18,
              expiresAt: first ? "2026-11-19T04:28:10.883Z" : "2026-11-20T04:28:10.883Z",
              status: "ACTIVE",
            },
          ],
          summary: {
            expiringBalanceCny: 18,
            nextExpiryAt: first ? "2026-11-19T04:28:10.883Z" : "2026-11-20T04:28:10.883Z",
          },
        },
      });
    }
    if (path.startsWith("/api/api-keys") && req.method === "GET") {
      return send(200, { code: 0, data: { list: [] } });
    }
    if (path.startsWith("/api/api-keys") && req.method === "POST") {
      const body = JSON.parse(chunks.join("") || "{}");
      return send(200, {
        code: 0,
        data: { id: "key-1", name: body.name ?? "agent", key: `sk_tr_fake_${body.name ?? "agent"}` },
      });
    }
    return send(404, { code: "NOT_FOUND" });
  });
});

const inference = http.createServer((req, res) => {
  const key = String(req.headers.authorization ?? "").replace("Bearer ", "");
  const chunks: string[] = [];
  req.on("data", (c) => chunks.push(String(c)));
  req.on("end", () => {
    // 只有 serveKey 说的那个 key 好使，其它都说没钱。
    const broke = serveKey === null ? true : !key.includes(serveKey);
    const status = broke ? 402 : 200;
    inferenceCalls.push({ key, status });
    if (broke) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: "INSUFFICIENT_BALANCE",
          message: "账户余额不足，请充值后重试。",
          traceId: "trace_fake_402",
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "deepseek-v4.1-flash-1017",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  });
});

await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
const platformPort = (platform.address() as any).port;
const inferencePort = (inference.address() as any).port;

process.env.TOKENRHYTHM_API_BASE = `http://127.0.0.1:${platformPort}`;
process.env.TOKENRHYTHM_INFER_BASE = `http://127.0.0.1:${inferencePort}/v1`;
process.env.TOKEN_RHYTHM_1_ACCOUNT = "19000000001";
process.env.TOKEN_RHYTHM_1_PASSWORD = "pw1";
process.env.TOKEN_RHYTHM_1_API_KEY = "sk_tr_tenant_1";
process.env.TOKEN_RHYTHM_2_ACCOUNT = "19000000002";
process.env.TOKEN_RHYTHM_2_PASSWORD = "pw2";
process.env.TOKEN_RHYTHM_2_API_KEY = "sk_tr_tenant_2";

/* ------------------------------------------------------------------ *
 * 两个租户的会话
 * ------------------------------------------------------------------ */

const { setSecret } = await import("../lib/store.ts");
for (const index of [1, 2]) {
  setSecret(`session:tokenrhythm:${index}`, "session", {
    schemaVersion: 1,
    account: `1900000000${index}`,
    password: `pw${index}`,
    name: `租户 ${index}`,
    cookie: `tr_session=session-${index}; tr_csrf=csrf-${index}`,
    generation: 1,
    loginAtMs: Date.now(),
  });
}

const { toTokenRhythm } = await import("../lib/router/upstreams.ts");
const { routingContext } = await import("../lib/router/routes.ts");

console.log("");
console.log("余额不足时换租户");

const ctx: any = {
  qoderRegions: () => ({}),
  legacyMaxAttempts: 1,
  legacyRetryMs: 0,
  qoderMaxAttempts: 1,
  tokenRhythmMaxAttempts: 1,
  logRoute: true,
  workbuddyMaxOutput: () => 64000,
  workbuddyModel: () => null,
};

const route: any = {
  upstream: "tokenrhythm",
  model: "deepseek-v4.1-flash-1017",
  group: "tokenrhythm",
};

// A Koa context, roughly: the status starts at 200 and the body goes in it.
let status = 200;
const out: any = {
  body: null,
  res: { headersSent: false, end() {} },
  set status(value: number) {
    status = value;
  },
  get status() {
    return status;
  },
};

try {
  await toTokenRhythm(
    ctx,
    { model: "deepseek-v4.1-flash-1017", stream: false, messages: [{ role: "user", content: "hi" }] },
    route,
    "openai",
    false,
    out,
  );
} catch (e) {
  check("没有抛错", false, (e as Error).message);
}

check("第一把 key 试过了", inferenceCalls.some((c) => c.key.includes("tenant_1")), JSON.stringify(inferenceCalls));
check("换到了第二个租户", inferenceCalls.some((c) => c.key.includes("tenant_2")), JSON.stringify(inferenceCalls));
check("第二个租户成功了", inferenceCalls.some((c) => c.key.includes("tenant_2") && c.status === 200));
check("答复是 200", status === 200, String(status));
check("答复里有内容", JSON.stringify(out.body ?? {}).includes("ok"), JSON.stringify(out.body ?? {}).slice(0, 200));

console.log("");
console.log("所有租户都没钱");

// Two more tenants, both with money on paper and neither able to pay.
process.env.TOKEN_RHYTHM_3_ACCOUNT = "19000000003";
process.env.TOKEN_RHYTHM_3_PASSWORD = "pw3";
process.env.TOKEN_RHYTHM_3_API_KEY = "sk_tr_tenant_3";
process.env.TOKEN_RHYTHM_4_ACCOUNT = "19000000004";
process.env.TOKEN_RHYTHM_4_PASSWORD = "pw4";
process.env.TOKEN_RHYTHM_4_API_KEY = "sk_tr_tenant_4";
for (const index of [3, 4]) {
  setSecret(`session:tokenrhythm:${index}`, "session", {
    schemaVersion: 1,
    account: `1900000000${index}`,
    password: `pw${index}`,
    name: `租户 ${index}`,
    cookie: `tr_session=session-${index}; tr_csrf=csrf-${index}`,
    generation: 1,
    loginAtMs: Date.now(),
  });
}

// Now every key says "no balance".
serveKey = null;

let failure: any = null;
const out2: any = {
  body: null,
  res: { headersSent: false, end() {} },
  set status(value: number) {
    failure = value;
  },
  get status() {
    return failure;
  },
};
try {
  await toTokenRhythm(
    ctx,
    { model: "deepseek-v4.1-flash-1017", stream: false, messages: [{ role: "user", content: "hi" }] },
    route,
    "openai",
    false,
    out2,
  );
} catch (e) {
  failure = (e as any).status ?? 0;
  check("报的是 402，不是 502", failure === 402, `${failure} ${(e as Error).message}`);
  check("说的是余额不足", (e as any).hint?.includes("余额") ?? false, (e as any).hint);
}

platform.close();
inference.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
