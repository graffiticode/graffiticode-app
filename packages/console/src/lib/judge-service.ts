/**
 * LLM-as-judge — a single shared code-quality scorer, used two ways:
 *   - OFFLINE, in scripts/model-eval.ts: pairwise model comparison (win-rate) + per-run
 *     pointwise scores, so model/prompt changes can be judged above the (saturated) compile line.
 *   - INLINE (async), from generateCode: fire-and-forget after the response is returned, logging
 *     a pointwise score to rag_analytics/{requestId} with zero user-facing latency (JUDGE_MODE=async).
 *
 * One module so the rubric and prompt live in exactly one place — offline metrics and inline logs
 * are then directly comparable. Reference-free: the eval sets and live requests have no gold answer,
 * so the judge scores the candidate against the prompt (intent) alone, on three rubric dimensions.
 *
 * Provider-neutral: calls run through llm-generation-service's completeOnce, so the judge can be
 * an Anthropic OR an OpenAI model. That matters for cross-family comparison — a Claude judge scoring
 * Claude-vs-GPT output is grading its own family's work, so judgePanel (below) runs one judge per
 * family and the harness measures the disagreement rather than assuming it away.
 *
 * Imports llm-generation-service, not code-generation-service: the latter imports judgeCode, and
 * going through it would close a cycle. The tier/model tables live in llm-models, which is
 * cycle-free.
 */
import {
  completeOnce,
  type SystemPrompt,
  type TokenUsage,
} from "./llm-generation-service";
import {
  inferProviderFromModel,
  modelForProvider,
  type LlmProvider,
} from "./llm-models";
import { getJudgeConfig } from "./rag-config";

// Must cover the WHOLE reason-before-score response: the <analysis> block (every
// requirement enumerated and each formula traced) AND the JSON verdict that
// follows it. At 2048 the analysis alone exhausted the budget on content-heavy
// items, so the verdict was never emitted and the candidate silently dropped out
// of the sample — the dominant cause of judge "errors" once timeouts were fixed.
const JUDGE_MAX_TOKENS = parseInt(process.env.JUDGE_MAX_TOKENS || "8192", 10);

export interface JudgeVerdict {
  correctness: number;          // 1–5: does the code correctly accomplish what the prompt asks
  instructionFollowing: number; // 1–5: did it do specifically what was asked (no more, no less)
  idiomaticity: number;         // 1–5: clean, idiomatic Graffiticode for the dialect
  overall: number;              // 1–5: holistic quality
  rationale: string;
  model: string;
  latencyMs: number;
}

export interface PairVerdict {
  winner: "A" | "B" | "tie";
  byDimension: {
    correctness: "A" | "B" | "tie";
    instructionFollowing: "A" | "B" | "tie";
    idiomaticity: "A" | "B" | "tie";
  };
  agreed: boolean; // true when the two A/B orderings agree on the overall winner
  model: string;
}

/**
 * The 1-5 `overall` scale, in one place.
 *
 * These anchors were maintained in three hand-kept copies — this prompt,
 * data/model-eval/labels/README.md, and scripts/gen-label-worksheet.ts. Since
 * --calibrate measures judge-vs-human agreement, any drift between the copies
 * corrupts the trust gate itself: the judge and the human would be scoring
 * against different scales and the disagreement would look like judge error.
 * The worksheet now renders from this constant; the README points here as
 * canonical.
 */
/**
 * SHARED BACKBONE, 1-3. Identical for every dialect, so a 3 means the same thing everywhere and
 * scores stay commensurable across dialects (which is what lets --calibrate pool rows at all).
 *
 * 3 is "correct and complete" — the CEILING of what a compiler can verify, and the FLOOR of what
 * is worth shipping. Everything above it is soft quality, which differs by dialect and is the
 * only part a human adds over the objective columns.
 */
const BASE_ANCHORS: Array<{ score: number; meaning: string }> = [
  { score: 1, meaning: "Doesn't work — no render, a stub that authored nothing, or the wrong kind of artifact entirely." },
  { score: 2, meaning: "Works but **wrong or incomplete** — misses the core ask, a requirement is absent, or the central logic/key is wrong." },
  { score: 3, meaning: "**Correct and complete** — every stated requirement met. Nothing a compiler could object to." },
];

