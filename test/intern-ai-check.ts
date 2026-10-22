// test/intern-ai-check.ts — intern-ai 模块里那些不需要网络的逻辑。
//
//   node --experimental-strip-types test/intern-ai-check.ts
//
// 覆盖的是最容易写错、又最难在真机上发现的几处：人机校验那一类错误的归类、
// 密码加密的形状、墨点余额和批次的解析、墨点怎么算（平台的公式，例子是官方
// 给的）、两个子站的 key 长得不一样、两个子站的模型清单结构不一样、两个子站
// 的推理端点前缀不一样。
//
// 用的数据是按平台真实回答的形状编出来的，值不是账号里的真数。

import {
  captchaHeaders,
  classify,
  cookieHeader,
  encryptSecret,
  internAiSite,
  loginBody,
  pemFromRawPublicKey,
  ssoUidFromToken,
  tokenExpiryMs,
  type InternAiError,
} from "../lib/intern-ai/auth.ts";
import { dialectFor } from "../lib/intern-ai/endpoints.ts";
import { maskToken, parseChatToken, parseDiscoveryKey } from "../lib/intern-ai/keys.ts";
import {
  estimateInkPoints,
  packExpired,
  parseBalance,
  parseCreditPack,
  parseCreditWindow,
  parseTransaction,
  parseTransactionPage,
  parseUsageSummary,
  usableCredits,
  INTERN_AI_MODEL_PRICES,
  type InternAiBalance,
} from "../lib/intern-ai/quota.ts";
import { parseModelList, parseModelRow } from "../lib/intern-ai/models.ts";
import { consoleAuthHeaders, withQuery } from "../lib/intern-ai/platform.ts";

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

console.log("");
console.log("错误的归类");

const captchaError = classify(200, { msgCode: "B0501", msg: "Human verification failed" }, "登录");
check("人机校验是单独一类", captchaError.kind === "captcha", captchaError.kind);
check("人机校验的错误说清楚了要什么", captchaError.message.includes("确认您不是机器人"), captchaError.message);
check("人机校验不是重试能解决的", captchaError.status === 503, String(captchaError.status));

check("401 是会话过期", classify(401, {}, "测试").kind === "auth");
check("A0202 也是会话过期", classify(200, { msgCode: "A0202" }, "测试").kind === "auth");
check("403 是没有权限", classify(403, {}, "测试").kind === "forbidden");
check("429 是限流", classify(429, {}, "测试").kind === "rate");
check("400 是请求不对", classify(400, {}, "测试").kind === "request");
check("A0101 是参数不对", classify(200, { msgCode: "A0101" }, "测试").kind === "request");
check("404 是接口不对", classify(404, {}, "测试").kind === "request");
check("500 是上游的问题", classify(500, {}, "测试").kind === "upstream");
check("错误信息里带着上游说的", classify(400, { msg: "字段不对" }, "测试").message.includes("字段不对"));
check("错误信息是中文", /[一-龥]/.test(classify(401, {}, "测试").message));

console.log("");
console.log("登录");

check("邮箱的 type 是 1", loginBody("a@b.com", "enc").type === "1");
check("手机号的 type 是 2", loginBody("13800000000", "enc").type === "2");
check("登录体里有账号", loginBody("13800000000", "enc").account === "13800000000");
check("登录体里是加密后的密码", loginBody("13800000000", "enc").password === "enc");
check("登录体记得住我", loginBody("13800000000", "enc").autoLogin === true);

check("没有人机校验就一个头都不带", Object.keys(captchaHeaders()).length === 0);
const capHeaders = captchaHeaders({ captchaVerifyParam: "p", sceneId: "s", prefix: "x" });
check("人机校验带三个头", Object.keys(capHeaders).length === 3, String(Object.keys(capHeaders).length));
check("人机校验的头名对", capHeaders.captchaVerifyParam === "p" && capHeaders.sceneId === "s" && capHeaders.prefix === "x");

