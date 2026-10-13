// Ordered model-family priority, per language — and, optionally, the TIER each family
// serves that language at.
//
// This is a STATIC HINT produced by offline evaluation (`scripts/model-eval.ts`),
// not a runtime decision. The first family in a language's list whose provider is
// available serves the request; on an *availability* failure (missing credentials,
// timeout, 429, 5xx, open circuit — see failoverableProviderError in
// llm-generation-service.ts) the next family is tried. A language absent from the
// table has not been evaluated and uses DEFAULT_MODEL_PRIORITY.
//
// One CAPABILITY failure fails over too: a model rejecting a request PARAMETER it does
// not carry (`"does not support the effort parameter"`). That is not the request being
// wrong, it is this model's surface being narrower than the next one's — so the second
// family is a genuinely different attempt rather than a doomed retry. Every other
// invalid_request (over-length, safety) still fails outright.
//
// It is deliberately NOT client-settable. Which model runs is a platform decision
// for the same reason head routing and composition are — see
// docs/language-routing-and-composition.md. Neither an end user nor a client agent
// (including MCP) can select or influence it; there is no GraphQL field to do so.
//
// It is the single place model routing is decided: an entry names the family order AND,
// with a `+tier` suffix, the tier each family serves at. Nothing else in the pipeline
// chooses a model — a dialect's `gc:tier=` only supplies the default for languages this
// table has no opinion about.
//
// It lives in its own module, one language per line, so that changing an ordering
// is a one-line diff a reviewer can actually read. Do not move it onto the
// LANGUAGES entries in languages.ts — those are single-line objects hundreds of
// characters wide, and an ordering buried at the end of one is unreviewable.
//
// Ships INERT: with the table empty every language resolves to the default, so
// deploying this changes no behavior. Populating a line is then a reviewable data
// change rather than a release — the same discipline `freePlan` uses in
// languages.ts.

// Type-only import: llm-models imports modelPriorityFor from here, so this must
// stay erasable or the two modules form a runtime cycle.
import type { EffortLevel, GenerationTier, LlmProvider } from "./llm-models";

/**
 * A family, optionally pinned to a tier: "anthropic" or "anthropic+fast".
 *
 * Tier belongs here, beside the ordering, because it is a property of the (language,
 * FAMILY) pair — not of the language alone. L0176 wants haiku primary and terra on
 * failover: the best fast model, falling back to a *balanced* one rather than to the
 * cheapest openai model, which is the single variant measured that fails outright. A
 * dialect-level `gc:tier=` cannot say that. It declares one tier for the language, so the
 * fallback would inherit `fast` and land on exactly the model being avoided.
 *
 * A bare family (no suffix) means "no opinion" — the route's tier applies, which is the
 * dialect's own `gc:tier=` / `gc:model=opus` directive or the small-edit fast downgrade.
 * That keeps every existing entry behaving exactly as before.
 */
export type PriorityEntry = LlmProvider | `${LlmProvider}+${GenerationTier}`;

/**
 * The five things a language runs a model for, and what each costs by default:
 *
 *   create          the dialect's tier (its `gc:tier=`), or a `+tier` suffix below
 *   update          same as create — a revision is not assumed to be easier
 *   repair          always "balanced" — error correction is a narrow, mechanical task,
 *                   and it is pinned to the family that wrote the code
 *   propertyUpdate  always "fast" — the L0166 small-edit path
 *   spec            always "fast" — get_spec, the INVERSE direction (item → English)
 *
 * Those defaults are unchanged and apply to every language. A language may override any of
 * the last four when it has evidence, which is what the object form of an entry is for.
 *
 * `spec` is here rather than beside spec-generation-service's own constants because this table
 * is meant to be the one place you can read what model runs where. It was the counter-example:
 * get_spec resolved `process.env.SPEC_MODEL || "claude-haiku-…"` on its own, invisible from here,
 * and for a dialect whose PRODUCT is the spec (L0177's recipe) that is the load-bearing model
 * choice, not a detail. Note it takes only a TIER: spec-gen calls the Anthropic Messages API
 * directly, so a `+tier` suffix or an openai entry in `order` has no effect on it.
 */
export type GenerationMode = "create" | "update" | "repair" | "propertyUpdate" | "spec";

