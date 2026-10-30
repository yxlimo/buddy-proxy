// test/admin-login-check.ts — 登录授权的自测。
//
//   node --experimental-strip-types test/admin-login-check.ts
//
// 不真的登录：起一个假的上游（回答 device code 与 state），看网关是不是把
// 「开始」分派到了对的地方、状态机是不是按预期的走、半凭据有没有漏进日志。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { startGateway as startHarness } from "./harness.ts";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-admin-login";
const SERVICE = "/buddy.admin.v1.AdminService";

/** 假上游给的东西：一眼就能在日志里找到。 */
const FAKE_DEVICE_CODE = "DEVICE-CODE-MUST-NOT-LEAK";
const FAKE_USER_CODE = "ABCD-EFGH";
const FAKE_STATE = "STATE-MUST-NOT-LEAK";
const FAKE_VERIFIER = "VERIFIER-MUST-NOT-LEAK";
/** 第二次要 device code 时给这一个：轮询它会同意。 */
const GOOD_DEVICE_CODE = "DEVICE-CODE-OK";

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
 * 假的上游
 * ------------------------------------------------------------------ */

/** 发了第几次 device code 请求。 */
let deviceCodeRequests = 0;
/** 发了第几次 zcode poll 请求：第一次 pending，第二次 ready。 */
let zcodePollRequests = 0;
/** 发了第几次 minimax token 请求：第一次还在等，第二次才批。 */
let minimaxTokenRequests = 0;
/** 发了第几次 qoder 的 deviceToken poll。 */
let qoderPollRequests = 0;
/**
 * 自测放行的那一次登录的 nonce。
 *
 * 上游的 poll 端点用 404 说「用户还没点」：那是等待，不是失败。只有 nonce
 * 对得上的那一次登录才会被批，别的登录（取消、过期那些）一直 404。
 */
let qoderApproveNonce = "";

