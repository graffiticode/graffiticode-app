/**
 * Which trial represents a (case, variant) pair.
 *
 * Shared so the judge and the human label the SAME program. model-eval.ts picks
 * the candidate it sends to the judge with this; seed-eval-labels.ts picks the
 * candidate it writes into the label set with this. If the two ever diverged,
 * --calibrate would be comparing a judge's score of one trial against a human's
 * score of a different one and reporting the gap as judge error.
 */

/** Minimum shape needed to choose; both callers pass richer objects. */
export interface TrialLike {
  latencyMs: number;
  trial: number;
}

/**
 * Median-latency successful trial, ties broken by trial index.
 *
 * Median, not first: "first ok" makes the judged program depend on scheduling,
 * so re-running the same inputs can judge different code and move a ranking for
 * reasons unrelated to the models.
 *
 * Median, not best: best-of-N would systematically flatter whichever model has
 * the higher variance, which is the opposite of what a fair comparison needs.
 *
 * Returns null when nothing succeeded — callers decide whether that is a skip or
 * an error.
 */
export function pickRepresentative<T extends TrialLike>(runs: T[]): T | null {
  if (!runs.length) return null;
  const ordered = [...runs].sort((a, b) => a.latencyMs - b.latencyMs || a.trial - b.trial);
  return ordered[Math.floor((ordered.length - 1) / 2)];
}