/**
 * A language's entry: either a bare ordering, or an ordering plus per-mode tier overrides.
 *
 * The array form stays the norm — most languages want one tier for creates and updates and
 * the standard repair/property behavior, and a single line is what makes this table
 * reviewable. Reach for the object form only when a mode genuinely differs, e.g. a dialect
 * whose initial authoring is heavy but whose revisions are not:
 *
 *   "0175": { order: ["openai+quality", "anthropic+quality"], update: "balanced" }
 *
 * `order` is optional so a language can state a tier opinion WITHOUT claiming a family ordering
 * it has no eval for — an entry with no order falls through to DEFAULT_MODEL_PRIORITY exactly as
 * an absent one does, and evaluatedLanguageIds() still does not count it as evaluated.
 */
export type PriorityConfig =
  | PriorityEntry[]
  | {
      order?: PriorityEntry[];
      /** Tier for fresh authoring. Defaults to the dialect's own `gc:tier=`, else balanced. */
      create?: GenerationTier;
      /** Tier for a revision (currentCode present). Defaults to the create tier. */
      update?: GenerationTier;
      /** Tier for error correction. Defaults to "balanced". */
      repair?: GenerationTier;
      /** Tier for the L0166 small-property-edit path. Defaults to "fast". */
      propertyUpdate?: GenerationTier;
      /** Tier for get_spec. Defaults to "fast". Tier only — see GenerationMode. */
      spec?: GenerationTier;
      /**
       * How hard the model thinks, overriding the global CODEGEN_EFFORT default.
       *
       * Same duality as the entry itself: a bare level applies to every mode, an object
       * names the modes that differ. `{ effort: "high" }` and
       * `{ effort: { create: "high", repair: "low" } }` are both valid.
       *
       * This is the per-language half of the effort knob, and it exists because
       * CODEGEN_EFFORT is global: one setting that is right for ten languages and wrong
       * for the eleventh has nowhere to record the exception. Recording it HERE rather
       * than in another env var is the point — the table is reviewable, diffable, and
       * already the one place you can read what a language runs on.
       *
       * Inert on a language whose model has no effort dial (see modelSupportsEffort):
       * the value resolves, the parameter is then dropped at the send site, and the
       * request succeeds without it.
       */
      effort?: EffortLevel | Partial<Record<GenerationMode, EffortLevel>>;
    };

/** The ordering out of either entry form. */
function orderOf(config: PriorityConfig | undefined): PriorityEntry[] {
  if (!config) return [];
  return Array.isArray(config) ? config : config.order || [];
}

/**
 * Per-language family ordering. Keys are canonical 4-digit language ids ("0166").
 *
 * EVERY entry must cite the eval run that justifies it — the value of a static
 * hint is that you can see why it says what it says. An ordering without evidence
 * is a guess with extra steps, so do not add a line without one.
 *
 * Populate with `npm run eval -- --lang <id> --models <a>,<b> --judge`, and only
 * after `--calibrate` shows the judge agrees with human labels for that dialect.
 */