const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/oauth2/device/code")) {
    // 第一次给一个会被拒绝的，第二次给一个会被同意的。
    deviceCodeRequests++;
    const code = deviceCodeRequests === 1 ? FAKE_DEVICE_CODE : GOOD_DEVICE_CODE;
    res.end(
      JSON.stringify({
        device_code: code,
        user_code: FAKE_USER_CODE,
        verification_uri: "https://example.invalid/authorize",
        verification_uri_complete: "https://example.invalid/authorize?user_code=" + FAKE_USER_CODE,
        expires_in: 300,
        interval: 3,
      }),
    );
    return;
  }
  if (req.url?.startsWith("/oauth2/token")) {
    if (body.includes(GOOD_DEVICE_CODE)) {
      minimaxTokenRequests++;
      if (minimaxTokenRequests === 1) {
        // 用户还没点：上游还在等。
        res.end(JSON.stringify({ status: "pending" }));
        return;
      }
      // 同意了。
      res.end(
        JSON.stringify({
          access_token: "at-test",
          refresh_token: "rt-test",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "agent.default",
        }),
      );
      return;
    }
    // 用户拒绝了。
    res.end(JSON.stringify({ error: "access_denied", error_description: "the user denied it" }));
    return;
  }
  if (req.url?.startsWith("/api/v1/deviceToken/poll")) {
    qoderPollRequests++;
    const nonce = new URL(req.url, "http://127.0.0.1").searchParams.get("nonce") ?? "";
    if (nonce !== qoderApproveNonce) {
      // 上游说「用户还没点」：这是等待，不是失败。
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        token: "qoder-at-test",
        refresh_token: "qoder-rt-test",
        user_id: "qoder-u-1",
        expire_time: 3600,
        refresh_token_expire_time: 86400,
      }),
    );
    return;
  }
  if (req.url?.startsWith("/v2/plugin/auth/state")) {
    res.end(
      JSON.stringify({
        code: 0,
        data: { state: FAKE_STATE, authUrl: "https://example.invalid/workbuddy-login?state=" + FAKE_STATE },
      }),
    );
    return;
  }
  if (req.url?.startsWith("/api/v1/oauth/cli/init")) {
    res.end(
      JSON.stringify({
        data: {
          flow_id: "flow-1",
          authorize_url: "https://example.invalid/zcode-login?flow=flow-1",
          poll_token: "pt-1",
          expires_at: Math.floor(Date.now() / 1000) + 600,
        },
      }),
    );
    return;
  }
  if (req.url?.startsWith("/api/v1/oauth/cli/poll/")) {
    zcodePollRequests++;
    if (zcodePollRequests === 1) {
      res.end(JSON.stringify({ data: { status: "pending" } }));
      return;
    }
    res.end(
      JSON.stringify({
        data: { status: "ready", token: "zcode-test-token", user: { user_id: "u-1" } },
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
const mockPort = (mock.address() as net.AddressInfo).port;
const mockBase = `http://127.0.0.1:${mockPort}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// 起网关交给共用的 helper：端口被抢就换号重试，失败一定收尾。
const gw = await startHarness({
  dataDir: DATA_DIR,
  keepDataDir: true,
  env: {
    // 上游全关：自测不碰任何平台，也不自动登录。
    MINIMAX_CODE: "",
    QODER_GLOBAL: "",
    QODER_CN: "",
    WORKBUDDY_CN: "",
    TOKENRHYTHM: "",
    // 假的上游。
    MINIMAX_OAUTH_ORIGIN: mockBase,
    WORKBUDDY_CN_BASE: mockBase,
    ZCODE_BASE_URL: mockBase,
    // Qoder 的 poll 也指到假上游：自测不碰真平台。
    QODER_GLOBAL_OPENAPI_BASE: mockBase,
    QODER_CN_OPENAPI_BASE: mockBase,
    // 轮询快一点：自测不用等上游那一秒。
    ZCODE_POLL_INTERVAL_MS: "200",
    MINIMAX_POLL_INTERVAL_MS: "200",
    QODER_POLL_INTERVAL_MS: "200",
  },
});
const base = gw.base;
/** helper 收集的子进程输出。 */
const log = () => gw.log();
process.on("exit", () => {
  mock.close();
});

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();



/** 打一个 Connect 方法。 */
async function call(method: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// 登录落在账号行上，而启动不再插行：先把每个平台下的账号按面板的做法加出来。
// 面板点「登录」时带着账号 id；不带就落在这个平台的第一个账号上。
for (const platform of ["minimax", "qiniu", "qoder", "qoder-cn", "workbuddy-cn", "zcode", "tokenrhythm", "sensenova", "intern-ai"]) {
  const made = await call("AddAccount", { platform });
  if (made.body?.ok !== true) console.log(`  （加不了 ${platform} 的账号：${JSON.stringify(made.body)}）`);
}

/** 等到满足条件为止。条件可以是异步的。 */
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 15000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 开始
 * ------------------------------------------------------------------ */

console.log("");
console.log("开始：各上游的分派");

const minimax = await call("BeginLogin", { upstreamId: "minimax" });
check("MiniMax 开始了", minimax.body?.ok === true, JSON.stringify(minimax.body));
check("MiniMax 是设备流", minimax.body?.session?.method === "device", JSON.stringify(minimax.body?.session));
check("MiniMax 有大字码", minimax.body?.session?.userCode === FAKE_USER_CODE, JSON.stringify(minimax.body?.session));
check(
  "MiniMax 的链接是完整的那条",
  String(minimax.body?.session?.authorizationUrl ?? "").includes(FAKE_USER_CODE),
  JSON.stringify(minimax.body?.session?.authorizationUrl),
);
check("MiniMax 还没完", minimax.body?.session?.status === "pending", JSON.stringify(minimax.body?.session?.status));
check(
  "MiniMax 有过期时间",
  Number(minimax.body?.session?.expiresAt) > Date.now(),
  String(minimax.body?.session?.expiresAt),
);

const qoder = await call("BeginLogin", { upstreamId: "qoder" });
check("Qoder 开始了", qoder.body?.ok === true, JSON.stringify(qoder.body));
check("Qoder 是设备流", qoder.body?.session?.method === "device", JSON.stringify(qoder.body?.session));
check("Qoder 没有大字码", !qoder.body?.session?.userCode, JSON.stringify(qoder.body?.session?.userCode));
check(
  "Qoder 的链接带挑战",
  String(qoder.body?.session?.authorizationUrl ?? "").includes("challenge="),
  JSON.stringify(qoder.body?.session?.authorizationUrl),
);
check(
  "Qoder 的链接带机器 token",
  String(qoder.body?.session?.authorizationUrl ?? "").includes("machine_token="),
  JSON.stringify(qoder.body?.session?.authorizationUrl),
);

const qoderCn = await call("BeginLogin", { upstreamId: "qoder-cn" });
check("Qoder 中国区开始了", qoderCn.body?.ok === true, JSON.stringify(qoderCn.body));
check(
  "Qoder 中国区是另一个域",
  String(qoderCn.body?.session?.authorizationUrl ?? "").includes("qoder.cn"),
  JSON.stringify(qoderCn.body?.session?.authorizationUrl),
);

const workbuddy = await call("BeginLogin", { upstreamId: "workbuddy-cn" });
check("WorkBuddy 开始了", workbuddy.body?.ok === true, JSON.stringify(workbuddy.body));
check("WorkBuddy 是浏览器流", workbuddy.body?.session?.method === "browser", JSON.stringify(workbuddy.body?.session));
check(
  "WorkBuddy 的链接是上游给的那条",
  String(workbuddy.body?.session?.authorizationUrl ?? "").includes(FAKE_STATE),
  JSON.stringify(workbuddy.body?.session?.authorizationUrl),
);

const zcode = await call("BeginLogin", { upstreamId: "zcode" });
check("ZCode 开始了", zcode.body?.ok === true, JSON.stringify(zcode.body));
check("ZCode 是浏览器流", zcode.body?.session?.method === "browser", JSON.stringify(zcode.body?.session));
check(
  "ZCode 的链接是上游给的那条",
  String(zcode.body?.session?.authorizationUrl ?? "").includes("zcode-login"),
  JSON.stringify(zcode.body?.session?.authorizationUrl),
);

const tokenrhythm = await call("BeginLogin", { upstreamId: "tokenrhythm" });
check("TokenRhythm 是密码流", tokenrhythm.body?.session?.method === "password", JSON.stringify(tokenrhythm.body?.session));

const sensenova = await call("BeginLogin", { upstreamId: "sensenova" });
check("SenseNova 是密码流", sensenova.body?.session?.method === "password", JSON.stringify(sensenova.body?.session));

const internAi = await call("BeginLogin", { upstreamId: "intern-ai", site: "chat" });
check("intern-ai 是回填流", internAi.body?.session?.method === "token", JSON.stringify(internAi.body?.session));
check(
  "intern-ai 给了 SSO 的登录页",
  String(internAi.body?.session?.authorizationUrl ?? "").includes("sso."),
  JSON.stringify(internAi.body?.session?.authorizationUrl),
);

const unknown = await call("BeginLogin", { upstreamId: "nope" });
check("不认识的上游不开始", unknown.body?.ok !== true, JSON.stringify(unknown.body));
check("说的是人话", typeof unknown.body?.message === "string" && unknown.body.message.length > 0);

// 七牛云也是 API-key 平台：点登录要说清楚用 API Key 按钮，别让人以为是坏了。
const qiniu = await call("BeginLogin", { upstreamId: "qiniu" });
check("七牛不开始登录", qiniu.body?.ok !== true, JSON.stringify(qiniu.body));
check(
  "七牛说该用 API Key",
  String(qiniu.body?.message ?? "").includes("API Key"),
  JSON.stringify(qiniu.body?.message),
);
check(
  "七牛不再说「没有登录的办法」",
  !String(qiniu.body?.message ?? "").includes("还没有登录的办法"),
  JSON.stringify(qiniu.body?.message),
);

console.log("");
console.log("cache 表与会话");

const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
// The gateway writes in WAL mode; a reader that does not speak WAL sees the
// main file only, which is what a checkpoint has written so far.
db.exec("PRAGMA journal_mode = WAL");
const rows = db.prepare("SELECT id, data FROM cache WHERE id LIKE 'login:%'").all() as any[];
check("会话写进了 cache 表", rows.length >= 6, String(rows.length));

const minimaxRow = rows.find((r) => r.id === `login:${minimax.body?.session?.loginId}`);
check("MiniMax 的会话在 cache 表里", Boolean(minimaxRow), JSON.stringify(rows.map((r) => r.id)));
const stored = JSON.parse(String(minimaxRow?.data ?? "{}"));
check("会话记着上游", stored.upstreamId === "minimax", JSON.stringify(stored.upstreamId));
check("会话记着轮询材料", Boolean(stored.poll?.auth?.deviceCode), JSON.stringify(Object.keys(stored.poll ?? {})));
check(
  "轮询材料里有 device code",
  String(stored.poll?.auth?.deviceCode) === FAKE_DEVICE_CODE,
  JSON.stringify(stored.poll?.auth?.deviceCode),
);
check(
  "轮询材料里有 code verifier",
  typeof stored.poll?.auth?.codeVerifier === "string" && stored.poll.auth.codeVerifier.length > 0,
);

// Qoder 的半凭据：挑战、nonce 与机器 token 都在这一行里。
const qoderRow = db.prepare("SELECT data FROM cache WHERE id = ?").get(`login:${qoder.body?.session?.loginId}`) as any;
check("Qoder 的会话在 cache 表里", Boolean(qoderRow), JSON.stringify(rows.map((r) => r.id)));
const qoderStored = JSON.parse(String(qoderRow?.data ?? "{}"));
check(
  "Qoder 的轮询材料里有 nonce",
  String(qoderStored?.poll?.auth?.nonce ?? "").length > 0,
  JSON.stringify(Object.keys(qoderStored?.poll?.auth ?? {})),
);
check(
  "Qoder 的轮询材料里有机器 token",
  String(qoderStored?.poll?.auth?.machineToken ?? "").length > 0,
  JSON.stringify(Object.keys(qoderStored?.poll?.auth ?? {})),
);

console.log("");
console.log("日志里没有材料");

check("日志里没有 device code", !log().includes(FAKE_DEVICE_CODE));
check("日志里没有 state", !log().includes(FAKE_STATE));
check("日志里没有 code verifier", !log().includes(FAKE_VERIFIER));

console.log("");
console.log("状态机");

// 没有轮询的那条（密码流）会一直 pending。
const pending = await call("GetLoginStatus", { loginId: tokenrhythm.body?.session?.loginId });
check("查得到这次登录", pending.body?.ok === true, JSON.stringify(pending.body));
check("还是 pending", pending.body?.session?.status === "pending", JSON.stringify(pending.body?.session?.status));
check("方法还是密码流", pending.body?.session?.method === "password", JSON.stringify(pending.body?.session?.method));

// 轮询被拒 → 失败。
const failed = await waitFor(async () => {
  const res = await call("GetLoginStatus", { loginId: minimax.body?.session?.loginId });
  return res.body?.session?.status === "failed";
});
check("轮询失败会变成 failed", failed, "一直是 pending");
const failedStatus = await call("GetLoginStatus", { loginId: minimax.body?.session?.loginId });
check(
  "失败时给的是人话",
  String(failedStatus.body?.session?.message ?? "").includes("拒绝"),
  JSON.stringify(failedStatus.body?.session?.message),
);
check(
  "失败时机器能读出码",
  String(failedStatus.body?.session?.message ?? "").includes("access_denied"),
  JSON.stringify(failedStatus.body?.session?.message),
);

// 轮询同意 → 成功，凭据落库。
const approved = await call("BeginLogin", { upstreamId: "minimax" });
check("第二次开始了", approved.body?.ok === true, JSON.stringify(approved.body));
const becameApproved = await waitFor(async () => {
  const res = await call("GetLoginStatus", { loginId: approved.body?.session?.loginId });
  return res.body?.session?.status === "approved";
});
check("轮询同意会变成 approved", becameApproved, "没有变成 approved");
check(
  "上游先说还在等，再批（框架自己问的）",
  minimaxTokenRequests >= 2,
  String(minimaxTokenRequests),
);
const approvedStatus = await call("GetLoginStatus", { loginId: approved.body?.session?.loginId });
check(
  "成功时带着凭据的摘要",
  // 凭据状态是契约里的枚举，JSON 里是枚举的名字。
  approvedStatus.body?.session?.credential?.status === "CREDENTIAL_STATE_USABLE",
  JSON.stringify(approvedStatus.body?.session),
);
const secretAppeared = await waitFor(() =>
  Boolean((db.prepare("SELECT data FROM secrets WHERE id = ?").get("session:provider:minimax") as any)?.data),
);
check("凭据落进了 secrets 表", secretAppeared, JSON.stringify(db.prepare("SELECT id FROM secrets").all()));
const storedSecret = db
  .prepare("SELECT data FROM secrets WHERE id = ?")
  .get("session:provider:minimax") as any;
check(
  "落库的凭据里有 access token",
  String(storedSecret?.data ?? "").includes("at-test"),
  String(storedSecret?.data).slice(0, 80),
);

// ZCode：浏览器 OAuth，轮询同意后凭据落库。
const zcodeApproved = await waitFor(async () => {
  const res = await call("GetLoginStatus", { loginId: zcode.body?.session?.loginId });
  return res.body?.session?.status === "approved";
});
check("ZCode 轮询同意会变成 approved", zcodeApproved, "没有变成 approved");
const zcodeSecret = db.prepare("SELECT data FROM secrets WHERE id = ?").get("session:provider:zcode") as any;
check("ZCode 的凭据落进了 secrets 表", Boolean(zcodeSecret?.data), JSON.stringify(db.prepare("SELECT id FROM secrets").all()));

// Qoder：上游用 404 说「用户还没批」，那是等待，不是失败。
const qoderAsked = await waitFor(() => qoderPollRequests >= 1);
check("Qoder 的上游被问过了", qoderAsked, String(qoderPollRequests));
const qoderPending = await call("GetLoginStatus", { loginId: qoder.body?.session?.loginId });
check(
  "上游回 404 时还是 pending",
  qoderPending.body?.session?.status === "pending",
  JSON.stringify(qoderPending.body?.session?.status),
);
check(
  "上游回 404 时不是 failed",
  qoderPending.body?.session?.status !== "failed",
  JSON.stringify(qoderPending.body?.session?.status),
);

// 放行：上游批了这一次登录。
qoderApproveNonce = String(qoderStored?.poll?.auth?.nonce ?? "");
const qoderApproved = await waitFor(async () => {
  const res = await call("GetLoginStatus", { loginId: qoder.body?.session?.loginId });
  return res.body?.session?.status === "approved";
});
check("Qoder 轮询同意会变成 approved", qoderApproved, "没有变成 approved");
const qoderAccountId = String(qoderStored?.accountId ?? "");
const qoderSecretAppeared = await waitFor(() =>
  Boolean((db.prepare("SELECT data FROM secrets WHERE id = ?").get(`session:provider:${qoderAccountId}`) as any)?.data),
);
check("Qoder 的凭据落进了 secrets 表", qoderSecretAppeared, JSON.stringify(db.prepare("SELECT id FROM secrets").all()));
const qoderSecret = db
  .prepare("SELECT id, data FROM secrets WHERE id = ?")
  .get(`session:provider:${qoderAccountId}`) as any;
check(
  "Qoder 的凭据 id 是 session:provider:<账号>",
  String(qoderSecret?.id ?? "") === `session:provider:${qoderAccountId}`,
  String(qoderSecret?.id),
);
check(
  "落库的 Qoder 凭据里有 access token",
  String(qoderSecret?.data ?? "").includes("qoder-at-test"),
  String(qoderSecret?.data).slice(0, 80),
);

// 取消。
const cancelTarget = await call("BeginLogin", { upstreamId: "qoder" });
const cancelled = await call("CancelLogin", { loginId: cancelTarget.body?.session?.loginId });
check("取消得了", cancelled.body?.ok === true, JSON.stringify(cancelled.body));
const afterCancel = await call("GetLoginStatus", { loginId: cancelTarget.body?.session?.loginId });
check("取消之后是 cancelled", afterCancel.body?.session?.status === "cancelled", JSON.stringify(afterCancel.body?.session));
const cancelAgain = await call("CancelLogin", { loginId: cancelTarget.body?.session?.loginId });
check("取消两次不行", cancelAgain.body?.ok !== true, JSON.stringify(cancelAgain.body));

// 过期：把那一行的过期时间改到过去。
const expireTarget = await call("BeginLogin", { upstreamId: "qoder-cn" });
const expireId = expireTarget.body?.session?.loginId;
const expireRow = db.prepare("SELECT data FROM cache WHERE id = ?").get(`login:${expireId}`) as any;
const expireData = JSON.parse(String(expireRow?.data ?? "{}"));
expireData.expiresAt = Date.now() - 1000;
db.prepare("UPDATE cache SET data = ? WHERE id = ?").run(JSON.stringify(expireData), `login:${expireId}`);
const expired = await call("GetLoginStatus", { loginId: expireId });
check("过了时间就是 expired", expired.body?.session?.status === "expired", JSON.stringify(expired.body?.session?.status));
check(
  "过期时给的是人话",
  String(expired.body?.session?.message ?? "").includes("过期"),
  JSON.stringify(expired.body?.session?.message),
);

const unknownStatus = await call("GetLoginStatus", { loginId: "no-such-login" });
check("查不到就说查不到", unknownStatus.body?.ok !== true, JSON.stringify(unknownStatus.body));

console.log("");
console.log("账号密码、换码与回填");

// 面板上要有地方点：能登录的账号都在列表里。
const accounts = await call("ListAccounts", {});
const accountList = Array.isArray(accounts.body?.accounts) ? accounts.body.accounts : [];
check("MiniMax 在账号列表里", accountList.some((a: any) => a.id === "minimax"));
check("Qoder 中国区在账号列表里", accountList.some((a: any) => a.id === "qoder-cn"));
check("WorkBuddy 在账号列表里", accountList.some((a: any) => a.id === "workbuddy-cn"));
check("SenseNova 在账号列表里", accountList.some((a: any) => a.id === "sensenova"));
check("intern-ai 在账号列表里", accountList.some((a: any) => a.id === "intern-ai"));

// 密码型上游不走 BeginLogin 的轮询；这里只验分派与错误。
const wrongUpstream = await call("LoginWithPassword", { upstreamId: "qoder", username: "x", password: "y" });
check("不用密码的上游会拒绝", wrongUpstream.body?.ok !== true, JSON.stringify(wrongUpstream.body));
check("拒绝时说的是人话", String(wrongUpstream.body?.message ?? "").length > 0);

const noAccount = await call("LoginWithPassword", { upstreamId: "tokenrhythm", accountId: "no-such-account", username: "x", password: "y" });
check("没有那个账号就不登", noAccount.body?.ok !== true, JSON.stringify(noAccount.body));

const noToken = await call("ImportLoginToken", { upstreamId: "intern-ai", token: "", site: "chat" });
check("空 token 不导入", noToken.body?.ok !== true, JSON.stringify(noToken.body));

const wrongImport = await call("ImportLoginToken", { upstreamId: "qoder", token: "x" });
check("不用回填的上游会拒绝", wrongImport.body?.ok !== true, JSON.stringify(wrongImport.body));

const noCode = await call("ExchangeLoginCode", { upstreamId: "intern-ai", code: "" });
check("空授权码不换", noCode.body?.ok !== true, JSON.stringify(noCode.body));

// 每个平台都得有登录链或显式声明「没有」：新接一个平台忘了登记，这条会红。
{
  const { allKinds } = await import("../lib/provider-kinds.ts");
  const { loginFlowOf, noLoginFlowReason } = await import("../lib/login-flow.ts");
  const naked = allKinds()
    .map((k) => k.kind)
    .filter((kind) => !loginFlowOf(kind) && !noLoginFlowReason(kind));
  check("每个平台都有登录链或显式声明", naked.length === 0, naked.join("、"));
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
try {
  router.kill("SIGTERM");
} catch {
  /* 已经走了 */
}
mock.close();
process.exit(fail ? 1 : 0);
