// test/usage-check.ts — 请求级用量日志。
//
//   node --experimental-strip-types test/usage-check.ts
//
// 覆盖的是用量统计最容易写错的地方：按天分组（「今日用量」这个说法就靠它）、
// 按上游和按模型的分组、令牌的分摊、时间窗的边界、游标翻页、过期记录丢掉。
//
// 用的库是测试自己的（临时目录），不碰真的那个。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-check-"));
process.env.BUDDY_DATA_DIR = tmp;

const {
  listUsage,
  pruneUsage,
  recordUsage,
  localDay,
  clearUsage,
  maxTotals,
  usageTotals,
} = await import("../lib/usage.ts");
const { usageEvents, usageSummary } = await import("../lib/admin/usage.ts");

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

function clear(): void {
  clearUsage();
}

console.log("");
console.log("上游报的 usage 怎么算成令牌");

const openai = usageTotals({ prompt_tokens: 100, completion_tokens: 20 });
check("OpenAI 的输入就是 prompt_tokens", openai.promptTokens === 100, String(openai.promptTokens));
check("OpenAI 的输出是 completion_tokens", openai.completionTokens === 20, String(openai.completionTokens));

// Anthropic 把输入拆成三处：没命中缓存的、缓存读到的、缓存写进去的。
const anthropic = usageTotals({
  input_tokens: 7,
  output_tokens: 22,
  cache_read_input_tokens: 197,
  cache_creation_input_tokens: 0,
  output_tokens_details: { thinking_tokens: 18 },
});
check("Anthropic 的输入要加上缓存读到的", anthropic.promptTokens === 204, String(anthropic.promptTokens));
check("Anthropic 的输出是 output_tokens", anthropic.completionTokens === 22, String(anthropic.completionTokens));
check("推理令牌在 output_tokens_details 里", anthropic.reasoningTokens === 18, String(anthropic.reasoningTokens));

const openaiDetails = usageTotals({
  prompt_tokens: 100,
  completion_tokens: 20,
  completion_tokens_details: { reasoning_tokens: 5 },
});
check("OpenAI 的推理令牌在 completion_tokens_details 里", openaiDetails.reasoningTokens === 5);

check("没有 usage 是 0", usageTotals(null).promptTokens === 0);
check("什么都没有是 0", usageTotals({}).completionTokens === 0);

console.log("");
console.log("分几次报的 usage 要合起来");

// Anthropic 的流：message_start 报 0，message_delta 报 7 + 缓存读到的 197。
let merged = maxTotals(null, usageTotals({ input_tokens: 0, output_tokens: 0 }));
merged = maxTotals(
  merged,
  usageTotals({ input_tokens: 7, output_tokens: 22, cache_read_input_tokens: 197 }),
);
check("输入合起来是 204", merged.promptTokens === 204, String(merged.promptTokens));
check("输出合起来是 22", merged.completionTokens === 22, String(merged.completionTokens));

// 两种口径不能重复算：message_start 报 204，message_delta 报 7+197。
const twoWays = maxTotals(
  maxTotals(null, usageTotals({ input_tokens: 204, output_tokens: 0 })),
  usageTotals({ input_tokens: 7, output_tokens: 22, cache_read_input_tokens: 197 }),
);
check("两种口径不重复算", twoWays.promptTokens === 204, String(twoWays.promptTokens));

// 累计上报的：取大的那个。
const cumulative = maxTotals(
  usageTotals({ prompt_tokens: 50 }),
  usageTotals({ prompt_tokens: 120 }),
);
check("累计上报取大的", cumulative.promptTokens === 120, String(cumulative.promptTokens));

console.log("");
console.log("记一条请求");

clear();
const now = Date.now();
recordUsage({
  upstreamId: "qoder",
  upstreamModel: "glm-5.3",
  agentModel: "glm-5.3",
  agent: "pi",
  sessionId: "ses-1",
  parentSessionId: "",
  agentName: "be-match",
  client: "qoder",
  ok: true,
  status: 200,
  promptTokens: 100,
  completionTokens: 20,
  reasoningTokens: 5,
  latencyMs: 1200,
  error: "",
});

let events = listUsage();
check("记下一条", events.length === 1, String(events.length));
check("令牌原样存着", events[0].promptTokens === 100 && events[0].completionTokens === 20);
check("推理令牌单独存", events[0].reasoningTokens === 5);
check("今天是哪天", events[0].day === localDay(now), events[0].day);
check("id 是库里的序号", events[0].id > 0);

console.log("");
console.log("失败的请求也记");

recordUsage({
  upstreamId: "minimax",
  upstreamModel: "MiniMax-M3.1-Flash",
  agentModel: "MiniMax-M3.1-Flash",
  agent: "opencode",
  sessionId: "ses-1",
  parentSessionId: "ses-parent",
  agentName: "reviewer",
  client: "minimax",
  ok: false,
  status: 429,
  promptTokens: 10,
  completionTokens: 0,
  reasoningTokens: 0,
  latencyMs: 300,
  error: "upstream said no",
});

events = listUsage();
check("两条了", events.length === 2, String(events.length));
check("新的在前", events[0].upstreamId === "minimax");
check("失败的那条带着原因", events[0].error === "upstream said no", events[0].error);

console.log("");
console.log("合计与分组");

