// test/admin-state-check.ts — 上游的状态、凭据状态的枚举、没公布的原因。
//
//   node --experimental-strip-types test/admin-state-check.ts
//
// 起一个网关（上游全关，不碰任何平台），然后：
//
//   1. 凭据状态的六种说法都映射到契约里的枚举；
//   2. 上游的七种状态：关着、没登录、过期、被拒、额度用尽、正在登录、就绪；
//   3. 模型没公布的七种原因；
//   4. 上游关着的时候 ListModels 不列它的模型（那个缓存不一致的回归测试）；
//   5. 上游从关到开，目录立刻出来。
//
// 状态与原因都是「读数据库算出来的」：所以测试直接往数据库里写会话、写
// 登录会话、写 /health 的缓存，然后问网关。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway } from "./harness.ts";

// 每一趟一个自己的目录（mkdtemp 建的，已经干净）：几个测试同时跑时
// 不能共用一个 SQLite。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-state-"));
const SERVICE = "/buddy.admin.v1.AdminService";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
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
 * 一、凭据状态的词表（不碰网关）
 * ------------------------------------------------------------------ */

section("凭据状态的枚举");

const { credentialState, credentialStateText, hasUsableCredential } = await import("../lib/admin/credentials.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

check(
  "authenticated → CREDENTIAL_STATE_AUTHENTICATED",
  credentialState("authenticated") === CredentialState.AUTHENTICATED,
  String(credentialState("authenticated")),
);
check("missing → CREDENTIAL_STATE_MISSING", credentialState("missing") === CredentialState.MISSING);
check("expired → CREDENTIAL_STATE_EXPIRED", credentialState("expired") === CredentialState.EXPIRED);
check("error → CREDENTIAL_STATE_ERROR", credentialState("error") === CredentialState.ERROR);
check("usable → CREDENTIAL_STATE_USABLE", credentialState("usable") === CredentialState.USABLE);
check("anonymous → CREDENTIAL_STATE_ANONYMOUS", credentialState("anonymous") === CredentialState.ANONYMOUS);
check("不认识的 → CREDENTIAL_STATE_MISSING", credentialState("wat") === CredentialState.MISSING);
check(
  "枚举换成人看的词",
  credentialStateText(CredentialState.EXPIRED) === "expired" &&
    credentialStateText(CredentialState.MISSING) === "missing" &&
    credentialStateText(CredentialState.USABLE) === "usable",
  credentialStateText(CredentialState.USABLE),
);
check(
  "有能用的凭据",
  hasUsableCredential(CredentialState.AUTHENTICATED) &&
    hasUsableCredential(CredentialState.ANONYMOUS) &&
    hasUsableCredential(CredentialState.USABLE) &&
    !hasUsableCredential(CredentialState.MISSING) &&
    !hasUsableCredential(CredentialState.EXPIRED),
);

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

const fakeUpstream = http.createServer((_req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolve) => fakeUpstream.listen(0, "127.0.0.1", () => resolve()));
const fakeBase = `http://127.0.0.1:${(fakeUpstream.address() as net.AddressInfo).port}`;

// 起网关交给共用的 helper：端口被抢就换号重试，退出时一定收尾。
// 上游全关：状态由测试自己往数据库里写。
const gw = await startGateway({
  dataDir: DATA_DIR,
  // 目录也是临时的，helper 在子进程死了之后删。
  cleanupDataDir: true,
  env: {
    QODER_GLOBAL: "",
    QODER_CN: "",
    MINIMAX_CODE: "",
    WORKBUDDY_CN: "",
    TOKENRHYTHM: "",
    QODER_GLOBAL_INFER_BASE: `${fakeBase}/qoder-global`,
    QODER_GLOBAL_OPENAPI_BASE: `${fakeBase}/openapi-global`,
    QODER_GLOBAL_LEGACY_BASE: `${fakeBase}/qoder-global-legacy`,
    QODER_CN_INFER_BASE: `${fakeBase}/qoder-cn`,
    QODER_CN_OPENAPI_BASE: `${fakeBase}/openapi-cn`,
    WORKBUDDY_CN_BASE: `${fakeBase}/workbuddy`,
    WORKBUDDY_CHAT_BASE: `${fakeBase}/workbuddy`,
  },
});
const base = gw.base;

function cleanup(): void {
  fakeUpstream.close();
}
process.on("exit", cleanup);

check("网关起来了", (await fetch(`${base}/health`)).ok);

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();

// 启动不再插行：新库里一个账号都没有，先按面板的做法加一行出来。
// 平台是模板（九个服务），账号才是 provider 表的行。
async function addAccount(platform: string, alias = ""): Promise<string> {
  const res = await admin("AddAccount", { platform, alias });
  return String(res.id ?? "");
}

async function admin(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
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

/** 直接写数据库：会话、登录会话、缓存。 */
function db(): DatabaseSync {
  return new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
}

function writeSecret(id: string, kind: string, data: unknown): void {
  const conn = db();
  try {
    conn
      .prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .run(id, kind, JSON.stringify(data), Date.now());
  } finally {
    conn.close();
  }
}

function deleteSecret(id: string): void {
  const conn = db();
  try {
    conn.prepare("DELETE FROM secrets WHERE id = ?").run(id);
  } finally {
    conn.close();
  }
}

function writeCached(id: string, data: unknown): void {
  const conn = db();
  try {
    conn
      .prepare("INSERT INTO cache (id, data, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at")
      .run(id, JSON.stringify(data), Date.now());
  } finally {
    conn.close();
  }
}

function deleteCached(id: string): void {
  const conn = db();
  try {
    conn.prepare("DELETE FROM cache WHERE id = ?").run(id);
  } finally {
    conn.close();
  }
}

/** 直接往聚合表里写一个目标（面板的接口不收上游没有的模型）。 */
function writeTarget(modelId: string, group: string, upstreamModel: string, weight: number, enabled = true): void {
  const conn = db();
  try {
    conn
      .prepare(
        "INSERT INTO aggregate_target (model_id, group_name, upstream_model, weight, position, enabled) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(modelId, group, upstreamModel, weight, 0, enabled ? 1 : 0);
  } finally {
    conn.close();
  }
}

/** 把一个目标的上游模型改掉。 */
function retarget(modelId: string, upstreamModel: string): void {
  const conn = db();
  try {
    conn.prepare("UPDATE aggregate_target SET upstream_model = ? WHERE model_id = ?").run(upstreamModel, modelId);
  } finally {
    conn.close();
  }
}

/** 把一个模型的目标都删掉。 */
function deleteTargets(modelId: string): void {
  const conn = db();
  try {
    conn.prepare("DELETE FROM aggregate_target WHERE model_id = ?").run(modelId);
  } finally {
    conn.close();
  }
}

/** 一份还有效的 Qoder 会话。 */
function qoderSession(expiresInMs: number) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    region: "global",
    clientId: "state-test-client",
    accessToken: "dt-state-test",
    refreshToken: "drt-state-test",
    userId: "state-test-user",
    expiresAtMs: now + expiresInMs,
    refreshExpiresAtMs: now + expiresInMs,
    machineId: "state-test-machine",
    machineToken: "state-test-machine-token",
    machineType: "test",
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

/** /health 的快照：额度用尽靠它。 */
function healthSnapshot(qoderCredits: unknown) {
  return {
    qoder: {
      qoder: { account: null, credits: qoderCredits },
    },
    minimax: { minimax: { balance: null, tokenPlan: null } },
    minimaxApi: {},
    zcode: {},
    workbuddy: { "workbuddy-cn": { credits: null } },
    tokenrhythm: { tokenrhythm: { tenants: [] } },
    sensenova: {},
    internAi: {},
  };
}

async function upstreamStateOf(id: string): Promise<string> {
  const res = await admin("ListUpstreams");
  const found = (res.upstreams ?? []).find((u: any) => u.id === id);
  return String(found?.state ?? "");
}

/** 开关在账号上，不在平台上。 */
async function setEnabled(accountId: string, enabled: boolean): Promise<void> {
  await admin("SetAccountEnabled", { accountId, enabled });
}

/* ------------------------------------------------------------------ *
 * 二、上游的七种状态
 * ------------------------------------------------------------------ */

section("上游的状态");

// 先把这个平台下的账号建出来：账号 id 由服务起（`qoder`、`qoder-2`……）。
const qoderAccountId = await addAccount("qoder", "Qoder 主账号");
check("账号加得出来", qoderAccountId === "qoder", qoderAccountId);

// 1. 开关关着。
await setEnabled("qoder", false);
check("开关关着 → UPSTREAM_STATE_DISABLED", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_DISABLED", await upstreamStateOf("qoder"));

// 2. 开着，但没有会话。
await setEnabled("qoder", true);
deleteSecret("session:provider:qoder");
deleteCached("login:state-test-pending");
check("没有会话 → UPSTREAM_STATE_NO_CREDENTIAL", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_NO_CREDENTIAL", await upstreamStateOf("qoder"));

// 3. 会话过期了。
writeSecret("session:provider:qoder", "session", qoderSession(-1000));
check("会话过期 → UPSTREAM_STATE_CREDENTIAL_EXPIRED", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_CREDENTIAL_EXPIRED", await upstreamStateOf("qoder"));

// 4. 登录被拒了（cache 里有一次失败的登录）。
writeCached("login:state-test-failed", {
  loginId: "state-test-failed",
  upstreamId: "qoder",
  accountId: "qoder",
  status: "failed",
  method: "device",
  authorizationUrl: "",
  userCode: "",
  expiresAt: Date.now() + 1000,
  message: "密码不对。",
  username: "",
  site: "",
  poll: null,
  credentialId: "",
});
check("登录被拒 → UPSTREAM_STATE_CREDENTIAL_REJECTED", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_CREDENTIAL_REJECTED", await upstreamStateOf("qoder"));

// 5. 正在登录。
writeCached("login:state-test-pending", {
  loginId: "state-test-pending",
  upstreamId: "qoder",
  accountId: "qoder",
  status: "pending",
  method: "device",
  authorizationUrl: "https://example.invalid/authorize",
  userCode: "ABCD-EFGH",
  expiresAt: Date.now() + 60_000,
  message: "等着授权。",
  username: "",
  site: "",
  poll: null,
  credentialId: "",
});
check("正在登录 → UPSTREAM_STATE_LOGGING_IN", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_LOGGING_IN", await upstreamStateOf("qoder"));

// 6. 额度用尽。
deleteCached("login:state-test-pending");
deleteCached("login:state-test-failed");
writeSecret("session:provider:qoder", "session", qoderSession(3600_000));
writeCached(
  "health:upstreams:v2",
  healthSnapshot({ region: "global", plan: { total: 100, used: 100, remaining: 0 }, addOn: { total: 0, used: 0, remaining: 0 }, quotaExceeded: true, resetsAt: null }),
);
check("额度用尽 → UPSTREAM_STATE_OUT_OF_CREDITS", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_OUT_OF_CREDITS", await upstreamStateOf("qoder"));

// 6b. 套餐用完但加购还有 —— 平台说 quotaExceeded: false，那就不算用尽。
writeCached(
  "health:upstreams:v2",
  healthSnapshot({ region: "global", plan: { total: 300, used: 300, remaining: 0 }, addOn: { total: 100, used: 0, remaining: 100 }, quotaExceeded: false, resetsAt: null }),
);
check(
  "套餐用完、加购还有 → 仍然 READY",
  (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_READY",
  await upstreamStateOf("qoder"),
);

// 7. 一切正常。
writeCached(
  "health:upstreams:v2",
  healthSnapshot({ region: "global", plan: { total: 100, used: 10, remaining: 90 }, addOn: { total: 0, used: 0, remaining: 0 }, quotaExceeded: false, resetsAt: null }),
);
check("一切正常 → UPSTREAM_STATE_READY", (await upstreamStateOf("qoder")) === "UPSTREAM_STATE_READY", await upstreamStateOf("qoder"));

// 凭据状态本身也是枚举。
const upstreams = await admin("ListUpstreams");
const qoder = (upstreams.upstreams ?? []).find((u: any) => u.id === "qoder");
check(
  "凭据状态是枚举",
  qoder?.credential?.status === "CREDENTIAL_STATE_AUTHENTICATED",
  JSON.stringify(qoder?.credential),
);

/* ------------------------------------------------------------------ *
 * 三、ListModels：关着的上游不列模型
 * ------------------------------------------------------------------ */

section("模型目录");

await setEnabled("qoder", true);
const withQoder = await admin("ListModels", { upstreamId: "qoder" });
check(
  "Qoder 开着的时候列它的模型",
  (withQoder.models ?? []).length > 0,
  JSON.stringify(withQoder).slice(0, 200),
);

await setEnabled("qoder", false);
const withoutQoder = await admin("ListModels", { upstreamId: "qoder" });
check(
  "Qoder 关着的时候一个模型也不列（那个 bug 的回归测试）",
  (withoutQoder.models ?? []).length === 0,
  JSON.stringify(withoutQoder).slice(0, 200),
);

const allOff = await admin("ListModels", {});
check("所有上游都关着的时候目录是空的", (allOff.models ?? []).length === 0, JSON.stringify(allOff).slice(0, 200));

// 从关到开：立刻就有模型了。
await setEnabled("qoder", true);
const backOn = await admin("ListModels", { upstreamId: "qoder" });
check(
  "从关到开，目录立刻出来（不用重启）",
  (backOn.models ?? []).length > 0,
  JSON.stringify(backOn).slice(0, 200),
);

/* ------------------------------------------------------------------ *
 * 四、没公布的原因
 * ------------------------------------------------------------------ */

section("没公布的原因");

async function reasonOf(id: string): Promise<string> {
  const res = await admin("ListPublishedModels");
  const found = (res.models ?? []).find((m: any) => m.id === id);
  return String(found?.unpublishedReason ?? "");
}

async function saveModel(id: string, enabled: boolean, targets: any[]): Promise<void> {
  const res = await admin("SavePublishedModel", {
    model: { id, displayName: id, strategy: "single", enabled, targets },
  });
  if (res.ok !== true) throw new Error(`存 ${id} 失败：${JSON.stringify(res)}`);
}

const qoderTarget = { groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, enabled: true };

// 1. 模型自己被停用了。
await saveModel("r-disabled", false, [qoderTarget]);
check("模型被停用 → UNPUBLISHED_REASON_DISABLED", (await reasonOf("r-disabled")) === "UNPUBLISHED_REASON_DISABLED", await reasonOf("r-disabled"));

// 2. 目标的上游关着。
await saveModel("r-upstream-off", true, [qoderTarget]);
await setEnabled("qoder", false);
check("上游关着 → UNPUBLISHED_REASON_UPSTREAM_DISABLED", (await reasonOf("r-upstream-off")) === "UNPUBLISHED_REASON_UPSTREAM_DISABLED", await reasonOf("r-upstream-off"));

// 3. 目标被停用了。
await saveModel("r-target-off", true, [{ ...qoderTarget, enabled: false }]);
check("目标被停用 → UNPUBLISHED_REASON_TARGET_DISABLED", (await reasonOf("r-target-off")) === "UNPUBLISHED_REASON_TARGET_DISABLED", await reasonOf("r-target-off"));

// 4. 上游不列这个模型了。
//    面板的接口不收上游没有的模型（那是它该拦的），所以直接写库：先存一个
//    真的，再把目标改成上游不认的模型。
await setEnabled("qoder", true);
await saveModel("r-gone", true, [qoderTarget]);
retarget("r-gone", "no-such-model");
await saveModel("r-reload", true, [qoderTarget]); // 存一次 = 重读一次目录
check("上游没这个模型 → UNPUBLISHED_REASON_MODEL_GONE", (await reasonOf("r-gone")) === "UNPUBLISHED_REASON_MODEL_GONE", await reasonOf("r-gone"));

// 5. 上游没登录。
deleteSecret("session:provider:qoder");
await saveModel("r-no-credential", true, [qoderTarget]);
check("上游没登录 → UNPUBLISHED_REASON_NO_CREDENTIAL", (await reasonOf("r-no-credential")) === "UNPUBLISHED_REASON_NO_CREDENTIAL", await reasonOf("r-no-credential"));

// 6. 一个能用的目标都没有。
//    面板的接口不收没有目标的模型（那也是它该拦的），所以直接写库。
await saveModel("r-no-target", true, [qoderTarget]);
deleteTargets("r-no-target");
await saveModel("r-reload-3", true, [qoderTarget]); // 存一次 = 重读一次目录
check("没有目标 → UNPUBLISHED_REASON_NO_TARGET", (await reasonOf("r-no-target")) === "UNPUBLISHED_REASON_NO_TARGET", await reasonOf("r-no-target"));

// 7. 有的目标能用有的不能：公布了，理由留空。
//    权重大的那个是上游不认的模型，小的那个能用 —— 照样公布。
writeSecret("session:provider:qoder", "session", qoderSession(3600_000));
await saveModel("r-mixed", true, [qoderTarget]);
writeTarget("r-mixed", "qoder", "no-such-model", 10);
await saveModel("r-reload-2", true, [qoderTarget]); // 存一次 = 重读一次目录
const mixed = await admin("ListPublishedModels");
const mixedModel = (mixed.models ?? []).find((m: any) => m.id === "r-mixed");
check(
  // 公布了就没有理由：契约里这个字段是 optional，没公布时才有。
  "有一个目标能用就是公布了，理由留空",
  mixedModel?.published === true && mixedModel?.unpublishedReason === undefined,
  JSON.stringify(mixedModel),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
if (fail) {
  console.log("");
  console.log("--- 网关的日志 ---");
  console.log(gw.log().slice(-4000));
}
process.exit(fail ? 1 : 0);
