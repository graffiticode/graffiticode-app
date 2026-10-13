// Synthetic `itemId`s used by the internal generation harnesses.
//
// The daily corpus ping and the weekly corpus sweep both call
// `generateCodeForRequest` with an `itemId` they invent, because a dialect
// reading `get-val-public "itemId"` must resolve to something (see the comment
// at corpus-ping.ts's call site). Neither creates an item: the id is never
// written to Firestore.
//
// That is exactly what makes them dangerous to cost reporting. The id is
// CONSTANT per language, so anything that groups `ai_generation` records by
// `itemId` sees a whole window of harness runs as ONE enormous item. Observed
// 2026-09-09: L0175's 25 daily pings collapsed into a single $3.38 "item",
// which — averaged against the one real item the language produced that week —
// reported $1.62/item for a dialect whose real item cost 4 cents.
//
// So the ids live here, in one place, shared by the two writers and by every
// reader that has to tell harness traffic apart from customer traffic. A new
// harness MUST register its prefix here rather than inventing one at its call
// site, or it silently reappears in the cost reports as a giant fake item.
//
// Note these are *prefixes with a language suffix*, not opaque ids: matching is
// by prefix so `corpus-ping-0175` and any future `corpus-ping-0183` are both
// recognised without this file knowing the language set.

export const HARNESS_ITEM_ID_PREFIXES = {
  /** Daily liveness ping — src/lib/corpus-ping.ts */
  ping: "corpus-ping-",
  /** Weekly shape sweep — src/lib/corpus-sweep.ts */
  sweep: "corpus-sweep-",
  /** Model eval — scripts/model-eval.ts */
  eval: "model-eval-",
  /** Corpus re-baseline — scripts/corpus-rebaseline.ts */
  rebaseline: "corpus-rebaseline-",
} as const;

export type HarnessKind = keyof typeof HARNESS_ITEM_ID_PREFIXES;

/** The synthetic id a harness run passes for `lang` (e.g. `corpus-ping-0175`). */
export function harnessItemId(kind: HarnessKind, lang: string): string {
  return `${HARNESS_ITEM_ID_PREFIXES[kind]}${lang}`;
}

/**
 * Does this `itemId` belong to an internal harness rather than a real item?
 *
 * Callers that measure per-item cost must exclude these from BOTH sides of the
 * ratio: the spend is real, but it produces no item, so dividing it by items
 * charges customer items for infrastructure and makes cost/item grow every time
 * a language joins the ping set.
 */
export function isHarnessItemId(itemId: unknown): boolean {
  if (typeof itemId !== "string") return false;
  return Object.values(HARNESS_ITEM_ID_PREFIXES).some(p => itemId.startsWith(p));
}

/** Which harness an id belongs to, or null for a real item. */
export function harnessKindOf(itemId: unknown): HarnessKind | null {
  if (typeof itemId !== "string") return null;
  for (const [kind, prefix] of Object.entries(HARNESS_ITEM_ID_PREFIXES)) {
    if (itemId.startsWith(prefix)) return kind as HarnessKind;
  }
  return null;
}
