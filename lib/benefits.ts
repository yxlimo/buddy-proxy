// lib/benefits.ts — the daily benefits of the accounts.
//
// Each client keeps its own; this is the part they share: what an outcome
// looks like, and the runner that asks every enabled upstream.

import { runWorkBuddyBenefits } from "./workbuddy/benefits.ts";
import { runQoderBenefits } from "./qoder/benefits.ts";
import { runMiniMaxBenefits } from "./minimax/checkin.ts";
import { provider } from "./providers.ts";

/**
 * 参与签到的账号：provider 的 id。
 *
 * 签到是账号的事 —— 上游名下的每个账号都要签，转发时先调哪个是策略的事。
 */
export type BenefitUpstream = string;

export interface BenefitOutcome {
  upstream: string;
  ok: boolean;
  credits: number;
  report: string[];
  at: string;
}

/**
 * 各家怎么签到。
 *
 * 拆出来是为了能离线测：真跑的时候用的是真的那三个。
 */
export interface BenefitRunners {
  workbuddy: (providerId: string) => Promise<BenefitOutcome>;
  minimax: (providerId: string) => Promise<BenefitOutcome>;
  qoder: (providerId: string) => Promise<BenefitOutcome>;
}

const REAL_RUNNERS: BenefitRunners = {
  workbuddy: (providerId) => runWorkBuddyBenefits(providerId),
  minimax: (providerId) => runMiniMaxBenefits(providerId),
  qoder: (providerId) => runQoderBenefits(providerId),
};

/**
 * Run the benefits of every account given.
 *
 * 一个账号一次：名下的账号都要签到，不因策略而漏签 —— 策略管的是转发时先调
 * 谁，跟签到没关系。
 */
export async function runBenefits(
  upstreams: BenefitUpstream[],
  runners: BenefitRunners = REAL_RUNNERS,
): Promise<BenefitOutcome[]> {
  const out: BenefitOutcome[] = [];
  for (const id of upstreams) {
    const kind = provider(id)?.kind ?? "";
    if (kind === "workbuddy") out.push(await runners.workbuddy(id));
    else if (kind === "minimax") out.push(await runners.minimax(id));
    else if (kind === "qoder") out.push(await runners.qoder(id));
  }
  return out;
}
