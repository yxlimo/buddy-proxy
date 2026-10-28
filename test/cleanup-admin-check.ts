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
import { fileURLToPath } from "node:url";
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
const { PLATFORMS } = await import("../lib/platforms.ts");

// 启动不再插行：新装好的服务里一个账号都没有，平台是代码里的模板。
const builtIn = listProviders();
check("新装好的服务里一个账号都没有", builtIn.length === 0, builtIn.map((p) => p.id).join(","));
check(
  "十个平台是模板，不是表里的行",
  PLATFORMS.length === 10 && PLATFORMS.every((p) => typeof p.id === "string"),
  PLATFORMS.map((p) => p.id).join(","),
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
  ["key:provider:minimax:plan", "plan_key", null],
  ["key:provider:minimax-api:key-1", "api_key", 1],
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
writeSecret("key:provider:minimax:plan", "account", { key: "b" });
writeSecret("session:provider:minimax-code-m-plan", "session", { accessToken: "c" });
writeSecret("session:provider:minimax-api", "session", { accessToken: "d" });
writeSecret("key:provider:minimax-api:key-1", "account", { key: "e" });

const dropped = deleteProviderCredentials("minimax");
check("删掉了自己的凭据", dropped === 2, String(dropped));
check("会话没了", getSecret("session:provider:minimax") === null);
check("plan key 没了", getSecret("key:provider:minimax:plan") === null);
check(
  "同前缀的另一个上游还在（M plan）",
  getSecret("session:provider:minimax-code-m-plan") !== null,
);
check(
  "同前缀的另一个上游还在（开放平台）",
  getSecret("session:provider:minimax-api") !== null &&
    getSecret("key:provider:minimax-api:key-1") !== null,
);

/* ------------------------------------------------------------------ *
 * 二之二之二、「试一下」说的要与那一行对得上
 * ------------------------------------------------------------------ */

section("「试一下」说的话");

const { testCredential } = await import("../lib/admin/accounts.ts");

const senseAccount = addAccount({ platform: "sensenova", alias: "测试 SenseNova" });
const senseId = String(senseAccount.id ?? "sensenova");
writeSecret(`key:provider:${senseId}:account`, "account", {
  user: "one@example.com",
  password: "",
  apiKey: "sk-sense-test",
});
const loginTried = await testCredential(`key:provider:${senseId}:account`);
check(
  "登录凭据说的是登录账号",
  loginTried.message.includes("登录账号") && !loginTried.message.includes("推理 key"),
  loginTried.message,
);
const apiKeyTried = await testCredential(`key:provider:${senseId}:account#api_key`);
check(
  "推理 key 说的是推理 key",
  apiKeyTried.message.includes("推理 key"),
  apiKeyTried.message,
);

/* ------------------------------------------------------------------ *
 * 三、TokenRhythm 的凭据挂在账号行上
 * ------------------------------------------------------------------ */

section("TokenRhythm 的凭据");

const { setSecret } = await import("../lib/store.ts");
const { credentialsOf, listAccounts } = await import("../lib/admin/accounts.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

const trOne = addAccount({ platform: "tokenrhythm", alias: "中转站一号" });
const trOneId = String(trOne.id ?? "tokenrhythm");
setSecret(`key:provider:${trOneId}:account`, "account", {
  account: "one@example.com",
  password: "pw-one",
  apiKey: "sk_tr_one",
});
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
const sessionCredential = rhythmCredentials.find((c) => c.kind === "session");
check("会话凭据列出来了", Boolean(sessionCredential), JSON.stringify(rhythmCredentials));
check(
  "会话凭据不是 missing",
  sessionCredential?.status === CredentialState.USABLE,
  String(sessionCredential?.status),
);
check(
  "会话凭据的 id 就是账号那一格",
  sessionCredential?.id === `session:provider:${trOneId}`,
  String(sessionCredential?.id),
);
check(
  "登录账号与推理 key 也列出来了",
  rhythmCredentials.some((c) => c.kind === "login") && rhythmCredentials.some((c) => c.kind === "api_key"),
  rhythmCredentials.map((c) => c.kind).join(","),
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

// 第二个账号：旧库里的那一份（按序号存的）要落在这个账号行上。
const trTwo = addAccount({ platform: "tokenrhythm", alias: "中转站二号" });
const trTwoId = String(trTwo.id ?? "tokenrhythm-2");
check("第二个账号的 id 是接序号起的", trTwoId === "tokenrhythm-2", trTwoId);

// 注销一个账号：它的凭据全删，旧库里那一份也删 —— 不删它，下一次读又搬回来。
const { logoutAccount } = await import("../lib/admin/accounts.ts");
const { getSecret: readSecret } = await import("../lib/store.ts");
setSecret("account:tokenrhythm:2", "account", {
  account: "two@example.com",
  password: "pw-two",
  apiKey: "sk_tr_two",
});
setSecret("key:provider:tokenrhythm:tenant-2", "account", {
  account: "two@example.com",
  password: "pw-two",
  apiKey: "sk_tr_two",
});
check("旧的那一份先在", readSecret("account:tokenrhythm:2") !== null);

const loggedOut = logoutAccount(trTwoId);
check("注销一个账号", loggedOut.ok === true && loggedOut.removed > 0, JSON.stringify(loggedOut));
check(
  "旧的那一份也删了（不然账号会回来）",
  readSecret("account:tokenrhythm:2") === null,
  JSON.stringify(readSecret("account:tokenrhythm:2")),
);
check(
  "更早的那一份也删了",
  readSecret("key:provider:tokenrhythm:tenant-2") === null,
  JSON.stringify(readSecret("key:provider:tokenrhythm:tenant-2")),
);
check(
  "别的账号的凭据没动",
  credentialsOf(trOneId).some((c) => c.kind === "login"),
  JSON.stringify(credentialsOf(trOneId).map((c) => c.kind)),
);

/* ------------------------------------------------------------------ *
 * 三之二、七牛的凭据挂在账号行上
 * ------------------------------------------------------------------ */
section("七牛云的凭据");

// 七牛云的凭据是两段：推理 key 与门户 cookie（额度只认 cookie）。两段都要
// 列出来 —— 面板上说「暂无凭据」，而上游层明明是已登录的。
const { writeQiniuAccount } = await import("../lib/qiniu/account.ts");
const qiniuRow = addAccount({ platform: "qiniu", alias: "测试七牛" });
const qiniuId = String(qiniuRow.id ?? "qiniu");
writeQiniuAccount(qiniuId, { apiKey: "sk-qiniu-test-key", portalCookie: "portal_cookie=abc" });

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
check(
  "每一组的 group 就是平台 id",
  groups.every((g) => PLATFORMS.some((p) => p.id === g.group)),
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

// 一个新的进程：环境变量在那时候还在，而上游的开关已经只认数据库了。
const ENV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-admin-env-"));
const envRun = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "-e", `
    const { listProviders } = await import("${ROOT}/lib/providers.ts");
    const { PLATFORMS } = await import("${ROOT}/lib/platforms.ts");
    // 环境里那几个开关还在，但没人读了：一个账号都不该冒出来。
    const rows = listProviders();
    console.log(JSON.stringify({ platforms: PLATFORMS.length, rows: rows.map((r) => [r.id, r.enabled]) }));
  `],
  {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: ENV_DIR, MINIMAX_CODE: "1", QODER_GLOBAL: "1" },
    encoding: "utf8",
  },
);
check("带着环境开关起进程没报错", envRun.status === 0, envRun.stderr?.slice(-300) ?? "");
let envRun_body: { platforms: number; rows: [string, boolean][] } = { platforms: 0, rows: [] };
try {
  envRun_body = JSON.parse(envRun.stdout.trim().split("\n").pop() ?? "{}");
} catch {
  envRun_body = { platforms: 0, rows: [] };
}
check(
  "环境里的开关被忽略了（一个账号都没有）",
  envRun_body.platforms === 10 && envRun_body.rows.length === 0,
  JSON.stringify(envRun_body),
);
fs.rmSync(ENV_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
