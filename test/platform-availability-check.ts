// test/platform-availability-check.ts — 平台能不能接请求：一个判定，四处都用它。
//
//   node --experimental-strip-types test/platform-availability-check.ts
//
// 离线：假的上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 分两部分：
//
//   一、判定本身（在本进程里算）：账号、开关、凭据、额度、冷却各是一种状态。
//      状态对不对、「最早能试的时刻」是不是未来的时刻。
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

const { addAccount, setProviderEnabled } = await import("../lib/providers.ts");
const { platformAvailability } = await import("../lib/router/availability.ts");
const { inferenceCredentialOf } = await import("../lib/admin/accounts.ts");
const { hasUsableCredential } = await import("../lib/admin/credentials.ts");
const { writeQiniuAccount } = await import("../lib/qiniu/account.ts");
const { putHealthSnapshot, clearHealthSnapshot } = await import("../lib/health-cache.ts");
const { setCooldown, clearCooldown } = await import("../lib/cooldown.ts");

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

// 填上凭据：就绪。
writeQiniuAccount(accountId, { apiKey: "sk-test-key" });
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
putHealthSnapshot({
  qiniu: {
    [accountId]: {
      quota: { respacks: [{ itemCode: "respack-general", total: 100, used: 100, remaining: 0 }] },
    },
  },
} as any);
const spent = platformAvailability("qiniu");
check("额度用尽 → out_of_credits", spent.state === "out_of_credits", spent.state);
check("额度用尽 → 没有能接的账号", spent.usable.length === 0, String(spent.usable.length));
check("额度用尽 → 目录不摘模型", spent.ids.length === 5, JSON.stringify(spent.ids));
check(
  "额度用尽 → 恢复时间是未来的时刻",
  spent.untilMs !== null && spent.untilMs > Date.now(),
  String(spent.untilMs),
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
clearCooldown(accountId);
const recovered = platformAvailability("qiniu");
check("冷却结束 → 又就绪了", recovered.state === "ready", recovered.state);

/* ------------------------------------------------------------------ *
 * 二、路由与健康检查
 * ------------------------------------------------------------------ */

section("二、路由与健康检查（真网关 + 假上游）");

const fake = await startFakeQoder();
const gw = await startGateway({
  env: {
    BENEFITS_DISABLED: "1",
    // 上游指向本机的假上游：一个字都不出机器。
    QODER_GLOBAL_INFER_BASE: `${fake.base}/qoder-global`,
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
 */
function seedQoderAccount(): void {
  const now = Date.now();
  withDb((db) => {
    db.prepare(
      "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("qoder", "qoder", "测试 Qoder", 1, 100, now, now);
    db.prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)").run(
      "session:provider:qoder",
      "session",
      JSON.stringify(qoderSession(now)),
      now,
    );
  });
}

/** 把会话拿走：这个账号开着，但没有凭据了。 */
function dropQoderSession(): void {
  withDb((db) => {
    db.prepare("DELETE FROM secrets WHERE id = ?").run("session:provider:qoder");
  });
}

/** 把会话放回去。 */
function restoreQoderSession(): void {
  const now = Date.now();
  withDb((db) => {
    db.prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?)").run(
      "session:provider:qoder",
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

/** 表里加一个开放平台（kind 还没登记：存在，但接不了）。 */
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
seedQoderAccount();
const added = await admin("AddAccount", { platform: "qiniu", alias: "测试七牛" });
check("面板能加一个七牛云的账号", added.ok === true, JSON.stringify(added));

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
  (await publish("avail-qoder", "qoder", "glm-5.3")).ok === true,
);
check(
  "面板能发布一个指向七牛云的模型",
  (await publish("avail-qiniu", "qiniu", "deepseek/deepseek-v4.1-flash-1017")).ok === true,
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

await admin("SetAccountEnabled", { accountId: "qiniu", enabled: false });
const offAnswer = await chat("qiniu", "deepseek/deepseek-v4.1-flash-1017");
check("账号都关着的时候请求被拒了", offAnswer.status === 400, `HTTP ${offAnswer.status}`);
check(
  "说的是账号都关着",
  String(offAnswer.json?.error?.message ?? "").includes("no account turned on"),
  JSON.stringify(offAnswer.json),
);
await admin("SetAccountEnabled", { accountId: "qiniu", enabled: true });

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

writeCooldown("qoder", Date.now() + 10 * 60_000);
const coolingAnswer = await chat("qoder", "glm-5.3");
check("冷却的时候答 503", coolingAnswer.status === 503, `HTTP ${coolingAnswer.status} ${coolingAnswer.text.slice(0, 160)}`);
check("提示里说了在冷却", String(coolingAnswer.json?.hint ?? "").includes("冷却"), JSON.stringify(coolingAnswer.json));
clearCooldownRow("qoder");
const afterCooldown = await chat("qoder", "glm-5.3");
check("冷却结束之后又通了", afterCooldown.status === 200, `HTTP ${afterCooldown.status}`);

section("健康检查：开放平台在，但接不了");

addOpenPlatform("zephyr");
const health = await fetch(`${gw.base}/health`).then((r) => r.json());
const zephyr = health?.upstreams?.zephyr;
check("开放平台出现在健康检查里", Boolean(zephyr), JSON.stringify(Object.keys(health?.upstreams ?? {})));
check("开放平台是关着的", zephyr?.enabled === false, JSON.stringify(zephyr));
check("开放平台没有地址（kind 还没登记）", zephyr?.base === null, JSON.stringify(zephyr?.base));
check("开放平台没有模型", zephyr?.models === 0, JSON.stringify(zephyr?.models));
const zephyrProvider = (health?.providers ?? []).find((p: any) => p.id === "zephyr");
check("开放平台在平台列表里也是关着的", zephyrProvider?.enabled === false, JSON.stringify(zephyrProvider));

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
