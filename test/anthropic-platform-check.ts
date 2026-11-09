// test/anthropic-platform-check.ts — 上游讲 Anthropic Messages 的开放平台。
//
//   node --experimental-strip-types test/anthropic-platform-check.ts
//
// 离线：临时数据目录 + 本进程里的假上游。假上游**只认 Anthropic 报文**（形状
// 不对就回 400），所以「下游是 OpenAI、上游是 Anthropic」这一路的翻译真的被
// 走了一遍 —— 翻译没了，第一条就红。不发真请求，不碰真凭据。
//
// 查五件事：
//
//   1. 端到端非流式：OpenAI 方言进 → Anthropic 报文出 → 答回 OpenAI 形状
//   2. 端到端流式：SSE 帧 + 最后一帧 [DONE]
//   3. 客户端本来就是 Anthropic：请求原样过去（system / cache_control 都在）
//   4. 鉴权头：x-api-key 与 anthropic-version 在，authorization 不在
//   5. usage：input_tokens / cache_read_input_tokens / output_tokens 按
//      lib/dialect/cache.ts 的口径记成 prompt / completion

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-platform-"));
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
 * 假上游：只认 Anthropic Messages
 * ------------------------------------------------------------------ */

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

const seen: Seen[] = [];

/**
 * 假上游要拒的那个账号（账号 id，空串表示不拒任何账号）。
 *
 * 按账号 id 分支，不按 key 的值：key 只是编造的样例，账号 id 才是网关这次真的
 * 告诉上游「我是谁」的那一条。key 两个账号可以一样，账号 id 不能。
 */
let refusedAccount = "";

/** 上游报的 usage：输入拆两处，跟 Anthropic 一样。 */
const USAGE = { input_tokens: 7, cache_read_input_tokens: 197, output_tokens: 22 };

/**
 * 这是不是 Anthropic 的 Messages 报文。
 *
 * 两条硬要求：max_tokens 是个数（Anthropic 必填），messages 里没有 system
 * 这种角色（system 在顶层）。少了任一条都说明发来的是别的方言 —— 换成
 * OpenAI 的报文，两条都不满足。
 */
function anthropicShaped(body: any): string | null {
  if (!body || typeof body !== "object") return "body is not an object";
  if (typeof body.max_tokens !== "number") return "max_tokens is missing";
  if (!Array.isArray(body.messages)) return "messages is not an array";
  const bad = body.messages.find((m: any) => m?.role !== "user" && m?.role !== "assistant");
  if (bad) return `messages has a role Anthropic does not have: ${String(bad?.role)}`;
  if (body.choices !== undefined) return "choices is an OpenAI field";
  return null;
}

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = Array.isArray(value) ? value.join(",") : String(value ?? "");
  }
  seen.push({ method: req.method ?? "", path: url.pathname, headers, body });

  // 这个账号被拒：401 是**账号**的失败，策略层该看得见（能降级的换下一个
  // 账号，单一策略的把那个账号关一段时间）。判据是 x-account-id —— 网关真的
  // 把「这次是哪个账号发的」写进了 HTTP 头。
  if (refusedAccount && headers["x-account-id"] === refusedAccount) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    );
    return;
  }

  const problem = anthropicShaped(body);
  if (problem) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: problem } }));
    return;
  }

  if (body.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(
      frame("message_start", {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          // 输入在 message_start 里报，输出在 message_delta 里报 —— 上游就是这么
          // 拆的，记账要按两处都收。
          usage: { input_tokens: USAGE.input_tokens, cache_read_input_tokens: USAGE.cache_read_input_tokens, output_tokens: 1 },
        },
      }),
    );
    res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    );
    res.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: USAGE.output_tokens },
      }),
    );
    res.write(frame("message_stop", { type: "message_stop" }));
    res.end();
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: USAGE,
    }),
  );
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as { port: number }).port;
/** 不带 /v1 的地址：网关要自己拼出 /v1/messages。 */
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

