// test/sensenova-intern-ai-check.ts — SenseNova 与书生·端砚的离线自测。
//
//   node --experimental-strip-types test/sensenova-intern-ai-check.ts
//
// 起一个假的上游：模型清单、控制台额度、对话，它都答。网关的推理地址与控制台
// 地址都指过去 —— 一个字都不出机器，也不花任何积分。
//
// 覆盖四件事：
//
//   1. 模型目录：平台报了什么是目录里就有什么（上下文、输出上限、能力）；
//   2. 一个请求真的能走通（OpenAI 与 Anthropic 两种方言，流式与非流式）；
//   3. 额度是积分（点数），不是钱；
//   4. 上游的状态：没有推理 key 是 NO_CREDENTIAL，有 key 是 READY，
//      积分用完了是 OUT_OF_CREDITS。

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-sensenova-intern-ai";
const UNIT_DIR = "/tmp/opencode/test-sensenova-intern-ai-unit";
const SERVICE = "/buddy.admin.v1.AdminService";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 一、目录与能力（不碰网关）
 * ------------------------------------------------------------------ */

// 单元部分用自己的数据目录，免得跟网关抢一个库。
fs.rmSync(UNIT_DIR, { recursive: true, force: true });
fs.mkdirSync(UNIT_DIR, { recursive: true, mode: 0o700 });
process.env.BUDDY_DATA_DIR = UNIT_DIR;

const { senseNovaCatalogModels, internAiCatalogModels } = await import("../lib/router/catalog.ts");
const { mergeCatalogModels, hasCapability } = await import("../lib/intern-ai/models.ts");
const { parsePoolUsage } = await import("../lib/sensenova/quota.ts");
const { parseBalance, parseCreditPack } = await import("../lib/intern-ai/quota.ts");

section("SenseNova 的目录");

const SENSE_MODELS = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    contextLength: 1048576,
    maxOutputLength: 65536,
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: ["tools", "json_mode", "reasoning"],
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextLength: 131072,
    maxOutputLength: 32768,
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: ["tools"],
  },
];

const senseCatalog = senseNovaCatalogModels(SENSE_MODELS);
check("模型 id 是上游的那个", senseCatalog[0]?.id === "sensenova-6.8-flash-lite", String(senseCatalog[0]?.id));
check("名字是平台给的", senseCatalog[0]?.displayName === "SenseNova 6.8 Flash Lite");
check("平台说能思考就是能思考", senseCatalog[0]?.reasoning === true);
check("平台没说能思考就是不能", senseCatalog[1]?.reasoning === false);
check("平台说能调工具就是能调工具", senseCatalog[0]?.toolCall === true);
check("上下文长度是平台报的", senseCatalog[0]?.contextWindow === 1048576, String(senseCatalog[0]?.contextWindow));
check("输出上限是平台报的", senseCatalog[0]?.maxOutputTokens === 65536, String(senseCatalog[0]?.maxOutputTokens));

const bareCatalog = senseNovaCatalogModels([
  {
    id: "no-info",
    name: "",
    contextLength: 0,
    maxOutputLength: 0,
    inputModalities: [],
    outputModalities: [],
    features: [],
  },
]);
check("平台没报上下文，目录里就没有那个数", bareCatalog[0]?.contextWindow === undefined);
check("平台没报输出上限，目录里就没有那个数", bareCatalog[0]?.maxOutputTokens === undefined);
check("没名字就用 id", bareCatalog[0]?.displayName === "no-info");

section("书生·端砚的目录");

const INTERN_CATALOG_INPUT = [
  { id: "intern-s2", name: "intern-s2", contextLength: 131072, reasoning: true, toolCall: true },
  { id: "qwen3.8-27b", name: "Qwen3.8 27B", contextLength: 65536, reasoning: false, toolCall: true },
];
const internCatalog = internAiCatalogModels(INTERN_CATALOG_INPUT);
check("模型 id 是上游的那个", internCatalog[0]?.id === "intern-s2");
check("上下文是平台报的", internCatalog[0]?.contextWindow === 131072);
check("平台没报输出上限，目录里就没有那个数", internCatalog[0]?.maxOutputTokens === undefined);
check("模型能调工具", internCatalog[0]?.toolCall === true);

