// test/effort-check.ts — 思考档位在方言转换里不丢。
//
//   node --experimental-strip-types test/effort-check.ts
//
// agent 说的思考档位有几种写法：Anthropic 方言的 output_config.effort、
// OpenAI 方言的 reasoning_effort、显式的 effort，还有 Anthropic 的
// thinking.budget_tokens（一个预算数字，说不清是哪一档）。
//
// 档位要么原样到上游，要么明确地降一级。预算数字推不出顶档 —— 但预算
// 太大时可以当成顶档。

import {
  effortFromBudget,
  effortOf,
  anthropicToOpenAI,
  openaiToAnthropic,
  thinkingFields,
  thinkingIntentOf,
} from "../lib/dialect/request.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("读档位");

check(
  "output_config.effort 是 Anthropic 方言的写法",
  effortOf({ output_config: { effort: "max" } }) === "max",
  String(effortOf({ output_config: { effort: "max" } })),
);
check(
  "reasoning_effort 是 OpenAI 方言的写法",
  effortOf({ reasoning_effort: "high" }) === "high",
  String(effortOf({ reasoning_effort: "high" })),
);
check(
  "档位比预算大：档位说话",
  effortOf({ output_config: { effort: "max" }, thinking: { budget_tokens: 16384 } }) === "max",
  String(effortOf({ output_config: { effort: "max" }, thinking: { budget_tokens: 16384 } })),
);
check(
  "没有档位只有预算：预算说话",
  effortOf({ thinking: { budget_tokens: 8192 } }) === "medium",
  String(effortOf({ thinking: { budget_tokens: 8192 } })),
);
check(
  "什么都没有：没有档位",
  effortOf({}) === undefined,
  String(effortOf({})),
);

console.log("");
console.log("预算换档位");

check("1024 是 low", effortFromBudget(1024) === "low");
check("2048 是 low", effortFromBudget(2048) === "low");
check("8192 是 medium", effortFromBudget(8192) === "medium");
check("16384 是 high", effortFromBudget(16384) === "high");
check("32768 是 max", effortFromBudget(32768) === "max");
check("64000 是 max", effortFromBudget(64000) === "max");

console.log("");
console.log("Anthropic → OpenAI");

const toOpenAI = anthropicToOpenAI({
  model: "m",
  messages: [],
  thinking: { type: "enabled", budget_tokens: 16384 },
  output_config: { effort: "max" },
});
check("档位原样带过去", toOpenAI.reasoning_effort === "max", JSON.stringify(toOpenAI.reasoning_effort));

const budgetOnly = anthropicToOpenAI({
  model: "m",
  messages: [],
  thinking: { type: "enabled", budget_tokens: 16384 },
});
check("只有预算时按预算算", budgetOnly.reasoning_effort === "high", JSON.stringify(budgetOnly.reasoning_effort));

const adaptive = anthropicToOpenAI({
  model: "m",
  messages: [],
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "max" },
});
check("自适应思考也带档位", adaptive.reasoning_effort === "max", JSON.stringify(adaptive.reasoning_effort));

console.log("");
console.log("OpenAI → Anthropic");

const toAnthropic = openaiToAnthropic({
  model: "m",
  messages: [],
  reasoning_effort: "max",
});
check(
  "max 是一个大预算",
  Number(toAnthropic.thinking?.budget_tokens) > 16384,
  JSON.stringify(toAnthropic.thinking),
);

// 关掉思考：两个方向都得过同一层。
//
// 网关不知道上游按哪个名字读思考开关，所以 OpenAI 方言那边两种拼法一起发；
// 「什么都没写」必须一个字段都不多给 —— 那是调用方没意见，不是关。
console.log("");
console.log("读意图");

const offIntent = (body: Record<string, unknown>) => thinkingIntentOf(body)?.off === true;

check("thinking.type=disabled 是关", offIntent({ thinking: { type: "disabled" } }));
check("reasoning_effort=none 是关", offIntent({ reasoning_effort: "none" }));
check("大小写和空格不影响", offIntent({ reasoning_effort: " NONE " }));
check("自相矛盾时以关为准", offIntent({ thinking: { type: "disabled" }, output_config: { effort: "high" } }));
check(
  "分级是档位不是关",
  thinkingIntentOf({ thinking: { type: "adaptive" }, output_config: { effort: "high" } })?.off === false,
);
check("什么都没写是没有意图", thinkingIntentOf({ model: "m" }) === undefined);

