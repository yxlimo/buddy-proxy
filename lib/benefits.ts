// lib/benefits.ts — the daily benefits of the accounts.
//
// Each client keeps its own; this is the part they share: what an outcome
// looks like, and the runner that asks every enabled upstream.

import { runWorkBuddyBenefits } from "./workbuddy/benefits.ts";
import { runQoderBenefits } from "./qoder/benefits.ts";

export type BenefitUpstream = "workbuddy-cn" | "qoder-cn" | "qoder-global";

export interface BenefitOutcome {
  upstream: string;
  ok: boolean;
  credits: number;
  report: string[];
  at: string;
}

/** Run the benefits of every enabled upstream. */
export async function runBenefits(upstreams: BenefitUpstream[]): Promise<BenefitOutcome[]> {
  const out: BenefitOutcome[] = [];
  for (const upstream of upstreams) {
    if (upstream === "workbuddy-cn") out.push(await runWorkBuddyBenefits());
    // The provider id, not the region: that is what the session key is made of.
    else out.push(await runQoderBenefits(upstream === "qoder-cn" ? "qoder-cn" : "qoder"));
  }
  return out;
}