section("两份清单合起来");

const inferenceOnly = [{ id: "intern-s2", name: "intern-s2", contextLength: 0, inputTypes: [], capabilities: [], capabilitiesEn: [], supportedProtocols: [] }];
const consoleList = [
  {
    id: "intern-s2",
    name: "Intern S2",
    contextLength: 131072,
    inputTypes: ["text"],
    capabilities: ["深度思考", "工具调用"],
    capabilitiesEn: ["reasoning", "tool_call"],
    supportedProtocols: ["openai_chat"],
  },
];
const merged = mergeCatalogModels(inferenceOnly, consoleList);
check("推理端的清单说了算：有哪些模型", merged.length === 1 && merged[0]?.id === "intern-s2");
check("上下文来自控制台那份清单", merged[0]?.contextLength === 131072, String(merged[0]?.contextLength));
check("中文的能力名认得出来", merged[0]?.toolCall === true && merged[0]?.reasoning === true);
check("名字用控制台那份的（推理端只给 id）", merged[0]?.name === "Intern S2", String(merged[0]?.name));

const noConsole = mergeCatalogModels(inferenceOnly, []);
check("控制台那份没有的时候，上下文就是不知道", noConsole[0]?.contextLength === 0);
check("控制台那份没有的时候，工具调用按有算（推理端就是 OpenAI 的接口）", noConsole[0]?.toolCall === true);

check("英文的能力名认得出来", hasCapability(["tool_call"], "tool") && hasCapability(["reasoning"], "reasoning"));
check("中文的能力名认得出来", hasCapability(["工具调用"], "tool") && hasCapability(["深度思考"], "reasoning"));
check("没有就说没有", hasCapability([], "tool") === false && hasCapability(["json_mode"], "reasoning") === false);

/* ------------------------------------------------------------------ *
 * 二、假的上游
 * ------------------------------------------------------------------ */

const SENSE_LIST = {
  data: SENSE_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    context_length: m.contextLength,
    max_output_length: m.maxOutputLength,
    input_modalities: m.inputModalities,
    output_modalities: m.outputModalities,
    supported_features: m.features,
  })),
};

const INTERN_LIST = {
  object: "list",
  data: [
    { id: "intern-s2", object: "model" },
    { id: "qwen3.8-27b", object: "model" },
  ],
};

/**
 * SenseNova 的积分池（平台给的样子）。
 */
const SENSE_POOLS_RAW = {
  plan: { id: "free", name: "Free Plan", type: "TOKEN_PLAN_PLAN_TYPE_FREE" },
  pools: [
    {
      id: "pool_general",
      name: "通用积分池",
      model_ids: ["deepseek-v4-flash", "sensenova-6.8-flash-lite"],
      window_5h: { limit: "60000", used: "1000", remaining: "59000", reset_at: "1792655487" },
      window_7d: { limit: "600000", used: "10000", remaining: "590000", reset_at: "1793163087" },
      grant_balance: "5000",
      nearest_grant_expiry: "1794567600",
      nearest_grant_expiring_balance: "1200",
      pool_type: "default",
    },
    {
      id: "pool_lite",
      name: "Flash-Lite积分池",
      model_ids: ["sensenova-6.8-flash-lite"],
      window_5h: { limit: "60000", used: "0", remaining: "60000", reset_at: "1792655487" },
      window_7d: { limit: "600000", used: "0", remaining: "600000", reset_at: "1793163087" },
      grant_balance: "0",
      nearest_grant_expiry: "0",
      nearest_grant_expiring_balance: "0",
      pool_type: "dedicated",
    },
  ],
};

/** 网关把平台的回答读成的样子（快照里存的是这一份）。 */
const SENSE_POOLS = parsePoolUsage(SENSE_POOLS_RAW);

/** 每个池子的积分都空了的样子。 */
const SENSE_POOLS_EMPTY = parsePoolUsage({
  ...SENSE_POOLS_RAW,
  pools: SENSE_POOLS_RAW.pools.map((pool) => ({
    ...pool,
    window_5h: { ...pool.window_5h, remaining: "0" },
    window_7d: { ...pool.window_7d, remaining: "0" },
    grant_balance: "0",
  })),
});