const summary = usageSummary();
check("请求数是两条", summary.total.requests === 2, String(summary.total.requests));
check("成功一条失败一条", summary.total.succeeded === 1 && summary.total.failed === 1);
check("输入令牌加起来", summary.total.promptTokens === 110, String(summary.total.promptTokens));
check("输出令牌加起来", summary.total.completionTokens === 20, String(summary.total.completionTokens));
check("推理令牌加起来", summary.total.reasoningTokens === 5, String(summary.total.reasoningTokens));
check("按上游分成两个", summary.byUpstream.length === 2, String(summary.byUpstream.length));
check("按模型分成两个", summary.byModel.length === 2, String(summary.byModel.length));
check("按天是一天", summary.byDay.length === 1, String(summary.byDay.length));

const qoder = summary.byUpstream.find((b) => b.key === "qoder");
check("qoder 那桶是第一条", qoder?.summary.requests === 1, String(qoder?.summary.requests));

console.log("");
console.log("今日用量");

// 昨天的一条：按天分组时它不能算进今天。
recordUsage({
  upstreamId: "qoder",
  upstreamModel: "glm-5.3",
  agentModel: "glm-5.3",
  agent: "pi",
  sessionId: "ses-1",
  parentSessionId: "",
  agentName: "be-match",
  client: "qoder",
  ok: true,
  status: 200,
  promptTokens: 999,
  completionTokens: 999,
  reasoningTokens: 0,
  latencyMs: 1,
  error: "",
  ts: now - 30 * 60 * 60 * 1000,
});

const today = usageSummary("", "today");
check("今日只有今天的两条", today.total.requests === 2, String(today.total.requests));
check("今日的令牌不含昨天那条", today.total.promptTokens === 110, String(today.total.promptTokens));

const all = usageSummary();
check("全部是三条", all.total.requests === 3, String(all.total.requests));
check("按天是两天", all.byDay.length === 2, String(all.byDay.length));
check("按天从早到晚", all.byDay[0].key < all.byDay[1].key, JSON.stringify(all.byDay.map((b) => b.key)));

console.log("");
console.log("筛与游标");

const byUpstream = usageSummary("qoder");
check("按上游筛", byUpstream.total.requests === 2, String(byUpstream.total.requests));

const onlyQoder = usageEvents("", "glm-5.3");
check("按模型筛", onlyQoder.length === 2, String(onlyQoder.length));

const page1 = usageEvents("", "", 2);
check("限量", page1.length === 2, String(page1.length));
const page2 = usageEvents("", "", 2, page1[page1.length - 1].id);
check("游标取到更早的", page2.length === 1, String(page2.length));
check(
  "两页不重",
  !page1.some((a) => page2.some((b) => b.id === a.id)),
);

console.log("");
console.log("丢掉太老的");

recordUsage({
  upstreamId: "qoder",
  upstreamModel: "old",
  agentModel: "old",
  agent: "pi",
  sessionId: "ses-1",
  parentSessionId: "",
  agentName: "be-match",
  client: "qoder",
  ok: true,
  status: 200,
  promptTokens: 1,
  completionTokens: 1,
  reasoningTokens: 0,
  latencyMs: 1,
  error: "",
  ts: now - 200 * 24 * 60 * 60 * 1000,
});
const removed = pruneUsage(90);
check("丢掉了那条", removed === 1, String(removed));
check("剩下的还在", listUsage().length === 3, String(listUsage().length));

console.log("");
console.log("会话与子代理");

// 一个没有会话头的请求：算「未知」，父会话算「主代理」。
recordUsage({
  upstreamId: "qoder",
  upstreamModel: "glm-5.3",
  agentModel: "glm-5.3",
  agent: "curl",
  sessionId: "",
  parentSessionId: "",
  agentName: "",
  client: "qoder",
  ok: true,
  status: 200,
  promptTokens: 5,
  completionTokens: 5,
  reasoningTokens: 0,
  latencyMs: 10,
  error: "",
  ts: now,
});

const bySession = usageSummary("", "");
const sessionKeys = bySession.bySession.map((b) => b.key).sort();
check(
  "按会话分组：ses-1 和未知各一份",
  sessionKeys.length === 2 && sessionKeys.includes("ses-1") && sessionKeys.includes("未知"),
  JSON.stringify(sessionKeys),
);
const parentKeys = bySession.byParentSession.map((b) => b.key).sort();
check(
  "按父会话分组：父会话和主代理各一份",
  parentKeys.length === 2 && parentKeys.includes("ses-parent") && parentKeys.includes("主代理"),
  JSON.stringify(parentKeys),
);
const stored = listUsage();
check(
  "事件里存着会话与父会话",
  stored.some((e) => e.sessionId === "ses-1" && e.parentSessionId === "ses-parent"),
  JSON.stringify(stored.map((e) => [e.sessionId, e.parentSessionId])),
);
check(
  "事件里存着 agent 名",
  stored.some((e) => e.agentName === "be-match"),
  JSON.stringify(stored.map((e) => e.agentName)),
);

const byAgentName = bySession.byAgentName.map((b) => b.key).sort();
check(
  "按 agent 名分组：be-match、reviewer 与未知各一份",
  byAgentName.length === 3 && byAgentName.includes("be-match") && byAgentName.includes("reviewer"),
  JSON.stringify(byAgentName),
);
const bySubagent = bySession.bySubagent.map((b) => b.key).sort();
check(
  "按子代理分组是「agent 名 @ 父会话」",
  bySubagent.some((k) => k === "reviewer @ ses-parent"),
  JSON.stringify(bySubagent),
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
