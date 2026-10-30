// test/workbuddy-check.ts — the parts of the WorkBuddy client that were
// changed to match the official one.
//
//   node --experimental-strip-types test/workbuddy-check.ts
//
// Each check is one behaviour the official client has and the proxy did not.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store opens its file the first time it is asked for it, so the data
// directory has to point at a temporary one before anything imports it.
// The test never wants the real database: it reads no credential.
process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-check-"));

const { buildChatBody, conversationIdFor } = await import("../lib/workbuddy/transport.ts");
const { clampEffort } = await import("../lib/workbuddy/models.ts");
const { chatHeaders } = await import("../lib/workbuddy/auth.ts");
const { uuidv7Hex } = await import("../lib/ids.ts");
const { cliFetch } = await import("../lib/http.ts");

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
console.log("the regions");
{
  const { ENDPOINTS } = await import("../lib/workbuddy/auth.ts");
  const { platformOf } = await import("../lib/platforms.ts");
  const { kindOf } = await import("../lib/provider-kinds.ts");

  check("the China endpoints did not move", ENDPOINTS.cn.base === "https://www.workbuddy.cn" && ENDPOINTS.cn.origin === "https://www.codebuddy.cn");
  check(
    "the international endpoints are the ones the client uses",
    ENDPOINTS.global.base === "https://www.workbuddy.ai" && ENDPOINTS.global.origin === "https://www.codebuddy.ai",
    JSON.stringify(ENDPOINTS.global),
  );
  check("the international platform is a row of its own", platformOf("workbuddy-global")?.region === "global", JSON.stringify(platformOf("workbuddy-global")));
  check("the China platform is still China", platformOf("workbuddy-cn")?.region === "cn", JSON.stringify(platformOf("workbuddy-cn")));

  // The base URL follows the account row, not a constant.
  const kind = kindOf("workbuddy");
  const asGlobal = kind?.baseUrl({ id: "workbuddy-global", region: "global" } as any);
  const asCn = kind?.baseUrl({ id: "workbuddy-cn", region: "cn" } as any);
  check("the base URL follows the row: international", asGlobal === "https://www.workbuddy.ai", String(asGlobal));
  check("the base URL follows the row: China", asCn === "https://www.workbuddy.cn", String(asCn));
}

console.log("");
console.log("the credit ledger");

