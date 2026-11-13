// test/platform-delete-residue-check.ts — 删平台之后，这个平台 id 名下不留东西。
//
//   node --experimental-strip-types test/platform-delete-residue-check.ts
//
// 离线：临时数据目录，不发真请求，不碰真凭据。
//
// 这里的判据只有一条：平台没了，它名下那些「按平台 id 记着的东西」也一起没了。
// 平台被删掉，同一个 id 又被建回来是常事（换个地址重建、面板重建），那时候新
// 平台不该凭空继承旧平台的人工设置 —— 用户从没为这个新平台填过任何东西。
//
// 查的是：
//
//   1. 人工写的模型元数据（platform_model_override）：写一条 → 删平台 → 没了；
//      同 id 重建 → 读回来是空的
//   2. 别的平台的不受影响（别把别人的东西一起删了）
//   3. 平台策略（platform_policy）：删平台 → 那一行没了
//   4. 账号与凭据：删平台 → 账号行、凭据、冷却都没了（这是既有行为，这里钉住）
//   5. 上游会话映射（session_map）：删平台 → 那一行没了
//   6. 幂等：删一个不存在的平台 → 说没有，不是崩；清一个没有行的平台 → 不报错
//
// 用不到的东西一律留着：请求日志与用量统计（usage_event / aggregate_*）——
// 「删干净」指的是旧位置上的记录，不是统计。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-delete-residue-"));
process.env.BUDDY_DATA_DIR = tmp;

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

function section(name: string): void {
  console.log("");
  console.log(name);
}

