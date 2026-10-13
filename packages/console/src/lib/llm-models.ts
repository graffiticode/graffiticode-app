import { modelPriorityFor, modelTiersFor, modeEffortFor, modeTierFor, type GenerationMode } from "./model-priority";

export type LlmProvider = "anthropic" | "openai";
export type ProviderMode = LlmProvider | "auto";
export type GenerationTier = "quality" | "balanced" | "fast";

/**
 * How hard the model thinks before answering — the second cost/quality dial, orthogonal
 * to tier. Tier picks WHICH model; effort picks how much of it you spend.
 *
 * Not every model carries this dial: see modelSupportsEffort, which drops the parameter
 * for a model that would 400 on it. A language pinned to a non-supporting model (today,
 * anything on `anthropic+fast` → Haiku 4.5) silently ignores whatever effort is set for
 * it, so raising effort there is not expressible without also changing its tier.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const ANTHROPIC_MODELS = {
  // Opus 5 rather than 4.8: same $5/$25, current generation. Two behaviors this
  // codebase has to respect — thinking is ON by default (omitting `thinking` runs
  // adaptive, unlike 4.8), and `max_tokens` caps thinking PLUS response text, so
  // DEFAULT_MAX_TOKENS buys less answer here than it did on 4.8; and
  // `thinking:{type:"disabled"}` is a 400 at effort xhigh/max.
  QUALITY: "claude-opus-5",
  BALANCED: "claude-sonnet-5",
  FAST: "claude-haiku-4-5-20251001",
  DEFAULT: "claude-sonnet-5",
} as const;

export const OPENAI_MODELS = {
  QUALITY: "gpt-5.6-sol",
  BALANCED: "gpt-5.6-terra",
  FAST: "gpt-5.6-luna",
  DEFAULT: "gpt-5.6-terra",
} as const;

// Backwards-compatible names used by router, judge, and evaluation code.
export const CLAUDE_MODELS = {
  OPUS: ANTHROPIC_MODELS.QUALITY,
  SONNET: ANTHROPIC_MODELS.BALANCED,
  HAIKU: ANTHROPIC_MODELS.FAST,
  DEFAULT: ANTHROPIC_MODELS.DEFAULT,
} as const;

const PROVIDERS = new Set<LlmProvider>(["anthropic", "openai"]);
const PROVIDER_MODES = new Set<ProviderMode>(["auto", ...PROVIDERS]);
const TIERS = new Set<GenerationTier>(["quality", "balanced", "fast"]);

export function parseProviderMode(value: unknown): ProviderMode | undefined {
  const normalized = String(value || "").trim().toLowerCase() as ProviderMode;
  return PROVIDER_MODES.has(normalized) ? normalized : undefined;
}

export function parseGenerationTier(value: unknown): GenerationTier | undefined {
  const normalized = String(value || "").trim().toLowerCase() as GenerationTier;
  return TIERS.has(normalized) ? normalized : undefined;
}

export function inferProviderFromModel(model?: string): LlmProvider | undefined {
  if (!model) return undefined;
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^(gpt-|o\d|codex-)/i.test(model)) return "openai";
  return undefined;
}

export function inferTierFromModel(model?: string): GenerationTier | undefined {
  if (!model) return undefined;
  if (/(opus|sol)(?:-|$)/i.test(model)) return "quality";
  if (/(haiku|luna)(?:-|$)/i.test(model)) return "fast";
  if (/(sonnet|terra)(?:-|$)/i.test(model)) return "balanced";
  return undefined;
}

export function modelForProvider(
  provider: LlmProvider,
  tier: GenerationTier,
): string {
  if (provider === "openai") {
    return tier === "quality"
      ? OPENAI_MODELS.QUALITY
      : tier === "fast"
        ? OPENAI_MODELS.FAST
        : OPENAI_MODELS.BALANCED;
  }
  return tier === "quality"
    ? ANTHROPIC_MODELS.QUALITY
    : tier === "fast"
      ? ANTHROPIC_MODELS.FAST
      : ANTHROPIC_MODELS.BALANCED;
}

export function configuredProviderMode(): ProviderMode {
  return parseProviderMode(process.env.CODEGEN_PROVIDER) || "auto";
}

export function configuredPrimaryProvider(): LlmProvider {
  const configured = parseProviderMode(process.env.CODEGEN_PRIMARY_PROVIDER);
  return configured === "openai" ? "openai" : "anthropic";
}

export function configuredFallbackEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(
    process.env.CODEGEN_FALLBACK_ENABLED || "true",
  );
}

export function modelRejectsTemperature(model?: string): boolean {
  return !!model && /(opus|sonnet-5|fable|mythos|gpt-5\.6)/i.test(model);
}

/**
 * Does this model accept an effort parameter at all?
 *
 * `effort` is not universal. Anthropic takes it as `output_config.effort` and OpenAI as
 * `reasoning.effort`, but on both sides it is a property of the MODEL, not the provider:
 * the Claude 5 family and Opus 4.6-4.8 accept it, and Haiku 4.5 — which is
 * ANTHROPIC_MODELS.FAST, the model `anthropic+fast` resolves to — rejects it with a 400,
 * `"This model does not support the effort parameter."`
 *
 * That is not hypothetical. CODEGEN_EFFORT=low went onto the console service on
 * 2026-09-01 and every L0176 generation started failing, because L0176 is the one
 * language pinned to `anthropic+fast` (model-priority.ts). It was a hard failure rather
 * than a slow one: 0 tokens, 159ms, and no failover, since an `invalid_request_error`
 * was on failoverableProviderError's deny list. The daily corpus ping was the only thing
 * that caught it — L0176 has no other traffic.
 *
 * ALLOW-LIST, not a deny-list of the two 4.5 models, and that direction is the whole
 * point. An unrecognized model here silently loses effort — a request that succeeds
 * without a tuning knob. A deny-list would let the next model we add 400 on every call.
 * Being wrong in the quiet direction is the requirement.
 */
