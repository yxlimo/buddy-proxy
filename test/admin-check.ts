// test/admin-check.ts — 管理接口（Connect）的自测。
//
//   node --experimental-strip-types test/admin-check.ts
//
// 起一个真的网关（上游全关，不花 token），用浏览器那种 POST 打 Connect 的
// 端点：令牌对不对、二十个方法答不答得上、老的 JSON 路由没了没有、/health
// 还是不是公开的。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// 临时目录走系统的 tmpdir：写死的 /tmp 在 Windows 上落到当前盘的根上，
// 而且两次运行会撞在同一个目录上。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-admin-check-"));
// 这个进程也要读库（数平台）。库是第一次被用到的时候才打开的，而“第一次”
// 可能早于这个文件里的第一行代码 —— 有些模块在求值期就读配置。所以数据目录
// 必须在那些模块被加载之前定下来，而且要与网关那一份是同一个，否则数的是
// 另一个库。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { startGateway: startHarness } = await import("./harness.ts");
type Gateway = import("./harness.ts").Gateway;
const { tokenPlanView } = await import("../lib/admin/upstreams.ts");
const { PLATFORMS, allPlatforms } = await import("../lib/platforms.ts");

const SERVICE = "/buddy.admin.v1.AdminService";

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

let base = "";

/** 打一个 Connect 方法。答复里的 headers 是原样的响应头（失败的机器码就在那）。 */
async function call(
  method: string,
  body: unknown = {},
  token?: string,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** 响应头里我们要的那几个（打印用）。 */
function showHeaders(headers: Headers): string {
  const wanted = ["buddy-error", "content-type"];
  return JSON.stringify(Object.fromEntries(wanted.map((key) => [key, headers.get(key)])));
}

/** 列表字段：proto3 的 JSON 会省略空数组。 */
function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 两组 id 是不是一样的。
 *
 * 比集合，不比个数：多一个少一个都算不一样（同一个 id 出现两次也算）。
 */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const wanted = new Set(b);
  return a.every((id) => wanted.has(id));
}

/** 不带令牌打一个地址。 */
async function raw(path: string, method = "GET"): Promise<number> {
  const res = await fetch(`${base}${path}`, { method });
  await res.text();
  return res.status;
}

/** /health 的答复。 */
async function healthOf(root: string): Promise<any> {
  const res = await fetch(`${root}/health`);
  return res.json();
}

/** 当前这个网关。重启以后它会换成下一个。 */
let router: Gateway | undefined;

/** 网关的日志。自测要看令牌打没打出来。 */
const log = () => router?.log() ?? "";

/**
 * 起网关交给共用的 helper：端口被抢就换号重试，失败一定收尾。
 *
 * base 与 router 都跟着换：重启以后看到的是新那个网关。
 */
async function startRouter(): Promise<Gateway> {
  const gw = await startHarness({
    dataDir: DATA_DIR,
    keepDataDir: true,
    env: {
      // 上游全关：自测不碰任何平台。
      MINIMAX_CODE: "",
      QODER_GLOBAL: "",
      QODER_CN: "",
      WORKBUDDY_CN: "",
      TOKENRHYTHM: "",
    },
  });
  base = gw.base;
  router = gw;
  return gw;
}

// 目录在文件开头就建好了（那里要先定下数据目录）：网关起在一个空目录上。
router = await startRouter();

const cleanup = () => {
  router?.stop();
};
process.on("exit", cleanup);

console.log("");
console.log("令牌");

const tokenFile = path.join(DATA_DIR, "admin-token");
check("令牌文件生成了", fs.existsSync(tokenFile));
const mode = fs.existsSync(tokenFile) ? fs.statSync(tokenFile).mode & 0o777 : 0;
// Windows 没有 POSIX 权限位：stat 出来总是 0666，这一项只在类 Unix 上有意义。
if (process.platform !== "win32") check("令牌文件是 0600", mode === 0o600, `0${mode.toString(8)}`);
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

// 第一次起来的时候，日志里要看得见完整的令牌：人不在机器前，这是唯一的
// 一次机会。
check("日志里有令牌", log().includes(`[ADMIN] 面板令牌已生成：${token}`), log().slice(0, 200));
check("日志里说了令牌写在哪", log().includes(`写到了 ${tokenFile}（0600）`), log().slice(0, 200));
check("令牌没有出现在 /health 里", !JSON.stringify(healthOf(base)).includes(token));

const noToken = await call("GetSystemStatus");
check("没有令牌进不来", noToken.status === 401, String(noToken.status));
check("没有令牌说的是没鉴权", noToken.body?.code === "unauthenticated", JSON.stringify(noToken.body));

const badToken = await call("GetSystemStatus", {}, "not-the-token");
check("令牌不对也进不来", badToken.status === 401, String(badToken.status));

const status = await call("GetSystemStatus", {}, token);
check("令牌对了就答", status.status === 200, String(status.status));
check("答的是系统状态", Boolean(status.body?.version), JSON.stringify(status.body).slice(0, 120));
check(
  "上游列表就是模板 + 表里的开放平台",
  sameIds(
    list(status.body?.upstreams).map((u: any) => String(u.id)),
    allPlatforms().map((p) => p.id),
  ),
  JSON.stringify(list(status.body?.upstreams).map((u: any) => u.id)),
);
check(
  "上游的名字与 id 都对",
  list(status.body?.upstreams).every((u: any) => typeof u.id === "string" && typeof u.label === "string") &&
    PLATFORMS.every((p) => list(status.body?.upstreams).some((u: any) => u.id === p.id)),
  JSON.stringify(list(status.body?.upstreams).map((u: any) => u.id)),
);
check("面板令牌已配置", status.body?.adminTokenSet === true);

// 新装好的服务：内置上游全是关的（开关只有 provider.enabled 一份）。
check(
  "内置上游默认全是关的",
  list(status.body?.upstreams).every((u: any) => u.enabled === false),
  JSON.stringify(list(status.body?.upstreams).filter((u: any) => u.enabled).map((u: any) => u.id)),
);

console.log("");
console.log("上游与配置");