/* ------------------------------------------------------------------ *
 * 网关（本进程里）
 * ------------------------------------------------------------------ */

const { app } = await import("../lib/router/app.ts");
const { kindOf, policiesOfKind } = await import("../lib/provider-kinds.ts");
const { createOpenPlatform, openPlatformOf } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { platformAvailability } = await import("../lib/admin/platform-state.ts");
const { openPlatformKeyOf } = await import("../lib/open-platform-credentials.ts");
const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");
const { listUsage } = await import("../lib/usage.ts");
const { PLATFORM_KIND_OPTIONS } = await import("../lib/platform-catalog.ts");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(
  path: string,
  body: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE 或者错误页 */
  }
  return { status: res.status, json, text };
}

/** 最近一次打到假上游的推理请求。 */
function lastSeen(): Seen {
  return seen[seen.length - 1];
}

/* ------------------------------------------------------------------ *
 * 登记与建平台
 * ------------------------------------------------------------------ */

section("登记");

const kind = kindOf("anthropic");
check("kindOf(\"anthropic\") 不是 null", kind !== null, String(kind));
check("面板上的名字是 Anthropic 兼容", kind?.label === "Anthropic 兼容", String(kind?.label));
check("登录方式是 api_key", kind?.login === "api_key", String(kind?.login));
check("推理凭据是 api_key", kind?.inferWith === "api_key", String(kind?.inferWith));
check("是开放平台（直接转发）", kind?.openPlatform === true, String(kind?.openPlatform));
check("收 single 与 fallback", policiesOfKind("anthropic").join(",") === "single,fallback", policiesOfKind("anthropic").join(","));
check(
  "能建的平台种类里有它",
  PLATFORM_KIND_OPTIONS.some((option) => option.kind === "anthropic"),
  PLATFORM_KIND_OPTIONS.map((option) => option.kind).join(","),
);
check(
  "它有 dispatch（路由认得出怎么发）",
  typeof kind?.dispatch === "function",
  typeof kind?.dispatch,
);
check(
  "目录这一层是空的（目录走平台那一行）",
  (kind?.models({ platform: "aup" } as any) ?? []).length === 0,
  String((kind?.models({ platform: "aup" } as any) ?? []).length),
);

section("建平台与账号");

const created = createOpenPlatform({
  id: "aup",
  label: "Aup",
  baseUrl: upstreamBase,
  kind: "anthropic",
});
check("平台建得起来", created.ok === true, created.message);
check("类型写进去了", openPlatformOf("aup")?.kind === "anthropic", String(openPlatformOf("aup")?.kind));
check(
  "推理地址取的是平台那一行的",
  kind?.baseUrl({ platform: "aup" } as any) === upstreamBase,
  String(kind?.baseUrl({ platform: "aup" } as any)),
);

const added = addAccount({ platform: "aup" });
const accountId = added.id ?? "";
check("账号加得起来", added.ok === true && accountId !== "", added.message);

const keyed = setProviderKeys(accountId, ["test-key-a"]);
check("一把推理 key 写得进去", keyed.ok === true && keyed.count === 1, keyed.message);
check(
  "key 在账号名下",
  openPlatformKeyOf(accountId)?.apiKey === "test-key-a",
  String(openPlatformKeyOf(accountId)?.apiKey),
);
check("平台是 ready", platformAvailability("aup").state === "ready", platformAvailability("aup").state);

// 发布一个模型：模型名是客户端要的那个，上游的模型名是另一个 —— 答复里的
// model 必须是客户端问的那一个。
saveAggregateModel({
  id: "claude-fake",
  displayName: "claude-fake",
  strategy: "single",
  targets: [{ group: "aup", upstreamModel: "claude-sonnet-x", weight: 1, position: 0, enabled: true }],
});
reloadAggregate();

/* ------------------------------------------------------------------ *
 * 1. 端到端非流式（OpenAI 方言进）
 * ------------------------------------------------------------------ */

