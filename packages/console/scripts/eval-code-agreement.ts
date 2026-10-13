/**
 * eval-code-agreement.ts — how much the variants' programs actually DIFFER on the same case.
 *
 * WHY. Every objective column in model-eval.ts rates a run against the compiler: did it parse,
 * did it converge, what did the compiler object to. On a dialect whose compile rate is saturated
 * (L0179's 2026-08-25 sweep: all four variants at 100%), those columns are all ties, and a tie
 * says nothing about whether the models wrote the SAME program or four different ones that happen
 * to compile. That distinction is free — the code is already on every RunResult for the judge —
 * and it is the cheapest read on whether RAG is doing the work:
 *
 *   - Agreement is the healthy result. Identical programs across families mean retrieval and the
 *     dialect instructions, not the model, determined the output — which is exactly what a curated
 *     corpus is for, and it is the evidence that a cheaper tier is safe.
 *   - Disagreement is where a model choice can still matter. A variant that consistently departs
 *     from what the others converge on is either seeing something in the prompt they missed or
 *     inventing something the corpus never taught — and which one it is is a two-minute read of
 *     the two programs, not another sweep.
 *
 * This measures DIVERGENCE, never quality. Nothing here knows which program is better; a solo
 * dissent is a pointer at a pair of programs to look at, and the judge or a human label is what
 * settles it. Rank models on this and you would be rewarding conformity.
 *
 * THREE LEVELS, because "different" hides three different findings:
 *   formatting — the same token stream, laid out differently. Noise; never reported as a delta.
 *   values     — the same program shape, different invented literals (one model's sample rows say
 *                Alice/Bob, the other's say Q1/Q2). Real, but it is invention, not nuance: the
 *                prompt underdetermined the content and both filled the hole.
 *   structure  — the shapes differ: different attributes, different cell counts, a formula where
 *                the other typed a literal. This is the only level worth reading, and the report
 *                names the vocabulary that separates them so the axis is visible without a diff.
 *
 * SELF-AGREEMENT IS THE CONTROL, and the reason this isn't just a diff. A cross-model delta only
 * means "these models write different programs" if each model writes the SAME program when you
 * run it twice. A variant that disagrees with itself across trials is sampling noise, and its
 * disagreement with the others is the same noise — so `self` is printed next to `agrees` and a low
 * `self` invalidates that row's cross-model reading. This needs --trials > 1 to say anything.
 *
 * CANONICAL SOURCE FIRST. Layout differences are removed by round-tripping every program through
 * the dialect's own parser — `parser.parse` then `unparse` (canonicalizeRuns below) — rather than
 * by normalizing text here. The parser is the authority on what is layout and what is content, and
 * a hand-rolled normalizer can only approximate it: it would keep counting a re-indented attribute
 * list as a delta, or worse, normalize away something that mattered. The round-trip is local
 * (only the lexicon fetch is network, and it is cached), so it costs a sweep nothing.
 *
 * The `formatting` level survives that step only as a fallback: a program the parser rejects keeps
 * its raw source, and two such programs can still differ by layout alone. When the round-trip
 * worked, `formatting` is unreachable by construction.
 *
 * NOISE FLOOR — read this before calling any movement a result. Two L0179 sweeps run a day apart
 * against the IDENTICAL dialect (fingerprint a3552541, 12 cases x 4 variants x 3 trials, 2026-08-25
 * and 2026-08-26) differed by up to 9 points of cross-model agreement (sonnet 42% -> 33%) and 19
 * points of self-agreement (sonnet 75% -> 56%). At this sample size a single sweep's number is not
 * a measurement of anything; only a move larger than that, or one that shows up in every variant at
 * once, is. The four-sweep series that followed cleared it by moving all four variants together
 * (agreement 28-44% across both baselines -> 47-53%), which trial noise does not do.
 *
 * The cheap guard is to hold a same-dialect baseline: fingerprint every sweep (model-eval.ts stamps
 * it per run) and compare like against like. A dialect that shipped mid-series is the one thing that
 * makes two sweeps incomparable, and the fingerprint is what catches it.
 *
 * WHAT IT COMPARES: the same median-latency representative the judge scores (pickRepresentative),
 * over runs that compiled — a failed run is absent from its case rather than counted as agreement.
 * In --converge mode `code` is the session's ENDPOINT, so agreement there is about where the
 * variants landed after iterating, not about their opening moves.
 */
import { parser, unparse } from "@graffiticode/parser";
import { getLanguageLexicon } from "../src/lib/api";
import { pickRepresentative } from "./eval-representative";