export function modelSupportsEffort(model?: string): boolean {
  return (
    !!model &&
    /(opus-5|sonnet-5|opus-4-[678]|sonnet-4-6|fable|mythos|gpt-5\.6)/i.test(
      model,
    )
  );
}

export interface LanguageGenerationPolicy {
  tier?: GenerationTier;
}

// `provider` is deliberately absent: which FAMILY runs is owned by
// src/lib/model-priority.ts, so a dialect-owned `gc:provider=` directive would be a
// second source of truth for one decision. A dialect still chooses its own TIER
// (how much model to spend within whichever family serves it), which is what
// `gc:tier=` and the legacy `gc:model=opus` express.
const GENERATION_DIRECTIVE_RE =
  /<!--\s*gc:(model|tier)\s*[:=]\s*([a-z0-9._-]+)\s*-->/gi;

// Matches any gc:model/gc:tier/gc:provider directive for STRIPPING purposes.
// Broader than the parser on purpose: a stale `gc:provider=` in a dialect's
// instructions.md is no longer honored, but it must still never reach the LLM.
const GENERATION_DIRECTIVE_STRIP_RE =
  /<!--\s*gc:(model|tier|provider)\s*[:=]\s*([a-z0-9._-]+)\s*-->/gi;

/**
 * Removes private routing directives before instructions enter the prompt and
 * returns the language's provider-neutral generation policy.
 */
export function parseLanguageGenerationPolicy(
  instructions: string,
): { cleaned: string; policy: LanguageGenerationPolicy } {
  const policy: LanguageGenerationPolicy = {};
  let match: RegExpExecArray | null;

  while ((match = GENERATION_DIRECTIVE_RE.exec(instructions)) !== null) {
    const [, , rawValue] = match;
    const tier =
      parseGenerationTier(rawValue) ||
      inferTierFromModel(rawValue) ||
      (rawValue.toLowerCase() === "opus"
        ? "quality"
        : rawValue.toLowerCase() === "sonnet"
          ? "balanced"
          : rawValue.toLowerCase() === "haiku"
            ? "fast"
            : undefined);
    if (tier) policy.tier = tier;
  }

  GENERATION_DIRECTIVE_RE.lastIndex = 0;
  GENERATION_DIRECTIVE_STRIP_RE.lastIndex = 0;
  return {
    cleaned: instructions.replace(GENERATION_DIRECTIVE_STRIP_RE, ""),
    policy,
  };
}

export interface GenerationRouteInput {
  /** Language id — the ONLY input that selects a family. */
  lang?: string | number | null;
  tier?: GenerationTier;
  /**
   * Internal/eval escape hatch: pin one exact model. Reachable only from
   * in-process TS callers (scripts/model-eval.ts); there is no GraphQL field for
   * it, so a client cannot set it. A pin disables failover — an eval that
   * silently fell back to another family would be measuring the wrong thing.
   */
  model?: string;
  /**
   * What is being generated. Only "update" is read here; repair and propertyUpdate resolve
   * their own tier at their call sites, where the defaults live. Defaults to "create".
   */
  mode?: GenerationMode;
}