section("1. 端到端非流式");

{
  const answer = await call("/v1/chat/completions", {
    model: "claude-fake",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "say ok" },
    ],
  });
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check(
    "答案是 OpenAI 的形状",
    answer.json?.object === "chat.completion" && answer.json?.choices?.[0]?.message?.content === "ok",
    answer.text.slice(0, 300),
  );
  check("model 是客户端要的那个", answer.json?.model === "claude-fake", String(answer.json?.model));

  const request = lastSeen();
  check("打到上游的路径是 /v1/messages", request.path === "/v1/messages", request.path);
  check("发出去的是上游的模型名", request.body?.model === "claude-sonnet-x", String(request.body?.model));
  check("发出去的不是流式", request.body?.stream === false, String(request.body?.stream));
  check("max_tokens 补上了", typeof request.body?.max_tokens === "number", String(request.body?.max_tokens));
  check(
    "system 被搬到了顶层（Anthropic 的写法）",
    request.body?.system === "be brief",
    JSON.stringify(request.body?.system),
  );
}

/* ------------------------------------------------------------------ *
 * 2. 端到端流式
 * ------------------------------------------------------------------ */

section("2. 端到端流式");

{
  const answer = await call("/v1/chat/completions", {
    model: "claude-fake",
    stream: true,
    messages: [{ role: "user", content: "say ok" }],
  });
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check("是 SSE", /^data: /m.test(answer.text), answer.text.slice(0, 200));
  check("最后有 [DONE]", answer.text.trimEnd().endsWith("data: [DONE]"), answer.text.slice(-200));
  check("帧里有内容", answer.text.includes('"content":"ok"'), answer.text.slice(0, 400));
  check("帧里的 model 是客户端要的那个", answer.text.includes('"model":"claude-fake"'), answer.text.slice(0, 200));
  check("上游收到的是流式请求", lastSeen().body?.stream === true, String(lastSeen().body?.stream));
}

/* ------------------------------------------------------------------ *
 * 3. 客户端本来就是 Anthropic
 * ------------------------------------------------------------------ */

section("3. 客户端本来就是 Anthropic");

{
  const clientBody = {
    model: "claude-fake",
    max_tokens: 64,
    system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "say ok", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  const answer = await call("/v1/messages", clientBody);
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check(
    "答案是 Anthropic 的形状",
    answer.json?.type === "message" && answer.json?.content?.[0]?.text === "ok",
    answer.text.slice(0, 300),
  );
  check("model 是客户端要的那个", answer.json?.model === "claude-fake", String(answer.json?.model));

  const request = lastSeen();
  check("路径还是 /v1/messages", request.path === "/v1/messages", request.path);
  check(
    "system 原样过去（没被转成 OpenAI 的 system 消息）",
    JSON.stringify(request.body?.system) === JSON.stringify(clientBody.system),
    JSON.stringify(request.body?.system),
  );
  check(
    "cache_control 原样过去（转一次就丢）",
    JSON.stringify(request.body?.messages) === JSON.stringify(clientBody.messages),
    JSON.stringify(request.body?.messages),
  );
  check("客户端的 max_tokens 没被换掉", request.body?.max_tokens === 64, String(request.body?.max_tokens));
}

/* ------------------------------------------------------------------ *
 * 4. 鉴权头
 * ------------------------------------------------------------------ */

section("4. 鉴权头");

{
  const request = lastSeen();
  check("带 x-api-key", request.headers["x-api-key"] === "test-key-a", String(request.headers["x-api-key"]));
  check("没有 authorization", request.headers["authorization"] === undefined, String(request.headers["authorization"]));
  check(
    "带 anthropic-version",
    request.headers["anthropic-version"] === "2023-06-01",
    String(request.headers["anthropic-version"]),
  );
  check(
    "content-type 是 JSON",
    String(request.headers["content-type"] ?? "").startsWith("application/json"),
    String(request.headers["content-type"]),
  );
}

/* ------------------------------------------------------------------ *
 * 4b. 归因头：这次请求是哪个账号发的
 * ------------------------------------------------------------------ */

section("4b. 归因头");

{
  const request = lastSeen();
  check(
    "带 x-account-id，值是这次用的那个账号",
    request.headers["x-account-id"] === accountId,
    `${String(request.headers["x-account-id"])} ≠ ${accountId}`,
  );
  check(
    "带 x-request-id（非空）",
    typeof request.headers["x-request-id"] === "string" && request.headers["x-request-id"] !== "",
    String(request.headers["x-request-id"]),
  );
  check(
    "x-request-id 是个 UUID 形状",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(request.headers["x-request-id"])),
    String(request.headers["x-request-id"]),
  );
  // 头里不许出现 key：归因头说的是哪个账号，不是凭什么进去的。
  check(
    "归因头里没有 key",
    !JSON.stringify([request.headers["x-request-id"], request.headers["x-account-id"]]).includes("test-key-a"),
    JSON.stringify([request.headers["x-request-id"], request.headers["x-account-id"]]),
  );
}