/**
 * The soft band, 4-5, per dialect. Above correct-and-complete, every dialect is asking the same
 * two questions — 4: will it still be right when the request changes slightly? 5: would you hand
 * it to someone learning this dialect? — but the evidence for them is dialect-specific, so each
 * entry names what to look at.
 *
 * A dialect with genuinely little soft quality SHOULD cluster at 3. That is a finding ("model
 * choice barely matters here"), not a gap to be filled by inventing bands: a 4/5 distinction
 * manufactured to keep Spearman computable measures the rubric, not the model.
 *
 * `version` is stamped onto every label row when it is scored. Change the wording of a band and
 * you must bump it, so --calibrate can refuse rows scored against anchors that no longer exist
 * rather than silently comparing a judge on one scale to a human on another.
 */
interface DialectAnchors {
  version: number;
  soft: Array<{ score: number; meaning: string }>;
}

const DEFAULT_SOFT: DialectAnchors = {
  version: 2,
  soft: [
    { score: 4, meaning: "Correct **and robust** — derived values are actually computed rather than hardcoded, so it stays right when an input changes." },
    { score: 5, meaning: "Correct, robust, **idiomatic and minimal** — nothing redundant; you would show it to someone learning the dialect." },
  ],
};

const DIALECT_ANCHORS: Record<string, DialectAnchors> = {
  // Spreadsheets. The soft band is thin on purpose — expect most correct sheets to sit at 3.
  "0166": {
    version: 2,
    soft: [
      { score: 4, meaning: "Correct **and robust** — every derived cell is a formula, not a literal (a typed-in 30 where `=SUM(A1:A2)` belongs is a 3); layout is usable (labels, widths, number formats) and formulas extend to new rows." },
      { score: 5, meaning: "All of 4, **idiomatic and minimal** — no dead or redundant cells, formulas written the way the dialect intends; usable as a reference example." },
    ],
  },
  // Learnosity items. Bands are written against what instructions.md actually documents —
  // `distractor-rationale` (a string, or one per option), the faceted `tags` the Author Site
  // indexes (Difficulty, DOK, standards), and the per-type `partial-credit` rules — so scoring a
  // 4 means pointing at a specific authored thing rather than at a general impression.
  //
  // The generic default band ("derived values are computed rather than hardcoded") described a
  // spreadsheet and said nothing about an item bank, which would have put a labeler on an axis the
  // dialect doesn't have.
  "0176": {
    version: 2,
    soft: [
      // NOTE the "asked for it" rule. Several 0176 cases request rationales and tags outright, so
      // their PRESENCE is part of being correct and complete. Reward presence here and the band
      // collapses into 3 on those cases while being unreachable on the ones that don't ask. What
      // 4 measures is whether the authored metadata is any GOOD.
      { score: 4, meaning: "**Bankable** — the authored metadata is right, not merely present: each `distractor-rationale` names the specific misconception that option catches rather than restating that it is wrong; scoring matches the item's structure (partial credit only on a type with several scorable responses, exact match otherwise, `valid-response` indices lined up with the options); any tags are accurate for the content. Anything the request explicitly asked for counts toward 3 — this band is about quality, not presence. A content team could import it unedited." },
      { score: 5, meaning: "**Exemplar** — all of 4, plus distractors that discriminate (each one plausible to a specific partial understanding rather than obviously wrong), stimulus and options free of giveaways, the question type chosen for what it is best at rather than the nearest one that works, and bank-useful metadata the request never asked for." },
    ],
  },
  // ELA assessment items. Correct-and-complete is a low bar here: an item can meet every stated
  // requirement and still measure nothing, which is exactly what the compiler cannot see.
  "0175": {
    version: 2,
    soft: [
      { score: 4, meaning: "**Defensible as an assessment item** — each distractor encodes a distinct plausible misconception, the key requires the passage (not general knowledge), no length/position/stem-echo giveaway, stem taken from the catalog. A reviewer would accept it." },
      // "Pool depth" is countable in the SOURCE, not in the compiled review: count the
      // `claim status distractor … targets ["q1"]` entries and the non-supporting `source`s,
      // against the three of each an EBSR draws. Do NOT read `review.alternativeClaims` for
      // this — it counts other SUPPORTED claims of the same dimension, so a well-formed item
      // reports 0 however deep its pool is, and reading it as depth marks every item thin.
      { score: 5, meaning: "**Exemplar** — all of 4, plus a pool deeper than the item consumes (more targeted distractors than the three drawn, spanning distinct error types, and more non-supporting sources than Part B uses), Part B that discriminates on its own, and options matched in register and length." },
    ],
  },
  // Learnosity Author API integration designs. This dialect's compiler is unusually strong — it
  // reports design holes, drops members the chosen view doesn't accept, type-checks every property,
  // and computes `complete` — so band 3 already means no hole, no dropped member, no bad value.
  // What it cannot see is whether the design would DO anything in the running editor, which is
  // where the soft band lives.
  //
  // TWO TRAPS TO KNOW BEFORE SCORING, both of which make the compiler's signals point the wrong way:
  //
  //   1. A program that INVENTS a `domain`, `user-id` or `reference` the request never supplied
  //      compiles clean, reports `complete: true`, and emits FEWER warnings than the correct
  //      answer. Every compiler-visible signal rewards it. It is still wrong — the recipe then
  //      tells a developer to sign for a host they do not serve, which 401s with the Author API's
  //      least debuggable error — so it is a 2 ("a requirement is absent; the central logic is
  //      wrong"), not a 3. Do not let a clean warning count carry it. The 2026-08-12 sweep found
  //      haiku doing this on 6 of 39 runs and luna on 1.
  //   2. The Author API FAILS OPEN on config: an unrecognized or wrong-path key is silently
  //      ignored, the editor still initializes, and the page looks correct while enforcing
  //      nothing. So "the design says the picker is restricted" and "the picker is restricted"
  //      are different claims, and only the first is visible to a compiler.
  "0177": {
    // v2 (2026-08-13): v1's band 4 was unreachable. It rewarded reaching for the ENFORCED
    // mechanism (`question-type-groups`) over the intent-only one (`allow-widgets`) — but the
    // compiler emits a `specificity` advisory when `question-type-groups` is absent, so that
    // choice is compiler-visible and belongs to band 3 by rule 5 below. Measured on the first
    // sweep: every model used it on every case that asked for a restriction, so the band never
    // discriminated. The bands now split on the two things the compiler genuinely cannot see —
    // whether the VIEW matches the experience described, and whether the design is MINIMAL.
    version: 2,
    soft: [
      { score: 4, meaning: "**The right experience, and only what was asked** — the view matches the experience the client described rather than the nearest one that compiles (an \"authors browse and open items\" request answered with `item-list`, not `item-edit` with a reference invented to satisfy it), and the design sets what the request asked for WITHOUT riding along extras it never mentioned. The compiler cannot check either: it knows a view was named, not whether it is the right one, and it will happily accept configuration nobody asked for. A reviewer would send this to a developer as-is." },
      { score: 5, meaning: "**Exemplar** — all of 4, and minimal to the point of being readable as a statement of intent: someone who has never seen the request could reconstruct it from the program, because nothing in it is unexplained by the request. Where the dialect offers an enforced mechanism and an intent-only one for the same goal, both are present and distinguishable (the enforced `question-type-groups` doing the work, `allow-widgets` recording the finer intent the API cannot enforce) so the recipe can carry the distinction to the developer. You would show it to someone learning the dialect." },
    ],
  },
};

