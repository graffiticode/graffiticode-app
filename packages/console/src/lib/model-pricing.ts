// Per-model provider pricing, USD per token.
//
// Replaces four hardcoded Sonnet-rate constants that were applied to every
// model regardless of which one ran — so an Opus generation (5× Sonnet's input
// rate) was recorded at Sonnet's price. Cost telemetry is not a billing control
// here (the free plan meters items, not dollars), but it does feed
// cost-per-acquired-account in the funnel report, and a figure that silently
// understates the expensive model is worse than no figure.
//
// Rates are per 1M tokens, from the providers' standard price lists. Keep this
// table in sync with src/lib/llm-models.ts.

import { inferProviderFromModel, LlmProvider } from "./llm-models";

const PER_MILLION = 1_000_000;

interface ModelRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  provider: LlmProvider;
  /**
   * Promotional rate in effect until the given date (ISO). After it, `input`
   * and `output` above apply. Encoded rather than ignored because the
   * introductory Sonnet 5 rate is a third off, and this is the default
   * generation model — treating it as the standard rate would overstate almost
   * all free-plan spend while the promotion lasts. Self-expiring: once the date
   * passes, the standard rate applies with no code change.
   */
  intro?: { input: number; output: number; until: string };
}

const MODEL_RATES: Record<string, ModelRate> = {
  "claude-fable-5": { provider: "anthropic", input: 10, output: 50 },
  "claude-opus-5": { provider: "anthropic", input: 5, output: 25 },
  "claude-opus-4-8": { provider: "anthropic", input: 5, output: 25 },
  "claude-opus-4-7": { provider: "anthropic", input: 5, output: 25 },
  "claude-opus-4-6": { provider: "anthropic", input: 5, output: 25 },
  // $2/$10 is the STANDING rate, not a promotion: Anthropic decided against
  // letting the introductory price lapse to $3/$15, so there is no expiry to
  // encode. Left as an `intro` window it would have self-expired on 2026-08-31
  // and stepped every cost report up 50% overnight on the model carrying ~70%
  // of generation spend — a rate-card artefact that reads as a cost regression.
  "claude-sonnet-5": { provider: "anthropic", input: 2, output: 10 },
  "claude-sonnet-4-6": { provider: "anthropic", input: 3, output: 15 },
  "claude-haiku-4-5": { provider: "anthropic", input: 1, output: 5 },
  "gpt-5.6-sol": { provider: "openai", input: 5, output: 30 },
  "gpt-5.6-terra": { provider: "openai", input: 2.5, output: 15 },
  "gpt-5.6-luna": { provider: "openai", input: 1, output: 6 },
};

// Unknown models fall back to the default generation model's rate rather than
// to zero: a missing table entry should make the estimate approximate, not
// silently free.
const FALLBACK = MODEL_RATES["claude-sonnet-5"];

/**
 * Cache pricing is a fixed multiple of a model's input rate, so it needs no
 * per-model entries: a 5-minute-TTL write costs 1.25×, a 1-hour-TTL write 2×,
 * and a read 0.1×.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

/** Model ids may carry a date suffix (`claude-haiku-4-5-20251001`); the table is keyed without one. */
function rateFor(
  model: string | undefined,
  now: Date,
  provider?: LlmProvider,
): { input: number; output: number; provider: LlmProvider } {
  const id = String(model || "");
  const entry =
    MODEL_RATES[id] ??
    MODEL_RATES[id.replace(/-\d{8}$/, "")] ??
    (provider === "openai"
      ? MODEL_RATES["gpt-5.6-terra"]
      : FALLBACK);
  if (entry.intro && now < new Date(`${entry.intro.until}T23:59:59Z`)) {
    return {
      input: entry.intro.input,
      output: entry.intro.output,
      provider: entry.provider,
    };
  }
  return {
    input: entry.input,
    output: entry.output,
    provider:
      provider || inferProviderFromModel(model) || entry.provider,
  };
}

/**
 * Cost of one Messages API response, from its `usage` object.
 *
 * `inputTokens` is the **uncached remainder**, not the whole prompt: the API
 * reports `input_tokens`, `cache_creation_input_tokens`, and
 * `cache_read_input_tokens` as disjoint counts, so the full prompt is their
 * sum. This function previously subtracted the cached parts back out of
 * `inputTokens`, which double-discounted them and understated every cached
 * generation — the more effective the prompt cache, the larger the shortfall.
 * Free-plan spend telemetry (`recordSpend`) was low for that reason.
 */
export function estimateUsdCost(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      }
    | undefined,
  model?: string,
  now = new Date(),
  provider?: LlmProvider,
): number {
  if (!usage) return 0;
  // The per-request usage object doesn't split cache creation by TTL; 5m is the
  // default and what we write, so it prices as a 5-minute entry.
  return usdCostFromReport(
    {
      uncachedInput: usage.inputTokens || 0,
      cacheWrite5m: usage.cacheCreationInputTokens || 0,
      cacheRead: usage.cacheReadInputTokens || 0,
      output: usage.outputTokens || 0,
    },
    model,
    now,
    provider,
  );
}

/**
 * Prices one row of the Admin API's usage report
 * (`/v1/organizations/usage_report/messages`).
 *
 * Deliberately separate from `estimateUsdCost` rather than folded into it,
 * because the two consume opposite conventions and silently mixing them
 * under-counts. The Messages API reports `input_tokens` *inclusive* of the
 * cached portions, so `estimateUsdCost` subtracts them back out; the usage
 * report already hands back `uncached_input_tokens` *exclusive* of cache, so
 * subtracting again would charge nothing for input that was really billed.
 * The report also splits cache creation by TTL, which the per-request usage
 * object does not — and the two TTLs are priced differently (2× vs 1.25×).
 */
export function usdCostFromReport(
  tokens: {
    uncachedInput?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    cacheRead?: number;
    output?: number;
  },
  model?: string,
  now = new Date(),
  provider?: LlmProvider,
): number {
  const rate = rateFor(model, now, provider);
  // OpenAI prompt caching has the same 1.25x write and 0.1x read multipliers
  // represented by the normalized provider usage fields.
  const cacheWriteMultiplier = CACHE_WRITE_MULTIPLIER;
  const cacheReadMultiplier = CACHE_READ_MULTIPLIER;

  const usd =
    (tokens.uncachedInput || 0) * rate.input +
    (tokens.output || 0) * rate.output +
    (tokens.cacheWrite5m || 0) * rate.input * cacheWriteMultiplier +
    (tokens.cacheWrite1h || 0) * rate.input * CACHE_WRITE_1H_MULTIPLIER +
    (tokens.cacheRead || 0) * rate.input * cacheReadMultiplier;

  return usd / PER_MILLION;
}