/** 书生·端砚的墨点余额（平台给的样子）。 */
const INTERN_BALANCE_RAW = {
  access_status: 1,
  rpm_limit: 50,
  decision_rpm_limit: 200,
  tpm_limit: 2000000,
  available_credits: "1.698000",
  active_package_count: 1,
  usage_windows: {
    "5h": {
      enabled: true,
      limit_credits: "10.000000",
      used_credits: "0.249000",
      remaining_credits: "9.751000",
      next_recover_at: "2026-10-22 19:56:38",
    },
    "7d": {
      enabled: true,
      limit_credits: "70.000000",
      used_credits: "0.249000",
      remaining_credits: "69.751000",
      next_recover_at: "2026-10-25 19:56:38",
    },
  },
  used: 8.302,
  calculated_at: "2026-10-22 16:28:14",
};

const INTERN_BALANCE = parseBalance(INTERN_BALANCE_RAW);

/** 墨点没了。 */
const INTERN_BALANCE_EMPTY = parseBalance({ ...INTERN_BALANCE_RAW, available_credits: "0" });

/** 5 小时的窗口用满了。 */
const INTERN_BALANCE_WINDOW = parseBalance({
  ...INTERN_BALANCE_RAW,
  usage_windows: {
    "5h": { ...INTERN_BALANCE_RAW.usage_windows["5h"], remaining_credits: "0" },
    "7d": INTERN_BALANCE_RAW.usage_windows["7d"],
  },
});

/** 书生·端砚的墨点批次（平台给的样子）。 */
const INTERN_PACKS_RAW = {
  packages: [
    {
      pkg_id: "pkg_free_monthly_base",
      issued_at: "2026-10-15 12:56:38",
      cycle_type: "monthly",
      current_cycle: { start_at: "2026-10-15 12:56:38", end_at: "2026-11-15 00:00:00" },
      total_credits: "10.000000",
      remaining_credits: "1.698000",
      status: "available",
      income_expense_type: "platform_grant",
      remark: "每月免费基础包",
      effective_at: "2026-10-15 12:56:38",
      expire_at: "2099-12-31 00:00:00",
    },
  ],
};

const INTERN_PACKS = INTERN_PACKS_RAW.packages.map(parseCreditPack);

/** 书生·端砚控制台上在售的模型（补上下文与能力用的那份）。 */
const INTERN_CONSOLE_MODELS = {
  models: [
    {
      id: "intern-s2",
      display_name: "Intern S2",
      context_length: 131072,
      input_types: ["text"],
      capabilities: ["深度思考", "工具调用"],
      capabilities_en: ["reasoning", "tool_call"],
      supported_protocols: ["openai_chat", "anthropic_messages"],
    },
    {
      id: "qwen3.8-27b",
      display_name: "Qwen3.8 27B",
      context_length: 65536,
      input_types: ["text"],
      capabilities: ["工具调用"],
      capabilities_en: ["tool_call"],
      supported_protocols: ["openai_chat"],
    },
  ],
};

