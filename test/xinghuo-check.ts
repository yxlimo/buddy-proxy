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
const { platformOf } = await import("../lib/platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { listAccounts } = await import("../lib/admin/accounts.ts");
const { beginLogin } = await import("../lib/admin/login.ts");
const { xinghuoInferenceKey, xinghuoStatus } = await import("../lib/xinghuo/account.ts");

const PROVIDER = {
  id: "xinghuo-test",
  platform: "xinghuo",
  kind: "xinghuo",
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

const kind = kindOf("xinghuo");
check("种类在", kind !== null, String(kind));
check("名字是讯飞星火", kind?.label === "讯飞星火", String(kind?.label));
check("登录方式是 api_key", kind?.login === "api_key", String(kind?.login));
check("平台在", platformOf("xinghuo") !== null, String(platformOf("xinghuo")));
check(
  "收 single 与 fallback",
  policiesOfKind("xinghuo").join(",") === "single,fallback",
  policiesOfKind("xinghuo").join(","),
);
check(
  "推理地址是星火的那条",
  kind?.baseUrl(PROVIDER) === "https://maas-api.cn-huabei-1.xf-yun.com/v2",
  String(kind?.baseUrl(PROVIDER)),
);

/* ------------------------------------------------------------------ *
 * 模型目录：写死的那一份
 * ------------------------------------------------------------------ */

section("目录");

const models = kind?.models(PROVIDER) ?? [];
check("目录是写死的 1 个", models.length === 1, String(models.length));
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

{
  const result = setProviderKeys("xinghuo", ["k1"]);
  check("写成功了", result.ok, result.message);
  check("写进去一段", result.count === 1, String(result.count));
  check("推理 key 是它", xinghuoInferenceKey("xinghuo") === "k1", xinghuoInferenceKey("xinghuo"));
  check("状态说有 key", String(xinghuoStatus("xinghuo").detail).includes("API key"), String(xinghuoStatus("xinghuo").detail));
}

section("清掉");

{
  const result = setProviderKeys("xinghuo", []);
  check("写成功了", result.ok, result.message);
  check("写进去零段", result.count === 0, String(result.count));
  check("推理 key 是空的", xinghuoInferenceKey("xinghuo") === "", xinghuoInferenceKey("xinghuo"));
  check(
    "状态说没有推理用的 key",
    String(xinghuoStatus("xinghuo").detail).includes("没有推理用的 API key"),
    String(xinghuoStatus("xinghuo").detail),
  );
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
  check("说是有可用的 key", String(row?.detail ?? "").includes("key"), String(row?.detail));
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
  check("说的是不接受", result.message.includes("不接受"), result.message);
  check("一段都没写", result.count === 0, String(result.count));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
