// test/open-platform-kind-check.ts — 开放平台（用户自己加的平台）接上以后的样子。
//
//   node --experimental-strip-types test/open-platform-kind-check.ts
//
// 离线：临时数据目录 + 本进程里的假上游，不发真请求，不碰真凭据。
//
// 查的是六件事：
//
//   1. kind 登记了：kindOf("openai") 不是 null，平台的状态是 ready
//   2. 目录公布：/v1/models（根路由）与 /<平台>/v1/models 都列得出目录里的模型
//   3. 转发：POST /<平台>/v1/chat/completions 打到假上游并回 200
//   4. 没有 key：平台是 no_credential、不公布模型、请求被拒并说清是「没凭据」
//   5. 自动拉目录：上游的 /models 答了，目录就被换成上游答的那一份（source=auto）
//   6. 人写死的目录（auto=false）不会被自动拉覆盖
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
    res.writeHead(200, { "content-type": "application/json" });
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
check("请求被拒", refused.status >= 400, `HTTP ${refused.status}`);
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
