// test/catalog-billing-check.ts — the billing read out of four upstream /models replies.
//
//   node --experimental-strip-types test/catalog-billing-check.ts
//
// The bodies below are the shapes the platforms really answer with (see
// docs/upstream-catalog-probe-20261113.md). Prices are public information and the
// credential-shaped parts of those replies are not needed here, so only the fields
// the reader touches are kept.
//
// The case worth guarding is the last one: "0" is a price when the platform says
// which currency and unit, and "no answer" when it says neither.

import { BILLING_DESCRIPTORS, billingFor, readModelBilling } from "../lib/catalog-billing.ts";

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

// tokenrhythm: per-million prices, CNY stated, effective price equals the list price
const tokenrhythmModel = {
  id: "glm-5.1",
  object: "model",
  currency: "CNY",
  input_price_per_million: "8.00000000",
  output_price_per_million: "28.00000000",
  cache_read_price_per_million: "2.00000000",
  has_discount: false,
  effective_input_price_per_million: "8.00000000",
  effective_output_price_per_million: "28.00000000",
  effective_cache_read_price_per_million: "2.00000000",
  pricing: {
    currency: "CNY",
    unit: "per_1m_tokens",
    prompt: "8.00000000",
    completion: "28.00000000",
    cache_read: "2.00000000",
  },
  discount_pricing: { currency: "CNY", unit: "per_1m_tokens", prompt: null, completion: null, cache_read: null },
  effective_pricing: {
    currency: "CNY",
    unit: "per_1m_tokens",
    prompt: "8.00000000",
    completion: "28.00000000",
    cache_read: "2.00000000",
  },
};

// sensenova: every role is "0", no currency and no unit anywhere
const sensenovaModel = {
  id: "deepseek-v4-flash",
  context_length: 1048576,
  max_output_length: 65536,
  pricing: { prompt: "0", completion: "0", image: "0", request: "0", input_cache_read: "0" },
};

// intern-ai: USD per token, one entry per role inside the modality arrays
const internAiModel = {
  id: "Agents-A1",
  input_modalities: [
    {
      type: "text",
      pricing: [
        { type: "prompt", unit: "token", cost_usd: "0.000016" },
        { type: "cached_prompt", unit: "token", cost_usd: "0.0000032" },
      ],
    },
  ],
  output_modalities: [{ type: "text", pricing: [{ type: "completion", unit: "token", cost_usd: "0.000064" }] }],
};

