// test/fake-sessions.ts — write the sessions the offline test needs.
//
// The self-test runs against the mock upstream, but the router still wants a
// credential for every upstream it is asked to serve: without one it starts
// the device flow (which would open a browser) and answers 503.
//
// So the test writes dummy sessions into its own database — the one under
// BUDDY_DATA_DIR, never the real one. The tokens are not real; the mock
// upstream does not look at them.
//
// The upstream switches live in the same database (provider.enabled), and a
// fresh install has every built-in upstream off. So this script turns on the
// ones the offline test needs — the same thing the panel's switch does.
//
//   node test/fake-sessions.ts

import { setSecret } from "../lib/store.ts";
import { addAccount } from "../lib/providers.ts";
import { saveTokenRhythmCredential } from "../lib/tokenrhythm/accounts.ts";
import { store } from "../lib/store.ts";

const now = Date.now();
const year = now + 365 * 24 * 3600 * 1000;

function qoder(region: "global" | "cn") {
  return {
    schemaVersion: 1,
    region,
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    accessToken: "dt-test-access-token",
    refreshToken: "drt-test-refresh-token",
    userId: "00000000-0000-0000-0000-000000000000",
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    machineId: "00000000-0000-4000-8000-000000000000",
    machineToken: "test-machine-token",
    machineType: "test-machine-type",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

function workBuddy() {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    uid: "test-uid",
    nickname: "test",
    domain: "www.workbuddy.cn",
    region: "cn",
    generation: 1,
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

// 一个平台下建一个账号（启动不再插行），会话与开关都挂在账号行上。
// TEST_UPSTREAMS 说这一趟要哪几个平台。
const ON = process.env.TEST_UPSTREAMS ?? "qoder,qoder-cn,workbuddy-cn";
const on = ON.split(",").map((id) => id.trim()).filter(Boolean);
const accountOf: Record<string, string> = {};
for (const platform of on) {
  const made = addAccount({ platform, alias: "测试账号" });
  if (!made.ok || !made.id) throw new Error(`加不了 ${platform} 的账号：${made.message}`);
  accountOf[platform] = made.id;
}

/** MiniMax Code 的会话：形状与真的那份一致（刷新时会按字段读）。 */
function miniMax() {
  return {
    schemaVersion: 1,
    clientId: "mcode-public",
    audience: "agent-backend",
    scopes: ["agent.default"],
    region: "cn",
    accessToken: "test-token",
    refreshToken: "test-refresh",
    tokenType: "Bearer",
    expiresAtMs: year,
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

// 会话挂在账号行上：qoder 两个区各一份，workbuddy 一份，minimax 一份。
if (accountOf["qoder"]) setSecret(`session:provider:${accountOf["qoder"]}`, "session", qoder("global"));
if (accountOf["qoder-cn"]) setSecret(`session:provider:${accountOf["qoder-cn"]}`, "session", qoder("cn"));
if (accountOf["workbuddy-cn"]) {
  setSecret(`session:provider:${accountOf["workbuddy-cn"]}`, "session", workBuddy());
}
if (accountOf["minimax"]) {
  setSecret(`session:provider:${accountOf["minimax"]}`, "session", miniMax());
}
// 中转站：账号密码（查余额）+ API key（发请求），两个都是假的，mock 不看。
if (accountOf["tokenrhythm"]) {
  saveTokenRhythmCredential(accountOf["tokenrhythm"], {
    account: "test-account%40example.com",
    password: "test-password",
    apiKey: "sk_tr_test_key_1",
  });
}

// 开关：新装的账号默认就是开着的，这里显式写一遍，免得将来默认值变了。
for (const platform of on) {
  store().prepare("UPDATE provider SET enabled = 1 WHERE id = ?").run(accountOf[platform]);
}

console.log(`[test] 假会话写好了（qoder 全球区 / 中国区 / workbuddy 中国区），开着：${on.join("、")}`);
