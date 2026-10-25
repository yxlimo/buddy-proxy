// test/dead-session-check.ts — 平台拒了刷新之后，别再拿这份会话去问平台。
//
//   node --experimental-strip-types test/dead-session-check.ts
//
// refresh token 被拒（invalid_grant）之后，这份会话已经作废：再问一次也是
// 同样的答复，每一次都要走一趟网络。所以网关要记住这次拒绝，直接回答；
// 直到有新会话写进来（登录成功）才重新试。
//
// 平台那边是假的：本地起一个 HTTP 服务冒充 OAuth 服务。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dead-session-"));
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
/** 平台答什么：true = 拒绝（invalid_grant），false = 正常发新的 token。 */
let refuse = true;

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
      if (refuse) {
        return send(400, {
          error: "invalid_grant",
          error_description: "this refresh token can no longer be used, start a new authorization",
        });
      }
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

const { writeSession, clearDeadSession } = await import("../lib/session.ts");
const { providerSecretId } = await import("../lib/providers.ts");
const { ensureCredential, refreshSession } = await import("../lib/minimax/oauth.ts");

const providerId = "minimax";
const id = providerSecretId(providerId);

/** 一份会话：临期（还有一分钟到期），所以定时器会换它。 */
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

writeSession(id, session(1, "mmoat_old", "mmort_old", 1));

console.log("平台拒绝了刷新");

let thrown: any = null;
try {
  await refreshSession(providerId);
} catch (e) {
  thrown = e;
}
check("抛错了", thrown !== null, "没抛");
check("状态是 503", thrown?.status === 503, String(thrown?.status));
check(
  "提示说清是哪儿抢走了这份会话",
  String(thrown?.hint ?? "").includes("只能有一个持有者"),
  String(thrown?.hint),
);
check(
  "提示提到平台会撤掉同一个账号的其它会话",
  String(thrown?.hint ?? "").includes("同一个账号"),
  String(thrown?.hint),
);
check("平台被问了一次", tokenCalls === 1, String(tokenCalls));

console.log("");
console.log("别再问平台了");

thrown = null;
try {
  await refreshSession(providerId);
} catch (e) {
  thrown = e;
}
check("还是抛错", thrown !== null, "没抛");
check("状态还是 503", thrown?.status === 503, String(thrown?.status));
check("平台没有被再问", tokenCalls === 1, String(tokenCalls));

thrown = null;
try {
  await ensureCredential(providerId);
} catch (e) {
  thrown = e;
}
check("取凭据时也不问平台", thrown !== null && thrown?.status === 503, String(thrown?.status));
check("平台还是没有被问", tokenCalls === 1, String(tokenCalls));

console.log("");
console.log("没到临期就不换");

refuse = false;
writeSession(id, session(2, "mmoat_fresh", "mmort_fresh", 60));
const unchanged = await refreshSession(providerId);
check("原样返回，没有去换", unchanged.refreshToken === "mmort_fresh", String(unchanged.refreshToken));
check("平台没有被问", tokenCalls === 1, String(tokenCalls));

console.log("");
console.log("写进新会话之后可以再试");

writeSession(id, session(2, "mmoat_new", "mmort_new", 1));
const session2 = await refreshSession(providerId);
check("刷新成功了", session2.generation === 3, String(session2.generation));
check("平台被问了一次", tokenCalls === 2, String(tokenCalls));
check("拿到的是新的 refresh token", session2.refreshToken === "mmort_new_refresh", String(session2.refreshToken));

console.log("");
console.log("操作者清了那个记号，可以再试一次");

refuse = true;
// 刚换来的令牌还有一个小时才到期，所以再写一份临期的：定时器会换它。
writeSession(id, session(3, "mmoat_again", "mmort_again", 1));
await refreshSession(providerId).catch(() => {});
check("平台拒了", tokenCalls === 3, String(tokenCalls));
clearDeadSession(id);
let retried: any = null;
try {
  await refreshSession(providerId);
} catch (e) {
  retried = e;
}
check("平台又被问了一次", tokenCalls === 4, String(tokenCalls));
check("还是那个拒绝", retried?.status === 503, String(retried?.status));

fake.close();

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