const { adminService } = await import("../lib/admin/service.ts");
const { store } = await import("../lib/store.ts");
const { createOpenPlatform, openPlatformOf } = await import("../lib/open-platforms.ts");
const { listModelOverrides, upsertModelOverrides } = await import("../lib/model-overrides.ts");
const { setPlatformPolicy } = await import("../lib/platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { upstreamSessionId } = await import("../lib/upstream-session.ts");
const { ConnectError } = await import("@connectrpc/connect");

const svc = adminService as any;

/** 这个平台名下的行有几条。 */
function overridesOf(platformId: string): number {
  return Number(
    (store()
      .prepare("SELECT COUNT(*) AS n FROM platform_model_override WHERE platform_id = ?")
      .get(platformId) as any)?.n ?? 0,
  );
}

function policyOf(platformId: string): number {
  return Number(
    (store().prepare("SELECT COUNT(*) AS n FROM platform_policy WHERE platform = ?").get(platformId) as any)?.n ?? 0,
  );
}

function sessionsOf(upstream: string): number {
  return Number(
    (store().prepare("SELECT COUNT(*) AS n FROM session_map WHERE upstream = ?").get(upstream) as any)?.n ?? 0,
  );
}

function providersOf(platform: string): number {
  return Number(
    (store().prepare("SELECT COUNT(*) AS n FROM provider WHERE platform = ?").get(platform) as any)?.n ?? 0,
  );
}

function secretsOf(accountId: string): number {
  const rows = store().prepare("SELECT id FROM secrets").all() as any[];
  return rows.filter((row) => {
    const id = String(row.id);
    return id.startsWith(`key:provider:${accountId}`) || id.startsWith(`session:provider:${accountId}`);
  }).length;
}

async function deletePlatform(id: string): Promise<{ ok: boolean; code: string }> {
  try {
    await svc.deletePlatform({ id }, {});
    return { ok: true, code: "" };
  } catch (e) {
    if (e instanceof ConnectError) {
      const errorCodes = await import("../lib/admin/error-codes.ts");
      return { ok: false, code: String(e.metadata.get(errorCodes.ADMIN_ERROR_HEADER) ?? "") };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * 1. 人工写的模型元数据
 * ------------------------------------------------------------------ */

section("删平台：人工写的模型元数据");

const created = createOpenPlatform({
  id: "residue-demo",
  label: "Residue Demo",
  baseUrl: "https://api.residue.test/v1",
});
check("平台建得起来", created.ok === true, created.message);

const other = createOpenPlatform({
  id: "keep-demo",
  label: "Keep Demo",
  baseUrl: "https://api.keep.test/v1",
});
check("另一个平台建得起来", other.ok === true, other.message);

const written = upsertModelOverrides("residue-demo", [
  { id: "m-1", displayName: "自定义模型", contextWindow: 12345 },
]);
check("人工条目写得进去", written.ok === true, written.message);
check("库里有一行", overridesOf("residue-demo") === 1, String(overridesOf("residue-demo")));
check("读得回来", listModelOverrides("residue-demo").length === 1, String(listModelOverrides("residue-demo").length));

// 别的平台也写一条：删平台不能把别人的一起删了。
const kept = upsertModelOverrides("keep-demo", [{ id: "m-2", displayName: "别人的" }]);
check("另一个平台的人工条目写得进去", kept.ok === true, kept.message);

// 平台策略也写一行：它是同一类东西（按平台 id 记着）。
const policy = setPlatformPolicy("residue-demo", "fallback");
check("平台策略写得进去", policy.ok === true, policy.message);
check("策略那一行在", policyOf("residue-demo") === 1, String(policyOf("residue-demo")));

// 名下放一个账号与一把凭据：删平台要连它们一起删（既有行为，这里钉住）。
const account = addAccount({ platform: "residue-demo" });
const accountId = account.id ?? "";
check("账号加得起来", account.ok === true && accountId !== "", account.message);
const keyed = setProviderKeys(accountId, ["sk-TESTONLY-res", ""]); // privacy:allow — 编造的样例
check("凭据写进去了", keyed.ok === true, keyed.message);
check("凭据有一行", secretsOf(accountId) === 1, String(secretsOf(accountId)));

// 上游会话映射：平台 id 那一列。
const session = upstreamSessionId("residue-demo", "client-session-1");
check("会话映射写进去了", session !== "" && sessionsOf("residue-demo") === 1, String(sessionsOf("residue-demo")));

/* ------------------------------------------------------------------ *
 * 2. 删平台
 * ------------------------------------------------------------------ */

section("删平台");

const deleted = await deletePlatform("residue-demo");
check("平台删得掉", deleted.ok, deleted.code);

check("平台行没了", openPlatformOf("residue-demo") === null, "还在");
check("人工元数据没了", overridesOf("residue-demo") === 0, String(overridesOf("residue-demo")));
check("策略那一行没了", policyOf("residue-demo") === 0, String(policyOf("residue-demo")));
check("账号没了", providersOf("residue-demo") === 0, String(providersOf("residue-demo")));
check("凭据没了", secretsOf(accountId) === 0, String(secretsOf(accountId)));
check("会话映射没了", sessionsOf("residue-demo") === 0, String(sessionsOf("residue-demo")));

// 别的平台的东西一件都不少。
check("别的平台的人工条目还在", overridesOf("keep-demo") === 1, String(overridesOf("keep-demo")));
check("别的平台的平台行还在", openPlatformOf("keep-demo") !== null, "没了");

// 面板读回来的那份也得是空的：走的是缓存（lib/model-overrides.ts 里那份
// overridesByPlatform），缓存不作废的话库里删了、面板上还看得到。
check("面板读回来是空的", listModelOverrides("residue-demo").length === 0, String(listModelOverrides("residue-demo").length));

/* ------------------------------------------------------------------ *
 * 3. 同 id 重建：不继承旧设置
 * ------------------------------------------------------------------ */

section("同 id 重建");

const rebuilt = createOpenPlatform({
  id: "residue-demo",
  label: "Residue Demo Again",
  baseUrl: "https://api.residue2.test/v1",
});
check("同 id 重建得起来", rebuilt.ok === true, rebuilt.message);
check("重建之后人工条目是空的", listModelOverrides("residue-demo").length === 0, String(listModelOverrides("residue-demo").length));
check("重建之后策略是默认的（表里没有那一行）", policyOf("residue-demo") === 0, String(policyOf("residue-demo")));

// 面板那一层（走的是 admin service 的 listModelOverrides）：读回来也得是空的。
const listed = await svc.listModelOverrides({ platformId: "residue-demo" }, {});
check("面板接口读回来是空的", (listed?.overrides ?? []).length === 0, String((listed?.overrides ?? []).length));

/* ------------------------------------------------------------------ *
 * 4. 幂等
 * ------------------------------------------------------------------ */

section("幂等");

const missing = await deletePlatform("no-such-platform-at-all");
check("删不存在的平台会说不存在（不是崩）", !missing.ok && missing.code === "PLATFORM_NOT_FOUND", missing.code);

// 清一个没有行的平台：不报错，也不该删掉别人的。
const before = overridesOf("keep-demo");
const { forgetPlatformModelOverrides } = await import("../lib/model-overrides.ts");
const forgotten = forgetPlatformModelOverrides("no-such-platform-at-all");
check("清一个没有行的平台不报错", forgotten === 0, String(forgotten));
check("别人的条目没被动", overridesOf("keep-demo") === before, String(overridesOf("keep-demo")));

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log("");
console.log(`通过 ${pass} 条，失败 ${fail} 条`);
if (fail) {
  console.log("");
  for (const problem of problems) console.log(`  FAIL ${problem}`);
  process.exit(1);
}
