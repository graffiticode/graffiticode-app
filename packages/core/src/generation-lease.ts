// Generation progress on the item (moved from pages/api/resolvers.ts). The v1
// worker's status flips and per-item lease lived here too; they were retired
// with generation protocol v1 (2026-10-17) — v2 jobs keep their state and
// lease in generation-jobs/{id} (generation-jobs.ts).
import { db } from "./db.js";
import type { AuthArg } from "./types.js";

/**
 * Write how many characters a running generation has emitted.
 *
 * Deliberately a bare `update` of one field rather than going through updateItem:
 * this runs DURING generation, several times, and must not touch the taskId path,
 * the version record, billing, or the free-plan expiry bump. It is progress, not a
 * mutation of the item's content.
 *
 * Cleared by the v2 completion and failure transactions, so a finished item
 * never carries a stale count.
 */
export async function setItemGenerationChars({
  auth,
  id,
  chars,
}: {
  auth: AuthArg;
  id: string;
  chars: number;
}) {
  await db().doc(`users/${auth.uid}/items/${id}`).update({ generationChars: chars });
}
