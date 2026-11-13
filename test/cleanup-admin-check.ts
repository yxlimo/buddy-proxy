// test/cleanup-admin-check.ts — 这一轮清理的自测（管理面板这一面）。
//
//   node --experimental-strip-types test/cleanup-admin-check.ts
//
// 离线：不碰真上游，不发真请求，不花额度。
//
// 覆盖：
//   1. 新装好的服务：内置上游全是关的（开关只有 provider.enabled 一份）；
//   2. 凭据的 id 是现行格式：面板的「试一下/刷新」认得每一种形状；
//   3. TokenRhythm 的会话是一张表：会话凭据不再是 missing；
//   3.1 七牛云的两段凭据都列出来：账号行不再是「暂无凭据」；
//   4. 用量保留天数是热设置：改完不报「待重启」；
//   5. 用户自己加的 provider 出现在模型目录里；
//   6. config-cli 拒绝服务没问过的设置。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-admin-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

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
 * 一、新装好的服务：内置上游全是关的
 * ------------------------------------------------------------------ */

section("新装好的服务");

const { listProviders, addAccount } = await import("../lib/providers.ts");
const { allPlatforms } = await import("../lib/platforms.ts");
const { listOpenPlatforms } = await import("../lib/open-platforms.ts");
const { SIMULATED_CLIENTS } = await import("../lib/platform-catalog.ts");

// 启动不再插账号行：新装好的服务里一个账号都没有，平台是表里的行（模拟客户端
// 那几条由启动时播出来；厂商那几行是用户在面板上自己建的）。
const builtIn = listProviders();
check("新装好的服务里一个账号都没有", builtIn.length === 0, builtIn.map((p) => p.id).join(","));
// 目录里的全部 id（含 hidden 的）：唯一性要按整张目录算。
const builtInIds = SIMULATED_CLIENTS.map((c) => c.id);
check(
  "内置平台的 id 是唯一的",
  new Set(builtInIds).size === builtInIds.length,
  builtInIds.join(","),
);
// 会播种的那几条：目录里的 hidden 条目（zcode）不播 —— 它在目录里，但表里没有
// 行。所以「会播种的」与「目录里有的」不是一回事，不能拿 builtInIds 当行数用。
const seededIds = SIMULATED_CLIENTS.filter((c) => !c.hidden).map((c) => c.id);
// 平台全在表里：会播种的模拟客户端就是表里那几行（厂商那几行不再由代码补）。
check(
  "平台就是表里那几行（启动播进来的）",
  seededIds.every((id) => typeof id === "string" && id.length > 0) &&
    listOpenPlatforms().length === seededIds.length &&
    allPlatforms().length === listOpenPlatforms().length,
  `${seededIds.join(",")} / ${listOpenPlatforms().length}`,
);
check(
  "上游的开关不在环境里了",
  !/MINIMAX_CODE|QODER_GLOBAL|QODER_CN|WORKBUDDY_CN|TOKENRHYTHM|SENSENOVA|INTERN_AI|ZCODE|MINIMAX_API/.test(
    fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8"),
  ),
);

/* ------------------------------------------------------------------ *
 * 二、凭据的 id：现行格式
 * ------------------------------------------------------------------ */

section("凭据的 id");

const { parseCredentialId } = await import("../lib/admin/credentials.ts");

const shapes: [string, string, number | null][] = [
  ["session:provider:qoder", "session", null],
  // 通用开放平台那一把推理 key 就在 :key 这个后缀上：认不出它，面板上那一行
  // 的「试一下」就只会回「无法识别的凭据」。
  ["key:provider:open-platform:key", "api_key", null],
  // 一把 key 一个租户的那种形状：解析器照样认得。
  ["key:provider:qiniu:key-1", "api_key", 1],
  ["key:provider:sensenova:account", "login", null],
  ["key:provider:intern-ai:account", "login", null],
  ["key:provider:tokenrhythm:account", "login", null],
];
for (const [id, form, tenant] of shapes) {
  const ref = parseCredentialId(id);
  check(
    `认得 ${id}`,
    ref?.form === form && ref?.tenant === tenant,
    JSON.stringify(ref),
  );
}
check(
  "旧的 plan 后缀不认了（MiniMax Code 的额度只走会话）",
  parseCredentialId("key:provider:minimax:plan") === null,
  JSON.stringify(parseCredentialId("key:provider:minimax:plan")),
);
check(
  "从账号里派生出来的推理 key 也认得",
  parseCredentialId("key:provider:sensenova:account#api_key")?.derived === "api_key",
  JSON.stringify(parseCredentialId("key:provider:sensenova:account#api_key")),
);
check(
  "旧格式不认（那是迁移回落，不是现行格式）",
  parseCredentialId("session:minimax") === null &&
    parseCredentialId("account:tokenrhythm:1") === null &&
    parseCredentialId("session:provider:tokenrhythm:tenant-1") === null,
  JSON.stringify(parseCredentialId("session:provider:tokenrhythm:tenant-1")),
);

