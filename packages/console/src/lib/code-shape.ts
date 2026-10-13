// Comparing two Graffiticode programs by SHAPE rather than by text.
//
// Extracted from scripts/eval-code-agreement.ts, which measured divergence across model variants,
// so the corpus health sweep can ask the same question of a different pair: a freshly regenerated
// program versus the corpus entry it came from. One implementation, because two copies of
// `shapeKey` would drift and quietly stop meaning the same thing.
//
// THREE LEVELS, because "different" hides three findings and only one is worth waking someone for:
//   same        — identical after canonicalization.
//   values      — same shape, different invented literals (one run's rows say Alice/Bob, the
//                 other's say Q1/Q2). Real, but it is invention: the prompt underdetermined the
//                 content and both filled the hole.
//   structure   — the shapes differ: different attributes, different counts, a formula where the
//                 other typed a literal. The only level that says the program changed.
//
// CANONICAL SOURCE FIRST. Layout is removed by round-tripping through the dialect's own parser
// (parse → unparse), never by normalizing text here: the parser is the authority on what is layout
// and what is content, and a hand-rolled normalizer either keeps counting a re-indented attribute
// list as a change or normalizes away something that mattered.
import { parser, unparse } from "@graffiticode/parser";
import { getLanguageLexicon } from "./api";

const TOKEN_RE = /"(?:\\.|[^"\\])*"|[A-Za-z_][\w-]*|-?\d+(?:\.\d+)?|[^\s]/g;

export function tokens(code: string): string[] {
  return code.match(TOKEN_RE) ?? [];
}

/** Layout-insensitive identity: the token stream itself. */
export function textKey(code: string): string {
  return tokens(code).join(" ");
}

/**
 * Structure-only identity: literals masked, so two programs differing only in the sample data they
 * invented collapse to one key. Numbers mask to strings because the same hole gets filled either
 * way — `text "8000"` and `text "Q1"` are the same authored cell.
 */
export function shapeKey(code: string): string {
  return tokens(code).map((t) => (/^"/.test(t) ? '""' : /^-?\d/.test(t) ? "0" : t)).join(" ");
}

/** The dialect vocabulary a program used, for naming what separates two shapes. */
export function vocab(code: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens(code)) {
    if (!/^[A-Za-z_][\w-]*$/.test(t)) continue;
    m.set(t, (m.get(t) || 0) + 1);
  }
  return m;
}

const lexiconCache = new Map<string, any>();

/**
 * Round-trip a program through its dialect's parser. Returns null when the lexicon is unavailable
 * or the parse is broken — the caller then compares raw source, which can still differ by layout
 * alone, so a null is worth reporting rather than hiding.
 *
 * An ERROR node means the pool describes a broken parse, and unparsing it yields text that is not
 * this program — a silent corruption of the comparison rather than a visible failure.
 */
export async function canonicalizeCode(lang: string, code: string): Promise<string | null> {
  if (!code) return null;
  try {
    if (!lexiconCache.has(lang)) lexiconCache.set(lang, await getLanguageLexicon(lang));
    const lex = lexiconCache.get(lang);
    if (!lex) return null;
    const callbacks = { GET_VAL_PRIVATE: () => "", GET_VAL_PUBLIC: () => "" };
    const pool: any = await parser.parse(lang, code, lex, callbacks);
    const broken = Object.keys(pool || {}).some((k) => k !== "root" && pool[k]?.tag === "ERROR");
    if (broken) return null;
    return unparse(pool, lex, {});
  } catch {
    return null;
  }
}

export type ShapeLevel = "same" | "values" | "structure";

export interface ShapeDiff {
  level: ShapeLevel;
  /** True when either side could not be canonicalized, so `level` compares raw source. */
  degraded: boolean;
  /** Vocabulary present in one program and not the other — what to look at first. */
  onlyInA: string[];
  onlyInB: string[];
}

/**
 * Compare two programs of the same dialect. `a` is conventionally the stored baseline and `b` the
 * regeneration, which only matters for reading onlyInA/onlyInB.
 */
export async function compareShape(lang: string, a: string, b: string): Promise<ShapeDiff> {
  const [ca, cb] = await Promise.all([canonicalizeCode(lang, a), canonicalizeCode(lang, b)]);
  const degraded = ca === null || cb === null;
  const A = ca ?? a;
  const B = cb ?? b;

  let level: ShapeLevel;
  if (textKey(A) === textKey(B)) level = "same";
  else if (shapeKey(A) === shapeKey(B)) level = "values";
  else level = "structure";

  const va = vocab(A);
  const vb = vocab(B);
  const onlyInA = [...va.keys()].filter((k) => !vb.has(k)).sort();
  const onlyInB = [...vb.keys()].filter((k) => !va.has(k)).sort();

  return { level, degraded, onlyInA, onlyInB };
}
