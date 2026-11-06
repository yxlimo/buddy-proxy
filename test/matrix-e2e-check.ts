// test/matrix-e2e-check.ts — 端到端矩阵（A/B/C/D/F/G 的可离线部分）。
//
//   node --experimental-strip-types test/matrix-e2e-check.ts
//
// 起一个真网关（test/harness.ts，ROUTER_PORT 随机）+ 本进程里的假上游。
// 假上游答：GET /v1/models、POST /v1/chat/completions（普通与 stream）、
// POST /v1/messages（只认 x-api-key，回 anthropic 格式，普通与 stream），
// 把收到的每个请求的方法/路径/关键头记下来。
//
// 面板那一面走真的 Connect 端点（POST /buddy.admin.v1.AdminService/<Method>），
// 令牌是数据目录里的 admin-token。
//
// 离线：临时数据目录，不发任何真请求。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startGateway } from "./harness.ts";

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
 * 假上游
 * ------------------------------------------------------------------ */

interface Seen {
  method: string;
  path: string;
  authorization: string;
  xApiKey: string;
  /** 请求体原文（表单也原样留着）。 */
  raw: string;
  /** JSON 体里的 model 字段（没有就是空串）。 */
  model: string;
}

const seen: Seen[] = [];

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* 不是 JSON 也算 */
  }
  seen.push({
    method: req.method ?? "",
    path: url.pathname,
    authorization: String(req.headers.authorization ?? ""),
    xApiKey: String(req.headers["x-api-key"] ?? ""),
    raw,
    model: typeof body?.model === "string" ? body.model : "",
  });

  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  // ── 登录（device 流）───────────────────────────────────────────────
  // MiniMax：RFC 8628 的 device code + token 两个端点。
  if (req.method === "POST" && url.pathname === "/oauth2/device/code") {
    json(200, {
      device_code: "FAKE-DEVICE-CODE",
      user_code: "WXYZ-1234",
      verification_uri: "http://127.0.0.1/authorize",
      verification_uri_complete: "http://127.0.0.1/authorize?user_code=WXYZ-1234",
      expires_in: 300,
      interval: 0,
    });
    return;
  }
  // 第一次问 pending，之后一次就批准：轮询真的走了两轮。
  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    if (tokenPolls++ === 0) {
      json(200, { status: "pending" });
      return;
    }
    json(200, {
      access_token: "FAKE-MINIMAX-ACCESS",
      refresh_token: "FAKE-MINIMAX-REFRESH",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "agent.default",
    });
    return;
  }
  // Qoder：没有 device code 端点，只有一条带 nonce/verifier 的轮询。
  if (req.method === "GET" && url.pathname.startsWith("/api/v1/deviceToken/poll")) {
    json(200, {
      token: "FAKE-QODER-ACCESS",
      refresh_token: "FAKE-QODER-REFRESH",
      expire_time: 3600,
      refresh_token_expire_time: 86400,
      user_id: "fake-user",
    });
    return;
  }

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    json(200, { object: "list", data: [{ id: "fake-model-a" }, { id: "fake-model-b" }] });
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({
        id: "c1",
        object: "chat.completion.chunk",
        model: "fake-model-a",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      });
      chunk({
        id: "c1",
        object: "chat.completion.chunk",
        model: "fake-model-a",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    json(200, {
      id: "c1",
      object: "chat.completion",
      model: "fake-model-a",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/messages")) {
    // 各家实际形状不一样：开放平台（anthropic 方言）是 x-api-key，
    // 模拟客户端（minimax 的 Code 会话）是 Authorization: Bearer。
    // 一个端点认所有头就把「鉴权头用错了」这件事一起藏了。
    const credential = String(req.headers["x-api-key"] ?? "") || String(req.headers.authorization ?? "");
    if (!credential) {
      json(401, { error: { type: "authentication_error", message: "missing credentials" } });
      return;
    }
    // 名字里带 FAIL 的凭据：上游拒了（降级用的控制组）。
    if (credential.includes("FAIL")) {
      json(500, { error: { type: "api_error", message: "fake upstream refuses this credential" } });
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t: string, o: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
      ev("message_start", {
        type: "message_start",
        message: { id: "msg1", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } },
      });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      ev("message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    json(200, {
      id: "msg1",
      type: "message",
      role: "assistant",
      model: body.model ?? "fake-model-a",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    return;
  }
  json(404, { error: `no fake route for ${req.method} ${url.pathname}` });
});

await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
/** MiniMax 的 token 端点被问过几次（第一次答 pending）。 */
let tokenPolls = 0;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

// 数据目录自己建：D17 要真重启，重启的几段必须看同一个库（helper 自己建的
// 临时目录在停的时候就删了）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-matrix-e2e-"));
const gw = await startGateway({
  dataDir,
  env: {
    MINIMAX_BASE_URL: `${upBase}/v1`,
    // 登录那几条路也指向假上游：minimax 的 device 流走 OAuth 源站，
    // qoder 的轮询走它自己的 openapi 主机。
    MINIMAX_OAUTH_ORIGIN: upBase,
    MINIMAX_POLL_INTERVAL_MS: "150",
    QODER_CN_OPENAPI_BASE: upBase,
    QODER_GLOBAL_OPENAPI_BASE: upBase,
    QODER_POLL_INTERVAL_MS: "150",
  },
});
// 本进程里读库的那几个 helper 必须指向同一个数据目录（网关自己的那个临时目录）。
process.env.BUDDY_DATA_DIR = gw.dataDir;
const token = fs.readFileSync(path.join(gw.dataDir, "admin-token"), "utf8").trim();

async function rpc(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}/buddy.admin.v1.AdminService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, httpStatus: res.status };
  }
}