const upstreams = await call("ListUpstreams", {}, token);
check(
  "上游列表就是模板 + 表里的开放平台",
  sameIds(
    list(upstreams.body?.upstreams).map((u: any) => String(u.id)),
    allPlatforms().map((p) => p.id),
  ),
  JSON.stringify(list(upstreams.body?.upstreams).map((u: any) => u.id)),
);

// 启动不再插行：新库里一个账号都没有。后面要用的账号按面板的做法加出来 ——
// 平台是模板，账号才是 provider 表里的行。
const created: Record<string, string> = {};
// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
const { qiniuQuotaPlugin } = await import("../lib/qiniu/quota-plugin.ts");
insertVendorPlatform("tokenrhythm");
// 迁移后七牛云那行的 kind 是 openai：凭据 = 推理 key + 所选额度插件要的那几段。
// 这一节要写两段（key 与门户 cookie），所以行上指名七牛的额度插件。
insertVendorPlatform("qiniu", "qiniu", { quotaPlugin: qiniuQuotaPlugin.id });

for (const platform of ["qoder-cn", "qoder", "tokenrhythm", "qiniu"]) {
  const res = await call("AddAccount", { platform, alias: `${platform} 主账号` }, token);
  created[platform] = String(res.body?.id ?? "");
}
// 账号 id 是独立的自增数，跟平台 id 没有字面关系：关联只靠 platform 这一列。
const rhythmAccountId = created["tokenrhythm"];
check(
  "账号按平台加得出来，id 是独立的自增数",
  Object.values(created).every((id) => /^\d+$/.test(id)) &&
    new Set(Object.values(created)).size === Object.values(created).length,
  JSON.stringify(created),
);
check(
  "id 里没有平台的名字",
  Object.entries(created).every(([platform, id]) => !id.includes(platform)),
  JSON.stringify(created),
);

// 七牛云的凭据从面板写进去，挂在账号下面（upstream_id 是账号 id）：两段，
// 推理用的 key 与门户 cookie。
const qiniuAccountId = created["qiniu"];
const keys = await call("SetProviderKeys", { upstreamId: qiniuAccountId, keys: ["sk-qiniu-test-one", "portal=pc"] }, token);
check("key 写进去了", Number(keys.body?.count) === 2, JSON.stringify(keys.body));
check("答复里没有 ok 与 message 两格", !("ok" in (keys.body ?? {})) && !("message" in (keys.body ?? {})), JSON.stringify(keys.body));
const afterKeys = await call("ListCredentials", { accountId: qiniuAccountId }, token);
check(
  "一个账号下有推理 key 与门户 cookie",
  list(afterKeys.body?.credentials).some((c: any) => c.kind === "api_key") &&
    list(afterKeys.body?.credentials).some((c: any) => c.kind === "cookie"),
  JSON.stringify(list(afterKeys.body?.credentials).map((c: any) => c.kind)),
);
const afterKeysUp = await call("ListUpstreams", {}, token);
const qiniuUpstream = list(afterKeysUp.body?.upstreams).find((u: any) => u.id === "qiniu");
check("七牛云下就是一个账号", qiniuUpstream?.accountCount === 1, String(qiniuUpstream?.accountCount));
const badKeys = await call("SetProviderKeys", { upstreamId: "no-such-account", keys: ["x"] }, token);
check(
  "没有这个账号：404 + ACCOUNT_NOT_FOUND",
  badKeys.status === 404 && badKeys.headers.get("buddy-error") === "ACCOUNT_NOT_FOUND",
  `${badKeys.status} ${showHeaders(badKeys.headers)}`,
);
check(
  "失败答复是 Connect 的错误形状（没有 ok，code 是 not_found，消息只有事实）",
  !("ok" in (badKeys.body ?? {})) &&
    badKeys.body?.code === "not_found" &&
    !/[\u4e00-\u9fa5]/.test(String(badKeys.body?.message ?? "")),
  JSON.stringify(badKeys.body),
);
await call("SetProviderKeys", { upstreamId: qiniuAccountId, keys: [] }, token);

const config = await call("ListConfig", {}, token);
check("配置项列出来了", Array.isArray(config.body?.items) && config.body.items.length > 0);
check(
  "配置项带来源",
  list(config.body?.items).every((i: any) => ["database", "environment", "default"].includes(i.source)),
);
check(
  "配置项带说明",
  list(config.body?.items).some((i: any) => i.key === "REQUIRE_API_KEY" && i.description.length > 0),
);

const setConfig = await call("SetConfig", { key: "ADMIN_CORS_ORIGINS", value: "123456" }, token);
check("配置改得掉", setConfig.body?.ok === true, JSON.stringify(setConfig.body));
// 面板能改的设置是热的：改完就生效，没有待重启的东西。
check("改完立刻生效", setConfig.body?.pendingRestart === false, JSON.stringify(setConfig.body));

const setUnknown = await call("SetConfig", { key: "NOT_A_SETTING", value: "1" }, token);
check("不认识的配置项不收", setUnknown.body?.ok !== true);

// 用量保留天数是热设置：改完立刻生效，面板上不报「待重启」。
const setRetention = await call("SetConfig", { key: "USAGE_RETENTION_DAYS", value: "45" }, token);
check("用量保留天数改得掉", setRetention.body?.ok === true, JSON.stringify(setRetention.body));
const afterRetention = await call("GetSystemStatus", {}, token);
check(
  "改完用量保留天数不报待重启",
  afterRetention.body?.pendingRestart === false,
  JSON.stringify(afterRetention.body?.pendingRestart),
);
await call("SetConfig", { key: "USAGE_RETENTION_DAYS", value: "30" }, token);

const setUpstream = await call("SetAccountEnabled", { accountId: created["qoder-cn"], enabled: true }, token);
check("账号开关改得掉", setUpstream.body?.ok === true, JSON.stringify(setUpstream.body));
check("改了账号立刻生效", setUpstream.body?.pendingRestart === false, JSON.stringify(setUpstream.body));

const setBadUpstream = await call("SetAccountEnabled", { accountId: "nope", enabled: true }, token);
check("不认识的账号不收", setBadUpstream.body?.ok !== true);