/** 假上游收到过的推理请求。 */
const seen: { path: string; model: string; stream: boolean }[] = [];

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = url.pathname;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }

  const json = (payload: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  // SenseNova 的推理端点。
  if (route === "/sensenova/v1/models" && req.method === "GET") {
    json(SENSE_LIST);
    return;
  }
  if (route === "/sensenova/v1/chat/completions" && req.method === "POST") {
    seen.push({ path: route, model: String(body.model ?? ""), stream: body.stream === true });
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    json({
      id: "c1",
      object: "chat.completion",
      created: 1792585589,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 },
    });
    return;
  }
  // SenseNova 的控制台：积分池。
  if (route === "/sensenova/lite/console/v1/tokenplan/pool-usage") {
    json(SENSE_POOLS_RAW);
    return;
  }

  // 书生·端砚的推理端点。
  if (route === "/intern-ai/v1/models" && req.method === "GET") {
    json(INTERN_LIST);
    return;
  }
  if (route === "/intern-ai/v1/chat/completions" && req.method === "POST") {
    seen.push({ path: route, model: String(body.model ?? ""), stream: body.stream === true });
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    json({
      id: "c2",
      object: "chat.completion",
      created: 1792585589,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 32, completion_tokens: 2, total_tokens: 34 },
    });
    return;
  }
  // 书生·端砚的控制台：墨点与在售的模型。
  if (route === "/intern-ai/api/tokenplan/v1/credits/balance") {
    json({ code: 0, msg: "ok", data: INTERN_BALANCE_RAW });
    return;
  }
  if (route === "/intern-ai/api/tokenplan/v1/credits/packages") {
    json({ code: 0, msg: "ok", data: INTERN_PACKS_RAW });
    return;
  }
  if (route === "/intern-ai/api/tokenplan/v1/models") {
    json({ code: 0, msg: "ok", data: INTERN_CONSOLE_MODELS });
    return;
  }

  // 别的上游（TokenRhythm、MiniMax）也指到这里：它们的接口一律答「没有」，
  // 免得测试去碰真的平台。
  if (route.startsWith("/tokenrhythm/") || route.startsWith("/minimax/")) {
    json({ error: "not found" }, 404);
    return;
  }

  json({ error: `no fake route for ${req.method} ${route}` }, 404);
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
const fakeBase = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;

/* ------------------------------------------------------------------ *
 * 三、网关
 * ------------------------------------------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

let router: ChildProcess | null = null;
let routerLog = "";

function startRouter(): ChildProcess {
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: DATA_DIR,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 上游的开关不在环境里了：它在数据库的 provider.enabled 上。
      // 下面用面板的 SetUpstreamEnabled 把这两个新上游打开，其余默认就是关的。
      // 推理端点与控制台都指向假上游：一个字都不出机器。
      SENSENOVA_BASE: `${fakeBase}/sensenova/v1`,
      SENSENOVA_PLATFORM_BASE: `${fakeBase}/sensenova`,
      INTERN_AI_DISCOVERY_API_BASE: `${fakeBase}/intern-ai/v1`,
      INTERN_AI_DISCOVERY_BASE: `${fakeBase}/intern-ai`,
      TOKENRHYTHM_API_BASE: `${fakeBase}/tokenrhythm`,
      MINIMAX_API_BASE: `${fakeBase}/minimax`,
      // 故意不给推理 key：先看看没有凭据时上游是什么状态。
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => {
    routerLog += c.toString();
  });
  child.stderr?.on("data", (c: Buffer) => {
    routerLog += c.toString();
  });
  router = child;
  return child;
}

async function waitHealthy(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function cleanup(): void {
  try {
    router?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  fake.close();
}
process.on("exit", cleanup);

startRouter();
check("网关起来了", await waitHealthy());

/**
 * 等第一次健康快照刷完。
 *
 * /health 发现快照是旧的就起一个后台刷新 —— 那一次刷新会问各个上游。测试要
 * 在它之后再往缓存里写东西，否则会被它盖掉。
 */
