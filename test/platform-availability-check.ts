// test/platform-availability-check.ts — 平台能不能接请求：一个判定，四处都用它。
//
//   node --experimental-strip-types test/platform-availability-check.ts
//
// 离线：假的上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 分两部分：
//
//   一、判定本身（在本进程里算）：账号、开关、凭据、额度、冷却各是一种状态。
//      状态对不对、「最早能试的时刻」是不是未来的时刻。另外还有一档不在账号上：
//      最近每次请求都被上游排进队列的平台不能说成就绪（一之六）。
//   二、路由与健康检查（真网关 + 假上游）：没有凭据的平台不公布模型、请求被
//      拒并说清是「没凭据」；把凭据填回去它就回来了（反证：不填就回不去）。
//
// 为什么用两个数据目录：额度快照只活在进程内存里，所以判定要在本进程里算；
// 网关要跑在自己的目录里。两边各用各的，谁也不碰谁。
//
// 七牛云与讯飞星火这种 api key 型的平台，推理地址是写死的（lib/qiniu/config.ts），
// 指不到假上游 —— 所以「填上凭据就通」那一段用 Qoder（会话型，地址可以指到假上
// 游），api key 型的凭据在第一部分里验（七牛云的账号填一把 key 就绪）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PlatformAvailability } from "../lib/router/availability.ts";
import type { RoutingContext } from "../lib/router/routes.ts";
import { startFakeQoder } from "./fake-qoder-upstream.ts";
import { startGateway } from "./harness.ts";

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

/* ------------------------------------------------------------------ *
 * 一、判定本身
 * ------------------------------------------------------------------ */

section("一、判定：状态与最早能试的时刻");

const UNIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "availability-unit-"));
// 数据目录要在导入库模块之前定下来：store 是进程里的单例。
process.env.BUDDY_DATA_DIR = UNIT_DIR;

const { addAccount, listProviders, setProviderEnabled, updateProvider } = await import("../lib/providers.ts");
const { quotaConclusionOf, quotaPluginIdOf } = await import("../lib/quota-state.ts");
const { cooldownStamp } = await import("../lib/router/account-cooldown.ts");
const { platformAvailability } = await import("../lib/router/availability.ts");
const { inferenceCredentialOf } = await import("../lib/admin/accounts.ts");
const { hasUsableCredential } = await import("../lib/admin/credentials.ts");
const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
const { writeQiniuAccount } = await import("../lib/qiniu/account.ts");
const { qiniuQuotaPlugin } = await import("../lib/qiniu/quota-plugin.ts");
const { updateOpenPlatform } = await import("../lib/open-platforms.ts");
const { QINIU_INFER_BASE } = await import("../lib/qiniu/config.ts");
const { putHealthSnapshot, clearHealthSnapshot } = await import("../lib/health-cache.ts");
const { setCooldown, clearCooldown } = await import("../lib/cooldown.ts");

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("qiniu");
insertVendorPlatform("sensenova");
// 目录是上游那一份：这一节要的是「目录归平台，账号的状态不摘模型」，所以先
// 往行里写一份（等价于上游答了一次）。
const { syncPlatformModels } = await import("../lib/open-platforms.ts");
syncPlatformModels("qiniu", [
  "deepseek/deepseek-v4.1-flash-1017",
  "qiniu/conatus-free",
  "minimax/minimax-m3.1-flash",
  "nvidia/nemotron-3-ultra-550b-a55b0-free",
  "qwen/qwen3.8-flash-next",
]);

// 平台没有账号。
const empty = platformAvailability("qiniu");
check("没有账号 → no_account", empty.state === "no_account", empty.state);
check("没有账号 → 没有能接的账号", empty.usable.length === 0 && empty.serving.length === 0, empty.state);
check("没有账号 → 没有恢复时间（等不出来）", empty.untilMs === null, String(empty.untilMs));
check("没有账号 → 目录是空的", empty.ids.length === 0, JSON.stringify(empty.ids));

// 账号建了，但没填 key。
const made = addAccount({ platform: "qiniu", alias: "测试七牛" });
if (!made.ok || !made.id) throw new Error(`加不了七牛云的账号：${made.message}`);
const accountId = String(made.id);
const noKey = platformAvailability("qiniu");
check("开着但没有凭据 → no_credential", noKey.state === "no_credential", noKey.state);
check("没有凭据 → 没有能接的账号", noKey.usable.length === 0 && noKey.serving.length === 0, noKey.state);
check("没有凭据 → 没有恢复时间（等不出来）", noKey.untilMs === null, String(noKey.untilMs));
check("没有凭据 → 账号数是 1", noKey.accounts === 1, String(noKey.accounts));
check("没有凭据 → 目录还是平台的（恒为全量）", noKey.ids.length === 5, JSON.stringify(noKey.ids));

