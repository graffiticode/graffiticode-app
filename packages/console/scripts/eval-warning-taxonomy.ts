/**
 * Compiler-warning extraction and classification for the eval harness.
 *
 * WHY THIS EXISTS. The 0175 sweep reported 100% compile across three variants while 35 of its 60
 * compile results carried warnings — dangling evidence ids, bare distractor pools, length
 * giveaways. Compiling is table stakes for this dialect; the warnings ARE the quality signal, and
 * they were being discarded. `generateCode` already returns them (its `verification` result), so
 * this is pure extraction, not new plumbing.
 *
 * THE FIXABLE/UNFIXABLE SPLIT is the load-bearing part. The convergence loop asks a model to repair
 * what the compiler complained about, so a warning the model cannot legitimately fix must not drive
 * it. `Passage reads above grade 5` is about the stimulus the PROMPT supplied — 27 of the 68
 * messages in the baseline sweep, 40% of the total. Feeding that back tells a model to rewrite the
 * user's passage, which is both wrong and unwinnable, and would score every variant as "never
 * converged". So unfixable buckets are reported and excluded from the convergence target.
 *
 * Matchers are written against the 11 distinct message shapes the L0175 compiler actually emitted
 * in that sweep, not against guesses. An unrecognized message classifies as `unknown` + fixable and
 * is surfaced by `unknownWarnings()`, so a new compiler warning shows up as a miss to fix here
 * rather than silently leaving the metric.
 */

export type WarningBucket =
  | "passage-level"
  | "missing-task-model"
  | "dangling-reference"
  | "thin-pool"
  | "giveaway"
  // ── L0177 (Author API integration) ──────────────────────────────────────────
  | "design-hole"      // a required property the design doesn't state
  | "member-dropped"   // a member the chosen view doesn't accept
  | "invalid-value"    // wrong type, or a tag that isn't a Learnosity widget type
  | "specificity"      // advisory: unrestricted widgets, default item bank
  | "unknown";

export interface ClassifiedWarning {
  message: string;
  bucket: WarningBucket;
  fixable: boolean;
}

/**
 * Buckets whose warnings the model cannot fix without inventing something.
 *
 * `passage-level` is L0175's: the complaint is about the stimulus the PROMPT supplied, so acting
 * on it means rewriting the user's passage.
 *
 * `design-hole` is L0177's counterpart, and it is the sharper case. That dialect's instructions
 * say outright: "Do not invent `domain`, `user-id`, or `reference` — omit them and the compiler
 * flags them as design holes for the client to supply." A hole is therefore the CORRECT output for
 * a request that named no domain, and feeding it back asks the model to fabricate a serving host —
 * which is both wrong and unwinnable, and would score every variant as never-converged.
 *
 * The exception is real, though: when the prompt DID supply the value and the model dropped it,
 * the identical warning text is a genuine defect. Nothing in the message distinguishes the two —
 * only the case can, via its `design.supplies`, which is what the `supplies` context below is for.
 */
const UNFIXABLE: ReadonlySet<WarningBucket> = new Set<WarningBucket>([
  "passage-level", "design-hole", "specificity",
]);

/**
 * The line these three sit on, stated once because it keeps needing restating: a warning is
 * FIXABLE when it names a defect the model INTRODUCED, and unfixable when clearing it would take
 * information the prompt never contained.
 *
 * L0177's specificity advisories are the second kind, which is not obvious from their wording.
 * "No item bank specified (`organisation-id`) — the default is used" can only be cleared by
 * inventing a bank id; "No `question-type-groups`" by inventing a restriction the request never
 * asked for. They are addressed to the CLIENT, who can go ask the user — not to a generator
 * holding one prompt. Left fixable, the convergence loop reads them as work and drives exactly the
 * fabrication this dialect exists to prevent.
 *
 * That is also why they can be unconditional where design holes cannot: an advisory only fires
 * when the prompt named no bank/restriction, so there is no "the prompt supplied it and the model
 * dropped it" case to rescue — except on an update whose currentCode carried one, which the
 * `member-dropped`/`invalid-value` buckets (both genuinely fixable) do not cover. Rare enough to
 * name here rather than build for.
 */