async function waitForSnapshot(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const res = await fetch(`${base}/health`);
    const body = await res.json().catch(() => null);
    if (body?.snapshot?.at && body?.snapshot?.stale === false) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
await waitForSnapshot();

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();

async function admin(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
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

/** 直接写数据库：会话、账号、/health 的快照。 */
function db(): DatabaseSync {
  return new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
}

/**
 * 把上游打开。
 *
 * 上游的开关在数据库的 provider.enabled 上，环境变量不再参与。新装好的
 * 服务默认全关，所以测试自己打开这两个 —— 面板上做的是同一件事。
 */
async function enableUpstream(id: string): Promise<void> {
  const res = await admin("SetUpstreamEnabled", { upstreamId: id, enabled: true });
  if (!res?.ok) throw new Error(`the upstream ${id} did not turn on: ${JSON.stringify(res)}`);
}

await enableUpstream("sensenova");
await enableUpstream("intern-ai");

function writeSecret(id: string, kind: string, data: unknown): void {
  const conn = db();
  try {
    conn
      .prepare(
        "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      )
      .run(id, kind, JSON.stringify(data), Date.now());
  } finally {
    conn.close();
  }
}

function writeCached(id: string, data: unknown): void {
  const conn = db();
  try {
    conn
      .prepare("INSERT INTO cache (id, data, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at")
      .run(id, JSON.stringify(data), Date.now());
  } finally {
    conn.close();
  }
}

/** 一个上游现在的状态。 */
async function upstreamStateOf(id: string): Promise<string> {
  const res = await admin("ListUpstreams");
  const found = (res.upstreams ?? []).find((u: any) => u.id === id);
  return String(found?.state ?? "");
}

/** 一个上游的凭据状态。 */
async function upstreamCredentialOf(id: string): Promise<any> {
  const res = await admin("ListUpstreams");
  const found = (res.upstreams ?? []).find((u: any) => u.id === id);
  return found?.credential ?? null;
}

/* ------------------------------------------------------------------ *
 * 四、没有凭据的时候
 * ------------------------------------------------------------------ */

section("没有推理 key 的时候");

check("SenseNova 没有凭据 → UPSTREAM_STATE_NO_CREDENTIAL", (await upstreamStateOf("sensenova")) === "UPSTREAM_STATE_NO_CREDENTIAL", await upstreamStateOf("sensenova"));
check("书生·端砚没有凭据 → UPSTREAM_STATE_NO_CREDENTIAL", (await upstreamStateOf("intern-ai")) === "UPSTREAM_STATE_NO_CREDENTIAL", await upstreamStateOf("intern-ai"));
check(
  "SenseNova 的凭据是 api_key，状态是 missing",
  (await upstreamCredentialOf("sensenova"))?.kind === "api_key" &&
    (await upstreamCredentialOf("sensenova"))?.status === "CREDENTIAL_STATE_MISSING",
  JSON.stringify(await upstreamCredentialOf("sensenova")),
);
check(
  "书生·端砚的凭据是 api_key，状态是 missing",
  (await upstreamCredentialOf("intern-ai"))?.kind === "api_key" &&
    (await upstreamCredentialOf("intern-ai"))?.status === "CREDENTIAL_STATE_MISSING",
  JSON.stringify(await upstreamCredentialOf("intern-ai")),
);

// 登录态与推理 key 一起写进去 —— 这就是面板登录完之后的样子。
const now = Date.now();
writeSecret("session:sensenova", "session", {
  cookie: "oauth2_authentication_session=abc",
  accessToken: "sense-token",
  refreshToken: "sense-refresh",
  expiresAtMs: now + 3600_000,
  obtainedAtMs: now,
  username: "someone",
});
writeSecret("account:sensenova", "account", {
  user: "someone",
  password: "",
  apiKey: "sk-sensenova-test",
});
writeSecret("session:intern-ai", "session", {
  sites: [
    { name: "discovery", token: "intern-token", clientId: "dagw" },
    { name: "chat", token: "intern-token", clientId: "ebmr" },
  ],
  ssoUid: "sso-uid",
  obtainedAtMs: now,
  username: "someone",
});
writeSecret("account:intern-ai", "account", {
  user: "someone",
  password: "",
  discoveryKey: "sk-intern-test",
  chatKey: null,
});

check("有 key 之后 SenseNova → UPSTREAM_STATE_READY", (await upstreamStateOf("sensenova")) === "UPSTREAM_STATE_READY", await upstreamStateOf("sensenova"));
check("有 key 之后书生·端砚 → UPSTREAM_STATE_READY", (await upstreamStateOf("intern-ai")) === "UPSTREAM_STATE_READY", await upstreamStateOf("intern-ai"));
check(
  "凭据状态变成 authenticated",
  (await upstreamCredentialOf("sensenova"))?.status === "CREDENTIAL_STATE_AUTHENTICATED" &&
    (await upstreamCredentialOf("intern-ai"))?.status === "CREDENTIAL_STATE_AUTHENTICATED",
  JSON.stringify([await upstreamCredentialOf("sensenova"), await upstreamCredentialOf("intern-ai")]),
);

/* ------------------------------------------------------------------ *
 * 五、模型目录
 * ------------------------------------------------------------------ */

section("模型目录");

/** 等目录出来：目录是问上游要来的，要一小会儿。 */
async function waitForModels(group: string, count: number): Promise<any[]> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${base}/${group}/v1/models`);
    const body = await res.json();
    const models = body?.data ?? [];
    if (models.length >= count) return models;
    await new Promise((r) => setTimeout(r, 250));
  }
  return [];
}

const senseModels = await waitForModels("sensenova", 2);
check("SenseNova 的目录里有模型", senseModels.length >= 2, String(senseModels.length));
check(
  "SenseNova 的模型 id 是上游的那些",
  senseModels.some((m: any) => m.id === "sensenova-6.8-flash-lite") &&
    senseModels.some((m: any) => m.id === "deepseek-v4-flash"),
  JSON.stringify(senseModels.map((m: any) => m.id)),
);
const senseLite = senseModels.find((m: any) => m.id === "sensenova-6.8-flash-lite");
check("上下文是平台报的", senseLite?.context_window === 1048576, String(senseLite?.context_window));
check("输出上限是平台报的", senseLite?.max_output_tokens === 65536, String(senseLite?.max_output_tokens));
check("平台说能思考就是能思考", senseLite?.reasoning === true);
check("平台说能调工具就是能调工具", senseLite?.tool_call === true);

const internModels = await waitForModels("intern-ai", 2);
check("书生·端砚的目录里有模型", internModels.length >= 2, String(internModels.length));
check(
  "书生·端砚的模型 id 是上游的那些",
  internModels.some((m: any) => m.id === "intern-s2") &&
    internModels.some((m: any) => m.id === "qwen3.8-27b"),
  JSON.stringify(internModels.map((m: any) => m.id)),
);
const internS2 = internModels.find((m: any) => m.id === "intern-s2");
check("上下文是控制台那份清单给的", internS2?.context_window === 131072, String(internS2?.context_window));
check("能力是控制台那份清单给的", internS2?.tool_call === true && internS2?.reasoning === true);

/* ------------------------------------------------------------------ *
 * 六、一个请求真的能走通
 * ------------------------------------------------------------------ */

section("请求");

/** 客户端发一次请求。 */
async function chat(group: string, model: string, extra: Record<string, unknown> = {}, path = "chat/completions"): Promise<any> {
  const res = await fetch(`${base}/${group}/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "say ok" }],
      ...extra,
    }),
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