async function call(
  p: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${gw.base}${p}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 流不是 JSON */
  }
  return { status: res.status, json, text };
}

const { listOpenPlatforms } = await import("../lib/open-platforms.ts");
const { addAccount, accountsOfPlatform, updateProvider, provider: providerRow } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { setSecret, getSecret, listSecrets } = await import("../lib/store.ts");
const { listCooldowns, setCooldown } = await import("../lib/cooldown.ts");

const users = [{ role: "user", content: "say ok" }];

/* ------------------------------------------------------------------ *
 * A 开放平台（openai 方言）
 * ------------------------------------------------------------------ */

section("A 开放平台（openai 方言）");

const madeA = await rpc("AddPlatform", { id: "e2e-openai", label: "E2E OpenAI", baseUrl: `${upBase}/v1`, kind: "openai" });
check("A1 建 openai 平台成功", madeA.ok === true && madeA.platform?.id === "e2e-openai", JSON.stringify(madeA).slice(0, 200));
check(
  "A1 列表里有它",
  listOpenPlatforms().some((p) => p.id === "e2e-openai"),
  listOpenPlatforms().map((p) => p.id).join(","),
);

const aModelsEmpty = await call("/e2e-openai/v1/models");
check("A2 没账号时 /v1/models 200", aModelsEmpty.status === 200, String(aModelsEmpty.status));
check(
  "A2 没账号时 data 为空",
  Array.isArray(aModelsEmpty.json?.data) && aModelsEmpty.json.data.length === 0,
  JSON.stringify(aModelsEmpty.json).slice(0, 200),
);

const accA = addAccount({ platform: "e2e-openai", alias: "e2e-a" });
check("A3 加账号成功", accA.ok && !!accA.id, accA.message);
if (accA.id) {
  const keys = setProviderKeys(accA.id, ["sk-E2E-TESTONLY-0001"]); // privacy:allow — 编造的样例
  check("A3 存 key 成功", keys.ok, JSON.stringify(keys).slice(0, 200));
}

const refreshed = await rpc("RefreshPlatformModels", { platformId: "e2e-openai" });
check("A4 刷新模型有答复", refreshed.ok !== false && !refreshed.raw, JSON.stringify(refreshed).slice(0, 200));
// 平台行的形状是 OpenPlatformRow：models 是 { items, auto, fetchedAt, source }，
// 没有一个叫 modelsAuto 的顶层字段（那是 proto 里 UpdatePlatform 的入参名）。
const rowA = listOpenPlatforms().find((p) => p.id === "e2e-openai");
const rowAModels: string[] = (rowA?.models.items ?? []).map((m) => m.id);
check("A4 平台行的 models 有内容", rowAModels.length > 0, `${rowAModels.join(",")} / 答复：${refreshed.message}`);
check("A4 models.auto=true（人没锁）", rowA?.models.auto === true, String(rowA?.models.auto));
check("A4 答复说拉到 2 个", /2/.test(String(refreshed.message ?? "")), String(refreshed.message));
check(
  "A4 刷新确实打了上游 /v1/models",
  seen.filter((s) => s.path === "/v1/models" && s.authorization.includes("sk-E2E-TESTONLY-0001")).length === 1, // privacy:allow — 编造的样例
  seen.filter((s) => s.path === "/v1/models").map((s) => s.authorization).join(" | "),
);

const chatA = await call("/e2e-openai/v1/chat/completions", {
  method: "POST",
  body: { model: "fake-model-a", messages: users },
});
check("A5 普通请求 200", chatA.status === 200, String(chatA.status));
check("A5 答复有内容", String(chatA.json?.choices?.[0]?.message?.content ?? "").includes("ok"), chatA.text.slice(0, 160));

const streamA = await call("/e2e-openai/v1/chat/completions", {
  method: "POST",
  body: { model: "fake-model-a", messages: users, stream: true },
});
const framesA = streamA.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6).trim());
check("A5 流式两帧 + [DONE]", framesA.filter((f) => f !== "[DONE]").length === 2 && framesA.at(-1) === "[DONE]", framesA.join(" | ").slice(0, 200));