export interface GenerationRoute {
  /** Family order to try, most preferred first. Never empty. */
  providers: LlmProvider[];
  tier: GenerationTier;
  /**
   * Per-family tier overrides from the priority table (`"anthropic+fast"`). Absent for
   * every language whose entries carry no suffix, in which case `tier` applies to all.
   * Callers must read `tierByProvider?.[provider] ?? tier` — using `tier` alone silently
   * ignores the table and runs the wrong model.
   */
  tierByProvider?: Partial<Record<LlmProvider, GenerationTier>>;
  model?: string;
  /**
   * Per-language effort override from the priority table. Absent for every language that
   * states no opinion, in which case the global CODEGEN_EFFORT applies.
   *
   * Callers must read `route.effort ?? options.effort` — the route value WINS, because a
   * table entry is a deliberate exception to a global default.
   */
  effort?: EffortLevel;
  /** Where the ordering came from, for telemetry and log lines. */
  source: "model_pin" | "operator_override" | "language_priority";
}

/**
 * Resolve which model families may serve a request, in order.
 *
 * Precedence, none of it client-reachable:
 *   1. an internal/eval `model` pin (single family, no failover)
 *   2. an operator override (CODEGEN_PROVIDER / CODEGEN_PRIMARY_PROVIDER) — for
 *      canary and incident response
 *   3. the language's static priority list, else the default
 *
 * Tier picks the model WITHIN the chosen family via modelForProvider. A language's
 * `gc:tier=` directive and the small-edit fast downgrade set the route-wide default; the
 * priority table may override it PER FAMILY (`tierByProvider`), which is how a language
 * runs fast on one provider and balanced on its fallback. Neither changes which family
 * serves the request.
 *
 * Tier precedence, highest first:
 *   1. an exact `model` pin — bypasses the table entirely (eval harness only)
 *   2. a `+tier` suffix in MODEL_PRIORITY, for the family serving the request
 *   3. the route-wide `tier`: the dialect's `gc:tier=` / `gc:model=opus`, or the
 *      small-edit fast downgrade
 * A table suffix therefore outranks a dialect's own directive, deliberately: the table is
 * platform-owned and each line cites the eval behind it, while the directive is the
 * dialect's default for when nobody has measured. It also outranks the small-edit
 * downgrade, so a `+balanced` fallback stays balanced even on a trivial edit — currently
 * only reachable via L0176's fallback, where it is the intent.
 */
export function resolveGenerationRoute(
  input: GenerationRouteInput,
): GenerationRoute {
  const explicitTier = parseGenerationTier(input.tier);
  if (input.tier !== undefined && !explicitTier) {
    throw new Error(
      `Invalid code generation tier "${input.tier}"; expected quality, balanced, or fast`,
    );
  }
  const tier = explicitTier || inferTierFromModel(input.model) || "balanced";

  // 1. Exact model pin (internal/eval only).
  const pinnedProvider = inferProviderFromModel(input.model);
  if (input.model && pinnedProvider) {
    return {
      providers: [pinnedProvider],
      tier,
      model: input.model,
      source: "model_pin",
    };
  }

  // 2. Operator override. CODEGEN_PROVIDER names one family to force everywhere;
  //    "auto" (the default) means "defer to the language". CODEGEN_PRIMARY_PROVIDER
  //    only reorders — it never removes a family, so an override cannot cost a
  //    language its failover.
  const configuredMode = configuredProviderMode();
  if (configuredMode !== "auto") {
    return { providers: [configuredMode], tier, source: "operator_override" };
  }

  // 3. The language's static priority list.
  const priority = modelPriorityFor(input.lang);
  const primary = configuredPrimaryProvider();
  const providers =
    process.env.CODEGEN_PRIMARY_PROVIDER && priority.includes(primary)
      ? [primary, ...priority.filter(provider => provider !== primary)]
      : priority;

  // Only this path consults the table. A model pin (eval harness) and an operator override
  // must keep bypassing it entirely.
  //
  // A mode override is LANGUAGE-WIDE and replaces the per-family tiers for that mode: a
  // dialect saying "revisions are lighter" means lighter on whichever family serves it, and
  // leaving the +tier suffixes in force would let them veto the very override being asked
  // for. Absent an override (the normal case) the suffixes apply as before.
  // Effort rides along on this path only, for the same reason the mode tier does: a model
  // pin (eval harness) and an operator override are deliberate bypasses of the table, and
  // an eval that silently inherited a language's effort would be measuring the wrong thing.
  const modeEffort = modeEffortFor(input.lang, input.mode ?? "create");
  const modeTier = modeTierFor(input.lang, input.mode ?? "create");
  if (modeTier) {
    return {
      providers: configuredFallbackEnabled() ? providers : providers.slice(0, 1),
      tier: modeTier,
      ...(modeEffort ? { effort: modeEffort } : {}),
      source: "language_priority",
    };
  }
  const tierByProvider = modelTiersFor(input.lang);
  return {
    providers: configuredFallbackEnabled() ? providers : providers.slice(0, 1),
    tier,
    ...(Object.keys(tierByProvider).length ? { tierByProvider } : {}),
    ...(modeEffort ? { effort: modeEffort } : {}),
    source: "language_priority",
  };
}
