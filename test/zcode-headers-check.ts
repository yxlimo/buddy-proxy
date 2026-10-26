// test/zcode-headers-check.ts — ZCode 的请求头，跟官方桌面端 3.16.3 对。
//
//   node --experimental-strip-types test/zcode-headers-check.ts
//
// 离线：不问 ZCode。
//
// 依据是客户端自己落的 model IO（真值样本）：
//
//   ~/.zcode/cli/rollout/model-io-<sessionId>.jsonl
//   2026-10-26T13:45Z 一次成功的 start-plan 请求（account:bigmodel-start-plan，
//   GLM-5.3-Flash）的 request.headers。
//
// 2026-10-26 之前这份测试对的是官方源码里的 `buildCliZCodeSourceHeaders`
// （Z Code@cli / process.platform / os.release()），那套值报的是网关自己的
// 运行环境，不是桌面端的样子，上游用 code 3012 回它。
//
// 头少一个、多一个、或者每次都换的那些，平台那边看得见。

import { zcodeHeaders, zcodePlatformHeaders, zcodeBody, ZCODE_MESSAGES_URL } from "../lib/zcode/transport.ts";
import { setZcodeCapabilities, zcodeModelsInUse, zcodeEffortFor } from "../lib/zcode/models.ts";
import type { ZcodeSession } from "../lib/zcode/auth.ts";
import type { Json } from "../lib/json.ts";

const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
};

const session: ZcodeSession = {
  token: "jwt_test",
  provider: "zai",
  deviceId: "11111111-2222-3333-4444-555555555555",
  generation: 1,
  loginAtMs: Date.now(),
  expiresAtMs: Date.now() + 3600_000,
};

/** 官方桌面端那套头（model IO 真值）。 */
const OFFICIAL = [
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-type",
  "HTTP-Referer",
  "user-agent",
  "X-ZCode-App-Version",
  "X-Title",
  "X-Release-Channel",
  "X-Client-Language",
  "X-Client-Timezone",
  "X-ZCode-Agent",
  "X-Platform",
  "X-Os-Category",
  "X-Os-Version",
  "x-request-id",
  "x-zcode-session-type",
  "x-zcode-trace-id",
  "x-query-id",
  "x-zcode-query-source",
];

/** 官方桌面端的会话 id 形状。 */
const SESSION_ID = "session_37e3b015e79c2c05045cacd79a105500";

console.log("");
console.log("模型请求的头：就是官方那套");

{
  const headers = zcodeHeaders(session, { sessionId: SESSION_ID });
  const names = Object.keys(headers);
  for (const name of OFFICIAL) {
    check(`有 ${name}`, names.includes(name), names.join(","));
  }
  const extra = names.filter((n) => !OFFICIAL.includes(n) && n !== "x-session-id");
  check("没有多余的头", extra.length === 0, extra.join(","));
  check("没有 X-Device-Mid", !("X-Device-Mid" in headers), Object.keys(headers).join(","));
}

console.log("");
console.log("头的值");

{
  const headers = zcodeHeaders(session, { sessionId: SESSION_ID });
  check("两个鉴权头都是 jwt", headers["authorization"] === "Bearer jwt_test" && headers["x-api-key"] === "jwt_test", headers["authorization"]);
  check("时区跟官方抓包一样", headers["X-Client-Timezone"] === "Asia/Shanghai", headers["X-Client-Timezone"]);
  check("版本头是版本号", /^ZCode\/\d+\.\d+\.\d+$/.test(headers["user-agent"]), headers["user-agent"]);
  check("报的是桌面端的平台", headers["X-Platform"] === "win32-x64", headers["X-Platform"]);
  check("报的是 Windows", headers["X-Os-Category"] === "windows", headers["X-Os-Category"]);
  check("报的是 Windows 版本", /^10\.0\.\d+$/.test(headers["X-Os-Version"]), headers["X-Os-Version"]);
  check("标题是桌面端", headers["X-Title"] === "Z Code@electron", headers["X-Title"]);
  check("会话类型是 main", headers["x-zcode-session-type"] === "main", headers["x-zcode-session-type"]);
  check("查询来源是 main_turn", headers["x-zcode-query-source"] === "main_turn", headers["x-zcode-query-source"]);
  check("query id 是 uuid", /^[0-9a-f-]{36}$/.test(headers["x-query-id"]), headers["x-query-id"]);
  check("会话 id 是给的那个", headers["x-session-id"] === SESSION_ID, headers["x-session-id"]);
}

console.log("");
console.log("归因头每次请求都不一样，会话 id 不是");

{
  const a = zcodeHeaders(session, { sessionId: "same" });
  const b = zcodeHeaders(session, { sessionId: "same" });
  check("请求 id 每次不同", a["x-request-id"] !== b["x-request-id"]);
  check("trace id 每次不同", a["x-zcode-trace-id"] !== b["x-zcode-trace-id"]);
  check("会话 id 是稳定的", a["x-session-id"] === b["x-session-id"], `${a["x-session-id"]} vs ${b["x-session-id"]}`);
}