/** Canonical 4-digit form, matching findLanguageById in languages.ts. */
function normalizeLang(lang?: string | number | null): string {
  return String(lang ?? "").trim().replace(/^L/i, "").padStart(4, "0");
}

export function dialectAnchors(lang?: string | number | null): DialectAnchors {
  return DIALECT_ANCHORS[normalizeLang(lang)] || DEFAULT_SOFT;
}

/** The anchor VERSION a label row should record when scored for this dialect. */
export function anchorVersion(lang?: string | number | null): number {
  return dialectAnchors(lang).version;
}

/** Full 1-5 scale for a dialect: shared backbone + that dialect's soft band. */
export function overallAnchors(lang?: string | number | null): Array<{ score: number; meaning: string }> {
  return [...BASE_ANCHORS, ...dialectAnchors(lang).soft];
}

/**
 * Back-compat export: the default scale. Prefer overallAnchors(lang) — a bare list cannot express
 * that 4/5 differ by dialect, and callers that ignore the dialect will score 0175 items against a
 * spreadsheet's notion of quality.
 */
export const OVERALL_ANCHORS = overallAnchors();

/** Why the scale is anchored low — shared by the judge prompt and the human worksheet. */
export const ANCHOR_DISCIPLINE =
  "Compiling/rendering is saturated and is table stakes, NOT quality: \"it works\" is a 2, not a " +
  "free 3. Correctness dominates presentation — a clean program that computes the wrong value is at " +
  "most a 2. **3 is correct and complete**, and it is the DEFAULT for anything a compiler would " +
  "accept: do not treat correct-and-complete as a 4. Reserve 4-5 for the soft qualities below, and " +
  "expect a dialect with few of them to cluster at 3.";