// The platform's own answers, recorded once. No network here: the parsing
// is a pure function, so the recorded JSON is enough.
const SUMMARY = {
  TotalCredits: "1867.97000068",
  SubscriptionPackageName: "体验版",
  IsPaidUser: false,
  CreditGroups: [
    { Kind: "plan_base", Name: "套餐基础积分", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500", TotalCount: 1 },
    { Kind: "plan_bonus", Name: "套餐赠送积分", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0", TotalCount: 0 },
    { Kind: "addon", Name: "购买积分", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0", TotalCount: 0 },
    { Kind: "benefit", Name: "平台奖励积分", CycleTotalCapacity: "3522", CycleRemainCapacity: "1867.97000068", CycleUsedCapacity: "1654.02999932", TotalCount: 27 },
  ],
  Packages: [{ PackageCode: "TCACA_code_007_nzdH5h4Nl0", CycleTotalCapacity: "1972", CycleRemainCapacity: "1817.97000068", TotalCount: 25 }],
};

const PACKAGES = {
  TotalCount: 28,
  Accounts: [
    {
      ResourceId: "codebuddy-k8b012gcvqr17rj",
      PackageName: "CodeBuddy个人版拉新权益包",
      CapacityUnit: "credits",
      CapacityType: 1,
      CycleCapacitySize: 1500,
      CycleCapacityRemain: 0,
      CycleCapacityUsed: 1500,
      ExpiredTime: "2026-10-28 14:31:15",
      CycleEndTime: "2026-11-21 09:21:57",
      Status: 3,
      CreateTime: 1792545719000,
    },
    {
      ResourceId: "codebuddy-aa11bb22cc33dd44",
      PackageName: "CodeBuddy个人版加购包",
      CapacityUnit: "credits",
      CapacityType: 1,
      CycleCapacitySize: 200,
      CycleCapacityRemain: 200,
      CycleCapacityUsed: 0,
      ExpiredTime: "2026-12-31 23:59:59",
      CycleEndTime: "2026-12-31 23:59:59",
      Status: 0,
      CreateTime: 1792545719000,
    },
  ],
};

{
  const { parseWorkBuddyResources, fetchWorkBuddyResourcesWith } = await import("../lib/workbuddy/resources.ts");
  const ledger = parseWorkBuddyResources(SUMMARY, PACKAGES);

  check("四个分组都在", ledger.groups.length === 4, String(ledger.groups.length));
  const base = ledger.groups[0];
  check("分组的名字是平台给的", base?.name === "套餐基础积分", String(base?.name));
  check("分组的种类是平台的 kind", base?.kind === "plan_base", String(base?.kind));
  check("分组的总量", base?.total === 500, String(base?.total));
  check("分组剩下的", base?.remaining === 0, String(base?.remaining));
  check("分组用掉的", base?.used === 500, String(base?.used));
  const benefit = ledger.groups[3];
  check("奖励积分剩下的不是取整的", benefit?.remaining === 1867.97000068, String(benefit?.remaining));
  check("奖励积分用掉的", benefit?.used === 1654.02999932, String(benefit?.used));
  check("总量就是平台给的 TotalCredits", ledger.total === Number("1867.97000068"), String(ledger.total));
  check("套餐名", ledger.plan === "体验版", ledger.plan);
  check("付费标记", ledger.paid === false, String(ledger.paid));

  check("批次都进来了", ledger.lots.length === 2, String(ledger.lots.length));
  const lot = ledger.lots[0];
  check("批次的 id 是 ResourceId", lot?.id === "codebuddy-k8b012gcvqr17rj", String(lot?.id));
  check("批次的名字是 PackageName", lot?.name === "CodeBuddy个人版拉新权益包", String(lot?.name));
  check("批次剩下的是 CycleCapacityRemain", lot?.remaining === 0, String(lot?.remaining));
  check("批次的大小是 CycleCapacitySize", lot?.size === 1500, String(lot?.size));
  check(
    "到期时间是东八区本地时间解析出来的",
    lot?.expiresAt === Date.parse("2026-10-28T14:31:15+08:00"),
    String(lot?.expiresAt),
  );
  check(
    "周期结束时间也是本地时间",
    lot?.cycleEndsAt === Date.parse("2026-11-21T09:21:57+08:00"),
    String(lot?.cycleEndsAt),
  );
  check("Status 3 是失效的", lot?.active === false, String(lot?.active));
  check("Status 0 是有效的", ledger.lots[1]?.active === true, String(ledger.lots[1]?.active));

  // 明细没到：总数照给，批次是空的。
  const noLots = parseWorkBuddyResources(SUMMARY, null);
  check("明细缺失时批次是空的", noLots.lots.length === 0, String(noLots.lots.length));
  check("明细缺失时总量照给", noLots.total === Number("1867.97000068"), String(noLots.total));

  // 明细那一问失败：同样不影响总数。
  const failedLots = await fetchWorkBuddyResourcesWith(async (path) => {
    if (path.includes("summary")) return { status: 200, body: { data: SUMMARY } };
    return { status: 500, body: { msg: "boom" } };
  });
  check("明细失败时总量还在", failedLots?.total === Number("1867.97000068"), String(failedLots?.total));
  check("明细失败时批次是空的", failedLots?.lots.length === 0, String(failedLots?.lots.length));

  // 总览那一问失败：不知道，不是没有。
  const failedSummary = await fetchWorkBuddyResourcesWith(async () => ({ status: 503, body: { msg: "nope" } }));
  check("总览失败时是 null", failedSummary === null, String(failedSummary));

  const answered = await fetchWorkBuddyResourcesWith(async (path) => {
    if (path.includes("summary")) return { status: 200, body: { data: SUMMARY } };
    return { status: 200, body: { data: PACKAGES } };
  });
  check("两问都到时批次齐了", answered?.lots.length === 2, String(answered?.lots.length));
  check("两问都到时总量是平台的", answered?.total === Number("1867.97000068"), String(answered?.total));
}

console.log("");
console.log("the panel's numbers");
{
  const { kindOf } = await import("../lib/provider-kinds.ts");
  const kind = kindOf("workbuddy");
  const row = { id: "workbuddy-cn", kind: "workbuddy", region: "cn", enabled: true } as any;

  // 账本读不到：面板上就没有额度，不许编一条签到批次出来。
  const without = kind?.quotas?.(row, { workbuddy: { "workbuddy-cn": { credits: { daily: 100, streakDays: 3 } } } } as any) ?? [];
  check("账本读不到时是空的", without.length === 0, JSON.stringify(without));

  const { parseWorkBuddyResources } = await import("../lib/workbuddy/resources.ts");
  const resources = parseWorkBuddyResources(SUMMARY, PACKAGES);
  const with_ = kind?.quotas?.(row, { workbuddy: { "workbuddy-cn": { credits: null, resources } } } as any) ?? [];
  check("账本在时有一条额度", with_.length === 1, String(with_.length));
  const credits = with_[0]?.credits;
  check("剩余是平台的总积分", credits?.remaining === Number("1867.97000068"), String(credits?.remaining));
  check("总量原样给", credits?.total === Number("1867.97000068"), String(credits?.total));
  check("用掉的是各分组的和", credits?.used === 500 + 1654.02999932, String(credits?.used));
  check("批次是平台的那些", credits?.lots?.length === 2, String(credits?.lots?.length));
  check(
    "批次的来源是平台给的名字",
    credits?.lots?.[0]?.sourceLabel === "CodeBuddy个人版拉新权益包",
    String(credits?.lots?.[0]?.sourceLabel),
  );
  check(
    "批次的状态是有效还是已失效",
    credits?.lots?.[0]?.status === "已失效" && credits?.lots?.[1]?.status === "有效",
    `${credits?.lots?.[0]?.status}/${credits?.lots?.[1]?.status}`,
  );
  check(
    "摘要里有套餐名和各组",
    String(credits?.note).startsWith("套餐：体验版") && String(credits?.note).includes("套餐基础积分"),
    String(credits?.note),
  );
  console.log(`  note: ${credits?.note}`);
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