// 公钥的包装：服务端给的是裸 base64 的 DER
const raw = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCOst3X5k3uqRpKtFOfLQdh5ZyakdP0fnP6CyPs";
const pem = pemFromRawPublicKey(raw);
check("裸公钥补上了 PEM 头", pem.startsWith("-----BEGIN PUBLIC KEY-----"));
check("裸公钥补上了 PEM 尾", pem.trim().endsWith("-----END PUBLIC KEY-----"));
check("PEM 里有原来的内容", pem.replace(/\s+/g, "").includes(raw));
check("本来就是 PEM 的不动", pemFromRawPublicKey(pem) === pem);

// 密码加密：解开来必须是「账号||密码+时间戳」
const { constants, generateKeyPairSync, privateDecrypt } = await import("node:crypto");
const pair = generateKeyPairSync("rsa", { modulusLength: 1024 });
const pubPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const encrypted = encryptSecret(pubPem, "13800000000", "s3cret");
const plain = privateDecrypt(
  { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING },
  Buffer.from(encrypted, "base64"),
).toString();
check("加密出来的是 base64", /^[A-Za-z0-9+/]+=*$/.test(encrypted));
check("解开是「账号||密码」", plain.startsWith("13800000000||s3cret"), plain.slice(0, 8));
const stamp = plain.slice("13800000000||s3cret".length);
check("解开的是十位 unix 秒", /^\d{10}$/.test(stamp), stamp);

console.log("");
console.log("token");

// 一个编出来的 JWT：载荷里 jti 是账号 id，exp 是到期时刻
const fakeJwt = (payload: any) =>
  `${Buffer.from(JSON.stringify({ typ: "JWT", alg: "HS512" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(payload),
  ).toString("base64url")}.sig`;
const jwt = fakeJwt({ jti: "100000001", exp: 1793867171 });
check("从 token 里读出账号 id", ssoUidFromToken(jwt) === "100000001", ssoUidFromToken(jwt));
check("到期时刻是毫秒", tokenExpiryMs(jwt) === 1793867171000, String(tokenExpiryMs(jwt)));
check("不是 token 的时候不炸", ssoUidFromToken("not-a-jwt") === "");
check("坏 token 的到期时刻是 0", tokenExpiryMs("not-a-jwt") === 0);

console.log("");
console.log("cookie");

const jar = ["uaa-token=abc; Path=/; HttpOnly; Secure", "acw_tc=def; Path=/; HttpOnly"];
check("cookie 头是分号隔开的", cookieHeader(jar) === "uaa-token=abc; acw_tc=def", cookieHeader(jar));
check("属性不混进值里", !cookieHeader(jar).includes("HttpOnly"));

const authHeaders = consoleAuthHeaders("tok", { sites: [], ssoUid: "100000001" } as any);
check("控制台要带 Bearer", authHeaders.Authorization === "Bearer tok");
check("控制台还要带 cookie", authHeaders.Cookie === "uaa-token=tok; ssouid=100000001", authHeaders.Cookie);
check("没有会话就只带 Bearer", Object.keys(consoleAuthHeaders("tok")).length === 1);

console.log("");
console.log("两个子站");

check("两个子站的名字不一样", internAiSite("discovery").name !== internAiSite("chat").name);
check("两个子站的客户端 id 不一样", internAiSite("discovery").clientId !== internAiSite("chat").clientId);
check("两个子站换 token 的路径不一样", internAiSite("discovery").authPath !== internAiSite("chat").authPath);
check("同一个子站每次一样", internAiSite("chat").clientId === internAiSite("chat").clientId);

console.log("");
console.log("推理端点");

const dd = dialectFor("discovery");
const cd = dialectFor("chat");
check("两个子站的 OpenAI 基地址不一样", dd.openaiBase !== cd.openaiBase);
check("Chat 的 Anthropic 不带 /api", !cd.anthropicBase.endsWith("/api"), cd.anthropicBase);
check("Discovery 的 Anthropic 跟 OpenAI 同一个前缀", dd.anthropicBase === dd.openaiBase);
check("Chat 的 Anthropic 路径是 /v1/messages", cd.messagesPath === "/v1/messages");
check("Discovery 的 Anthropic 路径是 /messages", dd.messagesPath === "/messages");
check("两个子站的对话路径一样", dd.chatPath === cd.chatPath);

