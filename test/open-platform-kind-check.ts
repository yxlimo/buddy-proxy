// test/open-platform-kind-check.ts — 开放平台（用户自己加的平台）接上以后的样子。
//
//   node --experimental-strip-types test/open-platform-kind-check.ts
//
// 离线：临时数据目录 + 本进程里的假上游，不发真请求，不碰真凭据。
//
// 查的是八件事：
//
//   1. kind 登记了：kindOf("openai") 不是 null，平台的状态是 ready
//   2. 目录公布：/v1/models（根路由）与 /<平台>/v1/models 都列得出目录里的模型
//   3. 转发：POST /<平台>/v1/chat/completions 打到假上游并回 200
//   4. 没有 key：平台是 no_credential、不公布模型、请求被拒并说清是「没凭据」
//   5. 自动拉目录：上游的 /models 答了，目录就被换成上游答的那一份（source=auto）
//   6. 人写死的目录（auto=false）不会被自动拉覆盖
//   7. 拉目录的退避与去重：拉不到之后不再问上游，成功之后失败也不再问，并发只拉一轮
//   8. 手动刷新（force）穿透退避，但不穿透去重
//
// 假上游在本进程里（node:http）：它只答两种路 —— /v1/models 与
// /v1/chat/completions —— 并把自己收到过的请求记下来。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-platform-kind-"));
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

/* ------------------------------------------------------------------ *
 * 假的上游
 * ------------------------------------------------------------------ */

/** 假上游收到过的请求。 */
const seen: {
  method: string;
  path: string;
  authorization: string;
  xApiKey: string;
  anthropicVersion: string;
}[] = [];

/** 假上游的 /models 答什么（换形状就改它）。 */
let modelsPayload: unknown = { data: [{ id: "m-1" }, { id: "m-2" }] };

/** 假上游的 /models 答什么状态码（换形状就改它）。 */
let modelsStatus = 200;

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  seen.push({
    method: req.method ?? "",
    path: url.pathname,
    authorization: String(req.headers.authorization ?? ""),
    xApiKey: String(req.headers["x-api-key"] ?? ""),
    anthropicVersion: String(req.headers["anthropic-version"] ?? ""),
  });
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(modelsStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(modelsPayload));
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        model: "m-1",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as { port: number }).port;
const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

// 13 那一节要看 SenseNova 的目录落到平台行上（目录是问上游要来的）。把它的推理
// 端点指到假上游：一个字都不出机器。必须在 import 各平台模块之前 —— 那几个
// 地址常量是模块求值时读的。
process.env.SENSENOVA_BASE = upstreamBase;

/* ------------------------------------------------------------------ *
 * 网关（本进程里）
 * ------------------------------------------------------------------ */