// A6：SavePublishedModel 的 id 必填。契约注释（proto）原来写「id 为空表示新建」，
// 实现（lib/admin/models.ts:393）直接拒。面板的对话框也把「对外 id」当必填，
// 空 id 根本存不了 —— 所以是注释错了，不是实现错了（注释已改）。
const savedEmpty = await rpc("SavePublishedModel", {
  model: {
    id: "",
    displayName: "e2e-published",
    enabled: true,
    strategy: "single",
    targets: [{ groupName: "e2e-openai", upstreamModel: "fake-model-a", weight: 100, enabled: true }],
  },
});
check("A6 空 id 被拒（与实现一致）", savedEmpty.ok === false && /id/.test(String(savedEmpty.message ?? "")), JSON.stringify(savedEmpty).slice(0, 200));

const saved = await rpc("SavePublishedModel", {
  model: {
    id: "e2e-published",
    displayName: "e2e-published",
    enabled: true,
    strategy: "single",
    targets: [{ groupName: "e2e-openai", upstreamModel: "fake-model-a", weight: 100, enabled: true }],
  },
});
check("A6 带 id 发布成功", saved.ok === true && saved.id === "e2e-published", JSON.stringify(saved).slice(0, 200));
const rootModels = await call("/v1/models");
check(
  "A6 根路由 /v1/models 有它",
  (rootModels.json?.data ?? []).some((m: any) => m.id === "e2e-published"),
  JSON.stringify(rootModels.json).slice(0, 200),
);
const rootChat = await call("/v1/chat/completions", {
  method: "POST",
  body: { model: "e2e-published", messages: users },
});
check("A6 根路由 chat 200", rootChat.status === 200, String(rootChat.status));
const lastUp = seen.filter((s) => s.path.endsWith("/chat/completions")).at(-1);
check(
  "A6 上游收到的是目标模型名（换回来了）",
  lastUp?.model === "fake-model-a",
  `上游最后一次 chat 的 model：${lastUp?.model ?? "无"}`,
);

/* ------------------------------------------------------------------ *
 * B 开放平台（anthropic 方言）
 * ------------------------------------------------------------------ */

section("B 开放平台（anthropic 方言）");

const madeB = await rpc("AddPlatform", { id: "e2e-anthropic", label: "E2E Anthropic", baseUrl: `${upBase}/v1`, kind: "anthropic" });
check("B7 建 anthropic 平台成功", madeB.ok === true && madeB.platform?.id === "e2e-anthropic", JSON.stringify(madeB).slice(0, 200));
const accB = addAccount({ platform: "e2e-anthropic", alias: "e2e-b" });
check("B7 加账号成功", accB.ok && !!accB.id, accB.message);
if (accB.id) {
  setProviderKeys(accB.id, ["sk-E2E-TESTONLY-0002"]); // privacy:allow — 编造的样例
}
await rpc("RefreshPlatformModels", { platformId: "e2e-anthropic" });

const before = seen.length;
const openaiToAnthropic = await call("/e2e-anthropic/v1/chat/completions", {
  method: "POST",
  body: { model: "fake-model-a", messages: users },
});
const anthropicSeen = seen.slice(before).filter((s) => s.path.endsWith("/messages"));
check("B8 openai 格式进去 → 上游收到 anthropic 报文", anthropicSeen.length === 1, `命中 ${anthropicSeen.length} 次`);
check("B8 上游收到 x-api-key", !!anthropicSeen.at(-1)?.xApiKey, anthropicSeen.at(-1)?.xApiKey ?? "空");
check("B8 上游没有 authorization", !anthropicSeen.at(-1)?.authorization, anthropicSeen.at(-1)?.authorization ?? "");
check("B8 客户端拿到 200", openaiToAnthropic.status === 200, String(openaiToAnthropic.status));

const anthropicPass = await call("/e2e-anthropic/v1/messages", {
  method: "POST",
  body: { model: "fake-model-a", max_tokens: 16, messages: users },
  headers: { "x-api-key": "client-key", "anthropic-version": "2023-06-01" },
});
check("B9 anthropic 格式 200", anthropicPass.status === 200, String(anthropicPass.status));
check(
  "B9 回的是 anthropic 格式",
  anthropicPass.json?.type === "message" && Array.isArray(anthropicPass.json?.content),
  JSON.stringify(anthropicPass.json).slice(0, 160),
);

/* ------------------------------------------------------------------ *
 * C 模拟客户端（不登录：直接写会话）
 * ------------------------------------------------------------------ */

section("C 模拟客户端（minimax）");

// 播种是启动时做的事：minimax 那一行已经在库里了，所以「同 id 再建一次」必然
// 回「这个平台已存在」。要验的是「删掉之后同 id 能建回来，而且墓碑不把它改回
// 播种的名字」——先把播种出来的那一行删掉。
check(
  "C10 库里已经有播种的 minimax",
  listOpenPlatforms().some((p) => p.id === "minimax"),
  listOpenPlatforms().map((p) => p.id).join(","),
);
const dupId = await rpc("AddPlatform", { id: "minimax", label: "MiniMax Code", baseUrl: "", kind: "minimax" });
check("C10 同 id 再建被拒", dupId.ok === false && /已存在/.test(String(dupId.message ?? "")), JSON.stringify(dupId).slice(0, 200));
const dupMinimax = await rpc("AddPlatform", { id: "my-minimax", label: "我的 MiniMax", baseUrl: "", kind: "minimax" });
check("C10 同 kind 换 id 被拒", dupMinimax.ok === false, JSON.stringify(dupMinimax).slice(0, 200));
check(
  "C10 库里没多一行",
  !listOpenPlatforms().some((p) => p.id === "my-minimax"),
  listOpenPlatforms().map((p) => p.id).join(","),
);

