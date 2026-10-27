// test/workbuddy-check.ts — the parts of the WorkBuddy client that were
// changed to match the official one.
//
//   node --experimental-strip-types test/workbuddy-check.ts
//
// Each check is one behaviour the official client has and the proxy did not.

import { buildChatBody, conversationIdFor } from "../lib/workbuddy/transport.ts";
import { clampEffort } from "../lib/workbuddy/models.ts";
import { chatHeaders } from "../lib/workbuddy/auth.ts";
import { uuidv7Hex } from "../lib/ids.ts";
import { cliFetch } from "../lib/http.ts";
import http from "node:http";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const model = {
  id: "hy3",
  display_name: "Hy3",
  credits: 0,
  context: 1000000,
  maxOutput: 32000,
  vision: false,
  tools: true,
  reasoning: true,
  onlyReasoning: false,
  efforts: ["low", "high", "max"],
  temperature: 0.9,
  topP: 1,
};

const noTools = { ...model, id: "no-tools", tools: false, efforts: [] as string[] };

console.log("");
console.log("the thinking level");

check("a level the model supports is kept", clampEffort("high", ["low", "high", "max"]) === "high");
check("a level above the supported ones steps down", clampEffort("medium", ["low", "high", "max"]) === "low");
check("the level below the asked one is used", clampEffort("xhigh", ["low", "high", "max"]) === "high");
check("a level that is not a level falls back to the smallest", clampEffort("wild", ["low", "high"]) === "low");
check("max becomes high when the model lists no levels", clampEffort("max", []) === "high");
check("xhigh becomes high when the model lists no levels", clampEffort("xhigh", []) === "high");
check("low stays low when the model lists no levels", clampEffort("low", []) === "low");

console.log("");
console.log("the request body");

const body = buildChatBody(
  { model: "hy3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium", temperature: 0.1 },
  model,
);
check("the thinking level is clamped", body.reasoning_effort === "low", String(body.reasoning_effort));
check("the caller's temperature is kept", body.temperature === 0.1);
check("the model carries no field the client does not send", !("cache_retention" in body));
check("the stream is asked for", body.stream === true);
check("the usage is asked for", body.stream_options?.include_usage === true);

const withTools = buildChatBody(
  { model: "no-tools", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] },
  noTools,
);
check("a model without tools is sent no tools", !("tools" in withTools));

const defaults = buildChatBody({ model: "hy3", messages: [{ role: "user", content: "hi" }] }, model);
check("the model's own temperature is sent when the caller has none", defaults.temperature === 0.9);
check("the model's own top_p is sent when the caller has none", defaults.top_p === 1);

console.log("");
console.log("the conversation id");

