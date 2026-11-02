// test/account-lifecycle-check.ts — 账号的一生：登录、取消、删除、刷新。
//
//   node --experimental-strip-types test/account-lifecycle-check.ts
//
// 离线：假上游在本机起（MiniMax 的 OAuth、SenseNova 的控制台），不碰任何平台。
//
// 盯住的几件事：
//   1. 取消了的登录，平台批下来也不写凭据；删账号时还在等的登录被取消。
//   2. 删掉的账号 id 不复用，新账号不继承旧会话、旧缓存。
//   3. TokenRhythm 停用的账号不接请求（钉住之后被停用的也一样）。
//   4. SenseNova 账号 A 的 401 只清 A 的会话。
//   5. 两个刷新撞在同一份会话上：只换一次令牌。
//   6. 删 tokenrhythm 不影响 tokenrhythm-2 的旧记录；删后钉住的账户与死记号清掉。
//   7. 凭据指纹只留前 4 位。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "account-lifecycle-"));
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

function section(title: string): void {
  console.log("");
  console.log(title);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 设备流的轮询：approve 之前一直 pending。 */
let approve = false;
/** 设备流被问了几次。 */
let devicePolls = 0;
/** refresh_token 换令牌被问了几次。 */
let refreshCalls = 0;
/** SenseNova 控制台：哪个令牌答 401。 */
const refusedTokens = new Set<string>();

function jwt(scope: string): string {
  const payload = Buffer.from(JSON.stringify({ scope, sub: "u" })).toString("base64url");
  return `h.${payload}.s`;
}

const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "/";
    if (url.startsWith("/oauth2/token") && body.get("grant_type") === "refresh_token") {
      refreshCalls++;
      // 平台慢一点：两个刷新有机会撞上。
      await sleep(150);
      return send(200, {
        access_token: jwt("agent.default"),
        refresh_token: `mmort_rotated_${refreshCalls}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.startsWith("/oauth2/token")) {
      devicePolls++;
      if (!approve) return send(200, { status: "pending" });
      return send(200, {
        access_token: jwt("agent.default"),
        refresh_token: "mmort_approved",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.startsWith("/lite/console/")) {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (refusedTokens.has(token)) return send(401, { message: "unauthorized" });
      return send(200, { pools: [] });
    }
    send(404, { error: "not_found" });
  });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.MINIMAX_OAUTH_ORIGIN = base;
process.env.SENSENOVA_PLATFORM_BASE = base;
process.env.MINIMAX_POLL_INTERVAL_MS = "50";

const { addAccount, provider, setProviderEnabled } = await import("../lib/providers.ts");
const { getSecret, setSecret, listSecrets, setCached, peekCached, closeStore } = await import("../lib/store.ts");
const { driveLogin } = await import("../lib/login-flow.ts");
const { deleteAccount, logoutAccount } = await import("../lib/admin/accounts.ts");
const { getLoginStatus, cancelLogin } = await import("../lib/admin/login.ts");
const { deadSession, markSessionDead, writeSession } = await import("../lib/session.ts");
const { tokenFingerprint } = await import("../lib/credential.ts");

/* ------------------------------------------------------------------ *
 * 1. 取消登录
 * ------------------------------------------------------------------ */

section("取消了的登录不写凭据");

{
  const account = addAccount({ platform: "minimax", alias: "取消登录" }).id!;
  const ctx = { accountId: account, platform: "minimax", region: "" };
  const ticket = {
    method: "device" as const,
    authorizationUrl: "",
    userCode: "U",
    expiresAtMs: Date.now() + 10_000,
    message: "",
    state: { auth: { deviceCode: "D", codeVerifier: "V", userCode: "U", verificationUri: "x", expiresInSec: 10, intervalSec: 1 } },
  };
  // 平台批了，但轮询那一下回来时用户已经点了取消。
  approve = true;
  let wanted = true;
  const polls = devicePolls;
  let error: unknown = null;
  try {
    await driveLogin("minimax", ctx, ticket, ticket.expiresAtMs, () => {
      // 第一次问（轮询之前）还要；轮询回来再问时已经取消了。
      const answer = wanted;
      wanted = false;
      return answer;
    });
  } catch (e) {
    error = e;
  }
  check("平台被问过一次", devicePolls === polls + 1, String(devicePolls - polls));
  check("报的是取消", (error as Error)?.message?.includes("cancelled"), String((error as Error)?.message));
  check("会话没有写进去", getSecret(`session:provider:${account}`) === null);

  // 还要的那一次照常落库（对照组）。
  const ok = await driveLogin("minimax", ctx, ticket, ticket.expiresAtMs, () => true);
  check("没取消的登录照常落库", ok.credentialId === `session:provider:${account}` && getSecret(ok.credentialId) !== null);
  approve = false;
}

section("登录途中账号被删了：不写凭据");

{
  const account = addAccount({ platform: "minimax", alias: "删了的账号" }).id!;
  const ctx = { accountId: account, platform: "minimax", region: "" };
  const ticket = {
    method: "device" as const,
    authorizationUrl: "",
    userCode: "U",
    expiresAtMs: Date.now() + 10_000,
    message: "",
    state: { auth: { deviceCode: "D", codeVerifier: "V", userCode: "U", verificationUri: "x", expiresInSec: 10, intervalSec: 1 } },
  };
  // 面板那一行：pending 的登录。删账号时要被标成 cancelled。
  const loginId = "lifecycle-login-1";
  setCached(`login:${loginId}`, {
    loginId,
    upstreamId: "minimax",
    accountId: account,
    status: "pending",
    method: "device",
    authorizationUrl: "",
    userCode: "U",
    expiresAt: Date.now() + 60_000,
    message: "",
    username: "",
    poll: null,
    credentialId: "",
  });
  const wanted = () => (peekCached<{ status?: string }>(`login:${loginId}`)?.data?.status ?? "") === "pending";
  const running = driveLogin("minimax", ctx, ticket, ticket.expiresAtMs, wanted).then(
    () => null,
    (e: unknown) => e,
  );
  await sleep(80);
  const result = deleteAccount(account);
  check("账号删掉了", result.ok && provider(account) === null, result.message);
  check("pending 的登录被取消了", getLoginStatus(loginId)?.status === "cancelled", String(getLoginStatus(loginId)?.status));
  approve = true;
  const error = await running;
  approve = false;
  check("轮询停了，报的是取消", (error as Error)?.message?.includes("cancelled"), String((error as Error)?.message));
  check("删掉的账号没有凭据回来", getSecret(`session:provider:${account}`) === null);

  // 不靠登录行也挡得住：账号行没了，commit 之前那一问会拦下。
  approve = true;
  const orphan = await driveLogin("minimax", ctx, ticket, ticket.expiresAtMs, () => true).then(
    () => null,
    (e: unknown) => e,
  );
  approve = false;
  check("账号行不在就不落库", orphan !== null && getSecret(`session:provider:${account}`) === null, String(orphan));
  check("已经取消的登录不能再取消", cancelLogin(loginId).ok === false);
}

/* ------------------------------------------------------------------ *
 * 2. 账号 id 不复用
 * ------------------------------------------------------------------ */

section("删掉的账号 id 不复用");

{
  const a = addAccount({ platform: "qoder", alias: "一" }).id!;
  const b = addAccount({ platform: "qoder", alias: "二" }).id!;
  check("id 的形状没变", a === "qoder" && b === "qoder-2", `${a} ${b}`);
  setSecret(`session:provider:${b}`, "session", { accessToken: "old", refreshToken: "old", expiresAtMs: Date.now() + 3_600_000 });
  markSessionDead(`session:provider:${b}`, "旧的拒绝");
  deleteAccount(b);
  check("死记号跟着删了", deadSession(`session:provider:${b}`) === null);
  const c = addAccount({ platform: "qoder", alias: "三" }).id!;
  check("新账号拿的是新号", c === "qoder-3", c);
  check("新账号没有会话", getSecret(`session:provider:${c}`) === null);
  // 最前面那个删了也一样：不会再发 `qoder`。
  deleteAccount(a);
  deleteAccount(c);
  const d = addAccount({ platform: "qoder", alias: "四" }).id!;
  check("全删光了也接着往后排", d === "qoder-4", d);
}

section("注销清掉缓存里的凭据");

{
  const { ensureCredential } = await import("../lib/minimax/oauth.ts");
  const account = addAccount({ platform: "minimax", alias: "注销" }).id!;
  writeSession(`session:provider:${account}`, {
    schemaVersion: 1,
    clientId: "mcode-public",
    audience: "agent-backend",
    scopes: ["agent.default"],
    region: "cn",
    accessToken: "mmoat_cached",
    refreshToken: "mmort_cached",
    tokenType: "Bearer",
    expiresAtMs: Date.now() + 3_600_000,
    generation: 1,
    loginAtMs: Date.now(),
    refreshedAtMs: Date.now(),
  });
  const cred = await ensureCredential(account);
  check("先缓存上一份", cred.accessToken === "mmoat_cached");
  logoutAccount(account);
  const after = await ensureCredential(account).then(
    () => "still served",
    (e: unknown) => (e as Error).message,
  );
  check("注销之后缓存里那份不再发出去", after !== "still served", after);
}

/* ------------------------------------------------------------------ *
 * 3. TokenRhythm 停用的账号
 * ------------------------------------------------------------------ */

section("删 tokenrhythm 不碰 tokenrhythm-2 的旧记录");

{
  const first = addAccount({ platform: "tokenrhythm", alias: "首个" }).id!;
  check("首个账号就是平台 id", first === "tokenrhythm", first);
  // 旧库里按租户号存的记录：2 号是另一个账号的。
  setSecret("key:provider:tokenrhythm:tenant-2", "key", { key: "sk_two" });
  setSecret("account:tokenrhythm:2", "account", { account: "two", password: "pw" });
  setSecret("session:tokenrhythm:2", "session", { cookie: "tr_session=two" });
  setSecret("key:provider:tokenrhythm:tenant-1", "key", { key: "sk_one" });
  setSecret("key:provider:tokenrhythm:account", "account", { account: "one", password: "pw" });
  deleteAccount(first);
  check("自己的凭据删了", getSecret("key:provider:tokenrhythm:account") === null);
  check("自己那一号的旧记录删了", getSecret("key:provider:tokenrhythm:tenant-1") === null);
  check("2 号的旧 key 还在", getSecret("key:provider:tokenrhythm:tenant-2") !== null);
  check("2 号的旧账号还在", getSecret("account:tokenrhythm:2") !== null);
  check("2 号的旧登录态还在", getSecret("session:tokenrhythm:2") !== null);
}

section("TokenRhythm：停用的账号不接请求");

{
  const { usableAccounts, orderedAccounts } = await import("../lib/tokenrhythm/wallet.ts");
  const { setBalanceAccount, pinnedBalanceAccount } = await import("../lib/tokenrhythm/balance.ts");
  const one = addAccount({ platform: "tokenrhythm", alias: "一" }).id!;
  const two = addAccount({ platform: "tokenrhythm", alias: "二" }).id!;
  const status = (accountId: string, expiry: string) => ({
    accountId,
    account: "***",
    name: accountId,
    hasKey: true,
    credential: null,
    wallet: { currency: "CNY", availableCny: 10, giftAvailableCny: 10, rechargeCny: 0, giftTotalCny: 10, giftStatus: "", asOf: null },
    credits: { summary: { expiringCny: 10, nextExpiryAt: expiry }, list: [] },
    error: null,
  });
  const statuses = [status(one, "2026-12-01T00:00:00Z"), status(two, "2026-12-20T00:00:00Z")];
  check("都开着：两个都能用", usableAccounts(statuses).length === 2);
  setProviderEnabled(two, false);
  check("停用的那个不在可用里", usableAccounts(statuses).map((s) => s.accountId).join() === one);
  setProviderEnabled(two, true);

  // expiry_first：先钉住先到期的那个，再把它停用。
  const reader = async () => statuses;
  const pinned = await setBalanceAccount("tokenrhythm", reader);
  check("钉住的是先到期的那个", pinned?.accountId === one, String(pinned?.accountId));
  setProviderEnabled(one, false);
  check("钉住的被停用了就不算钉住", pinnedBalanceAccount("tokenrhythm") === null);
  const repinned = await setBalanceAccount("tokenrhythm", reader);
  check("重新钉的是另一个", repinned?.accountId === two, String(repinned?.accountId));
  check("排序里也没有停用的", orderedAccounts(statuses).every((s) => s.accountId !== one));
  setProviderEnabled(one, true);

  // 删账号：钉的是它就不钉了。
  await setBalanceAccount("tokenrhythm", async () => [status(two, "2026-11-01T00:00:00Z")]);
  check("现在钉的是二号", pinnedBalanceAccount("tokenrhythm")?.accountId === two);
  deleteAccount(two);
  check("删掉之后钉住的没了", pinnedBalanceAccount("tokenrhythm") === null);
  deleteAccount(one);
}

section("前缀按字面比");

{
  setSecret("key:provider:a_b:x", "key", { v: 1 });
  setSecret("key:provider:aXb:x", "key", { v: 2 });
  const ids = listSecrets("key:provider:a_b").map((r) => r.id);
  check("`_` 不是通配符", ids.length === 1 && ids[0] === "key:provider:a_b:x", JSON.stringify(ids));
}

/* ------------------------------------------------------------------ *
 * 4. SenseNova 的 401 只清自己
 * ------------------------------------------------------------------ */

section("SenseNova：A 的 401 只清 A");

{
  const { poolUsage } = await import("../lib/sensenova/quota.ts");
  const a = addAccount({ platform: "sensenova", alias: "A" }).id!;
  const b = addAccount({ platform: "sensenova", alias: "B" }).id!;
  const session = (token: string) => ({
    cookie: "",
    accessToken: token,
    refreshToken: `r-${token}`,
    expiresAtMs: Date.now() + 3_600_000,
    obtainedAtMs: Date.now(),
    username: token,
  });
  setSecret(`session:provider:${a}`, "session", session("token-a"));
  setSecret(`session:provider:${b}`, "session", session("token-b"));
  refusedTokens.add("token-a");
  const error = await poolUsage(session("token-a"), a).then(
    () => null,
    (e: unknown) => e,
  );
  check("A 拿到了 401", (error as { kind?: string })?.kind === "auth", String((error as Error)?.message));
  check("A 的会话清了", getSecret(`session:provider:${a}`) === null);
  check("B 的会话还在", getSecret(`session:provider:${b}`) !== null);

  // 没说是谁的：按令牌找到主人，也只清那一份。
  setSecret(`session:provider:${a}`, "session", session("token-a"));
  await poolUsage(session("token-a")).catch(() => {});
  check("不带账号也只清令牌的主人", getSecret(`session:provider:${a}`) === null && getSecret(`session:provider:${b}`) !== null);
}

/* ------------------------------------------------------------------ *
 * 5. 并发刷新只换一次
 * ------------------------------------------------------------------ */

section("两个刷新撞在同一份会话上：只换一次令牌");

{
  const { refreshSession } = await import("../lib/minimax/oauth.ts");
  const account = addAccount({ platform: "minimax", alias: "并发刷新" }).id!;
  writeSession(`session:provider:${account}`, {
    schemaVersion: 1,
    clientId: "mcode-public",
    audience: "agent-backend",
    scopes: ["agent.default"],
    region: "cn",
    accessToken: jwt("agent.default"),
    refreshToken: "mmort_due",
    tokenType: "Bearer",
    // 一分钟后到期：在临期（5 分钟）里面。
    expiresAtMs: Date.now() + 60_000,
    generation: 1,
    loginAtMs: Date.now(),
    refreshedAtMs: Date.now(),
  });
  const before = refreshCalls;
  const [x, y] = await Promise.all([refreshSession(account), refreshSession(account)]);
  check("平台只被问了一次", refreshCalls - before === 1, String(refreshCalls - before));
  check("两边拿到的是同一份新会话", x.refreshToken === y.refreshToken && x.refreshToken.startsWith("mmort_rotated_"), `${x.refreshToken} / ${y.refreshToken}`);
  const stored = getSecret<{ refreshToken?: string; generation?: number }>(`session:provider:${account}`);
  check("库里是换过的那张", stored?.refreshToken === x.refreshToken && stored?.generation === 2, JSON.stringify(stored));
}

/* ------------------------------------------------------------------ *
 * 6. 指纹
 * ------------------------------------------------------------------ */

section("凭据指纹");

{
  const fp = tokenFingerprint("mmoat_secret_value_1234567890");
  check("只留前 4 位", fp.startsWith("mmoa…") && !fp.includes("mmoat_s"), fp);
  check("不带长度", !fp.includes("(29)"), fp);
  check("同一个值同一个指纹", fp === tokenFingerprint("mmoat_secret_value_1234567890"));
  check("换一个值就是另一个", fp !== tokenFingerprint("mmoat_secret_value_1234567891"));
  const log = fs.readFileSync(path.join(tmp, "auth.log"), "utf8");
  check("auth.log 里没有完整的 refresh token", !log.includes("mmort_rotated_"), log.slice(0, 200));
}

fake.close();
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项\n  ${problems.join("\n  ")}` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