/** Markdown table of the anchors, for the human labeling worksheet. */
export function anchorTableMarkdown(lang?: string | number | null): string {
  return [
    "| overall | meaning |",
    "|---|---|",
    ...overallAnchors(lang).map((a) => `| **${a.score}** | ${a.meaning} |`),
  ].join("\n");
}

/**
 * How to award 4 and 5 in ANY dialect. Dialect-independent by construction: each entry in
 * DIALECT_ANCHORS names only the EVIDENCE for its bands, and these rules say what the bands mean.
 *
 * Every rule here was learned by getting it wrong first:
 *   1 came from L0176, whose cases request rationales and tags outright — rewarding their presence
 *     would have collapsed band 4 into 3 on those cases and made it unreachable on the rest.
 *   2 is what keeps calibration possible: an unpointable 4 is a mood, and Spearman cannot correlate
 *     moods.
 *   3 stops "did more than asked" from reading as excellence when instruction-following calls it a 2.
 *   4 is the honest out. A dialect clustering at 3 is a finding about the dialect.
 *   5 is the one that decides whether any of this pays for itself: the convergence loop already
 *     forces every compiler-visible defect to be fixed before a human sees the candidate, so a band
 *     the compiler could check is measuring nothing. The broken L0175 t10 item — warning-free,
 *     drift-free, converged in one turn, scored 1 by a human — is the case in point.
 */
export const SOFT_BAND_DISCIPLINE = [
  "4 = judgment where the request was SILENT: the same requirements executed with craft — the",
  "choices made where the prompt did not specify, or where quality is a matter of degree. It is the",
  "work a reviewer would otherwise send back.",
  "5 = HEADROOM, not merely the absence of faults. \"Nothing wrong with it\" is a 4. A 5 has something",
  "left over — depth beyond what was used, generality beyond what was asked — which is what makes it",
  "worth showing to someone learning the dialect. Expect 5s to be rare.",
  "",
  "Rules, in every dialect:",
  "1. PRESENCE IS 3, QUALITY IS 4. Anything the request explicitly asked for belongs to correct-and-",
  "   complete. Band 4 asks whether it is any good.",
  "2. A 4 MUST BE POINTABLE — name the specific authored thing that earns it. If the reason cannot",
  "   survive \"point at it in the code\", it is a 3.",
  "3. NEVER REWARD EXTRA SCOPE. Doing more than asked is not a 5; extraneous content is a 2.",
  "   Headroom means depth in what WAS asked for.",
  "4. IF YOU CANNOT NAME THE SOFT QUALITY, IT IS A 3. Clustering at 3 is a legitimate result.",
  "5. EVERY BAND MUST BE INVISIBLE TO THE COMPILER. Anything the compiler can verify has already been",
  "   forced to 3. If a proposed 4 would be caught by a warning, it is not a 4 — it is a bug.",
].join("\n");

/**
 * MEASURED DEAD END, recorded so it is not retried on intuition: passing the dialect's full
 * instructions.md into the judge's system prompt (as an authoritative "contract" block) made
 * agreement WORSE on both dialects that have labels.
 *
 *   L0176 (clean A/B — only this changed):  MAE .21 -> .36,  rho .60 -> .45
 *   L0175 (confounded, see below):          MAE .57 -> .71,  rho .32 -> .13
 *
 * It did not fix the errors it was meant to fix and added new ones: on L0176 the judge kept faulting
 * `hot-text` for not being "token-highlight", which that document defined as synonyms AT THE TIME OF
 * THE RUN (the synonym was retired shortly after, so do not expect today's copy to show it — the
 * objection was invented against the contract as it then stood, not derived from it), and newly
 * called `itembank-save-credentials` unsigned for code that matches the document's own example line
 * for line. More context did not inform it; it gave it more surface from which to build confident,
 * specific, wrong objections.
 *
 * The shape of every false negative was a claim about MECHANICS — does this construct work, would
 * this key resolve, is this wiring right — which the compiler and the convergence loop have already
 * settled before the judge sees anything. The catch that kept working (a request asking for three
 * accepted forms, code accepting one) was a REQUIREMENT-COUNT claim, checkable from the request with
 * no dialect knowledge at all. If this is revisited, narrow the job rather than widen the context.
 *
 * Caveat on the L0175 number: SOFT_BAND_DISCIPLINE was added to this prompt between its baseline and
 * that run, so two things changed. L0176 is the trustworthy comparison.
 */

