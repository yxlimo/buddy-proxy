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
import { ensureBuiltinProviders } from "../lib/providers.ts";
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

// The sessions belong to the provider now: one per provider id.
setSecret("session:provider:qoder", "session", qoder("global"));
setSecret("session:provider:qoder-cn", "session", qoder("cn"));
setSecret("session:provider:workbuddy-cn", "session", workBuddy());

// The switches too: a fresh install has every built-in upstream off, and the
// offline test serves qoder (both regions) and workbuddy. TEST_UPSTREAMS says
// which ones this run needs.
ensureBuiltinProviders();
const ON = process.env.TEST_UPSTREAMS ?? "qoder,qoder-cn,workbuddy-cn";
const on = ON.split(",").map((id) => id.trim()).filter(Boolean);
for (const id of on) {
  store().prepare("UPDATE provider SET enabled = 1 WHERE id = ?").run(id);
}

console.log(`[test] 假会话写好了（qoder 全球区 / 中国区 / workbuddy 中国区），开着：${on.join("、")}`);