export interface AgreementRunLike {
  lang: string; caseId: string; variantId: string; model: string;
  trial: number; latencyMs: number; finalCompile: boolean; code?: string;
}

/** Same shape, different layout ⇒ the same program. */
const TOKEN_RE = /"(?:\\.|[^"\\])*"|[A-Za-z_][\w-]*|-?\d+(?:\.\d+)?|[^\s]/g;

function tokens(code: string): string[] {
  return code.match(TOKEN_RE) ?? [];
}

/** Layout-insensitive identity: the token stream itself. */
function textKey(code: string): string {
  return tokens(code).join(" ");
}

/**
 * Structure-only identity: literals masked, so two programs that differ only in the sample data
 * they invented collapse to one key. Numbers are masked with strings because the same hole gets
 * filled either way — `text "8000"` and `text "Q1"` are the same authored cell.
 */
function shapeKey(code: string): string {
  return tokens(code).map((t) => (/^"/.test(t) ? '""' : /^-?\d/.test(t) ? "0" : t)).join(" ");
}

/** The dialect vocabulary a program used, for naming what separates two shapes. */
function vocab(code: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens(code)) {
    if (!/^[A-Za-z_][\w-]*$/.test(t)) continue;
    m.set(t, (m.get(t) || 0) + 1);
  }
  return m;
}

/** Normalized token edit distance, 0 (identical) → 1 (nothing in common). */
function distance(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] / Math.max(a.length, b.length);
}

/** Mean pairwise rate at which a set of keys agree. 1 when fewer than two keys (nothing to compare). */
function pairwiseAgreement(keys: string[]): number | null {
  if (keys.length < 2) return null;
  let same = 0, total = 0;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) { total++; if (keys[i] === keys[j]) same++; }
  }
  return same / total;
}

export interface AgreementCase {
  lang: string; caseId: string;
  /** Variants that produced a compiling program; the rest are absent, never counted as agreeing. */
  variants: string[];
  missing: string[];
  /** identical: same shape AND same literals. values/structure/formatting as documented above. */
  level: "identical" | "formatting" | "values" | "structure";
  /** Shape clusters, largest first — the majority program, then the departures. */
  groups: string[][];
  /** The variant that alone departed from a consensus every other variant shared. */
  soloDissent?: string;
  /** Max pairwise shape distance, and the vocabulary that separates the dissent from consensus. */
  maxDistance?: number;
  added?: string[];
  dropped?: string[];
}

export interface AgreementVariant {
  variantId: string; model: string;
  /** Mean pairwise shape agreement across this variant's OWN trials — the control. */
  self: number | null;
  selfCases: number;
  /** Mean pairwise shape agreement with the other variants. */
  agrees: number | null;
  soloDissents: number;
  cases: number;
}

export interface AgreementReport {
  lang: string;
  cases: AgreementCase[];
  variants: AgreementVariant[];
  identical: number; valuesOnly: number; structural: number; comparable: number;
}

/**
 * Rewrite every run's `code` to its canonical source — parse to the AST pool, unparse back — so
 * agreement is measured on what the program IS rather than on how it was laid out.
 *
 * Returns NEW objects. Mutating the runs would put canonical source into the payload, where the
 * judge reads it and seed-eval-labels copies it into a label row: the evidence record has to hold
 * what the model actually emitted, not a reformatted version of it.
 *
 * Never fails a report. A dialect whose lexicon won't fetch, or a program the parser rejects,
 * keeps its raw source and is counted in `failed` so the caller can say the comparison was made
 * on unnormalized text for those runs.
 *
 * Parse callbacks return a constant rather than a real value: `get-val-public "itemId"` resolves
 * differently per run, and threading the real value in would make two identical programs compare
 * unequal for a reason that has nothing to do with the model.
 */