const RUBRIC = `You are a strict, discriminating judge of Graffiticode DSL code — a family of domain-specific
languages (spreadsheets, assessments, charts, …); each request targets one dialect. You are given the
natural-language request (the author's INTENT) and one or more candidate programs. There is NO
reference solution — judge each candidate on how well it realizes the intent.

Method — do this BEFORE scoring:
1. Enumerate the discrete requirements in the intent (each value, column, formula, condition, format).
2. For EACH requirement, verify whether the candidate satisfies it — trace the actual formulas and
   logic, do not assume. A well-formed formula that computes the wrong thing (wrong operand, wrong
   condition, wrong base, flat where tiered was asked, tax on the wrong subtotal, …) is a FAILURE.
3. The single worst material failure caps the score — correctness dominates presentation.

Scoring discipline:
- Compiling/rendering is table stakes, NOT quality. A program that renders but gets the central logic
  wrong is poor, not average — do not give credit for merely running.
- Do NOT default to high scores. Reserve the top score for candidates that are correct, complete, AND
  idiomatic. If any requirement is unmet or any formula is wrong, it is not a top score.
- Be concrete: name the specific requirement(s) missed or formula(s) wrong; only say "all requirements
  verified correct" when you have actually checked each one.

Score these dimensions, each an integer 1–5:
- correctness: is every value / formula / condition / structure actually right for the intent?
- instructionFollowing: is every requested element present, and nothing extraneous added?
- idiomaticity: clean, minimal, idiomatic Graffiticode for this dialect?`;

// Coerce to an integer in 1–5, or null when missing/non-numeric. NEVER 0: 0 is
// outside the rubric, and a missing field silently scored 0 reads as "worst" and
// poisons aggregates (the model intermittently omits `overall` under the rubric).
function score5(n: any): number | null {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return null;
  return Math.min(5, Math.max(1, x));
}

function pick(o: any, ...keys: string[]): any {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

// String-aware forward scan collecting every balanced top-level {...} object that
// parses. Robust to a reason-before-score <analysis> block that contains braces
// (formulas, "{}" cells) ahead of the verdict — unlike a greedy first-to-last regex.
function extractJsonObjects(text: string): any[] {
  const s = text || "", out: any[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) {
      if (--depth === 0 && start !== -1) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip non-JSON */ }
        start = -1;
      }
    }
  }
  return out;
}

// The verdict is the LAST verdict-shaped object (after any reasoning). Never throws.
function parseJson(text: string): any | null {
  const objs = extractJsonObjects(text);
  if (!objs.length) {
    const m = (text || "").match(/\{[\s\S]*\}/); // fallback: greedy single block
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o && (o.overall !== undefined || o.correctness !== undefined || o.winner !== undefined)) return o;
  }
  // No verdict-shaped object: the response was truncated before the verdict, or
  // the judge never emitted one. Do NOT fall back to the last object parsed —
  // the analysis quotes both Graffiticode (`{}` cells, `{}..` terminators) and
  // Learnosity JSON, so the salvaged object is arbitrary prose scrapings. That
  // fallback reported truncation as "missing dimension" and hid the real cause.
  return null;
}

/**
 * One judge call. The provider is derived from the model id, so a judge model is
 * the only thing a caller picks — there is no separate provider argument to get
 * out of sync with it.
 *
 * Temperature is left to the adapter's own model rules (completeOnce → the
 * provider adapter drops it where the model rejects it), which is why the local
 * copy of the temperature guard is gone.
 */
