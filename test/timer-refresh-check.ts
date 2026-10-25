// test/timer-refresh-check.ts — 只有定时器换令牌。
//
//   node --experimental-strip-types test/timer-refresh-check.ts
//
// refresh token 是轮换的：换一次就作废，而平台在看到同一份 token 被用了两次
// 时，会把**整个会话**的令牌一起撤掉。所以同一份会话同一时刻只能有一个
// 刷新者。
//
// 网关里那个刷新者是定时器：它每分钟问一次，快到期就换。请求那一条路不换
// 令牌——它看到过期的就报错。这条测试守住这一点：
//
//   1. 请求路径（取凭据、发请求）从不向平台要令牌。
//   2. 定时器只在临期时才换。
//   3. 定时器不叠着跑：上一轮没跑完就不开新一轮。
//
// 平台那边是假的：本地起一个 HTTP 服务冒充 OAuth 服务。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "timer-refresh-"));
process.env.BUDDY_DATA_DIR = tmp;

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * 假 OAuth 服务
 * ------------------------------------------------------------------ */

let tokenCalls = 0;

const fake = http.createServer((req, res) => {
  const chunks: string[] = [];
  req.on("data", (c) => chunks.push(String(c)));
  req.on("end", () => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith("/oauth2/token")) {
      tokenCalls++;
      return send(200, {
        access_token: "mmoat_new_access",
        refresh_token: "mmort_new_refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "agent.default",
      });
    }
    send(404, { error: "not_found" });
  });
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const port = (fake.address() as { port: number }).port;
process.env.MINIMAX_OAUTH_ORIGIN = `http://127.0.0.1:${port}`;

const { writeSession } = await import("../lib/session.ts");
const { providerSecretId } = await import("../lib/providers.ts");
const { ensureCredential, refreshSession } = await import("../lib/minimax/oauth.ts");

const providerId = "minimax";
const id = providerSecretId(providerId);

function session(generation: number, access: string, refresh: string, minutesLeft: number) {
  return {
    schemaVersion: 1,
    clientId: "mcode-public",
    audience: "agent-backend",
    scopes: ["agent.default"],
    region: "cn",
    accessToken: access,
    refreshToken: refresh,
    tokenType: "Bearer",
    expiresAtMs: Date.now() + minutesLeft * 60_000,
    generation,
    loginAtMs: Date.now(),
    refreshedAtMs: Date.now(),
  };
}

console.log("");
console.log("请求路径不换令牌");

// 令牌已经过期了：请求路径要报过期，而不是自己去换。
writeSession(id, session(1, "mmoat_old", "mmort_old", -5));
let thrown: any = null;
try {
  await ensureCredential(providerId);
} catch (e) {
  thrown = e;
}
check("过期会报错", thrown !== null, "没抛");
check("状态是 503", thrown?.status === 503, String(thrown?.status));
check("平台没有被问", tokenCalls === 0, String(tokenCalls));

console.log("");
console.log("临期才换");

// 还有 59 分钟：不到临期，不换。
writeSession(id, session(1, "mmoat_fresh", "mmort_fresh", 59));
const unchanged = await refreshSession(providerId);
check("没到临期就原样返回", unchanged.refreshToken === "mmort_fresh", String(unchanged.refreshToken));
check("平台没有被问", tokenCalls === 0, String(tokenCalls));

// 还有一分钟：临期了，换。
writeSession(id, session(1, "mmoat_due", "mmort_due", 1));
const refreshed = await refreshSession(providerId);
check("临期就换了", refreshed.refreshToken === "mmort_new_refresh", String(refreshed.refreshToken));
check("平台被问了一次", tokenCalls === 1, String(tokenCalls));

console.log("");
console.log("定时器不叠着跑");

// 让一轮跑久一点：第二轮在第一轮没结束时来了，不该叠上去。
const { runPeriodicOnce } = await import("../lib/periodic.ts");
const { listProviders, addAccount } = await import("../lib/providers.ts");
addAccount({ platform: "qoder", alias: "慢账号" });
const before = tokenCalls;
await Promise.all([runPeriodicOnce(), runPeriodicOnce(), runPeriodicOnce()]);
check("同时叫三轮，平台没有被多问", tokenCalls === before, `${before} → ${tokenCalls}`);

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