console.log("");
console.log("墨点余额");

// 形状照平台真实回答抄的：墨点是小数字符串，时间是「本地时间，没有时区」
const balanceBody = {
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
      limit_credits: "50.000000",
      used_credits: "1.079000",
      remaining_credits: "48.921000",
      next_recover_at: "2026-10-29 12:56:38",
    },
  },
  calculated_at: "2026-10-22 16:28:14",
};
const bal = parseBalance(balanceBody);
check("余额是小数", bal.availableCredits === 1.698, String(bal.availableCredits));
check("余额没有四舍五入成整数", bal.availableCredits !== 2);
check("批次数读到了", bal.activePackageCount === 1);
check("5 小时窗口读到了", bal.window5h.window === "5h" && bal.window5h.enabled);
check("窗口的数字是数字", bal.window5h.limitCredits === 10 && bal.window5h.remainingCredits === 9.751);
check("窗口的已用量读到了", bal.window5h.usedCredits === 0.249);
check("恢复时刻是字符串", bal.window5h.nextRecoverAt === "2026-10-22 19:56:38");
check("7 天窗口读到了", bal.window7d.window === "7d");
check("限流读到了", bal.rpmLimit === 50 && bal.decisionRpmLimit === 200 && bal.tpmLimit === 2000000);
check("账号能用", bal.accessStatus === 1);
check("计算时刻读到了", bal.calculatedAt === "2026-10-22 16:28:14");
check("没开窗口的窗口 enabled 是 false", parseCreditWindow("x", {}).enabled === false);
check("空的回答不炸", parseBalance(null).availableCredits === 0);

console.log("");
console.log("墨点批次");

const pack = parseCreditPack({
  pkg_id: "pkg_free_monthly_base",
  issued_at: "2026-10-15 12:56:38",
  cycle_type: "monthly",
  current_cycle: { start_at: "2026-10-15 12:56:38", end_at: "2026-11-16 00:00:00" },
  total_credits: "10.000000",
  remaining_credits: "1.698000",
  status: "available",
  income_expense_type: "platform_grant",
  remark: "每月免费基础包",
  effective_at: "2026-10-15 12:56:38",
  expire_at: "2099-12-31 23:59:59",
});
check("批次 id 读到了", pack.id === "pkg_free_monthly_base");
check("周期读到了", pack.cycleType === "monthly");
check("本个周期的起止读到了", pack.cycleStartAt === "2026-10-15 12:56:38");
check("周期的结束读到了", pack.cycleEndAt === "2026-11-16 00:00:00");
check("批次的余额是小数", pack.remainingCredits === 1.698 && pack.totalCredits === 10);
check("批次的备注读到了", pack.remark === "每月免费基础包");
check("批次的收支类型读到了", pack.incomeExpenseType === "platform_grant");
check("批次的到期时刻读到了", pack.expireAt === "2099-12-31 23:59:59");
check("空的批次不炸", parseCreditPack({}).id === "");

console.log("");
console.log("墨点流水");

const tx = parseTransaction({
  occurred_at: "2026-10-22 00:00:00",
  income_expense_type: "consume",
  income_expense_type_name: "消费",
  credit_delta: "-0.249000",
  remark: "消费",
  pkg_id: "",
  model: "deepseek-v4.1-flash-1017",
  request_count: 22,
});
check("流水的时刻读到了", tx.occurredAt === "2026-10-22 00:00:00");
check("流水的变动量是小数", tx.creditDelta === -0.249, String(tx.creditDelta));
check("流水的类型读到了", tx.incomeExpenseType === "consume");
check("流水的中文名读到了", tx.incomeExpenseTypeName === "消费");
check("流水的模型读到了", tx.model === "deepseek-v4.1-flash-1017");
check("流水的请求数读到了", tx.requestCount === 22);
const page = parseTransactionPage({ items: [tx], total: 10 });
check("一页流水读到了", page.items.length === 1 && page.total === 10);
check("没有 items 不炸", parseTransactionPage({}).items.length === 0);