/* ------------------------------------------------------------------ *
 * 二之二、删一个上游的凭据：不能连别的上游一起删
 * ------------------------------------------------------------------ */
section("删凭据的边界");

const { deleteProviderCredentials } = await import("../lib/providers.ts");
const { getSecret, setSecret: writeSecret } = await import("../lib/store.ts");

// 同前缀的另一个上游：它们的前缀一样，只有冒号后面不一样。
writeSecret("session:provider:minimax", "session", { accessToken: "a" });
// 旧库里留下的套餐 key：账号注销时也要跟着删干净。
writeSecret("key:provider:minimax:plan", "account", { key: "b" });
writeSecret("session:provider:minimax-code-m-plan", "session", { accessToken: "c" });
// 另一个平台的凭据：前缀不一样，删 minimax 不该动它。
writeSecret("session:provider:qiniu", "session", { accessToken: "d" });
writeSecret("key:provider:qiniu:key-1", "account", { key: "e" });

const dropped = deleteProviderCredentials("minimax");
check("删掉了自己的凭据", dropped === 2, String(dropped));
check("会话没了", getSecret("session:provider:minimax") === null);
check("plan key 没了", getSecret("key:provider:minimax:plan") === null);
check(
  "同前缀的另一个上游还在（M plan）",
  getSecret("session:provider:minimax-code-m-plan") !== null,
);
check(
  "别的上游的凭据没动（七牛云）",
  getSecret("session:provider:qiniu") !== null &&
    getSecret("key:provider:qiniu:key-1") !== null,
);

/* ------------------------------------------------------------------ *
 * 二之二之二、「试一下」说的要与那一行对得上
 * ------------------------------------------------------------------ */

section("「试一下」说的话");

const { testCredential, credentialsOf, listAccounts } = await import("../lib/admin/accounts.ts");

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("sensenova");
insertVendorPlatform("tokenrhythm");
// 七牛要两段凭据（推理 Key + 额度 Cookie），额度那一段由插件带进来：行上指名它。
insertVendorPlatform("qiniu", "qiniu", { quotaPlugin: "qiniu" });
const { setProviderKeys } = await import("../lib/admin/credentials.ts");

// 迁移后的形状：SenseNova 的行上 kind=openai。登录会话随 kind 退场不再列
// （面板上没有登录流了），推理 key 在开放平台读的那一处（:key）。
const senseAccount = addAccount({ platform: "sensenova", alias: "测试 SenseNova" });
const senseId = String(senseAccount.id ?? "");
check("SenseNova 账号建出来了", Boolean(senseId), senseId);
writeSecret(`session:provider:${senseId}`, "session", { accessToken: "sn-session" });
setProviderKeys(senseId, ["sk-sense-test"]);
const senseCredentials = credentialsOf(senseId);
check(
  "SenseNova 只列推理 Key 一行（会话与登录账号都不列）",
  senseCredentials.map((c) => c.id).join(",") === `key:provider:${senseId}:key`,
  senseCredentials.map((c) => `${c.id}:${c.kind}`).join(","),
);
check(
  "SenseNova 的条数与列出来的行数一致",
  listAccounts().find((a) => a.id === senseId)?.credentialCount === senseCredentials.length,
  JSON.stringify({
    count: listAccounts().find((a) => a.id === senseId)?.credentialCount,
    rows: senseCredentials.length,
  }),
);
const senseKeyTried = await testCredential(`key:provider:${senseId}:key`);
check(
  "推理 Key 试得起来（不回「无法识别」）",
  !senseKeyTried.message.includes("无法识别"),
  senseKeyTried.message,
);

