// test/xinghuo-check.ts — 讯飞星火：登记对不对、目录、凭据、面板上的账号。
//
//   node --experimental-strip-types test/xinghuo-check.ts
//
// 离线：临时数据目录，不碰真凭据，不发任何请求（讯飞要真 key，这里没有）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xinghuo-"));
process.env.BUDDY_DATA_DIR = tmp;

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(name);
}

const { kindOf, policiesOfKind } = await import("../lib/provider-kinds.ts");
// 种类登记在注册表里：导入它，种类才都在。
await import("../lib/kinds/index.ts");
const { platformOfAny } = await import("../lib/platforms.ts");
const { syncPlatformModels, openPlatformOf } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { listAccounts } = await import("../lib/admin/accounts.ts");
const { beginLogin } = await import("../lib/admin/login.ts");
const { openPlatformKeyOf } = await import("../lib/open-platform-credentials.ts");

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("xinghuo", "xinghuo");

const PROVIDER = {
  id: "xinghuo-test",
  platform: "xinghuo",
  // 迁移后的形状：厂商 kind 退场，行上就是通用方言 openai。
  kind: "openai",
  region: "",
  alias: "讯飞星火测试账号",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;

/* ------------------------------------------------------------------ *
 * 平台登记
 * ------------------------------------------------------------------ */

section("登记");

// 星火的 kind 已经退场：读目录、凭据这些能力由通用方言那一类接手。
const kind = kindOf("openai");
check("通用方言那一类在", kind !== null, String(kind));
// 星火现在在平台表里（不再在代码里的模板里）：两处数据源合起来才认得它。
check("平台在", platformOfAny("xinghuo") !== null, String(platformOfAny("xinghuo")));
check(
  "收 single 与 fallback",
  policiesOfKind("openai").join(",") === "single,fallback",
  policiesOfKind("openai").join(","),
);
check(
  "行上地址是星火的那条（迁移写进去的那台）",
  openPlatformOf("xinghuo")?.baseUrl === "https://maas-api.cn-huabei-1.xf-yun.com/v2",
  String(openPlatformOf("xinghuo")?.baseUrl),
);

/* ------------------------------------------------------------------ *
 * 模型目录：写死的那一份
 * ------------------------------------------------------------------ */

section("目录");

// 目录是上游那一份：行里写进去什么就公布什么（这里写进去的是上游答的那份）。
check(
  "行里还没有目录：就没什么可公布的",
  (kind?.models(PROVIDER) ?? []).length === 0,
  JSON.stringify((kind?.models(PROVIDER) ?? []).map((m) => m.id)),
);
syncPlatformModels("xinghuo", ["Spark-X2.6"], {});
const models = kind?.models(PROVIDER) ?? [];
check("目录是上游那一份（1 个）", models.length === 1, String(models.length));
check("就是 Spark-X2.6", models[0]?.id === "Spark-X2.6", String(models[0]?.id));
check("每个都有名字", models.every((m) => !!m.displayName), models.map((m) => m.displayName).join(","));
check(
  "平台没报的上下文档位不公布",
  models.every((m) => m.contextWindow === undefined && m.maxOutputTokens === undefined),
  JSON.stringify(models.map((m) => [m.contextWindow, m.maxOutputTokens])),
);

/* ------------------------------------------------------------------ *
 * 凭据：一把 key
 * ------------------------------------------------------------------ */

section("凭据");

/** 迁移后推理 key 的位置：开放平台读的那一处。 */
function inferenceKey(accountId: string): string {
  return openPlatformKeyOf(accountId)?.apiKey ?? "";
}

{
  const result = setProviderKeys("xinghuo", ["k1"]);
  check("写成功了", result.ok, result.message);
  check("写进去一段", result.count === 1, String(result.count));
  check("推理 key 是它（在迁移后的位置）", inferenceKey("xinghuo") === "k1", inferenceKey("xinghuo"));
  // 面板状态那一面在「面板上的账号」那节用真账号验；这里只有一个平台 id，
  // 不查凭据行（面板那层按账号行列）。
}

section("清掉");

{
  const result = setProviderKeys("xinghuo", [""]);
  check("写成功了", result.ok, result.message);
  check("写进去零段", result.count === 0, String(result.count));
  check("推理 key 是空的", inferenceKey("xinghuo") === "", inferenceKey("xinghuo"));
  check("key 真的清掉了", inferenceKey("xinghuo") === "", inferenceKey("xinghuo"));
}

/* ------------------------------------------------------------------ *
 * 面板上看到的账号
 * ------------------------------------------------------------------ */

section("面板上的账号");

const account = addAccount({ platform: "xinghuo" });
const accountId = account.id ?? "";
check("加好了讯飞星火的账号", account.ok && accountId !== "", account.message);

{
  const result = setProviderKeys(accountId, ["k2"]);
  check("key 写进去了", result.ok && result.count === 1, result.message);
  const row = listAccounts().find((a) => a.id === accountId);
  check("账号在列表里", row !== undefined, accountId);
  check("状态不是 missing", row?.status !== "missing", String(row?.status));
  check("说是有可用的推理 Key", row?.detail === "有可用的推理 Key", String(row?.detail));
}

/* ------------------------------------------------------------------ *
 * 登录：开放平台没有登录这一说
 * ------------------------------------------------------------------ */

section("登录");

{
  let ok = true;
  let message = "";
  try {
    await beginLogin("xinghuo");
  } catch (e) {
    ok = false;
    const err = e as { hint?: string; message?: string };
    // 面板上看到的那句话（lib/admin/service.ts 的 loginErrorText 那样拼）。
    message = err.hint || err.message || "";
  }
  check("不开始登录", ok === false, message);
  check("说该用 API Key", message.includes("API Key"), message);
  check("不再说「没有登录的办法」", !message.includes("还没有登录的办法"), message);
}

/* ------------------------------------------------------------------ *
 * 控制组：别的平台不受影响
 * ------------------------------------------------------------------ */

section("控制组");

{
  const result = setProviderKeys("zcode", ["x"]);
  check("ZCode 仍然被拒", !result.ok, result.message);
  check("机器码说的是没有这个账号", result.code === "ACCOUNT_NOT_FOUND", JSON.stringify(result));
  check("一段都没写", result.count === 0, String(result.count));
}

// Close the database before removing its directory: on Windows an open
// file cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
