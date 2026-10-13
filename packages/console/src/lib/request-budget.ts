/**
 * A token ceiling for ONE code-generation request.
 *
 * Every budget in this codebase is denominated in items or in wall-clock.
 * Nothing bounded the tokens a single request could spend: `MAX_FIX_ATTEMPTS`
 * is per generateCode rather than per request, so composition multiplies it to
 * 25 repair generations, and the only request-wide bound is the 420s deadline
 * (generate-for-request.ts). A request that keeps failing verification can
 * therefore spend without limit until the clock runs out.
 *
 * This is a circuit breaker, not a quota. The ceilings sit far above real
 * traffic (see the defaults below) and exist to stop a pathology, so a request
 * that trips one is a bug report, not a customer who should upgrade. That is
 * why the refusal message never mentions plans or token counts.
 *
 * WHERE IT CHARGES, and why it matters. The obvious seam is recordTokenUsage(),
 * the single `ai_generation` writer that every stage already calls. It is the
 * wrong seam: it runs only on success. A failed generation throws in
 * code-generation-service before reaching it, and the all-providers-failed path
 * in llm-generation-service returns EMPTY_USAGE(), so failures are invisible
 * there — which is precisely the case a runaway consists of. The accumulator
 * instead sits at `requestProvider`, the one chokepoint every streaming
 * provider call passes through, so aborted, stalled and failed attempts all
 * charge. Those tokens were genuinely spent.
 *
 * Deliberately NOT covered, so nobody "completes" the coverage later:
 * generateSpec (a different resolver, not inside generateCodeForRequest), the
 * offline funnel narrator, and embeddings (on this path, but ~1/1000 the cost
 * per token and absent from the distribution the ceilings were measured
 * against).
 */

// Type-only: this module must not import from the codegen tree, which imports
// it. `import type` erases at compile, so it cannot create a cycle.
import type { TokenUsage } from "./llm-generation-service";

export type BudgetMode = "shadow" | "enforce" | "off";

export interface RequestBudget {
  readonly rid: string;
  readonly tokenLimit: number;
  readonly callLimit: number;
  readonly mode: BudgetMode;
  tokens: number;
  calls: number;
  /** Which ceiling was crossed first. Set once, then sticky. */
  trippedOn: "tokens" | "calls" | null;
}

/**
 * Default token ceiling.
 *
 * Measured over 1,216 production requests since 2026-08-01: median 16,620,
 * p90 57,896, p99 138,846, max 297,245. 400,000 is ~1.35x the observed max and
 * ~2.9x p99 — no production request in a month would have come near it.
 *
 * Counts input + output + cache-creation + cache-read across every provider
 * attempt. Excludes reasoningTokens, which are a documented SUBSET of
 * outputTokens (see TokenUsage) and would double-count.
 */
const DEFAULT_TOKEN_LIMIT = 400_000;

/**
 * Default call ceiling — counted in PROVIDER calls, which is not the unit the
 * usage collection records, and the difference is the whole reason this number
 * is not 12.
 *
 * Stored records show a prod max of 12 provider ATTEMPTS per request (p99: 7).
 * But this counter sits at requestProvider, so it also counts every
 * continuation chunk — up to maxContinuations (10) per attempt — and nothing
 * records those, so the true per-request call count is unmeasured and bounded
 * analytically at ~120. 150 clears that with headroom.
 *
 * Its job is loop termination, not cost: it exists for the zero-token
 * pathology, where a call fails before spending anything (missing credentials,
 * an open circuit breaker) and the token ceiling therefore never advances. The
 * token ceiling is the cost bound.
 */
const DEFAULT_CALL_LIMIT = 150;

/**
 * `configuredNumber` in llm-generation-service rejects 0 and negatives and
 * silently returns the fallback, so a limit CANNOT be disabled by setting it to
 * 0. Mode "off" is the disable switch. Same semantics kept here so the two read
 * alike.
 */
