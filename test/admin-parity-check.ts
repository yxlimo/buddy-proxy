// test/admin-parity-check.ts — 面板与路由同一套口径：没有可用凭据。
//
//   node --experimental-strip-types test/admin-parity-check.ts
//
// 离线：一个请求都不发出去。
//
// 造一个平台：账号开着，但只有门户 cookie，没有推理用的 API key（七牛云的两
// 段凭据）。这时面板这一层与判定必须说同一个词：
//
//   判定（lib/admin/platform-state.ts） → no_credential
//   面板的状态（lib/admin/upstreams.ts）  → UPSTREAM_STATE_NO_CREDENTIAL
//   面板的凭据                            → CREDENTIAL_STATE_MISSING
//   面板的平台行（lib/admin/service.ts）  → 没有可用凭据
//   面板的模型层（lib/admin/models.ts）   → UNPUBLISHED_REASON_NO_CREDENTIAL
//
// 然后把 API key 填上：两边同时变成可用。
//
// 另外两种「凭据的事」也要分得清：会话过期了（定时器还没刷好，不是没配好）
// 与凭据读不出来（网关自己的故障）。这两件都跟「没有凭据」不是一回事。
//
// 最后验一遍：九个 kind 的推理凭据由注册表说了算 —— 凭据表里每一段的
// inference 标记都得跟注册表一致。
//
// 另外三种「接不了」也要分得清：没有账号、账号都关着、没有可用凭据 ——
// 要人做的东西不一样，面板得说得出是哪一件。
//
// 为什么先让额度刷新那一轮跑完：面板算东西的时候会看一眼额度快照，快照旧了
// 就在后台刷新一轮，那一轮会去问上游。先让它在没有账号的时候跑完（没有账号
// 就没有上游可问，一个请求都发不出去），之后再造账号 —— 面板再算的时候快照
// 是新的，刷新不会被触发。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** 消息里有 BigInt，JSON.stringify 会被绊倒。 */
function show(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item)) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */

section("准备：额度刷新那一轮先跑完（那时还没有账号）");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-parity-"));
// 数据目录要在导入库模块之前定下来：store 是进程里的单例。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { addAccount, setProviderEnabled } = await import("../lib/providers.ts");
const { writeQiniuAccount } = await import("../lib/qiniu/account.ts");
const { writeXinghuoKey } = await import("../lib/xinghuo/account.ts");
const { setSecret, store } = await import("../lib/store.ts");
const { allKinds } = await import("../lib/provider-kinds.ts");
const { isPlatform } = await import("../lib/platforms.ts");
const { canInfer, credentialsOf, listAccounts } = await import("../lib/admin/accounts.ts");
const { platformAvailability } = await import("../lib/router/availability.ts");
const {
  healthRefreshing,
  healthSnapshot,
  upstreamCredential,
  upstreamState,
} = await import("../lib/admin/upstreams.ts");
const { publishedModels, savePublishedModel } = await import("../lib/admin/models.ts");
const { adminService } = await import("../lib/admin/service.ts");
const {
  CredentialState,
  UnpublishedReason,
  UpstreamState,
} = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

/** 面板的平台行（面板那一层看到的那个平台）。 */
async function platformRow(id: string): Promise<any> {
  const listed = await adminService.listUpstreams!({} as any, {} as any);
  return (listed.upstreams ?? []).find((u: any) => u.id === id);
}

