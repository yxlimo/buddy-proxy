// test/qoder-models-check.ts — which key each model goes out as, and where.
//
//   node --experimental-strip-types test/qoder-models-check.ts
//
// 离线：假上游在本机，请求是真的（签名、编码都是真的），一个字都不出机器。
//
// 为什么要有这个：上游只有一套协议了（CLI 自己的 COSY），但密钥有两套词汇
// 表 —— 普通的那套（`qmodel` / `kmodel` / …）与带版本号的那套（`dfmodel` /
// `kmodel_latest` / …）。两套都在同一个端点上被受理，所以「面板上的模型 id」
// 到「线上发出去的 key」这一层映射是唯一可能错的地方，而错了只会在真请求时
// 才看得出来（上游回 invalid_model_error）。这里把它钉住：
//
//   1. 每一个模型 id 发出去的 key 就是表里那一个（含 tier 按 effort 换 key）；
//   2. 请求走的是老协议那条路，路径与上限与官方客户端一致；
//   3. 两个区都列全部模型，只有 CN 那个永远排不上队的深寻被拿掉；
//   4. 端点只剩一个（没有第二种协议），面板看到的基础地址就是它去掉路径。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-models-"));
process.env.BUDDY_DATA_DIR = tmp;

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

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

interface Seen {
  region: string;
  path: string;
  key: string;
  displayName: string;
  maxTokens: unknown;
  reasoning: unknown;
  contextWindow: unknown;
}

const seen: Seen[] = [];

