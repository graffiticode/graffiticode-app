// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { generateSpec, specModelFor, SPEC_CACHE_VERSION } from "../lib/spec-generation-service";
import { generateRequestId } from "../lib/logger";
import { db } from "./db";
import { getItem } from "./items";

// Cached specs live on the item doc under `spec`. `coverage.missing` holds verbatim authored
// strings, so the stored copy is clamped: an item doc already carries `code` (the full AST) and
// `help` (the full chat transcript), and a heavily-elided spec must not push it toward the 1MB
// ceiling. The value RETURNED to the caller is always the fresh, unclamped report.
export const SPEC_COVERAGE_MISSING_LIMIT = 50;

/**
 * A cache entry is valid only for the exact content state and prompt/model configuration that
 * produced it. taskId is content-addressed so it covers content; the model stamp catches a
 * MODEL_PRIORITY retier or a SPEC_MODEL override; the version stamp catches a prompt-asset edit.
 */
export function isSpecCacheHit(cached: any, taskId: string): boolean {
  return !!cached
    && typeof cached.text === "string"
    && cached.text.length > 0
    && typeof cached.lang === "string"
    && cached.taskId === taskId
    && cached.version === SPEC_CACHE_VERSION
    // The entry's own lang, not the item doc's: a spec is generated from the task, whose lang
    // is fixed by the same content hash as the taskId. The item doc's `lang` can be rewritten
    // on its own (a scope-gate re-route) without the task changing underneath it.
    && cached.model === specModelFor(cached.lang);
}

// Side-write, never load-bearing: the spec has already been generated and paid for by the time
// we get here, so a failed cache write must not fail the request. Mirrors recordVersion().
export async function cacheSpec({ auth, id, taskId, spec, lang, coverage, model }) {
  try {
    // A targeted update, deliberately NOT routed through updateItem: generating a spec is not
    // a content change, so it must not bump `updated`, refresh a free-plan `expiresAt`, or mint
    // a version record. `update` with a map value replaces the whole map, so a stale entry is
    // overwritten wholesale.
    await db.doc(`users/${auth.uid}/items/${id}`).update({
      spec: {
        text: spec,
        taskId,
        lang,
        model,
        version: SPEC_CACHE_VERSION,
        coverage: {
          checked: coverage?.checked ?? 0,
          missing: (coverage?.missing ?? []).slice(0, SPEC_COVERAGE_MISSING_LIMIT),
        },
        generatedAt: Date.now(),
      },
    });
  } catch (error) {
    console.error("cacheSpec(): failed to store spec for item", id, error);
  }
}

// Produce a platform-neutral English spec of an item's content, for handing across languages.
// Resolves the item -> head taskId, then delegates to the spec generator. The item id is an
// opaque handle here; the returned spec (English) is the only cross-language exchange unit.
//
// Read-through cached on the item doc: generation is a multi-second Anthropic call and sits in
// an agent's hot path, while the result is a pure function of the (content-addressed) taskId
// plus the dialect's prompt assets and model. The cache rides along on share/claim copies,
// which spread the whole doc and re-derive the same taskId.
export async function getSpec({ auth, id }) {
  const rid = generateRequestId();
  const item = await getItem({ auth, id, includeSpec: true });
  if (!item) {
    throw new Error(`Item not found: ${id}`);
  }
  if (!item.taskId) {
    throw new Error(`Item ${id} has no compiled task yet`);
  }
  const cached = (item as any).spec;
  if (isSpecCacheHit(cached, item.taskId)) {
    console.log(`[spec-gen] cache hit lang=${cached.lang}`);
    return {
      spec: cached.text,
      lang: cached.lang,
      itemId: id,
      coverage: {
        checked: cached.coverage?.checked ?? 0,
        missing: cached.coverage?.missing ?? [],
      },
    };
  }
  const { spec, lang, coverage, model } = await generateSpec({ auth, taskId: item.taskId, rid, itemId: id });
  // Never cache an empty spec: that was the silent failure mode of a thinking-capable model
  // leading with a `thinking` block, and caching it would make a transient bug permanent.
  if (spec.trim().length > 0) {
    await cacheSpec({ auth, id, taskId: item.taskId, spec, lang, coverage, model });
  }
  return { spec, lang, itemId: id, coverage };
}
