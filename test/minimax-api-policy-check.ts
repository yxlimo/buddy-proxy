// test/minimax-api-policy-check.ts — 开放平台（按 API Key 分租户）的策略与失败。
//
//   node --experimental-strip-types test/minimax-api-policy-check.ts
//
// 离线：假平台，不碰真平台，不花额度。
//
// 覆盖：
//   1. 单一策略只用第一把 key（不换）；
//   2. 降级策略下 400（请求本身的问题）不换 key，原文还在；
//   3. 降级策略下 402（余额用尽）换下一把 key；
//   4. 流式答复里的业务错误（200 + base_resp.status_code）不会被当成答复
//      交给客户端。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-api-policy-"));
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

/** 每把 key 平台怎么回答。 */
let answers: Record<string, { status: number; body: string; type?: string }> = {};
/** 平台被叫了几次，用的是哪把 key。 */
const calls: string[] = [];

const platform = http.createServer((req, res) => {
  const key = String(req.headers.authorization ?? "").replace("Bearer ", "");
  calls.push(key);
  const answer = answers[key] ?? { status: 500, body: "{}" };
  res.writeHead(answer.status, { "content-type": answer.type ?? "application/json" });
  res.end(answer.body);
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const port = (platform.address() as any).port;

process.env.MINIMAX_API_BASE = `http://127.0.0.1:${port}/v1`;
process.env.MINIMAX_API_1_KEY = "sk_test_key_1";
process.env.MINIMAX_API_2_KEY = "sk_test_key_2";

/* ------------------------------------------------------------------ *
 * 上游自己的策略
 * ------------------------------------------------------------------ */

const { ensureBuiltinProviders } = await import("../lib/providers.ts");
const { store } = await import("../lib/store.ts");
ensureBuiltinProviders();
const setPolicy = (policy: string): void => {
  store().prepare("UPDATE provider SET policy = ? WHERE id = ?").run(policy, "minimax-api");
};

const { toMiniMaxApi } = await import("../lib/router/upstreams.ts");

const ctx: any = {
  qoderRegions: () => ({}),
  legacyMaxAttempts: 1,
  legacyRetryMs: 0,
  qoderMaxAttempts: 1,
  tokenRhythmMaxAttempts: 1,
  logRoute: false,
  clientHeaders: {},
  workbuddyMaxOutput: () => 64000,
  workbuddyModel: () => null,
};

const route: any = {
  upstream: "minimax-api",
  provider: "minimax-api",
  model: "MiniMax-M3.1-Flash",
  group: "minimax-api",
};

/** 一个 Koa 上下文的粗略样子。 */
function outBox(): any {
  const box: any = {
    body: null,
    res: { headersSent: false, end() {} },
    set status(value: number) {
      box.code = value;
    },
    get status() {
      return box.code ?? 200;
    },
  };
  return box;
}

/** 调一次开放平台，抓住错误。 */
async function call(stream = false): Promise<{ error: any; out: any }> {
  const out = outBox();
  try {
    await toMiniMaxApi(
      ctx,
      { model: "MiniMax-M3.1-Flash", stream, messages: [{ role: "user", content: "hi" }] },
      route,
      "openai",
      stream,
      out,
    );
    return { error: null, out };
  } catch (e) {
    return { error: e, out };
  }
}

const badRequest = { status: 400, body: JSON.stringify({ error: { message: "参数错 (2013)" } }) };
const noMoney = { status: 402, body: JSON.stringify({ error: { message: "余额不足 (1008)" } }) };
const okAnswer = {
  status: 200,
  body: JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "MiniMax-M3.1-Flash",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  }),
};

console.log("");
console.log("单一策略：只用第一把 key");

{
  setPolicy("single");
  calls.length = 0;
  answers = { sk_test_key_1: badRequest, sk_test_key_2: okAnswer };
  const { error } = await call();
  check("只用了第一把 key", calls.join(",") === "sk_test_key_1", calls.join(","));
  check("没有换到第二把 key", !calls.includes("sk_test_key_2"), calls.join(","));
  check("原文还在", String(error?.hint ?? "").includes("400"), String(error?.hint));
  check("没有说成「没有账号能用」", !String(error?.message).includes("no minimax api tenant"), String(error?.message));
}

console.log("");
console.log("降级策略：请求本身的问题不换 key");

{
  setPolicy("fallback");
  calls.length = 0;
  answers = { sk_test_key_1: badRequest, sk_test_key_2: okAnswer };
  const { error } = await call();
  check("只试了一把 key", calls.join(",") === "sk_test_key_1", calls.join(","));
  check("原文还在", String(error?.hint ?? "").includes("400"), String(error?.hint));
}

console.log("");
console.log("降级策略：余额用尽换下一把 key");

{
  setPolicy("fallback");
  calls.length = 0;
  answers = { sk_test_key_1: noMoney, sk_test_key_2: okAnswer };
  const { error, out } = await call();
  check("换到了第二把 key", calls.includes("sk_test_key_2"), calls.join(","));
  check("没有报错", error === null, String(error?.message));
  check("答复里有内容", JSON.stringify(out.body ?? {}).includes("ok"), JSON.stringify(out.body ?? {}).slice(0, 200));
}

console.log("");
console.log("流式答复里的业务错误不是答复");

{
  setPolicy("single");
  calls.length = 0;
  answers = {
    sk_test_key_1: {
      status: 200,
      type: "text/event-stream",
      body: `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        base_resp: { status_code: 2067, status_msg: "套餐额度已用完" },
      })}\n\n`,
    },
  };
  const { error, out } = await call(true);
  check("没有当成答复交给客户端", out.body === null, JSON.stringify(out.body ?? {}).slice(0, 200));
  check("报的是业务错误", String(error?.message ?? "").includes("2067"), String(error?.message));
  check("说的是平台的原话", String(error?.hint ?? "").includes("套餐额度已用完"), String(error?.hint));
}

platform.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