// opencode-go: per-million numbers, no currency field, plus time-of-day multipliers
const opencodeGoModel = {
  id: "deepseek-v4.1-flash",
  limit: { context: 1000000, output: 384000 },
  cost: {
    text: {
      input: { price: 0.15, cache: { read: 0.003 } },
      output: { price: 0.6 },
    },
    multipliers: [
      {
        when: {
          utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
          any: [
            { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
            { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
          ],
        },
        factor: 2,
      },
    ],
  },
};

// qiniu: an OpenAI-shaped list with no billing at all
const qiniuModel = {
  id: "glm-4.5",
  object: "model",
  owned_by: "system",
  context_length: 131072,
  max_tokens: 98304,
  service_status: "available",
};

console.log("");
console.log("tokenrhythm — 每百万 token，CNY");

const tokenrhythm = readModelBilling("tokenrhythm", tokenrhythmModel);
check("计费模式是 token", tokenrhythm.mode === "token", tokenrhythm.mode);
check("币种读到了", tokenrhythm.currency === "CNY", String(tokenrhythm.currency));
check("输入价 8", tokenrhythm.inputPerMillion === 8, String(tokenrhythm.inputPerMillion));
check("输出价 28", tokenrhythm.outputPerMillion === 28, String(tokenrhythm.outputPerMillion));
check("缓存读价 2", tokenrhythm.cacheReadPerMillion === 2, String(tokenrhythm.cacheReadPerMillion));
check("不是 unknown", tokenrhythm.unknown === undefined, String(tokenrhythm.unknown));

const discounted = readModelBilling("tokenrhythm", {
  ...tokenrhythmModel,
  has_discount: true,
  discount_input_price_per_million: "4.00000000",
  discount_pricing: { currency: "CNY", unit: "per_1m_tokens", prompt: "4.00000000", completion: "14.00000000", cache_read: "1.00000000" },
  effective_pricing: { currency: "CNY", unit: "per_1m_tokens", prompt: "4.00000000", completion: "14.00000000", cache_read: "1.00000000" },
});
check("打折时报的是生效价，不是原价", discounted.inputPerMillion === 4, String(discounted.inputPerMillion));
check("打折时输出价也是生效价", discounted.outputPerMillion === 14, String(discounted.outputPerMillion));

console.log("");
console.log("sensenova — 全是 0，没说币种也没说单位");

const sensenova = readModelBilling("sensenova", sensenovaModel);
check("报 unknown", sensenova.unknown === true, String(sensenova.unknown));
check("输入价不给", sensenova.inputPerMillion === undefined, String(sensenova.inputPerMillion));
check("输出价不给", sensenova.outputPerMillion === undefined, String(sensenova.outputPerMillion));
check("缓存读价不给", sensenova.cacheReadPerMillion === undefined, String(sensenova.cacheReadPerMillion));
check("币种不猜", sensenova.currency === undefined, String(sensenova.currency));

console.log("");
console.log("intern-ai — 每 token，USD");

const internAi = readModelBilling("intern-ai", internAiModel);
check("计费模式是 token", internAi.mode === "token", internAi.mode);
check("币种是 USD", internAi.currency === "USD", String(internAi.currency));
check("每 token 0.000016 换成每百万 16", internAi.inputPerMillion === 16, String(internAi.inputPerMillion));
check("输出每 token 0.000064 换成每百万 64", internAi.outputPerMillion === 64, String(internAi.outputPerMillion));
check("cached_prompt 落到缓存读价", internAi.cacheReadPerMillion === 3.2, String(internAi.cacheReadPerMillion));
check("不是 unknown", internAi.unknown === undefined, String(internAi.unknown));

console.log("");
console.log("opencode-go — 每百万，没写币种，按时段翻倍");

const opencodeGo = readModelBilling("opencode-go", opencodeGoModel);
check("计费模式是 token", opencodeGo.mode === "token", opencodeGo.mode);
check("输入价 0.15", opencodeGo.inputPerMillion === 0.15, String(opencodeGo.inputPerMillion));
check("输出价 0.6", opencodeGo.outputPerMillion === 0.6, String(opencodeGo.outputPerMillion));
check("缓存读价 0.003", opencodeGo.cacheReadPerMillion === 0.003, String(opencodeGo.cacheReadPerMillion));
check("倍率照抄", opencodeGo.multipliers?.[0]?.factor === 2, JSON.stringify(opencodeGo.multipliers));

console.log("");
console.log("倍率计费（表里的可选字段，用一张合成描述符验机制）");

// No in-scope platform bills purely by multiplier, but mode "multiplier" is part of
// the shared format, so the reader is exercised with a descriptor of its own rather
// than left as code nothing ever runs
BILLING_DESCRIPTORS["test-multiplier-only"] = { roles: {}, unit: "unknown", currency: { kind: "none" }, multipliers: "cost.multipliers" };
const multiplierOnly = readModelBilling("test-multiplier-only", { cost: { multipliers: [{ factor: 3 }] } });
check("只有倍率也是 multiplier 模式", multiplierOnly.mode === "multiplier", multiplierOnly.mode);
check("倍率照样读出来", multiplierOnly.multipliers?.[0]?.factor === 3, JSON.stringify(multiplierOnly.multipliers));

BILLING_DESCRIPTORS["test-credits"] = { roles: {}, unit: "unknown", currency: { kind: "none" }, credits: ["credits"] };
const credits = readModelBilling("test-credits", { credits: 0.15 });
check("倍率计费读成 credits", credits.mode === "multiplier" && credits.credits === 0.15, JSON.stringify(credits));

console.log("");
console.log("没有计费字段的模型");

const qiniu = readModelBilling("qiniu", qiniuModel);
check("模式是 none", qiniu.mode === "none", qiniu.mode);
check("没有价格字段", qiniu.inputPerMillion === undefined && qiniu.outputPerMillion === undefined);
check("没报错也没瞎猜", qiniu.unknown === undefined && qiniu.currency === undefined);

const bare = readModelBilling("tokenrhythm", { id: "glm-5.1" });
check("tokenrhythm 的模型少了 pricing 也是 none", bare.mode === "none", bare.mode);
check("不认识的平台是 none", readModelBilling("no-such-platform", tokenrhythmModel).mode === "none");
check("空对象不炸", readModelBilling("intern-ai", {}).mode === "none");

console.log("");
console.log("按平台行查描述符（id 优先，kind 兜底）");

// A vendor kind is the platform: however the user named the row, the models behind
// it are tokenrhythm's.
const byVendorKind = billingFor({ id: "tr-main", kind: "tokenrhythm" }, tokenrhythmModel);
check(
  "行名随便起，kind 命中",
  byVendorKind.mode === "token" && byVendorKind.inputPerMillion === 8 && byVendorKind.currency === "CNY",
  JSON.stringify(byVendorKind),
);

// opencode-go is a row of kind openai with its own base_url: the kind says "the
// OpenAI dialect" and nothing about whose models those are, so only the id can name
// the vendor. This is the case the id-first lookup exists for.
const byOwnId = billingFor({ id: "opencode-go", kind: "openai" }, opencodeGoModel);
check(
  "id 优先：kind 是 openai 也命中",
  byOwnId.mode === "token" && byOwnId.inputPerMillion === 0.15,
  JSON.stringify(byOwnId),
);
check(
  "opencode-go 那一条照样读得出分时段倍率",
  byOwnId.multipliers?.[0]?.factor === 2,
  JSON.stringify(byOwnId),
);

// A row the user made up: nothing to read, and nothing thrown. A model whose price
// nobody models is normal.
const madeUp = billingFor({ id: "my-relay", kind: "openai" }, tokenrhythmModel);
check(
  "自建的平台按 none 交回，不抛",
  madeUp.mode === "none" && madeUp.unknown === undefined && madeUp.currency === undefined,
  JSON.stringify(madeUp),
);

console.log("");
console.log("坏值当没给");

const badStrings = readModelBilling("tokenrhythm", {
  pricing: { currency: "CNY", prompt: "abc", completion: null, cache_read: "2.00000000" },
});
check("坏字符串当没给", badStrings.inputPerMillion === undefined, String(badStrings.inputPerMillion));
check("null 当没给", badStrings.outputPerMillion === undefined, String(badStrings.outputPerMillion));
check("好的那个照样读", badStrings.cacheReadPerMillion === 2, String(badStrings.cacheReadPerMillion));

const emptyString = readModelBilling("tokenrhythm", { pricing: { currency: "CNY", prompt: "" } });
check("空字符串不是 0", emptyString.mode === "none", emptyString.mode);

const partialInternAi = readModelBilling("intern-ai", {
  input_modalities: [{ type: "text", pricing: [{ type: "prompt", unit: "token" }] }],
  output_modalities: [{ type: "text", pricing: [{ type: "completion", unit: "token", cost_usd: "n/a" }] }],
});
check("intern-ai 缺 cost_usd 当没给", partialInternAi.mode === "none", partialInternAi.mode);

console.log("");
console.log("反证：带币种带单位的 0 是免费，不是 unknown");

const freeModel = readModelBilling("tokenrhythm", {
  pricing: { currency: "CNY", unit: "per_1m_tokens", prompt: "0", completion: "0", cache_read: "0" },
});
check("真的是 0 就报 0", freeModel.inputPerMillion === 0, String(freeModel.inputPerMillion));
check("真的是 0 就不给 unknown", freeModel.unknown === undefined, String(freeModel.unknown));

const freeOpencodeGo = readModelBilling("opencode-go", {
  cost: { text: { input: { price: 0, cache: { read: 0 } }, output: { price: 0 } } },
});
check("opencode-go 的 0 也是免费", freeOpencodeGo.inputPerMillion === 0, String(freeOpencodeGo.inputPerMillion));
check("opencode-go 的 0 不给 unknown", freeOpencodeGo.unknown === undefined, String(freeOpencodeGo.unknown));

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