const senseChat = await chat("sensenova", "sensenova-6.8-flash-lite");
check("SenseNova 的请求通了", senseChat.status === 200, `HTTP ${senseChat.status} ${senseChat.text.slice(0, 160)}`);
check("答案有内容", Boolean(senseChat.json?.choices?.[0]?.message?.content));
check("用量算出来了", Number(senseChat.json?.usage?.prompt_tokens ?? 0) > 0);
check("请求真的走到了那个上游", seen.some((s) => s.path === "/sensenova/v1/chat/completions" && s.model === "sensenova-6.8-flash-lite"), JSON.stringify(seen));

const senseAnthropic = await chat(
  "sensenova",
  "sensenova-6.8-flash-lite",
  { max_tokens: 32 },
  "messages",
);
check("SenseNova 的 Anthropic 方言也通", senseAnthropic.status === 200, `HTTP ${senseAnthropic.status}`);
check("Anthropic 的形状是对的", Boolean(senseAnthropic.json?.content?.[0]?.text), senseAnthropic.text.slice(0, 160));

const internChat = await chat("intern-ai", "intern-s2");
check("书生·端砚的请求通了", internChat.status === 200, `HTTP ${internChat.status} ${internChat.text.slice(0, 160)}`);
check("答案有内容", Boolean(internChat.json?.choices?.[0]?.message?.content));
check("请求真的走到了那个上游", seen.some((s) => s.path === "/intern-ai/v1/chat/completions" && s.model === "intern-s2"), JSON.stringify(seen));