const usage = parseUsageSummary({
  sso_uid: "100000001",
  model: "all",
  start_date: "2026-10-01",
  end_date: "2026-10-22",
  summary: {
    total_tokens: 2439530,
    request_count: 147,
    consumed_credits: "8.302000",
    input_cached_tokens: 1299102,
    input_uncached_tokens: 1046634,
    output_tokens: 93794,
  },
  daily_usage: [{ date: "2026-10-18", total_tokens: 1630140, request_count: 96, consumed_credits: "5.680000" }],
});
check("用量汇总的 token 读到了", usage.totalTokens === 2439530);
check("用量汇总的墨点是小数", usage.consumedCredits === 8.302, String(usage.consumedCredits));
check("用量汇总的按天明细读到了", usage.dailyUsage.length === 1 && usage.dailyUsage[0]!.consumedCredits === 5.68);
check("空的用量汇总不炸", parseUsageSummary({}).totalTokens === 0);

console.log("");
console.log("还剩多少墨点");

const packs = [pack, parseCreditPack({ pkg_id: "pkg_2", status: "expired", remaining_credits: "999" })];
check("能用的是余额和窗口里小的那个", usableCredits(bal, packs) === 1.698, String(usableCredits(bal, packs)));
const noWindow = parseBalance({ available_credits: "10", usage_windows: { "5h": { enabled: false }, "7d": { enabled: false } } });
check("没开窗口时余额和批次里小的那个说了算", usableCredits(noWindow, packs) === 1.698, String(usableCredits(noWindow, packs)));
check("没有批次就只看余额", usableCredits(noWindow, []) === 10, String(usableCredits(noWindow, [])));
check("过期批次不算", usableCredits(noWindow, [packs[1]!]) === 0);
check("没有批次也不炸", usableCredits(bal, []) === 1.698);

check("状态是 expired 的批次算过期", packExpired({ ...pack, status: "expired" }));
check("状态是 voided 的批次算过期", packExpired({ ...pack, status: "voided" }));
check("状态是 used_up 的批次算过期", packExpired({ ...pack, status: "used_up" }));
check("available 的批次不算过期", !packExpired(pack));

console.log("");
console.log("墨点怎么算");

// 平台给的例子：缓存命中 100000 @2，未命中 500000 @10，输出 200000 @40 = 13.2
const points = estimateInkPoints(
  { cachedInputPerMillion: 2, inputPerMillion: 10, outputPerMillion: 40 },
  { cachedInputTokens: 100_000, inputTokens: 500_000, outputTokens: 200_000 },
);
check("算出来是 13.2", Math.abs(points - 13.2) < 1e-9, String(points));
check("免费模型不扣墨点", estimateInkPoints(INTERN_AI_MODEL_PRICES["intern-s2"]!, { cachedInputTokens: 1000, inputTokens: 1000, outputTokens: 1000 }) === 0);
check(
  "glm-5.3 的价对得上",
  Math.abs(estimateInkPoints(INTERN_AI_MODEL_PRICES["glm-5.3"]!, { cachedInputTokens: 0, inputTokens: 1_000_000, outputTokens: 0 }) - 8) < 1e-9,
);
check(
  "决策模型输出不计费",
  estimateInkPoints(INTERN_AI_MODEL_PRICES["intern-decision-4b"]!, { cachedInputTokens: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 }) === 0.2,
);
check("空用量不扣墨点", estimateInkPoints(INTERN_AI_MODEL_PRICES["minimax-m3"]!, { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 }) === 0);

console.log("");
console.log("两个子站的 key");

const dKey = parseDiscoveryKey({
  id: "ak_01M4YZ2TJVMFCQAVWXD9956GXX",
  name: "pi",
  masked_key: "sk-...9b42",
  status: "active",
  created_at: "2026-10-15T05:03:14.011Z",
  last_used_at: "2026-10-22T08:20:37.611Z",
});
check("Discovery key 的 id 读到了", dKey.id === "ak_01M4YZ2TJVMFCQAVWXD9956GXX");
check("Discovery key 的名字读到了", dKey.name === "pi");
check("Discovery key 的掩码读到了", dKey.maskedKey === "sk-...9b42");
check("Discovery key 的状态读到了", dKey.status === "active");
check("Discovery key 的时间读到了", dKey.createdAt === "2026-10-15T05:03:14.011Z");
check("列表里没有完整的 key", dKey.plainKey === undefined);
const createdKey = parseDiscoveryKey({
  id: "ak_01M5HBMBKQSBGMXJXB1VVCQPGS",
  name: "buddy-proxy",
  key: "sk-fullvalue",
  masked_key: "sk-...369c",
  status: "active",
});
check("创建的回答里带着完整的 key", createdKey.plainKey === "sk-fullvalue");
check("创建的回答里 id 也在", createdKey.id === "ak_01M5HBMBKQSBGMXJXB1VVCQPGS");