async function callJudge(
  system: SystemPrompt,
  user: string,
  model: string,
  timeoutMs: number,
): Promise<{ content: string; usage: TokenUsage }> {
  const provider = inferProviderFromModel(model);
  if (!provider) throw new Error(`Unrecognized judge model "${model}"`);
  const { content, usage, failure } = await completeOnce({
    provider,
    model,
    systemPrompt: system,
    messages: [{ role: "user", content: user }],
    options: { maxTokens: JUDGE_MAX_TOKENS, temperature: 0, timeoutMs },
  });
  if (failure) throw new Error(failure.message);
  return { content, usage };
}

/**
 * Validate a judge model and confirm its provider has a credential.
 *
 * Returns null rather than throwing, because both callers already contract to
 * return null on any failure — a judge is an observer, and a missing OPENAI_API_KEY
 * should silently drop that judge from a panel, not fail the run being scored.
 */
function resolveJudgeModel(model: string | undefined): string | null {
  if (!model) return null;
  const provider = inferProviderFromModel(model);
  if (!provider) return null;
  const key = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  return key ? model : null;
}

/** The quality-tier model for a family — the default judge for that family. */
export function judgeModelForFamily(family: LlmProvider): string {
  return modelForProvider(family, "quality");
}

function intentBlock(prompt: string, lang: string, spec?: string | null, currentCode?: string | null): string {
  const parts = [`Dialect: L${lang}`, ``, `REQUEST (author intent):`, prompt];
  if (currentCode) parts.push(``, `PRIOR CODE (this was an edit of):`, currentCode);
  if (spec) parts.push(``, `INTENT ANCHOR (platform-neutral spec of the produced item):`, spec);
  return parts.join("\n");
}

interface JudgeCodeArgs {
  prompt: string;
  code: string;
  lang: string;
  spec?: string | null;
  currentCode?: string | null;
  /** Judge model id; its provider is inferred. Defaults to JUDGE_MODEL. */
  model?: string;
  /** Optional request id and item id for token usage recording (only used in inline mode, not in offline eval). */
  rid?: string;
  itemId?: string | null;
}

/**
 * Pointwise: score one candidate against the intent. Returns { verdict, usage } or null on any failure
 * (missing key, API error, unparseable verdict) so callers never have to guard against a throw.
 * When rid/itemId are provided (inline mode only), usage is captured for token recording; offline eval
 * simply ignores the usage field.
 */
export async function judgeCode(args: JudgeCodeArgs): Promise<{ verdict: JudgeVerdict; usage?: TokenUsage } | null> {
  const cfg = getJudgeConfig();
  const model = resolveJudgeModel(args.model || cfg.judgeModel);
  if (!model) return null;

  // Anchors for THIS dialect: the 1-3 backbone is shared, but 4-5 are dialect-specific, so a
  // judge handed the default list would score an assessment item against a spreadsheet's idea of
  // quality — and --calibrate would then read that mismatch as judge error.
  const system = `${RUBRIC}

Then an overall 1–5. ${ANCHOR_DISCIPLINE}
${[...overallAnchors(args.lang)].reverse().map((a) => `  ${a.score} = ${a.meaning.replace(/\*\*/g, "")}`).join("\n")}

${SOFT_BAND_DISCIPLINE}

First work through the Method in an <analysis>…</analysis> block: list the intent's requirements, then
check EACH against the candidate — name the formula/value and say whether it is right. Reason to the
score; do not pre-commit to a high one. THEN, after </analysis>, output the verdict as a single JSON
object (no code fences). All four score fields are REQUIRED integers 1–5 (never omit "overall"); put
"rationale" LAST:
{"correctness":N,"instructionFollowing":N,"idiomaticity":N,"overall":N,"rationale":"cite the specific defect(s), or 'all requirements verified correct'"}`;
  const user = `${intentBlock(args.prompt, args.lang, args.spec, args.currentCode)}

CANDIDATE:
${args.code}`;

  // One retry, because a judge call can fail three distinct ways: the call itself
  // throws (timeout / rate limit / provider error), the response carries no
  // verdict-shaped JSON, or the JSON is missing a dimension. All three silently
  // drop the candidate from the sample, so JUDGE_DEBUG=1 reports which one — a
  // dropped candidate is not a neutral loss, it biases whatever the sample gates.
  const t0 = performance.now();
  const debug = process.env.JUDGE_DEBUG === "1";
  const note = (attempt: number, why: string, detail?: string) => {
    if (debug) {
      console.error(`[judge] attempt=${attempt} model=${model} ${why}` +
        (detail ? ` :: ${detail.replace(/\s+/g, " ").slice(0, 240)}` : ""));
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The retry must be a DIFFERENT request, not a replay: temperature is 0, so
      // re-sending the same prompt reproduces the same truncation. Drop the
      // analysis on the second attempt — the verdict alone always fits.
      const sys = attempt === 0
        ? system
        : `${system}\n\nRETRY: your previous response was cut off before the verdict. Skip the ` +
          `<analysis> block entirely and output ONLY the single JSON object, nothing else.`;
      const { content: text, usage } = await callJudge(sys, user, model, cfg.judgeTimeoutMs);
      const o = parseJson(text);
      if (!o) { note(attempt, "no verdict-shaped JSON", `len=${text?.length ?? 0} tail=${(text || "").slice(-200)}`); continue; }
      const correctness = score5(pick(o, "correctness"));
      const instructionFollowing = score5(pick(o, "instructionFollowing", "instruction_following"));
      const idiomaticity = score5(pick(o, "idiomaticity"));
      // A verdict missing any dimension is unusable — retry rather than record a 0.
      if (correctness === null || instructionFollowing === null || idiomaticity === null) {
        note(attempt, "missing dimension", JSON.stringify(o));
        continue;
      }
      // The judge intermittently omits `overall`; repair from the dimension mean
      // instead of recording a spurious 0 that would floor the aggregate.
      const overall = score5(pick(o, "overall")) ?? Math.round((correctness + instructionFollowing + idiomaticity) / 3);
      const verdict: JudgeVerdict = {
        correctness,
        instructionFollowing,
        idiomaticity,
        overall,
        rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 1000) : "",
        model,
        latencyMs: Math.round(performance.now() - t0),
      };
      return { verdict, usage: args.rid ? usage : undefined };
    } catch (e: any) {
      note(attempt, "call threw", e?.message || String(e));
    }
  }
  return null;
}