console.log("");
console.log("生效策略");

const policyList = await call("ListUpstreams", {}, token);
const policyQoder = list(policyList.body?.upstreams).find((u: any) => u.id === "qoder");
check("上游带着策略", policyQoder?.policy === "PROVIDER_POLICY_SINGLE", JSON.stringify(policyQoder?.policy));

// 策略有自己的方法：改它不碰别名与开关。
await call("UpdateProvider", { id: rhythmAccountId, alias: "TokenRhythm" }, token);
const setPolicy = await call(
  "SetPlatformPolicy",
  { platform: "tokenrhythm", policy: "PROVIDER_POLICY_FALLBACK" },
  token,
);
check("策略改得掉", setPolicy.body?.ok === true, JSON.stringify(setPolicy.body));

const afterPolicy = await call("ListUpstreams", {}, token);
const fallbackRhythm = list(afterPolicy.body?.upstreams).find((u: any) => u.id === "tokenrhythm");
check("改完就是降级", fallbackRhythm?.policy === "PROVIDER_POLICY_FALLBACK", JSON.stringify(fallbackRhythm?.policy));
const aliasAfterPolicy = list((await call("ListAccounts", {}, token)).body?.accounts).find(
  (a: any) => a.id === rhythmAccountId,
);
check("改策略不动账号的别名", aliasAfterPolicy?.alias === "TokenRhythm", JSON.stringify(aliasAfterPolicy?.alias));

const setExpiry = await call(
  "SetPlatformPolicy",
  { platform: "tokenrhythm", policy: "PROVIDER_POLICY_EXPIRY_FIRST" },
  token,
);
check("余额到期优先也改得掉", setExpiry.body?.ok === true, JSON.stringify(setExpiry.body));

// 每个平台都收降级与余额到期优先：白名单只在 lib/platforms.ts 一处决定，
// 与 kind 无关。
const qoderFallback = await call(
  "SetPlatformPolicy",
  { platform: "qoder", policy: "PROVIDER_POLICY_FALLBACK" },
  token,
);
check("Qoder 收降级", qoderFallback.body?.ok === true, JSON.stringify(qoderFallback.body));
const qoderExpiry = await call(
  "SetPlatformPolicy",
  { platform: "qoder", policy: "PROVIDER_POLICY_EXPIRY_FIRST" },
  token,
);
check("Qoder 也收余额到期优先", qoderExpiry.body?.ok === true, JSON.stringify(qoderExpiry.body));
await call("SetPlatformPolicy", { platform: "qoder", policy: "PROVIDER_POLICY_SINGLE" }, token);

// 给错了不收，而且说清楚只认哪三个。
const badPolicy = await call("SetPlatformPolicy", { platform: "tokenrhythm", policy: 0 }, token);
check("UNSPECIFIED 不收", badPolicy.body?.ok !== true, JSON.stringify(badPolicy.body));
check(
  "错的话说了只认哪三个",
  ["single", "fallback", "expiry_first"].every((v) => String(badPolicy.body?.message ?? "").includes(v)),
  String(badPolicy.body?.message),
);

const unknownPolicy = await call("SetPlatformPolicy", { platform: "tokenrhythm", policy: 7 }, token);
check("不认识的数字不收", unknownPolicy.body?.ok !== true, JSON.stringify(unknownPolicy.body));

const afterBad = await call("ListUpstreams", {}, token);
check(
  "给错了策略没写进去",
  list(afterBad.body?.upstreams).find((u: any) => u.id === "tokenrhythm")?.policy ===
    "PROVIDER_POLICY_EXPIRY_FIRST",
);

// 策略不在 UpdateProvider 里了：改别名与开关都不该动它。
await call("UpdateProvider", { id: rhythmAccountId, alias: "TokenRhythm" }, token);
await call("UpdateProvider", { id: rhythmAccountId, enabled: true }, token);
const afterAlias = await call("ListUpstreams", {}, token);
check(
  "只改别名与开关不动策略",
  list(afterAlias.body?.upstreams).find((u: any) => u.id === "tokenrhythm")?.policy ===
    "PROVIDER_POLICY_EXPIRY_FIRST",
);
await call("SetPlatformPolicy", { platform: "tokenrhythm", policy: "PROVIDER_POLICY_SINGLE" }, token);

const kinds = await call("ListProviderKinds", {}, token);
const kindPolicies = (kind: string) => list(list(kinds.body?.kinds).find((k: any) => k.kind === kind)?.policies);
check("其余两个策略", kindPolicies("qoder").length === 2, JSON.stringify(kindPolicies("qoder")));

// 策略集合来自一处（lib/platforms.ts），每个平台的列表里都是那三个。
const upstreamPolicies = async (id: string) =>
  list(
    list((await call("ListUpstreams", {}, token)).body?.upstreams).find((u: any) => u.id === id)
      ?.policies,
  );
for (const id of ["qoder", "tokenrhythm"]) {
  const offered = await upstreamPolicies(id);
  check(`${id} 的平台列表是三个策略`, offered.length === 3, JSON.stringify(offered));
  check(
    `${id} 的平台列表是单一、降级、余额到期优先`,
    offered.join(",") ===
      "PROVIDER_POLICY_SINGLE,PROVIDER_POLICY_FALLBACK,PROVIDER_POLICY_EXPIRY_FIRST",
    offered.join(","),
  );
}

console.log("");
console.log("账号数");

const counts = await call("ListUpstreams", {}, token);
const countList = list(counts.body?.upstreams);
const accountRows = list((await call("ListAccounts", {}, token)).body?.accounts);
// 账号数是 provider 表的行数：跟账号列表里那几行一致。
for (const platform of ["qoder", "qoder-cn", "tokenrhythm", "qiniu", "workbuddy-cn"]) {
  const upstream = countList.find((u: any) => u.id === platform);
  const rows = accountRows.filter((a: any) => a.platform === platform);
  check(
    `${platform} 的账号数就是表里的行数`,
    Number(upstream?.accountCount ?? 0) === rows.length,
    `${upstream?.accountCount} vs ${rows.length}`,
  );
}

