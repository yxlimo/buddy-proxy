// test/credential-fault-check.ts — 凭据这一档的故障：路由与派发答什么。
//
//   node --experimental-strip-types test/credential-fault-check.ts
//
// 离线：一个请求都不发出去（这里只走到「答什么」这一步，连假上游都不起）。
//
// 三件事：
//
//   一、凭据过期了：平台前缀那条路答 400，文案说「过期」（要人刷新或重新登录）。
//   二、凭据读不出来：派发答 503，而且**不带** Retry-After —— 等一会儿不会
//      让凭据自己读出来，说「一分钟后再试」是骗人。
//   三、单一策略：那个账号的凭据读不出来 → 拒绝，不换到别的账号身上去。
//
// 怎么造「凭据读不出来」：把 secrets 表拿走（网关自己的故障，不是运维没配好）。
// 怎么造「凭据过期」：会话的到期时间放在过去。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlatformAvailability } from "../lib/router/availability.ts";
import type { RoutingContext } from "../lib/router/routes.ts";

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

/** 跑一次，拿到它抛出来的错（没有抛就是 null）。 */
function caught(run: () => unknown): any {
  try {
    run();
  } catch (e) {
    return e;
  }
  return null;
}

/** 这个错误带不带 Retry-After（没有就是「不知道什么时候能好」）。 */
function retryAfterOf(error: unknown): number | undefined {
  return (error as { retryAfterUntilMs?: number } | null)?.retryAfterUntilMs;
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "credential-fault-"));
// 数据目录要在导入库模块之前定下来：store 是进程里的单例。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { addAccount, listProviders } = await import("../lib/providers.ts");
const { setSecret, store } = await import("../lib/store.ts");
const { setPlatformPolicy } = await import("../lib/platforms.ts");
const { platformAvailability } = await import("../lib/router/availability.ts");
const { routeInGroup, platformWithoutAccount } = await import("../lib/router/routes.ts");
const { underPolicy } = await import("../lib/router/upstreams/policy.ts");

/** Qoder 的会话：形状与真的那份一致（推理凭据就是登录会话本身）。 */
function qoderSession(expiresAtMs: number): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 1,
    region: "global",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    accessToken: "dt-test-token",
    refreshToken: "drt-test-token",
    userId: "test-user",
    expiresAtMs,
    refreshExpiresAtMs: expiresAtMs,
    machineId: "test-machine",
    machineToken: "test-machine-token",
    machineType: "test",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

/** 路由看到的那个平台：与 handle.ts 的 routingContext 同一个形状。 */
function routingContextOf(availability: PlatformAvailability): RoutingContext {
  return {
    platforms: new Map([
      [
        availability.platform,
        {
          kind: availability.kind,
          // 开着**而且**有可用凭据的账号才算数（handle.ts 的 routingContext）。
          enabled: availability.serving.length > 0,
          accounts: availability.accounts,
          ids: new Set(availability.ids),
          untilMs: availability.untilMs,
          state: availability.state,
        },
      ],
    ]),
  };
}

/* ------------------------------------------------------------------ *
 * 一、凭据过期：平台前缀那条路答 400
 * ------------------------------------------------------------------ */

section("凭据过期了");

const made = addAccount({ platform: "qoder", alias: "凭据过期的" });
if (!made.ok || !made.id) throw new Error(`加不了 Qoder 的账号：${made.message}`);
const accountId = String(made.id);
// 到期时间放在过去：定时器还没刷到这一轮。
setSecret(`session:provider:${accountId}`, "session", qoderSession(Date.now() - 60_000));

const expired = platformAvailability("qoder");
check("会话过期 → 判定是 credential_expired", expired.state === "credential_expired", expired.state);
check("会话过期 → 没有恢复时刻（等的是人，不是钟）", expired.untilMs === null, String(expired.untilMs));
check("会话过期 → 那个账号接不了", expired.usable.length === 0, String(expired.usable.length));

const expiredAnswer = caught(() => routeInGroup("qoder", expired.ids[0] ?? "glm-5.3", routingContextOf(expired)));
check("凭据过期 → 平台前缀那条路答 400", expiredAnswer?.status === 400, String(expiredAnswer?.status));
check(
  "凭据过期 → 说的是凭据过期了",
  String(expiredAnswer?.message ?? "").includes("has an expired credential"),
  String(expiredAnswer?.message),
);
check("凭据过期 → 文案说「过期」", String(expiredAnswer?.hint ?? "").includes("过期"), String(expiredAnswer?.hint));
check("凭据过期 → 文案说该怎么办", String(expiredAnswer?.hint ?? "").includes("重新登录"), String(expiredAnswer?.hint));
check("凭据过期 → 没有 Retry-After", retryAfterOf(expiredAnswer) === undefined, String(retryAfterOf(expiredAnswer)));

/* ------------------------------------------------------------------ *
 * 二、凭据读不出来：派发答 503，不带 Retry-After
 * ------------------------------------------------------------------ */

section("凭据读不出来");

