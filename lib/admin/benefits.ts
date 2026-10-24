// lib/admin/benefits.ts — 每日权益的跑腿器，/health 与面板共用。
//
// 签到是幂等的：问两次，平台会答「已经领过了」。所以这里不需要自己的状态
// 文件，跑一次记一次就行。

import { configFlag, configString } from "../config.ts";
import { BenefitsRunner } from "../router/benefits.ts";
import type { BenefitUpstream } from "../benefits.ts";
import { upstreamEnabled } from "./upstreams.ts";

/**
 * 多久跑一次签到。
 *
 * 中国区的日子是按北京时间翻的。间隔是一小时而不是一天：Buddy 那趟活动
 * 只有一到四个小时，已经到账的赠金放着不动就是白等几个小时。
 */
export const BENEFITS_INTERVAL_MS = Number(configString("BENEFITS_INTERVAL_MS", "") || 60 * 60 * 1000);

/** 参与签到的账号，而且得是开着的。 */
export function benefitUpstreams(): BenefitUpstream[] {
  if (configFlag("BENEFITS_DISABLED", false)) return [];
  const out: BenefitUpstream[] = [];
  if (upstreamEnabled("minimax")) out.push("minimax");
  if (upstreamEnabled("workbuddy-cn")) out.push("workbuddy-cn");
  if (upstreamEnabled("qoder-cn")) out.push("qoder-cn");
  if (upstreamEnabled("qoder")) out.push("qoder-global");
  return out;
}

/** 跑腿器。整个进程只有一个，面板和 /health 看的是同一份。 */
export const benefits = new BenefitsRunner({
  intervalMs: BENEFITS_INTERVAL_MS,
  upstreams: benefitUpstreams(),
});
