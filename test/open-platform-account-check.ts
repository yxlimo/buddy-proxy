// test/open-platform-account-check.ts — 开放平台账号的凭据：存、读、面板视图、清空、删账号。
//
//   node --experimental-strip-types test/open-platform-account-check.ts
//
// 离线：临时数据目录，不发请求，不碰真凭据。
//
// 开放平台（用户自己加的平台）的 kind 登记了（"openai"），所以这里查的不只是
// 凭据这一层，还有它在面板上的样子：
//
//   1. 没填 key：面板上没有凭据行，平台是 no_credential
//   2. 填了 key：读得回来，凭据表里有一条 api_key（掩码与指纹都有），平台是 ready
//   3. 推理标记来自注册表（canInfer）：开放平台的那把 API key 就是推理凭据
//   4. key 前后的空格被去掉
//   5. 清空 key：凭据没了，平台回到 no_credential
//   6. 删账号：凭据一起没了，不留孤儿
//   7. 开放平台走了额度插件时，发来的数组短了：整单不改（推理 key 与插件的那
//      几段都留着）
//
// 平台的 ready 那一档与「推理凭据就是这一条」现在都成立（S2b 登记了 kind），
// 所以这里直接断言它们，不再绕开。

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
const { registerQuotaPlugin } = await import("../lib/quota-plugins.ts");
const { pluginFieldOf } = await import("../lib/quota-plugin-credentials.ts");
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
  check(
    "平台是 ready",
    platformAvailability("acme").state === "ready",
    platformAvailability("acme").state,
  );
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
  check("名字是推理 Key", row?.label === "推理 Key", String(row?.label));
  check("id 是凭据在库里的地址", row?.id === openPlatformKeyId(accountId), String(row?.id));
  check("掩码有值", Boolean(row?.masked), String(row?.masked));
  check("指纹有值", Boolean(row?.fingerprint), String(row?.fingerprint));
  check("状态是能用的", row?.status === CredentialState.USABLE, String(row?.status));

  // 推理标记来自注册表：开放平台的 kind 登记了（"openai"，inferWith 是
  // api_key），所以那把 API key 就是推理凭据。
  const inferable = canInfer(kind, "api_key");
  check("注册表说这一类上游的推理凭据是 key", inferable === true, String(inferable));
  check("这一条是推理凭据", row?.inference === true, String(row?.inference));
  check(
    "推理凭据就是这一条",
    inferenceCredentialOf(accountId)?.id === row?.id,
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

section("三家的推理 key 由用户自己填");

// SenseNova、书生·端砚、TokenRhythm 的 key 都是用户自己贴进来的：网关不替人
// 建一把（平台只把完整值给一次，建出来的那把用户既看不到也换不掉）。
//
// 这里验两件事：
//
//   1. 写了 key 之后，账号上原来那份记录（账号、密码）原样还在 —— 整份覆盖成
//      只有 key 的壳就等于把登录态清了；
//   2. 空串表示清掉那一格（与七牛云、讯飞星火一个意思），清的时候登录态照样
//      在。

const { storedAccount: storedSenseNova } = await import("../lib/sensenova/auth.ts");
const { storedAccount: storedInternAi } = await import("../lib/intern-ai/auth.ts");
const { tokenRhythmCredentialOf, saveTokenRhythmCredential } = await import(
  "../lib/tokenrhythm/accounts.ts"
);
const { setSecret } = await import("../lib/store.ts");
const { providerSecretId } = await import("../lib/credential-ids.ts");

// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("sensenova");
insertVendorPlatform("intern-ai");
insertVendorPlatform("tokenrhythm");

const senseNovaId = addAccount({ platform: "sensenova" }).id ?? "";
const internAiId = addAccount({ platform: "intern-ai" }).id ?? "";
const tokenRhythmId = addAccount({ platform: "tokenrhythm" }).id ?? "";
check(
  "三个账号都加得起来",
  Boolean(senseNovaId) && Boolean(internAiId) && Boolean(tokenRhythmId),
  `${senseNovaId} ${internAiId} ${tokenRhythmId}`,
);

// 先给它们一份「登录过」的记录：除了 key 之外的那些东西。
setSecret(providerSecretId(senseNovaId, "account"), "account", {
  user: "someone",
  password: "pw-sense",
});
setSecret(providerSecretId(internAiId, "account"), "account", {
  user: "someone",
  password: "pw-intern",
});
saveTokenRhythmCredential(tokenRhythmId, { account: "someone", password: "pw-tr" });

{
  const result = setProviderKeys(senseNovaId, ["sk-sense-1"]);
  check("SenseNova：写成功了", result.ok === true, result.message);
  check("SenseNova：写进去一把", result.count === 1, String(result.count));
  check(
    "SenseNova：文案说写了什么",
    result.message.includes("SenseNova") && result.message.includes("推理 Key"),
    result.message,
  );
  check(
    "SenseNova：key 是刚写的那个",
    storedSenseNova(senseNovaId)?.apiKey === "sk-sense-1",
    JSON.stringify(storedSenseNova(senseNovaId)),
  );
  check(
    "SenseNova：账号还在（没把登录态清了）",
    storedSenseNova(senseNovaId)?.user === "someone",
    JSON.stringify(storedSenseNova(senseNovaId)),
  );
  check(
    "SenseNova：密码还在（没把登录态清了）",
    storedSenseNova(senseNovaId)?.password === "pw-sense",
    JSON.stringify(storedSenseNova(senseNovaId)),
  );

  const cleared = setProviderKeys(senseNovaId, [""]);
  check("SenseNova：空串清掉了", cleared.count === 0, String(cleared.count));
  check(
    "SenseNova：key 没了",
    !storedSenseNova(senseNovaId)?.apiKey,
    JSON.stringify(storedSenseNova(senseNovaId)),
  );
  check(
    "SenseNova：清 key 的时候账号还在",
    storedSenseNova(senseNovaId)?.user === "someone",
    JSON.stringify(storedSenseNova(senseNovaId)),
  );
  check(
    "SenseNova：清 key 的时候密码还在",
    storedSenseNova(senseNovaId)?.password === "pw-sense",
    JSON.stringify(storedSenseNova(senseNovaId)),
  );
}

{
  const result = setProviderKeys(internAiId, ["sk-disc-1"]);
  check("书生·端砚：写成功了", result.ok === true, result.message);
  check("书生·端砚：写进去一把", result.count === 1, String(result.count));
  check(
    "书生·端砚：位置 0 是 Discovery 的",
    storedInternAi(internAiId)?.discoveryKey === "sk-disc-1",
    JSON.stringify(storedInternAi(internAiId)),
  );
  check(
    "书生·端砚：账号还在（没把登录态清了）",
    storedInternAi(internAiId)?.user === "someone",
    JSON.stringify(storedInternAi(internAiId)),
  );
  check(
    "书生·端砚：密码还在（没把登录态清了）",
    storedInternAi(internAiId)?.password === "pw-intern",
    JSON.stringify(storedInternAi(internAiId)),
  );

  // 空串表示清掉它，不算错。
  const cleared = setProviderKeys(internAiId, [""]);
  check("书生·端砚：清掉了", cleared.count === 0, String(cleared.count));
  check(
    "书生·端砚：key 没了",
    !storedInternAi(internAiId)?.discoveryKey,
    JSON.stringify(storedInternAi(internAiId)),
  );
  check(
    "书生·端砚：清 key 的时候账号还在",
    storedInternAi(internAiId)?.user === "someone",
    JSON.stringify(storedInternAi(internAiId)),
  );
  check(
    "书生·端砚：清 key 的时候密码还在",
    storedInternAi(internAiId)?.password === "pw-intern",
    JSON.stringify(storedInternAi(internAiId)),
  );
}

{
  const result = setProviderKeys(tokenRhythmId, ["sk-tr-1"]);
  check("TokenRhythm：写成功了", result.ok === true, result.message);
  check("TokenRhythm：写进去一把", result.count === 1, String(result.count));
  check(
    "TokenRhythm：文案说写了什么",
    result.message.includes("TokenRhythm") && result.message.includes("推理 Key"),
    result.message,
  );
  check(
    "TokenRhythm：key 是刚写的那个",
    tokenRhythmCredentialOf(tokenRhythmId)?.apiKey === "sk-tr-1",
    JSON.stringify(tokenRhythmCredentialOf(tokenRhythmId)),
  );
  check(
    "TokenRhythm：账号还在（没把登录态清了）",
    tokenRhythmCredentialOf(tokenRhythmId)?.account === "someone",
    JSON.stringify(tokenRhythmCredentialOf(tokenRhythmId)),
  );
  check(
    "TokenRhythm：密码还在（没把登录态清了）",
    tokenRhythmCredentialOf(tokenRhythmId)?.password === "pw-tr",
    JSON.stringify(tokenRhythmCredentialOf(tokenRhythmId)),
  );

  const cleared = setProviderKeys(tokenRhythmId, [""]);
  check("TokenRhythm：空串清掉了", cleared.count === 0, String(cleared.count));
  check(
    "TokenRhythm：key 没了",
    !tokenRhythmCredentialOf(tokenRhythmId)?.apiKey,
    JSON.stringify(tokenRhythmCredentialOf(tokenRhythmId)),
  );
  check(
    "TokenRhythm：清 key 的时候账号还在",
    tokenRhythmCredentialOf(tokenRhythmId)?.account === "someone",
    JSON.stringify(tokenRhythmCredentialOf(tokenRhythmId)),
  );
  check(
    "TokenRhythm：清 key 的时候密码还在",
    tokenRhythmCredentialOf(tokenRhythmId)?.password === "pw-tr",
    JSON.stringify(tokenRhythmCredentialOf(tokenRhythmId)),
  );
}

section("额度插件：发来的数组短了，整单不改");

// 开放平台的凭据是按位置写的：第一把是推理 API key，后面几把按平台所选额度
// 插件的 fields 顺序。所以调用方发来的数组必须够长 —— 短了说明它不知道这个
// 插件要几段（面板的插件登记表没到手时就是这样）。按位置写下去，缺的那几段
// 会被当成空串清掉：那是静默丢凭据。
//
// 这里用一个两段字段的额度插件（测试自己登记的，代码里没有这个插件）。

registerQuotaPlugin({
  id: "qiniu-portal",
  label: "门户额度",
  fields: [
    { name: "portal_account", label: "门户账号", secret: true },
    { name: "portal_cookie", label: "门户 cookie", secret: true },
  ],
  fetch: async () => null,
  quotas: () => [],
});

const portalPlatform = createOpenPlatform({
  id: "portal-demo",
  label: "Portal Demo",
  baseUrl: "https://api.portal-demo.test/v1",
  quotaPlugin: "qiniu-portal",
});
check("带插件的开放平台建得起来", portalPlatform.ok === true, portalPlatform.message);

const portalAccountId = addAccount({ platform: "portal-demo" }).id ?? "";
check("账号加得起来", portalAccountId !== "", portalAccountId);

{
  const result = setProviderKeys(portalAccountId, [
    "sk-portal-1",
    "portal-user",
    "portal-cookie-1",
  ]);
  check("三段都写成功了", result.ok === true, result.message);
  check("写进去三段", result.count === 3, String(result.count));
  check(
    "推理 key 读得回来",
    openPlatformKeyOf(portalAccountId)?.apiKey === "sk-portal-1",
    JSON.stringify(openPlatformKeyOf(portalAccountId)),
  );
  check(
    "插件的第一段读得回来",
    pluginFieldOf(portalAccountId, "portal_account") === "portal-user",
    pluginFieldOf(portalAccountId, "portal_account"),
  );
  check(
    "插件的第二段读得回来",
    pluginFieldOf(portalAccountId, "portal_cookie") === "portal-cookie-1",
    pluginFieldOf(portalAccountId, "portal_cookie"),
  );
}

{
  // 只发一段：调用方不知道这个插件要两段。整单不改 —— 推理 key 与插件那两段
  // 都留着原来那些（不是「插件那两段没动」，是「什么都没动」）。
  const result = setProviderKeys(portalAccountId, ["sk-new"]);
  check("短的数组被拒了", result.ok === false, result.message);
  check("一段都没写", result.count === 0, String(result.count));
  check(
    "机器码说的是段数不够，细节里说清要几段、发来几段",
    result.code === "ACCOUNT_KEY_COUNT_SHORT" && result.message.includes("got 1"),
    JSON.stringify(result),
  );
  check("细节里说了没有任何改动", result.message.includes("nothing written"), result.message);
  check(
    "推理 key 还是原来那把",
    openPlatformKeyOf(portalAccountId)?.apiKey === "sk-portal-1",
    JSON.stringify(openPlatformKeyOf(portalAccountId)),
  );
  check(
    "插件的第一段还在",
    pluginFieldOf(portalAccountId, "portal_account") === "portal-user",
    pluginFieldOf(portalAccountId, "portal_account"),
  );
  check(
    "插件的第二段还在",
    pluginFieldOf(portalAccountId, "portal_cookie") === "portal-cookie-1",
    pluginFieldOf(portalAccountId, "portal_cookie"),
  );
}

{
  // 对照组：三段（后两段空）—— 空的那段表示清掉它，这是现有的语义。
  const result = setProviderKeys(portalAccountId, ["sk-new", "", ""]);
  check("三段就写成功了", result.ok === true, result.message);
  check("只写进去一把（两段是清掉的）", result.count === 1, String(result.count));
  check(
    "推理 key 换了",
    openPlatformKeyOf(portalAccountId)?.apiKey === "sk-new",
    JSON.stringify(openPlatformKeyOf(portalAccountId)),
  );
  check(
    "插件的第一段清掉了",
    pluginFieldOf(portalAccountId, "portal_account") === "",
    pluginFieldOf(portalAccountId, "portal_account"),
  );
  check(
    "插件的第二段清掉了",
    pluginFieldOf(portalAccountId, "portal_cookie") === "",
    pluginFieldOf(portalAccountId, "portal_cookie"),
  );
}

section("控制组：别的平台不收");

{
  const result = setProviderKeys("zcode", ["x"]);
  check("被拒了", result.ok === false, result.message);
  check("机器码说的是没有这个账号", result.code === "ACCOUNT_NOT_FOUND", JSON.stringify(result));
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