// 只填门户 cookie：额度问得到，推理发不出去 —— 那不是推理凭据。
writeQiniuAccount(accountId, { portalCookie: "pc-test-cookie" });
// 门户 cookie 只进插件的字段行，推理 key 那一行（key:provider:<账号>:key）仍然是空的。
const cookieOnly = platformAvailability("qiniu");
check("只有门户 cookie → inferenceCredentialOf 返回 null", inferenceCredentialOf(accountId) === null);
check("只有门户 cookie → 平台状态是 no_credential", cookieOnly.state === "no_credential", cookieOnly.state);
check(
  "只有门户 cookie → 没有能接的账号",
  cookieOnly.usable.length === 0 && cookieOnly.serving.length === 0,
  cookieOnly.state,
);

// 账号都关着：跟「没有凭据」是两件事。
setProviderEnabled(accountId, false);
const off = platformAvailability("qiniu");
check("账号都关着 → accounts_off", off.state === "accounts_off", off.state);
check("账号都关着 → 账号数还是 1", off.accounts === 1, String(off.accounts));
check("账号都关着 → 没有能接的账号", off.usable.length === 0 && off.serving.length === 0, off.state);
setProviderEnabled(accountId, true);

// 填上凭据：就绪。迁移后的位置：推理 key 在 key:provider:<账号>:key。
writeOpenPlatformKey(accountId, "sk-test-key");
const ready = platformAvailability("qiniu");
check("填上凭据 → ready", ready.state === "ready", ready.state);
check("就绪 → 有一个能接的账号", ready.usable.length === 1, String(ready.usable.length));
check("就绪 → 目录还是那一份", ready.ids.length === 5, JSON.stringify(ready.ids));
const inference = inferenceCredentialOf(accountId);
check(
  "填上 apiKey → inferenceCredentialOf 返回那把 key",
  inference?.kind === "api_key",
  JSON.stringify(inference?.kind ?? null),
);
check(
  "填上 apiKey → 返回的那一条确实能推理",
  inference?.inference === true && hasUsableCredential(inference.status),
  JSON.stringify({ inference: inference?.inference ?? null, status: inference?.status ?? null }),
);

// 额度用尽：还是就绪的样子，但接不了。
// 额度由平台那一行指名的插件问回来：指名它，快照里那份才读得到。
// 快照里存的是那一次的结论（状态 + 面板那几行），不是门户的原样答复。
updateOpenPlatform("qiniu", { quotaPlugin: qiniuQuotaPlugin.id });
// 两个快照：插件不给时刻的，与插件给了时刻的。同一份快照两处（面板 / 路由）
// 必须报同一个数。
const noTimeSnapshot = {
  plugins: {
    [qiniuQuotaPlugin.id]: {
      [accountId]: { state: "no_quota", views: [], recoverAt: null, message: "资源包全部用尽" },
    },
  },
} as any;
const PLUGIN_AT = Date.now() + 30 * 60_000;
const timedSnapshot = {
  plugins: {
    [qiniuQuotaPlugin.id]: {
      [accountId]: { state: "no_quota", views: [], recoverAt: PLUGIN_AT, message: "资源包全部用尽" },
    },
  },
} as any;

/** 面板那一格报的时刻（走 quotaConclusionOf，不自己拼快照）。 */
function panelRecoverAt(snapshot: any, cooling: Map<string, number>): number {
  const row = listProviders().find((r) => r.id === accountId)!;
  return quotaConclusionOf(row, snapshot, quotaPluginIdOf(row), cooling).recoverAtMs;
}

putHealthSnapshot(noTimeSnapshot);
const spent = platformAvailability("qiniu");
check("额度用尽 → out_of_credits", spent.state === "out_of_credits", spent.state);
check("额度用尽 → 没有能接的账号", spent.usable.length === 0, String(spent.usable.length));
check("额度用尽 → 目录不摘模型", spent.ids.length === 5, JSON.stringify(spent.ids));
// 插件不给时刻、也没有冷却：没人知道什么时候回来。额度不会因为过了五分钟就回
// 来 —— 那时答「不知道」（null / 0），不拿一个固定时长冒充。
check("额度用尽、插件不给时刻 → 判定不编时刻（null）", spent.untilMs === null, String(spent.untilMs));
check(
  "额度用尽、插件不给时刻 → spent 表里是 null（见底但不知道什么时候回来）",
  spent.spent.get(accountId) === null,
  String(spent.spent.get(accountId)),
);
check("额度用尽、插件不给时刻 → 面板那一格也是 0", panelRecoverAt(noTimeSnapshot, spent.cooling) === 0, String(panelRecoverAt(noTimeSnapshot, spent.cooling)));

// 控制组：插件给了时刻就是它（上面那两条不是写死的）。
putHealthSnapshot(timedSnapshot);
const timedSpent = platformAvailability("qiniu");
check("额度用尽、插件给了时刻 → 判定给的就是它", timedSpent.untilMs === PLUGIN_AT, `${timedSpent.untilMs} 与 ${PLUGIN_AT}`);
check("同一个账号的 spent 值也是它", timedSpent.spent.get(accountId) === PLUGIN_AT, String(timedSpent.spent.get(accountId)));
check(
  "面板那一格与路由是同一个数",
  panelRecoverAt(timedSnapshot, timedSpent.cooling) === PLUGIN_AT,
  `${panelRecoverAt(timedSnapshot, timedSpent.cooling)} 与 ${PLUGIN_AT}`,
);
clearHealthSnapshot();

