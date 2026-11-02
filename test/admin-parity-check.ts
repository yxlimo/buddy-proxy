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
check("面板的凭据不给令牌", !credential.fingerprint.includes("sk-"), credential.fingerprint);

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
const readyRow = await platformRow("qiniu");
check("平台行的状态 → UPSTREAM_STATE_READY", readyRow?.state === UpstreamState.READY, show(readyRow?.state));
check("平台行没有该说的话", !String(readyRow?.stateReason ?? "").includes("没有可用凭据"), String(readyRow?.stateReason));
const readyModel = publishedModels().find((m) => m.id === "parity-qiniu");
check("模型层 → 公布了", readyModel?.published === true, show(readyModel?.published));
check("目标不再接不了", readyModel?.targets?.[0]?.blocked === false, show(readyModel?.targets?.[0]));

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