// Chat：列表里的 token 是掩过的，创建的那次是完整的
const cToken = parseChatToken({
  id: "dnwpi4yU81H6ivgnK0COOYpPQh1Z89ONciSGUKmgFFA=",
  token: "sk...zn3e",
  auth_status: 1,
  token_name: "buddy-proxy",
  created_at: "2026-10-22T08:28:51.494Z",
  expired_at: "-",
});
check("Chat token 的 id 读到了", cToken.id.startsWith("dnwpi4yU81H6"));
check("Chat token 的名字读到了", cToken.name === "buddy-proxy");
check("Chat token 的掩码是平台给的", cToken.maskedToken === "sk...zn3e");
check("Chat token 的权限是数字", cToken.authStatus === 1);
check("Chat token 的有效期是「-」", cToken.expiredAt === "-");
check("Chat token 列表里没有完整的 token", cToken.plainToken === undefined);
const cCreated = parseChatToken(
  { id: "t2", token: "sk-IbdDHTAvrxLZslTJoaU2158hsuA9kqOlvSOSPH2c0GPjzn3e", token_name: "buddy-proxy" },
  true,
);
check("Chat 创建的完整 token 读到了", cCreated.plainToken === "sk-IbdDHTAvrxLZslTJoaU2158hsuA9kqOlvSOSPH2c0GPjzn3e");
check("Chat 创建的 token 也掩了一份", cCreated.maskedToken.includes("••••"));
check("字段名跟 Discovery 不一样", !("masked_key" in cToken));
check("短的 token 不掩", maskToken("sk-123") === "sk-123");

console.log("");
console.log("模型清单");

const modelList = parseModelList({
  object: "list",
  data: [{ id: "intern-s2", object: "model" }],
  models: [{ name: "intern-decision-4b", description: "决策模型", release_date: "2026-01-01" }],
});
check("生成模型读到了", modelList.models.length === 1 && modelList.models[0]!.id === "intern-s2");
check("决策模型是并列的另一个数组", modelList.decisionModels.length === 1);
check("决策模型的 id 在 name 里", modelList.decisionModels[0]!.name === "intern-decision-4b");
check("决策模型的发布日期读到了", modelList.decisionModels[0]!.releaseDate === "2026-01-01");
check("空的回答不炸", parseModelList(null).models.length === 0);

const row = parseModelRow({
  id: "deepseek-v4-pro-0813",
  display_name: "DeepSeek-V4-Pro-0813",
  context_length: 1048576,
  input_types: ["text", "image"],
  capabilities: ["工具调用", "科学推理"],
  supported_protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
});
check("模型的 id 读到了", row.id === "deepseek-v4-pro-0813");
check("上下文长度是数字", row.contextLength === 1048576);
check("输入模态读到了", row.inputTypes.join(",") === "text,image");
check("能力读到了", row.capabilities.length === 2);
check("支持的协议读到了", row.supportedProtocols.length === 3);
check("空的一行也不炸", parseModelRow({}).id === "");

console.log("");
console.log("地址");

check("查询参数拼上了", withQuery("https://x.cn/a", { page: 5 }) === "https://x.cn/a?page=5");
check("空的值不拼", withQuery("https://x.cn/a", { page: undefined }) === "https://x.cn/a");
check("已有的问号后面用 &", withQuery("https://x.cn/a?b=1", { c: 2 }) === "https://x.cn/a?b=1&c=2");
check("值要转义", withQuery("https://x.cn/a", { q: "a b" }) === "https://x.cn/a?q=a%20b");

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