type Side = "A" | "B" | "tie";
function normSide(v: any): Side {
  const s = String(v || "").trim().toUpperCase();
  return s === "A" ? "A" : s === "B" ? "B" : "tie";
}
function flip(s: Side): Side {
  return s === "A" ? "B" : s === "B" ? "A" : "tie";
}

async function judgeOnce(prompt: string, lang: string, first: string, second: string, spec: string | null | undefined, model: string, timeoutMs: number): Promise<{ winner: Side; dims: Record<string, Side> } | null> {
  // The pairwise judge scores no absolute anchors, but it still needs to know what "better" MEANS
  // once both candidates are correct and complete — which, on a saturated dialect, is most pairs.
  // Without the dialect's soft band it falls back to generic code taste and the comparison drifts
  // away from the axis the pointwise judge and the human are both using.
  const system = `${RUBRIC}

Both candidates may be correct and complete. What separates them in this dialect, in order:
${dialectAnchors(lang).soft.map((a) => `  - ${a.meaning.replace(/\*\*/g, "")}`).join("\n")}

Two candidates, A and B. Decide which better realizes the intent overall and per dimension. Ties allowed.
Return ONLY a JSON object, no prose, no code fences:
{"winner":"A|B|tie","correctness":"A|B|tie","instructionFollowing":"A|B|tie","idiomaticity":"A|B|tie","rationale":"one sentence"}`;
  const user = `${intentBlock(prompt, lang, spec)}

CANDIDATE A:
${first}

CANDIDATE B:
${second}`;
  try {
    const { content: text } = await callJudge(system, user, model, timeoutMs);
    const o = parseJson(text);
    if (!o) return null;
    return {
      winner: normSide(pick(o, "winner")),
      dims: {
        correctness: normSide(pick(o, "correctness")),
        instructionFollowing: normSide(pick(o, "instructionFollowing", "instruction_following")),
        idiomaticity: normSide(pick(o, "idiomaticity")),
      },
    };
  } catch {
    return null;
  }
}

interface JudgePairArgs {
  prompt: string;
  codeA: string;
  codeB: string;
  lang: string;
  spec?: string | null;
  /** Judge model id; its provider is inferred. Defaults to JUDGE_MODEL. */
  model?: string;
}

/**
 * Pairwise, blind, order-controlled: run BOTH A/B orderings (positions swapped) and require
 * agreement on the overall winner; on disagreement, call it a tie (position bias). Per-dimension
 * verdicts are combined the same way. Returns null if either ordering fails.
 */
