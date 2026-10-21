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
  /** The accounts that hand out credits. */
  upstreams: BenefitUpstream[];
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
  private timer: NodeJS.Timeout | null = null;
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
    if (!this.options.upstreams.length) return;
    this.state.running = true;
    try {
      const outcomes = await runBenefits(this.options.upstreams);
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

  /** Run the benefits now, and then on the timer. */
  start(): void {
    if (!this.options.upstreams.length) return;
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    // The login may still be waiting for an approval, so the first run waits a
    // minute for the session to be there.
    setTimeout(() => void this.runOnce(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
