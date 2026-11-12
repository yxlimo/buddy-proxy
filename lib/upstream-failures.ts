// lib/upstream-failures.ts — how the last few requests against a platform ended.
//
// A platform can be green on every criterion the judgment knows — accounts on,
// credentials fine, quota fine, no cooldown — and still serve nothing: the upstream
// parks the model in a queue on every single request. A queued answer never cools an
// account down (the account is not at fault, and a cooldown would take that account's
// other models down with it), so nothing the panel looked at ever moved. Measured:
// qoder and qoder-cn answered `queued` on 116 of 119 attempts over two days, and the
// panel said ready the whole time.
//
// What this file keeps is the one fact the judgment could not see: what the last few
// requests actually ended as. The router writes one entry per finished request (not one
// per upstream attempt inside it: a request that tried qoder three times is still one
// request the caller never got an answer from), and the judgment
// reads the recent ones.
//
// Successes are recorded too (kind "ok", not skipped). "Every request was queued" only
// means something against the mix: a ring holding nothing but failures cannot tell
// "queued twice in a row" from "queued twice, and three good answers in between" —
// and one queued answer is an accident, not a state.
//
// It is a leaf (no imports), because both sides need it and they must not meet: the
// router writes it, the judgment in lib/admin/platform-state.ts reads it, and the
// admin layer does not import the routing layer (see that file's header). A leaf both
// can import is the only shape that keeps them apart.
//
// In memory only, like the quota snapshot (lib/health-cache.ts): it is a trace of what
// just happened, not state of our own. A restart must not resurrect yesterday's queue.

/** One finished request: how it ended, and when. */
export interface UpstreamAttempt {
  /** The kind the classification gave the failure (lib/router/provider-selection.ts), or "ok". */
  kind: string;
  /** Unix ms. */
  at: number;
}

/**
 * How many requests per platform are kept.
 *
 * A ring, not a history: the judgment only ever asks "was every request in the last
 * few minutes queued", and a long list would keep saying "queued" long after the
 * queue cleared.
 */
const MAX_ATTEMPTS = 20;

/** Per platform, the most recent requests, oldest first. */
const attempts = new Map<string, UpstreamAttempt[]>();

/**
 * Note how one request against this platform ended.
 *
 * Called with "ok" when the upstream answered: the ring has to hold both outcomes or
 * the recency question has no answer.
 */
export function noteUpstreamFailure(platform: string, kind: string, at = Date.now()): void {
  const list = attempts.get(platform);
  if (!list) {
    attempts.set(platform, [{ kind, at }]);
    return;
  }
  list.push({ kind, at });
  // The oldest ones go first. The reader's window prunes too (see
  // recentUpstreamFailures), but a busy platform is written far more often than it is
  // read — without this the list grows for a whole day and the window would have to
  // walk all of it to answer a question about the last ten minutes.
  if (list.length > MAX_ATTEMPTS) list.splice(0, list.length - MAX_ATTEMPTS);
}

/**
 * The requests this platform saw inside the window, oldest first.
 *
 * The window belongs to the reader: "recent" is a different number of minutes for the
 * panel than for whoever asks next, and a window fixed in here would have to be
 * guessed again at every call site.
 */
export function recentUpstreamFailures(
  platform: string,
  windowMs: number,
  now = Date.now(),
): UpstreamAttempt[] {
  const list = attempts.get(platform);
  if (!list?.length) return [];
  const from = now - windowMs;
  return list.filter((one) => one.at >= from);
}