export async function judgePair(args: JudgePairArgs): Promise<PairVerdict | null> {
  const cfg = getJudgeConfig();
  const model = resolveJudgeModel(args.model || cfg.judgeModel);
  if (!model) return null;

  // Ordering 1: A=codeA, B=codeB. Ordering 2: A=codeB, B=codeA (flip the verdict back).
  const r1 = await judgeOnce(args.prompt, args.lang, args.codeA, args.codeB, args.spec, model, cfg.judgeTimeoutMs);
  const r2 = await judgeOnce(args.prompt, args.lang, args.codeB, args.codeA, args.spec, model, cfg.judgeTimeoutMs);
  if (!r1 || !r2) return null;

  const combine = (a: Side, bRaw: Side): Side => {
    const b = flip(bRaw); // r2 was positionally flipped
    if (a === b) return a;
    return "tie";
  };

  const winner = combine(r1.winner, r2.winner);
  return {
    winner,
    byDimension: {
      correctness: combine(r1.dims.correctness, r2.dims.correctness),
      instructionFollowing: combine(r1.dims.instructionFollowing, r2.dims.instructionFollowing),
      idiomaticity: combine(r1.dims.idiomaticity, r2.dims.idiomaticity),
    },
    agreed: flip(r2.winner) === r1.winner,
    model,
  };
}

// ── Cross-provider panel (OFFLINE / HARNESS ONLY) ────────────────────────────
//
// Do NOT call this from the inline production path. `judgeCode` is what
// generateCode uses, one call per request; a panel multiplies that per-request
// cost by the number of judges for a signal production does not act on. The
// panel exists to answer a question only the harness asks: when we rank model
// FAMILIES against each other, how much of the ranking is the judge preferring
// its own family?
//
// A single-family judge cannot answer that about itself. Running one judge per
// family and reporting the disagreement makes the bias measurable instead of
// assumed — and where the judges disagree, the honest move is a human label, not
// a tiebreak. Position bias is already handled separately by judgePair, which
// runs both A/B orderings; this is the provider-bias analogue, not a replacement.

export interface PanelEntry {
  /** Family of the JUDGE (not of the candidate). */
  judge: LlmProvider;
  model: string;
  verdict: JudgeVerdict | null;
}

export interface PanelVerdict {
  entries: PanelEntry[];
  /** Judges that returned a usable verdict. */
  scored: PanelEntry[];
  /** Mean `overall` across scored judges, or null when none scored. */
  meanOverall: number | null;
  /** Largest pairwise gap in `overall` between judges — 0 with fewer than two. */
  spread: number;
  /**
   * True when every scored judge lands within one point on `overall`. Below that,
   * the panel is not a usable ranking signal for this candidate and the case
   * should go to a human label.
   */
  agreed: boolean;
}

/**
 * Score one candidate with one judge per family.
 *
 * `judges` defaults to both families' quality-tier models. A family with no
 * credential is dropped (resolveJudgeModel returns null), so this degrades to a
 * single-judge run rather than failing — but `scored.length` then tells the
 * caller it cannot measure self-preference, and it should say so rather than
 * report a bias of zero.
 */
export async function judgePanel(args: {
  prompt: string;
  code: string;
  lang: string;
  spec?: string | null;
  currentCode?: string | null;
  judges?: LlmProvider[];
}): Promise<PanelVerdict> {
  const families = args.judges?.length ? args.judges : (["anthropic", "openai"] as LlmProvider[]);
  const entries: PanelEntry[] = [];

  for (const family of families) {
    const model = judgeModelForFamily(family);
    const result = await judgeCode({
      prompt: args.prompt,
      code: args.code,
      lang: args.lang,
      spec: args.spec,
      currentCode: args.currentCode,
      model,
    });
    entries.push({ judge: family, model, verdict: result?.verdict ?? null });
  }

  const scored = entries.filter((e) => e.verdict);
  const overalls = scored.map((e) => e.verdict!.overall);
  const meanOverall = overalls.length
    ? overalls.reduce((s, x) => s + x, 0) / overalls.length
    : null;
  const spread = overalls.length > 1 ? Math.max(...overalls) - Math.min(...overalls) : 0;
  return { entries, scored, meanOverall, spread, agreed: spread <= 1 };
}
