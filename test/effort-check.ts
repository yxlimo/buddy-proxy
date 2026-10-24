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

import { effortFromBudget, effortOf, anthropicToOpenAI, openaiToAnthropic } from "../lib/dialect/request.ts";

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

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