/* ------------------------------------------------------------------ *
 * 5. usage 记对
 * ------------------------------------------------------------------ */

section("5. usage");

{
  // 上一条是 Anthropic 方言的请求（上游与非流式那一条报的 usage 一样）：
  // input 7 + cache_read 197 才是全部输入，输出 22。
  const events = listUsage({ upstreamId: "aup" });
  const last = events[0];
  check("用量表里有这一条", Boolean(last), String(events.length));
  check("记的是 200", last?.status === 200 && last?.ok === true, `${last?.status} ${last?.ok}`);
  check("prompt 是 input + cache_read", last?.promptTokens === 204, String(last?.promptTokens));
  check("completion 是 output", last?.completionTokens === 22, String(last?.completionTokens));
  check("上游模型名记下来了", last?.upstreamModel === "claude-sonnet-x", String(last?.upstreamModel));
  check("客户端问的模型名也记下来了", last?.agentModel === "claude-fake", String(last?.agentModel));
}

/* ------------------------------------------------------------------ *
 * 基址已经带了 /v1 时不重复拼
 * ------------------------------------------------------------------ */

section("基址带 /v1");

{
  const created2 = createOpenPlatform({
    id: "aup-v1",
    label: "Aup v1",
    baseUrl: `${upstreamBase}/v1`,
    kind: "anthropic",
  });
  check("平台建得起来", created2.ok === true, created2.message);
  const account2 = addAccount({ platform: "aup-v1" });
  setProviderKeys(account2.id ?? "", ["test-key-a"]);
  saveAggregateModel({
    id: "claude-fake-v1",
    displayName: "claude-fake-v1",
    strategy: "single",
    targets: [{ group: "aup-v1", upstreamModel: "claude-sonnet-x", weight: 1, position: 0, enabled: true }],
  });
  reloadAggregate();

  const answer = await call("/v1/chat/completions", {
    model: "claude-fake-v1",
    messages: [{ role: "user", content: "say ok" }],
  });
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check("路径没有拼成 /v1/v1/messages", lastSeen().path === "/v1/messages", lastSeen().path);
}

/* ------------------------------------------------------------------ *
 * 6. 客户端是 OpenAI 方言：usage 也按 Anthropic 的口径换算
 * ------------------------------------------------------------------ */

section("6. OpenAI 方言的 usage");