// 让凭据真的读不出来：把 secrets 表拿走。这是网关自己的故障，不是运维没配好。
store().exec("DROP TABLE secrets");

const broken = platformAvailability("qoder");
check("凭据读不出来 → 判定是 credential_unknown", broken.state === "credential_unknown", broken.state);
check("凭据读不出来 → 没有恢复时刻", broken.untilMs === null, String(broken.untilMs));
check(
  "读不出来的账号不进 usable（不可验证的账号不该被派发挑中）",
  broken.usable.length === 0,
  String(broken.usable.length),
);
check("读不出来的账号仍算名下有账号", broken.serving.length > 0, String(broken.serving.length));

// 平台前缀那条路走的是派发（凭据读不出来时那个账号仍算「名下有账号」），
// 这一档的答复在派发那边答。平台整体接不了时（没有可用的账号了）才用这一档。
const platformAnswer = platformWithoutAccount("qoder", "credential_unknown");
check("凭据读不出来 → 平台接不了时答 503", platformAnswer.status === 503, String(platformAnswer.status));
check(
  "凭据读不出来 → 说的是凭据读不出来",
  String(platformAnswer.message).includes("has an unreadable credential"),
  platformAnswer.message,
);
check("凭据读不出来 → 文案说「读不出来」", platformAnswer.hint.includes("读不出来"), platformAnswer.hint);
check("凭据读不出来 → 没有 Retry-After", retryAfterOf(platformAnswer) === undefined, String(retryAfterOf(platformAnswer)));

// 派发：降级策略（不走「单一」那一支），一个能接的账号都没有。
setPlatformPolicy("qoder", "fallback");
const tried: string[] = [];
let dispatchFailure: any = null;
try {
  await underPolicy("qoder", "test", async (account) => {
    tried.push(account.id);
    return account.id;
  });
} catch (e) {
  dispatchFailure = e;
}
check("凭据读不出来 → 派发答 503", dispatchFailure?.status === 503, String(dispatchFailure?.status));
check("凭据读不出来 → 文案说「读不出来」", String(dispatchFailure?.hint ?? "").includes("读不出来"), String(dispatchFailure?.hint));
check(
  "凭据读不出来 → 没有 Retry-After（等一会儿不会让凭据自己读出来）",
  retryAfterOf(dispatchFailure) === undefined,
  String(retryAfterOf(dispatchFailure)),
);
check("凭据读不出来 → 一个账号都没打", tried.length === 0, tried.join(","));

/* ------------------------------------------------------------------ *
 * 三、单一策略：那个账号的凭据读不出来 → 拒绝，不换账号
 * ------------------------------------------------------------------ */

section("单一策略：凭据读不出来不换账号");

setPlatformPolicy("qoder", "single");

const singleTried: string[] = [];
let singleFailure: any = null;
try {
  await underPolicy("qoder", "test", async (account) => {
    singleTried.push(account.id);
    return account.id;
  });
} catch (e) {
  singleFailure = e;
}
check("单一策略 + 凭据读不出来 → 拒绝", singleFailure !== null, "没有抛错");
check("单一策略 + 凭据读不出来 → 答 503", singleFailure?.status === 503, String(singleFailure?.status));
check("单一策略 + 凭据读不出来 → 没有换到别的账号", singleTried.length === 0, singleTried.join(","));

// 名下还有一个好着的账号时也一样：面板上写着单一，流量就不能悄悄落到别处。
//
// 这里用一份算好的可用性（underPolicy 的 availability 参数就是给这一层用的）：
// 那个账号的凭据读不出来，另一个账号好着。
const row = listProviders().find((r) => r.platform === "qoder");
if (!row) throw new Error("找不到那个 Qoder 账号");
const spare = { ...row, id: "qoder-spare", weight: 10 };
const mixed: PlatformAvailability = {
  platform: "qoder",
  kind: "qoder",
  state: "credential_unknown",
  usable: [spare],
  serving: [row],
  cooling: new Map<string, number>(),
  spent: new Map<string, number>(),
  accounts: 2,
  rows: [row, spare],
  on: 2,
  advice: "凭据读不出来：看日志",
  catalog: [],
  ids: [],
  untilMs: null,
  reason: "凭据读不出来",
};

const mixedTried: string[] = [];
let mixedFailure: any = null;
try {
  await underPolicy(
    "qoder",
    "test",
    async (account) => {
      mixedTried.push(account.id);
      return account.id;
    },
    undefined,
    mixed,
  );
} catch (e) {
  mixedFailure = e;
}
check("名下还有好账号时也拒绝", mixedFailure !== null, "没有抛错");
check("名下还有好账号时答 503", mixedFailure?.status === 503, String(mixedFailure?.status));
check("名下还有好账号时没有换过去", mixedTried.length === 0, mixedTried.join(","));
check(
  "名下还有好账号时说的是凭据读不出来",
  String(mixedFailure?.hint ?? "").includes("读不出来"),
  String(mixedFailure?.hint),
);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  console.log("查出来的问题：");
  for (const problem of problems) console.log(`  - ${problem}`);
}
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