// 流式。
const streamed = await fetch(`${base}/sensenova/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "sensenova-6.8-flash-lite",
    messages: [{ role: "user", content: "say ok" }],
    stream: true,
  }),
});
const streamText = await streamed.text();
check("流式的状态码是 200", streamed.status === 200, `HTTP ${streamed.status}`);
check("流式是 SSE", (streamed.headers.get("content-type") ?? "").includes("text/event-stream"));
check("流式有帧", streamText.includes("data: "));
check("流式以 [DONE] 收尾", streamText.includes("data: [DONE]"));

// 不认识的模型要说清楚。
const unknown = await chat("sensenova", "no-such-model");
check("不认识的模型被拒了", unknown.status === 400, `HTTP ${unknown.status}`);
check(
  "错话说得清楚",
  String(unknown.json?.error?.message ?? "").startsWith("unknown model"),
  JSON.stringify(unknown.json),
);

// 上游关着的时候要说清楚。
await admin("SetUpstreamEnabled", { upstreamId: "sensenova", enabled: false });
const off = await chat("sensenova", "sensenova-6.8-flash-lite");
check("上游关着的时候被拒了", off.status === 400, `HTTP ${off.status}`);
check(
  "错话说得清楚（哪个上游没启用）",
  String(off.json?.error?.message ?? "").includes("not enabled"),
  JSON.stringify(off.json),
);
await admin("SetUpstreamEnabled", { upstreamId: "sensenova", enabled: true });

/* ------------------------------------------------------------------ *
 * 七、额度是积分，不是钱
 * ------------------------------------------------------------------ */

section("额度");

/** /health 的快照：额度用尽靠它。 */
function healthSnapshot(): unknown {
  return {
    qoder: {},
    minimax: { minimax: { balance: null, tokenPlan: null } },
    minimaxApi: {},
    zcode: {},
    workbuddy: { "workbuddy-cn": { credits: null } },
    tokenrhythm: { tokenrhythm: { tenants: [] } },
    sensenova: { sensenova: { pools: SENSE_POOLS } },
    internAi: { "intern-ai": { balance: INTERN_BALANCE, packs: INTERN_PACKS } },
  };
}

writeCached("health:upstreams:v2", healthSnapshot());

const withQuota = await admin("ListUpstreams");
const senseUpstream = (withQuota.upstreams ?? []).find((u: any) => u.id === "sensenova");
const internUpstream = (withQuota.upstreams ?? []).find((u: any) => u.id === "intern-ai");

check("SenseNova 的额度是积分", Boolean(senseUpstream?.quota?.credits), JSON.stringify(senseUpstream?.quota));
check("SenseNova 没有余额（它不是中转站）", senseUpstream?.quota?.balance === undefined, JSON.stringify(senseUpstream?.quota));
check(
  "SenseNova 的积分是活动积分（30 天到期的那种）",
  Number(senseUpstream?.quota?.credits?.remaining) === 5000,
  JSON.stringify(senseUpstream?.quota?.credits),
);
check(
  "只有活动积分不为 0 的池子才列一笔",
  (senseUpstream?.quota?.credits?.lots ?? []).length === 1,
  JSON.stringify(senseUpstream?.quota?.credits?.lots),
);
check(
  "通用池那一笔是活动积分，不是周期加活动",
  Number(senseUpstream?.quota?.credits?.lots?.[0]?.remaining) === 5000,
  JSON.stringify(senseUpstream?.quota?.credits?.lots),
);
check(
  "周期积分报成套餐额度：每个池子一个窗口",
  (senseUpstream?.quota?.tokenPlan?.windows ?? []).length === 2,
  JSON.stringify(senseUpstream?.quota?.tokenPlan?.windows),
);
check(
  "窗口的百分比是 remaining / limit",
  Number(senseUpstream?.quota?.tokenPlan?.windows?.[0]?.intervalPercent) === 98 &&
    Number(senseUpstream?.quota?.tokenPlan?.windows?.[0]?.weeklyPercent) === 98,
  JSON.stringify(senseUpstream?.quota?.tokenPlan?.windows),
);
check(
  "平台没报总额，总额就是 0（契约里 0 = 没报）",
  Number(senseUpstream?.quota?.credits?.total) === 0,
  JSON.stringify(senseUpstream?.quota?.credits),
);

check("书生·端砚的额度是积分", Boolean(internUpstream?.quota?.credits), JSON.stringify(internUpstream?.quota));
check("书生·端砚没有余额", internUpstream?.quota?.balance === undefined, JSON.stringify(internUpstream?.quota));
check(
  "墨点的余额是平台报的",
  Number(internUpstream?.quota?.credits?.remaining) === 1.698,
  JSON.stringify(internUpstream?.quota?.credits),
);
check(
  "墨点的总额是还在的批次的总量",
  Number(internUpstream?.quota?.credits?.total) === 10,
  JSON.stringify(internUpstream?.quota?.credits),
);
check(
  "已用的是平台报的",
  Number(internUpstream?.quota?.credits?.used) === 8.302,
  JSON.stringify(internUpstream?.quota?.credits),
);
check(
  "每一笔是一个墨点批次",
  (internUpstream?.quota?.credits?.lots ?? []).length === 1 &&
    internUpstream?.quota?.credits?.lots?.[0]?.sourceLabel === "每月免费基础包",
  JSON.stringify(internUpstream?.quota?.credits?.lots),
);
check(
  "批次的到期时间按平台的时区算",
  Number(internUpstream?.quota?.credits?.lots?.[0]?.expiresAt) === Date.parse("2099-12-31T00:00:00+08:00"),
  String(internUpstream?.quota?.credits?.lots?.[0]?.expiresAt),
);

// 走一遍真的那条路：网关自己去问平台（问的是假上游）。
// 快照刚刷过，所以要先过一会儿它才愿意再刷一次（网关不会把上游问得太勤）。
await new Promise((r) => setTimeout(r, 5500));
const balance = await admin("GetBalance", { upstreamId: "sensenova" });
const senseBalance = (balance.quotas ?? []).find((b: any) => b.upstreamId === "sensenova");
check("问平台得来的也是积分", Boolean(senseBalance?.credits), JSON.stringify(senseBalance));
check(
  "问平台得来的数与快照里的一样",
  Number(senseBalance?.credits?.remaining) === 5000,
  JSON.stringify(senseBalance?.credits),
);
check("问平台得来的没有余额", senseBalance?.balance === undefined, JSON.stringify(senseBalance));

/* ------------------------------------------------------------------ *
 * 八、额度用尽
 * ------------------------------------------------------------------ */

section("额度用尽");

// 池子里的积分都空了。
writeCached("health:upstreams:v2", {
  ...(healthSnapshot() as any),
  sensenova: { sensenova: { pools: SENSE_POOLS_EMPTY } },
});
check("SenseNova 的积分用尽 → UPSTREAM_STATE_OUT_OF_CREDITS", (await upstreamStateOf("sensenova")) === "UPSTREAM_STATE_OUT_OF_CREDITS", await upstreamStateOf("sensenova"));

// 墨点没了。
writeCached("health:upstreams:v2", {
  ...(healthSnapshot() as any),
  internAi: { "intern-ai": { balance: INTERN_BALANCE_EMPTY, packs: INTERN_PACKS } },
});
check("书生·端砚的墨点用尽 → UPSTREAM_STATE_OUT_OF_CREDITS", (await upstreamStateOf("intern-ai")) === "UPSTREAM_STATE_OUT_OF_CREDITS", await upstreamStateOf("intern-ai"));

// 窗口用满了也是用尽了。
writeCached("health:upstreams:v2", {
  ...(healthSnapshot() as any),
  internAi: { "intern-ai": { balance: INTERN_BALANCE_WINDOW, packs: INTERN_PACKS } },
});
check("窗口用尽了也是 OUT_OF_CREDITS", (await upstreamStateOf("intern-ai")) === "UPSTREAM_STATE_OUT_OF_CREDITS", await upstreamStateOf("intern-ai"));

// 额度回来了就又是 READY。
writeCached("health:upstreams:v2", healthSnapshot());
check("额度回来了 → UPSTREAM_STATE_READY", (await upstreamStateOf("intern-ai")) === "UPSTREAM_STATE_READY", await upstreamStateOf("intern-ai"));

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  console.log("查出来的问题：");
  for (const p of problems) console.log(`  - ${p}`);
}
if (fail) {
  console.log("");
  console.log("--- 网关的日志 ---");
  console.log(routerLog.slice(-4000));
}
cleanup();
process.exit(fail ? 1 : 0);