/** 收到一个老协议请求：把编码的正文解回来，记下上游真正认的那几个字段。 */
const { decodeLegacyBody, legacyModelKey, legacyChunk, legacyEnd } = await import("./legacy-wire.ts");

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = decodeLegacyBody(raw);
  const url = req.url ?? "";
  const region = url.startsWith("/cn") ? "cn" : "global";
  seen.push({
    region,
    path: url.split("?")[0] ?? "",
    key: legacyModelKey(body),
    displayName: String(body?.model_config?.display_name ?? ""),
    maxTokens: body?.parameters?.max_tokens,
    reasoning: body?.model_config?.is_reasoning,
    contextWindow: body?.model_config?.max_input_tokens,
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(legacyChunk("ok") + legacyEnd());
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
const fake = `http://127.0.0.1:${port}`;

// 端点在模块加载时读环境：两个区都指到假上游。
process.env.QODER_GLOBAL_LEGACY_BASE = `${fake}/global`;
process.env.QODER_CN_INFER_BASE = `${fake}/cn`;

/* ------------------------------------------------------------------ *
 * 假会话
 * ------------------------------------------------------------------ */

const { setSecret } = await import("../lib/store.ts");
const { addAccount } = await import("../lib/providers.ts");
const { closeStore } = await import("../lib/store.ts");

const accountId = String(addAccount({ platform: "qoder" }).id);
const now = Date.now();
setSecret(`session:provider:${accountId}`, "session", {
  schemaVersion: 1,
  region: "global",
  clientId: "test-client",
  accessToken: "dt-test-access-token", // privacy:allow — 编造的样例
  refreshToken: "drt-test-refresh-token", // privacy:allow — 编造的样例
  userId: "00000000-0000-0000-0000-000000000000",
  expiresAtMs: now + 365 * 24 * 3600 * 1000,
  refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
  machineId: "00000000-0000-4000-8000-000000000000",
  machineToken: "test-machine-token", // privacy:allow — 编造的样例
  machineType: "test-machine-type",
  generation: 1,
  loginAtMs: now,
  refreshedAtMs: now,
});

const { ENDPOINTS, LEGACY_PATH } = await import("../lib/qoder/auth.ts");
const { legacyChatCompletion } = await import("../lib/qoder/legacy.ts");
const { qoderModelsForRegion, resolveModelRoute, QODER_MODELS, QODER_CLIENT_MAX_TOKENS, getQoderModel } =
  await import("../lib/qoder/models.ts");

/**
 * 上游的 key，一个模型一个 —— 按实测的词汇表写死，不从 QODER_MODELS 抄。
 *
 * 抄的话这一层就只剩「代码等于自己」，模型表里写错了 key 也不会红。这里要的是
 * 「面板上的 id」与「上游认的字」之间那份对照，所以左边是 id，右边是上游的 key。
 */
const WIRE_KEYS: Record<string, string> = {
  "qwen3.7-plus": "qmodel",
  "kimi-k2.8-preview": "kmodel",
  "glm-5.3": "gmodel",
  "deepseek-v4-pro": "dmodel",
  "minimax-m3.1-flash": "mmodel",
  "deepseek-flash": "dfmodel",
  "qwen3.8-flash": "qfmodel",
  "qwen3.8-max": "qmodel_38max",
  "qwen3.7-max": "qmodel_latest",
  "kimi-k3": "kmodel_latest",
  "glm-5.3-flash": "gfmodel",
  sonus: "smodel",
};

/* ------------------------------------------------------------------ *
 * 1. id → key
 * ------------------------------------------------------------------ */

section("1. 每个模型 id 发出去的 key");

for (const [id, key] of Object.entries(WIRE_KEYS)) {
  const resolved = resolveModelRoute(id);
  check(`${id} → ${key}`, resolved.key === key && resolved.model?.id === id, JSON.stringify(resolved.key));
}

// tier：effort 换成 key，两个区不一样（CN 的目录里没有 ultimate）。
check("auto（不给 effort）→ auto", resolveModelRoute("auto").key === "auto", resolveModelRoute("auto").key);
check(
  "auto + high → ultimate",
  resolveModelRoute("auto", "high").key === "ultimate",
  resolveModelRoute("auto", "high").key,
);
check(
  "auto + low → auto",
  resolveModelRoute("auto", "low").key === "auto",
  resolveModelRoute("auto", "low").key,
);
check(
  "CN 的 auto 永远落在 auto（它的目录里没有 ultimate）",
  resolveModelRoute("auto", "high", "cn").key === "auto",
  resolveModelRoute("auto", "high", "cn").key,
);

// 不认识的 id 原样发出去：上游会回一句清楚的话，比网关猜一个强。
{
  const unknown = resolveModelRoute("not-a-qoder-model");
  check("不认识的 id 原样传出去", unknown.key === "not-a-qoder-model" && unknown.model === undefined, JSON.stringify(unknown));
}

/* ------------------------------------------------------------------ *
 * 2. 线上：key、路径、上限
 * ------------------------------------------------------------------ */

section("2. 发出去的那条请求：老协议那条路，key 就是那个");

/** 按面板上的 id 发一次（解析与网关同一条路：resolveModelRoute → legacy）。 */
async function send(id: string, effort?: string, region: "global" | "cn" = "global") {
  const { model, key } = resolveModelRoute(id, effort, region);
  await legacyChatCompletion(
    {
      messages: [{ role: "user", content: "say ok" }],
      modelKey: key,
      displayName: model?.name ?? key,
      maxTokens: QODER_CLIENT_MAX_TOKENS,
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.context,
    },
    { providerId: accountId, region },
  );
  return seen[seen.length - 1]!;
}

for (const id of ["qwen3.7-plus", "minimax-m3.1-flash", "glm-5.3", "deepseek-v4-pro", "kimi-k2.8-preview", "auto"]) {
  const expected = id === "auto" ? "ultimate" : WIRE_KEYS[id]!;
  const got = await send(id, "high");
  check(`${id} 线上发的是 ${expected}`, got.key === expected, got.key);
  check(
    `${id} 走的是老协议那条路`,
    got.path === `/global${LEGACY_PATH}`,
    got.path,
  );
  check(`${id} 的上限是客户端的 32000`, got.maxTokens === QODER_CLIENT_MAX_TOKENS, String(got.maxTokens));
}

{
  const got = await send("deepseek-flash", undefined, "cn");
  check("CN 的深寻闪照旧发 dfmodel", got.key === "dfmodel", got.key);
  check("CN 打的是 CN 那个主机", got.region === "cn" && got.path === `/cn${LEGACY_PATH}`, got.path);
}

{
  // 面板上的显示名要一起发：上游按它选后端，面板上的名字与上游的对不上时，
  // 客户端就会收到一个自己没听说过的模型。
  const got = await send("glm-5.3");
  check("display_name 是模型表里的那个", got.displayName === "GLM-5.3", got.displayName);
  check("reasoning 也跟着模型走", got.reasoning === true, String(got.reasoning));
  check("context_window 也跟着模型走", got.contextWindow === 180000, String(got.contextWindow));
}

/* ------------------------------------------------------------------ *
 * 3. 两个区的模型列表
 * ------------------------------------------------------------------ */

section("3. 两个区都列全部模型（没有按协议过滤了）");

{
  const global = qoderModelsForRegion("global");
  check(
    "全球区一个不少",
    global.length === QODER_MODELS.length,
    `${global.length}/${QODER_MODELS.length}`,
  );
  check(
    "全球区里有 tier",
    global.some((m) => m.kind === "tier"),
    JSON.stringify(global.map((m) => m.id)),
  );
  check(
    "全球区里有普通 key 的模型",
    global.some((m) => m.id === "glm-5.3") && global.some((m) => m.id === "qwen3.7-plus"),
    JSON.stringify(global.map((m) => m.id)),
  );
  check(
    "全球区里也有带版本号的模型（它们老协议照样受理）",
    global.some((m) => m.id === "deepseek-flash") && global.some((m) => m.id === "kimi-k3"),
    JSON.stringify(global.map((m) => m.id)),
  );

  const cn = qoderModelsForRegion("cn");
  check(
    "CN 只少掉那个永远排不上队的深寻",
    cn.length === QODER_MODELS.length - 1 && !cn.some((m) => m.id === "deepseek-flash"),
    `${cn.length}/${QODER_MODELS.length}`,
  );
  check(
    "CN 的其余模型都在",
    cn.every((m) => m.id === "deepseek-flash" || getQoderModel(m.id)),
    JSON.stringify(cn.map((m) => m.id)),
  );
}

/* ------------------------------------------------------------------ *
 * 4. 端点只剩一个
 * ------------------------------------------------------------------ */

section("4. 端点：只有老协议那一个");

check("全球区没有第二种协议的端点", !("infer" in ENDPOINTS.global), Object.keys(ENDPOINTS.global).join(","));
check("CN 也没有第二种协议的端点", !("infer" in ENDPOINTS.cn), Object.keys(ENDPOINTS.cn).join(","));
check(
  "两个区的路径是同一个",
  ENDPOINTS.global.inferLegacy.endsWith(LEGACY_PATH) && ENDPOINTS.cn.inferLegacy.endsWith(LEGACY_PATH),
  LEGACY_PATH,
);

// 默认主机要在干净的环境里看：上面为了打假上游改过两个区的 base，改过就看不到
// 默认值了。所以再起一个进程，只问它默认值是什么。
{
  const authUrl = new URL("../lib/qoder/auth.ts", import.meta.url).href;
  const kindUrl = new URL("../lib/kinds/qoder.ts", import.meta.url).href;
  const kindsUrl = new URL("../lib/provider-kinds.ts", import.meta.url).href;
  const script =
    `const { ENDPOINTS } = await import(${JSON.stringify(authUrl)});` +
    `await import(${JSON.stringify(kindUrl)});` +
    `const { kindOf } = await import(${JSON.stringify(kindsUrl)});` +
    `const kind = kindOf("qoder");` +
    `console.log(JSON.stringify({` +
    `global: ENDPOINTS.global.inferLegacy, cn: ENDPOINTS.cn.inferLegacy,` +
    `globalBase: kind?.baseUrl?.({ region: "global" }), cnBase: kind?.baseUrl?.({ region: "cn" }) }));`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("QODER_")) continue;
    if (value !== undefined) env[key] = value;
  }
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    env,
    encoding: "utf8",
  });
  const defaults = JSON.parse(printed.trim().split("\n").pop() ?? "{}");
  check(
    "全球区默认打 api2.qoder.sh（官方客户端 1.1.86 的默认）",
    defaults.global === `https://api2.qoder.sh${LEGACY_PATH}`,
    String(defaults.global),
  );
  check(
    "CN 默认打 gateway.qoder.com.cn",
    defaults.cn === `https://gateway.qoder.com.cn${LEGACY_PATH}`,
    String(defaults.cn),
  );
  // 面板看到的基础地址：端点去掉协议那条路径。地址来自 kind 注册表，不是另抄一份。
  check("全球区的 base 就是那个主机", defaults.globalBase === "https://api2.qoder.sh", String(defaults.globalBase));
  check("CN 的 base 就是那个主机", defaults.cnBase === "https://gateway.qoder.com.cn", String(defaults.cnBase));
}

server.close();
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