{
  // 只断言 200 是不够的：这一路的 usage 要先从 Anthropic 那三个字段换算成
  // OpenAI 的 prompt/completion（lib/dialect/cache.ts 的 openAIUsageOf），
  // 再被记账层按 Anthropic 的算法加回来。换算没了，客户端看到的数字就少
  // 一整截（缓存命中的那 197）。
  const before = listUsage({ upstreamId: "aup" }).length;
  const answer = await call("/v1/chat/completions", {
    model: "claude-fake",
    messages: [{ role: "user", content: "say ok" }],
  });
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check(
    "答的是 OpenAI 的形状",
    answer.json?.object === "chat.completion" && answer.json?.choices?.[0]?.message?.content === "ok",
    answer.text.slice(0, 300),
  );
  const events = listUsage({ upstreamId: "aup" });
  check("用量表多了一条", events.length === before + 1, `${before} → ${events.length}`);
  const last = events[0];
  check("记的是 200", last?.status === 200 && last?.ok === true, `${last?.status} ${last?.ok}`);
  check(
    "prompt 是 input + cache_read（不是只有 input）",
    last?.promptTokens === 204,
    String(last?.promptTokens),
  );
  check("completion 是 output", last?.completionTokens === 22, String(last?.completionTokens));
  check("上游模型名记下来了", last?.upstreamModel === "claude-sonnet-x", String(last?.upstreamModel));
  check("客户端问的模型名也记下来了", last?.agentModel === "claude-fake", String(last?.agentModel));
}

/* ------------------------------------------------------------------ *
 * 7. 客户端本来就是 Anthropic 且是流式：报文原样过去，SSE 原样回来
 * ------------------------------------------------------------------ */

section("7. Anthropic 方言 + 流式");

