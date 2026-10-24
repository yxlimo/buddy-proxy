// test/admin-contract-check.ts — 管理接口的契约、边界与静态托管的检查。
//
//   node --experimental-strip-types test/admin-contract-check.ts
//
// 起一个真的网关（上游全关，不花 token），把 proto/buddy/admin/v1/admin.proto
// 当标准答案：逐个方法核对请求与答复的字段名、类型与语义，再走一遍错误路径、
// 静态托管与 /health。
//
// 跟 admin-check.ts 的分工：那边看「方法答不答得上」，这边看「答的那份东西跟
// 契约是不是一回事」。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-admin-contract";
const SERVICE = "/buddy.admin.v1.AdminService";
const PROTO = path.join(ROOT, "proto/buddy/admin/v1/admin.proto");

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

/* ------------------------------------------------------------------ *
 * 契约的解析
 * ------------------------------------------------------------------ */

interface Field {
  /** proto 里的名字：upstream_id */
  name: string;
  /** JSON 里的名字：upstreamId */
  json: string;
  /** 字段的类型：string / int64 / CreditLot */
  type: string;
  repeated: boolean;
  optional: boolean;
}

interface Message {
  name: string;
  fields: Field[];
}

/** snake_case → camelCase：proto3 的 JSON 用后者。 */
function jsonName(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 从契约里读出消息与服务。 */
function parseProto(src: string): {
  messages: Map<string, Message>;
  methods: Map<string, { request: string; response: string }>;
} {
  const clean = src.replace(/\/\/[^\n]*/g, "");
  const messages = new Map<string, Message>();

  const re = /message\s+(\w+)\s*\{/g;
  // A message can hold another one; the inner one is part of the contract too.
  const queue: { name: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    while (i < clean.length && depth > 0) {
      const c = clean[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = clean.slice(start, i - 1);
    const fields: Field[] = [];
    for (const piece of body.split(";")) {
      const line = piece.trim();
      if (!line) continue;
      const f = /^(repeated\s+|optional\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+$/.exec(line);
      if (!f) continue;
      fields.push({
        name: f[3],
        json: jsonName(f[3]),
        type: f[2],
        repeated: Boolean(f[1]?.startsWith("repeated")),
        optional: Boolean(f[1]?.startsWith("optional")),
      });
    }
    messages.set(name, { name, fields });
    queue.push({ name, body });
    // The inner messages of this one: they were inside the body the scan just
    // stepped over.
    const inner = /message\s+(\w+)\s*\{/g;
    let im: RegExpExecArray | null;
    while ((im = inner.exec(body))) {
      const innerName = im[1];
      const innerStart = inner.lastIndex;
      let depth = 1;
      let j = innerStart;
      while (j < body.length && depth > 0) {
        const c = body[j];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      const innerBody = body.slice(innerStart, j - 1);
      const innerFields: Field[] = [];
      for (const piece of innerBody.split(";")) {
        const line = piece.trim();
        if (!line) continue;
        const f = /^(repeated\s+|optional\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+$/.exec(line);
        if (!f) continue;
        innerFields.push({
          name: f[3],
          json: jsonName(f[3]),
          type: f[2],
          repeated: Boolean(f[1]?.startsWith("repeated")),
          optional: Boolean(f[1]?.startsWith("optional")),
        });
      }
      if (!messages.has(innerName)) {
        messages.set(innerName, { name: innerName, fields: innerFields });
        queue.push({ name: innerName, body: innerBody });
      }
    }
  }
  void queue;

  const methods = new Map<string, { request: string; response: string }>();
  const rpc = /rpc\s+(\w+)\s*\(\s*([\w.]+)\s*\)\s*returns\s*\(\s*([\w.]+)\s*\)/g;
  while ((m = rpc.exec(clean))) {
    methods.set(m[1], { request: m[2], response: m[3] });
  }
  return { messages, methods };
}

const contract = parseProto(fs.readFileSync(PROTO, "utf8"));

/**
 * 一个值跟契约里的类型对不对得上。
 *
 * proto3 的 JSON：int64 是字符串（数字会丢精度），int32 是数字，optional 的
 * 字段不给就不出现在 JSON 里，repeated 的字段空的时候是 []。
 */
function typeError(type: string, value: unknown, where: string): string | null {
  switch (type) {
    case "string":
      return typeof value === "string" ? null : `${where} 要是字符串，拿到 ${typeof value}`;
    case "bool":
      return typeof value === "boolean" ? null : `${where} 要是布尔，拿到 ${typeof value}`;
    case "int32":
    case "uint32":
    case "sint32":
    case "double":
    case "float":
      return typeof value === "number" ? null : `${where} 要是数字，拿到 ${typeof value}`;
    case "int64":
    case "uint64":
    case "sint64":
      if (typeof value !== "string") return `${where} 要是字符串（int64 走字符串），拿到 ${typeof value}`;
      return /^-?\d+$/.test(value) ? null : `${where} 是 int64，但不是数字：${value}`;
    default:
      break;
  }
  const message = contract.messages.get(type);
  if (!message) return null;
  return messageError(message, value as Record<string, unknown>, where);
}

/** 一个消息跟契约对不对得上。返回第一处不对的地方。 */
function messageError(message: Message, value: unknown, where: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where} 要是对象，拿到 ${Array.isArray(value) ? "数组" : typeof value}`;
  }
  const obj = value as Record<string, unknown>;
  const known = new Map(message.fields.map((f) => [f.json, f]));
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) return `${where}.${key} 不在契约里`;
  }
  for (const field of message.fields) {
    const has = Object.prototype.hasOwnProperty.call(obj, field.json);
    if (!has) {
      // optional 的字段不给就不出现；消息类型的字段没值时也不出现；repeated
      // 的字段空的时候是 []，但也可能整个没写。别的字段都要在。
      if (field.optional) continue;
      if (field.repeated) continue;
      if (contract.messages.has(field.type)) continue;
      return `${where}.${field.json} 不在答复里`;
    }
    const raw = obj[field.json];
    if (field.repeated) {
      if (!Array.isArray(raw)) return `${where}.${field.json} 要是数组`;
      for (let i = 0; i < raw.length; i++) {
        const err = typeError(field.type, raw[i], `${where}.${field.json}[${i}]`);
        if (err) return err;
      }
      continue;
    }
    const err = typeError(field.type, raw, `${where}.${field.json}`);
    if (err) return err;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 网关
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

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const router = spawn(process.execPath, ["router-proxy.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    BUDDY_DATA_DIR: DATA_DIR,
    ROUTER_PORT: String(port),
    BENEFITS_DISABLED: "1",
    // 上游全关：不碰任何平台，也不花 token。
    MINIMAX_CODE: "",
    QODER_GLOBAL: "",
    QODER_CN: "",
    WORKBUDDY_CN: "",
    TOKENRHYTHM: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
router.stdout.on("data", (c: Buffer) => {
  log += c.toString();
});
router.stderr.on("data", (c: Buffer) => {
  log += c.toString();
});
process.on("exit", () => {
  try {
    router.kill("SIGTERM");
  } catch {
    /* 已经走了 */
  }
});

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        await res.text();
        return true;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!(await waitForHealth())) {
  console.log("  FAIL 网关没起来");
  console.log(log.slice(-800));
  process.exit(1);
}

const token = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();

/** 打一个 Connect 方法。 */
async function call(
  method: string,
  body: unknown = {},
  auth: string | null = token,
): Promise<{ status: number; body: any; contentType: string; text: string }> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, contentType: res.headers.get("content-type") ?? "", text };
}

/** 不带令牌打一个地址。 */
async function raw(p: string, init: RequestInit = {}): Promise<{ status: number; type: string; text: string }> {
  const res = await fetch(`${base}${p}`, init);
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", text };
}

console.log("");
console.log("契约：三十一个方法");

// 每个方法配一个像样的请求。
// 登录那六个：挑不会碰到网络的上游（密码流与回填流），不真的登录。
const CALLS: Array<{ method: string; request: unknown }> = [
  { method: "GetSystemStatus", request: {} },
  { method: "ListUpstreams", request: {} },
  { method: "SetUpstreamEnabled", request: { upstreamId: "qoder-cn", enabled: false } },
  { method: "ListConfig", request: {} },
  // 用一个后面不会改的键：后面要验「改之前没有待重启」。
  { method: "SetConfig", request: { key: "REQUIRE_API_KEY", value: "false" } },
  { method: "ListAccounts", request: {} },
  { method: "ListCredentials", request: { accountId: "" } },
  { method: "TestCredential", request: { credentialId: "nope:nope" } },
  { method: "RefreshCredential", request: { credentialId: "nope:nope" } },
  { method: "GetBalance", request: {} },
  { method: "GetUsageSummary", request: { upstreamId: "", window: "day" } },
  { method: "ListUsageEvents", request: { limit: 10 } },
  { method: "ListPublishedModels", request: {} },
  { method: "SavePublishedModel", request: { model: { id: "", displayName: "x" } } },
  { method: "DeletePublishedModel", request: { id: "nope" } },
  { method: "GetBenefitStatus", request: {} },
  { method: "RunBenefitNow", request: {} },
  { method: "ListModels", request: { upstreamId: "" } },
  { method: "TailLog", request: { lines: 5, filter: "" } },
  // 登录：密码流与回填流不碰网络，也不会真的登录。
  { method: "BeginLogin", request: { upstreamId: "sensenova" } },
  { method: "GetLoginStatus", request: { loginId: "no-such-login" } },
  { method: "CancelLogin", request: { loginId: "no-such-login" } },
  { method: "LoginWithPassword", request: { upstreamId: "qoder", username: "x", password: "y" } },
  { method: "ExchangeLoginCode", request: { upstreamId: "intern-ai", code: "" } },
  { method: "ImportLoginToken", request: { upstreamId: "intern-ai", token: "" } },
  { method: "SetProviderKeys", request: { upstreamId: "minimax-api", keys: [] } },
  { method: "ListProviderKinds", request: {} },
  { method: "AddProvider", request: { id: "contract-provider", kind: "minimax-api" } },
  { method: "UpdateProvider", request: { id: "contract-provider", alias: "契约" } },
  { method: "DeleteProvider", request: { id: "contract-provider" } },
  { method: "LogoutAccount", request: { accountId: "contract-provider" } },
];

check("契约里有三十二个方法", contract.methods.size === 32, String(contract.methods.size));
// RestartSystem 会让进程退出，单独在最后试。
check(
  "测的方法与契约一一对上（RestartSystem 单独试）",
  CALLS.length + 1 === contract.methods.size && CALLS.every((c) => contract.methods.has(c.method)),
  `${CALLS.length} vs ${contract.methods.size}`,
);

for (const { method, request } of CALLS) {
  const spec = contract.methods.get(method);
  if (!spec) {
    check(`${method} 在契约里`, false);
    continue;
  }
  const res = await call(method, request);
  if (res.status !== 200) {
    check(`${method} 答得上来`, false, `${res.status} ${res.text.slice(0, 120)}`);
    continue;
  }
  const err = messageError(contract.messages.get(spec.response)!, res.body, method);
  check(`${method} 的答复跟契约一致`, err === null, err ?? "");
}

// 请求的字段名：契约里没有的名字要被拒（或者至少不能被当成值）。
const specListCred = contract.methods.get("ListCredentials")!;
check("ListCredentials 的请求有 accountId", specListCred.request === "ListCredentialsRequest");
const reqMsg = contract.messages.get("ListCredentialsRequest")!;
check(
  "ListCredentialsRequest 只有 accountId",
  reqMsg.fields.length === 1 && reqMsg.fields[0].json === "accountId",
  JSON.stringify(reqMsg.fields.map((f) => f.json)),
);

const badField = await call("ListCredentials", { accountid: "qoder-cn" });
check("请求里拼错的字段名被忽略（不是 400）", badField.status === 200, String(badField.status));

const badType = await call("ListCredentials", { accountId: 123 });
check("请求里类型不对的是 400", badType.status === 400, String(badType.status));
check("类型不对的答复是 JSON", (badType.contentType ?? "").includes("json"), badType.contentType);

console.log("");
console.log("语义：敏感项、继承、余额、游标、时间");

// ListConfig：敏感项的值是空串，hasValue 单独说有没有值。
const config = await call("ListConfig");
const items: any[] = Array.isArray(config.body?.items) ? config.body.items : [];
check("配置项列出来了", items.length > 0, String(items.length));
const secrets = items.filter((i) => i.secret === true);
// 目前没有真正带密钥的配置项（凭据在 secrets 表里，不在配置里），所以这里
// 不断言「一定有敏感项」——断言的是处理方式：敏感项的值是空串、不带真值。
check("敏感项的值是空串", secrets.every((i) => i.value === ""), JSON.stringify(secrets.slice(0, 2)));
check("敏感项有 hasValue", secrets.every((i) => typeof i.hasValue === "boolean"), JSON.stringify(secrets.slice(0, 2)));
check(
  "敏感项的 value 里没有真值",
  secrets.every((i) => !/…|\*/.test(i.value)),
  JSON.stringify(secrets.slice(0, 2)),
);
check(
  "没有掩码一样的值",
  items.every((i) => i.value !== "***"),
  JSON.stringify(items.filter((i) => i.value === "***").map((i) => i.key)),
);
// REQUIRE_API_KEY 是开关，不是密钥：名字撞上了 _KEY 后缀而已，值要看得见。
const requireKey = items.find((i) => i.key === "REQUIRE_API_KEY");
check("开关类的键不是敏感项", requireKey?.secret === false, JSON.stringify(requireKey));
const plain = items.filter((i) => i.secret !== true);
check("不敏感的项有值", plain.every((i) => typeof i.value === "string"), JSON.stringify(plain.slice(0, 2)));
check(
  "来源是三种之一",
  items.every((i) => ["database", "environment", "default"].includes(i.source)),
  JSON.stringify(items.map((i) => i.source).filter((s) => !["database", "environment", "default"].includes(s))),
);

// ListPublishedModels：optional 的字段不给就不在 JSON 里；给了就在。
const saveInherit = await call("SavePublishedModel", {
  model: {
    id: "contract-inherit",
    displayName: "继承",
    strategy: "single",
    enabled: true,
    targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
  },
});
check("模型存得进去", saveInherit.body?.ok === true, JSON.stringify(saveInherit.body));

const saveExplicit = await call("SavePublishedModel", {
  model: {
    id: "contract-explicit",
    displayName: "写死",
    strategy: "single",
    enabled: true,
    contextWindow: 123456,
    maxOutputTokens: 4096,
    reasoning: false,
    toolCall: true,
    effortOptions: ["low", "high"],
    targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
  },
});
check("带元数据的模型存得进去", saveExplicit.body?.ok === true, JSON.stringify(saveExplicit.body));

const listed = await call("ListPublishedModels");
const models: any[] = Array.isArray(listed.body?.models) ? listed.body.models : [];
const inheritModel = models.find((m) => m.id === "contract-inherit");
const explicitModel = models.find((m) => m.id === "contract-explicit");
check("继承的模型读得回来", Boolean(inheritModel));
check(
  "继承的 optional 字段不在 JSON 里",
  inheritModel &&
    inheritModel.contextWindow === undefined &&
    inheritModel.maxOutputTokens === undefined &&
    inheritModel.reasoning === undefined &&
    inheritModel.toolCall === undefined,
  JSON.stringify(inheritModel),
);
check(
  "给定的 optional 字段读得回来",
  explicitModel &&
    explicitModel.contextWindow === 123456 &&
    explicitModel.maxOutputTokens === 4096 &&
    explicitModel.reasoning === false &&
    explicitModel.toolCall === true,
  JSON.stringify(explicitModel),
);
check("effortOptions 读得回来", Array.isArray(explicitModel?.effortOptions), JSON.stringify(explicitModel?.effortOptions));

// GetBalance：每条额度带着上游与账号。余额、积分、套餐额度是三样东西，
// 各是各的 —— 不能混着看。
const balance = await call("GetBalance");
const quotas: any[] = Array.isArray(balance.body?.quotas) ? balance.body.quotas : [];
check("额度答得上来", balance.status === 200);
check(
  "每条额度有 upstreamId 与 accountId",
  quotas.every((q) => typeof q.upstreamId === "string" && q.upstreamId.length > 0 && typeof q.accountId === "string" && q.accountId.length > 0),
  JSON.stringify(quotas.slice(0, 2)),
);
check(
  "余额的批次带着到期时间",
  quotas.every((q) => (q.balance?.lots ?? []).every((l: any) => typeof l.id === "string" && l.expiresAt !== undefined)),
  JSON.stringify(quotas.slice(0, 1)),
);
check(
  "积分的批次带着到期时间",
  quotas.every((q) => (q.credits?.lots ?? []).every((l: any) => typeof l.id === "string" && l.expiresAt !== undefined)),
  JSON.stringify(quotas.slice(0, 1)),
);
check(
  "一条额度不会同时是余额和积分",
  quotas.every((q) => !(q.balance && q.credits)),
  JSON.stringify(quotas.filter((q) => q.balance && q.credits)),
);
const oneBalance = await call("GetBalance", { upstreamId: "tokenrhythm" });
check(
  "额度能按上游筛",
  Array.isArray(oneBalance.body?.quotas) && oneBalance.body.quotas.every((q: any) => q.upstreamId === "tokenrhythm"),
  JSON.stringify(oneBalance.body?.quotas?.map((q: any) => q.upstreamId)),
);
check(
  "TokenRhythm 报的是余额（钱），不是积分",
  oneBalance.body?.quotas?.every((q: any) => q.balance && !q.credits),
  JSON.stringify(oneBalance.body?.quotas),
);

// GetSystemStatus：面板能改的设置是热的，改完就生效，没有待重启的东西。
const before = await call("GetSystemStatus");
check("改之前没有待重启", before.body?.pendingRestart === false, JSON.stringify(before.body?.pendingRestart));
const setConfig = await call("SetConfig", { key: "ADMIN_CORS_ORIGINS", value: "123456" });
check("配置改得掉", setConfig.body?.ok === true, JSON.stringify(setConfig.body));
check("改完立刻生效", setConfig.body?.pendingRestart === false, JSON.stringify(setConfig.body));
const after = await call("GetSystemStatus");
check("改之后也没有待重启", after.body?.pendingRestart === false, JSON.stringify(after.body?.pendingRestart));
const setUpstream = await call("SetUpstreamEnabled", { upstreamId: "qoder-cn", enabled: true });
check("上游开关改得掉", setUpstream.body?.ok === true, JSON.stringify(setUpstream.body));
check("改了上游立刻生效", setUpstream.body?.pendingRestart === false, JSON.stringify(setUpstream.body));
const listConfigAfter = await call("ListConfig");
check(
  "改了之后配置项的来源是 database",
  listConfigAfter.body?.items?.some((i: any) => i.key === "ADMIN_CORS_ORIGINS" && i.source === "database"),
  JSON.stringify(listConfigAfter.body?.items?.find((i: any) => i.key === "ADMIN_CORS_ORIGINS")),
);

// 上游的开关：enabled 是现在在生效的值。开关是热的，改完就生效。
const switched = await call("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true });
check("上游开关改得掉", switched.body?.ok === true, JSON.stringify(switched.body));
const afterSwitch = await call("ListUpstreams");
const switchedUpstream = (afterSwitch.body?.upstreams ?? []).find((u: any) => u.id === "qoder");
check("改完 enabled 是改后的值", switchedUpstream?.enabled === true, JSON.stringify(switchedUpstream));
// 答复里没有「待生效」这个字段了。
check("上游没有待生效的字段", !("pending" in (switchedUpstream ?? {})), JSON.stringify(switchedUpstream));

// 配置项：每项都有给人看的名字，名字不是 env 的键名。
check("配置项都有名字", items.every((i: any) => typeof i.label === "string" && i.label.length > 0));
check("名字不是键名", items.every((i: any) => i.label !== i.key));
check(
  "名字不是 env 键名的样子",
  items.every((i: any) => !/^[A-Z][A-Z0-9_]+$/.test(i.label)),
  JSON.stringify(items.filter((i: any) => /^[A-Z][A-Z0-9_]+$/.test(i.label)).map((i: any) => i.key)),
);

// 套餐额度：只有 MiniMax 有这个。
check(
  "套餐额度只有 MiniMax 有",
  quotas.every((q: any) => q.tokenPlan === undefined || q.upstreamId === "minimax"),
  JSON.stringify(quotas.map((q: any) => [q.upstreamId, q.tokenPlan !== undefined])),
);

// 时间：毫秒还是秒。
const upstreams = await call("ListUpstreams");
const list: any[] = Array.isArray(upstreams.body?.upstreams) ? upstreams.body.upstreams : [];

// 三个枚举：值只能是契约里那几个。
const UPSTREAM_STATES = [
  "UPSTREAM_STATE_READY",
  "UPSTREAM_STATE_DISABLED",
  "UPSTREAM_STATE_NO_CREDENTIAL",
  "UPSTREAM_STATE_CREDENTIAL_EXPIRED",
  "UPSTREAM_STATE_CREDENTIAL_REJECTED",
  "UPSTREAM_STATE_OUT_OF_CREDITS",
  "UPSTREAM_STATE_LOGGING_IN",
];
const CREDENTIAL_STATES = [
  "CREDENTIAL_STATE_AUTHENTICATED",
  "CREDENTIAL_STATE_MISSING",
  "CREDENTIAL_STATE_EXPIRED",
  "CREDENTIAL_STATE_ERROR",
  "CREDENTIAL_STATE_USABLE",
  "CREDENTIAL_STATE_ANONYMOUS",
];
const UNPUBLISHED_REASONS = [
  "UNPUBLISHED_REASON_DISABLED",
  "UNPUBLISHED_REASON_UPSTREAM_DISABLED",
  "UNPUBLISHED_REASON_NO_CREDENTIAL",
  "UNPUBLISHED_REASON_MODEL_GONE",
  "UNPUBLISHED_REASON_TARGET_DISABLED",
  "UNPUBLISHED_REASON_NO_TARGET",
];
check(
  "上游的 state 是契约里的枚举",
  list.every((u: any) => UPSTREAM_STATES.includes(u.state)),
  JSON.stringify(list.map((u: any) => u.state)),
);
check(
  "凭据的 status 是契约里的枚举",
  list.every((u: any) => CREDENTIAL_STATES.includes(u.credential?.status)),
  JSON.stringify(list.map((u: any) => u.credential?.status)),
);
const publishedModels = await call("ListPublishedModels");
const publishedList: any[] = Array.isArray(publishedModels.body?.models) ? publishedModels.body.models : [];
check(
  "没公布的原因是契约里的枚举（公布了就没有这个字段）",
  publishedList.every((m: any) => m.unpublishedReason === undefined || UNPUBLISHED_REASONS.includes(m.unpublishedReason)),
  JSON.stringify(publishedList.map((m: any) => [m.id, m.unpublishedReason])),
);
check(
  "公布了就没有理由，没公布一定有理由",
  publishedList.every((m: any) => (m.published === true) === (m.unpublishedReason === undefined)),
  JSON.stringify(publishedList.map((m: any) => [m.id, m.published, m.unpublishedReason])),
);

const cred = list.map((u) => u.credential).find((c) => c && c.expiresAt !== "0");
check("有一个带到期时间的凭据", Boolean(cred), JSON.stringify(list.map((u) => u.credential?.status)));
if (cred) {
  const expires = Number(cred.expiresAt);
  const remaining = Number(cred.remainingSec);
  check("expiresAt 是毫秒", expires > 1_000_000_000_000, String(expires));
  check("remainingSec 是秒", remaining > 0 && remaining < 100_000_000, String(remaining));
  check(
    "两者说的是同一件事",
    Math.abs(expires - (Date.now() + remaining * 1000)) < 120_000,
    `${expires} vs ${Date.now() + remaining * 1000}`,
  );
}
const status = await call("GetSystemStatus");
check("uptimeSec 是秒", Number(status.body?.uptimeSec) >= 0 && Number(status.body?.uptimeSec) < 100_000, String(status.body?.uptimeSec));

// GetUsageSummary 的窗口。
for (const w of ["hour", "day", "week", "month", "24h", "3d", "12h", "", "all"]) {
  const res = await call("GetUsageSummary", { window: w });
  check(`窗口 ${w || "(空)"} 答得上来`, res.status === 200 && res.body?.total !== undefined, String(res.status));
}

// ListUsageEvents：游标翻页不重不漏。
const events = await call("ListUsageEvents", { limit: 100 });
const list0: any[] = Array.isArray(events.body?.events) ? events.body.events : [];
check("用量明细答得上来", events.status === 200);
if (list0.length >= 2) {
  const descending = list0.every((e, i) => i === 0 || BigInt(list0[i - 1].id) > BigInt(e.id));
  check("新的在前", descending, JSON.stringify(list0.map((e) => e.id)));
  const cursor = list0[list0.length - 1].id;
  const next = await call("ListUsageEvents", { limit: 100, beforeId: cursor });
  const second: any[] = Array.isArray(next.body?.events) ? next.body.events : [];
  check("游标只给更早的那些", second.every((e) => BigInt(e.id) < BigInt(cursor)), JSON.stringify(second.map((e) => e.id)));
  check("游标翻页不重复", !second.some((e) => list0.some((f) => f.id === e.id)));
  const union = [...list0, ...second].map((e) => e.id);
  check("游标翻页不漏", new Set(union).size === union.length, JSON.stringify(union));
  check("明细的 client 是空串", list0.every((e) => e.client === ""), JSON.stringify(list0.map((e) => e.client)));
  check("明细的 ts 是毫秒", list0.every((e) => Number(e.ts) > 1_000_000_000_000), JSON.stringify(list0.map((e) => e.ts)));
} else {
  console.log("  --   没有用量行，游标那几项跳过");
}

// 别的窗口取值也不是 400。
for (const w of ["nonsense", "7d", "1h", "30d", "week"]) {
  const res = await call("GetUsageSummary", { window: w });
  check(`窗口 ${w} 不报错`, res.status === 200, String(res.status));
}

console.log("");
console.log("错误路径");

const noToken = await call("GetSystemStatus", {}, null);
check("没有令牌是 401", noToken.status === 401, String(noToken.status));
check("没有令牌的答复是 JSON", (noToken.contentType ?? "").includes("json"), noToken.contentType);
check("没有令牌说的是没鉴权", noToken.body?.code === "unauthenticated", JSON.stringify(noToken.body));

const badToken = await call("GetSystemStatus", {}, "not-the-token");
check("令牌不对是 401", badToken.status === 401, String(badToken.status));

const noSpace = await fetch(`${base}${SERVICE}/GetSystemStatus`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer${token}` },
  body: "{}",
});
check("没有空格的 Bearer 也认", noSpace.status === 200, String(noSpace.status));

const unknown = await call("NoSuchMethod", {});
check("不知道的方法是 404", unknown.status === 404, String(unknown.status));
check("不知道的方法的答复是 JSON", (unknown.contentType ?? "").includes("json"), unknown.contentType);
check("不知道的方法说的是没这个方法", unknown.body?.code === "unimplemented", JSON.stringify(unknown.body));

const badJson = await fetch(`${base}${SERVICE}/GetSystemStatus`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: "{not json",
});
const badJsonText = await badJson.text();
check("坏 JSON 是 4xx", badJson.status >= 400 && badJson.status < 500, String(badJson.status));
check("坏 JSON 的答复是 JSON 不是 HTML", (badJson.headers.get("content-type") ?? "").includes("json"), badJson.headers.get("content-type") ?? "");
check("坏 JSON 的答复说得清是什么错", badJsonText.includes("invalid_argument"), badJsonText.slice(0, 120));

const options = await fetch(`${base}${SERVICE}/GetSystemStatus`, { method: "OPTIONS" });
check("OPTIONS 是 204", options.status === 204, String(options.status));

console.log("");
console.log("/health");

const health = await raw("/health");
check("/health 不带令牌也能访问", health.status === 200, String(health.status));
const healthBody = JSON.parse(health.text);
check("/health 的形状没变", healthBody?.status === "ok" && Array.isArray(healthBody?.dialects), health.text.slice(0, 120));
check(
  "/health 里有各上游",
  Boolean(healthBody?.upstreams?.minimax) && Boolean(healthBody?.upstreams?.qoder) && Boolean(healthBody?.upstreams?.workbuddy),
  JSON.stringify(Object.keys(healthBody?.upstreams ?? {})),
);
check("/health 里有开关", typeof healthBody?.enabled?.minimax === "boolean", JSON.stringify(healthBody?.enabled));
check("/health 里有快照", Boolean(healthBody?.snapshot?.maxAgeMs), JSON.stringify(healthBody?.snapshot));
check("/health 里有权益", Boolean(healthBody?.benefits), JSON.stringify(healthBody?.benefits));
check("/health 里没有令牌", !health.text.includes(token));

console.log("");
console.log("面板的静态托管");

const index = await raw("/admin");
check("/admin 答得上来", index.status === 200, String(index.status));
check("/admin 答的是 HTML", index.type.includes("text/html"), index.type);
const indexSlash = await raw("/admin/");
check("/admin/ 答得上来", indexSlash.status === 200, String(indexSlash.status));
const deep = await raw("/admin/config");
check("/admin/config 是深链接", deep.status === 200, String(deep.status));
check("/admin/config 答的是 index.html", deep.text.includes("<div id=\"root\">"), deep.text.slice(0, 120));
const deepUsage = await raw("/admin/usage?window=day");
check("/admin/usage 带查询串也答得上来", deepUsage.status === 200, String(deepUsage.status));

const assetMatch = /src="(\/admin\/assets\/[^"]+\.js)"/.exec(index.text);
check("index.html 里的静态资源带 /admin/ 前缀", Boolean(assetMatch), index.text.slice(0, 200));
if (assetMatch) {
  const asset = await raw(assetMatch[1]);
  check("静态资源答得上来", asset.status === 200, String(asset.status));
  check("静态资源的类型是 JS", asset.type.includes("javascript"), asset.type);
  const rootAsset = await raw(assetMatch[1].replace("/admin", ""));
  check("根上的那一份静态资源也答得上来", rootAsset.status === 200, String(rootAsset.status));
}

const missingAsset = await raw("/admin/assets/does-not-exist.js");
check(
  "不存在的静态资源是 404",
  missingAsset.status === 404,
  `${missingAsset.status} ${missingAsset.type}`,
);
const missingRoute = await raw("/admin/does-not-exist-page");
check(
  "不存在的深链接回 index.html",
  missingRoute.status === 200 && missingRoute.type.includes("text/html"),
  `${missingRoute.status} ${missingRoute.type}`,
);

const postDeep = await fetch(`${base}/admin/config`, { method: "POST" });
check("深链接不接受 POST", postDeep.status === 404, String(postDeep.status));
check("深链接的 404 是 JSON", (postDeep.headers.get("content-type") ?? "").includes("json"), postDeep.headers.get("content-type") ?? "");

const traversal = await rawSocket("GET /admin/../../etc/passwd HTTP/1.1");
check("目录穿越被挡住", traversal.includes("403"), traversal.split("\r\n")[0]);

/** 不让库把路径改掉：自己发一个请求。 */
function rawSocket(request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${request}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (c: Buffer) => {
      text += c.toString();
    });
    socket.on("close", () => resolve(text));
    socket.on("error", () => resolve(text));
    setTimeout(() => socket.destroy(), 3000);
  });
}