export const MODEL_PRIORITY: Record<string, PriorityConfig> = {
  // "0166": ["anthropic", "openai"],  // eval YYYY-MM-DD: finalRate .94 vs .81
  // "0158": ["openai", "anthropic"],  // eval YYYY-MM-DD: $/win 0.031 vs 0.052

  // eval 2026-08-11 (model-eval-2026-08-11T00-09-52-156Z, 7 cases x 10 trials, --converge 5,
  // hold-out enforced, dialect 2bf6bf310261, 70 runs per variant):
  //   FAST      haiku-4.5    70/70 compile, $0.0017, p50 3.6s
  //             gpt-5.6-luna 67/70 (96%),   $0.0026, p50 4.5s — all three failures the same
  //             parse error ("Too few arguments for ITEMS"), so ~4% of generations
  //   BALANCED  terra 21/21 $0.0035 p50 2.9s · sonnet 21/21 $0.0047 p50 5.8s
  //   Human labels (anchor v2): all 28 candidates scored 3 — 7 per model across BOTH tiers,
  //   so quality is tied and cost is the only live variable. Behavior check on the case with
  //   a known silent-failure mode (clozeformula accepted-answer set): 20/20.
  //     ^ RETRACTED 2026-08-24. That case (`clozeformula-equivalence`, "simplify 4/8", accepting
  //     1/2 · 0.5 · 2/4 but not 4/8) has a near-twin in the RAG corpus carrying the code AND the
  //     scoring method, which retrieval supplied to every variant on every run. The 20/20 measured
  //     transcription, not authoring, so it is not evidence for what it claims. The hold-out gate
  //     passed it because the wording differs — the gate checks membership, not proximity. See
  //     scripts/eval-case-proximity.ts, which reports what retrieval would actually hand a case.
  //     Replaced by the 2026-08-24 clean-set result below.
  //   Judge NOT used: zero label variance leaves Spearman undefined, and a dialect at
  //   ceiling has nothing for a judge to discriminate.
  //
  // Supersedes the 2026-08-03 balanced-tier line (terra over sonnet on cost and latency).
  // That measurement was not wrong; it answered a narrower question, before the fast tier
  // had been tried on this dialect at all.
  //
  // Failover is +balanced ON PURPOSE. The cheapest openai model (luna) is the one variant
  // measured here that fails outright, so the fallback trades a little cost for terra's
  // 21/21 rather than inheriting `fast` from the primary.
  //
  // RE-MEASURED 2026-08-24 (model-eval-2026-08-24T19-35-00-883Z, 7 cases x 3 trials, single-shot,
  // hold-out enforced, 21 runs per variant, 0 errors). NOT a reproduction of the above: the dialect
  // moved underneath it, 2bf6bf310261 (37KB) -> aa0b77403d8c (49.6KB), and the costs moved with it.
  //   FAST      haiku-4.5    18/21 first-pass, 21/21 final, $0.0028, p50 5.5s
  //             gpt-5.6-luna 21/21 first-pass,              $0.0027, p50 7.0s
  //   BALANCED  terra 21/21 $0.0037 p50 3.9s · sonnet 21/21 $0.0082 p50 7.7s
  //   Every variant still ends at 100% compile with 0 warnings, 0 stubs, 0 drift.
  //
  // Line UNCHANGED, on two readings of that haiku result. (a) Its three misses are one case
  // (choicematrix-partial-credit) in 3 of 3 trials — deterministic, and a dialect-doc gap rather
  // than a model limit: it hoisted `scoring-type` out of `validation`, the repair pass fixed it in
  // one round, and the repaired code is structurally identical to terra's first-pass. The
  // instructions.md imperative it was reading named the attribute without its wrapper; correcting
  // it (l0176 1417bd0, deployed 2026-08-24) took that case from 0/3 to 10/10 first-pass, and
  // `scoring-type` sits inside `validation` in 40/40 generations across all four variants with
  // partialMatch preserved. (b) luna's 21/21 does not overturn its 3-in-70 from 2026-08-11 — at a 4% rate,
  // 21 clean runs happen ~42% of the time, so the +balanced failover keeps its basis.
  //
  // --converge is still inert here: 0 compiler warnings across all 84 runs, as across the earlier
  // 250+. Convergence and single-shot measure the same thing on this dialect.
  //
  // CLEAN-SET CONFIRMATION 2026-08-24 (model-eval-mcp-2026-08-24T21-29-06-818Z, 192 runs over
  // data/model-eval/mcp/0176.json — 16 cases authored from L0176's public MCP surface by
  // scripts/eval-cases-from-mcp.ts, which cannot read the corpus). Proximity, measured through the
  // generator's own retrieval path: 13 of 16 cases retrieve NOTHING above the 0.50 gate (mean top1
  // .435), against 4 of 7 fed 1-3 examples in the corpus-seeded set (mean .546).
  //   haiku 48/48 first-pass $0.0017 p50 4.8s · luna 48/48 $0.0032 7.0s
  //   terra 48/48 $0.0039 4.1s · sonnet 46/48 first-pass, 48/48 final, $0.0068 7.2s
  // Every variant still reaches 100% compile with 0 warnings and 0 drift on cases nobody was
  // handed the answer to, so the ordering above rests on the dialect being at ceiling, not on
  // retrieval propping it up. haiku stays cheapest by better than 2x.
  //
  // The retracted behavior check is replaced by this: the three clozeformula cases in the clean
  // set (symbolic equivalence, syntax+value, tolerance — top1 .27-.39, zero examples supplied)
  // went 36/36 first-pass across all four variants.
  //
  // Sonnet's 2 misses are one case (clozetext-two-blanks-long-answer, 2 of 3 trials): it put
  // `{{response}}` in `stimulus`, which compiles to a prompt with an orphaned input box — the
  // failure l0176's docs.test.ts guards its own examples against. The compiler caught it and
  // repair fixed it in one round. It surfaced only on a case with no retrieved example to
  // imitate, which is the argument for corpus-independent cases in one line.
  "0176": ["anthropic+fast", "openai+balanced"],

  // eval 2026-08-09 (model-eval-0175-converge-merged-from-checkpoint, 7 cases x 3 trials,
  // --converge 5, hold-out enforced, 21 runs per variant, 0 errors):
  //   ALL THREE converge 100% — every variant reaches a warning-free item, so compile-based
  //   metrics are saturated and say nothing. What separates them is the cost of getting there:
  //     turns-to-clean  sol 1.4   opus 1.1   sonnet 1.8
  //     $/converged     sol .069  opus .103  sonnet .086
  //     p50             sol 36.5s opus 40.4s sonnet 63.1s
  //   Human labels, anchor v2, n=7 each: sol 3.86, opus 3.71, sonnet 2.71.
  //   Judge NOT used: --calibrate (n=21) gives rho .32, CI [-.09,.66] — spans zero — and
  //   rho -.26 on openai-authored candidates, so it is not a fair cross-family arbiter here.
  //   Its LEVEL is fine (MAE .57, 95% within +-1); it is the RANKING that disagrees, which is
  //   the part an ordering needs.
  //
  // HONEST BASIS: sol's 3.86 vs opus's 3.71 is a one-case difference and inside noise. This line
  // rests on (a) cost and latency, which are unambiguous, and (b) the reviewer's judgment that
  // sol's items are more nuanced in ways a 1-5 overall score does not capture — the labels are
  // consistent with that read but do not establish it. Re-examine if the anchors gain a band for
  // it, or if a larger label set moves the means apart.
  //
  // Note this also buys 0175 failover it did not have: it was falling through to
  // DEFAULT_MODEL_PRIORITY (anthropic-only), so an OpenAI outage now degrades to opus instead of
  // failing — and an OpenAI credit lapse mid-sweep is exactly the failure this eval hit.
  //
  // Tiers are explicit here rather than inherited. L0175 used to carry `gc:model=opus` in its
  // instructions.md, which meant the eval above (sol vs opus, both quality-tier) was measuring a
  // pairing the table did not state — you had to read a different repo to know which models a
  // line referred to. The directive has been removed; this entry names them outright.
  //
  // Every mode is stated even where it equals the default, because the point of moving these
  // here was that you can read what runs without opening another repo.
  //
  // `update: "quality"` preserves today's behavior. Dropping revisions to balanced is plausible
  // — composing a five-target ELA item from a passage is the hard part, and a revision has the
  // working artifact in hand — but NOTHING here measures it: every case in every eval set is a
  // fresh create, so the harness has never scored a second turn. Change it when there is a run
  // behind it, not because the reasoning sounds right.
  "0175": {
    order: ["openai", "anthropic"],
    create: "quality",
    update: "quality",
    repair: "balanced",
  },

  // eval 2026-08-12 (model-eval-2026-08-12T18-09-04-986Z, 13 cases x 3 trials, --converge 3,
  // hold-out enforced against a 21-example corpus, 39 runs per variant, 0 errors):
  //
  //                        INVENTED   compile   p50    $/run
  //   BALANCED  terra        0/39      39/39    2.8s   $0.0020   <- primary
  //             sonnet       0/39      39/39    6.6s   $0.0049   <- failover
  //   FAST      luna         1/39      39/39    4.5s   $0.0017
  //             haiku        6/39      33/39    2.8s   $0.0020
  //
  // SECOND SWEEP 2026-08-13 (model-eval-2026-08-13T16-48-47-151Z, same 13 cases x 3 trials,
  // dialect 77480abe7aa7, balanced tier only) — and it changes how to read the row above:
  //   terra    0/39 invented, 39/39 compile, p50 3.4s, $0.0018
  //   sonnet   3/39 invented, 38/39 compile, p50 5.4s, $0.0070
  // Sonnet's inventions were hole-no-domain/t1 and hole-no-author/t0,t1 — the same two cases haiku
  // fails, and the design-hole count corroborates independently (10 of 12 available, the missing
  // two being the holes it filled).
  //
  // So **sonnet's 0/39 was a lucky sample, not a property**. Across two independent sweeps terra is
  // 0/39 and 0/39 while sonnet is 0/39 and 3/39. That does not move the ordering — it reinforces
  // terra as primary — but it does mean the FAILOVER is measurably weaker on the metric this
  // dialect turns on, and an Anthropic-served L0177 request can fabricate a serving domain roughly
  // one time in thirteen. There is no third balanced-tier option to fail over to, so this is
  // recorded rather than acted on; revisit if a quality-tier failover is ever justified.
  //
  // The general lesson, since it keeps recurring here: a single sweep at n=39 cannot distinguish
  // "never does this" from "does this occasionally". Read any 0/N in this table as an upper bound.
  //
  // INVENTED is the metric this dialect turns on: the program asserted a `domain`, `user-id` or
  // `reference` that its request never supplied. instructions.md forbids exactly that ("omit them
  // and the compiler flags them as design holes for the client to supply"), because a fabricated
  // serving domain yields a signed request that 401s and an editor nobody can debug.
  //
  // Two independent reads agree. Source-level: the counts above, from the emitted program.
  // Compiler-level: `design-hole` warnings over the four hole cases x 3 trials = 12 available —
  // sonnet 12, terra 12, luna 11, haiku 6. 12 minus the invention count, exactly, for every
  // variant. A model that fabricates shows FEWER holes, which is the companion check that
  // something was actually examined.
  //
  // Haiku fails on both axes and is not cheaper than terra (both $0.0020), so it wins on no axis
  // here. Its 12 failures are systematic, not flaky — all 3 trials of `hole-no-domain` and
  // `hole-no-author` invented; all 3 trials of `container-and-settings` (a section emitted after
  // the view closes) and `update-switch-view` (`status [published]`, a bare identifier) never
  // compiled. The fast tier is avoided for BOTH families: luna's single invention is one trial of
  // `hole-no-author`, and 0-vs-not-0 on this metric is worth $0.0003.
  //
  // Judge NOT used, and no --panel: there are no human labels for this dialect yet, so nothing
  // here ranks output QUALITY beyond "compiles and doesn't fabricate". That is enough to place
  // haiku last and to prefer the cheaper of two variants that tie at zero, and it is NOT enough to
  // claim terra writes better designs than sonnet. If labels later show a quality gap, this line
  // should move on that evidence, not on the cost column.
  //
  // Corpus caveat for the next sweep: all four variants retrieved from the same 21 examples, of
  // which 18 are `item-edit` and 2 demonstrate holes. Widen that and these numbers may move —
  // especially for the three non-item-edit cases, which every variant ran under-served.
  //
  // `spec: "balanced"` because for this dialect get_spec IS the product: the compiled data is
  // secondary and the recipe is what the caller implements. Its spec-directive.md is not the usual
  // verbalize-the-content task the "fast" default was chosen for — it is negative-constraint
  // reasoning (never assert the unverified widgetTypes config path; every config-behaviour check
  // must be differential INCLUDING enabling keys; the Goal must not claim a restriction is in
  // force), and assertCoverage cannot catch a violation because a recipe's substance is not in the
  // source it covers. A confidently wrong recipe tells a developer a restriction holds when the
  // Author API failed open, which is the specific hazard the directive exists to prevent.
  "0177": { order: ["openai+balanced", "anthropic+balanced"], spec: "balanced" },

  // NO ENTRY FOR 0179 — deliberately, and this note is here so the measurement is
  // not repeated from scratch.
  //
  // `{ effort: { create: "low" } }` shipped on 2026-09-09 and was removed the same
  // day. It was justified as the fix for L0179's zero-output thinking spiral, and it
  // is not: two spirals in a user's session ran WITH it applied and logged —
  // `output=16384 rawChars=0 effort=low stopEarly=no_output`, twice. The `effort=`
  // field on the [code-gen] line exists because that question was unanswerable
  // without it.
  //
  // What the measurement DID show, and what is being given up: ~2.4x on prescriptive
  // prompts (median 13.5s -> 5.7s over 4 trials per arm), code volume unchanged, and
  // 0/10 verdict differences on a paired corpus sweep. So it was a real latency win
  // that bought no protection from the thing it was added for. The spiral is bounded
  // by DEFAULT_MAX_TOKENS instead, which caps it deterministically rather than
  // hoping the model thinks less.
};

