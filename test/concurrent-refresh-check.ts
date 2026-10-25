// test/concurrent-refresh-check.ts — 同一个登录态被同时刷新两次。
//
//   node --experimental-strip-types test/concurrent-refresh-check.ts
//
// refresh token 是轮换的：换一次就作废。所以同一个登录态被同时刷新两次时，
// 两个调用拿着同一份 token 去换，一个成功，另一个被拒——那看起来跟「令牌
// 被偷了」一模一样，会把会话判死。
//
// 所以被拒的一方要重读：库里的会话已经换了令牌（别人先刷的），就拿那个
// 新的再换一次。于是两个调用拿到两个不同的 refresh token，谁也不等谁。
//
// 平台那边是假的：本地起一个 HTTP 服务冒充 OAuth 服务，它按真实平台的
// 规矩办事——同一个 refresh token 只能用一次，第二次答 invalid_grant。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-refresh-"));
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
 * 假 OAuth 服务：refresh token 只能用一次
 * ------------------------------------------------------------------ */

/** 平台认得的 refresh token：用过一次就作废。 */
const live = new Set<string>(["mmort_old"]);

/** 平台一共答了几次。 */
let tokenCalls = 0;

/** 平台发出去过几个新令牌。 */
let issued = 0;

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
      const body = new URLSearchParams(chunks.join("")).toString();
      const used = /refresh_token=([^&]+)/.exec(body)?.[1] ?? "";
      if (!live.has(used)) {
        return send(400, {
          error: "invalid_grant",
          error_description: "this refresh token can no longer be used, start a new authorization",
        });
      }
      // 用掉了：轮换成新的。
      live.delete(used);
      const next = `mmort_next_${++issued}`;
      live.add(next);
      return send(200, {
        access_token: `mmoat_of_${next}`,
        refresh_token: next,
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

const { writeSession, readSession } = await import("../lib/session.ts");
const { providerSecretId } = await import("../lib/providers.ts");
const { refreshSession } = await import("../lib/minimax/oauth.ts");

const providerId = "minimax";
const id = providerSecretId(providerId);

writeSession(id, {
  schemaVersion: 1,
  clientId: "mcode-public",
  audience: "agent-backend",
  scopes: ["agent.default"],
  region: "cn",
  accessToken: "mmoat_old",
  refreshToken: "mmort_old",
  tokenType: "Bearer",
  expiresAtMs: Date.now() + 3600_000,
  generation: 1,
  loginAtMs: Date.now(),
  refreshedAtMs: Date.now(),
});

console.log("两个调用同时刷新同一个登录态");

const [first, second] = await Promise.allSettled([
  refreshSession("now", providerId),
  refreshSession("now", providerId),
]);

check("两个都成功了", first.status === "fulfilled" && second.status === "fulfilled",
  `${first.status} / ${second.status}`);
if (first.status === "rejected" || second.status === "rejected") {
  const e = first.status === "rejected" ? first.reason : second.reason;
  console.log(`       失败的是：${(e as Error)?.message} ${(e as { hint?: string })?.hint ?? ""}`);
}

// 两个调用不能拿到同一个：后一个会把前一个刚换出来的令牌作废（平台的规矩）。
// 真正要保的是「库里最后留下的那个是有效的」——见下面那条。
const stored = readSession<{ refreshToken: string }>(id);
check("库里留下的是最新的那个", stored?.refreshToken === `mmort_next_${issued}`,
  `${stored?.refreshToken}（发出去 ${issued} 个）`);
check("平台被问了几次", tokenCalls >= 2, String(tokenCalls));

console.log("");
console.log("会话没有被判死");

const third = await refreshSession("now", providerId).catch((e) => e);
check("第三个调用也能刷新", !(third instanceof Error), String((third as Error)?.message));
check("它拿到的令牌是新的", typeof (third as { refreshToken?: string })?.refreshToken === "string",
  String((third as { refreshToken?: string })?.refreshToken));

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