const { app } = await import("../lib/router/app.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { createOpenPlatform, openPlatformOf, syncPlatformModels, updateOpenPlatform } = await import(
  "../lib/open-platforms.ts"
);
const { platformCategoryOfKind } = await import("../lib/platform-catalog.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { platformAvailability } = await import("../lib/admin/platform-state.ts");
const { refreshOpenPlatformCatalog, openPlatformCatalogRefreshable } = await import(
  "../lib/open-platform-catalog.ts"
);
const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/** 打网关一次，拿到状态码与正文。 */
async function call(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    ...(init?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

/* ------------------------------------------------------------------ *
 * 0. 平台表：厂商那几行不再由代码补
 * ------------------------------------------------------------------ */

section("0. 平台表里的厂商行");

const { store, closeStore } = await import("../lib/store.ts");
const { QINIU_PORTAL_BASE } = await import("../lib/qiniu/config.ts");
// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：后面几节要用的行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");

/**
 * 一个最小的账号行：这几家的 models() 只看 kind（只有开放平台那一类看平台行）。
 *
 * 造它而不是真去加一个账号：这一节查的是目录，加账号会顺带写凭据。
 */
function bareRow(platform: string) {
  return {
    id: "0",
    platform,
    kind: openPlatformOf(platform)?.kind ?? "",
    region: "",
    alias: "",
    enabled: true,
    weight: 0,
    policy: "single" as const,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 表里那一行现在有的目录。 */
function rowIds(platform: string): string[] {
  return openPlatformOf(platform)?.models.items ?? [];
}

/** 代码里那一份目录（kind.models() 报的），用来逐条比。 */
function kindIds(platform: string): string[] {
  const row = bareRow(platform);
  return (kindOf(row.kind)?.models(row) ?? []).map((model) => model.id);
}

/**
 * 直接写一行平台。
 *
 * 不走 createOpenPlatform：它的 kind 要过「能建哪几种」那张选单（只有两种
 * 方言与预置的模拟客户端）。这里要的是「表里有一行 kind=tokenrhythm 的平台」
 * —— 那是代码里的适配器，不是用户在面板上选的类型。
 */
function insertPlatform(id: string, kind: string, baseUrl: string): void {
  const now = Date.now();
  store()
    .prepare(
      "INSERT INTO platform (id, label, base_url, models, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, '', ?, '', ?, ?)",
    )
    .run(id, id, baseUrl, JSON.stringify({ items: [], traits: {}, fetchedAt: 0 }), kind, now, now);
}

// 全新库启动后厂商那几行不在表里：平台行是用户在面板上自己建的，代码这边只
// 提供适配器（那一类怎么说话、默认指哪台）。
const VENDOR_ROWS = ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"];
check(
  "全新库启动后厂商那几行不在表里",
  VENDOR_ROWS.every((id) => openPlatformOf(id) === null),
  VENDOR_ROWS.filter((id) => openPlatformOf(id) !== null).join(","),
);

// 后面几节要用的四行：测试自己造（生产里是用户在面板上建的）。
insertVendorPlatform("qiniu");
insertVendorPlatform("tokenrhythm");
insertVendorPlatform("sensenova");
insertVendorPlatform("intern-ai");
check(
  "造出来的四行厂商平台在表里",
  ["qiniu", "tokenrhythm", "sensenova", "intern-ai"].every((id) => openPlatformOf(id) !== null),
);

// 这几行是方言族：目录从上游拉，建行的时候不预填。代码里没有第二份目录。
for (const id of ["qiniu", "tokenrhythm", "sensenova", "intern-ai"]) {
  check(`${id}：行里的目录是空的`, rowIds(id).length === 0, JSON.stringify(rowIds(id)));
  check(
    `${id}：方言族（目录从上游拉）`,
    platformCategoryOfKind(openPlatformOf(id)?.kind ?? "") === "dialect",
    openPlatformOf(id)?.kind ?? "",
  );
}

// 已有库的行不被任何启动逻辑改写：插一行目录空着的厂商行，重启之后它还是那样
// （以前那一轮播种会把它按来源填一遍）。
insertPlatform("vendor-keep", "qiniu", "https://vendor-keep.test/v1");
const vendorKeepBefore = JSON.stringify(openPlatformOf("vendor-keep"));
closeStore();
store();
check(
  "已有库的行没被启动改写",
  JSON.stringify(openPlatformOf("vendor-keep")) === vendorKeepBefore,
  JSON.stringify(openPlatformOf("vendor-keep")),
);

/* ------------------------------------------------------------------ *
 * 0.1 额度请求打哪台
 * ------------------------------------------------------------------ */

section("0.1 额度请求打哪台");

// 判据是「这一类平台默认指哪台」（适配器自己声明的 defaultBaseUrl）：行上的
// 地址还等于它时，额度问插件自己那台（门户、控制台、钱包）；用户把行指到别处
// 时，跟着行走。
const { quotaEndpointBase } = await import("../lib/quota-plugins.ts");
const qiniuRow = { ...bareRow("qiniu"), platform: "qiniu" };
const qiniuBase = String(openPlatformOf("qiniu")?.baseUrl ?? "");
check(
  "前提：这一类声明的默认地址就是行上的地址",
  kindOf("qiniu")?.defaultBaseUrl === qiniuBase,
  `${kindOf("qiniu")?.defaultBaseUrl} / ${qiniuBase}`,
);
check(
  "行上的地址还是默认那台：额度问插件自己那台",
  quotaEndpointBase(qiniuRow as any, QINIU_PORTAL_BASE) === QINIU_PORTAL_BASE,
  quotaEndpointBase(qiniuRow as any, QINIU_PORTAL_BASE),
);
store()
  .prepare("UPDATE platform SET base_url = ? WHERE id = ?")
  .run("https://self-hosted.test/v1", "qiniu");
check(
  "行上的地址被改成自建端点：额度跟着行走",
  quotaEndpointBase(qiniuRow as any, QINIU_PORTAL_BASE) === "https://self-hosted.test/v1",
  quotaEndpointBase(qiniuRow as any, QINIU_PORTAL_BASE),
);
// 改回去：后面几节还要用这一行。
store().prepare("UPDATE platform SET base_url = ? WHERE id = ?").run(qiniuBase, "qiniu");

/* ------------------------------------------------------------------ *
 * 一个开放平台：一个账号，一把 key，一份手写的目录
 * ------------------------------------------------------------------ */

section("开放平台与账号");

const created = createOpenPlatform({
  id: "acme",
  label: "Acme",
  baseUrl: upstreamBase,
});
check("开放平台建得起来", created.ok === true, created.message);

const added = addAccount({ platform: "acme" });
const accountId = added.id ?? "";
check("账号加得起来", added.ok === true && accountId !== "", added.message);

const keyed = setProviderKeys(accountId, ["sk-acme-1"]);
check("key 写进去了", keyed.ok === true && keyed.count === 1, keyed.message);

// 目录是上游来的：这里直接写进行里（等价于上游答了一次）。
syncPlatformModels("acme", ["m-1"], {});
check(
  "目录写进去了",
  openPlatformOf("acme")?.models.items.join(",") === "m-1",
  JSON.stringify(openPlatformOf("acme")?.models),
);

/* ------------------------------------------------------------------ *
 * 1. kind 登记了
 * ------------------------------------------------------------------ */

section("1. kind 登记了");

const kind = kindOf("openai");
check("kindOf(\"openai\") 不是 null", kind !== null, String(kind));
check("面板上的名字是开放平台", kind?.label === "开放平台（OpenAI 兼容）", String(kind?.label));
check("登录方式是 api_key", kind?.login === "api_key", String(kind?.login));
check("推理凭据是 api_key", kind?.inferWith === "api_key", String(kind?.inferWith));
check("平台在可用性里是 ready", platformAvailability("acme").state === "ready", platformAvailability("acme").state);
check(
  "目录是平台那份（一个模型）",
  platformAvailability("acme").ids.join(",") === "m-1",
  platformAvailability("acme").ids.join(","),
);

/* ------------------------------------------------------------------ *
 * 2. 目录公布
 * ------------------------------------------------------------------ */

section("2. 目录公布");

const prefixed = await call("/acme/v1/models");
check("平台那条路由答 200", prefixed.status === 200, `HTTP ${prefixed.status}`);
check(
  "列得出目录里的模型",
  (prefixed.json?.data ?? []).some((m: any) => m.id === "m-1"),
  JSON.stringify(prefixed.json?.data ?? []),
);

// 根路由公布的是面板里发布的模型：把目录里的那个模型发布出去，它就该出现。
saveAggregateModel({
  id: "m-1",
  displayName: "m-1",
  strategy: "single",
  targets: [{ group: "acme", upstreamModel: "m-1", weight: 1, position: 0, enabled: true }],
});
reloadAggregate();

const root = await call("/v1/models");
check("根路由答 200", root.status === 200, `HTTP ${root.status}`);
check(
  "根路由也列得出它",
  (root.json?.data ?? []).some((m: any) => m.id === "m-1"),
  JSON.stringify(root.json?.data ?? []),
);
const rootOpenai = await call("/v1/models?dialect=openai");
check(
  "OpenAI 形状的根路由也列得出它",
  (rootOpenai.json?.data ?? []).some((m: any) => m.id === "m-1"),
  JSON.stringify(rootOpenai.json?.data ?? []),
);

/* ------------------------------------------------------------------ *
 * 3. 转发
 * ------------------------------------------------------------------ */

section("3. 转发");

seen.length = 0;
const chat = await call("/acme/v1/chat/completions", {
  method: "POST",
  body: { model: "m-1", messages: [{ role: "user", content: "say ok" }] },
});
check("请求答 200", chat.status === 200, `HTTP ${chat.status} ${chat.text.slice(0, 200)}`);
check(
  "假上游收到了推理请求",
  seen.some((s) => s.method === "POST" && s.path.endsWith("/chat/completions")),
  JSON.stringify(seen),
);
check(
  "路径是 /v1/chat/completions",
  seen.some((s) => s.method === "POST" && s.path === "/v1/chat/completions"),
  JSON.stringify(seen.map((s) => s.path)),
);
check(
  "用的是账号上那把 key",
  seen.some((s) => s.authorization === "Bearer sk-acme-1"),
  JSON.stringify(seen.map((s) => s.authorization)),
);
check("答案有内容", Boolean(chat.json?.choices?.[0]?.message?.content), chat.text.slice(0, 200));

/* ------------------------------------------------------------------ *
 * 4. 没有 key
 * ------------------------------------------------------------------ */

section("4. 没有 key");

const cleared = setProviderKeys(accountId, [""]);
check("key 清掉了", cleared.ok === true && cleared.count === 0, cleared.message);
check(
  "平台是 no_credential",
  platformAvailability("acme").state === "no_credential",
  platformAvailability("acme").state,
);

const noKeyModels = await call("/acme/v1/models");
check("平台那条路由还是答 200", noKeyModels.status === 200, `HTTP ${noKeyModels.status}`);
check(
  "但不公布模型",
  (noKeyModels.json?.data ?? []).length === 0,
  JSON.stringify(noKeyModels.json?.data ?? []),
);

seen.length = 0;
const refused = await call("/acme/v1/chat/completions", {
  method: "POST",
  body: { model: "m-1", messages: [{ role: "user", content: "say ok" }] },
});
check("请求被拒", refused.status === 400, `HTTP ${refused.status}`);
check(
  "说的是没有凭据",
  /凭据/.test(String(refused.json?.hint ?? refused.json?.error?.message ?? refused.text)),
  `${refused.status} ${refused.text.slice(0, 200)}`,
);
check(
  "没有打到上游",
  seen.length === 0,
  JSON.stringify(seen),
);

// 把 key 放回去：后面的检查还要用它。
setProviderKeys(accountId, ["sk-acme-1"]);

/* ------------------------------------------------------------------ *
 * 5. 自动拉目录
 * ------------------------------------------------------------------ */

section("5. 自动拉目录");

const autoCreated = createOpenPlatform({
  id: "auto-cat",
  label: "Auto Cat",
  baseUrl: upstreamBase,
});
check("自动目录的平台建得起来", autoCreated.ok === true, autoCreated.message);
check(
  "新加的平台没有目录（建平台不预填）",
  (openPlatformOf("auto-cat")?.models.items ?? []).length === 0,
  JSON.stringify(openPlatformOf("auto-cat")?.models),
);
const autoAccount = addAccount({ platform: "auto-cat" });
check("账号加得起来", autoAccount.ok === true, autoAccount.message);
setProviderKeys(autoAccount.id ?? "", ["sk-auto-1"]);

modelsPayload = { data: [{ id: "m-1" }, { id: "m-2" }] };
seen.length = 0;
const pulled = await refreshOpenPlatformCatalog("auto-cat");
check("拉到了", pulled.ok === true, pulled.message);
check(
  "假上游收到了 /models",
  seen.some((s) => s.method === "GET" && s.path === "/v1/models"),
  JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)),
);
check(
  "目录是上游答的那两个",
  openPlatformOf("auto-cat")?.models.items.join(",") === "m-1,m-2",
  JSON.stringify(openPlatformOf("auto-cat")?.models.items),
);
check("拉的时刻记下来了", Number(openPlatformOf("auto-cat")?.models.fetchedAt ?? 0) > 0, String(openPlatformOf("auto-cat")?.models.fetchedAt));

// 另一种形状：{ models: [{ name }] }。
modelsPayload = { models: [{ name: "x-1" }, { name: "x-2" }] };
const pulled2 = await refreshOpenPlatformCatalog("auto-cat");
check("另一种形状也认", pulled2.ok === true, pulled2.message);
check(
  "目录换成了那一份",
  openPlatformOf("auto-cat")?.models.items.join(",") === "x-1,x-2",
  JSON.stringify(openPlatformOf("auto-cat")?.models.items),
);

// 认不出来的形状：保留原来那份。
modelsPayload = { whatever: [] };
const pulled3 = await refreshOpenPlatformCatalog("auto-cat");
check("认不出来的形状不报成功", pulled3.ok === false, pulled3.message);
check(
  "原来那份目录留着",
  openPlatformOf("auto-cat")?.models.items.join(",") === "x-1,x-2",
  JSON.stringify(openPlatformOf("auto-cat")?.models.items),
);

/* ------------------------------------------------------------------ *
 * 6. 人写死的目录不被覆盖
 * ------------------------------------------------------------------ */

section("6. 目录只有上游那一份");

const manualCreated = createOpenPlatform({
  id: "manual-cat",
  label: "Manual Cat",
  baseUrl: upstreamBase,
});
check("这一行的平台建得起来", manualCreated.ok === true, manualCreated.message);
const manualAccount = addAccount({ platform: "manual-cat" });
setProviderKeys(manualAccount.id ?? "", ["sk-manual-1"]);
// 上一次拉到的目录留在行里。
syncPlatformModels("manual-cat", ["hand-1"], {});
check(
  "上一次拉到的目录在行里",
  openPlatformOf("manual-cat")?.models.items.join(",") === "hand-1",
  JSON.stringify(openPlatformOf("manual-cat")?.models.items),
);

modelsPayload = { data: [{ id: "m-1" }, { id: "m-2" }] };
seen.length = 0;
const manualPull = await refreshOpenPlatformCatalog("manual-cat");
check("拉得到", manualPull.ok === true, manualPull.message);
check(
  "目录换成了上游答的那份",
  openPlatformOf("manual-cat")?.models.items.join(",") === "m-1,m-2",
  JSON.stringify(openPlatformOf("manual-cat")?.models.items),
);
check(
  "问了一次上游",
  modelsHits() === 1,
  JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)),
);

/* ------------------------------------------------------------------ *
 * 7. 拉目录的退避与去重
 * ------------------------------------------------------------------ */

section("7. 拉目录的退避与去重");

/** 假上游被问过几次目录（GET /models）。 */
function modelsHits(): number {
  return seen.filter((s) => s.method === "GET" && s.path.endsWith("/models")).length;
}

// 拉不到目录：上游答 500。
const failCreated = createOpenPlatform({
  id: "cat-fail",
  label: "Cat Fail",
  baseUrl: upstreamBase,
});
check("平台建得起来", failCreated.ok === true, failCreated.message);
const failAccount = addAccount({ platform: "cat-fail" });
setProviderKeys(failAccount.id ?? "", ["sk-fail-1"]);

modelsStatus = 500;
seen.length = 0;
const failFirst = await refreshOpenPlatformCatalog("cat-fail");
check("拉不到时报失败", failFirst.ok === false, failFirst.message);
check("问过一次上游", modelsHits() === 1, String(modelsHits()));
check(
  "目录没变",
  (openPlatformOf("cat-fail")?.models.items ?? []).length === 0,
  JSON.stringify(openPlatformOf("cat-fail")?.models.items),
);

const failSecond = await refreshOpenPlatformCatalog("cat-fail");
check("第二次不再问上游", modelsHits() === 1, String(modelsHits()));
check(
  "第二次说暂不重复查询",
  failSecond.ok === false && failSecond.message.includes("暂不重复查询"),
  failSecond.message,
);

// 成功 → 失败 → 再问一次。
//
// 这条路径以前没被覆盖：成功与失败挨着的时候，退避要分得出「失败在成功之后」
// —— 分不出就多打一次上游。
const backoffCreated = createOpenPlatform({
  id: "cat-backoff",
  label: "Cat Backoff",
  baseUrl: upstreamBase,
});
check("平台建得起来", backoffCreated.ok === true, backoffCreated.message);
const backoffAccount = addAccount({ platform: "cat-backoff" });
setProviderKeys(backoffAccount.id ?? "", ["sk-backoff-1"]);

modelsStatus = 200;
modelsPayload = { data: [{ id: "b-1" }] };
seen.length = 0;
const backoffFirst = await refreshOpenPlatformCatalog("cat-backoff");
check("先拉到一份", backoffFirst.ok === true, backoffFirst.message);
check("问过一次上游", modelsHits() === 1, String(modelsHits()));

modelsStatus = 500;
const backoffFail = await refreshOpenPlatformCatalog("cat-backoff");
check("上游答 500 时报失败", backoffFail.ok === false, backoffFail.message);
check("失败问了一次上游", modelsHits() === 2, String(modelsHits()));

const backoffAgain = await refreshOpenPlatformCatalog("cat-backoff");
check("失败之后不再问上游", modelsHits() === 2, String(modelsHits()));
check(
  "说的是暂不重复查询",
  backoffAgain.ok === false && backoffAgain.message.includes("暂不重复查询"),
  backoffAgain.message,
);
check(
  "原来那份目录留着",
  openPlatformOf("cat-backoff")?.models.items.join(",") === "b-1",
  JSON.stringify(openPlatformOf("cat-backoff")?.models.items),
);

modelsStatus = 200;

// 手动点「刷新模型目录」：那一次要穿透退避。
//
// 退避是给没人看着的调用用的（定时器、启动、/v1/models 上顺手拉）；人点一次是
// 明确的意思，答复「刚刚查询过上游，暂不重复查询」等于让他点了个寂寞。
const forceCreated = createOpenPlatform({
  id: "cat-force",
  label: "Cat Force",
  baseUrl: upstreamBase,
});
check("平台建得起来", forceCreated.ok === true, forceCreated.message);
const forceAccount = addAccount({ platform: "cat-force" });
setProviderKeys(forceAccount.id ?? "", ["sk-force-1"]);

modelsStatus = 500;
seen.length = 0;
const forceFail = await refreshOpenPlatformCatalog("cat-force");
check("第一次拉不到", forceFail.ok === false, forceFail.message);
check("问过一次上游", modelsHits() === 1, String(modelsHits()));

// 不带 force：退避拦下来（后台与请求路径上的调用仍然吃这一层）。
const forceBackoff = await refreshOpenPlatformCatalog("cat-force");
check("不带 force 的第二次不问上游", modelsHits() === 1, String(modelsHits()));
check(
  "不带 force 说的是暂不重复查询",
  forceBackoff.ok === false && forceBackoff.message.includes("暂不重复查询"),
  forceBackoff.message,
);

// 带 force：穿透退避，真去问第二次。
const forceRetry = await refreshOpenPlatformCatalog("cat-force", { force: true });
check("手动刷新穿透退避", modelsHits() === 2, String(modelsHits()));
check("手动刷新拉不到时也报失败", forceRetry.ok === false, forceRetry.message);

// 手动刷新拉到了：照旧记成功并清掉失败状态 —— 之后不带 force 也不被退避拦。
modelsStatus = 200;
modelsPayload = { data: [{ id: "f-1" }] };
const forceOk = await refreshOpenPlatformCatalog("cat-force", { force: true });
check("手动刷新拉到了", forceOk.ok === true, forceOk.message);
check("手动刷新问了上游", modelsHits() === 3, String(modelsHits()));
check(
  "目录换成上游答的那一份",
  openPlatformOf("cat-force")?.models.items.join(",") === "f-1",
  JSON.stringify(openPlatformOf("cat-force")?.models.items),
);
const forceAfterSuccess = await refreshOpenPlatformCatalog("cat-force");
check("成功之后不吃退避", forceAfterSuccess.ok === true, forceAfterSuccess.message);
check("成功之后问上游", modelsHits() === 4, String(modelsHits()));

// 带 force 的并发也只拉一轮：去重不能被 force 改坏。
const forceRaceCreated = createOpenPlatform({
  id: "cat-force-race",
  label: "Cat Force Race",
  baseUrl: upstreamBase,
});
check("平台建得起来", forceRaceCreated.ok === true, forceRaceCreated.message);
const forceRaceAccount = addAccount({ platform: "cat-force-race" });
setProviderKeys(forceRaceAccount.id ?? "", ["sk-force-race-1"]);

modelsStatus = 200;
modelsPayload = { data: [{ id: "fr-1" }] };
seen.length = 0;
const [forceRaceFirst, forceRaceSecond] = await Promise.all([
  refreshOpenPlatformCatalog("cat-force-race", { force: true }),
  refreshOpenPlatformCatalog("cat-force-race", { force: true }),
]);
check("并发两次 force 只问上游一次", modelsHits() === 1, String(modelsHits()));
check(
  "两个都答了",
  forceRaceFirst.ok === true && forceRaceSecond.ok === true,
  `${forceRaceFirst.message} / ${forceRaceSecond.message}`,
);

// 并发：同一个平台只拉一轮。
const raceCreated = createOpenPlatform({
  id: "cat-race",
  label: "Cat Race",
  baseUrl: upstreamBase,
});
check("平台建得起来", raceCreated.ok === true, raceCreated.message);
const raceAccount = addAccount({ platform: "cat-race" });
setProviderKeys(raceAccount.id ?? "", ["sk-race-1"]);

modelsStatus = 200;
modelsPayload = { data: [{ id: "r-1" }] };
seen.length = 0;
const [raceFirst, raceSecond] = await Promise.all([
  refreshOpenPlatformCatalog("cat-race"),
  refreshOpenPlatformCatalog("cat-race"),
]);
check("并发两次只问上游一次", modelsHits() === 1, String(modelsHits()));
check(
  "两个都答了",
  raceFirst.ok === true && raceSecond.ok === true,
  `${raceFirst.message} / ${raceSecond.message}`,
);
check(
  "目录是上游答的那一份",
  openPlatformOf("cat-race")?.models.items.join(",") === "r-1",
  JSON.stringify(openPlatformOf("cat-race")?.models.items),
);

// 没有 key：不去问上游（那是正常状态，不是故障）。
const noKeyCreated = createOpenPlatform({
  id: "cat-nokey",
  label: "Cat No Key",
  baseUrl: upstreamBase,
});
check("平台建得起来", noKeyCreated.ok === true, noKeyCreated.message);
addAccount({ platform: "cat-nokey" });
modelsPayload = { data: [{ id: "m-1" }] };
seen.length = 0;
const noKeyPull = await refreshOpenPlatformCatalog("cat-nokey");
check("没有 key 不报成功", noKeyPull.ok === false, noKeyPull.message);
check(
  "说的是没有 key",
  noKeyPull.message.includes("key"),
  noKeyPull.message,
);
check("没有 key 不问上游", modelsHits() === 0, String(modelsHits()));

/**
 * 三种拉不到的形状：目录留着原来那份。
 *
 * 每个形状一个平台：拉失败之后有退避，同一个平台问不出第二种形状。
 */
async function shapeCase(id: string, label: string, status: number, payload: unknown): Promise<void> {
  const created = createOpenPlatform({ id, label, baseUrl: upstreamBase });
  check(`${label}：平台建得起来`, created.ok === true, created.message);
  const account = addAccount({ platform: id });
  setProviderKeys(account.id ?? "", [`sk-${id}`]);
  // 先成功一次：目录里有一份能用的。
  modelsStatus = 200;
  modelsPayload = { data: [{ id: "keep-1" }] };
  const first = await refreshOpenPlatformCatalog(id);
  check(`${label}：先拉到一份`, first.ok === true, first.message);
  // 再换成拉不到的形状。
  modelsStatus = status;
  modelsPayload = payload;
  const second = await refreshOpenPlatformCatalog(id);
  check(`${label}：不报成功`, second.ok === false, second.message);
  check(
    `${label}：原来那份目录留着`,
    openPlatformOf(id)?.models.items.join(",") === "keep-1",
    JSON.stringify(openPlatformOf(id)?.models.items),
  );
}

await shapeCase("cat-shape-500", "非 2xx", 500, { data: [{ id: "x-1" }] });
await shapeCase("cat-shape-empty", "空清单", 200, { data: [] });
await shapeCase("cat-shape-array", "裸数组", 200, [{ id: "x-1" }]);

// 函数总是 resolve：没有这个平台也是一个答复，不是一个 reject。
const missing = await refreshOpenPlatformCatalog("no-such-platform");
check("没有这个平台也 resolve", missing.ok === false, JSON.stringify(missing));
check(
  "说的是没有这个平台",
  missing.message.includes("没有这个平台"),
  missing.message,
);

/* ------------------------------------------------------------------ *
 * 9. 面板上的额度结论（ListUpstreams 的三格）
 * ------------------------------------------------------------------ */

section("9. 面板上的额度结论");

// 额度这一格有两半：数字（余额/积分/套餐）与结论（状态/恢复时刻/一句话）。
// 问不到数字的账号以前被塞一条数字全 0 的额度 —— 那是在说「额度是 0」。
// 现在只说结论：面板看得见原因，看不见一行零。
const { adminService } = await import("../lib/admin/service.ts");
const { putHealthSnapshot } = await import("../lib/health-cache.ts");

const quotaCreated = createOpenPlatform({
  id: "quota-demo",
  label: "Quota Demo",
  baseUrl: upstreamBase,
  // 插件在这一进程里登记过（kind 注册时一起进来的）：面板读的是平台行这一格。
  quotaPlugin: "sensenova-pools",
});
check("带额度插件的平台建得起来", quotaCreated.ok === true, quotaCreated.message);
const quotaAccount = addAccount({ platform: "quota-demo" });
const quotaAccountId = quotaAccount.id ?? "";
setProviderKeys(quotaAccountId, ["sk-quota-demo"]);
check("账号加得起来", quotaAccount.ok === true && quotaAccountId !== "", quotaAccount.message);

/** 能打印的形状：proto 里有 int64，JSON.stringify 碰到 BigInt 会抛。 */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? Number(v) : v));
}