/**
 * Used by any language with no MODEL_PRIORITY entry, i.e. every language until an
 * eval says otherwise.
 *
 * Anthropic first — the known-good default — with openai as a blind fallback so an
 * unevaluated language DEGRADES instead of failing when Anthropic is down. This was
 * anthropic-only until 2026-08-12, on the reasoning that a single entry means such a
 * language never silently runs on a provider nobody measured it against. What that
 * reasoning left out is what happens when the one family is unavailable: L0177
 * create_item returned `Overloaded` three times running with nowhere to fall through
 * to, and a dialect with no eval set is exactly the kind most likely to be in this
 * position.
 *
 * The cost is unchanged and still real: a language that lands on openai here is
 * running on a provider nothing has scored it against, and this applies to EVERY
 * unevaluated language, not just the one that prompted it. A dialect that would
 * rather fail than generate unmeasured must say so with its own `order`. An eval,
 * not this constant, is what should eventually decide each language's ordering.
 *
 * Still overridable at runtime without a deploy — see configuredDefaultPriority.
 */
export const DEFAULT_MODEL_PRIORITY: LlmProvider[] = ["anthropic", "openai"];

/** Canonical 4-digit form. Matches findLanguageById in languages.ts. */
function normalizeLangId(lang: string | number): string {
  return String(lang).trim().replace(/^L/i, "").padStart(4, "0");
}

