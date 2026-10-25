// lib/router/selection.ts — pick one candidate out of several.
//
// The same question comes up twice: the root route has several upstreams
// behind one published model, and an upstream has several accounts behind one
// request. Both are answered the same way — the candidates are put in order,
// and the first one that can serve the request takes it — so the logic lives
// here once.
//
// The package knows nothing about upstreams or accounts: a candidate is
// anything that can be tried, and the caller decides what a failure means.
// That is the only difference between the two callers: the root route treats
// every failure as "try the next one", the upstream side only moves on when
// the account itself is the problem.

/** How the candidates are used. */
export type SelectionStrategy = "single" | "fallback";

export interface SelectionCandidate<T> {
  /** The candidate's name: the log and the counters use it. */
  id: string;
  /** The weight: the bigger one is tried first. */
  weight: number;
  /** Try this candidate once. */
  run: () => Promise<T>;
}

export interface SelectionOptions<T> {
  strategy: SelectionStrategy;
  candidates: SelectionCandidate<T>[];
  /**
   * Does this error mean "this candidate cannot serve the request", so the
   * next one should be tried?
   *
   * Without it every error counts — the root route's behaviour, unchanged.
   */
  degradable?: (error: unknown) => boolean;
  /** Called after every attempt, whether it worked or not. */
  onAttempt?: (candidate: SelectionCandidate<T>, error: unknown | null) => void;
  /** The error to throw when nothing served the request. */
  failure?: (lastError: unknown, tried: string[]) => Error;
}

/**
 * Stop the selection.
 *
 * Some failures cannot be handed to another candidate: the answer has already
 * started, so there is nothing left to fall back to. The error that stopped it
 * is the one the caller gets.
 */
export class SelectionStop extends Error {
  /** The error that stopped the selection. */
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("the selection stopped");
    this.name = "SelectionStop";
    this.reason = reason;
  }
}

/**
 * Try the candidates until one of them answers.
 *
 * `single` runs the heaviest candidate and nothing else: a failure is the
 * failure, because a caller that asked for one candidate must not silently
 * get another one.
 *
 * `fallback` runs them from the heaviest to the lightest and stops at the
 * first one that answers. A failure moves on to the next candidate only when
 * `degradable` says the candidate itself was the problem; a failure that is
 * not degradable is the request's own fault and is thrown right away.
 */
export async function select<T>(options: SelectionOptions<T>): Promise<T> {
  // A strategy nobody knows is not a fallback. Running one anyway would send
  // the traffic somewhere the operator did not ask for, without a word.
  if (options.strategy !== "single" && options.strategy !== "fallback") {
    throw new Error(`unknown selection strategy: ${String(options.strategy)}`);
  }
  const candidates = byWeight(options.candidates);
  if (!candidates.length) {
    throw failureOf(options, undefined, []);
  }

  if (options.strategy === "single") {
    const only = candidates[0];
    try {
      const value = await only.run();
      options.onAttempt?.(only, null);
      return value;
    } catch (e) {
      options.onAttempt?.(only, e);
      if (e instanceof SelectionStop) throw e.reason;
      throw failureOf(options, e, [only.id]);
    }
  }

  const tried: string[] = [];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const value = await candidate.run();
      options.onAttempt?.(candidate, null);
      return value;
    } catch (e) {
      options.onAttempt?.(candidate, e);
      tried.push(candidate.id);
      if (e instanceof SelectionStop) throw e.reason;
      lastError = e;
      // Without a rule every failure moves on — the root route's behaviour.
      if (options.degradable && !options.degradable(e)) throw e;
    }
  }
  throw failureOf(options, lastError, tried);
}

/**
 * The candidates in the order they are tried: the heaviest first, and the
 * ones with the same weight in the order they came in.
 */
export function byWeight<T>(candidates: SelectionCandidate<T>[]): SelectionCandidate<T>[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.weight - a.candidate.weight || a.index - b.index)
    .map((entry) => entry.candidate);
}

/** The error to throw when no candidate served the request. */
function failureOf<T>(options: SelectionOptions<T>, lastError: unknown, tried: string[]): Error {
  if (options.failure) {
    const made = options.failure(lastError, tried);
    if (made) return made;
  }
  if (lastError instanceof Error) return lastError;
  return new Error(lastError ? String(lastError) : "no candidate could serve the request");
}