/** 面板上这个平台的那一行（走 ListUpstreams，不自己拼）。 */
async function upstreamOf(id: string): Promise<any> {
  const listed = await adminService.listUpstreams!();
  return (listed.upstreams ?? []).find((u: any) => u.id === id);
}

const RECOVER_AT = Date.now() + 2 * 60 * 60_000;
putHealthSnapshot({
  plugins: {
    "sensenova-pools": {
      [quotaAccountId]: {
        state: "no_quota",
        views: [],
        recoverAt: RECOVER_AT,
        message: "积分池用完了，等下一周期",
      },
    },
  },
});

const spentUpstream = await upstreamOf("quota-demo");
const spentQuota = spentUpstream?.quota;
check("额度这一格报得出来", Boolean(spentQuota), show(spentUpstream));
check(
  "quota_state 是 no_quota",
  spentQuota?.quotaState === "no_quota",
  show(spentQuota?.quotaState),
);
check(
  "recover_at_ms 是快照里那个时刻",
  Number(spentQuota?.recoverAtMs) === RECOVER_AT,
  `${spentQuota?.recoverAtMs} / ${RECOVER_AT}`,
);
check(
  "message 有那句话",
  typeof spentQuota?.message === "string" && spentQuota.message.includes("用完了"),
  show(spentQuota?.message),
);
check(
  "没有数字：余额、积分、套餐额度都没给（不是 0，是没给）",
  spentQuota?.balance === undefined && spentQuota?.credits === undefined && spentQuota?.tokenPlan === undefined,
  show(spentQuota),
);