{
  const clientBody = {
    model: "claude-fake",
    max_tokens: 64,
    stream: true,
    system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "say ok", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  const answer = await call("/v1/messages", clientBody);
  check("请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  check("是 SSE", /^event: /m.test(answer.text), answer.text.slice(0, 200));
  check(
    "答复是 Anthropic 的 SSE 形状（message_start / content_block_delta / message_stop）",
    answer.text.includes("event: message_start") &&
      answer.text.includes("event: content_block_delta") &&
      answer.text.includes("event: message_stop"),
    answer.text.slice(0, 400),
  );
  check("帧里的 model 是客户端要的那个", answer.text.includes('"model":"claude-fake"'), answer.text.slice(0, 200));

  const request = lastSeen();
  check("路径是 /v1/messages", request.path === "/v1/messages", request.path);
  check("上游收到的是流式请求", request.body?.stream === true, String(request.body?.stream));
  check(
    "system 原样过去（转一次会把 cache_control 转丢）",
    JSON.stringify(request.body?.system) === JSON.stringify(clientBody.system),
    JSON.stringify(request.body?.system),
  );
  check(
    "messages 原样过去",
    JSON.stringify(request.body?.messages) === JSON.stringify(clientBody.messages),
    JSON.stringify(request.body?.messages),
  );
  check("max_tokens 没被换掉", request.body?.max_tokens === 64, String(request.body?.max_tokens));
}

/* ------------------------------------------------------------------ *
 * 8. 上游 401 是这个账号的失败
 * ------------------------------------------------------------------ */

section("8. 401 带上游状态");

{
  const { setPlatformPolicy } = await import("../lib/platforms.ts");
  const { listCooldowns } = await import("../lib/cooldown.ts");
  const messagesHits = () => seen.filter((s) => s.path === "/v1/messages");

  // 降级：第一个账号被上游拒，换下一个账号接手。
  const fallbackCreated = createOpenPlatform({
    id: "aup-401-fb",
    label: "Aup 401 Fallback",
    baseUrl: upstreamBase,
    kind: "anthropic",
  });
  check("降级平台建得起来", fallbackCreated.ok === true, fallbackCreated.message);
  const badFirst = addAccount({ platform: "aup-401-fb" });
  setProviderKeys(badFirst.id ?? "", ["test-key-a"]);
  const goodSecond = addAccount({ platform: "aup-401-fb" });
  // 两个账号的 key 一样：这样「谁被拒」只能靠 x-account-id 分出来 —— 靠 key 的
  // 值分支的旧写法在这里根本不成立。
  setProviderKeys(goodSecond.id ?? "", ["test-key-a"]);
  const policy = setPlatformPolicy("aup-401-fb", "fallback");
  check("策略改成降级", policy.ok === true, policy.message);
  saveAggregateModel({
    id: "claude-fake-401-fb",
    displayName: "claude-fake-401-fb",
    strategy: "single",
    targets: [{ group: "aup-401-fb", upstreamModel: "claude-sonnet-x", weight: 1, position: 0, enabled: true }],
  });
  reloadAggregate();

  refusedAccount = badFirst.id ?? "";
  seen.length = 0;
  const answer = await call("/v1/chat/completions", {
    model: "claude-fake-401-fb",
    messages: [{ role: "user", content: "say ok" }],
  });
  check("降级：请求答 200", answer.status === 200, `HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  const attempts = messagesHits().map((s) => s.headers["x-account-id"]);
  const ids = messagesHits().map((s) => s.headers["x-request-id"]);
  check("降级：先打了第一个账号", messagesHits().length === 2, JSON.stringify(attempts));
  check(
    "降级：第一次试的是那个账号（x-account-id 说的）",
    attempts[0] === badFirst.id,
    JSON.stringify(attempts),
  );
  check(
    "降级：换到第二个账号接手",
    attempts[1] === goodSecond.id,
    JSON.stringify(attempts),
  );
  check(
    "降级：两次尝试的 request id 不一样，且都非空",
    Boolean(ids[0]) && Boolean(ids[1]) && ids[0] !== ids[1],
    JSON.stringify(ids),
  );
  check(
    "降级：答案来自第二个账号",
    answer.json?.choices?.[0]?.message?.content === "ok",
    answer.text.slice(0, 200),
  );
  check(
    "降级：第一个账号记了冷却",
    listCooldowns().some((row) => row.providerId === badFirst.id),
    JSON.stringify(listCooldowns().map((row) => row.providerId)),
  );

  // 单一：没有别的账号可换，所以不记冷却 —— 记了只会让这个平台一段时间里
  // 一个上游请求都不打，而客户端拿到的还是同一条上游 401。
  const singleCreated = createOpenPlatform({
    id: "aup-401-single",
    label: "Aup 401 Single",
    baseUrl: upstreamBase,
    kind: "anthropic",
  });
  check("单一平台建得起来", singleCreated.ok === true, singleCreated.message);
  const solo = addAccount({ platform: "aup-401-single" });
  setProviderKeys(solo.id ?? "", ["test-key-a"]);
  saveAggregateModel({
    id: "claude-fake-401-single",
    displayName: "claude-fake-401-single",
    strategy: "single",
    targets: [{ group: "aup-401-single", upstreamModel: "claude-sonnet-x", weight: 1, position: 0, enabled: true }],
  });
  reloadAggregate();

  // 换了平台，要拒的账号也得跟着换 —— 判据是账号 id，不是 key。
  refusedAccount = solo.id ?? "";
  const refused = await call("/v1/chat/completions", {
    model: "claude-fake-401-single",
    messages: [{ role: "user", content: "say ok" }],
  });
  check("单一：请求没成", refused.status !== 200, `HTTP ${refused.status} ${refused.text.slice(0, 200)}`);
  check(
    "单一：正文说的是上游 401",
    /401/.test(`${refused.json?.hint ?? ""}${refused.json?.error?.message ?? ""}${refused.text}`),
    refused.text.slice(0, 300),
  );
  check(
    "单一：没有别的账号可换，不记冷却",
    listCooldowns().some((row) => row.providerId === solo.id) === false,
    JSON.stringify(listCooldowns().map((row) => row.providerId)),
  );
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log("");
if (fail) {
  console.log(`FAIL ${fail} 项`);
  for (const problem of problems) console.log(`  - ${problem}`);
} else {
  console.log(`全部通过（${pass} 项）`);
}
server.close();
upstream.close();
process.exit(fail ? 1 : 0);