function configured(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function budgetMode(): BudgetMode {
  const raw = process.env.CODEGEN_REQUEST_BUDGET_MODE;
  return raw === "enforce" || raw === "off" ? raw : "shadow";
}

export function createRequestBudget(rid: string): RequestBudget {
  return {
    rid,
    tokenLimit: configured("CODEGEN_REQUEST_BUDGET_TOKENS", DEFAULT_TOKEN_LIMIT),
    callLimit: configured("CODEGEN_REQUEST_BUDGET_CALLS", DEFAULT_CALL_LIMIT),
    mode: budgetMode(),
    tokens: 0,
    calls: 0,
    trippedOn: null,
  };
}

/**
 * For callers outside a request: scripts, the eval harness, anything that has
 * no request to bound. Passing this is explicit and greppable, where an
 * optional `budget?` would let a new call site fall out of coverage silently —
 * which is exactly how planComposition's fallback path ended up recording no
 * usage at all.
 */
export function unlimitedBudget(): RequestBudget {
  return {
    rid: "unbudgeted",
    tokenLimit: Number.POSITIVE_INFINITY,
    callLimit: Number.POSITIVE_INFINITY,
    mode: "off",
    tokens: 0,
    calls: 0,
    trippedOn: null,
  };
}

/** Rough token count for text, used only as a charge floor. */
export function estimateTokens(s: string | undefined | null): number {
  return s ? Math.ceil(s.length / 4) : 0;
}

/**
 * Charge one provider call.
 *
 * `estimateFloor` exists because a failed call returns EMPTY_USAGE() (both
 * OpenAI failure paths) or partial usage (the Anthropic stall path) while the
 * input tokens were still billed. Trusting reported usage would leave the
 * accumulator blind to failures — reproducing, one layer down, the exact hole
 * that ruled out recordTokenUsage as the seam.
 */
export function charge(
  budget: RequestBudget,
  usage: TokenUsage | null | undefined,
  estimateFloor = 0,
  /**
   * Set false for a second charge against a call already counted — the router
   * calls charge an estimate up front (so a call that THROWS still charges) and
   * top up with reported tokens afterwards. Without this the top-up would count
   * the same call twice.
   */
  countCall = true,
): void {
  const reported = usage
    ? usage.inputTokens +
      usage.outputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens
    : 0;
  budget.tokens += Math.max(reported, estimateFloor);
  if (countCall) budget.calls += 1;
  if (budget.trippedOn === null) {
    if (budget.tokens >= budget.tokenLimit) budget.trippedOn = "tokens";
    else if (budget.calls >= budget.callLimit) budget.trippedOn = "calls";
  }
}

/**
 * Has a ceiling been crossed — regardless of mode?
 *
 * This is the MEASUREMENT predicate, and it is what makes shadow mode worth
 * deploying: it is true in shadow too, so the logs record how often the valve
 * would have fired. Never branch behaviour on it.
 */
export function tripped(budget: RequestBudget): boolean {
  return budget.trippedOn !== null;
}

/**
 * Should work actually stop? The BEHAVIOUR predicate — always false in shadow.
 *
 * Two predicates rather than one mode-checking helper, because a single
 * function would make every call site read as though it enforces when it does
 * not.
 */
export function exhausted(budget: RequestBudget): boolean {
  return budget.trippedOn !== null && budget.mode === "enforce";
}

/** Stable one-line summary for the `[budget]` log lines. */
export function budgetSummary(budget: RequestBudget): string {
  return (
    `on=${budget.trippedOn} tokens=${budget.tokens}/${budget.tokenLimit} ` +
    `calls=${budget.calls}/${budget.callLimit} mode=${budget.mode}`
  );
}

/** Error code carried alongside the message, so callers branch without matching prose. */
export const BUDGET_ERROR_CODE = "request_budget_exhausted";

/**
 * Self-contained: for an MCP caller only this string survives into the tool
 * result, so it has to explain itself with no surrounding context. It says
 * "safety limit, not a quota" because the alternative reading — that the user
 * ran out of something they could buy more of — is both wrong and the one a
 * reader reaches for first.
 */
export const BUDGET_ERROR_MESSAGE =
  "This request used an unusually large amount of model capacity and was stopped " +
  "before it could finish. This is a safety limit, not a usage quota — it almost " +
  "always means the request is too large or too open-ended to build in one step. " +
  "Try breaking it into smaller requests, or describing a simpler first version " +
  "you can build on.";
