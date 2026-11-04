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
const seen: { method: string; path: string; authorization: string }[] = [];

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

/* ------------------------------------------------------------------ *
 * 网关（本进程里）
 * ------------------------------------------------------------------ */

const { app } = await import("../lib/router/app.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { createOpenPlatform, openPlatformOf, updateOpenPlatform } = await import(
  "../lib/open-platforms.ts"
);
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { platformAvailability } = await import("../lib/admin/platform-state.ts");
const { refreshOpenPlatformCatalog } = await import("../lib/open-platform-catalog.ts");
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

// 目录是人写的：auto 关掉 —— 自动拉不许覆盖它。
const catalog = updateOpenPlatform("acme", { models: ["m-1"] });
check("手写的目录写进去了", catalog.ok === true, catalog.message);
check(
  "手写的目录不是自动拉的",
  openPlatformOf("acme")?.models.auto === false,
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
  "新加的平台默认是自动拉的",
  openPlatformOf("auto-cat")?.models.auto === true,
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
check("目录是自动拉的", openPlatformOf("auto-cat")?.models.source === "auto", openPlatformOf("auto-cat")?.models.source);
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

section("6. 人写死的目录");

const manualCreated = createOpenPlatform({
  id: "manual-cat",
  label: "Manual Cat",
  baseUrl: upstreamBase,
});
check("手工目录的平台建得起来", manualCreated.ok === true, manualCreated.message);
const manualAccount = addAccount({ platform: "manual-cat" });
setProviderKeys(manualAccount.id ?? "", ["sk-manual-1"]);
const manualCatalog = updateOpenPlatform("manual-cat", { models: ["hand-1"] });
check("手写的目录写进去了", manualCatalog.ok === true, manualCatalog.message);
check(
  "它不是自动拉的",
  openPlatformOf("manual-cat")?.models.auto === false,
  JSON.stringify(openPlatformOf("manual-cat")?.models),
);

modelsPayload = { data: [{ id: "m-1" }, { id: "m-2" }] };
seen.length = 0;
const manualPull = await refreshOpenPlatformCatalog("manual-cat");
check("不拉", manualPull.ok === false, manualPull.message);
check(
  "目录还是人写的那一份",
  openPlatformOf("manual-cat")?.models.items.join(",") === "hand-1",
  JSON.stringify(openPlatformOf("manual-cat")?.models.items),
);
check("来源还是 manual", openPlatformOf("manual-cat")?.models.source === "manual", openPlatformOf("manual-cat")?.models.source);
check("没去问上游", seen.length === 0, JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)));

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
  "第二次说先不再问",
  failSecond.ok === false && failSecond.message.includes("先不再问"),
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
  "说的是先不再问",
  backoffAgain.ok === false && backoffAgain.message.includes("先不再问"),
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
// 明确的意思，答复「刚问过上游，先不再问」等于让他点了个寂寞。
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
  "不带 force 说的是先不再问",
  forceBackoff.ok === false && forceBackoff.message.includes("先不再问"),
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
