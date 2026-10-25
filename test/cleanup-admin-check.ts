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

const { ensureBuiltinProviders, listProviders, addProvider } = await import("../lib/providers.ts");
ensureBuiltinProviders();

const builtIn = listProviders();
check(
  "九个内置上游都在",
  builtIn.length === 9,
  builtIn.map((p) => p.id).join(","),
);
check(
  "内置上游默认全是关的",
  builtIn.every((p) => !p.enabled),
  builtIn.filter((p) => p.enabled).map((p) => p.id).join(",") || "（没有开着的）",
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
  ["session:provider:tokenrhythm:tenant-2", "session", 2],
  ["key:provider:minimax:plan", "plan_key", null],
  ["key:provider:minimax-api:key-1", "api_key", 1],
  ["key:provider:sensenova:account", "login", null],
  ["key:provider:intern-ai:account", "login", null],
  ["key:provider:tokenrhythm:tenant-3", "login", 3],
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
  parseCredentialId("session:minimax") === null && parseCredentialId("account:tokenrhythm:1") === null,
  JSON.stringify(parseCredentialId("session:minimax")),
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

addProvider({ id: "sensenova-cleanup", kind: "sensenova", alias: "测试 SenseNova" });
writeSecret("key:provider:sensenova-cleanup:account", "account", {
  user: "one@example.com",
  password: "",
  apiKey: "sk-sense-test",
});
const loginTried = await testCredential("key:provider:sensenova-cleanup:account");
check(
  "登录凭据说的是登录账号",
  loginTried.message.includes("登录账号") && !loginTried.message.includes("推理 key"),
  loginTried.message,
);
const apiKeyTried = await testCredential("key:provider:sensenova-cleanup:account#api_key");
check(
  "推理 key 说的是推理 key",
  apiKeyTried.message.includes("推理 key"),
  apiKeyTried.message,
);

/* ------------------------------------------------------------------ *
 * 三、TokenRhythm 的会话是一张表
 * ------------------------------------------------------------------ */

section("TokenRhythm 的会话");

const { setSecret } = await import("../lib/store.ts");
const { credentialsOf, listAccounts } = await import("../lib/admin/accounts.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

addProvider({ id: "tr-cleanup", kind: "tokenrhythm", alias: "测试中转站" });
setSecret("key:provider:tr-cleanup:tenant-1", "account", {
  account: "one@example.com",
  password: "pw-one",
  apiKey: "sk_tr_one",
});
setSecret("session:provider:tr-cleanup", "session", {
  "1": {
    index: 1,
    providerId: "tr-cleanup",
    cookie: "tr_session=abc",
    csrf: "csrf-token",
    userId: "u-1",
    name: "测试账号",
    obtainedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30 * 24 * 3600 * 1000,
  },
});

const rhythmCredentials = credentialsOf("tr-cleanup:1");
const sessionCredential = rhythmCredentials.find((c) => c.kind === "session");
check("会话凭据列出来了", Boolean(sessionCredential), JSON.stringify(rhythmCredentials));
check(
  "会话凭据不是 missing",
  sessionCredential?.status === CredentialState.USABLE,
  String(sessionCredential?.status),
);
check(
  "会话凭据的 id 是按租户拼的",
  sessionCredential?.id === "session:provider:tr-cleanup:tenant-1",
  String(sessionCredential?.id),
);
check(
  "登录账号与推理 key 也列出来了",
  rhythmCredentials.some((c) => c.kind === "login") && rhythmCredentials.some((c) => c.kind === "api_key"),
  rhythmCredentials.map((c) => c.kind).join(","),
);
check(
  "账号列表里看得见这个租户",
  listAccounts().some((a) => a.id === "tr-cleanup:1"),
  listAccounts().map((a) => a.id).join(","),
);

// 注销一个租户：只删那一个租户的，别把别的租户一起删了。
const { logoutAccount } = await import("../lib/admin/accounts.ts");
const loggedOut = logoutAccount("tr-cleanup:1");
check("注销一个租户", loggedOut.ok === true && loggedOut.removed > 0, JSON.stringify(loggedOut));
check(
  "那个租户的登录账号没了",
  !credentialsOf("tr-cleanup:1").some((c) => c.kind === "login" || c.kind === "api_key"),
  JSON.stringify(credentialsOf("tr-cleanup:1")),
);
check(
  "那个租户的会话没了（不再是 usable）",
  credentialsOf("tr-cleanup:1").every((c) => c.kind !== "session" || c.status === CredentialState.MISSING),
  JSON.stringify(credentialsOf("tr-cleanup:1")),
);

// 内置的那个中转站：旧的那一份（account:tokenrhythm:<n>）也要删掉。
// 不删它，注销的租户下一次列账号就回来了 —— 读账号的那一步会回落读旧 id。
setSecret("key:provider:tokenrhythm:tenant-2", "account", {
  account: "two@example.com",
  password: "pw-two",
  apiKey: "sk_tr_two",
});
setSecret("account:tokenrhythm:2", "account", {
  account: "two@example.com",
  password: "pw-two",
  apiKey: "sk_tr_two",
});
const { getSecret: readSecret } = await import("../lib/store.ts");
check("旧的那一份先在", readSecret("account:tokenrhythm:2") !== null);
const loggedOutBuiltIn = logoutAccount("tokenrhythm:2");
check("注销内置中转站的一个租户", loggedOutBuiltIn.ok === true, JSON.stringify(loggedOutBuiltIn));
check(
  "旧的那一份也删了（不然账号会回来）",
  readSecret("account:tokenrhythm:2") === null,
  JSON.stringify(readSecret("account:tokenrhythm:2")),
);
check(
  "现行的那一份也删了",
  readSecret("key:provider:tokenrhythm:tenant-2") === null,
);

// 环境变量里配着的租户：删掉库里那份它就回来了 —— 消息里要说清楚。
process.env.TOKEN_RHYTHM_3_ACCOUNT = "three@example.com";
process.env.TOKEN_RHYTHM_3_PASSWORD = "pw-three";
setSecret("key:provider:tokenrhythm:tenant-3", "account", {
  account: "three@example.com",
  password: "pw-three",
  apiKey: "sk_tr_three",
});
const loggedOutEnv = logoutAccount("tokenrhythm:3");
check(
  "环境里配着的租户：消息说清楚了它还在",
  loggedOutEnv.message.includes("TOKEN_RHYTHM_3_ACCOUNT"),
  loggedOutEnv.message,
);
delete process.env.TOKEN_RHYTHM_3_ACCOUNT;
delete process.env.TOKEN_RHYTHM_3_PASSWORD;

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
 * 五、用户自己加的 provider 出现在模型目录里
 * ------------------------------------------------------------------ */

section("用户自己加的 provider");

const { catalogGroups } = await import("../lib/admin/upstreams.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
addProvider({ id: "qoder-cleanup", kind: "qoder", alias: "第二个 Qoder" });
const groups = catalogGroups();
const mine = groups.find((g) => g.group === "qoder-cleanup");
check("目录里有用户加的那个", Boolean(mine), groups.map((g) => g.group).join(","));
check(
  "它的模型是它自己的 kind 说的",
  (mine?.models.length ?? 0) > 0,
  String(mine?.models.length ?? 0),
);
check(
  "关着的上游不在目录里",
  !groups.some((g) => g.group === "qoder-cn"),
  groups.map((g) => g.group).join(","),
);

// 目录里的每一组，名字就是那个 provider 的 id：发布模型靠它指路，写错了
// 就指不到人。
check(
  "每一组的 group 就是那个 provider 的 id",
  groups.every((g) => listProviders().some((p) => p.id === g.group)),
  groups.map((g) => g.group).join(","),
);
check(
  "组的模型是它自己的 kind 说的那一份",
  groups.every((g) => {
    const row = listProviders().find((p) => p.id === g.group);
    if (!row) return false;
    const kind = kindOf(row.kind);
    if (!kind) return false;
    const expected = kind.models(row);
    return expected.length === g.models.length && expected.every((m, i) => m.id === g.models[i]?.id);
  }),
  groups.map((g) => `${g.group}=${g.models.length}`).join(","),
);

// WorkBuddy 的目录只有一份：注册表读到的就是 workbuddyModelList() 那一份。
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
    const { ensureBuiltinProviders, listProviders } = await import("${ROOT}/lib/providers.ts");
    ensureBuiltinProviders();
    const rows = listProviders();
    console.log(JSON.stringify(rows.map((r) => [r.id, r.enabled])));
  `],
  {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: ENV_DIR, MINIMAX_CODE: "1", QODER_GLOBAL: "1" },
    encoding: "utf8",
  },
);
check("带着环境开关起进程没报错", envRun.status === 0, envRun.stderr?.slice(-300) ?? "");
let envRows: [string, boolean][] = [];
try {
  envRows = JSON.parse(envRun.stdout.trim().split("\n").pop() ?? "[]");
} catch {
  envRows = [];
}
check(
  "环境里的开关被忽略了（内置上游仍然全关）",
  envRows.length === 9 && envRows.every(([, enabled]) => enabled === false),
  JSON.stringify(envRows),
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