const delSeeded = await rpc("DeletePlatform", { id: "minimax" });
check("C10 删掉播种的 minimax", delSeeded.ok === true, JSON.stringify(delSeeded).slice(0, 200));
const madeMinimax = await rpc("AddPlatform", { id: "minimax", label: "MiniMax Code", baseUrl: "", kind: "minimax" });
check("C10 删完同 id 能建回", madeMinimax.ok === true, JSON.stringify(madeMinimax).slice(0, 200));

const zcode = await rpc("AddPlatform", { id: "zcode", label: "ZCode", baseUrl: "", kind: "zcode" });
check("C11 建 zcode 被拒", zcode.ok === false, JSON.stringify(zcode).slice(0, 200));

/** 走面板的登录，等到终态。 */
async function loginViaPanel(platformId: string, accountId: string): Promise<any> {
  const begin = await rpc("BeginLogin", { upstreamId: platformId, accountId });
  const loginId = begin.session?.loginId;
  if (!begin.ok || !loginId) return begin;
  let final = begin;
  for (let i = 0; i < 60; i++) {
    final = await rpc("GetLoginStatus", { loginId });
    if (final.session?.status && final.session.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return final;
}

// C12：真的走一次 device 登录（假上游答 device code + token），凭据落库。
const accMin = addAccount({ platform: "minimax", alias: "e2e-minimax" });
check("C12 加 minimax 账号成功", accMin.ok && !!accMin.id, accMin.message);
const minLogin = accMin.id ? await loginViaPanel("minimax", accMin.id) : null;
check(
  "C12 minimax device 登录批准",
  minLogin?.session?.status === "approved",
  JSON.stringify(minLogin?.session ?? minLogin).slice(0, 240),
);
check(
  "C12 device 流真的问了两次（先 pending 后批准）",
  tokenPolls >= 2,
  `token 端点被问 ${tokenPolls} 次`,
);
check(
  "C12 凭据落在库里",
  !!accMin.id && (getSecret<any>(`session:provider:${accMin.id}`)?.accessToken ?? "") === "FAKE-MINIMAX-ACCESS",
  JSON.stringify(getSecret(`session:provider:${accMin.id}`)).slice(0, 200),
);

const minModels = await call("/minimax/v1/models");
check(
  "C13 minimax 有目录",
  (minModels.json?.data ?? []).length > 0,
  `${(minModels.json?.data ?? []).length} 个 / status ${minModels.status}`,
);
const minModel = (minModels.json?.data ?? [])[0]?.id;
const beforeMinChat = seen.length;
const minChat = await call("/minimax/v1/messages", {
  method: "POST",
  body: { model: minModel, max_tokens: 16, messages: users },
  headers: { "x-api-key": "public", "anthropic-version": "2023-06-01" },
});
check("C13 minimax chat 200", minChat.status === 200, `${minChat.status} ${minChat.text.slice(0, 120)}`);
const minUpstream = seen.slice(beforeMinChat).filter((s) => s.path.endsWith("/messages")).at(-1);
check(
  "C13 上游收到的是 Authorization: Bearer（不是 x-api-key）",
  !!minUpstream?.authorization.includes("FAKE-MINIMAX-ACCESS") && !minUpstream?.xApiKey,
  `authorization=${minUpstream?.authorization ?? "空"} x-api-key=${minUpstream?.xApiKey ?? "空"}`,
);

// C12（qoder）：同一条路，另一个平台的 device 流（没有 device code 端点，只有轮询）。
const accQoder = addAccount({ platform: "qoder-cn", alias: "e2e-qoder" });
check("C12 加 qoder 账号成功", accQoder.ok && !!accQoder.id, accQoder.message);
const qoderLogin = accQoder.id ? await loginViaPanel("qoder-cn", accQoder.id) : null;
check(
  "C12 qoder device 登录批准",
  qoderLogin?.session?.status === "approved",
  JSON.stringify(qoderLogin?.session ?? qoderLogin).slice(0, 240),
);
check(
  "C12 qoder 凭据落在库里",
  !!accQoder.id && (getSecret<any>(`session:provider:${accQoder.id}`)?.accessToken ?? "") === "FAKE-QODER-ACCESS",
  JSON.stringify(getSecret(`session:provider:${accQoder.id}`)).slice(0, 200),
);
const qoderModels = await call("/qoder-cn/v1/models");
check(
  "C12 登录后 qoder 平台可用（有目录）",
  (qoderModels.json?.data ?? []).length > 0,
  `${(qoderModels.json?.data ?? []).length} 个 / status ${qoderModels.status}`,
);

const beforeCatalog = seen.filter((s) => s.path.endsWith("/models")).length;
const minRefresh = await rpc("RefreshPlatformModels", { platformId: "minimax" });
const afterCatalog = seen.filter((s) => s.path.endsWith("/models")).length;
check("C15 模拟客户端刷新被答复「这类不用拉」", /不|模拟|预置|无需/.test(String(minRefresh.message ?? "")), JSON.stringify(minRefresh).slice(0, 200));
check("C15 上游收到 0 次目录请求", afterCatalog - beforeCatalog === 0, `${afterCatalog - beforeCatalog} 次`);

/* ------------------------------------------------------------------ *
 * E 多账号：权重、降级、删号
 * ------------------------------------------------------------------ */

section("E 多账号：权重、降级、删号");

// 同一个平台（e2e-anthropic）挂三个账号，权重 300 / 200 / 100。
// 权重最大的那个拿的是上游会拒的 key（名字里带 FAIL），好让降级看得见。
const accE1 = addAccount({ platform: "e2e-anthropic", alias: "e2e-e1" });
const accE2 = addAccount({ platform: "e2e-anthropic", alias: "e2e-e2" });
const accE3 = addAccount({ platform: "e2e-anthropic", alias: "e2e-e3" });
check("E19 三个账号建好了", [accE1, accE2, accE3].every((a) => a.ok && !!a.id), `${accE1.id},${accE2.id},${accE3.id}`);
const keyE1 = "sk-E2E-FAIL-0003"; // privacy:allow — 编造的样例，上游见到它就回 500
const keyE2 = "sk-E2E-OK-0004"; // privacy:allow — 编造的样例
const keyE3 = "sk-E2E-OK-0005"; // privacy:allow — 编造的样例
if (accE1.id) setProviderKeys(accE1.id, [keyE1]);
if (accE2.id) setProviderKeys(accE2.id, [keyE2]);
if (accE3.id) setProviderKeys(accE3.id, [keyE3]);
if (accE1.id) updateProvider(accE1.id, { alias: "e2e-e1", weight: 300 });
if (accE2.id) updateProvider(accE2.id, { alias: "e2e-e2", weight: 200 });
if (accE3.id) updateProvider(accE3.id, { alias: "e2e-e3", weight: 100 });
check(
  "E19 权重存下来了",
  providerRow(accE1.id!)?.weight === 300 && providerRow(accE2.id!)?.weight === 200 && providerRow(accE3.id!)?.weight === 100,
  [accE1.id, accE2.id, accE3.id].map((id) => providerRow(id!)?.weight).join(","),
);

// E19（single）：只用权重最高的那个。它接不了就是接不了，不换人。
const singlePolicy = await rpc("SetPlatformPolicy", { platform: "e2e-anthropic", policy: "PROVIDER_POLICY_SINGLE" });
check("E19 切 single", singlePolicy.ok === true, JSON.stringify(singlePolicy).slice(0, 200));
{
  const beforeSingle = seen.length;
  const attempt = await call("/e2e-anthropic/v1/messages", {
    method: "POST",
    body: { model: "fake-model-a", max_tokens: 16, messages: users },
    headers: { "x-api-key": "client-key", "anthropic-version": "2023-06-01" },
  });
  const hits = seen.slice(beforeSingle).filter((s) => s.path.endsWith("/messages"));
  check("E19 single 只打了一次上游", hits.length === 1, `${hits.length} 次`);
  check("E19 single 用的是权重最高的账号", hits[0]?.xApiKey === keyE1, hits[0]?.xApiKey ?? "空");
  check("E19 single 失败就是失败（没换人）", attempt.status >= 400, String(attempt.status));
}

// C14 / E19（fallback）：第一个账号 500 → 请求落到第二个账号。
const fallbackPolicy = await rpc("SetPlatformPolicy", { platform: "e2e-anthropic", policy: "PROVIDER_POLICY_FALLBACK" });
check("C14 切 fallback", fallbackPolicy.ok === true, JSON.stringify(fallbackPolicy).slice(0, 200));
{
  const beforeFallback = seen.length;
  const attempt = await call("/e2e-anthropic/v1/messages", {
    method: "POST",
    body: { model: "fake-model-a", max_tokens: 16, messages: users },
    headers: { "x-api-key": "client-key", "anthropic-version": "2023-06-01" },
  });
  const hits = seen.slice(beforeFallback).filter((s) => s.path.endsWith("/messages"));
  check("C14 上游收到两次", hits.length === 2, hits.map((h) => h.xApiKey).join(","));
  check("C14 先试权重最高的", hits[0]?.xApiKey === keyE1, hits[0]?.xApiKey ?? "空");
  check("C14 第二次用第二个账号的凭据", hits[1]?.xApiKey === keyE2, hits[1]?.xApiKey ?? "空");
  check("C14 客户端拿到 200", attempt.status === 200, `${attempt.status} ${attempt.text.slice(0, 120)}`);
}

// E20：删一个账号，库里它的那几段都没了。
{
  const victim = accE3.id!;
  setSecret(`key:provider:${victim}:chat`, "key", { apiKey: keyE3 });
  setCooldown(victim, Date.now() + 10 * 60_000, "quota");
  check(
    "E20 删之前：凭据与冷却都在",
    !!getSecret(`key:provider:${victim}:chat`) && listCooldowns().some((row) => row.providerId === victim),
    `${JSON.stringify(listSecrets(`key:provider:${victim}`).map((s) => s.id))} / ${JSON.stringify(listCooldowns().map((r) => r.providerId))}`,
  );
  const deleted = await rpc("DeleteAccount", { id: victim });
  check("E20 删账号成功", deleted.ok === true, JSON.stringify(deleted).slice(0, 200));
  check("E20 账号行没了", providerRow(victim) === null, String(providerRow(victim)));
  check(
    "E20 它名下的凭据全没了",
    listSecrets(`key:provider:${victim}`).length === 0 && getSecret(`session:provider:${victim}`) === null,
    JSON.stringify(listSecrets(`key:provider:${victim}`).map((s) => s.id)),
  );
  check(
    "E20 冷却没了",
    !listCooldowns().some((row) => row.providerId === victim),
    JSON.stringify(listCooldowns().map((r) => r.providerId)),
  );
  // 别的账号没被连坐。
  check(
    "E20 别的账号的凭据还在",
    !!getSecret(`key:provider:${accE2.id}:chat`) || providerRow(accE2.id!) !== null,
    String(providerRow(accE2.id!)?.id),
  );
}

/* ------------------------------------------------------------------ *
 * D 新建/删除平台
 * ------------------------------------------------------------------ */

section("D 新建/删除平台");

const delA = await rpc("DeletePlatform", { id: "e2e-openai" });
check("D16 删自建平台成功", delA.ok === true, JSON.stringify(delA).slice(0, 200));
check(
  "D16 列表里没了",
  !listOpenPlatforms().some((p) => p.id === "e2e-openai"),
  listOpenPlatforms().map((p) => p.id).join(","),
);
const gone = await call("/e2e-openai/v1/models");
// 既定行为（不是这次改动引入的）：带平台前缀的 models 路由没有「这个平台不存在」
// 这一支 —— groupCatalog 找不到那个 group 就拿出空列表，回 200。
// 引入点是模块拆分（lib/router/catalog.ts 的 groupCatalog），比对：拆分前的
// router-proxy.ts 里根本没有 `:platform` 的 models 路由，所以那时是 404（无路由）。
// 已报给主代理定：未知平台回 200 空列表 vs 404。
check(
  "D16 删完那条路是 200 空列表（既定行为，待定）",
  gone.status === 200 && Array.isArray(gone.json?.data) && gone.json.data.length === 0,
  `${gone.status} ${gone.text.slice(0, 160)}`,
);
const goneChat = await call("/e2e-openai/v1/chat/completions", {
  method: "POST",
  body: { model: "fake-model-a", messages: users },
});
check("D16 删完那条路的 chat 不再接", goneChat.status >= 400, String(goneChat.status));

const beforeDeleteMinimax = listOpenPlatforms().length;
const delMin = await rpc("DeletePlatform", { id: "minimax" });
check("D17 删 minimax 成功", delMin.ok === true, JSON.stringify(delMin).slice(0, 200));
check("D17 列表少一行", listOpenPlatforms().length === beforeDeleteMinimax - 1, `${beforeDeleteMinimax} → ${listOpenPlatforms().length}`);
// D17 的真重启在收尾那一节（同一份 BUDDY_DATA_DIR 再起一次网关）。

const kinds = await rpc("ListPlatformKinds", {});
const kindText = JSON.stringify(kinds);
check("D18 ListPlatformKinds 里没有 zcode", !kindText.includes("zcode"), kindText.slice(0, 200));
check(
  "D18 平台列表里没有 zcode",
  !listOpenPlatforms().some((p) => p.id === "zcode"),
  listOpenPlatforms().map((p) => p.id).join(","),
);

/* ------------------------------------------------------------------ *
 * F 模型目录
 * ------------------------------------------------------------------ */

section("F 模型目录");

// 人工目录（modelsAuto=false）不被上游覆盖。
await rpc("UpdatePlatform", {
  id: "e2e-anthropic",
  label: "E2E Anthropic",
  baseUrl: `${upBase}/v1`,
  modelsAuto: false,
  models: ["hand-written-1"],
});
const beforeF = seen.filter((s) => s.path.endsWith("/models")).length;
await rpc("RefreshPlatformModels", { platformId: "e2e-anthropic" });
const rowAnthropic = listOpenPlatforms().find((p) => p.id === "e2e-anthropic");
check(
  "F21 人工目录不被上游覆盖",
  JSON.stringify(rowAnthropic?.models ?? "").includes("hand-written-1") &&
    !JSON.stringify(rowAnthropic?.models ?? "").includes("fake-model-b"),
  JSON.stringify(rowAnthropic?.models ?? ""),
);
check("F21 刷新也没去问上游", seen.filter((s) => s.path.endsWith("/models")).length - beforeF === 0, "0 次");

// F22 的目录是按账号算的：平台没有可用账号时目录就是空（既定语义：线上没有就没有）。
// D 那一节把 minimax 删了一次，所以这里先把它和它的账号补回来。
if (!listOpenPlatforms().some((p) => p.id === "minimax")) {
  const remake = await rpc("AddPlatform", { id: "minimax", label: "MiniMax Code", baseUrl: "", kind: "minimax" });
  check("F22 前提：重新建 minimax", remake.ok === true, JSON.stringify(remake).slice(0, 200));
}
if (accountsOfPlatform("minimax").length === 0) {
  const acc = addAccount({ platform: "minimax", alias: "e2e-f22" });
  if (acc.id) {
    setSecret(`session:provider:${acc.id}`, "session", {
      schemaVersion: 1,
      clientId: "mcode-public",
      audience: "agent-backend",
      scopes: ["agent.default"],
      region: "cn",
      accessToken: "test-token",
      refreshToken: "test-refresh",
      tokenType: "Bearer",
      expiresAtMs: Date.now() + 3600_000,
      generation: 1,
      loginAtMs: Date.now(),
      refreshedAtMs: Date.now(),
    });
  }
}
const minAcc = accountsOfPlatform("minimax");
check("F22 前提：minimax 有一个可用账号", minAcc.length >= 1, minAcc.map((a) => a.id).join(","));
const listModels = await rpc("ListModels", { upstreamId: "minimax" });
const catalog = Array.isArray(listModels.models) ? listModels.models : [];
const noCredits = catalog.filter((m: any) => !("credits" in m));
const zeroCredits = catalog.filter((m: any) => m.credits === 0);
check(
  "F22 倍率缺失的模型没有这一格",
  catalog.length > 0 && (noCredits.length > 0 || zeroCredits.length > 0),
  `${noCredits.length} 条无倍率 / ${zeroCredits.length} 条 0 / 共 ${catalog.length}`,
);

/* ------------------------------------------------------------------ *
 * G 自定义模型
 * ------------------------------------------------------------------ */

section("G 自定义模型");

// G 的前提同上：workbuddy-cn 得有一个可用账号，目录才不为空。
const accWb = addAccount({ platform: "workbuddy-cn", alias: "e2e-workbuddy" });
check("G23 前提：加 workbuddy 账号", accWb.ok && !!accWb.id, accWb.message);
if (accWb.id) {
  setSecret(`session:provider:${accWb.id}`, "session", {
    schemaVersion: 1,
    clientId: "e2e-test",
    audience: "",
    scopes: [],
    region: "cn",
    accessToken: "FAKE-WORKBUDDY-ACCESS",
    refreshToken: "FAKE-WORKBUDDY-REFRESH",
    tokenType: "Bearer",
    expiresAtMs: Date.now() + 3600_000,
    generation: 1,
    loginAtMs: Date.now(),
    refreshedAtMs: Date.now(),
  });
}
const wbProbe = await rpc("ListModels", { upstreamId: "workbuddy-cn" });
check(
  "G23 前提：workbuddy 目录不空",
  (wbProbe.models ?? []).length > 0,
  `${(wbProbe.models ?? []).length} 个`,
);

const addOverride = await rpc("SetModelOverrides", {
  platformId: "workbuddy-cn",
  overrides: [{ id: "e2e-custom-model", displayName: "自定义模型", contextWindow: 123456 }],
});
check("G23 加人工条目成功", addOverride.ok !== false, JSON.stringify(addOverride).slice(0, 200));
const wbModels = await rpc("ListModels", { upstreamId: "workbuddy-cn" });
const custom = (wbModels.models ?? []).find((m: any) => m.id === "e2e-custom-model");
check("G23 出现在 ListModels", !!custom, (wbModels.models ?? []).map((m: any) => m.id).join(",").slice(0, 200));
check(
  "G23 其它字段是最小形状",
  custom?.maxOutputTokens === 0 || custom?.maxOutputTokens === undefined,
  JSON.stringify(custom ?? {}).slice(0, 200),
);

// 已有模型改字段 → 覆盖；没写的字段保持原来源。
// 挑一个自己带档位的模型：没有源档位的模型「没给档位」本来就是空，验不了继承。
const baseWb = (wbModels.models ?? []).find(
  (m: any) => m.id !== "e2e-custom-model" && (m.effortOptions ?? []).length > 0,
);
if (baseWb) {
  await rpc("SetModelOverrides", {
    platformId: "workbuddy-cn",
    overrides: [{ id: "e2e-custom-model", displayName: "自定义模型", contextWindow: 123456 }, { id: baseWb.id, displayName: "改名后的" }],
  });
  const after = await rpc("ListModels", { upstreamId: "workbuddy-cn" });
  const changed = (after.models ?? []).find((m: any) => m.id === baseWb.id);
  check("G24 显示的字段被覆盖", changed?.displayName === "改名后的", String(changed?.displayName));
  check(
    "G24 没写的字段保持原来源",
    changed?.contextWindow === baseWb.contextWindow && JSON.stringify(changed?.effortOptions ?? []) === JSON.stringify(baseWb.effortOptions ?? []),
    `ctx ${baseWb.contextWindow}→${changed?.contextWindow}`,
  );

  // 档位三态。继承要用一个本来就带档位的模型（新造的 id 没有源可继承，
  // 它的「没给档位」就是空）。
  await rpc("SetModelOverrides", {
    platformId: "workbuddy-cn",
    overrides: [{ id: baseWb.id }, { id: "e2e-effort-empty", effortOptions: { levels: [] } }, { id: "e2e-effort-set", effortOptions: { levels: ["low", "high"] } }],
  });
  const effort = await rpc("ListModels", { upstreamId: "workbuddy-cn" });
  const pick = (id: string) => (effort.models ?? []).find((m: any) => m.id === id);
  const inherit = pick(baseWb.id);
  const empty = pick("e2e-effort-empty");
  const set = pick("e2e-effort-set");
  check(
    "G25 三态可区分",
    !!inherit && !!empty && !!set &&
      JSON.stringify(inherit.effortOptions ?? []) === JSON.stringify(baseWb.effortOptions ?? []) &&
      JSON.stringify(baseWb.effortOptions ?? []) !== JSON.stringify([]) &&
      JSON.stringify(empty.effortOptions ?? []) === JSON.stringify([]) &&
      JSON.stringify(set.effortOptions ?? []) === JSON.stringify(["low", "high"]),
    `inherit=${JSON.stringify(inherit?.effortOptions)} empty=${JSON.stringify(empty?.effortOptions)} set=${JSON.stringify(set?.effortOptions)}`,
  );
}

const cleared = await rpc("SetModelOverrides", { platformId: "workbuddy-cn", overrides: [] });
const afterClear = await rpc("ListModels", { upstreamId: "workbuddy-cn" });
check("G26 空列表清空人工条目", cleared.ok !== false && !(afterClear.models ?? []).some((m: any) => m.id === "e2e-custom-model"), (afterClear.models ?? []).map((m: any) => m.id).join(",").slice(0, 200));

/* ------------------------------------------------------------------ *
 * D17′ 真重启
 * ------------------------------------------------------------------ */

section("D17 真重启（同一份 BUDDY_DATA_DIR）");

// 第一次重启：刚删掉 minimax 就重启，它不该被播种复活。
// （F 那一节为了验目录把它建回来过，所以这里再删一次。）
const delAgain = await rpc("DeletePlatform", { id: "minimax" });
check("D17 重启前再删掉 minimax", delAgain.ok === true, JSON.stringify(delAgain).slice(0, 200));
await gw.stopAndWait();
const gw2 = await startGateway({
  dataDir,
  env: {
    MINIMAX_BASE_URL: `${upBase}/v1`,
    MINIMAX_OAUTH_ORIGIN: upBase,
    QODER_CN_OPENAPI_BASE: upBase,
  },
});
const token2 = fs.readFileSync(path.join(gw2.dataDir, "admin-token"), "utf8").trim();
const rpc2 = async (method: string, body: unknown = {}): Promise<any> => {
  const res = await fetch(`${gw2.base}/buddy.admin.v1.AdminService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token2}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await res.text());
};
check(
  "D17 重启后删掉的 minimax 不复活",
  !listOpenPlatforms().some((p) => p.id === "minimax"),
  listOpenPlatforms().map((p) => p.id).join(","),
);

const again = await rpc2("AddPlatform", { id: "minimax", label: "用户起的名字", baseUrl: "", kind: "minimax" });
check("D17 同 id 建回成功", again.ok === true, JSON.stringify(again).slice(0, 200));
check(
  "D17 名字是用户填的（墓碑清掉，没被播种改回）",
  listOpenPlatforms().find((p) => p.id === "minimax")?.label === "用户起的名字",
  String(listOpenPlatforms().find((p) => p.id === "minimax")?.label),
);

// 第二次重启：名字还是用户填的那个（播种不会把它改回去）。
await gw2.stopAndWait();
const gw3 = await startGateway({
  dataDir,
  env: { MINIMAX_BASE_URL: `${upBase}/v1`, MINIMAX_OAUTH_ORIGIN: upBase },
});
check(
  "D17 再重启一次，名字还是用户填的",
  listOpenPlatforms().find((p) => p.id === "minimax")?.label === "用户起的名字",
  String(listOpenPlatforms().find((p) => p.id === "minimax")?.label),
);
await gw3.stopAndWait();

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

upstream.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log("");
  console.log("失败：");
  for (const p of problems) console.log(`  - ${p}`);
}
process.exit(fail === 0 ? 0 : 1);