const messages = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "the first question" },
];
const first = conversationIdFor(messages);
const grown = conversationIdFor([...messages, { role: "assistant", content: "an answer" }, { role: "user", content: "another" }]);
check("the id is the same for the same conversation", first === grown);
check("a different conversation gets a different id", first !== conversationIdFor([{ role: "user", content: "other" }]));
check("the id looks like a uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first), first);
check("a client that brings its own id keeps it", conversationIdFor(messages, "client-id") === "client-id");

console.log("");
console.log("the thinking summary");

check("a model that thinks is asked for a summary", defaults.reasoning_summary === "auto", String(defaults.reasoning_summary));
check("a model that thinks is asked for a verbose answer", defaults.verbosity === "high", String(defaults.verbosity));

const noThinking = buildChatBody({ model: "plain", messages: [{ role: "user", content: "hi" }] }, {
  ...model,
  id: "plain",
  reasoning: false,
});
check("a model that does not think is asked for no summary", !("reasoning_summary" in noThinking));
check("a model that does not think is asked for no verbosity", !("verbosity" in noThinking));

console.log("");
console.log("the identity");

// The headers a request the official client actually made carried.
const session = {
  uid: "9efe1321-da5f-47e8-8077-455cec3c7009",
  domain: "www.workbuddy.cn",
  accessToken: "token",
  refreshToken: "refresh",
} as any;
const headers = chatHeaders(session, { conversationId: "01a161f0-e17f-7e62-b596-761457a59e80" });

// 桌面端的头集合（docs/workbuddy/FINDINGS.md §1.1 的 DESK 表），逐字逐项。
// 名字的大小写也是规格的一部分：服务器看到的字符串就是这个。
const EXACT = [
  "X-User-Id",
  "X-Domain",
  "X-Product",
  "X-IDE-Type",
  "X-IDE-Name",
  "X-IDE-Version",
  "X-Private-Data",
  "User-Agent",
  "Accept",
  "Content-Type",
  "x-requested-with",
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "acp-connection-id",
  "X-Conversation-Message-ID",
  "X-Request-ID",
  "X-Agent-Intent",
  "X-Agent-Purpose",
  "x-codebuddy-request",
  "traceparent",
  "b3",
  "X-B3-TraceId",
  "X-B3-ParentSpanId",
  "X-B3-SpanId",
  "X-B3-Sampled",
  "X-Trace-ID",
  "Accept-Encoding",
  "Authorization",
];

const got = Object.keys(headers);
const extra = got.filter((k) => !EXACT.includes(k));
const missing = EXACT.filter((k) => !got.includes(k));
check("没有多余的头", extra.length === 0, extra.join(","));
check("没有缺的头", missing.length === 0, missing.join(","));
check("头的顺序也一致", got.join(",") === EXACT.join(","), got.join(","));

check("身份是桌面端，不是 CLI", headers["X-IDE-Type"] === "WorkBuddy" && headers["X-IDE-Name"] === "WorkBuddy", `${headers["X-IDE-Type"]}/${headers["X-IDE-Name"]}`);
check(
  "User-Agent 是桌面端版本两遍",
  /^WorkBuddy\/\d+\.\d+\.\d+ WorkBuddy\/\d+\.\d+\.\d+$/.test(headers["User-Agent"]),
  headers["User-Agent"],
);
check("X-IDE-Version 与 UA 里的版本一致", headers["User-Agent"].split("/")[1].split(" ")[0] === headers["X-IDE-Version"], headers["X-IDE-Version"]);
check("压缩只在 DESK 这一层关掉", headers["Accept-Encoding"] === "identity", headers["Accept-Encoding"]);
check("私有数据标记", headers["X-Private-Data"] === "true", headers["X-Private-Data"]);
check("小写的 x-requested-with", "x-requested-with" in headers, Object.keys(headers).join(","));
check("小写的 x-codebuddy-request", "x-codebuddy-request" in headers, Object.keys(headers).join(","));
check("小写的 acp-connection-id", "acp-connection-id" in headers, Object.keys(headers).join(","));
check("账号名", headers["X-User-Id"] === session.uid, headers["X-User-Id"]);
check("域名", headers["X-Domain"] === "www.workbuddy.cn", headers["X-Domain"]);

// 头的值：两种 id 形状、两种生命周期。
const UUID_V4_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
check(
  "会话 id 是带横线的 uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(headers["X-Conversation-ID"]),
  headers["X-Conversation-ID"],
);
check("会话 id 用的是传进来的那个", headers["X-Conversation-ID"] === "01a161f0-e17f-7e62-b596-761457a59e80", headers["X-Conversation-ID"]);
check("每轮的 request id 是 uuid v7 hex（客户端自己会校验这个形状）", UUID_V7_HEX.test(headers["X-Conversation-Request-ID"]), headers["X-Conversation-Request-ID"]);
check("message id 是带横线的 uuid v4", UUID_V4_DASHED.test(headers["X-Conversation-Message-ID"]), headers["X-Conversation-Message-ID"]);
check("X-Request-ID 也是带横线的 uuid v4", UUID_V4_DASHED.test(headers["X-Request-ID"]), headers["X-Request-ID"]);
check("两者不是同一个 id", headers["X-Request-ID"] !== headers["X-Conversation-Message-ID"], headers["X-Request-ID"]);
check("acp-connection-id 是带横线的 uuid", UUID_V4_DASHED.test(headers["acp-connection-id"]) || /^[0-9a-f-]{36}$/.test(headers["acp-connection-id"]), headers["acp-connection-id"]);

// 同一个会话：连接 id 固定；不同会话：不同。
{
  const again = chatHeaders(session, { conversationId: "01a161f0-e17f-7e62-b596-761457a59e80" });
  check("同一会话的 acp-connection-id 固定", again["acp-connection-id"] === headers["acp-connection-id"], `${again["acp-connection-id"]} vs ${headers["acp-connection-id"]}`);
  check("同一会话的 X-Conversation-ID 固定", again["X-Conversation-ID"] === headers["X-Conversation-ID"]);
  check("同一会话里每轮的 request id 是新的", again["X-Conversation-Request-ID"] !== headers["X-Conversation-Request-ID"]);
  const other = chatHeaders(session, { conversationId: "01a161f0-0000-7abc-9def-0123456789ab" });
  check("不同会话的 acp-connection-id 不同", other["acp-connection-id"] !== headers["acp-connection-id"]);
}

check("没有 X-Agent-Type", !("X-Agent-Type" in headers));
check("没有 X-Root-Request-ID", !("X-Root-Request-ID" in headers));
check("没有 X-Device-Id", !("X-Device-Id" in headers));
check("没有 X-Agent-Runtime", !("X-Agent-Runtime" in headers));
check("没有 x-stainless-*", Object.keys(headers).filter((k) => k.toLowerCase().startsWith("x-stainless-")).length === 0);
check("trace 是 32 位十六进制的 trace id", /^[0-9a-f]{32}$/.test(headers["X-Trace-ID"]), headers["X-Trace-ID"]);
check("traceparent 引用了同一个 trace id", headers["traceparent"].includes(headers["X-Trace-ID"]), headers["traceparent"]);

console.log("");
console.log("the request itself");

// A request that goes out the way the official client's does: none of the
// headers a browser's fetch adds.
const seen: Record<string, string | undefined> = {};
const server = http.createServer((req, res) => {
  seen["sec-fetch-mode"] = req.headers["sec-fetch-mode"] as any;
  seen["accept-language"] = req.headers["accept-language"] as any;
  seen["x-custom"] = req.headers["x-custom"] as any;
  res.end("ok");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
await cliFetch(`http://127.0.0.1:${port}/`, { headers: { "x-custom": "kept" } });
server.close();

check("the request carries no browser mode", seen["sec-fetch-mode"] === undefined, String(seen["sec-fetch-mode"]));
check("the request carries no browser language", seen["accept-language"] === undefined, String(seen["accept-language"]));
check("the request keeps the headers it was given", seen["x-custom"] === "kept", String(seen["x-custom"]));

console.log("");
console.log("the identifiers");

const hex = uuidv7Hex();
check("the id is 32 hexadecimal characters", /^[0-9a-f]{32}$/.test(hex), hex);
check(
  "the id has the shape the client checks",
  /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(hex),
  hex,
);
check("two ids are not the same", uuidv7Hex() !== hex);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
