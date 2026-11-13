// test/qiniu-keys-check.ts — 七牛云的凭据有两段：推理 key 与门户 cookie。
//
//   node --experimental-strip-types test/qiniu-keys-check.ts
//
// 离线：临时数据目录，不碰真凭据，不发任何请求。
//
// 厂商 kind 退场后的形状：平台行是 kind=openai + quota_plugin=qiniu，凭据按
// 迁移后的位置收 —— 推理 key 在 `key:provider:<账号>:key`，门户 cookie 是额度
// 插件声明的那一段（`key:provider:<账号>:account`）。写入口是通用那份声明
// （lib/kinds/shared.ts 的 openPlatformPlan），段数由插件决定。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qiniu-keys-"));
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

const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { credentialsOf } = await import("../lib/admin/accounts.ts");
const { qiniuPortalCookie } = await import("../lib/qiniu/account.ts");
const { openPlatformKeyOf } = await import("../lib/open-platform-credentials.ts");

/** 迁移后推理 key 的位置：开放平台读的那一处。 */
function inferenceKey(accountId: string): string {
  return openPlatformKeyOf(accountId)?.apiKey ?? "";
}

/** 面板上列出的凭据行：label 与顺序。 */
function rows(accountId: string): string[] {
  return credentialsOf(accountId).map((row) => row.label);
}

// 账号行：key 挂在账号名下，所以先有这个账号。
// 平台行带 quota_plugin=qiniu：插件声明了「额度 Cookie」那一段，凭据才是两格。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("qiniu", "qiniu", { quotaPlugin: "qiniu" });

const account = addAccount({ platform: "qiniu" });
const id = account.id ?? "";
check("加好了七牛云的账号", account.ok && id !== "", `${account.message}`);

console.log("");
console.log("段数不够整单不改");

{
  // 段数由插件决定，数组比它短就是调用方不知道要几段 —— 面板的登记表没到手时
  // 就会这样。按位置写下去，缺的那几段会被当成空串清掉（静默丢凭据），所以
  // 整单拒收。
  const result = setProviderKeys(id, ["k1"]);
  check("只给一段被拒", !result.ok, result.message);
  check("一段都没写", result.count === 0, String(result.count));
  check("推理 key 还是空的", inferenceKey(id) === "", inferenceKey(id));
  check("门户 cookie 还是空的", qiniuPortalCookie(id) === "", qiniuPortalCookie(id));
}

console.log("");
console.log("两段都写");

{
  const result = setProviderKeys(id, ["k1", "c=1"]);
  check("写成功了", result.ok, result.message);
  check("写进去两段", result.count === 2, String(result.count));
  check("推理 key 是它", inferenceKey(id) === "k1", inferenceKey(id));
  check("门户 cookie 是它", qiniuPortalCookie(id) === "c=1", qiniuPortalCookie(id));
  check("面板上两行都在，顺序是 key 在前", rows(id).join("|") === "推理 Key|额度 Cookie", rows(id).join("|"));
}

console.log("");
console.log("清掉一段，另一段留着");

{
  // 面板总是发全量：给全段数，不要的那段给空串。
  const result = setProviderKeys(id, ["", "c=1"]);
  check("写成功了", result.ok, result.message);
  check("写进去一段", result.count === 1, String(result.count));
  check("推理 key 是空的", inferenceKey(id) === "", inferenceKey(id));
  check("门户 cookie 是它", qiniuPortalCookie(id) === "c=1", qiniuPortalCookie(id));
  check("面板上额度 Cookie 那行还在（空的推理 key 不列出）", rows(id).join("|") === "额度 Cookie", rows(id).join("|"));
}

console.log("");
console.log("两段都空 → 删掉凭据");

{
  // 段数由插件决定，数组比它短就是调用方不知道要几段 —— 整单不改（防静默丢凭据）。
  const result = setProviderKeys(id, []);
  check("段数不够被拒", !result.ok, result.message);
  check("一段都没写", result.count === 0, String(result.count));
  check("两段原样都在", inferenceKey(id) === "" && qiniuPortalCookie(id) === "c=1", "");
}
{
  const result = setProviderKeys(id, ["", ""]);
  check("两段都给空串才清掉", result.ok && result.count === 0, result.message);
  check("门户 cookie 是空的", qiniuPortalCookie(id) === "", qiniuPortalCookie(id));
}

console.log("");
console.log("别的平台不放开");

{
  const result = setProviderKeys("zcode", ["x"]);
  check("被拒了", !result.ok, result.message);
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