// 控制组：同样的路，数字在的时候状态照快照走 —— 上面那条不是写死的。
putHealthSnapshot({
  plugins: {
    "sensenova-pools": {
      [quotaAccountId]: {
        state: "ok",
        views: [
          {
            upstreamId: quotaAccountId,
            accountId: quotaAccountId,
            credits: { total: 100, used: 40, remaining: 60, lots: [], note: "池子剩 60" },
          },
        ],
        recoverAt: null,
        message: "池子剩 60",
      },
    },
  },
});
const okUpstream = await upstreamOf("quota-demo");
const okQuota = okUpstream?.quota;
check("有数字的时候 quota_state 是 ok", okQuota?.quotaState === "ok", show(okQuota?.quotaState));
check(
  "数字照快照里那一份",
  Number(okQuota?.credits?.remaining) === 60,
  show(okQuota?.credits),
);
check(
  "ok 的恢复时刻是 0（不知道）",
  Number(okQuota?.recoverAtMs) === 0,
  String(okQuota?.recoverAtMs),
);

// 没有数字的结论也要到面板。以前只放行 no_quota / blocked，其余几种在面板上
// 一律是一个「—」—— 前端按七种状态写的那一半是死代码。状态与一句话本身就是
// 面板要看的东西，与有没有数字是两件事。
const quietStates = [
  { state: "blocked", recoverAt: RECOVER_AT, message: "账号被停用（access_status 0）" },
  { state: "unauthorized", recoverAt: null, message: "门户拒了这份 cookie（HTTP 401）" },
  { state: "rate_limited", recoverAt: RECOVER_AT, message: "门户限流了（HTTP 429）" },
  { state: "missing", recoverAt: null, message: "账号上没有门户 cookie" },
  { state: "unknown", recoverAt: null, message: "门户没问到：超时" },
] as const;
for (const c of quietStates) {
  putHealthSnapshot({
    plugins: {
      "sensenova-pools": {
        [quotaAccountId]: { state: c.state, views: [], recoverAt: c.recoverAt, message: c.message },
      },
    },
  });
  const quiet = (await upstreamOf("quota-demo"))?.quota;
  check(`${c.state}：额度这一格报了`, Boolean(quiet), show(quiet));
  check(`${c.state}：quota_state 是那个状态`, quiet?.quotaState === c.state, show(quiet?.quotaState));
  check(`${c.state}：message 是插件那句话`, quiet?.message === c.message, show(quiet?.message));
  check(
    `${c.state}：三格数字都没给（不是 0，是没给）`,
    quiet?.balance === undefined && quiet?.credits === undefined && quiet?.tokenPlan === undefined,
    show(quiet),
  );
  check(
    `${c.state}：恢复时刻照快照（没有就是 0）`,
    Number(quiet?.recoverAtMs ?? -1) === (c.recoverAt ?? 0),
    `${quiet?.recoverAtMs} / ${c.recoverAt ?? 0}`,
  );
  // 三处口径一致：账号那一行也是同一个结论。
  const listedAccounts = await adminService.listAccounts!({} as any, {} as any);
  const accountQuota = (listedAccounts.accounts ?? []).find((a: any) => a.id === quotaAccountId)?.quota;
  check(
    `${c.state}：ListAccounts 上也是这个状态与那句话`,
    accountQuota?.quotaState === c.state && accountQuota?.message === c.message,
    show(accountQuota),
  );
  check(
    `${c.state}：ListAccounts 上也没给数字`,
    accountQuota?.balance === undefined && accountQuota?.credits === undefined && accountQuota?.tokenPlan === undefined,
    show(accountQuota),
  );
}

// 控制组：没有结论时就不报这一格 ——「没有结论」不是一种结论。
putHealthSnapshot({ plugins: { "sensenova-pools": {} } });
const noConclusion = await upstreamOf("quota-demo");
check("没有结论就不报这一格", noConclusion?.quota === undefined, show(noConclusion?.quota));

/* ------------------------------------------------------------------ *
 * 10. 拿各家自己的推理 key 去问目录
 * ------------------------------------------------------------------ */

section("10. 拿各家自己的推理 key 去问目录");

const { saveSession: saveTokenRhythmSession } = await import("../lib/tokenrhythm/accounts.ts");

// 中转站：推理 key 与门户会话是两个东西。问目录要带那把 key，不是 cookie。
insertPlatform("relay-demo", "tokenrhythm", upstreamBase);
const relayAccount = addAccount({ platform: "relay-demo" });
const relayAccountId = relayAccount.id ?? "";
check("中转站账号加得起来", relayAccount.ok === true && relayAccountId !== "", relayAccount.message);
const relayKey = setProviderKeys(relayAccountId, ["sk-tr-infer-1"]);
check("中转站的推理 key 写进去了", relayKey.ok === true && relayKey.count === 1, relayKey.message);
// 再给它一份门户会话：cookie 只用来读钱包，不是推理凭据。
saveTokenRhythmSession(
  {
    accountId: relayAccountId,
    cookie: "PORTAL-COOKIE-MUST-NOT-BE-SENT",
    csrf: "csrf-1",
    userId: "u-1",
    name: "relay",
    obtainedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30 * 24 * 60 * 60_000,
  },
  { force: true },
);

modelsStatus = 200;
modelsPayload = { data: [{ id: "tr-1" }, { id: "tr-2" }] };
seen.length = 0;
const relayPull = await refreshOpenPlatformCatalog("relay-demo", { force: true });
check("中转站：拉到了", relayPull.ok === true, relayPull.message);
check("中转站：真的问了上游的 /models", modelsHits() === 1, JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)));
check(
  "中转站：带的是推理 key",
  seen.some((s) => s.authorization === "Bearer sk-tr-infer-1"),
  JSON.stringify(seen.map((s) => s.authorization)),
);
check(
  "中转站：不是门户 cookie",
  !seen.some((s) => s.authorization.includes("PORTAL-COOKIE")),
  JSON.stringify(seen.map((s) => s.authorization)),
);
check(
  "中转站：目录写回了表里",
  openPlatformOf("relay-demo")?.models.items.join(",") === "tr-1,tr-2",
  JSON.stringify(openPlatformOf("relay-demo")?.models),
);

