// lib/router/benefits.ts — the daily check-in of the China accounts.
//
// Both China accounts hand out credits for showing up. The router takes them
// without being asked: on startup, and then every few hours. Every call is
// idempotent — asking twice answers "already done" — so no state file of its
// own is needed.
//
// The switch decides which accounts take part; one that is off is not looked
// at.

import { runBenefits, type BenefitOutcome, type BenefitUpstream } from "../benefits.ts";

export interface BenefitsOptions {
  /** How often the check-in runs. */
  intervalMs: number;
  /**
   * The accounts that hand out credits.
   *
   * A function, not a list: the panel can add an account or switch one on
   * after the runner was made, and the next run has to know about it.
   */
  upstreams: () => BenefitUpstream[];
  /**
   * How to sign in.
   *
   * The default is the real thing. The split exists so the timer can be
   * checked offline: the real one talks to the upstream.
   */
  run?: (upstreams: BenefitUpstream[]) => Promise<BenefitOutcome[]>;
}

export interface BenefitsState {
  /** When the last run finished. */
  lastRunAt: string | null;
  /** What that run did. */
  lastOutcome: BenefitOutcome[] | null;
  /** A run is in progress. */
  running: boolean;
}

export class BenefitsRunner {
  private state: BenefitsState = { lastRunAt: null, lastOutcome: null, running: false };
  private readonly options: BenefitsOptions;

  // The options are a plain field, not a parameter property: the code runs
  // through Node's type stripping, which does not rewrite those.
  constructor(options: BenefitsOptions) {
    this.options = options;
  }

  /** The state of the last run, for the health endpoint. */
  get lastRun(): BenefitsState {
    return this.state;
  }

  /**
   * Take the daily benefits, if there is a session to take them with.
   */
  async runOnce(): Promise<void> {
    if (this.state.running) return;
    const upstreams = this.options.upstreams();
    if (!upstreams.length) return;
    this.state.running = true;
    try {
      const run = this.options.run;
      const outcomes = run ? await run(upstreams) : await runBenefits(upstreams);
      this.state.lastRunAt = new Date().toISOString();
      this.state.lastOutcome = outcomes;
      for (const outcome of outcomes) {
        const what = outcome.credits ? `+${outcome.credits} credits` : "nothing new";
        console.log(`  [BENEFITS] ${outcome.upstream}: ${what} — ${outcome.report.join("; ")}`);
      }
    } catch (e) {
      console.warn(`  [BENEFITS] failed: ${(e as Error).message}`);
    } finally {
      this.state.running = false;
    }
  }

  /**
   * Take the benefits now.
   *
   * There is no timer of its own: the periodic runner (lib/periodic.ts) calls
   * this, so a login state has one timer over it, not two.
   */
}