// 冷却中：恢复时间就是冷却结束的那一刻。
const until = Date.now() + 10 * 60_000;
setCooldown(accountId, until, "test");
const cooling = platformAvailability("qiniu");
check("冷却中 → cooling", cooling.state === "cooling", cooling.state);
check("冷却中 → 没有能接的账号", cooling.usable.length === 0, String(cooling.usable.length));
check("冷却中 → 目录不摘模型", cooling.ids.length === 5, JSON.stringify(cooling.ids));
check("冷却中 → 恢复时间是冷却结束的那一刻", cooling.untilMs === until, `${cooling.untilMs} 与 ${until}`);
check(
  "冷却中、插件不给时刻 → 面板那一格也是冷却结束那一刻（同一个数）",
  panelRecoverAt(noTimeSnapshot, cooling.cooling) === until,
  `${panelRecoverAt(noTimeSnapshot, cooling.cooling)} 与 ${until}`,
);
clearCooldown(accountId);
const recovered = platformAvailability("qiniu");
check("冷却结束 → 又就绪了", recovered.state === "ready", recovered.state);

/* ------------------------------------------------------------------ *
 * 一之二、派发：判定与派发是同一个答案
 * ------------------------------------------------------------------ */

section("派发：没有推理凭据的账号不进候选");

// 两个账号：权重大的那个没有推理凭据，权重小的那个有。
//
// 派发自己判的时候只看得见开关，于是会挑中权重大的那个 —— 请求打上去才报
// 「账号上没有推理用的 API key」。那时候答复已经要写给客户端了。
const heavy = addAccount({ platform: "qoder", alias: "没有凭据的" });
const light = addAccount({ platform: "qoder", alias: "有凭据的" });
if (!heavy.ok || !heavy.id || !light.ok || !light.id) {
  throw new Error(`qoder 的账号建不出来：${heavy.message} ${light.message}`);
}
updateProvider(heavy.id, { weight: 900 });
updateProvider(light.id, { weight: 100 });

const { setSecret } = await import("../lib/store.ts");
// Qoder 的推理凭据就是登录会话本身。
setSecret(`session:provider:${light.id}`, "session", qoderSessionSecret());

const { underPolicy } = await import("../lib/router/upstreams/policy.ts");
const tried: string[] = [];
const chosen = await underPolicy("qoder", "test", async (account) => {
  tried.push(account.id);
  return account.id;
});
check(
  "派发挑中的是有凭据的那个账号",
  chosen === light.id,
  `${chosen}（试过：${tried.join(",")}）`,
);
check("没有凭据的账号根本没被试", !tried.includes(heavy.id), tried.join(","));

/* ------------------------------------------------------------------ *
 * 一之三、答复：额度用尽是 402，冷却是 503，都点名平台
 * ------------------------------------------------------------------ */

section("答复：额度用尽 402，冷却 503，点名平台");

const { routeInGroup, emptyCatalogTargets, catalogueNotReady } = await import("../lib/router/routes.ts");