// 七牛云：两段凭据，推理用第一段。
insertPlatform("qiniu-demo", "qiniu", upstreamBase);
const qiniuDemoAccount = addAccount({ platform: "qiniu-demo" });
const qiniuKeyed = setProviderKeys(qiniuDemoAccount.id ?? "", ["sk-qiniu-infer", "PORTAL-COOKIE-QINIU"]);
check("七牛：两段凭据都写进去了", qiniuKeyed.ok === true && qiniuKeyed.count === 2, qiniuKeyed.message);
modelsStatus = 200;
modelsPayload = { data: [{ id: "q-1" }] };
seen.length = 0;
const qiniuPull = await refreshOpenPlatformCatalog("qiniu-demo", { force: true });
check("七牛：拉到了", qiniuPull.ok === true, qiniuPull.message);
check("七牛：真的问了上游的 /models", modelsHits() === 1, JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)));
check(
  "七牛：带的是推理 key",
  seen.some((s) => s.authorization === "Bearer sk-qiniu-infer"),
  JSON.stringify(seen.map((s) => s.authorization)),
);
check(
  "七牛：不是门户 cookie",
  !seen.some((s) => s.authorization.includes("PORTAL-COOKIE-QINIU")),
  JSON.stringify(seen.map((s) => s.authorization)),
);
check("七牛：目录写回了表里", rowIds("qiniu-demo").join(",") === "q-1", JSON.stringify(rowIds("qiniu-demo")));

// 只配了门户 cookie 的七牛账号：不能推理，也就不去问目录。
insertPlatform("cookie-demo", "qiniu", upstreamBase);
const cookieAccount = addAccount({ platform: "cookie-demo" });
setProviderKeys(cookieAccount.id ?? "", ["", "PORTAL-ONLY"]);
seen.length = 0;
const cookiePull = await refreshOpenPlatformCatalog("cookie-demo", { force: true });
check(
  "只有门户 cookie：报没有能用的 API key",
  cookiePull.ok === false && /API key/.test(cookiePull.message),
  cookiePull.message,
);
check("只有门户 cookie：没问上游", seen.length === 0, JSON.stringify(seen));

// 没有 key：报那句话，不问上游。
insertPlatform("nokey-demo", "tokenrhythm", upstreamBase);
addAccount({ platform: "nokey-demo" });
seen.length = 0;
const noKeyPull2 = await refreshOpenPlatformCatalog("nokey-demo", { force: true });
check(
  "没有推理 key：报那句话",
  noKeyPull2.ok === false && /API key/.test(noKeyPull2.message),
  noKeyPull2.message,
);
check("没有推理 key：没问上游", seen.length === 0, JSON.stringify(seen));

// 有 key 但上游 500：保留原来那份目录。
modelsStatus = 500;
modelsPayload = { data: [{ id: "nope" }] };
const relayFail = await refreshOpenPlatformCatalog("relay-demo", { force: true });
check("上游 500：不报成功", relayFail.ok === false, relayFail.message);
check(
  "上游 500：原来那份目录留着",
  openPlatformOf("relay-demo")?.models.items.join(",") === "tr-1,tr-2",
  JSON.stringify(openPlatformOf("relay-demo")?.models),
);
modelsStatus = 200;

/* ------------------------------------------------------------------ *
 * 11. 拉目录的鉴权头跟着方言走
 * ------------------------------------------------------------------ */

section("11. 拉目录的鉴权头跟着方言走");

// Anthropic 兼容的上游不认 `Authorization: Bearer`：问 `/models` 也只用
// `x-api-key` 加版本头。发错了回 401 —— 看着像 key 不对，其实是头不对，
// 目录永远拉不到。
const anthCreated = createOpenPlatform({
  id: "anth-cat",
  label: "Anth Cat",
  baseUrl: upstreamBase,
  kind: "anthropic",
});
check("anthropic 平台建得起来", anthCreated.ok === true, anthCreated.message);
const anthAccount = addAccount({ platform: "anth-cat" });
const anthAccountId = anthAccount.id ?? "";
check("anthropic：账号加得起来", anthAccount.ok === true && anthAccountId !== "", anthAccount.message);
setProviderKeys(anthAccountId, ["sk-anth-1"]);

seen.length = 0;
modelsPayload = { data: [{ id: "a-1" }] };
const anthPull = await refreshOpenPlatformCatalog("anth-cat", { force: true });
check("anthropic：拉到了", anthPull.ok === true, anthPull.message);
const anthModelsHits = seen.filter((s) => s.method === "GET" && s.path.endsWith("/models"));
check("anthropic：问了一次 /models", anthModelsHits.length === 1, JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)));
check(
  "anthropic：带的是 x-api-key",
  anthModelsHits[0]?.xApiKey === "sk-anth-1",
  JSON.stringify(anthModelsHits.map((s) => s.xApiKey)),
);
check(
  "anthropic：带 anthropic-version",
  anthModelsHits[0]?.anthropicVersion === "2023-06-01",
  JSON.stringify(anthModelsHits.map((s) => s.anthropicVersion)),
);
check(
  "anthropic：没有 authorization",
  !anthModelsHits.some((s) => s.authorization !== ""),
  JSON.stringify(anthModelsHits.map((s) => s.authorization)),
);
check(
  "anthropic：目录写回了表里",
  openPlatformOf("anth-cat")?.models.items.join(",") === "a-1",
  JSON.stringify(openPlatformOf("anth-cat")?.models),
);

// 控制组：方言另一侧照旧发 Bearer —— 新加的那一项没有把保底行为改坏。
seen.length = 0;
modelsPayload = { data: [{ id: "o-1" }] };
const openaiPull = await refreshOpenPlatformCatalog("auto-cat", { force: true });
check("openai：拉到了", openaiPull.ok === true, openaiPull.message);
const openaiModelsHits = seen.filter((s) => s.method === "GET" && s.path.endsWith("/models"));
check(
  "openai：带的还是 Bearer",
  openaiModelsHits[0]?.authorization === "Bearer sk-auto-1",
  JSON.stringify(openaiModelsHits.map((s) => s.authorization)),
);
check(
  "openai：没有 x-api-key",
  !openaiModelsHits.some((s) => s.xApiKey !== ""),
  JSON.stringify(openaiModelsHits.map((s) => s.xApiKey)),
);

/* ------------------------------------------------------------------ *
 * 12. 方言族（用户自己建的那一族）：目录一律从上游拉
 * ------------------------------------------------------------------ */

section("12. 方言族的目录一律从上游拉");

// 面板上那个「刷新模型目录」按钮走的就是这条路。厂商那几行也是方言族：一样拉。
const vendorRefresh = await adminService.refreshPlatformModels!({ platformId: "qiniu" } as any);
check(
  "方言族的厂商行：刷新去问上游（没 key 时答的是没有 key）",
  vendorRefresh.ok === false && /key/.test(String(vendorRefresh.message)),
  vendorRefresh.message,
);

modelsPayload = { data: [{ id: "m-9" }, { id: "m-10" }] };
const dialectRefresh = await adminService.refreshPlatformModels!({ platformId: "auto-cat" } as any);
check("方言行：还能刷新", dialectRefresh.ok === true, dialectRefresh.message);
check(
  "方言行：目录换成了上游那份",
  openPlatformOf("auto-cat")?.models.items.join(",") === "m-9,m-10",
  JSON.stringify(openPlatformOf("auto-cat")?.models),
);

/* ------------------------------------------------------------------ *
 * 13. 行是权威：kind 的目录读平台那一行
 * ------------------------------------------------------------------ */

section("13. 行是权威");

// 目录现在由平台行说了算（各 kind 的 models() 读它），代码里的表降成「按 id 查
// 元数据」。这一节查的就是那个次序：行说有哪些、什么顺序；表说它们是什么。

