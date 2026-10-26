// lib/benefits.ts — the daily benefits of the accounts.
//
// Each client keeps its own; this is the part they share: what an outcome
// looks like, and the runner that asks every enabled upstream.
//
// Which kind of upstream hands out credits is in the kind registry
// (lib/kinds.ts): a kind that does not give anything is simply not asked.
// Adding a kind is one entry there, not another branch here.

import { kindOf, type BenefitOutcome } from "./provider-kinds.ts";
import { provider } from "./providers.ts";
// The kinds register themselves; importing the file is what makes them known.
import "./kinds.ts";

export type { BenefitOutcome };

/**
 * 参与签到的账号：provider 的 id。
 *
 * 签到是账号的事 —— 上游名下的每个账号都要签，转发时先调哪个是策略的事。
 */
export type BenefitUpstream = string;

/** 一类上游的签到跑法。 */
export type BenefitRunner = (providerId: string) => Promise<BenefitOutcome>;

/**
 * 每类上游的签到跑法。
 *
 * 真的那份在 kind 注册表里；这份是给离线自测用的 —— 假的跑法换掉真的，
 * 一个上游都不碰。
 */
export type BenefitRunners = Record<string, BenefitRunner>;

/**
 * 注册表里那一类上游的签到跑法。
 *
 * 没有登记签到的种类就是没有：它不发积分，问它也是白问。
 */
function registeredRunner(kind: string): BenefitRunner | null {
  const entry = kindOf(kind);
  if (!entry?.benefits) return null;
  return (providerId) => {
    const row = provider(providerId);
    if (!row) throw new Error(`没有这个 Provider：${providerId}`);
    return entry.benefits!(row);
  };
}

/**
 * Run the benefits of every account given.
 *
 * 一个账号一次：名下的账号都要签到，不因策略而漏签 —— 策略管的是转发时先调
 * 谁，跟签到没关系。
 *
 * 给了 runners 就是用那份（离线自测：假的跑法，不碰任何上游）；没给就用注册
 * 表里登记的那个种类。
 */
export async function runBenefits(
  upstreams: BenefitUpstream[],
  runners?: BenefitRunners,
): Promise<BenefitOutcome[]> {
  const out: BenefitOutcome[] = [];
  for (const id of upstreams) {
    const row = provider(id);
    if (!row) continue;
    const runner = runners ? runners[row.kind] : registeredRunner(row.kind);
    if (!runner) continue;
    // 一个账号出错不挡着别的账号：签到是每个账号各自的事，一个账号的会话
    // 坏了，别的账号今天也该签上。
    try {
      out.push(await runner(id));
    } catch (e) {
      out.push({
        upstream: id,
        ok: false,
        credits: 0,
        report: [`签到出错：${(e as Error)?.message ?? String(e)}`],
        at: new Date().toISOString(),
      });
    }
  }
  return out;
}