export async function canonicalizeRuns(
  runs: AgreementRunLike[],
): Promise<{ runs: AgreementRunLike[]; failed: number; langsUnavailable: string[] }> {
  const lexicons = new Map<string, any>();
  const langsUnavailable: string[] = [];
  for (const lang of [...new Set(runs.map((r) => r.lang))]) {
    try {
      const lex = await getLanguageLexicon(lang);
      if (lex) lexicons.set(lang, lex); else langsUnavailable.push(lang);
    } catch { langsUnavailable.push(lang); }
  }

  const callbacks = { GET_VAL_PRIVATE: () => "", GET_VAL_PUBLIC: () => "" };
  // Identical source recurs constantly across trials — which is the whole point of the metric —
  // so the cache does most of the work.
  const cache = new Map<string, string | null>();
  let failed = 0;

  const canonical = async (lang: string, code: string): Promise<string | null> => {
    const lex = lexicons.get(lang);
    if (!lex) return null;
    const key = `${lang}\u241f${code}`;
    if (cache.has(key)) return cache.get(key)!;
    let out: string | null = null;
    try {
      const pool: any = await parser.parse(lang, code, lex, callbacks);
      // An ERROR node means the pool describes a broken parse, and unparsing it yields text that
      // is not this program — a silent corruption of the comparison rather than a visible failure.
      const broken = Object.keys(pool || {}).some((k) => k !== "root" && pool[k]?.tag === "ERROR");
      if (!broken) out = unparse(pool, lex, {});
    } catch { /* fall through to raw */ }
    cache.set(key, out);
    return out;
  };

  const out: AgreementRunLike[] = [];
  for (const r of runs) {
    // Only the runs the report will actually compare. Canonicalizing a run that never compiled
    // buys nothing (it is filtered out downstream) and costs a parser stack trace on stderr for
    // every failed generation in the sweep.
    if (!r.code || !r.finalCompile) { out.push(r); continue; }
    const c = await canonical(r.lang, r.code);
    if (c === null) failed++;
    out.push(c === null ? r : { ...r, code: c });
  }
  return { runs: out, failed, langsUnavailable };
}

