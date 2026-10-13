/**
 * Hold-out preflight for the eval harness.
 *
 * `model-eval.ts` instructs that eval cases be seeded from mark-1 training
 * examples "but HOLD THEM OUT of RAG so you're not grading against retrieved
 * answers." Nothing enforced that, and the failure is silent and directional:
 * if a case is also a live `training_examples` doc, RAG retrieves the answer and
 * every model is scored partly on how well it copies a supplied solution. That
 * does not just add noise — it flatters whichever family is better at mimicry,
 * which is exactly the axis a family ordering is supposed to measure. Since the
 * ordering gets committed to src/lib/model-priority.ts and then decides real
 * traffic, a leak here becomes a durable wrong default.
 *
 * So this is a gate, not a warning: a leak fails the run.
 *
 * Escape hatch: --allow-leak downgrades it to a warning, for the case where you
 * deliberately want to measure retrieval-assisted performance. It prints loudly,
 * because that number must never be used to set a priority ordering.
 */
import admin from "firebase-admin";

/** Same lazy-init pattern as code-generation-service.getFirestoreDb. */
function firestore() {
  try {
    return admin.firestore();
  } catch {
    if (!admin.apps.length) admin.initializeApp();
    return admin.firestore();
  }
}

export interface Leak {
  caseId: string;
  kind: "exact" | "contains";
  trainingDocId: string;
  excerpt: string;
}

/**
 * Normalize for comparison: case, whitespace runs, and surrounding punctuation
 * are all things a human editing a prompt into an eval set changes without
 * meaning to, and none of them stop RAG from retrieving the example.
 */
function normalize(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

/** Below this length, containment matching is noise ("make a chart"). */
const MIN_CONTAINMENT_LENGTH = 40;

/**
 * Compare each case prompt against every `training_examples` prompt for the
 * language.
 *
 * Two match kinds, because a verbatim copy is not the only leak that matters:
 *   exact    — normalized prompts identical
 *   contains — one normalized prompt contains the other, both long enough to be
 *              specific. This catches the realistic case: someone pastes a
 *              training prompt into the eval set and appends or trims a clause.
 *
 * Embedding similarity would catch paraphrases too, but it costs an embedding
 * call per case per run and would make a gate depend on a threshold nobody has
 * calibrated. Exact + containment is cheap, explainable, and catches the leak
 * that actually happens.
 */
export class EmptyCorpusError extends Error {}

export async function findHoldoutLeaks(
  lang: string,
  cases: Array<{ id: string; prompt: string }>,
  collection = "training_examples",
): Promise<Leak[]> {
  const snapshot = await firestore().collection(collection).where("lang", "==", lang).get();
  const corpus = snapshot.docs.map((doc) => ({
    id: doc.id,
    prompt: normalize((doc.data() as any)?.prompt || ""),
  })).filter((entry) => entry.prompt);

  // An empty corpus produces "no overlap" — a pass indistinguishable from a real
  // one, and therefore worse than an error. It means either the language has no
  // training examples (so RAG contributes nothing and the run measures a
  // different pipeline than production) or we are pointed at the wrong Firestore
  // — the emulator has 0 training_examples, so a run there would silently clear
  // this gate while retrieving nothing. Refuse either way.
  if (!corpus.length) {
    throw new EmptyCorpusError(
      `no training_examples for L${lang} in "${collection}" — cannot verify hold-out. ` +
      `Check you are pointed at prod Firestore (the emulator has none), or that this ` +
      `language actually has a RAG corpus.`,
    );
  }

  const leaks: Leak[] = [];
  for (const c of cases) {
    const needle = normalize(c.prompt);
    if (!needle) continue;
    for (const entry of corpus) {
      let kind: Leak["kind"] | null = null;
      if (entry.prompt === needle) {
        kind = "exact";
      } else if (
        Math.min(entry.prompt.length, needle.length) >= MIN_CONTAINMENT_LENGTH &&
        (entry.prompt.includes(needle) || needle.includes(entry.prompt))
      ) {
        kind = "contains";
      }
      if (kind) {
        leaks.push({
          caseId: c.id,
          kind,
          trainingDocId: entry.id,
          excerpt: entry.prompt.slice(0, 90),
        });
        break; // one leak per case is enough to fail it
      }
    }
  }
  return leaks;
}

/**
 * Run the gate for every language in the run. Returns true when it is safe to
 * proceed; the caller exits on false.
 */
export async function assertHoldout(
  langs: string[],
  casesFor: (lang: string) => Array<{ id: string; prompt: string }>,
  opts: { allowLeak?: boolean; allowEmptyCorpus?: boolean; collection?: string } = {},
): Promise<boolean> {
  let leaked = 0;
  for (const lang of langs) {
    const cases = casesFor(lang);
    if (!cases.length) continue;
    let leaks: Leak[];
    try {
      leaks = await findHoldoutLeaks(lang, cases, opts.collection);
    } catch (err: any) {
      if (err instanceof EmptyCorpusError && opts.allowEmptyCorpus) {
        console.error(`[holdout] ⚠ L${lang}: corpus is EMPTY — proceeding (--allow-empty-corpus): nothing to leak into, nothing verified.`);
        continue;
      }
      // Cannot verify => do not proceed. An unreadable or empty corpus is
      // indistinguishable from a clean one, and both would silently pass.
      const why = err instanceof EmptyCorpusError
        ? `the corpus is EMPTY: ${err.message}`
        : `could not read the corpus: ${err?.message || err}`;
      console.error(
        `\n[holdout] Cannot verify hold-out for L${lang} — ${why}` +
        `\n[holdout] Refusing to run: an unverifiable corpus looks identical to a clean one.`,
      );
      return false;
    }
    if (!leaks.length) {
      console.error(`[holdout] L${lang}: ${cases.length} cases, no overlap with training_examples ✓`);
      continue;
    }
    leaked += leaks.length;
    console.error(`\n[holdout] L${lang}: ${leaks.length} of ${cases.length} eval cases are IN the RAG corpus:`);
    for (const leak of leaks) {
      console.error(`  ${leak.kind.padEnd(8)} case "${leak.caseId}" ↔ training_examples/${leak.trainingDocId}`);
      console.error(`           "${leak.excerpt}${leak.excerpt.length >= 90 ? "…" : ""}"`);
    }
  }

  if (!leaked) return true;

  if (opts.allowLeak) {
    console.error(
      `\n[holdout] ⚠ --allow-leak: proceeding with ${leaked} leaked case(s).` +
      `\n[holdout] ⚠ These numbers measure retrieval-assisted performance, NOT model quality.` +
      `\n[holdout] ⚠ Do NOT use this run to set a MODEL_PRIORITY ordering.\n`,
    );
    return true;
  }

  console.error(
    `\n[holdout] Refusing to run: ${leaked} eval case(s) are also RAG training examples, so every` +
    `\n          model would be graded partly on copying a retrieved answer — which biases the` +
    `\n          comparison toward whichever family mimics best.` +
    `\n` +
    `\n          Fix by either:` +
    `\n            - removing those prompts from the eval set, or` +
    `\n            - dropping them from the corpus: unmark the eval-account item (mark != 1) and delete` +
    `\n              its training_examples doc — generate-embeddings-from-examples.ts does not prune` +
    `\n` +
    `\n          To measure retrieval-assisted performance deliberately, pass --allow-leak.\n`,
  );
  return false;
}