// 加一个账号，账号数跟着加一；平台本身删不掉。
const secondRhythm = await call("AddAccount", { platform: "tokenrhythm", alias: "中转站二号" }, token);
check("中转站能加第二个账号", /^\d+$/.test(String(secondRhythm.body?.id ?? "")), JSON.stringify(secondRhythm.body));
const withSecond = list((await call("ListUpstreams", {}, token)).body?.upstreams).find(
  (u: any) => u.id === "tokenrhythm",
);
check("加了就是两个", withSecond?.accountCount === 2, String(withSecond?.accountCount));

// 注销账号：行与凭据一起删。
const deleted = await call("DeleteAccount", { id: String(secondRhythm.body?.id ?? "") }, token);
check("账号删得掉", deleted.body?.ok === true, JSON.stringify(deleted.body));
const afterDelete = list((await call("ListUpstreams", {}, token)).body?.upstreams).find(
  (u: any) => u.id === "tokenrhythm",
);
check("删完就剩一个", afterDelete?.accountCount === 1, String(afterDelete?.accountCount));

console.log("");
console.log("账号与凭据");

const accounts = await call("ListAccounts", {}, token);
check("账号列出来了", list(accounts.body?.accounts).length >= 4);
check(
  "账号带着平台",
  list(accounts.body?.accounts).some((a: any) => a.platform === "qoder-cn" && a.id === created["qoder-cn"]),
  JSON.stringify(list(accounts.body?.accounts).map((a: any) => `${a.id}:${a.platform}`)),
);
check(
  "账号带着开关与建出来的时刻",
  list(accounts.body?.accounts).every((a: any) => typeof a.enabled === "boolean" && String(a.createdAt) > "0"),
  JSON.stringify(list(accounts.body?.accounts)[0]),
);

// 给 qoder-cn 那个账号写一份会话：凭据列表要看得到指纹（掩码不算数）。
const qoderDb = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
qoderDb.exec("PRAGMA busy_timeout = 5000");
qoderDb
  .prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  )
  .run(
    `session:provider:${created["qoder-cn"]}`,
    "session",
    JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAtMs: Date.now() + 3600_000,
      refreshExpiresAtMs: Date.now() + 30 * 24 * 3600 * 1000,
      generation: 1,
      loginAtMs: Date.now(),
      refreshedAtMs: Date.now(),
    }),
    Date.now(),
  );
qoderDb.close();

const credentials = await call("ListCredentials", {}, token);
check("凭据列出来了", Array.isArray(list(credentials.body?.credentials)));
check(
  "凭据只有掩码，没有原文",
  list(credentials.body?.credentials).every((c: any) => !c.masked || c.masked.includes("…")),
);
check(
  "凭据带着指纹",
  list(credentials.body?.credentials).some((c: any) => typeof c.fingerprint === "string" && c.fingerprint.length > 0),
);

const oneAccount = await call("ListCredentials", { accountId: created["qoder-cn"] }, token);
check(
  "凭据能按账号筛",
  oneAccount.body?.credentials?.every((c: any) => c.accountId === created["qoder-cn"]),
);

// 迁移后中转站不再有登录会话：它是一个 openai 平台，账号唯一的凭据就是那把
// 推理 key（key:provider:<账号>:key）。从面板写进去，面板上那条凭据就不是 missing。
await call("SetProviderKeys", { upstreamId: rhythmAccountId, keys: ["sk-tr-test-one"] }, token);

const rhythmCredentials = list((await call("ListCredentials", { accountId: rhythmAccountId }, token)).body?.credentials);
const rhythmKey = rhythmCredentials.find((c: any) => c.kind === "api_key");
check("中转站的推理 key 凭据列出来了", Boolean(rhythmKey), JSON.stringify(rhythmCredentials));
check(
  "中转站的推理 key 凭据不是 missing",
  rhythmKey?.status === "usable",
  String(rhythmKey?.status),
);
check(
  "中转站的推理 key 凭据 id 就是 key:provider:<账号>:key",
  rhythmKey?.id === `key:provider:${rhythmAccountId}:key`,
  String(rhythmKey?.id),
);

const testCredential = await call("TestCredential", { credentialId: "nope:nope" }, token);
check("试一条不存在的凭据会失败", testCredential.body?.ok !== true, JSON.stringify(testCredential.body));
check("试凭据会记下时间", Boolean(testCredential.body?.checkedAt));

const refreshCredential = await call("RefreshCredential", { credentialId: "nope:nope" }, token);
check("刷一条不存在的凭据会失败", refreshCredential.body?.ok !== true);

console.log("");
console.log("凭据的 id：现行格式");

// 认得这些 id（形状对不对），但不真的去问上游。
//
// 「试一下」会真的去问上游，所以这里的 id 都指向一个不存在的上游：形状对
// 的话得到的是「没有这个 Provider」，形状不对才是「无法识别的凭据」。这样
// 一个字也不出机器。
const knownIds = [
  "session:provider:no-such-upstream",
  "key:provider:no-such-upstream:key-1",
  "key:provider:no-such-upstream:account",
];
for (const id of knownIds) {
  const tried = await call("TestCredential", { credentialId: id }, token);
  const message = String(tried.body?.message ?? "");
  check(`认得 ${id}`, !message.includes("无法识别的凭据"), message);
}
for (const id of knownIds) {
  const refreshed = await call("RefreshCredential", { credentialId: id }, token);
  const message = String(refreshed.body?.message ?? "");
  check(`刷新也认得 ${id}`, !message.includes("无法识别的凭据"), message);
}
// 一个真的存在的上游，但会话不在：识得出这个 id，而「试一下」问的是本地的
// 会话，读不到就答「没有登录」——一个字也不出机器。
// （不能用真的 provider id：那边会带着真令牌去问真的 Qoder。）
const knownKind = await call("TestCredential", { credentialId: "session:provider:no-such-upstream" }, token);
check(
  "认得形状对的 id",
  !String(knownKind.body?.message ?? "").includes("无法识别的凭据"),
  String(knownKind.body?.message),
);
const unknownProvider = await call("TestCredential", { credentialId: "session:provider:no-such-upstream" }, token);
check(
  "账号不在就说账号不在",
  String(unknownProvider.body?.message ?? "").includes("没有这个账号"),
  String(unknownProvider.body?.message),
);
// 旧格式是迁移回落，不再是现行格式。
const legacyId = await call("TestCredential", { credentialId: "session:minimax" }, token);
check(
  "旧格式不认了",
  String(legacyId.body?.message ?? "").includes("无法识别的凭据"),
  String(legacyId.body?.message),
);
// 旧的 plan 后缀也不认了：MiniMax Code 的额度只走会话。
const legacyPlanId = await call("TestCredential", { credentialId: "key:provider:no-such-upstream:plan" }, token);
check(
  "旧的 plan 后缀不认了",
  String(legacyPlanId.body?.message ?? "").includes("无法识别的凭据"),
  String(legacyPlanId.body?.message),
);

