// test/qiniu-keys-check.ts — 七牛云的凭据有两段：推理 key 与门户 cookie。
//
//   node --experimental-strip-types test/qiniu-keys-check.ts
//
// 离线：临时数据目录，不碰真凭据，不发任何请求。

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
const { qiniuInferenceKey, qiniuPortalCookie, qiniuStatus } = await import("../lib/qiniu/account.ts");

// 账号行：key 挂在账号名下，所以先有这个账号。
const account = addAccount({ platform: "qiniu" });
const id = account.id ?? "";
check("加好了七牛云的账号", account.ok && id !== "", `${account.message}`);

console.log("");
console.log("只写推理 key");

{
  const result = setProviderKeys(id, ["k1"]);
  check("写成功了", result.ok, result.message);
  check("写进去一段", result.count === 1, String(result.count));
  check("推理 key 是它", qiniuInferenceKey(id) === "k1", qiniuInferenceKey(id));
  check("门户 cookie 是空的", qiniuPortalCookie(id) === "", qiniuPortalCookie(id));
  check("状态说有 key 没有 cookie", String(qiniuStatus(id).detail).includes("没有门户 cookie"), String(qiniuStatus(id).detail));
}

console.log("");
console.log("两段都写");

{
  const result = setProviderKeys(id, ["k1", "c=1"]);
  check("写成功了", result.ok, result.message);
  check("写进去两段", result.count === 2, String(result.count));
  check("推理 key 是它", qiniuInferenceKey(id) === "k1", qiniuInferenceKey(id));
  check("门户 cookie 是它", qiniuPortalCookie(id) === "c=1", qiniuPortalCookie(id));
  check("状态说两段都在", String(qiniuStatus(id).detail).includes("都在"), String(qiniuStatus(id).detail));
}

console.log("");
console.log("只写门户 cookie");

{
  const result = setProviderKeys(id, ["", "c=1"]);
  check("写成功了", result.ok, result.message);
  check("写进去一段", result.count === 1, String(result.count));
  check("推理 key 是空的", qiniuInferenceKey(id) === "", qiniuInferenceKey(id));
  check("门户 cookie 是它", qiniuPortalCookie(id) === "c=1", qiniuPortalCookie(id));
  check("状态说只有 cookie", String(qiniuStatus(id).detail).includes("只有门户 cookie"), String(qiniuStatus(id).detail));
}

console.log("");
console.log("两段都空 → 删掉凭据");

{
  const result = setProviderKeys(id, []);
  check("写成功了", result.ok, result.message);
  check("写进去零段", result.count === 0, String(result.count));
  check("推理 key 是空的", qiniuInferenceKey(id) === "", qiniuInferenceKey(id));
  check("门户 cookie 是空的", qiniuPortalCookie(id) === "", qiniuPortalCookie(id));
  check("状态说两段都没有", String(qiniuStatus(id).detail).includes("也没有门户 cookie"), String(qiniuStatus(id).detail));
}

console.log("");
console.log("别的平台不放开");

{
  const result = setProviderKeys("zcode", ["x"]);
  check("被拒了", !result.ok, result.message);
  check("说的是不接受", result.message.includes("不接受"), result.message);
  check("一段都没写", result.count === 0, String(result.count));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
