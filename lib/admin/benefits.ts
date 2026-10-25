// lib/admin/benefits.ts — 每日权益的跑腿器，/health 与面板共用。
//
// 签到是幂等的：问两次，平台会答「已经领过了」。所以这里不需要自己的状态
// 文件，跑一次记一次就行。

import { configFlag, configString } from "../config.ts";
import { BenefitsRunner } from "../router/benefits.ts";
import type { BenefitUpstream } from "../benefits.ts";
import { listProviders } from "../providers.ts";

/**
 * 多久跑一次签到。
 *
 * 中国区的日子是按北京时间翻的。间隔是一小时而不是一天：Buddy 那趟活动
 * 只有一到四个小时，已经到账的赠金放着不动就是白等几个小时。
 */
export const BENEFITS_INTERVAL_MS = Number(configString("BENEFITS_INTERVAL_MS", "") || 60 * 60 * 1000);

/**
 * 这些种类的账号每天给积分。
 *
 * 按种类列，不列几个写死的 id：签到是账号的事，一个上游名下的每个账号都要
 * 签到，用户自己加的第二个 Qoder 账号也一样。转发时先调哪个账号是策略的事，
 * 跟签到无关 —— 策略不会让哪个账号漏签。
 */
const BENEFIT_KINDS = new Set(["minimax", "workbuddy", "qoder"]);

/** 参与签到的账号，而且得是开着的。 */
export function benefitUpstreams(): BenefitUpstream[] {
  if (configFlag("BENEFITS_DISABLED", false)) return [];
  return listProviders()
    .filter((row) => row.enabled && BENEFIT_KINDS.has(row.kind))
    .map((row) => row.id);
}

/** 跑腿器。整个进程只有一个，面板和 /health 看的是同一份。 */
export const benefits = new BenefitsRunner({
  intervalMs: BENEFITS_INTERVAL_MS,
  // 现问：面板上刚加的上游、刚开的开关，下一次跑就能算进去 —— 定时器是一直
  // 设着的（启动时还没有账号也设），不只是面板上那个「现在签到」按钮。
  upstreams: benefitUpstreams,
});