const KNOWN_PROVIDERS = new Set<LlmProvider>(["anthropic", "openai"]);
// Duplicated from llm-models' TIERS for the same reason KNOWN_PROVIDERS duplicates its
// PROVIDERS: this module may only import types from there, or the two form a runtime cycle.
const KNOWN_TIERS = new Set<GenerationTier>(["quality", "balanced", "fast"]);

/**
 * Split "anthropic+fast" into its parts. Returns null when the FAMILY is unrecognized —
 * an entry naming no known provider is not routable and the caller drops it.
 *
 * An unrecognized TIER degrades to no override rather than dropping the entry: a typo in
 * the suffix should cost the tier opinion, not the family's place in the failover chain.
 * That matches how the rest of this module fails — a bad table entry falls through to the
 * known-good default instead of taking generation down for that dialect.
 */
function parseEntry(entry: string): { provider: LlmProvider; tier?: GenerationTier } | null {
  const [rawProvider, rawTier] = String(entry).trim().toLowerCase().split("+", 2);
  if (!KNOWN_PROVIDERS.has(rawProvider as LlmProvider)) return null;
  const tier = rawTier && KNOWN_TIERS.has(rawTier as GenerationTier)
    ? (rawTier as GenerationTier)
    : undefined;
  return { provider: rawProvider as LlmProvider, tier };
}