// 「关」有三个拼法，从哪个字段进来都得认：pi 的档位名是 off，opencode 的
// 变体名将来也是 off，Anthropic 形状写 disabled，OpenAI 的档位里写 none。
console.log("");
console.log("三个拼法、三个字段");

for (const [field, value] of [
  ["output_config.effort", "off"],
  ["effort", "off"],
  ["reasoning_effort", "disabled"],
  ["reasoning_effort", "off"],
  ["effort", "disabled"],
  ["output_config.effort", "none"],
] as const) {
  const body: Record<string, any> = field === "output_config.effort" ? { output_config: { effort: value } } : { [field]: value };
  const sent = thinkingFields(body, "openai");
  check(
    `${field}="${value}" 是关，且 OpenAI 方言两种字段一起发`,
    thinkingIntentOf(body)?.off === true && sent.reasoning_effort === "none" && sent.thinking?.type === "disabled",
    JSON.stringify(sent),
  );
}
check("off 不是档位：effortOf 不把它当层级返回", effortOf({ output_config: { effort: "off" } }) === undefined, String(effortOf({ output_config: { effort: "off" } })));
check(
  "off 压过同一请求里的预算",
  effortOf({ reasoning_effort: "off", thinking: { budget_tokens: 8192 } }) === undefined,
  String(effortOf({ reasoning_effort: "off", thinking: { budget_tokens: 8192 } })),
);

console.log("");
console.log("兼容层：Anthropic → OpenAI 方言");

const offToOpenAI = anthropicToOpenAI({ model: "m", messages: [], thinking: { type: "disabled" } });
check("关：发 reasoning_effort=none", offToOpenAI.reasoning_effort === "none", String(offToOpenAI.reasoning_effort));
check("关：同时发 thinking disabled", offToOpenAI.thinking?.type === "disabled", JSON.stringify(offToOpenAI.thinking));

const levelToOpenAI = anthropicToOpenAI({
  model: "m",
  messages: [],
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
});
check("分级：档位原样", levelToOpenAI.reasoning_effort === "high", String(levelToOpenAI.reasoning_effort));
check("分级：同时发 thinking enabled", levelToOpenAI.thinking?.type === "enabled", JSON.stringify(levelToOpenAI.thinking));

const bareToOpenAI = anthropicToOpenAI({ model: "m", messages: [] });
check("没写：不强加 reasoning_effort", !("reasoning_effort" in bareToOpenAI), JSON.stringify(bareToOpenAI));
check("没写：不强加 thinking", !("thinking" in bareToOpenAI), JSON.stringify(bareToOpenAI));

console.log("");
console.log("兼容层：OpenAI → Anthropic 方言");

const offToAnthropic = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "none" });
check("关：发 thinking disabled", offToAnthropic.thinking?.type === "disabled", JSON.stringify(offToAnthropic.thinking));
check("关：不发 output_config（Anthropic 没有 none 这档）", !("output_config" in offToAnthropic), JSON.stringify(offToAnthropic));
check("关：不发 reasoning_effort", !("reasoning_effort" in offToAnthropic), JSON.stringify(offToAnthropic));

const anthropicSpelledOff = openaiToAnthropic({ model: "m", messages: [], thinking: { type: "disabled" } });
check("关：Anthropic 拼法也认", anthropicSpelledOff.thinking?.type === "disabled", JSON.stringify(anthropicSpelledOff.thinking));

const lowToAnthropic = openaiToAnthropic({ model: "m", messages: [], reasoning_effort: "low" });
check("分级：换成预算", lowToAnthropic.thinking?.type === "enabled" && Number(lowToAnthropic.thinking?.budget_tokens) > 0, JSON.stringify(lowToAnthropic.thinking));

const bareToAnthropic = openaiToAnthropic({ model: "m", messages: [] }, 4096);
check("没写：不强加 thinking", !("thinking" in bareToAnthropic), JSON.stringify(bareToAnthropic));

console.log("");
console.log("兼容层本身");

check("没意图时两个方向都是空", JSON.stringify(thinkingFields({}, "openai")) === "{}" && JSON.stringify(thinkingFields({}, "anthropic")) === "{}");
check(
  "关：OpenAI 那边两个字段一起",
  thinkingFields({ thinking: { type: "disabled" } }, "openai").reasoning_effort === "none" &&
    thinkingFields({ thinking: { type: "disabled" } }, "openai").thinking?.type === "disabled",
  JSON.stringify(thinkingFields({ thinking: { type: "disabled" } }, "openai")),
);

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