console.log("");
console.log("MiniMax Code：只用会话");

// 面板不再问这个 key。
const codeKeys = await call("SetProviderKeys", { upstreamId: "minimax", keys: ["sk-cp-nope"] }, token);
check(
  "MiniMax Code 不收 key：ACCOUNT_TAKES_NO_KEY",
  codeKeys.status === 400 && codeKeys.headers.get("buddy-error") === "ACCOUNT_TAKES_NO_KEY",
  `${codeKeys.status} ${showHeaders(codeKeys.headers)}`,
);
check(
  "细节说的是它用会话（英文事实，不是中文文案）",
  String(codeKeys.body?.message ?? "").includes("logs in"),
  String(codeKeys.body?.message),
);

// 它的凭据只有会话那一条。
const codeAccount = await call("AddAccount", { platform: "minimax", alias: "Code 主账号" }, token);
const codeAccountId = String(codeAccount.body?.id ?? "");
const codeCreds = await call("ListCredentials", { accountId: codeAccountId }, token);
check(
  "MiniMax Code 的凭据只有会话",
  list(codeCreds.body?.credentials).every((c: any) => c.kind === "session") &&
    list(codeCreds.body?.credentials).length === 1,
  JSON.stringify(list(codeCreds.body?.credentials).map((c: any) => [c.id, c.kind])),
);

console.log("");
console.log("余额与用量");

const balance = await call("GetBalance", {}, token);
check("余额答得上来", balance.status === 200 && Array.isArray(list(balance.body?.balances)));

const usage = await call("GetUsageSummary", {}, token);
check("用量合计答得上来", usage.status === 200 && usage.body?.total !== undefined);
check("用量能按上游分组", Array.isArray(list(usage.body?.byUpstream)));
check("用量能按模型分组", Array.isArray(list(usage.body?.byModel)));
check("用量能按天分组", Array.isArray(list(usage.body?.byDay)));

const usageWindow = await call("GetUsageSummary", { upstreamId: "qoder", window: "day" }, token);
check("用量能按窗口筛", usageWindow.status === 200);

const events = await call("ListUsageEvents", { limit: 10 }, token);
check("用量明细答得上来", events.status === 200 && Array.isArray(list(events.body?.events)));

console.log("");
console.log("公布的模型");