/* ------------------------------------------------------------------ *
 * 三、TokenRhythm 的凭据挂在账号行上
 * ------------------------------------------------------------------ */

section("TokenRhythm 的凭据");

const { setSecret } = await import("../lib/store.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

const trOne = addAccount({ platform: "tokenrhythm", alias: "中转站一号" });
const trOneId = String(trOne.id ?? "");
check("第一个账号建出来了", Boolean(trOneId), trOneId);
// 迁移后：推理 key 在 :key，会话只在插件内部读（面板上不列，登录流退场了）。
setProviderKeys(trOneId, ["sk_tr_one"]);
setSecret(`session:provider:${trOneId}`, "session", {
  accountId: trOneId,
  cookie: "tr_session=abc",
  csrf: "csrf-token",
  userId: "u-1",
  name: "测试账号",
  obtainedAtMs: Date.now(),
  expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000,
});

const rhythmCredentials = credentialsOf(trOneId);
check(
  "只列推理 Key 一行（会话与登录账号都不列）",
  rhythmCredentials.map((c) => c.id).join(",") === `key:provider:${trOneId}:key`,
  rhythmCredentials.map((c) => `${c.id}:${c.kind}`).join(","),
);
check(
  "推理 Key 不是 missing",
  rhythmCredentials[0]?.status === CredentialState.USABLE,
  String(rhythmCredentials[0]?.status),
);
check(
  "TokenRhythm 的条数与列出来的行数一致",
  listAccounts().find((a) => a.id === trOneId)?.credentialCount === rhythmCredentials.length,
  JSON.stringify({
    count: listAccounts().find((a) => a.id === trOneId)?.credentialCount,
    rows: rhythmCredentials.length,
  }),
);
check(
  "账号列表里看得见这个账号",
  listAccounts().some((a) => a.id === trOneId),
  listAccounts().map((a) => a.id).join(","),
);
check(
  "账号带着平台",
  listAccounts().find((a) => a.id === trOneId)?.platform === "tokenrhythm",
  JSON.stringify(listAccounts().find((a) => a.id === trOneId)),
);

// 第二个账号：同一平台下的另一个登录。它的凭据挂在它自己那一格上，与第一个
// 账号互不串味 —— 账号 id 说不了谁是谁，认人靠 platform 与各自的凭据。
const trTwo = addAccount({ platform: "tokenrhythm", alias: "中转站二号" });
const trTwoId = String(trTwo.id ?? "");
check("第二个账号建出来了", Boolean(trTwoId) && trTwoId !== trOneId, `${trOneId} ${trTwoId}`);
check(
  "两个账号挂在同一个平台上",
  listAccounts().filter((a) => a.platform === "tokenrhythm").length === 2,
  listAccounts().filter((a) => a.platform === "tokenrhythm").map((a) => `${a.id}:${a.platform}`).join(","),
);

// 注销一个账号：它自己那一份凭据全删，另一个账号的不动。
const { logoutAccount } = await import("../lib/admin/accounts.ts");
const { getSecret: readSecret } = await import("../lib/store.ts");
setProviderKeys(trTwoId, ["sk_tr_two"]);
check("它自己的凭据先在", readSecret(`key:provider:${trTwoId}:key`) !== null);

const loggedOut = logoutAccount(trTwoId);
check("注销一个账号", loggedOut.ok === true && loggedOut.removed > 0, JSON.stringify(loggedOut));
check(
  "它自己的凭据删了",
  readSecret(`key:provider:${trTwoId}:key`) === null,
  JSON.stringify(readSecret(`key:provider:${trTwoId}:key`)),
);
check(
  "注销的那个账号名下没有可用凭据了",
  credentialsOf(trTwoId).every((c) => c.status === CredentialState.MISSING),
  JSON.stringify(credentialsOf(trTwoId).map((c) => `${c.id}:${c.status}`)),
);
check(
  "另一个账号的凭据没动，也没串味",
  credentialsOf(trOneId).some((c) => c.kind === "api_key") &&
    credentialsOf(trOneId).every((c) => c.id.includes(trOneId)),
  JSON.stringify(credentialsOf(trOneId).map((c) => c.id)),
);

/* ------------------------------------------------------------------ *
 * 三之二、七牛的凭据挂在账号行上
 * ------------------------------------------------------------------ */
section("七牛云的凭据");

// 七牛云的凭据是两段：推理 Key 与额度 Cookie。两段都要列出来 —— 面板上说
// 「暂无凭据」，而上游层明明是配好的。写入口是面板那条路（两段按位置收）。
const qiniuRow = addAccount({ platform: "qiniu", alias: "测试七牛" });
const qiniuId = String(qiniuRow.id ?? "");
check("七牛账号建出来了", Boolean(qiniuId), qiniuId);
setProviderKeys(qiniuId, ["sk-qiniu-test-key", "portal_cookie=abc"]);

const qiniuCredentials = credentialsOf(qiniuId);
check(
  "推理 key 列出来了",
  qiniuCredentials.some((c) => c.kind === "api_key"),
  qiniuCredentials.map((c) => c.kind).join(","),
);
check(
  "门户 cookie 也列出来了",
  qiniuCredentials.some((c) => c.kind === "cookie"),
  qiniuCredentials.map((c) => c.kind).join(","),
);
const cookieCredential = qiniuCredentials.find((c) => c.kind === "cookie");
check(
  "cookie 是掩码，不是原值",
  Boolean(cookieCredential) && cookieCredential!.masked !== "portal_cookie=abc",
  String(cookieCredential?.masked),
);
check(
  "七牛凭据的条数与列出来的行数一致",
  listAccounts().find((a) => a.id === qiniuId)?.credentialCount === qiniuCredentials.length,
  JSON.stringify({
    count: listAccounts().find((a) => a.id === qiniuId)?.credentialCount,
    rows: qiniuCredentials.length,
  }),
);
const qiniuView = listAccounts().find((a) => a.id === qiniuId);
check(
  "账号不是「暂无凭据」",
  qiniuView !== undefined && qiniuView.status !== CredentialState.MISSING,
  String(qiniuView?.status),
);
check(
  "凭据数不是 0",
  (qiniuView?.credentialCount ?? 0) >= 1,
  String(qiniuView?.credentialCount),
);
/* ------------------------------------------------------------------ *
 * 三之三、通用开放平台的推理 key 就在 :key 那一格上
 * ------------------------------------------------------------------ */
section("开放平台的推理 key");

// 通用开放平台（openai / anthropic）的账号只有一把推理 key，地址存在 key:provider:<账号>:key。
// 那一行点「试一下」以前回「无法识别的凭据」—— 面板上一行看得见、点了必然失败。
const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
insertVendorPlatform("openai", "open-platform-test", { baseUrl: "http://127.0.0.1:1" });
const openRow = addAccount({ platform: "open-platform-test", alias: "测试开放平台" });
const openId = String(openRow.id ?? "");
check("开放平台账号建出来了", Boolean(openId), openId);
writeOpenPlatformKey(openId, "sk-open-platform-test"); // privacy:allow — 编造的样例
const openCredentials = credentialsOf(openId);
const openKeyCredential = openCredentials.find((c) => c.inference);
check(
  "推理 key 的 id 就是 :key 那一格",
  openKeyCredential?.id === `key:provider:${openId}:key`,
  JSON.stringify(openCredentials.map((c) => c.id)),
);
check(
  "解析器认得 :key 那一格",
  parseCredentialId(`key:provider:${openId}:key`)?.form === "api_key",
  JSON.stringify(parseCredentialId(`key:provider:${openId}:key`)),
);

// 面板上的每一条凭据都得能「试一下」「刷新一下」：列得出来却点不动的行
// （id 解析器不认识）就是一行看得见、点了必然失败的按钮。
const unparsable = listAccounts()
  .flatMap((a) => credentialsOf(a.id))
  .filter((c) => parseCredentialId(c.id) === null);
check(
  "面板上每一条凭据的 id 都认得",
  unparsable.length === 0,
  unparsable.map((c) => c.id).join(","),
);

// 已经有了这一行（面板上看得见），点「试一下」就该拿到真实的试法答复。
// 地址指向本机一个关着的端口：问不到上游是意料之中，但那是「问不到」，不是
// 「不认识这条凭据」。正向断言那句答复：只查「不含无法识别」的话，回一句
// 「没有这条凭据」也放得过。
const openTried = await testCredential(`key:provider:${openId}:key`);
check(
  "开放平台的推理 key 试得起来（拿去问了上游的模型清单）",
  openTried.message ===
    "上游没有答模型清单：key 可能不对，也可能是这个平台没有 /models（细节看日志）",
  openTried.message,
);

/* ------------------------------------------------------------------ *
 * 四、用量保留天数是热设置
 * ------------------------------------------------------------------ */

section("用量保留天数");

const { setConfigValue, pendingRestart } = await import("../lib/admin/config.ts");

check("一开始没有待重启的东西", pendingRestart() === false, String(pendingRestart()));
const retention = setConfigValue("USAGE_RETENTION_DAYS", "45");
check("用量保留天数改得掉", retention.ok === true, JSON.stringify(retention));
check(
  "改完不报待重启（它是热设置）",
  pendingRestart() === false,
  String(pendingRestart()),
);
setConfigValue("USAGE_RETENTION_DAYS", "30", true);

/* ------------------------------------------------------------------ *
 * 五、目录按平台分组（不是按账号）
 * ------------------------------------------------------------------ */

section("模型目录按平台分组");

const { catalogGroups } = await import("../lib/admin/upstreams.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { accountsOfPlatform } = await import("../lib/providers.ts");
addAccount({ platform: "qoder", alias: "第一个 Qoder" });
addAccount({ platform: "qoder", alias: "第二个 Qoder" });
const groups = catalogGroups();
const mine = groups.find((g) => g.group === "qoder");
check("目录里有加过账号的平台", Boolean(mine), groups.map((g) => g.group).join(","));
check(
  "它的模型是它的 kind 说的",
  (mine?.models.length ?? 0) > 0,
  String(mine?.models.length ?? 0),
);
check(
  "同一个平台有两个账号也只有一组",
  groups.filter((g) => g.group === "qoder").length === 1,
  groups.map((g) => g.group).join(","),
);
check(
  "没有账号的平台不在目录里",
  !groups.some((g) => g.group === "qoder-cn"),
  groups.map((g) => g.group).join(","),
);

// 目录里的每一组，名字就是平台 id：路径里那一段、发布模型指路都用它。
// 平台有两处数据源（模板与表里的开放平台），两处的 id 都算数。
check(
  "每一组的 group 就是平台 id",
  groups.every((g) => allPlatforms().some((p) => p.id === g.group)),
  groups.map((g) => g.group).join(","),
);
check(
  "组的模型是它自己的 kind 说的那一份",
  groups.every((g) => {
    // 目录是平台的一组：拿它名下随便哪个账号去问 kind 都是同一份。
    const row = accountsOfPlatform(g.group)[0];
    if (!row) return false;
    const kind = kindOf(row.kind);
    if (!kind) return false;
    const expected = kind.models(row);
    return expected.length === g.models.length && expected.every((m, i) => m.id === g.models[i]?.id);
  }),
  groups.map((g) => `${g.group}=${g.models.length}`).join(","),
);

// WorkBuddy 的目录只有一份：注册表读到的就是 workbuddyModelList() 那一份。
addAccount({ platform: "workbuddy-cn", alias: "测试 WorkBuddy" });
const { workbuddyModelList } = await import("../lib/workbuddy/models.ts");
const wbRow = listProviders().find((p) => p.kind === "workbuddy");
const wbKind = wbRow ? kindOf(wbRow.kind) : null;
const wbFromRegistry = wbKind && wbRow ? wbKind.models(wbRow) : [];
const wbLive = workbuddyModelList();
check(
  "注册表读到的 WorkBuddy 目录就是活的那一份",
  wbLive.length > 0 &&
    wbFromRegistry.length === wbLive.length &&
    wbFromRegistry.every((m, i) => m.id === wbLive[i]?.id),
  `${wbFromRegistry.map((m) => m.id).join(",")} vs ${wbLive.map((m) => m.id).join(",")}`,
);

/* ------------------------------------------------------------------ *
 * 六、config-cli 拒绝服务没问过的设置
 * ------------------------------------------------------------------ */

section("config-cli");

function cli(args: string[]): { code: number; out: string } {
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "config-cli.ts", ...args],
    { cwd: ROOT, env: { ...process.env, BUDDY_DATA_DIR: DATA_DIR }, encoding: "utf8" },
  );
  return { code: res.status ?? 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const unknown = cli(["set", "NOT_A_SETTING=1"]);
check("服务没问过的设置不收", unknown.code !== 0, String(unknown.code));
check(
  "错话说清楚了",
  unknown.out.includes("没有问过"),
  unknown.out.trim().slice(0, 120),
);
const unknownClear = cli(["clear", "NOT_A_SETTING"]);
check("清一个服务没问过的设置也不收", unknownClear.code !== 0, String(unknownClear.code));
const known = cli(["set", "HEALTH_CACHE_MS=60000"]);
check("服务问过的设置写得进去", known.code === 0, known.out.trim().slice(0, 120));
cli(["clear", "HEALTH_CACHE_MS"]);

// 面板能改的那三个都在快照里：不在快照里的设置，面板不显示，config-cli
// 也不收。
for (const key of ["REQUIRE_API_KEY", "ADMIN_CORS_ORIGINS", "USAGE_RETENTION_DAYS"]) {
  const set = cli(["set", `${key}=1`]);
  check(`${key} 写得进去`, set.code === 0, set.out.trim().slice(0, 120));
  cli(["clear", key]);
}

/* ------------------------------------------------------------------ *
 * 七、环境里的上游开关没人读了
 * ------------------------------------------------------------------ */

section("环境里的上游开关");

// 子进程里的 import() 要 file:// URL：Windows 上裸的 "D:\..." 会被当成 d: 协议。
// 一个新的进程：环境变量在那时候还在，而上游的开关已经只认数据库了。
const ENV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-admin-env-"));
const envRun = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "-e", `
    const { listProviders } = await import("${pathToFileURL(path.join(ROOT, "lib/providers.ts")).href}");
    const { allPlatforms } = await import("${pathToFileURL(path.join(ROOT, "lib/platforms.ts")).href}");
    const { listOpenPlatforms } = await import("${pathToFileURL(path.join(ROOT, "lib/open-platforms.ts")).href}");
    // 环境里那几个开关还在，但没人读了：一个账号都不该冒出来。
    const rows = listProviders();
    console.log(JSON.stringify({
      platforms: allPlatforms().length,
      platformRows: listOpenPlatforms().length,
      rows: rows.map((r) => [r.id, r.enabled]),
    }));
  `],
  {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: ENV_DIR, MINIMAX_CODE: "1", QODER_GLOBAL: "1" },
    encoding: "utf8",
  },
);
check("带着环境开关起进程没报错", envRun.status === 0, envRun.stderr?.slice(-300) ?? "");
let envRun_body: { platforms: number; platformRows: number; rows: [string, boolean][] } = {
  platforms: 0,
  platformRows: 0,
  rows: [],
};
try {
  envRun_body = JSON.parse(envRun.stdout.trim().split("\n").pop() ?? "{}");
} catch {
  envRun_body = { platforms: 0, platformRows: 0, rows: [] };
}
// 子进程用的是另一个（干净的）库：它看得到的是目录里该播的那几条 —— 厂商那
// 几行是这一节之前造进本进程那个库的，两个库的平台集合本来就不一样。
const SEEDED_ROWS = SIMULATED_CLIENTS.filter((c) => !c.hidden).length;
check(
  "环境里的开关被忽略了（一个账号都没有）",
  envRun_body.platforms === SEEDED_ROWS &&
    envRun_body.platformRows === SEEDED_ROWS &&
    envRun_body.rows.length === 0,
  JSON.stringify(envRun_body),
);
fs.rmSync(ENV_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

// Close the database before removing its directory: on Windows an open
// file cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