healthSnapshot();
for (let i = 0; i < 300 && healthRefreshing(); i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
check("额度刷新那一轮已经跑完（那时没有账号，没有请求出去）", !healthRefreshing());

/* ------------------------------------------------------------------ *
 * 一、没有账号
 * ------------------------------------------------------------------ */

section("没有账号");

const empty = platformAvailability("xinghuo");
check("判定 → no_account", empty.state === "no_account", empty.state);
check("面板的状态 → NO_CREDENTIAL（枚举里没有「没有账号」这一项）", upstreamState("xinghuo") === UpstreamState.NO_CREDENTIAL, String(upstreamState("xinghuo")));
const emptyRow = await platformRow("xinghuo");
check("面板说得出「没有账号」", String(emptyRow?.stateReason ?? "").includes("还没有账号"), String(emptyRow?.stateReason));
check("面板说这个平台一个账号都没有", emptyRow?.accountCount === 0, String(emptyRow?.accountCount));
check("面板说这个平台没有开着的账号", emptyRow?.hasEnabledAccount === false, String(emptyRow?.hasEnabledAccount));

/* ------------------------------------------------------------------ *
 * 二、开着但没有推理凭据（反证的核心）
 * ------------------------------------------------------------------ */

section("账号开着，但只有门户 cookie，没有推理凭据");

const made = addAccount({ platform: "qiniu", alias: "测试七牛" });
if (!made.ok || !made.id) throw new Error(`加不了七牛云的账号：${made.message}`);
const accountId = String(made.id);
// 只填门户 cookie：额度问得到，推理发不出去 —— 那不是推理凭据。
writeQiniuAccount(accountId, { portalCookie: "pc-test-cookie" });

const judged = platformAvailability("qiniu");
check("判定 → no_credential", judged.state === "no_credential", judged.state);
check("判定说没有能接的账号", judged.usable.length === 0 && judged.serving.length === 0, judged.state);

check("面板的状态 → UPSTREAM_STATE_NO_CREDENTIAL", upstreamState("qiniu") === UpstreamState.NO_CREDENTIAL, String(upstreamState("qiniu")));
const credential = upstreamCredential("qiniu");
check("面板的凭据 → CREDENTIAL_STATE_MISSING", credential.status === CredentialState.MISSING, String(credential.status));
check("面板的凭据说得出没有推理凭据", credential.detail.includes("推理"), credential.detail);
check("面板的凭据不给令牌", credential.fingerprint === "", credential.fingerprint);

const qiniuRow = await platformRow("qiniu");
check("平台行的状态 → UPSTREAM_STATE_NO_CREDENTIAL", qiniuRow?.state === UpstreamState.NO_CREDENTIAL, show(qiniuRow?.state));
check("平台行说「没有可用凭据」", String(qiniuRow?.stateReason ?? "").includes("没有可用凭据"), String(qiniuRow?.stateReason));
check("平台行说去面板上填 key 或者登录", String(qiniuRow?.stateReason ?? "").includes("API Key"), String(qiniuRow?.stateReason));
check("平台行的凭据 → CREDENTIAL_STATE_MISSING", qiniuRow?.credential?.status === CredentialState.MISSING, show(qiniuRow?.credential));
check("平台行说这个平台开着（开关是账号上的事）", qiniuRow?.enabled === true && qiniuRow?.hasEnabledAccount === true, show({ enabled: qiniuRow?.enabled, has: qiniuRow?.hasEnabledAccount }));
check("平台行说名下有一个账号", qiniuRow?.accountCount === 1, String(qiniuRow?.accountCount));

// 模型那一层：目标接不了，而且要说得清是「没有可用凭据」。
savePublishedModel({
  id: "parity-qiniu",
  displayName: "parity-qiniu",
  enabled: true,
  strategy: "single",
  targets: [
    { groupName: "qiniu", upstreamModel: "deepseek/deepseek-v4.1-flash-1017", weight: 10, enabled: true },
  ],
});
const model = publishedModels().find((m) => m.id === "parity-qiniu");
check("模型层 → UNPUBLISHED_REASON_NO_CREDENTIAL", model?.unpublishedReason === UnpublishedReason.NO_CREDENTIAL, String(model?.unpublishedReason));
check("模型层说没有公布", model?.published === false, show(model?.published));
const target = model?.targets?.[0];
check("目标接不了", target?.blocked === true, show(target));
check("目标说得出「没有可用凭据」", String(target?.blockedReason ?? "").includes("没有可用凭据"), String(target?.blockedReason));

/* ------------------------------------------------------------------ *
 * 三、账号都关着
 * ------------------------------------------------------------------ */

section("账号都关着");

setProviderEnabled(accountId, false);
const off = platformAvailability("qiniu");
check("判定 → accounts_off", off.state === "accounts_off", off.state);
check("面板的状态 → UPSTREAM_STATE_DISABLED", upstreamState("qiniu") === UpstreamState.DISABLED, String(upstreamState("qiniu")));
const offRow = await platformRow("qiniu");
check("平台行说得出「账号都关着」", String(offRow?.stateReason ?? "").includes("都关着"), String(offRow?.stateReason));
check("平台行说这个平台没有开着的账号", offRow?.hasEnabledAccount === false, String(offRow?.hasEnabledAccount));
setProviderEnabled(accountId, true);

/* ------------------------------------------------------------------ *
 * 四、填上 API key：两边同时变成可用
 * ------------------------------------------------------------------ */

section("把 API key 填上：两边同时变成可用");

writeQiniuAccount(accountId, { apiKey: "sk-test-key" });

const ready = platformAvailability("qiniu");
check("判定 → ready", ready.state === "ready", ready.state);
check("判定说有一个能接的账号", ready.usable.length === 1, String(ready.usable.length));
check("面板的状态 → UPSTREAM_STATE_READY", upstreamState("qiniu") === UpstreamState.READY, String(upstreamState("qiniu")));
const readyCredential = upstreamCredential("qiniu");
check("面板的凭据 → 有能用的凭据", readyCredential.status === CredentialState.AUTHENTICATED, String(readyCredential.status));
check(
  "填上 key 之后凭据只给前 10 个字符",
  readyCredential.fingerprint.startsWith("sk-test-key".slice(0, 10)) &&
    !readyCredential.fingerprint.includes("sk-test-key"),
  readyCredential.fingerprint,
);
const readyRow = await platformRow("qiniu");
check("平台行的状态 → UPSTREAM_STATE_READY", readyRow?.state === UpstreamState.READY, show(readyRow?.state));
check("平台行没有该说的话", !String(readyRow?.stateReason ?? "").includes("没有可用凭据"), String(readyRow?.stateReason));
const readyModel = publishedModels().find((m) => m.id === "parity-qiniu");
check("模型层 → 公布了", readyModel?.published === true, show(readyModel?.published));
check("目标不再接不了", readyModel?.targets?.[0]?.blocked === false, show(readyModel?.targets?.[0]));

/* ------------------------------------------------------------------ *
 * 五、会话过期：不是「没有凭据」
 * ------------------------------------------------------------------ */

section("会话过期了");

// 会话型平台的推理凭据就是登录会话。会话过期只说明定时器还没刷好 —— 说成
// 「没有凭据」会把人引到「填 API Key」上，而这类平台压根没有 API Key 这一说。
const expiredAccount = addAccount({ platform: "qoder", alias: "会话过期的" });
if (!expiredAccount.ok || !expiredAccount.id) {
  throw new Error(`加不了 Qoder 的账号：${expiredAccount.message}`);
}
const expiredId = String(expiredAccount.id);
setSecret(`session:provider:${expiredId}`, "session", {
  accessToken: "dt-expired-token",
  // 已经过期：定时器还没刷到这一轮。
  expiresAtMs: Date.now() - 60_000,
  generation: 1,
});

const expiredJudged = platformAvailability("qoder");
check("会话过期 → credential_expired", expiredJudged.state === "credential_expired", expiredJudged.state);
check("会话过期 → 说的是过期，不是没有凭据", expiredJudged.advice.includes("过期"), expiredJudged.advice);
check(
  "会话过期 → 没有恢复时刻（等刷新不是定时器能算的事）",
  expiredJudged.untilMs === null,
  String(expiredJudged.untilMs),
);
check("会话过期 → 那个账号接不了", expiredJudged.usable.length === 0, String(expiredJudged.usable.length));
check(
  "面板的状态 → CREDENTIAL_EXPIRED",
  upstreamState("qoder") === UpstreamState.CREDENTIAL_EXPIRED,
  String(upstreamState("qoder")),
);
const expiredRow = await platformRow("qoder");
check(
  "平台行的状态 → CREDENTIAL_EXPIRED",
  expiredRow?.state === UpstreamState.CREDENTIAL_EXPIRED,
  show(expiredRow?.state),
);
check("平台行说得出「过期」", String(expiredRow?.stateReason ?? "").includes("过期"), String(expiredRow?.stateReason));

/* ------------------------------------------------------------------ *
 * 六、九个 kind 的推理凭据：注册表说了算
 * ------------------------------------------------------------------ */

section("九个 kind 的推理凭据");

const kinds = allKinds();
check("注册表里有九个 kind", kinds.length === 9, kinds.map((k) => k.kind).join(","));

for (const kind of kinds) {
  // 注册表说这一类上游的推理凭据是哪一份（inferWith）；判定函数说的必须是同一件
  // 事 —— 凭据的形态（session / api_key）说它自己是不是那一份。
  check(
    `${kind.kind}：会话是不是推理凭据跟注册表一致`,
    canInfer(kind.kind, "session") === (kind.inferWith === "session"),
    kind.inferWith,
  );
  check(
    `${kind.kind}：key 是不是推理凭据跟注册表一致`,
    canInfer(kind.kind, "api_key") === (kind.inferWith === "api_key"),
    kind.inferWith,
  );
  check(`${kind.kind}：登录账号不是推理凭据`, canInfer(kind.kind, "login") === false);
  check(`${kind.kind}：门户 cookie 不是推理凭据`, canInfer(kind.kind, "cookie") === false);
}

// 没登记的 kind（开放平台那种）：一律不是推理凭据 —— 没有登记就没有这一类
// 上游的规矩，猜不得。
check(
  "没登记的 kind 不是推理凭据",
  canInfer("openai", "api_key") === false && canInfer("", "session") === false,
);

/**
 * 给一个账号把凭据配齐（每家的形状不一样）。
 *
 * 配的是**每一段**凭据：会话、登录账号、key、门户 cookie 都配上 —— 这样才
 * 看得出「哪一段才是推理用的那一份」。
 */
function seedCredentials(kind: string, accountId: string): void {
  const session = `session:provider:${accountId}`;
  const account = `key:provider:${accountId}:account`;
  const year = Date.now() + 365 * 24 * 3600 * 1000;
  if (kind === "minimax" || kind === "qoder" || kind === "workbuddy" || kind === "zcode") {
    setSecret(session, "session", { accessToken: "at-test", expiresAtMs: year, generation: 1 });
    return;
  }
  if (kind === "sensenova") {
    setSecret(session, "session", { accessToken: "at-test", expiresAtMs: year, generation: 1 });
    setSecret(account, "account", { user: "tester", apiKey: "sk-sense-test" });
    return;
  }
  if (kind === "intern-ai") {
    setSecret(session, "session", { sites: [{ name: "子站", token: "site-token" }], obtainedAtMs: Date.now() });
    setSecret(account, "account", { discoveryKey: "dk-test" });
    return;
  }
  if (kind === "tokenrhythm") {
    setSecret(account, "account", { account: "tester", password: "pw", apiKey: "sk-tr-test" });
    setSecret(session, "session", {
      cookie: "c=1",
      csrf: "csrf",
      userId: "u",
      name: "n",
      obtainedAtMs: Date.now(),
      expiresAtMs: year,
    });
    return;
  }
  if (kind === "qiniu") {
    writeQiniuAccount(accountId, { apiKey: "sk-qiniu-test", portalCookie: "pc=1" });
    return;
  }
  if (kind === "xinghuo") {
    writeXinghuoKey(accountId, "sk-xinghuo-test");
    return;
  }
}

// 每个 kind 用哪个平台建账号。zcode 没有平台模板（它的 kind 是从平台派生
// 的），所以那一类只能验注册表那一半。
const KIND_PLATFORM: Record<string, string> = {
  minimax: "minimax",
  qoder: "qoder",
  workbuddy: "workbuddy-cn",
  zcode: "",
  sensenova: "sensenova",
  "intern-ai": "intern-ai",
  tokenrhythm: "tokenrhythm",
  qiniu: "qiniu",
  xinghuo: "xinghuo",
};

for (const kind of kinds) {
  const platform = KIND_PLATFORM[kind.kind] ?? "";
  if (!platform) {
    // 这一类还没有平台模板：账号的 kind 是从平台派生的（lib/providers.ts 的
    // toRow），没有平台就没有这一类的账号 —— credentialsOf 的这一支今天造不
    // 出来（注册表那一半上面已经验过：canInfer 与 inferWith 一致）。
    //
    // 这一行不是恒真：哪天这一类有了平台模板，它就会失败，那时该把真正的
    // credentialsOf 断言补上。
    check(
      `${kind.kind}：还没有平台模板（这一类只能验注册表那一半）`,
      !isPlatform(kind.kind),
      `${kind.kind} 现在是平台了：给它补上 credentialsOf 的断言`,
    );
    continue;
  }
  const made = addAccount({ platform, alias: `测试 ${kind.kind}` });
  if (!made.ok || !made.id) {
    check(`${kind.kind}：账号建得起来`, false, made.message);
    continue;
  }
  seedCredentials(kind.kind, String(made.id));
  const rows = credentialsOf(String(made.id));
  const inferred = rows.filter((r) => r.inference).map((r) => r.kind);
  check(
    `${kind.kind}：推理凭据只有 ${kind.inferWith} 那一段`,
    inferred.length === 1 && inferred[0] === kind.inferWith,
    inferred.join(",") || "（一段都没有）",
  );
  check(
    `${kind.kind}：每一段的 inference 都跟注册表一致`,
    rows.every((r) => r.inference === canInfer(kind.kind, r.kind)),
    rows.map((r) => `${r.kind}:${r.inference ? "是" : "否"}`).join(","),
  );
}

/* ------------------------------------------------------------------ *
 * 七、凭据读不出来：不是「平台没配好」
 * ------------------------------------------------------------------ */

section("凭据读不出来");

// 让凭据真的读不出来：把 secrets 表拿走。这是网关自己的故障，不是运维没配好
// —— 判定读到的是异常，它要说的是「读不出来」，不是「没有凭据」。
store().exec("DROP TABLE secrets");

const broken = platformAvailability("qiniu");
check("凭据读不出来 → credential_unknown", broken.state === "credential_unknown", broken.state);
check(
  "读不出来的账号不进 usable（不可验证的账号不该被派发挑中）",
  broken.usable.length === 0,
  String(broken.usable.length),
);
check("读不出来的账号仍算名下有账号", broken.serving.length > 0, String(broken.serving.length));
check("说的是「凭据读不出来」", broken.advice.includes("读不出来"), broken.advice);
check(
  "没有恢复时刻（读不出来不是定时器能算的事）",
  broken.untilMs === null,
  String(broken.untilMs),
);
const authLogText = fs.existsSync(path.join(DATA_DIR, "auth.log"))
  ? fs.readFileSync(path.join(DATA_DIR, "auth.log"), "utf8")
  : "";
check("读凭据失败落了 auth.log", authLogText.includes("的凭据失败"), authLogText.slice(-160));

// 账号那一层：一个账号的凭据读不出来，不能让整页挂掉。
//
// 面板的账号表是 listAccounts 算出来的：它一抛，ListUpstreams 与 ListAccounts
// 一起挂，面板上连「凭据读不出来」那一格都看不到。
const accounts = listAccounts();
check("凭据读不出来时账号列表照样列得出来", accounts.length > 0, String(accounts.length));
const brokenAccount = accounts.find((a) => a.id === accountId);
check("读不出来的账号没有被丢掉", Boolean(brokenAccount), "账号不见了");
check(
  "读不出来的账号标成不可用（error，不是「没有凭据」）",
  brokenAccount?.status === CredentialState.ERROR,
  String(brokenAccount?.status),
);
check(
  "读不出来的账号说得出「凭据读不出来」",
  String(brokenAccount?.detail ?? "").includes("凭据读不出来"),
  String(brokenAccount?.detail),
);

// 面板的平台行也要列得出来：它走的是同一条路。
let brokenRow: any = null;
let brokenRowError: any = null;
try {
  brokenRow = await platformRow("qiniu");
} catch (e) {
  brokenRowError = e;
}
check(
  "凭据读不出来时面板的上游行照样列得出来",
  brokenRow !== null,
  String(brokenRowError?.message ?? ""),
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
