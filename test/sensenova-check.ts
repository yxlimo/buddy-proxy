// test/sensenova-check.ts — SenseNova 模块里那些不需要网络的逻辑。
//
//   node --experimental-strip-types test/sensenova-check.ts
//
// 覆盖的是最容易写错、又最难在真机上发现的几处：池子的分类、扣减顺序、
// 窗口的算法、cookie 的拼法、key 的掩码、错误的归类。
//
// 用的数据是编出来的，不是账号里的真数。

import {
  classify,
  cookieHeader,
  cookieValue,
  codeFrom,
  loginBody,
  loginChallengeFrom,
  pkcePair,
  type SenseNovaError,
} from "../lib/sensenova/auth.ts";
import { parseApiKeyRow } from "../lib/sensenova/keys.ts";
import {
  classifyPoolType,
  deductionOrder,
  modelIdsOf,
  nextUsableStep,
  parsePoolUsage,
  poolEmpty,
  poolForModel,
  poolPaused,
  rollingRemaining,
  summarize,
  totalRemaining,
} from "../lib/sensenova/quota.ts";
import { parseModelRow } from "../lib/sensenova/models.ts";
import { withQuery } from "../lib/sensenova/platform.ts";

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

/** 一份编出来的额度回答，形状跟平台给的一样。 */
const USAGE_BODY = {
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

console.log("");
console.log("额度回答的读法");

const usage = parsePoolUsage(USAGE_BODY);
check("套餐的字段都在", usage.plan.id === "free" && usage.plan.type === "TOKEN_PLAN_PLAN_TYPE_FREE");
check("两个池子都读到了", usage.pools.length === 2, String(usage.pools.length));

const general = usage.pools[0]!;
const lite = usage.pools[1]!;

check("通用池认得出来", general.kind === "general", general.kind);
check("专属池认得出来", lite.kind === "dedicated", lite.kind);
check("原始的 pool_type 留着", general.poolType === "default" && lite.poolType === "dedicated");
check("池子的名字是接口给的", general.name === "通用积分池", general.name);
check("模型清单是数组", Array.isArray(general.modelIds) && general.modelIds.length === 2);
check("窗口的数字是数字", general.window5h.limit === 60000 && general.window5h.used === 1000);
check("窗口的重置时刻是 unix 秒", general.window5h.resetAt === 1792655487);
check("活动积分的余额读成了数字", general.grantBalance === 5000, String(general.grantBalance));
check("最近到期的余额读成了数字", general.nearestGrantExpiringBalance === 1200);

check("没见过的 pool_type 不乱猜", classifyPoolType("whatever") === "other");
check("空的回答不炸", parsePoolUsage(null).pools.length === 0);
check("没有池子的字段不炸", parsePoolUsage({ pools: [{}] }).pools[0]!.kind === "other");

console.log("");
console.log("还剩多少");

check("周期积分取两个窗口里小的那个", rollingRemaining(general) === 59000, String(rollingRemaining(general)));
check("总余额是周期加活动", totalRemaining(general) === 64000, String(totalRemaining(general)));
check("5 小时窗口见底了池子就停", !poolPaused(general));
check("周期和活动都没了才算空", !poolEmpty(general));
const spent = {
  ...lite,
  window5h: { ...lite.window5h, remaining: 0 },
  window7d: { ...lite.window7d, remaining: 0 },
};
check("什么都没有的池子是空的", poolEmpty(spent) === true);
check("只有活动积分的池子不算空", poolEmpty({ ...spent, grantBalance: 10 }) === false);

console.log("");
console.log("扣减顺序");

const order = deductionOrder(usage.pools, "sensenova-6.8-flash-lite");
check("Flash-lite 先扣专属池", order[0]?.pool.id === "pool_lite", order[0]?.pool.id);
check("专属池先扣的是周期积分", order[0]?.credit === "rolling");
check("然后是通用池的周期积分", order[1]?.pool.id === "pool_general" && order[1]?.credit === "rolling");
check("最后是通用池的活动积分", order[2]?.pool.id === "pool_general" && order[2]?.credit === "grant");
check("Flash-lite 一共三步", order.length === 3, String(order.length));

const other = deductionOrder(usage.pools, "deepseek-v4-flash");
check("其他模型只走通用池", other.length === 2, String(other.length));
check("其他模型先扣周期", other[0]?.pool.id === "pool_general" && other[0]?.credit === "rolling");
check("其他模型再扣活动积分", other[1]?.credit === "grant");
check("不归积分池管的模型没有顺序", deductionOrder(usage.pools, "some-other-model").length === 0);

check("模型落在哪个池子看出来了", poolForModel(usage.pools, "sensenova-6.8-flash-lite")?.id === "pool_lite");
check("普通模型落在通用池", poolForModel(usage.pools, "deepseek-v4-flash")?.id === "pool_general");
check("不在套餐里的模型没有池子", poolForModel(usage.pools, "nope") === null);

check("第一个还扣得动的池子是对的", nextUsableStep(order)?.pool.id === "pool_lite");
const paused = [
  { ...lite, window5h: { ...lite.window5h, remaining: 0 } },
  general,
];
const pausedOrder = deductionOrder(paused, "sensenova-6.8-flash-lite");
check("专属池停了就换下一个", nextUsableStep(pausedOrder)?.pool.id === "pool_general");
check("顺序本身没变", pausedOrder[0]?.pool.id === "pool_lite");

console.log("");
console.log("摘要");

const summary = summarize(usage);
check("摘要有两条", summary.length === 2);
check("摘要里带着池子的种类", summary[0]?.kind === "general" && summary[1]?.kind === "dedicated");
check("摘要里带着模型数", summary[1]?.models === 1, String(summary[1]?.models));
check("摘要里的余额是对的", summary[0]?.totalRemaining === 64000);

console.log("");
console.log("模型清单");

const model = parseModelRow({
  id: "sensenova-6.8-flash-lite",
  name: "SenseNova 6.8 Flash Lite",
  context_length: 1048576,
  max_output_length: 65536,
  input_modalities: ["text"],
  output_modalities: ["text"],
  supported_features: ["tools", "reasoning"],
});
check("模型的 id 读到了", model.id === "sensenova-6.8-flash-lite");
check("上下文长度是数字", model.contextLength === 1048576);
check("能力清单读到了", model.features.join(",") === "tools,reasoning");
check("空的一行也不炸", parseModelRow({}).id === "");
check("池子里的模型去重了", modelIdsOf(usage.pools).length === 2, String(modelIdsOf(usage.pools).length));

console.log("");
console.log("登录");

const pair = pkcePair();
check("verifier 是 base64url", /^[A-Za-z0-9_-]+$/.test(pair.codeVerifier), pair.codeVerifier.slice(0, 12));
check("challenge 也是 base64url", /^[A-Za-z0-9_-]+$/.test(pair.codeChallenge));
check("verifier 和 challenge 不是一回事", pair.codeVerifier !== pair.codeChallenge);
check("两次造出来的 verifier 不一样", pkcePair().codeVerifier !== pair.codeVerifier);

check(
  "challenge 从跳转地址里取",
  loginChallengeFrom("https://iam.example.cn/iam/authn/v1/auth/login?login_challenge=abc123") === "abc123",
);
check("地址不对时不炸", loginChallengeFrom("not a url") === "");
check("授权码从回调地址里取", codeFrom("https://platform.example.cn/?code=xyz&state=1") === "xyz");
check("回调地址里没有码就是空", codeFrom("https://platform.example.cn/") === "");

const body = loginBody("someone", "secret", "chal");
check("登录体有账号", body.username === "someone");
check("登录体有密码", body.password === "secret");
check("登录体有 challenge", body.challenge === "chal");
check("密码明文发，所以加密标志是 false", body.is_encrypt === false);

console.log("");
console.log("cookie");

const jar = [
  "oauth2_authentication_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
  "oauth2_authentication_csrf=def; Path=/; HttpOnly; Secure",
];
check("取得到 cookie 的值", cookieValue(jar, "oauth2_authentication_session") === "abc");
check("取不到就是空", cookieValue(jar, "nope") === "");
check("属性不混进值里", !cookieValue(jar, "oauth2_authentication_csrf").includes("Path"));
check("cookie 头是分号隔开的", cookieHeader(jar) === "oauth2_authentication_session=abc; oauth2_authentication_csrf=def");

console.log("");
console.log("key");

const key = parseApiKeyRow({
  id: "01a16280-d806-7c96-93dc-aec9947ca5dd",
  displayname: "probe",
  key_type: "API_KEY_TYPE_TOKEN_PLAN",
  api_key: "sk-abcdefghijklmnop",
  create_time: "2026-01-01T00:00:00Z",
  status: "enabled",
  is_default: false,
});
check("key 的名字读到了", key.displayname === "probe");
check("key 的计费类型读到了", key.keyType === "API_KEY_TYPE_TOKEN_PLAN");
check("key 被掩码了", key.maskedKey.includes("••••") && !key.maskedKey.includes("defghijkl"), key.maskedKey);
check("列表里没有完整的 key", key.plainKey === undefined);
const created = parseApiKeyRow({ api_key: "sk-abcdefghijklmnop", api_key_plain: "sk-abcdefghijklmnop" });
check("创建的回答里带着完整的 key", created.plainKey === "sk-abcdefghijklmnop");
check("短的 key 不掩码", parseApiKeyRow({ api_key: "sk-1" }).maskedKey === "sk-1");
check("默认 key 认得出来", parseApiKeyRow({ is_default: true }).isDefault === true);

console.log("");
console.log("错误的归类");

const authError = classify(401, { message: "expired" }, "测试");
check("401 是会话过期", authError.kind === "auth", authError.kind);
check("403 是没有权限", classify(403, {}, "测试").kind === "forbidden");
check("429 是限流", classify(429, {}, "测试").kind === "rate");
check("400 是请求不对", classify(400, { message: "bad" }, "测试").kind === "request");
check("404 是接口不对", classify(404, {}, "测试").kind === "request");
check("500 是上游的问题", classify(500, {}, "测试").kind === "upstream");
check("错误信息里带着上游说的", classify(400, { message: "字段不对" }, "测试").message.includes("字段不对"));
check("错误信息是中文", /[一-龥]/.test(classify(401, {}, "测试").message));
check(
  "平台那套 details 里的理由也读得出来",
  classify(401, { code: 16, details: [{ reason: "Invalid access token" }] }, "测试").message.includes(
    "Invalid access token",
  ),
);

console.log("");
console.log("地址");

check("查询参数拼上了", withQuery("https://x.cn/a", { page_size: 5 }) === "https://x.cn/a?page_size=5");
check("空的值不拼", withQuery("https://x.cn/a", { page_size: undefined }) === "https://x.cn/a");
check("已有的问号后面用 &", withQuery("https://x.cn/a?b=1", { c: 2 }) === "https://x.cn/a?b=1&c=2");
check("值要转义", withQuery("https://x.cn/a", { q: "a b" }) === "https://x.cn/a?q=a%20b");

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