const oldRoute = await raw("/admin/usage");
check("老的 JSON 路由没了", !oldRoute.text.includes('"data"'), oldRoute.text.slice(0, 80));

console.log("");
console.log("重启");

// RestartSystem 会让进程退出去，所以另起一个网关来试。
const restartPort = await freePort();
const restartData = "/tmp/opencode/test-admin-contract-restart";
fs.rmSync(restartData, { recursive: true, force: true });
fs.mkdirSync(restartData, { recursive: true, mode: 0o700 });
const restartRouter = spawn(process.execPath, ["router-proxy.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    BUDDY_DATA_DIR: restartData,
    ROUTER_PORT: String(restartPort),
    BENEFITS_DISABLED: "1",
    MINIMAX_CODE: "",
    QODER_GLOBAL: "",
    QODER_CN: "",
    WORKBUDDY_CN: "",
    TOKENRHYTHM: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const restartBase = `http://127.0.0.1:${restartPort}`;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${restartBase}/health`);
    if (res.ok) {
      await res.text();
      up = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 250));
}
check("另一个网关起来了", up);
if (up) {
  const restartToken = fs.readFileSync(path.join(restartData, "admin-token"), "utf8").trim();
  const res = await fetch(`${restartBase}${SERVICE}/RestartSystem`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${restartToken}` },
    body: "{}",
  });
  const body = await res.json().catch(() => null);
  check("RestartSystem 答得上来", res.status === 200, String(res.status));
  check("RestartSystem 说接下了", body?.accepted === true, JSON.stringify(body));
  // 进程会自己退出去。
  let exited = false;
  restartRouter.on("exit", () => {
    exited = true;
  });
  for (let i = 0; i < 40 && !exited; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  check("RestartSystem 之后进程退了出去", exited);
}
try {
  restartRouter.kill("SIGTERM");
} catch {
  /* 已经走了 */
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
try {
  router.kill("SIGTERM");
} catch {
  /* 已经走了 */
}
process.exit(fail ? 1 : 0);