/**
 * Which required property a design-hole warning is about, so a case that DID supply that value can
 * reclassify the warning as fixable. Keyed on the compiler's own phrasing.
 */
const HOLE_SUBJECT: Array<[RegExp, string]> = [
  [/serving `?domain`?/i, "domain"],
  [/identify the author|`?user-id`?/i, "user-id"],
  [/needs a `?reference`?/i, "reference"],
  [/which authoring view/i, "view"],
];

const RULES: Array<[RegExp, WarningBucket]> = [
  // "Passage reads above grade 5 (est. grade 8.1); shorten sentences and use simpler…"
  [/passage reads (?:above|below) grade/i, "passage-level"],
  // "Outcome 'q1' does not specify a task-model; add one (e.g. `task-model tm3`)…"
  [/does not specify a task-model/i, "missing-task-model"],
  // "claim 'd4' cites unknown evidence id 'e2'."
  [/cites unknown evidence id/i, "dangling-reference"],
  // "Only 2 distractor claim(s) target this outcome; this item wants 3"
  // "Only 4 viable distractor(s) target outcome 'q1'; author at least 5…"
  // "Only 3 non-supporting evidence source(s) available; author at least 5"
  // "Only 3 Part B foil source(s) available; author at least 5 non-supporting evidence lines…"
  // "Distractor error types not represented: insignificant."
  //
  // Deliberately matches "Only N …" followed by ANY pool noun rather than enumerating the
  // phrasings: the first version of this rule listed the three shapes present in the baseline
  // sweep and then missed "Part B foil source(s)" in the very next run — same defect, different
  // wording. Every one of these warnings means the same thing (the authored pool is too shallow),
  // so the rule should key on that, not on the compiler's current sentence.
  [/only \d+ .{0,40}(?:distractor|source|foil|claim)/i, "thin-pool"],
  [/error types not represented/i, "thin-pool"],
  // "Part A/Part B/Options: the correct option (…) is 60% longer … possible length giveaway."
  // "Part B options do not overlap the correct Part A option — possible A↔B giveaway."
  [/giveaway/i, "giveaway"],

  // ── L0177, written against the strings in its compiler.ts, not against guesses ──────────────
  // "Which authoring view? Use exactly one of: item-edit, item-list, activity-edit, activity-list."
  // "Your design doesn't specify the serving `domain` (required — the Author API signature binds…"
  // "Your design doesn't identify the author (required). Provide `user-id` — the author's stable id."
  // "item-edit needs a `reference` — the existing item to edit, or a new reference to create."
  [/which authoring view|doesn't specify the serving|doesn't identify the author|needs a `?reference`?/i, "design-hole"],
  // "item-list: \"widget\" isn't a member of this view — dropped. item-list accepts: item."
  [/isn't a member of this view|isn't a valid .* (?:property|option)|isn't a top-level/i, "member-dropped"],
  // "allow-widgets: FOO isn't a Learnosity widget type — use tags like MCQ, SHORT-TEXT…"
  // "item back must be true or false." / "container height must be a number."
  [/isn't a learnosity widget type|must be (?:true or false|a number|a string)/i, "invalid-value"],
  // "`allow-widgets` not restricted — the editor exposes all default widget types."
  // "No item bank specified (`organisation-id`) — the default is used."
  // "No `question-type-groups` — the editor offers all ten question-type groups."
  [/not restricted —|no item bank specified|no `?question-type-groups`?/i, "specificity"],
];

/**
 * Context that decides fixability for warnings whose text alone cannot.
 * `supplies` is the eval case's `design.supplies` — the required properties the PROMPT gave.
 */
export interface WarningContext {
  supplies?: string[];
}

export function classifyWarning(message: string, ctx?: WarningContext): ClassifiedWarning {
  const text = String(message || "");
  for (const [re, bucket] of RULES) {
    if (re.test(text)) {
      // A hole the prompt DID supply is a dropped value, not a hole the client still owes —
      // the one case where a design-hole warning is legitimately repairable.
      if (bucket === "design-hole" && ctx?.supplies?.length) {
        const subject = HOLE_SUBJECT.find(([r]) => r.test(text))?.[1];
        if (subject && ctx.supplies.includes(subject)) {
          return { message: text, bucket, fixable: true };
        }
      }
      return { message: text, bucket, fixable: !UNFIXABLE.has(bucket) };
    }
  }
  // Unknown defaults to FIXABLE: a warning we don't recognize is more likely a real defect than a
  // stimulus complaint, and treating it as unfixable would quietly shrink the convergence target.
  return { message: text, bucket: "unknown", fixable: true };
}

/**
 * Every warning-bearing object in a verification result.
 *
 * The first four shapes are the item shapes L0175/L0176 return, mirroring `toItems()` inside
 * @graffiticode/l0175 (module-private there). The last two exist because "item" is not the only
 * thing a dialect compiles to:
 *
 *   L0177 compiles to ONE design object — `{ mode, complete, warnings, paths }` — with no `kind`
 *   and no `type`. It fell through every branch, so `[]` came back and its warnings, which are the
 *   dialect's ENTIRE quality signal, were silently dropped. The first 0177 sweep (78 runs,
 *   2026-08-12) reported `warn 0.0` and `converged 100%` on programs that demonstrably carried
 *   design holes. Nothing failed; every column just quietly meant something else.
 *
 * Hence: key on carrying warnings, not on looking like an item. That is the actual precondition,
 * and a dialect that compiles to something new gets counted instead of silently scoring zero.
 */
function toItems(data: any, depth = 0): any[] {
  if (!data || typeof data !== "object" || depth > 2) return [];
  if (Array.isArray(data)) return data;
  if (data.kind === "items" && Array.isArray(data.items)) return data.items;
  if (data.kind === "item") return [data];
  if (data.type) return [data]; // lenient: a bare item-shaped object
  if (Array.isArray(data.warnings) || typeof data.complete === "boolean") return [data];
  // Defensive: some callers hand over the whole compile envelope rather than its `data`.
  if (data.data) return toItems(data.data, depth + 1);
  return [];
}

export interface WarningReport {
  all: ClassifiedWarning[];
  fixable: ClassifiedWarning[];
  unfixable: ClassifiedWarning[];
  /**
   * The compiler's `review.alternativeClaims`: how many OTHER supported claims of the same
   * dimension the item could have been built around (`supported claims - 1`). It is a
   * multiple-correct-answer smell, NOT a measure of distractor depth — a well-formed EBSR
   * has exactly one supported claim and reports 0 no matter how deep its foil pool is.
   * Captured because the compiler emits it; do not read it as pool depth.
   */
  alternativeClaims: number | null;
}

/**
 * Pull the compiler's warnings (and `review.alternativeClaims`, see above) out of
 * a `generateCode` result's `verification` field. Returns an empty report rather than throwing when
 * the language emits no such structure, so non-L0175 evals are unaffected.
 */
export function warningsFromVerification(verification: any, ctx?: WarningContext): WarningReport {
  const items = toItems(verification?.data);
  const all: ClassifiedWarning[] = [];
  let alternativeClaims: number | null = null;
  for (const item of items) {
    for (const w of item?.warnings || []) all.push(classifyWarning(typeof w === "string" ? w : String(w?.message ?? w), ctx));
    const alt = item?.review?.alternativeClaims;
    if (typeof alt === "number") alternativeClaims = (alternativeClaims ?? 0) + alt;
  }
  return {
    all,
    fixable: all.filter((w) => w.fixable),
    unfixable: all.filter((w) => !w.fixable),
    alternativeClaims,
  };
}

/** Distinct unrecognized messages — print these after a run so the taxonomy can be extended. */
export function unknownWarnings(reports: WarningReport[]): string[] {
  const seen = new Set<string>();
  for (const r of reports) {
    for (const w of r.all) if (w.bucket === "unknown") seen.add(w.message);
  }
  return [...seen];
}

/** Counts by bucket, for the run payload and the console summary. */
export function bucketCounts(reports: WarningReport[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reports) {
    for (const w of r.all) out[w.bucket] = (out[w.bucket] || 0) + 1;
  }
  return out;
}