/** 路由看到的那个平台：与 handle.ts 的 routingContext 同一个形状。 */
function routingContextOf(availability: PlatformAvailability): RoutingContext {
  return {
    platforms: new Map([
      [
        availability.platform,
        {
          kind: availability.kind,
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

/** 跑一次，拿到它抛出来的错（没有抛就是 null）。 */
function caught(run: () => unknown): any {
  try {
    run();
  } catch (e) {
    return e;
  }
  return null;
}

/** 同上，给 async 的那条路（派发）。 */
async function caughtAsync(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  return null;
}

/** Qoder 的会话：形状与真的那份一致（凭据就是登录会话本身）。 */
function qoderSessionSecret(): Record<string, unknown> {
  const now = Date.now();
  const year = now + 365 * 24 * 3600 * 1000;
  return {
    schemaVersion: 1,
    region: "global",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    accessToken: "dt-test-token",
    refreshToken: "drt-test-token",
    userId: "test-user",
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    machineId: "test-machine",
    machineToken: "test-machine-token",
    machineType: "test",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

// 额度用尽、插件给了时刻：402，类型是 usage_limit_error，文案点名平台并带上
// 同一个时刻（面板那一格报的也是它）。
putHealthSnapshot(timedSnapshot);
const spentPlatform = platformAvailability("qiniu");
check("额度用尽 → 判定是 out_of_credits", spentPlatform.state === "out_of_credits", spentPlatform.state);
const spentAnswer = caught(() => routeInGroup("qiniu", spentPlatform.ids[0], routingContextOf(spentPlatform)));
check("额度用尽 → 答 402", spentAnswer?.status === 402, String(spentAnswer?.status));
check("额度用尽 → 类型是 usage_limit_error", spentAnswer?.type === "usage_limit_error", String(spentAnswer?.type));
check("额度用尽 → 文案点名了平台", String(spentAnswer?.hint ?? "").includes("qiniu"), String(spentAnswer?.hint));
check("额度用尽 → 文案说了什么时候恢复", String(spentAnswer?.hint ?? "").includes("恢复"), String(spentAnswer?.hint));
check(
  "额度用尽 → 文案里那个时刻就是面板那一格",
  String(spentAnswer?.hint ?? "").includes(cooldownStamp(PLUGIN_AT)),
  String(spentAnswer?.hint),
);
clearHealthSnapshot();

// 额度用尽、插件不给时刻、也没有冷却：402 还在（见底的账号不去打），但正文里
// 不出现时刻、也不说「恢复」—— 额度不会因为过了五分钟就回来，编一个时刻是在
// 骗人。这里走真正的派发那条路（underPolicy），不是自己拼错误。
putHealthSnapshot(noTimeSnapshot);
const unknownSpent = platformAvailability("qiniu");
check("不知道时刻 → 判定还是 out_of_credits", unknownSpent.state === "out_of_credits", unknownSpent.state);
check(
  "不知道时刻 → 路由不禁用（它自己按平台级说不清）",
  caught(() => routeInGroup("qiniu", unknownSpent.ids[0], routingContextOf(unknownSpent))) === null,
  "路由抛错了",
);
let unknownRan = false;
const unknownAnswer = await caughtAsync(() =>
  underPolicy("qiniu", "test", async () => {
    unknownRan = true;
    return "不该跑到这里";
  }),
);
check("不知道时刻 → 派发还是答 402", unknownAnswer?.status === 402, String(unknownAnswer?.status));
check("不知道时刻 → 见底的账号根本没去打", unknownRan === false);
check(
  "不知道时刻 → 文案里没有任何时刻",
  !/\d{4}/.test(String(unknownAnswer?.hint ?? "")),
  String(unknownAnswer?.hint),
);
check(
  "不知道时刻 → 文案里没有「恢复」二字",
  !String(unknownAnswer?.hint ?? "").includes("恢复"),
  String(unknownAnswer?.hint),
);
check(
  "不知道时刻 → 没有 Retry-After（不编一个「过一会」）",
  unknownAnswer?.retryAfterUntilMs === undefined,
  String(unknownAnswer?.retryAfterUntilMs),
);
clearHealthSnapshot();

// 冷却：503，点名平台，说清什么时候再试 —— 那是真实的冷却结束时刻，不是估的。
const coolingUntil = Date.now() + 10 * 60_000;
setCooldown(accountId, coolingUntil, "test");
const coolingPlatform = platformAvailability("qiniu");
check("冷却中 → 判定是 cooling", coolingPlatform.state === "cooling", coolingPlatform.state);
const coolingRouteAnswer = caught(() =>
  routeInGroup("qiniu", coolingPlatform.ids[0], routingContextOf(coolingPlatform)),
);
check("冷却 → 答 503", coolingRouteAnswer?.status === 503, String(coolingRouteAnswer?.status));
check(
  "冷却 → 文案点名了平台",
  String(coolingRouteAnswer?.hint ?? "").includes("qiniu"),
  String(coolingRouteAnswer?.hint),
);
check(
  "冷却 → 文案说了在冷却",
  String(coolingRouteAnswer?.hint ?? "").includes("冷却"),
  String(coolingRouteAnswer?.hint),
);
check(
  "冷却 → 文案里那个时刻就是冷却结束",
  String(coolingRouteAnswer?.hint ?? "").includes(cooldownStamp(coolingUntil)),
  String(coolingRouteAnswer?.hint),
);
check(
  "冷却 → 面板那一格也是冷却结束（同一个数）",
  panelRecoverAt(noTimeSnapshot, coolingPlatform.cooling) === coolingPlatform.untilMs,
  `${panelRecoverAt(noTimeSnapshot, coolingPlatform.cooling)} 与 ${coolingPlatform.untilMs}`,
);
clearCooldown(accountId);

/* ------------------------------------------------------------------ *
 * 一之四、单一策略：权重最大的账号接不了就说清楚，不换账号
 * ------------------------------------------------------------------ */

section("单一策略：权重最大的账号额度见底也不换账号");

// 两个账号：权重大的那个额度见底，权重小的那个好着。
// 见底是按账号判的，所以两个都要有凭据 —— 没有凭据的账号不算「见底」。
const drained = addAccount({ platform: "qoder", alias: "额度见底的" });
const spare = addAccount({ platform: "qoder", alias: "好着的" });
if (!drained.ok || !drained.id || !spare.ok || !spare.id) {
  throw new Error(`qoder 的账号建不出来：${drained.message} ${spare.message}`);
}
updateProvider(drained.id, { weight: 900 });
updateProvider(spare.id, { weight: 100 });
setSecret(`session:provider:${drained.id}`, "session", qoderSessionSecret());
setSecret(`session:provider:${spare.id}`, "session", qoderSessionSecret());
putHealthSnapshot({
  qoder: {
    [drained.id]: {
      credits: { quotaExceeded: true, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    },
  },
} as any);

const served: string[] = [];
let singleFailure: any = null;
try {
  await underPolicy("qoder", "test", async (account) => {
    served.push(account.id);
    return account.id;
  });
} catch (e) {
  singleFailure = e;
}
check("见底 → 答 402", singleFailure?.status === 402, String(singleFailure?.status));
check("见底 → 类型是 usage_limit_error", singleFailure?.type === "usage_limit_error", String(singleFailure?.type));
check("见底 → 文案说了是哪个账号", String(singleFailure?.hint ?? "").includes(drained.id), String(singleFailure?.hint));
check("见底 → 没有打到别的账号", served.length === 0, served.join(","));
clearHealthSnapshot();

/* ------------------------------------------------------------------ *
 * 一之五、目录没拿到：答 503，不是 404
 * ------------------------------------------------------------------ */

section("目录没拿到：503，不是 404");

// 一个目录为空的平台：kind 登记了、账号有凭据（所以就绪），但目录没拿到。
const noCatalog = addAccount({ platform: "sensenova", alias: "目录空的" });
if (!noCatalog.ok || !noCatalog.id) throw new Error(`sensenova 的账号建不出来：${noCatalog.message}`);
// 迁移后 SenseNova 是一个 openai 平台：推理凭据就是那一把 key（key:provider:<账号>:key）。
writeOpenPlatformKey(noCatalog.id, "sk-test-key");
const noCatalogPlatform = platformAvailability("sensenova");
check("目录空的平台 → 就绪", noCatalogPlatform.state === "ready", noCatalogPlatform.state);
check("目录空的平台 → 目录确实是空的", noCatalogPlatform.ids.length === 0, JSON.stringify(noCatalogPlatform.ids));

const emptyTargets = emptyCatalogTargets(
  [{ group: "sensenova", enabled: true }],
  new Map([["sensenova", noCatalogPlatform]]),
);
check("目录没拿到 → 说的是那个平台", emptyTargets.includes("sensenova"), JSON.stringify(emptyTargets));
const catalogueAnswer = catalogueNotReady(emptyTargets);
check("目录没拿到 → 答 503", catalogueAnswer.status === 503, String(catalogueAnswer.status));
check(
  "目录没拿到 → 文案说目录还没拿到",
  String(catalogueAnswer.hint).includes("目录"),
  String(catalogueAnswer.hint),
);

/* ------------------------------------------------------------------ *
 * 一之六、排队：最近每次请求都排不上去时，绿的就绪是假的
 * ------------------------------------------------------------------ */

section("排队：最近每次请求都排不上去时，绿的就绪是假的");

// 排队不冷却账号（lib/router/account-cooldown.ts），凭据、额度、开关也都好着 ——
// 判定看得见的四样里一样都不动，所以这一档只能靠「最近几次请求的结果」来判：
// 记账住在 lib/upstream-failures.ts（纯内存，最多 20 条），窗口由判定给（十分钟）。
const { noteUpstreamFailure, recentUpstreamFailures } = await import("../lib/upstream-failures.ts");
const { listCooldowns } = await import("../lib/cooldown.ts");
const { upstreamStateOf } = await import("../lib/admin/upstreams.ts");
const { UpstreamState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

// 库里那一次就是这四条：把「排队中」与冷却分开，它必须本来就是一个就绪的平台。
const queueAt = Date.now();
const before = platformAvailability("qoder", queueAt);
check("串场：这个平台本来是就绪的", before.state === "ready", before.state);

// 一、只有成功记录 → 就绪。
noteUpstreamFailure("qoder", "ok", queueAt);
const justOk = platformAvailability("qoder", queueAt);
check("只有成功记录 → ready", justOk.state === "ready", justOk.state);

// 二、一条排队 + 一条成功 → 不是 queued：偶发一次排队是正常的，拿它报警等于
// 每个平台都常驻一个「排队中」。
noteUpstreamFailure("qoder", "queued", queueAt + 1);
const mixed = platformAvailability("qoder", queueAt + 1000);
check("一条排队 + 一条成功 → 不是 queued", mixed.state !== "queued", mixed.state);
check("一条排队 + 一条成功 → 还是 ready", mixed.state === "ready", mixed.state);

// 三、窗口里只剩排队（前面那条成功早已出了窗口）→ queued，而且没有恢复时刻。
// 用 20 分钟之后的时间戳写：十分钟窗口的判据就是「窗内每一条都是排队」。
const queueLater = queueAt + 20 * 60_000;
noteUpstreamFailure("qoder", "queued", queueLater);
noteUpstreamFailure("qoder", "queued", queueLater);
const inWindow = recentUpstreamFailures("qoder", 10 * 60_000, queueLater);
check(
  "串场：窗口里只剩那两次排队",
  inWindow.length === 2 && inWindow.every((one) => one.kind === "queued"),
  JSON.stringify(inWindow),
);
const queued = platformAvailability("qoder", queueLater);
check("两条以上、全是排队 → queued", queued.state === "queued", queued.state);
check("排队没有恢复时刻（untilMs 是 null，不编）", queued.untilMs === null, String(queued.untilMs));
check("理由里说了是排队", queued.reason.includes("排队"), queued.reason);
check("面板上给了一句话（不是空的）", queued.advice.length > 0, queued.advice);
check(
  "契约里也是 QUEUED（不是就绪）",
  upstreamStateOf(queued) === UpstreamState.QUEUED,
  String(upstreamStateOf(queued)),
);

// 状态只影响展示：不冷却账号、不改选号、不摘模型。
const queueAccountIds = queued.rows.map((row) => row.id);
const coolingRows = listCooldowns(queueLater).filter((one) => queueAccountIds.includes(one.providerId));
check("排队不产生冷却行", coolingRows.length === 0, JSON.stringify(coolingRows));
check("排队不改选号：账号仍在 serving 里", queued.serving.length > 0, String(queued.serving.length));
check("排队不摘模型：目录仍是全量", queued.ids.length > 0, JSON.stringify(queued.ids));

// 五、窗口里的排队记录都过期之后：回到 ready。排队是会过去的，拿半小时前的
// 排队说事就是一个摘不掉的黄灯。
const queuePassed = platformAvailability("qoder", queueLater + 11 * 60_000);
check("窗口外的排队记录 → 回到 ready", queuePassed.state === "ready", queuePassed.state);

/* ------------------------------------------------------------------ *
 * 二、路由与健康检查
 * ------------------------------------------------------------------ */

section("二、路由与健康检查（真网关 + 假上游）");

const fake = await startFakeQoder();
const gw = await startGateway({
  env: {
    BENEFITS_DISABLED: "1",
    // 上游指向本机的假上游：一个字都不出机器。
    QODER_GLOBAL_OPENAPI_BASE: `${fake.base}/openapi-global`,
    QODER_GLOBAL_LEGACY_BASE: `${fake.base}/qoder-global-legacy`,
  },
});

const token = fs.readFileSync(path.join(gw.dataDir, "admin-token"), "utf8").trim();

/** 一次 Connect 调用（面板的口径）。 */
async function admin(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}/buddy.admin.v1.AdminService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, httpStatus: res.status };
  }
}

/** 客户端发一次请求（OpenAI 方言，平台前缀那条路）。 */
async function chat(platform: string, model: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${gw.base}/${platform}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "say ok" }] }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

/** 根路由公布的模型。 */
async function publishedIds(): Promise<string[]> {
  const res = await fetch(`${gw.base}/v1/models`);
  const body = await res.json().catch(() => ({}));
  return (body?.data ?? []).map((m: any) => String(m.id));
}

/** 根路由：模型名是发布出来的那个。 */
async function rootChat(model: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "say ok" }] }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

/** 网关自己的库：直接读写（与网关写的是同一张表）。 */
function withDb<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** Qoder 的会话：形状与真的那份一致（假上游不看它，网关要看）。 */
function qoderSession(now: number): unknown {
  const year = now + 365 * 24 * 3600 * 1000;
  return {
    schemaVersion: 1,
    region: "global",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    accessToken: "dt-test-token",
    refreshToken: "drt-test-token",
    userId: "test-user",
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    machineId: "test-machine",
    machineToken: "test-machine-token",
    machineType: "test",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

/**
 * 把 Qoder 的账号与会话种进去。
 *
 * 网关已经起来了才种：启动时没有账号，就不会有设备登录（那会真的去问平台）。
 * 账号 id 是自增整数：种好之后把它记下来，会话删/还都挂那一格。
 */
let seededQoderId = "";
async function seedQoderAccount(): Promise<void> {
  // 建行走网关自己的 AddAccount（那个进程才是这个库的主人），再按它给的 id
  // 把会话写进去。
  const made = await admin("AddAccount", { platform: "qoder", alias: "测试 Qoder" });
  seededQoderId = String(made?.id ?? "");
  if (!/^\d+$/.test(seededQoderId)) throw new Error(`qoder 的账号建不出来：${JSON.stringify(made)}`);
  const now = Date.now();
  withDb((db) => {
    db.prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)").run(
      `session:provider:${seededQoderId}`,
      "session",
      JSON.stringify(qoderSession(now)),
      now,
    );
  });
}

/** 把会话拿走：这个账号开着，但没有凭据了。 */
function dropQoderSession(): void {
  withDb((db) => {
    db.prepare("DELETE FROM secrets WHERE id = ?").run(`session:provider:${seededQoderId}`);
  });
}

/** 把会话放回去。 */
function restoreQoderSession(): void {
  const now = Date.now();
  withDb((db) => {
    db.prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)").run(
      `session:provider:${seededQoderId}`,
      "session",
      JSON.stringify(qoderSession(now)),
      now,
    );
  });
}

/** 写一行冷却（到什么时候为止）。 */
function writeCooldown(providerId: string, untilMs: number): void {
  withDb((db) => {
    db.prepare(
      "INSERT INTO cooldown (provider_id, until_ms, reason, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(provider_id) DO UPDATE SET until_ms = excluded.until_ms",
    ).run(providerId, untilMs, "test", Date.now());
  });
}

function clearCooldownRow(providerId: string): void {
  withDb((db) => {
    db.prepare("DELETE FROM cooldown WHERE provider_id = ?").run(providerId);
  });
}

/**
 * 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：网关那个库里要有的
 * 行，测试自己写进去。
 */
function addVendorPlatform(id: string, kind: string, baseUrl: string): void {
  const now = Date.now();
  withDb((db) => {
    db.prepare(
      "INSERT OR IGNORE INTO platform " +
        "(id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)",
    ).run(id, id, baseUrl, "[]", 0, "", kind, now, now);
  });
}

/** 表里加一个开放平台（用户自己加的：它在，但名下没有账号，所以接不了）。 */
function addOpenPlatform(id: string): void {
  const now = Date.now();
  withDb((db) => {
    db.prepare(
      "INSERT INTO platform (id, label, base_url, models, models_auto, quota_plugin, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, "Zephyr", "https://example.invalid/v1", JSON.stringify({ items: [], fetchedAt: 0, source: "auto" }), 1, "", now, now);
  });
}

// 账号与会话。
await seedQoderAccount();
// 厂商 kind 已退场：迁移把存量行改成 openai + 行上写死的默认地址，网关库里
// 造的行也用同一个形状（kind 写 openai，地址取七牛的常量推理地址）。
addVendorPlatform("qiniu", "openai", QINIU_INFER_BASE);
const added = await admin("AddAccount", { platform: "qiniu", alias: "测试七牛" });
check("面板能加一个七牛云的账号", typeof added?.id === "string" && Boolean(added.id), JSON.stringify(added));
// 账号 id 是面板起的（自增数）：开关、冷却都挂在它上面，不是平台 id。
const qiniuAccountId = String(added.id ?? "");
check("七牛账号的 id 拿到了", /^\d+$/.test(qiniuAccountId), qiniuAccountId);

// 发布两个模型：一个指向有凭据的 Qoder，一个指向没有凭据的七牛云。
const publish = async (id: string, groupName: string, upstreamModel: string): Promise<any> =>
  admin("SavePublishedModel", {
    model: {
      id,
      displayName: id,
      enabled: true,
      strategy: "single",
      targets: [{ groupName, upstreamModel, weight: 10, position: 0, enabled: true }],
    },
  });
check(
  "面板能发布一个指向 Qoder 的模型",
  (await publish("avail-qoder", "qoder", "glm-5.3"))?.id === "avail-qoder",
);
check(
  "面板能发布一个指向七牛云的模型",
  (await publish("avail-qiniu", "qiniu", "deepseek/deepseek-v4.1-flash-1017"))?.id === "avail-qiniu",
);

section("没有账号 / 账号都关着 / 没有凭据");

const listed = await publishedIds();
check("有凭据的平台的模型公布了", listed.includes("avail-qoder"), JSON.stringify(listed));
check("没有凭据的平台的模型不公布", !listed.includes("avail-qiniu"), JSON.stringify(listed));

const noCredential = await chat("qiniu", "deepseek/deepseek-v4.1-flash-1017");
check("没有凭据的时候请求被拒了", noCredential.status === 400, `HTTP ${noCredential.status}`);
check(
  "说的是没有可用凭据",
  String(noCredential.json?.error?.message ?? "").includes("no usable credential"),
  JSON.stringify(noCredential.json),
);
check(
  "提示里说清要在面板上填 key 或者登录",
  String(noCredential.json?.hint ?? "").includes("凭据") &&
    String(noCredential.json?.hint ?? "").includes("API Key"),
  JSON.stringify(noCredential.json),
);

await admin("SetAccountEnabled", { accountId: qiniuAccountId, enabled: false });
const offAnswer = await chat("qiniu", "deepseek/deepseek-v4.1-flash-1017");
check("账号都关着的时候请求被拒了", offAnswer.status === 400, `HTTP ${offAnswer.status}`);
check(
  "说的是账号都关着",
  String(offAnswer.json?.error?.message ?? "").includes("no account turned on"),
  JSON.stringify(offAnswer.json),
);
await admin("SetAccountEnabled", { accountId: qiniuAccountId, enabled: true });

section("根路由：发布过的模型，目标平台没凭据");

// 模型确实发布过（avail-qiniu），只是它的目标平台现在接不了。
// 答「没有这个模型」会让客户端去改模型名 —— 而模型名是对的。
const rootNoCredential = await rootChat("avail-qiniu");
check(
  "不是 404（模型确实发布过）",
  rootNoCredential.status !== 404,
  `HTTP ${rootNoCredential.status} ${rootNoCredential.text.slice(0, 200)}`,
);
check(
  "答 400（运维没配好，不是等一会儿就好）",
  rootNoCredential.status === 400,
  `HTTP ${rootNoCredential.status}`,
);
const rootHint = String(rootNoCredential.json?.hint ?? "");
check("文案点名了是哪个上游", rootHint.includes("qiniu"), rootHint);
check(
  "文案说了是什么状态",
  rootHint.includes("no_credential") || rootHint.includes("没有可用凭据"),
  rootHint,
);
check("文案说了该怎么办", rootHint.includes("API Key"), rootHint);

section("凭据填回去就回来了（反证：不填就回不去）");

dropQoderSession();
const withoutSession = await publishedIds();
check("会话拿走之后那个模型不公布了", !withoutSession.includes("avail-qoder"), JSON.stringify(withoutSession));
const dropped = await chat("qoder", "glm-5.3");
check("会话拿走之后请求被拒了", dropped.status === 400, `HTTP ${dropped.status}`);
check(
  "说的是没有可用凭据",
  String(dropped.json?.error?.message ?? "").includes("no usable credential"),
  JSON.stringify(dropped.json),
);

restoreQoderSession();
const back = await publishedIds();
check("会话放回去之后模型又公布了", back.includes("avail-qoder"), JSON.stringify(back));
fake.reset();
const answered = await chat("qoder", "glm-5.3");
check("会话放回去之后请求通了", answered.status === 200, `HTTP ${answered.status} ${answered.text.slice(0, 160)}`);
check("请求真的走到了那个上游", fake.seen.length === 1 && fake.seen[0].model === "gmodel", JSON.stringify(fake.seen));

section("冷却中：答 503 并说什么时候恢复");

writeCooldown(seededQoderId, Date.now() + 10 * 60_000);
const coolingAnswer = await chat("qoder", "glm-5.3");
check("冷却的时候答 503", coolingAnswer.status === 503, `HTTP ${coolingAnswer.status} ${coolingAnswer.text.slice(0, 160)}`);
check("提示里说了在冷却", String(coolingAnswer.json?.hint ?? "").includes("冷却"), JSON.stringify(coolingAnswer.json));
check(
  "提示里点名了是哪个上游",
  String(coolingAnswer.json?.hint ?? "").includes("qoder"),
  JSON.stringify(coolingAnswer.json),
);
clearCooldownRow(seededQoderId);
const afterCooldown = await chat("qoder", "glm-5.3");
check("冷却结束之后又通了", afterCooldown.status === 200, `HTTP ${afterCooldown.status}`);

section("健康检查：开放平台在，但接不了");

addOpenPlatform("zephyr");
const health = await fetch(`${gw.base}/health`).then((r) => r.json());
const zephyr = health?.upstreams?.zephyr;
check("开放平台出现在健康检查里", Boolean(zephyr), JSON.stringify(Object.keys(health?.upstreams ?? {})));
check("开放平台是关着的", zephyr?.enabled === false, JSON.stringify(zephyr));
check("开放平台没有账号，地址不报", zephyr?.base === null, JSON.stringify(zephyr?.base));
check("开放平台没有模型", zephyr?.models === 0, JSON.stringify(zephyr?.models));
const zephyrProvider = (health?.providers ?? []).find((p: any) => p.id === "zephyr");
check("开放平台在平台列表里也是关着的", zephyrProvider?.enabled === false, JSON.stringify(zephyrProvider));

section("健康检查：每个平台都说得出状态");

for (const [id, upstream] of Object.entries(health?.upstreams ?? {})) {
  const entry = upstream as any;
  check(`${id} 有状态`, typeof entry.state === "string" && entry.state.length > 0, JSON.stringify(entry.state));
  check(`${id} 说得出为什么`, typeof entry.reason === "string" && entry.reason.length > 0, JSON.stringify(entry.reason));
}
check(
  "没有凭据的平台状态是 no_credential",
  health?.upstreams?.qiniu?.state === "no_credential",
  JSON.stringify(health?.upstreams?.qiniu?.state),
);
check(
  "有凭据的平台状态是 ready",
  health?.upstreams?.qoder?.state === "ready",
  JSON.stringify(health?.upstreams?.qoder?.state),
);
check(
  "平台列表里也有状态",
  (health?.providers ?? []).every((p: any) => typeof p.state === "string" && p.state.length > 0),
  JSON.stringify((health?.providers ?? []).map((p: any) => [p.id, p.state])),
);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  console.log("查出来的问题：");
  for (const p of problems) console.log(`  - ${p}`);
}
gw.stop();
fake.close();
fs.rmSync(UNIT_DIR, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
