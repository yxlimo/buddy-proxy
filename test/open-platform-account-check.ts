// test/open-platform-account-check.ts — 开放平台账号的凭据：存、读、面板视图、清空、删账号。
//
//   node --experimental-strip-types test/open-platform-account-check.ts
//
// 离线：临时数据目录，不发请求，不碰真凭据。
//
// 开放平台（用户自己加的平台）还没有登记的 kind —— 登记是下一个阶段的事。所以
// 这里查的是**凭据这一层**：
//
//   1. 没填 key：面板上没有凭据行，平台是 no_credential
//   2. 填了 key：读得回来，凭据表里有一条 api_key（掩码与指纹都有）
//   3. 推理标记来自注册表（canInfer），不是写死的 true
//   4. key 前后的空格被去掉
//   5. 清空 key：凭据没了，平台回到 no_credential
//   6. 删账号：凭据一起没了，不留孤儿
//
// 平台的 ready 那一档与「推理凭据就是这一条」要等 kind 登记（S2b）：那时
// canInfer 才说 true。所以这里断言的是「跟着注册表走」，而不是把现在这个
// 临时的 false 写死。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-platform-account-"));
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

const { createOpenPlatform } = await import("../lib/open-platforms.ts");
const { addAccount, provider } = await import("../lib/providers.ts");
const { setProviderKeys, openPlatformOfAccount } = await import("../lib/admin/credentials.ts");
const { canInfer, credentialsOf, deleteAccount, inferenceCredentialOf } = await import(
  "../lib/admin/accounts.ts"
);
const { platformAvailability } = await import("../lib/admin/platform-state.ts");
const { openPlatformKeyId, openPlatformKeyOf } = await import("../lib/open-platform-credentials.ts");
const { CredentialState } = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");
const { store } = await import("../lib/store.ts");

section("平台与账号");

const created = createOpenPlatform({
  id: "acme",
  label: "Acme",
  baseUrl: "https://api.acme.test/v1",
});
check("开放平台建得起来", created.ok === true, created.message);

const added = addAccount({ platform: "acme" });
const accountId = added.id ?? "";
check("账号加得起来", added.ok === true && accountId !== "", added.message);
check("这个账号是开放平台的账号", openPlatformOfAccount(accountId) !== null, accountId);

const kind = provider(accountId)?.kind ?? "";
check("账号有 kind（不是空串）", kind !== "", kind);

section("没有填 key");

check("凭据表里没有行", credentialsOf(accountId).length === 0, JSON.stringify(credentialsOf(accountId)));
check("没有推理凭据", inferenceCredentialOf(accountId) === null, JSON.stringify(inferenceCredentialOf(accountId)));
check(
  "平台是 no_credential",
  platformAvailability("acme").state === "no_credential",
  platformAvailability("acme").state,
);

section("填一把 key");

{
  const result = setProviderKeys(accountId, ["sk-acme-1"]);
  check("写成功了", result.ok === true, result.message);
  check("写进去一把", result.count === 1, String(result.count));
  check("文案说的是这个平台", result.message.includes("Acme"), result.message);
  check("读得回来", openPlatformKeyOf(accountId)?.apiKey === "sk-acme-1", JSON.stringify(openPlatformKeyOf(accountId)));
}

{
  // 凭据存在 secrets 表里，id 是那唯一的算法：key:provider:<账号>:key。
  const row = store()
    .prepare("SELECT id FROM secrets WHERE id = ?")
    .get(openPlatformKeyId(accountId)) as { id?: string } | undefined;
  check(
    "凭据存在 secrets 表里，id 是 key:provider:<账号>:key",
    row?.id === `key:provider:${accountId}:key`,
    String(row?.id),
  );
}

{
  const rows = credentialsOf(accountId);
  check("凭据表里有一条", rows.length === 1, JSON.stringify(rows));
  const row = rows[0];
  check("形态是 api_key", row?.kind === "api_key", String(row?.kind));
  check("名字是推理 API key", row?.label === "推理 API key", String(row?.label));
  check("id 是凭据在库里的地址", row?.id === openPlatformKeyId(accountId), String(row?.id));
  check("掩码有值", Boolean(row?.masked), String(row?.masked));
  check("指纹有值", Boolean(row?.fingerprint), String(row?.fingerprint));
  check("状态是能用的", row?.status === CredentialState.USABLE, String(row?.status));

  // 推理标记来自注册表：开放平台的 kind 还没登记（S2b 登记），所以现在
  // canInfer 说 false；登记之后它就是 true。写死 true 的话这条现在就挂 ——
  // 这里要的就是「跟着注册表走」。
  const inferable = canInfer(kind, "api_key");
  check("推理标记跟着注册表走", row?.inference === inferable, `${String(row?.inference)} vs ${String(inferable)}`);
  check(
    "推理凭据与注册表一致",
    (inferenceCredentialOf(accountId)?.id ?? null) === (inferable ? row?.id : null),
    JSON.stringify(inferenceCredentialOf(accountId)?.id ?? null),
  );
}

section("key 前后的空格");

{
  const result = setProviderKeys(accountId, ["  sk-acme-2  "]);
  check("写成功了", result.ok === true, result.message);
  check(
    "空格去掉了",
    openPlatformKeyOf(accountId)?.apiKey === "sk-acme-2",
    JSON.stringify(openPlatformKeyOf(accountId)),
  );
}

section("清空 key");

{
  const result = setProviderKeys(accountId, [""]);
  check("写成功了", result.ok === true, result.message);
  check("写进去零把", result.count === 0, String(result.count));
  check("读不到了", openPlatformKeyOf(accountId) === null, JSON.stringify(openPlatformKeyOf(accountId)));
  check("凭据表里没有行", credentialsOf(accountId).length === 0, JSON.stringify(credentialsOf(accountId)));
  check("没有推理凭据", inferenceCredentialOf(accountId) === null, JSON.stringify(inferenceCredentialOf(accountId)));
  check(
    "平台回到 no_credential",
    platformAvailability("acme").state === "no_credential",
    platformAvailability("acme").state,
  );
  const row = store()
    .prepare("SELECT id FROM secrets WHERE id = ?")
    .get(openPlatformKeyId(accountId)) as { id?: string } | undefined;
  check("secrets 表里那一行没了", row === undefined, String(row?.id));
}

section("再填一次，然后删账号");

{
  const result = setProviderKeys(accountId, ["sk-acme-3"]);
  check("写成功了", result.ok === true, result.message);
  check("读得回来", openPlatformKeyOf(accountId)?.apiKey === "sk-acme-3", JSON.stringify(openPlatformKeyOf(accountId)));

  const deleted = deleteAccount(accountId);
  check("删得掉", deleted.ok === true, deleted.message);
  check("凭据没了", openPlatformKeyOf(accountId) === null, JSON.stringify(openPlatformKeyOf(accountId)));
  check("账号行没了", provider(accountId) === null, accountId);
  const row = store()
    .prepare("SELECT id FROM secrets WHERE id = ?")
    .get(openPlatformKeyId(accountId)) as { id?: string } | undefined;
  check("secrets 表里没有孤儿", row === undefined, String(row?.id));
}

section("控制组：别的平台不收");

{
  const result = setProviderKeys("zcode", ["x"]);
  check("被拒了", result.ok === false, result.message);
  check("说的是不接受", result.message.includes("不接受"), result.message);
  check("一段都没写", result.count === 0, String(result.count));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