/** 直接写行里的目录（不经面板那条路：这一节要的是行本身的样子）。 */
function putRowModels(platform: string, items: string[]): void {
  store()
    .prepare("UPDATE platform SET models = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ items, traits: {}, fetchedAt: 0 }), Date.now(), platform);
}

/** 行里的目录。 */
function rowItems(platform: string): string[] {
  return openPlatformOf(platform)?.models.items ?? [];
}

/** 一个不在表里的平台 id：模板行本该由迁移补出，这是「意料之外」的那一种。 */
const orphanRow = { ...bareRow("qiniu"), platform: "no-such-platform" };

// 一、行是权威。
putRowModels("qiniu", ["only-this-one"]);
const onlyRow = kindOf("qiniu")!.models(bareRow("qiniu"));
check(
  "qiniu：只返回行里的那一条",
  onlyRow.length === 1 && onlyRow[0]?.id === "only-this-one",
  JSON.stringify(onlyRow.map((m) => m.id)),
);
check(
  "qiniu：displayName 就是 id（元数据表里没有它，不猜一个名字）",
  onlyRow[0]?.displayName === "only-this-one",
  String(onlyRow[0]?.displayName),
);
check(
  "qiniu：报出去的就是行里的那一条",
  onlyRow.map((m) => m.id).join(",") === "only-this-one",
  JSON.stringify(onlyRow.map((m) => m.id)),
);
check(
  "qiniu：元数据表里没有的 id 只给最小形状（能力不编：缺键，不是 false）",
  onlyRow[0]?.contextWindow === undefined &&
    onlyRow[0]?.maxOutputTokens === undefined &&
    !("reasoning" in (onlyRow[0] ?? {})) &&
    !("toolCall" in (onlyRow[0] ?? {})),
  JSON.stringify(onlyRow[0]),
);

// 二、行空即没有。这是本单的判据：空退回代码目录，这一条立刻红。
putRowModels("tokenrhythm", []);
check(
  "tokenrhythm：行空就是没有（不退回代码目录）",
  kindOf("tokenrhythm")!.models(bareRow("tokenrhythm")).length === 0,
  JSON.stringify(kindOf("tokenrhythm")!.models(bareRow("tokenrhythm")).map((m) => m.id)),
);
// 行空时它会在上游目录到手后被填上（见下面第八条），不是永久没有 —— 但「现在
// 没有」就是没有，不从代码目录借。
check(
  "tokenrhythm：行空就是空（不靠退回代码目录蒙上去的）",
  kindOf("tokenrhythm")!.models(bareRow("tokenrhythm")).length === 0,
  JSON.stringify(openPlatformOf("tokenrhythm")?.models),
);

// 三、这一族没有代码目录：行里的 id 报出去就是最小形状（不编能力）。
putRowModels("tokenrhythm", ["relay-model-1"]);
const tokenFromRow = kindOf("tokenrhythm")!.models(bareRow("tokenrhythm"));
check(
  "tokenrhythm：id 是行里那个",
  tokenFromRow[0]?.id === "relay-model-1",
  String(tokenFromRow[0]?.id),
);
check(
  "tokenrhythm：只有最小形状（没有编出来的能力与窗口）",
  JSON.stringify(tokenFromRow[0]) === JSON.stringify({ id: "relay-model-1", displayName: "relay-model-1" }),
  JSON.stringify(tokenFromRow[0]),
);

// 四、顺序跟着行。
putRowModels("qiniu", ["model-b", "model-a"]);
const orderFromRow = kindOf("qiniu")!
  .models(bareRow("qiniu"))
  .map((m) => m.id);
check(
  "qiniu：顺序跟着行",
  orderFromRow.join(",") === "model-b,model-a",
  orderFromRow.join(","),
);

// 五、模拟客户端那几家不动：它们的模型口径是逆推加实测来的，以代码为准。
//
// 造一行同名的平台（目录里写着别的），它们的 models() 也不许读它。
// 播种已经把 qoder 这一行补进表里（模拟客户端的平台全在表里了）：直接往那一行
// 写一份别人的目录，够验「它们的 models() 不读行」。
putRowModels("qoder", ["row-should-be-ignored"]);
const { qoderCatalogModels } = await import("../lib/catalog-models.ts");
const { qoderModelsForRegion } = await import("../lib/qoder/models.ts");
const { regionOf: qoderRegionOf } = await import("../lib/qoder/auth.ts");
const qoderRow = { ...bareRow("qoder"), id: "qoder" };
const qoderIds = kindOf("qoder")!
  .models(qoderRow)
  .map((m) => m.id);
const codeQoderIds = qoderCatalogModels(qoderModelsForRegion(qoderRegionOf("qoder"))).map(
  (m) => m.id,
);
check(
  "qoder：目录还是代码那一份（与改动前逐条一致）",
  qoderIds.join(",") === codeQoderIds.join(","),
  `${qoderIds.join(",")} / ${codeQoderIds.join(",")}`,
);
check(
  "qoder：行里的目录没被读（多一个模型都不行）",
  !qoderIds.includes("row-should-be-ignored"),
  qoderIds.join(","),
);

// 六、行读不到：没有目录。方言族的目录只有上游那一份，代码里没有第二份。
const orphanIds = kindOf("qiniu")!
  .models(orphanRow)
  .map((m) => m.id);
check(
  "行读不到：没有目录（不拿代码里的目录顶）",
  orphanIds.length === 0,
  orphanIds.join(","),
);

// 七、同步的那条路、拉取时刻与幂等。
//
// 上游目录到手以后写平台行的那条路（lib/router/catalog-cache.ts）没有闸门：
// 方言族的目录归上游，拿到就写。老库里那一列（models_auto）留着，但没有人
// 读它 —— 判据只有平台的族。

/** 把老库里那一列翻一下：证明没有人读它。 */
function setRowAuto(platform: string, auto: boolean): void {
  store().prepare("UPDATE platform SET models_auto = ? WHERE id = ?").run(auto ? 1 : 0, platform);
}

const safety = createOpenPlatform({ id: "gate-probe", label: "Gate Probe", baseUrl: upstreamBase });
check("闸门那行的平台建得起来", safety.ok === true, safety.message);
putRowModels("gate-probe", ["code-pick-1"]);
setRowAuto("gate-probe", false);
syncPlatformModels("gate-probe", ["upstream-1", "upstream-2"]);
check(
  "那一列写着 0：同步照样写（判据不是那一列）",
  rowItems("gate-probe").join(",") === "upstream-1,upstream-2",
  JSON.stringify(openPlatformOf("gate-probe")?.models),
);
check(
  "那一列写着 0：也照旧说要去拉目录",
  openPlatformCatalogRefreshable(openPlatformOf("gate-probe")!) === true,
  JSON.stringify(openPlatformOf("gate-probe")?.models),
);
setRowAuto("gate-probe", true);

// 代码里不再有按厂商写死的名单：加一家平台不需要动 store（模板表加一条就行）。
// 只查那一句真删干净了 —— 判据从此只存在库里（models_auto 那一列）。
const storeSource = fs.readFileSync(new URL("../lib/store.ts", import.meta.url), "utf8");
check(
  "store.ts 里没有按 kind 写死的目录名单",
  !storeSource.includes("UPSTREAM_CATALOG_KINDS"),
  storeSource.split("\n").filter((line) => line.includes("UPSTREAM_CATALOG_KINDS")).join(" | "),
);

// 行空的时候：kind 报空（目录只有上游那一份），上游答了就填上。
putRowModels("sensenova", []);
setRowAuto("sensenova", true);
check(
  "行空的目录：kind 报空",
  kindOf("sensenova")!.models(bareRow("sensenova")).length === 0,
  String(kindOf("sensenova")!.models(bareRow("sensenova")).length),
);
syncPlatformModels("sensenova", ["sense-new"]);
check(
  "上游答了就填上",
  rowItems("sensenova").join(",") === "sense-new",
  JSON.stringify(openPlatformOf("sensenova")?.models),
);

// 同步函数对每一行都一样 —— 上面那条不是「同步什么都不写」蒙过去的。
putRowModels("intern-ai", []);
setRowAuto("intern-ai", true);
syncPlatformModels("intern-ai", ["intern-new"]);
check(
  "同步写进去了",
  rowItems("intern-ai").join(",") === "intern-new",
  JSON.stringify(openPlatformOf("intern-ai")?.models),
);

// 同步也要记「上次拉取的时刻」：0 是「没拉过」，面板照它显示「上次拉取」。
// 刚拉回来的目录不能还说没拉过。
const syncedAt = openPlatformOf("intern-ai")?.models.fetchedAt ?? 0;
check(
  "同步之后 fetchedAt 是刚才（不是 0）",
  syncedAt > 0 && Date.now() - syncedAt < 60_000,
  `${syncedAt} / ${Date.now()}`,
);

// 幂等：目录没变不动 updated_at（那是「最后修改」），但「上次拉取」还是要跟着
// 往前挪 —— 两件事。
const internUpdatedAt = openPlatformOf("intern-ai")?.updatedAt ?? 0;
await new Promise((resolve) => setTimeout(resolve, 5));
syncPlatformModels("intern-ai", ["intern-new"]);
check(
  "同步是幂等的：目录没变就不动 updated_at",
  (openPlatformOf("intern-ai")?.updatedAt ?? 0) === internUpdatedAt,
  `${openPlatformOf("intern-ai")?.updatedAt} / ${internUpdatedAt}`,
);
check(
  "同步是幂等的：拉取时刻仍然跟着往前挪",
  (openPlatformOf("intern-ai")?.models.fetchedAt ?? 0) > syncedAt,
  `${openPlatformOf("intern-ai")?.models.fetchedAt} / ${syncedAt}`,
);

// 老库里那一列写着 0 的那一行：同步照样写（那一列没有人读）。
setRowAuto("intern-ai", false);
syncPlatformModels("intern-ai", ["intern-should-not-land"]);
check(
  "那一列写着 0：同步照样写",
  rowItems("intern-ai").join(",") === "intern-should-not-land",
  JSON.stringify(openPlatformOf("intern-ai")?.models),
);
setRowAuto("intern-ai", true);

// 方言族的厂商行：一样从上游拉，一样写进行里。
putRowModels("qiniu", []);
setRowAuto("qiniu", false);
syncPlatformModels("qiniu", ["qiniu-upstream-1"]);
check(
  "方言族的厂商行：上游那份写进行里",
  rowItems("qiniu").join(",") === "qiniu-upstream-1",
  JSON.stringify(openPlatformOf("qiniu")?.models),
);

// 八、端到端：上游答了目录 -> 落到 cache -> 行跟着出现 -> kind 读得到元数据。
// 这一条是这一单的主线：行说了算，而行的内容确实是上游那一份。
const { refreshSenseNovaCatalog, senseNovaCatalog } = await import(
  "../lib/sensenova/transport.ts"
);

const senseAccount = addAccount({ platform: "sensenova" });
const senseAccountId = String(senseAccount.id ?? "");
check("SenseNova：账号加得起来", senseAccount.ok === true && senseAccountId !== "", senseAccount.message);
const senseKey = setProviderKeys(senseAccountId, ["sk-sense-test"]);
check("SenseNova：推理 key 写进去了", senseKey.ok === true && senseKey.count === 1, senseKey.message);

// 把行清成空的，才看得出后续那一步是「上游答了 → 行被填上」。
putRowModels("sensenova", []);
setRowAuto("sensenova", true);
check(
  "SenseNova：动手之前行里是空的",
  rowItems("sensenova").length === 0,
  JSON.stringify(openPlatformOf("sensenova")?.models),
);
check(
  "SenseNova：行空的时候 kind 也报空（不从 cache 借）",
  kindOf("sensenova")!.models(bareRow("sensenova")).length === 0,
  JSON.stringify(kindOf("sensenova")!.models(bareRow("sensenova")).map((m) => m.id)),
);
modelsPayload = {
  data: [
    {
      id: "sense-from-upstream",
      name: "Sense From Upstream",
      context_length: 65536,
      max_output_length: 4096,
      supported_features: ["tools", "reasoning"],
    },
  ],
};
await refreshSenseNovaCatalog(true, senseAccountId);
check(
  "SenseNova：上游答的目录落在 cache 里",
  senseNovaCatalog().some((m) => m.id === "sense-from-upstream"),
  JSON.stringify(senseNovaCatalog().map((m) => m.id)),
);
check(
  "SenseNova：行跟着变成了上游那一份",
  rowItems("sensenova").join(",") === "sense-from-upstream",
  JSON.stringify(openPlatformOf("sensenova")?.models),
);
const senseFromRow = kindOf("sensenova")!.models(bareRow("sensenova"));
check(
  "SenseNova：kind 读得到行里的那一份",
  senseFromRow.length === 1 && senseFromRow[0]?.id === "sense-from-upstream",
  JSON.stringify(senseFromRow.map((m) => m.id)),
);
check(
  "SenseNova：元数据是 cache 里那一份（名字、上下文、输出、能力）",
  senseFromRow[0]?.displayName === "Sense From Upstream" &&
    senseFromRow[0]?.contextWindow === 65536 &&
    senseFromRow[0]?.maxOutputTokens === 4096 &&
    senseFromRow[0]?.reasoning === true &&
    senseFromRow[0]?.toolCall === true,
  JSON.stringify(senseFromRow[0]),
);

/* ------------------------------------------------------------------ *
 * 人工元数据：发布目录的最后一道覆盖
 * ------------------------------------------------------------------ */

// 开放平台的目录从平台那一行来（catalogModelsFromRow），模板平台的从代码表来；
// 人工写的那一层两者都不是 —— 它是注册表在目录出口上加的一层，两条出口都得走
// 得到它。这一节查的正是「表里那一行说了算」这条出口。
const OVER = "override-probe";
insertPlatform(OVER, "openai", "https://probe.example");
putRowModels(OVER, ["row-one", "row-two"]);
const { upsertModelOverrides, deleteModelOverride, listModelOverrides } = await import(
  "../lib/model-overrides.ts"
);
/** 写入口是按 id 覆盖、不替人删；这一节要的是「换成这一份」，所以先删干净。 */
const replaceModelOverrides = (platform: string, rows: { id: string; [key: string]: unknown }[]) => {
  for (const row of listModelOverrides(platform)) deleteModelOverride(platform, row.id);
  return upsertModelOverrides(platform, rows as never);
};
const rowBefore = kindOf("openai")!.models(bareRow(OVER));
check(
  "开放平台：行里的目录就是发布的目录",
  rowBefore.map((m) => m.id).join(",") === "row-one,row-two",
  rowBefore.map((m) => m.id).join(","),
);

replaceModelOverrides(OVER, [{ id: "row-one", displayName: "改过的名字", contextWindow: 32768 }]);
const rowAfter = kindOf("openai")!.models(bareRow(OVER));
check("开放平台：人工写的名字盖上了", rowAfter[0]?.displayName === "改过的名字", JSON.stringify(rowAfter[0]));
check("开放平台：人工写的上下文盖上了", rowAfter[0]?.contextWindow === 32768, JSON.stringify(rowAfter[0]));
check(
  "开放平台：没写的那几格不凭空长出来",
  JSON.stringify(rowAfter[0]) === JSON.stringify({ id: "row-one", displayName: "改过的名字", contextWindow: 32768 }),
  JSON.stringify(rowAfter[0]),
);
check("开放平台：没被写的那一条一动不动", JSON.stringify(rowAfter[1]) === JSON.stringify(rowBefore[1]), JSON.stringify(rowAfter[1]));

replaceModelOverrides(OVER, [{ id: "row-three", displayName: "人工加的" }]);
check(
  "开放平台：人工加的模型在末尾",
  kindOf("openai")!
    .models(bareRow(OVER))
    .map((m) => m.id)
    .join(",") === "row-one,row-two,row-three",
  kindOf("openai")!
    .models(bareRow(OVER))
    .map((m) => m.id)
    .join(","),
);
check(
  "开放平台：人工条目不在时不会出现在别的平台上",
  kindOf("sensenova")!
    .models(bareRow("sensenova"))
    .every((m) => m.id !== "row-three"),
);

replaceModelOverrides(OVER, []);
check(
  "开放平台：清空之后逐字段回到行里的目录",
  JSON.stringify(kindOf("openai")!.models(bareRow(OVER))) === JSON.stringify(rowBefore),
  JSON.stringify(kindOf("openai")!.models(bareRow(OVER))),
);

/* ------------------------------------------------------------------ *
 * 14. 新建平台：目录归上游还是归代码，由平台的族说了算
 * ------------------------------------------------------------------ */

section("14. 新建平台的族");

// 判据只有一处（lib/platform-catalog.ts 的 platformCategoryOfKind）：方言族一律
// 从上游拉，模拟客户端那一族由代码给出。
const VENDOR_KINDS = ["qiniu", "tokenrhythm", "xinghuo", "sensenova", "intern-ai"];
for (const kind of VENDOR_KINDS) {
  const id = `new-${kind}`;
  const created = createOpenPlatform({
    id,
    label: kind,
    baseUrl: upstreamBase,
    kind,
  });
  check(`${kind}：平台建得起来`, created.ok === true, created.message);
  check(
    `${kind}：方言族（目录从上游拉）`,
    platformCategoryOfKind(kind) === "dialect",
    platformCategoryOfKind(kind),
  );
  check(
    `${kind}：建出来时没有目录`,
    (openPlatformOf(id)?.models.items ?? []).length === 0,
    JSON.stringify(openPlatformOf(id)?.models),
  );
}

// 方言：一样从上游拉。
for (const kind of ["openai", "anthropic"]) {
  const id = `new-dialect-${kind}`;
  const created = createOpenPlatform({
    id,
    label: kind,
    baseUrl: upstreamBase,
    ...(kind === "openai" ? {} : { kind }),
  });
  check(`${kind}：平台建得起来`, created.ok === true, created.message);
  check(
    `${kind}：建出来时没有目录`,
    (openPlatformOf(id)?.models.items ?? []).length === 0,
    JSON.stringify(openPlatformOf(id)?.models),
  );
}

// 模拟客户端：目录由代码给出（行上不预填）。
check(
  "模拟客户端：行上不预填目录",
  (openPlatformOf("minimax")?.models.items ?? []).length === 0,
  JSON.stringify(openPlatformOf("minimax")?.models),
);

/* ------------------------------------------------------------------ *
 * 15. 面板的 kind 清单：默认地址取自注册表
 * ------------------------------------------------------------------ */

section("15. ListPlatformKinds 的默认地址");

const kindsAnswer = await adminService.listPlatformKinds!({} as any, {} as any);
const kindsListed = (kindsAnswer.kinds ?? []) as any[];
for (const one of VENDOR_KINDS) {
  const row = kindsListed.find((k) => k.kind === one);
  const registryBase = kindOf(one)?.defaultBaseUrl ?? "";
  check(`${one}：清单里有这一格`, Boolean(row), String(row));
  check(
    `${one}：默认地址不是空串`,
    typeof row?.defaultBaseUrl === "string" && row.defaultBaseUrl !== "",
    String(row?.defaultBaseUrl),
  );
  check(
    `${one}：默认地址等于注册表那一格`,
    row?.defaultBaseUrl === registryBase,
    `${row?.defaultBaseUrl} / ${registryBase}`,
  );
}

/* ------------------------------------------------------------------ *
 * 16. 建平台：额度插件与目录都预填
 * ------------------------------------------------------------------ */

section("16. 建平台时预填额度插件与目录");

// 额度插件：这一类默认用哪个插件写在 kind 注册表里（ProviderKind.defaultQuotaPlugin）。
// 面板建平台时拿它预填那一格，用户可以改。
const VENDOR_PLUGIN: { kind: string; plugin: string }[] = [
  { kind: "qiniu", plugin: "qiniu" },
  { kind: "sensenova", plugin: "sensenova-pools" },
  { kind: "intern-ai", plugin: "intern-ai-credits" },
  { kind: "tokenrhythm", plugin: "tokenrhythm-wallet" },
  { kind: "xinghuo", plugin: "" },
];
for (const one of VENDOR_PLUGIN) {
  const row = kindsListed.find((k) => k.kind === one.kind);
  check(
    `${one.kind}：清单里的默认插件是 ${one.plugin || "（空）"}`,
    row?.defaultQuotaPlugin === one.plugin,
    String(row?.defaultQuotaPlugin),
  );
  check(
    `${one.kind}：与注册表那一格一致`,
    (kindOf(one.kind)?.defaultQuotaPlugin ?? "") === one.plugin,
    String(kindOf(one.kind)?.defaultQuotaPlugin),
  );
}

// 建平台：额度插件写进行里（像以前那些模板一样）。
for (const one of VENDOR_PLUGIN) {
  const id = `prefill-${one.kind}`;
  const created = createOpenPlatform({
    id,
    label: one.kind,
    baseUrl: upstreamBase,
    kind: one.kind,
  });
  check(`${one.kind}：平台建得起来`, created.ok === true, created.message);
  check(
    `${one.kind}：额度插件预填成 ${one.plugin || "（空）"}`,
    openPlatformOf(id)?.quotaPlugin === one.plugin,
    String(openPlatformOf(id)?.quotaPlugin),
  );
}

// 目录：建平台一律不预填（目录归上游，刷新才拿得到）。
for (const kind of ["qiniu", "xinghuo", "tokenrhythm"]) {
  const id = `prefill-models-${kind}`;
  const created = createOpenPlatform({
    id,
    label: kind,
    baseUrl: upstreamBase,
    kind,
  });
  check(`${kind}：平台建得起来`, created.ok === true, created.message);
  const row = openPlatformOf(id);
  check(
    `${kind}：目录不预填`,
    (row?.models.items ?? []).length === 0,
    JSON.stringify(row?.models.items),
  );
  check(`${kind}：没拉过上游`, row?.models.fetchedAt === 0, String(row?.models.fetchedAt));
}

// 目录归上游的那几家：建的时候目录是空的，等上游那份。
for (const kind of ["sensenova", "intern-ai", "openai"]) {
  const id = `prefill-empty-${kind}`;
  const created = createOpenPlatform({
    id,
    label: kind,
    baseUrl: upstreamBase,
    ...(kind === "openai" ? {} : { kind }),
  });
  check(`${kind}：平台建得起来`, created.ok === true, created.message);
  check(
    `${kind}：目录是空的`,
    openPlatformOf(id)?.models.items.length === 0,
    JSON.stringify(openPlatformOf(id)?.models.items),
  );
}

// 用户自己给了目录：那一格已经不在契约里，写不进去 —— 建出来仍然没有目录。
const given = createOpenPlatform({
  id: "prefill-given",
  label: "given",
  baseUrl: upstreamBase,
  kind: "qiniu",
  models: ["my/model-a", "my/model-b"],
} as never);
check("给了目录的平台建得起来", given.ok === true, given.message);
check(
  "用户给的目录写不进去（目录不是建平台的人说了算）",
  (openPlatformOf("prefill-given")?.models.items ?? []).length === 0,
  JSON.stringify(openPlatformOf("prefill-given")?.models.items),
);

// 三种给法是三件事（这一层是定规矩的地方）：
//   不给这一格 = 这一类声明的默认插件；给了空串 = 不用插件；给了 id = 用这个。
const DEFAULT_PLUGIN_KIND = "qiniu";
const defaultPluginRow = createOpenPlatform({
  id: "plugin-default",
  label: "默认插件",
  baseUrl: upstreamBase,
  kind: DEFAULT_PLUGIN_KIND,
});
check("不给插件：平台建得起来", defaultPluginRow.ok === true, defaultPluginRow.message);
check(
  "不给就是这一类声明的默认插件",
  openPlatformOf("plugin-default")?.quotaPlugin === "qiniu",
  String(openPlatformOf("plugin-default")?.quotaPlugin),
);

const emptyPluginRow = createOpenPlatform({
  id: "plugin-empty",
  label: "不用插件",
  baseUrl: upstreamBase,
  kind: DEFAULT_PLUGIN_KIND,
  quotaPlugin: "",
});
check("给空串：平台建得起来", emptyPluginRow.ok === true, emptyPluginRow.message);
check(
  "空串是「不用插件」，不是默认那个",
  openPlatformOf("plugin-empty")?.quotaPlugin === "",
  String(openPlatformOf("plugin-empty")?.quotaPlugin),
);

const unknownPluginRow = createOpenPlatform({
  id: "plugin-unknown",
  label: "没登记的插件",
  baseUrl: upstreamBase,
  kind: DEFAULT_PLUGIN_KIND,
  quotaPlugin: "no-such-plugin",
});
check("没登记的插件被拒", unknownPluginRow.ok === false, unknownPluginRow.message);
check(
  "机器码是 QUOTA_PLUGIN_UNKNOWN",
  unknownPluginRow.code === "QUOTA_PLUGIN_UNKNOWN",
  String(unknownPluginRow.code),
);
check(
  "被拒的那一行没写进表",
  openPlatformOf("plugin-unknown") === null,
  String(openPlatformOf("plugin-unknown")),
);

/* ------------------------------------------------------------------ *
 * 17. 三条判别力：目录归上游还是归代码
 * ------------------------------------------------------------------ */

section("17. 目录归上游还是归代码");

// 一、方言族建平台时没有目录，刷新之后目录是上游答的那份。
const qiniuProbeCreated = createOpenPlatform({
  id: "qiniu-probe",
  label: "Qiniu Probe",
  baseUrl: upstreamBase,
  kind: "qiniu",
  quotaPlugin: "",
});
check("方言族（qiniu）的平台建得起来", qiniuProbeCreated.ok === true, qiniuProbeCreated.message);
check(
  "行里没有目录（建平台不预填）",
  (openPlatformOf("qiniu-probe")?.models.items ?? []).length === 0,
  JSON.stringify(openPlatformOf("qiniu-probe")?.models),
);
const qiniuProbeAccount = addAccount({ platform: "qiniu-probe" });
check("账号加得起来", qiniuProbeAccount.ok === true, qiniuProbeAccount.message);
setProviderKeys(qiniuProbeAccount.id ?? "", ["sk-qiniu-probe"]); // privacy:allow — 编造的样例
modelsPayload = { data: [{ id: "qiniu-up-1", context_length: 4096 }] };
seen.length = 0;
const qiniuProbeRefresh = await refreshOpenPlatformCatalog("qiniu-probe");
check("刷新拉到了", qiniuProbeRefresh.ok === true, qiniuProbeRefresh.message);
check(
  "目录是上游答的那份",
  openPlatformOf("qiniu-probe")?.models.items.join(",") === "qiniu-up-1",
  JSON.stringify(openPlatformOf("qiniu-probe")?.models.items),
);
check(
  "参数也跟上来",
  openPlatformOf("qiniu-probe")?.models.traits["qiniu-up-1"]?.contextWindow === 4096,
  JSON.stringify(openPlatformOf("qiniu-probe")?.models.traits),
);

// 二、模拟客户端那一族：目录仍来自代码，不因这次改动变空。
const { workbuddyCatalogModels } = await import("../lib/catalog-models.ts");
const { workbuddyPublishList } = await import("../lib/workbuddy/models.ts");
const workbuddyRow = { ...bareRow("workbuddy-cn"), kind: "workbuddy", region: "cn" };
const workbuddyIds = kindOf("workbuddy")!.models(workbuddyRow).map((m) => m.id);
const workbuddyCodeIds = workbuddyCatalogModels(workbuddyPublishList("cn")).map((m) => m.id);
check(
  "模拟客户端的目录仍来自代码（不是空的）",
  workbuddyIds.length > 0,
  JSON.stringify(workbuddyIds),
);
check(
  "模拟客户端的目录与代码那一份逐条一致",
  workbuddyIds.join(",") === workbuddyCodeIds.join(","),
  `${workbuddyIds.join(",")} / ${workbuddyCodeIds.join(",")}`,
);
check(
  "模拟客户端的行上不预填目录",
  (openPlatformOf("workbuddy-cn")?.models.items ?? []).length === 0,
  JSON.stringify(openPlatformOf("workbuddy-cn")?.models),
);

// 三、方言族的刷新一定打上游一次（假上游计数 1）。
const dialectProbeCreated = createOpenPlatform({
  id: "dialect-probe",
  label: "Dialect Probe",
  baseUrl: upstreamBase,
});
check("方言平台的平台建得起来", dialectProbeCreated.ok === true, dialectProbeCreated.message);
const dialectProbeAccount = addAccount({ platform: "dialect-probe" });
check("账号加得起来", dialectProbeAccount.ok === true, dialectProbeAccount.message);
setProviderKeys(dialectProbeAccount.id ?? "", ["sk-dialect-probe"]); // privacy:allow — 编造的样例
// 老库里那一列（models_auto）写着 0 的那一行：判据不是那一列，刷新照样打上游。
store().prepare("UPDATE platform SET models_auto = 0 WHERE id = ?").run("dialect-probe");
check(
  "那一列确实写着 0",
  Number((store().prepare("SELECT models_auto FROM platform WHERE id = ?").get("dialect-probe") as any)?.models_auto) === 0,
  "那一列不是 0，这一节就验不到东西",
);
modelsPayload = { data: [{ id: "dialect-1" }] };
seen.length = 0;
const dialectProbeRefresh = await refreshOpenPlatformCatalog("dialect-probe");
check("刷新拉到了", dialectProbeRefresh.ok === true, dialectProbeRefresh.message);
check(
  "打上游一次（假上游计数 1）",
  modelsHits() === 1,
  JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)),
);
check(
  "目录是上游答的那份",
  openPlatformOf("dialect-probe")?.models.items.join(",") === "dialect-1",
  JSON.stringify(openPlatformOf("dialect-probe")?.models.items),
);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */
server.close();
upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
