// tests/seed-usage.ts — 给面板 e2e 铺用量事件（离线测试数据）。
//
//   BUDDY_DATA_DIR=<这次运行的数据目录> node --experimental-strip-types \
//     tests/seed-usage.ts <preset> <upstreamId>
//
// 为什么需要它：用量页的「按会话 / 按主会话 / 按子代理」三块卡片要从
// GetUsageSummary 的分桶里摆数据，而分桶来自真实的请求记账 —— 没有一条
// 真请求能凭空长出十二个会话来。所以这一步把用量事件直接写进库
// （`lib/usage.ts` 的 `recordUsage`，与网关记账走同一条路径），铺完之后
// 面板照常从库里聚出来。这一套验的是「面板把分桶摆成什么」，不是记账
// 本身 —— 后者有别的用例。
//
// 事件都记在测试自备的 upstreamId 名下：用例用地址参数
// `/admin/usage?upstream=<id>` 把页面筛到这一份上，别的用例（签到跑腿那种
// 会记账的）留下的用量不会混进来。
//
// 不建平台、不改任何配置；只碰 BUDDY_DATA_DIR 那一份库，绝不落回
// ~/.buddy-proxy 或 NAS 上的库。

import { recordUsage } from '../lib/usage.ts';

const [preset, upstreamId] = process.argv.slice(2);

if (!process.env.BUDDY_DATA_DIR) {
  throw new Error('需要 BUDDY_DATA_DIR（这次运行的数据目录）');
}
if (!preset || !upstreamId) {
  throw new Error('用法：seed-usage.ts <sessions-12|sessions-3|sessions-10|subagents-12> <upstreamId>');
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 每个事件一份不同的令牌数：总量随序号递增，分桶按令牌从大到小排出来的
 * 顺序就是确定的（lib/admin/usage.ts 的 byTokens），用例才能断言「截的是
 * 排序后的前 10」。
 */
function tokensFor(index: number): { promptTokens: number; completionTokens: number } {
  return { promptTokens: (13 - index) * 1000, completionTokens: index * 10 };
}

function event(index: number, extra: {
  sessionId: string;
  parentSessionId?: string;
  agentName?: string;
  agent?: string;
}) {
  const { promptTokens, completionTokens } = tokensFor(index);
  return {
    upstreamId,
    upstreamModel: 'e2e-model',
    agentModel: 'e2e-agent-model',
    agent: extra.agent ?? 'e2e-top',
    sessionId: extra.sessionId,
    parentSessionId: extra.parentSessionId ?? '',
    agentName: extra.agentName ?? '',
    client: '',
    ok: true,
    status: 200,
    promptTokens,
    completionTokens,
    reasoningTokens: 0,
    latencyMs: 42,
    error: '',
  };
}

let events: ReturnType<typeof event>[];

switch (preset) {
  // 12 个不同的主代理会话：超过 10 条的那一档。
  case 'sessions-12':
    events = Array.from({ length: 12 }, (_, i) =>
      event(i + 1, { sessionId: `ses_e2etop-s${pad(i + 1)}` }));
    break;
  // 3 个会话：不足 10 条。
  case 'sessions-3':
    events = Array.from({ length: 3 }, (_, i) =>
      event(i + 1, { sessionId: `ses_e2etop3-s${pad(i + 1)}` }));
    break;
  // 正好 10 个会话：截断的边界。
  case 'sessions-10':
    events = Array.from({ length: 10 }, (_, i) =>
      event(i + 1, { sessionId: `ses_e2etop10-s${pad(i + 1)}` }));
    break;
  // 12 个子代理：每个事件自己的会话、自己的父会话、自己的 agent 名 ——
  // 按会话 / 按主会话 / 按子代理三块在同一份播种里各得 12 桶。
  case 'subagents-12':
    events = Array.from({ length: 12 }, (_, i) =>
      event(i + 1, {
        sessionId: `ses_e2e4-s${pad(i + 1)}`,
        parentSessionId: `ses_e2e4-p${pad(i + 1)}`,
        agentName: `w${pad(i + 1)}`,
        agent: 'e2e-sub',
      }));
    break;
  default:
    throw new Error(`不认识的形状：${preset}`);
}

for (const e of events) recordUsage(e);
console.log(JSON.stringify({ preset, upstream: upstreamId, seeded: events.length }));