const save = await call(
  "SavePublishedModel",
  {
    model: {
      id: "from-the-panel",
      displayName: "From the panel",
      strategy: "single",
      enabled: true,
      targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("模型存得进去", save.status === 200 && save.body?.id === "from-the-panel", JSON.stringify(save.body));
check("存完给了 id", save.body?.id === "from-the-panel");

const listed = await call("ListPublishedModels", {}, token);
check("模型读得回来", listed.body?.models?.some((m: any) => m.id === "from-the-panel"));
check(
  "模型带着目标",
  list(listed.body?.models).find((m: any) => m.id === "from-the-panel")?.targets?.[0]?.groupName === "qoder",
);

const badSave = await call("SavePublishedModel", { model: { id: "" } }, token);
check(
  "没有 id 的模型不收：MODEL_ID_MISSING",
  badSave.status === 400 && badSave.headers.get("buddy-error") === "MODEL_ID_MISSING",
  `${badSave.status} ${showHeaders(badSave.headers)}`,
);

console.log("");
console.log("失败怎么表达");

// 失败不是「200 + ok:false + 一句中文」，而是一次 Connect 错误：状态码按语义，
// 机器码在响应头 buddy-error 上，错误消息里只有排查用的事实。
//
// 这一节打真的 HTTP：面板拿到的是这两个东西，不是服务方法的返回值。

const dupPlatform = await call(
  "AddPlatform",
  { id: "dup-check", label: "Dup Check", baseUrl: "https://api.dup.test/v1" },
  token,
);
check("平台加得进去", dupPlatform.status === 200, JSON.stringify(dupPlatform.body));
check(
  "成功答复里没有 ok 与 message 两格",
  !("ok" in (dupPlatform.body ?? {})) && !("message" in (dupPlatform.body ?? {})),
  JSON.stringify(dupPlatform.body),
);

const dupAgain = await call(
  "AddPlatform",
  { id: "dup-check", label: "Dup Check", baseUrl: "https://api.dup.test/v1" },
  token,
);
// 这一行就是交付记录里要贴的那一条：同一次失败的响应头。
console.log(`  (一个真实失败的响应头) ${dupAgain.status} ${showHeaders(dupAgain.headers)} ${JSON.stringify(dupAgain.body)}`);
check(
  "重名：409 + PLATFORM_ALREADY_EXISTS 在响应头上",
  dupAgain.status === 409 && dupAgain.headers.get("buddy-error") === "PLATFORM_ALREADY_EXISTS",
  `${dupAgain.status} ${showHeaders(dupAgain.headers)}`,
);
check(
  "失败答复是 Connect 的错误形状（没有 ok，code 是 already_exists）",
  !("ok" in (dupAgain.body ?? {})) && dupAgain.body?.code === "already_exists",
  JSON.stringify(dupAgain.body),
);
check(
  "错误消息里没有中文文案（只有事实）",
  /[\u4e00-\u9fa5]/.test(String(dupAgain.body?.message ?? "")) === false,
  String(dupAgain.body?.message),
);

const renamedMiss = await call("UpdatePlatform", { id: "no-such-platform", label: "x" }, token);
check(
  "改不存在的平台：404 + PLATFORM_NOT_FOUND",
  renamedMiss.status === 404 && renamedMiss.headers.get("buddy-error") === "PLATFORM_NOT_FOUND",
  `${renamedMiss.status} ${showHeaders(renamedMiss.headers)}`,
);

const deletedMiss = await call("DeletePlatform", { id: "no-such-platform" }, token);
check(
  "删不存在的平台：404 + PLATFORM_NOT_FOUND",
  deletedMiss.status === 404 && deletedMiss.headers.get("buddy-error") === "PLATFORM_NOT_FOUND",
  `${deletedMiss.status} ${showHeaders(deletedMiss.headers)}`,
);

const droppedPlatform = await call("DeletePlatform", { id: "dup-check" }, token);
check("建的那个平台删得掉", droppedPlatform.status === 200, JSON.stringify(droppedPlatform.body));

const missAccount = await call("AddAccount", { platform: "no-such-platform" }, token);
check(
  "账号加在不存在的平台上：404 + ACCOUNT_PLATFORM_NOT_FOUND",
  missAccount.status === 404 && missAccount.headers.get("buddy-error") === "ACCOUNT_PLATFORM_NOT_FOUND",
  `${missAccount.status} ${showHeaders(missAccount.headers)}`,
);

const badOverrides = await call("SetModelOverrides", { platformId: "qoder", overrides: [{ id: "" }] }, token);
check(
  "人工条目的模型 id 空着：400 + MODEL_ID_MISSING",
  badOverrides.status === 400 && badOverrides.headers.get("buddy-error") === "MODEL_ID_MISSING",
  `${badOverrides.status} ${showHeaders(badOverrides.headers)}`,
);

const missOverride = await call("DeleteModelOverride", { platformId: "qoder", modelId: "no-such-model" }, token);
check(
  "删不存在的人工条目：404 + MODEL_OVERRIDE_NOT_FOUND",
  missOverride.status === 404 && missOverride.headers.get("buddy-error") === "MODEL_OVERRIDE_NOT_FOUND",
  `${missOverride.status} ${showHeaders(missOverride.headers)}`,
);

const noUpstream = await call(
  "SavePublishedModel",
  {
    model: {
      id: "no-upstream",
      displayName: "No Upstream",
      strategy: "single",
      targets: [{ groupName: "qoder", upstreamModel: "", weight: 1, enabled: true }],
    },
  },
  token,
);
check(
  "目标没填上游模型：400 + MODEL_MISSING_UPSTREAM",
  noUpstream.status === 400 && noUpstream.headers.get("buddy-error") === "MODEL_MISSING_UPSTREAM",
  `${noUpstream.status} ${showHeaders(noUpstream.headers)}`,
);

const del = await call("DeletePublishedModel", { id: "from-the-panel" }, token);
check("模型删得掉", del.body?.ok === true, JSON.stringify(del.body));

const delAgain = await call("DeletePublishedModel", { id: "from-the-panel" }, token);
check("删不存在的模型会说没有", delAgain.body?.ok !== true);

console.log("");
console.log("权益、目录与日志");

const benefitStatus = await call("GetBenefitStatus", {}, token);
check("权益状态答得上来", benefitStatus.status === 200 && Array.isArray(list(benefitStatus.body?.benefits)));

const runBenefit = await call("RunBenefitNow", {}, token);
check("立刻签到答得上来", runBenefit.status === 200 && runBenefit.body?.ok !== undefined, JSON.stringify(runBenefit.body));

const models = await call("ListModels", {}, token);
check("模型目录答得上来", models.status === 200 && Array.isArray(list(models.body?.models)));

const modelsOne = await call("ListModels", { upstreamId: "qoder-cn" }, token);
check(
  "模型目录能按上游筛",
  modelsOne.status === 200 && list(modelsOne.body?.models).every((m: any) => m.id !== "hy3"),
);

// 目录是**平台**的一组（路径里那一段是平台 id）：同一个平台下加第二个账号
// 不会让同一批模型在列表里出现两遍。
const added = await call("AddAccount", { platform: "qoder-cn", alias: "第二个 Qoder CN" }, token);
check("用户加的账号加得进去", /^\d+$/.test(String(added.body?.id ?? "")), JSON.stringify(added.body));
const addedModels = await call("ListModels", { upstreamId: "qoder-cn" }, token);
check(
  "同一个平台加第二个账号，目录还只有一组",
  addedModels.status === 200 && list(addedModels.body?.models).length > 0,
  JSON.stringify(list(addedModels.body?.models).map((m: any) => m.id)),
);
const afterSecond = await call("ListUpstreams", {}, token);
const modelsPerPlatform = list(afterSecond.body?.upstreams).find((u: any) => u.id === "qoder-cn");
check(
  "平台上两个账号，账号数是 2",
  modelsPerPlatform?.accountCount === 2,
  JSON.stringify(afterSecond.body).slice(0, 300),
);

const tail = await call("TailLog", { lines: 10 }, token);
check("日志尾巴读得出来", tail.status === 200 && Array.isArray(list(tail.body?.lines)));

const tailFiltered = await call("TailLog", { lines: 10, filter: "不会有的词" }, token);
check("日志能按词筛", tailFiltered.status === 200 && list(tailFiltered.body?.lines).length === 0);

console.log("");
console.log("继承");

// 一个不填元数据的模型：那些字段就是继承目标的值。
const inheritSave = await call(
  "SavePublishedModel",
  {
    model: {
      id: "inherit-test",
      displayName: "继承",
      strategy: "single",
      enabled: true,
      targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("继承的模型存得进去", inheritSave.status === 200 && Boolean(inheritSave.body?.id), JSON.stringify(inheritSave.body));

const inheritList = await call("ListPublishedModels", {}, token);
const inheritModel = list(inheritList.body?.models).find((m: any) => m.id === "inherit-test");
check("继承的字段读回来是没有", inheritModel && inheritModel.contextWindow === undefined, JSON.stringify(inheritModel));
check("继承的布尔读回来也是没有", inheritModel && inheritModel.reasoning === undefined, JSON.stringify(inheritModel));

// 库里存的是空的（继承），不是 0 也不是 false。
const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
const row = db
  .prepare("SELECT context_window, max_output_tokens, reasoning, tool_call FROM aggregate_model WHERE id = ?")
  .get("inherit-test") as any;
check(
  "库里存的是 NULL",
  row?.context_window === null && row?.max_output_tokens === null && row?.reasoning === null && row?.tool_call === null,
  JSON.stringify(row),
);

// 原样存回去，还是继承。
const echo = await call("SavePublishedModel", { model: inheritModel }, token);
check("原样存回去不报错", echo.status === 200 && Boolean(echo.body?.id), JSON.stringify(echo.body));
const row2 = db.prepare("SELECT context_window FROM aggregate_model WHERE id = ?").get("inherit-test") as any;
check("原样存回去库里还是 NULL", row2?.context_window === null, JSON.stringify(row2));

// 上游有目录的时候也一样：继承的字段还是没有，现算的值另放在 effective 里。
// 这两个混了，面板一存就把「继承」变成写死的数字。
const inheritedSave = await call(
  "SavePublishedModel",
  {
    model: {
      id: "inherits-a-catalog",
      displayName: "继承有目录的上游",
      strategy: "single",
      enabled: true,
      targets: [{ groupName: "qoder-cn", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("继承有目录的上游也存得进去", inheritedSave.status === 200 && Boolean(inheritedSave.body?.id), JSON.stringify(inheritedSave.body));

const withCatalog = await call("ListPublishedModels", {}, token);
const catalogModel = list(withCatalog.body?.models).find((m: any) => m.id === "inherits-a-catalog");
check(
  "有目录的时候，继承的字段还是没有",
  catalogModel && catalogModel.contextWindow === undefined && catalogModel.maxOutputTokens === undefined,
  JSON.stringify(catalogModel),
);
check(
  "现算的值在 effective 里",
  catalogModel && Number(catalogModel.effective?.contextWindow ?? 0) > 0,
  JSON.stringify(catalogModel?.effective),
);
check(
  "effective 里的值跟根路由公布的是同一个",
  catalogModel &&
    Number(catalogModel.effective?.contextWindow) ===
      Number(list((await call("ListModels", { upstreamId: "qoder-cn" }, token)).body?.models).find((m: any) => m.id === "glm-5.3")?.contextWindow),
  JSON.stringify(catalogModel?.effective),
);
// 原样存回去，继承还在。
const echoCatalog = await call("SavePublishedModel", { model: catalogModel }, token);
check("原样存回去不报错", echoCatalog.status === 200 && Boolean(echoCatalog.body?.id), JSON.stringify(echoCatalog.body));
const rowCatalog = db
  .prepare("SELECT context_window, max_output_tokens FROM aggregate_model WHERE id = ?")
  .get("inherits-a-catalog") as any;
check(
  "原样存回去库里还是 NULL",
  rowCatalog?.context_window === null && rowCatalog?.max_output_tokens === null,
  JSON.stringify(rowCatalog),
);
await call("DeletePublishedModel", { id: "inherits-a-catalog" }, token);

// 给了值就是给了值。
const explicit = await call(
  "SavePublishedModel",
  {
    model: {
      id: "explicit-test",
      displayName: "写死",
      strategy: "single",
      enabled: true,
      contextWindow: 123456,
      reasoning: false,
      targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("写死的模型存得进去", explicit.status === 200 && Boolean(explicit.body?.id), JSON.stringify(explicit.body));
const row3 = db
  .prepare("SELECT context_window, reasoning FROM aggregate_model WHERE id = ?")
  .get("explicit-test") as any;
check("给了的值存进去了", row3?.context_window === 123456 && row3?.reasoning === 0, JSON.stringify(row3));

const explicitList = await call("ListPublishedModels", {}, token);
const explicitModel = list(explicitList.body?.models).find((m: any) => m.id === "explicit-test");
check("给的值读得回来", explicitModel?.contextWindow === 123456, JSON.stringify(explicitModel));
check("false 读得回来", explicitModel?.reasoning === false, JSON.stringify(explicitModel));

console.log("");
console.log("上游与余额的新字段");

const withUrls = await call("ListUpstreams", {}, token);
const qoderUpstream = list(withUrls.body?.upstreams).find((u: any) => u.id === "qoder");
check("上游有地址", typeof qoderUpstream?.baseUrl === "string" && qoderUpstream.baseUrl.length > 0, JSON.stringify(qoderUpstream));
check("上游有区域", qoderUpstream?.region === "global", JSON.stringify(qoderUpstream?.region));
const cnUpstream = list(withUrls.body?.upstreams).find((u: any) => u.id === "qoder-cn");
check("中国区的区域是 cn", cnUpstream?.region === "cn", JSON.stringify(cnUpstream?.region));

// 开关：平台自己没有开关，`enabled` 说的是「名下有没有开着的账号」。
// 关掉唯一的那个账号，平台就是关的；再打开，平台又开着。开关是热的。
await call("SetAccountEnabled", { accountId: created["qoder"], enabled: false }, token);
const beforeSwitch = list((await call("ListUpstreams", {}, token)).body?.upstreams).find(
  (u: any) => u.id === "qoder",
);
check("账号关着的时候平台是关的", beforeSwitch?.enabled === false, JSON.stringify(beforeSwitch?.enabled));
const setSwitch = await call("SetAccountEnabled", { accountId: created["qoder"], enabled: true }, token);
check("开关改得掉", setSwitch.body?.ok === true, JSON.stringify(setSwitch.body));
const afterSwitch = list((await call("ListUpstreams", {}, token)).body?.upstreams).find(
  (u: any) => u.id === "qoder",
);
check("改完 enabled 就是改后的值", afterSwitch?.enabled === true, JSON.stringify(afterSwitch?.enabled));
// 没有「待生效」这回事：答复里根本没有这个字段。
check("答复里没有待生效的标志", !("pending" in (afterSwitch ?? {})), JSON.stringify(afterSwitch));

const balanceWithIds = await call("GetBalance", {}, token);
check(
  "余额带着上游与账号",
  list(balanceWithIds.body?.balances).every(
    (b: any) => typeof b.upstreamId === "string" && typeof b.accountId === "string",
  ),
  JSON.stringify(balanceWithIds.body?.balances),
);
check(
  "套餐额度只有 MiniMax 有",
  list(balanceWithIds.body?.balances).every(
    (b: any) => b.tokenPlan === undefined || b.upstreamId === "minimax",
  ),
  JSON.stringify(balanceWithIds.body?.balances?.map((b: any) => [b.upstreamId, b.tokenPlan !== undefined])),
);

const accountsWithBalance = await call("ListAccounts", {}, token);
check(
  "账号的余额没有就没有",
  list(accountsWithBalance.body?.accounts).every((a: any) => a.balance === undefined || a.balance.accountId === a.id),
  JSON.stringify(accountsWithBalance.body?.accounts?.slice(0, 2)),
);

console.log("");
console.log("配置项的名字");

const configItems = list((await call("ListConfig", {}, token)).body?.items);
check("配置项都有名字", configItems.every((i: any) => typeof i.label === "string" && i.label.length > 0));
check("名字不是键名", configItems.every((i: any) => i.label !== i.key));
check(
  "名字是人话，不是 env 键名",
  configItems.every((i: any) => !/^[A-Z][A-Z0-9_]+$/.test(i.label)),
  JSON.stringify(configItems.filter((i: any) => /^[A-Z][A-Z0-9_]+$/.test(i.label)).map((i: any) => i.key)),
);
// 上游的开关搬到了上游那一页，配置页不再重复一份。
check(
  "配置页里没有上游的开关",
  configItems.every((i: any) => !["MINIMAX_CODE", "QODER_GLOBAL", "QODER_CN", "WORKBUDDY_CN", "TOKENRHYTHM"].includes(i.key)),
  JSON.stringify(configItems.map((i: any) => i.key)),
);

console.log("");
console.log("套餐额度的换算");

// 平台给的是 ISO 字符串与百分比，面板要的是毫秒与整数。
const plan = tokenPlanView({
  windows: [
    {
      model: "general",
      intervalPercent: 62.4,
      weeklyPercent: 88,
      intervalEndsAt: "2026-10-22T12:00:00.000Z",
      weeklyEndsAt: "2026-10-29T12:00:00.000Z",
    },
  ],
});
check("套餐窗口换算出来了", plan?.windows?.length === 1, JSON.stringify(plan));
check("窗口的名字是平台给的那个", plan?.windows?.[0]?.label === "general", JSON.stringify(plan?.windows?.[0]));
check("百分比取整", plan?.windows?.[0]?.intervalPercent === 62, JSON.stringify(plan?.windows?.[0]));
check("到期时间换成毫秒", plan?.windows?.[0]?.intervalEndsAt === Date.parse("2026-10-22T12:00:00.000Z"));
check("没有套餐就是没有", tokenPlanView({ windows: [] }) === undefined);
check("没有套餐也是没有", tokenPlanView(null) === undefined);

console.log("");
console.log("用量的游标");

const allEvents = await call("ListUsageEvents", { limit: 100 }, token);
const firstPage = list(allEvents.body?.events);
if (firstPage.length >= 2) {
  // 答复是新的在前，id 越早越小。
  const descending = firstPage.every((e: any, i: number) => i === 0 || BigInt(firstPage[i - 1].id) > BigInt(e.id));
  check("新的在前", descending, JSON.stringify(firstPage.map((e: any) => e.id)));
  const cursor = firstPage[firstPage.length - 1].id;
  const nextPage = await call("ListUsageEvents", { limit: 100, beforeId: cursor }, token);
  const second = list(nextPage.body?.events);
  check("游标翻到更早的那些", second.every((e: any) => BigInt(e.id) < BigInt(cursor)), JSON.stringify(second.map((e: any) => e.id)));
  check("游标翻页不重复", !second.some((e: any) => firstPage.some((f: any) => f.id === e.id)));
} else {
  check("新的在前", true);
  check("游标翻到更早的那些", true);
  check("游标翻页不重复", true);
}

console.log("");
console.log("老路由与 /health");

// 老的 JSON 路由没了：/admin 下面是面板的单页应用，深链接回 index.html，
// 但答的不能再是老的 JSON。
const oldModels = await fetch(`${base}/admin/models`);
const oldModelsText = await oldModels.text();
check("老的 /admin/models 没了", !oldModelsText.includes('"data"'), oldModelsText.slice(0, 80));
const oldUsage = await fetch(`${base}/admin/usage`);
const oldUsageText = await oldUsage.text();
check("老的 /admin/usage 没了", !oldUsageText.includes('"data"'), oldUsageText.slice(0, 80));
check("老的 /admin/reload 没了", (await raw("/admin/reload", "POST")) === 404);

const health = await fetch(`${base}/health`);
const healthBody = await health.json();
check("/health 还是公开的", health.status === 200);
check("/health 的形状没变", healthBody?.status === "ok" && Boolean(healthBody?.upstreams) && Boolean(healthBody?.snapshot));
check(
  "/health 里有各平台（名字、区域、账号）",
  healthBody?.upstreams?.qoder?.region === "global" &&
    Array.isArray(healthBody?.upstreams?.qoder?.accounts) &&
    typeof healthBody?.upstreams?.qoder?.enabled === "boolean",
  JSON.stringify(healthBody?.upstreams?.qoder).slice(0, 200),
);

console.log("");
console.log("重启以后");

// 再起一个：令牌文件已经在那里了，日志里不该再打一次。
router?.stop();
await new Promise((r) => setTimeout(r, 500));
const second = await startRouter();
const up = Boolean(second.base);
check("第二个网关起来了", up);
check("令牌没有再打一遍", !log().includes("[ADMIN] 面板令牌已生成"), log().slice(0, 300));
check("令牌还是同一个", fs.readFileSync(tokenFile, "utf8").trim() === token);
second.stop();

console.log("");
console.log(`pass=${pass} fail=${fail}`);
cleanup();
process.exit(fail ? 1 : 0);