/**
 * Operator escape hatch for the default ordering: CODEGEN_DEFAULT_PRIORITY, a
 * comma-separated family list (e.g. "anthropic,openai" to give unevaluated
 * languages a blind fallback during an incident). Unparseable or empty values
 * fall back to DEFAULT_MODEL_PRIORITY rather than failing the request.
 */
function configuredDefaultPriority(): LlmProvider[] {
  const raw = process.env.CODEGEN_DEFAULT_PRIORITY;
  if (!raw) return DEFAULT_MODEL_PRIORITY;
  // Parses through the same helper, so the operator hatch accepts "anthropic+fast" too.
  const parsed = raw
    .split(",")
    .map(part => parseEntry(part)?.provider)
    .filter((p): p is LlmProvider => !!p);
  return parsed.length ? dedupe(parsed) : DEFAULT_MODEL_PRIORITY;
}

function dedupe(providers: LlmProvider[]): LlmProvider[] {
  return [...new Set(providers)];
}

/**
 * The family ordering to try for `lang`, most preferred first.
 *
 * Never empty: an unknown language, an empty table entry, or a table entry whose
 * families are all unrecognized resolves to the default. A silent fall-through to
 * the default is the right failure mode here — a typo in the table should degrade
 * to the known-good provider, not take generation down for that dialect.
 */