export function codeAgreement(runs: AgreementRunLike[]): AgreementReport[] {
  const byLang = new Map<string, AgreementRunLike[]>();
  for (const r of runs) (byLang.get(r.lang) ?? byLang.set(r.lang, []).get(r.lang)!).push(r);

  return [...byLang.entries()].map(([lang, rs]) => {
    const variantIds = [...new Set(rs.map((r) => r.variantId))];
    const modelOf = new Map(rs.map((r) => [r.variantId, r.model]));
    const caseIds = [...new Set(rs.map((r) => r.caseId))];

    // (case, variant) → every compiling trial, and the representative among them.
    const trials = new Map<string, AgreementRunLike[]>();
    for (const r of rs) {
      if (!r.finalCompile || !r.code) continue;
      const k = `${r.caseId}\u241f${r.variantId}`;
      (trials.get(k) ?? trials.set(k, []).get(k)!).push(r);
    }
    const repOf = (caseId: string, variantId: string): string | undefined =>
      pickRepresentative(trials.get(`${caseId}\u241f${variantId}`) ?? [])?.code;

    const selfRates = new Map<string, number[]>();
    const agreeRates = new Map<string, number[]>();
    const solos = new Map<string, number>();
    const cases: AgreementCase[] = [];

    for (const caseId of caseIds) {
      for (const v of variantIds) {
        const ts = trials.get(`${caseId}\u241f${v}`) ?? [];
        const rate = pairwiseAgreement(ts.map((t) => shapeKey(t.code!)));
        if (rate !== null) (selfRates.get(v) ?? selfRates.set(v, []).get(v)!).push(rate);
      }

      const present = variantIds.filter((v) => repOf(caseId, v));
      const missing = variantIds.filter((v) => !repOf(caseId, v));
      if (present.length < 2) continue; // nothing to compare — not agreement, not disagreement

      const shapes = new Map<string, string>(present.map((v) => [v, shapeKey(repOf(caseId, v)!)]));
      const texts = new Map<string, string>(present.map((v) => [v, textKey(repOf(caseId, v)!)]));

      for (const v of present) {
        const others = present.filter((o) => o !== v);
        const rate = others.length ? others.filter((o) => shapes.get(o) === shapes.get(v)).length / others.length : null;
        if (rate !== null) (agreeRates.get(v) ?? agreeRates.set(v, []).get(v)!).push(rate);
      }

      // Cluster on shape, largest cluster first: the consensus program, then the departures.
      const clusters = new Map<string, string[]>();
      for (const v of present) (clusters.get(shapes.get(v)!) ?? clusters.set(shapes.get(v)!, []).get(shapes.get(v)!)!).push(v);
      const groups = [...clusters.values()].sort((a, b) => b.length - a.length);

      const oneShape = groups.length === 1;
      const level: AgreementCase["level"] = !oneShape
        ? "structure"
        : new Set(texts.values()).size > 1
          ? "values"
          : new Set(present.map((v) => repOf(caseId, v)!)).size > 1
            ? "formatting"
            : "identical";

      const entry: AgreementCase = { lang, caseId, variants: present, missing, level, groups };

      if (level === "structure") {
        let maxDistance = 0;
        for (let i = 0; i < present.length; i++) {
          for (let j = i + 1; j < present.length; j++) {
            const d = distance(shapes.get(present[i])!.split(" "), shapes.get(present[j])!.split(" "));
            if (d > maxDistance) maxDistance = d;
          }
        }
        entry.maxDistance = maxDistance;
        // A solo dissent needs a real consensus to dissent FROM: two clusters, one of them a
        // singleton, and at least two variants in the other. With two variants there is no
        // majority, so a disagreement names no culprit.
        if (groups.length === 2 && groups[1].length === 1 && groups[0].length >= 2) {
          const odd = groups[1][0];
          entry.soloDissent = odd;
          solos.set(odd, (solos.get(odd) || 0) + 1);
          const mine = vocab(repOf(caseId, odd)!);
          const theirs = vocab(repOf(caseId, groups[0][0])!);
          entry.added = [...mine.keys()].filter((t) => (mine.get(t) || 0) > (theirs.get(t) || 0)).sort();
          entry.dropped = [...theirs.keys()].filter((t) => (theirs.get(t) || 0) > (mine.get(t) || 0)).sort();
        }
      }
      cases.push(entry);
    }

    const mean = (xs?: number[]) => (xs?.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    return {
      lang,
      cases,
      variants: variantIds.map((v) => ({
        variantId: v, model: modelOf.get(v) || v,
        self: mean(selfRates.get(v)), selfCases: selfRates.get(v)?.length ?? 0,
        agrees: mean(agreeRates.get(v)), soloDissents: solos.get(v) || 0,
        cases: agreeRates.get(v)?.length ?? 0,
      })).sort((a, b) => (b.agrees ?? 0) - (a.agrees ?? 0)),
      comparable: cases.length,
      identical: cases.filter((c) => c.level === "identical" || c.level === "formatting").length,
      valuesOnly: cases.filter((c) => c.level === "values").length,
      structural: cases.filter((c) => c.level === "structure").length,
    };
  });
}

export function printAgreement(reports: AgreementReport[]): void {
  const pct = (x: number | null) => (x === null ? "—" : (100 * x).toFixed(0) + "%");
  for (const rep of reports) {
    if (!rep.comparable) continue;
    console.log(`\nCross-variant code agreement — L${rep.lang} (${rep.comparable} comparable case(s)):`);
    console.log(
      `  same program ${rep.identical}   ` +
      `same shape, different literals ${rep.valuesOnly}   ` +
      `different shape ${rep.structural}`,
    );
    console.log("\n  " + ["variant", "self", "agrees", "solo"].map((h, i) => h.padEnd([28, 8, 8, 6][i])).join(""));
    for (const v of rep.variants) {
      console.log("  " + [
        v.model.padEnd(28),
        (v.selfCases ? pct(v.self) : "—").padEnd(8),
        pct(v.agrees).padEnd(8),
        String(v.soloDissents).padEnd(6),
      ].join(""));
    }
    if (rep.variants.every((v) => !v.selfCases)) {
      console.log("  NOTE: `self` needs --trials > 1. Without it a cross-variant delta cannot be told from sampling noise.");
    }
    const structural = rep.cases.filter((c) => c.level === "structure");
    if (structural.length) {
      console.log("\n  Different shape — the only level worth reading (dist = token edit distance on the masked shape):");
      for (const c of structural.sort((a, b) => (b.maxDistance ?? 0) - (a.maxDistance ?? 0))) {
        const groups = c.groups.map((g) => g.join("+")).join("  vs  ");
        console.log(`   · ${c.caseId}  dist ${(c.maxDistance ?? 0).toFixed(2)}  ${groups}`);
        if (c.soloDissent) {
          const add = (c.added ?? []).slice(0, 8).join(" ");
          const drop = (c.dropped ?? []).slice(0, 8).join(" ");
          // Same vocabulary either way means the departure is in arrangement or in how many of
          // something it emitted — a real difference the token multiset cannot name, and one that
          // would print as a bare variant name if it were not said outright.
          console.log(`     ${c.soloDissent} alone${add ? `  +${add}` : ""}${drop ? `  \u2212${drop}` : ""}` +
            (add || drop ? "" : "  (same vocabulary — differs in arrangement or count)"));
        }
      }
      console.log("  Divergence only — nothing here says which program is better; read the pair, or label them.");
    }
    const skipped = rep.cases.filter((c) => c.missing.length);
    if (skipped.length) {
      console.log(`  NOTE: ${skipped.length} case(s) compared fewer than all variants — a run that never compiled is absent, not agreeing.`);
    }
  }
}