console.log("");
console.log("客户端没给会话 id：那个头就不发");

{
  const headers = zcodeHeaders(session);
  check("没有 x-session-id", !("x-session-id" in headers), Object.keys(headers).join(","));
}

console.log("");
console.log("平台 API 多一个设备头");

{
  const headers = zcodePlatformHeaders(session);
  check("额度那种请求带设备号", headers["X-Device-Mid"] === session.deviceId, String(headers["X-Device-Mid"]));
  check("其余的一样", headers["authorization"] === "Bearer jwt_test");
}

console.log("");
console.log("body 里的 metadata");

{
  const body = zcodeBody({ model: "GLM-5.3-Flash", messages: [] } as Json, session, {
    effort: "high",
    model: "GLM-5.3-Flash",
    sessionId: SESSION_ID,
  });
  const raw = String((body as Json)["metadata"]?.["user_id"] ?? "");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* not JSON */
  }
  check("user_id 是 JSON 字符串套 JSON", parsed !== null, raw);
  check("带设备号", parsed?.["device_id"] === session.deviceId, String(parsed?.["device_id"]));
  check("带会话 id", parsed?.["session_id"] === SESSION_ID, String(parsed?.["session_id"]));
  check("账号 uuid 是空的（官方就是这样）", parsed?.["account_uuid"] === "", String(parsed?.["account_uuid"]));
  check("glm-5.3 开着思考", (body as Json)["thinking"]?.["type"] === "enabled", JSON.stringify((body as Json)["thinking"]));
  check("思考档位写进 output_config", (body as Json)["output_config"]?.["effort"] === "high", JSON.stringify((body as Json)["output_config"]));
}

console.log("");
console.log("思考怎么发：按目录里的标记（官方 zcode-builtin.json 的 modelApiRules）");

{
  // GLM-5.3：官方规则 —— enabled + effort（它只认 low / high / max）。
  const body = zcodeBody({ model: "GLM-5.3", messages: [] } as Json, session, { model: "GLM-5.3" });
  check("GLM-5.3 开着思考", (body as Json)["thinking"]?.["type"] === "enabled", JSON.stringify((body as Json)["thinking"]));
  check(
    "GLM-5.3 的档位换成它认的",
    (body as Json)["output_config"]?.["effort"] === "high",
    JSON.stringify((body as Json)["output_config"]),
  );
}

{
  // 不在目录里的模型：不发思考（上游反正不让用）。
  const body = zcodeBody({ model: "GLM-5.2", messages: [] } as Json, session, { model: "GLM-5.2" });
  check("目录外的模型不思考", (body as Json)["thinking"]?.["type"] === "disabled", JSON.stringify((body as Json)["thinking"]));
  check("目录外的模型没有 output_config", (body as Json)["output_config"] === undefined, JSON.stringify((body as Json)["output_config"]));
}

{
  // 客户端要了档位就用它（官方没指定时是 medium）。
  const body = zcodeBody({ model: "GLM-5.3-Flash", messages: [] } as Json, session, {
    effort: "low",
    model: "GLM-5.3-Flash",
  });
  check("客户端的档位照用", (body as Json)["output_config"]?.["effort"] === "low", JSON.stringify((body as Json)["output_config"]));
}

console.log("");
console.log("路径");

{
  check("路径是官方那一套", ZCODE_MESSAGES_URL.endsWith("/api/v1/zcode-plan/anthropic/v1/messages"), ZCODE_MESSAGES_URL);
}

console.log("");
console.log("平台说的权益决定公布哪些模型");

{
  // 这个账号的额度接口只给了这两个 capabilities —— 5.2 与 Turbo 上游回 3006。
  setZcodeCapabilities(["model:glm-5.3", "model:glm-5.3-flash"]);
  const ids = zcodeModelsInUse().map((m) => m.id);
  check("只公布权益里有的", ids.join(",") === "GLM-5.3,GLM-5.3-Flash", ids.join(","));
  check("5.2 不在目录里", !ids.includes("GLM-5.2"), ids.join(","));
  check("Turbo 不在目录里", !ids.includes("GLM-5-Turbo"), ids.join(","));
}

{
  // 一个都对不上时不要把目录清空。
  setZcodeCapabilities(["model:some-new-model"]);
  check("对不上就退回整个目录", zcodeModelsInUse().length === 2, String(zcodeModelsInUse().length));
}

console.log("");
console.log("思考档位换成模型认的");

{
  check("flash 认 low", zcodeEffortFor("GLM-5.3-Flash", "low") === "low");
  check("flash 不认 medium，往深处靠", zcodeEffortFor("GLM-5.3-Flash", "medium") === "high");
  check("flash 认 max", zcodeEffortFor("GLM-5.3-Flash", "max") === "max");
  check("glm-5.3 也只认 low/high/max", zcodeEffortFor("GLM-5.3", "minimal") === "low");
}

console.log("");
console.log(process.exitCode ? "有没过" : "全部通过");