export function modelPriorityFor(lang: string | number | undefined | null): LlmProvider[] {
  const fallback = configuredDefaultPriority();
  if (lang === undefined || lang === null || String(lang).trim() === "") {
    return fallback;
  }
  const configured = orderOf(MODEL_PRIORITY[normalizeLangId(lang)]);
  if (!configured.length) return fallback;
  // Tier suffixes are stripped here: this function answers "which families, in what order",
  // and every existing caller expects exactly that. Tier comes from modelTiersFor.
  const valid = dedupe(
    configured.map(entry => parseEntry(entry)?.provider).filter((p): p is LlmProvider => !!p),
  );
  return valid.length ? valid : fallback;
}

/**
 * Per-family tier overrides for `lang`, e.g. `{ anthropic: "fast", openai: "balanced" }`.
 *
 * Empty for every language whose entries carry no `+tier` suffix, which is the normal case
 * — and an empty result means "no opinion", leaving the route's tier (the dialect's own
 * `gc:tier=` directive, or the small-edit downgrade) in force. That is what keeps this
 * addition invisible to every language that predates it.
 *
 * Deliberately separate from modelPriorityFor rather than folded into one richer return
 * type: the ordering has several callers that do not care about tier, and widening their
 * shape to carry a field they ignore would be a worse trade than reading the table twice.
 */
export function modelTiersFor(
  lang: string | number | undefined | null,
): Partial<Record<LlmProvider, GenerationTier>> {
  if (lang === undefined || lang === null || String(lang).trim() === "") return {};
  const configured = orderOf(MODEL_PRIORITY[normalizeLangId(lang)]);
  if (!configured.length) return {};
  const out: Partial<Record<LlmProvider, GenerationTier>> = {};
  for (const entry of configured) {
    const parsed = parseEntry(entry);
    // First mention wins, matching dedupe()'s first-wins ordering above.
    if (parsed?.tier && !out[parsed.provider]) out[parsed.provider] = parsed.tier;
  }
  return out;
}

/** Languages with an explicit ordering — i.e. the ones that have been evaluated. */
export function evaluatedLanguageIds(): string[] {
  return Object.keys(MODEL_PRIORITY).filter(id => orderOf(MODEL_PRIORITY[id]).length);
}

/**
 * The tier a language wants for a given mode, or undefined to keep the default.
 *
 * Defaults live at the CALL SITES, not here — repair hardcodes "balanced", the property path
 * hardcodes "fast", and create/update fall back to the route tier — so returning undefined
 * means "you were right, carry on". That keeps this table purely a place to record
 * exceptions, and keeps a language with no entry behaving identically to before it existed.
 */
export function modeTierFor(
  lang: string | number | undefined | null,
  mode: GenerationMode,
): GenerationTier | undefined {
  if (lang === undefined || lang === null || String(lang).trim() === "") return undefined;
  const config = MODEL_PRIORITY[normalizeLangId(lang)];
  if (!config || Array.isArray(config)) return undefined;
  const tier = config[mode];
  return tier && KNOWN_TIERS.has(tier) ? tier : undefined;
}

const KNOWN_EFFORTS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * The effort a language wants for a given mode, or undefined to keep the global default.
 *
 * Exactly the shape of modeTierFor, and undefined means the same thing: "you were right,
 * carry on". The default lives at the call site — `route.effort ?? options.effort`, where
 * options.effort is CODEGEN_EFFORT — so a language with no entry behaves precisely as it
 * did before this existed, and the table stays a record of exceptions rather than a
 * second place the default is written down.
 *
 * Unlike modeTierFor, a BARE level is accepted as well as the per-mode object, because
 * effort is usually a whole-language opinion ("this dialect needs to think") where tier
 * is usually a per-mode one.
 */
export function modeEffortFor(
  lang: string | number | undefined | null,
  mode: GenerationMode,
): EffortLevel | undefined {
  if (lang === undefined || lang === null || String(lang).trim() === "") return undefined;
  const config = MODEL_PRIORITY[normalizeLangId(lang)];
  if (!config || Array.isArray(config)) return undefined;
  const effort = config.effort;
  if (!effort) return undefined;
  const level = typeof effort === "string" ? effort : effort[mode];
  return level && KNOWN_EFFORTS.has(level) ? level : undefined;
}
