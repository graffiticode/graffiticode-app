// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { db } from "./db.js";
import type { AuthArg } from "./types.js";
import { assertNoActiveGeneration } from "./generation-protocol.js";

// Set the async-generation status on an item. Used by startCodeGeneration
// (status="generating") and the /api/generate-job worker (status="ready" on
// success, "failed"+error otherwise). Clears generationStartedAt on a terminal
// status so the staleness guard only fires while genuinely in-flight.
export async function setItemGenerationStatus({
  auth,
  id,
  status,
  error = null,
}: {
  auth: AuthArg;
  id: string;
  status: "generating" | "ready" | "failed";
  error?: string | null;
}) {
  const itemRef = db().doc(`users/${auth.uid}/items/${id}`);
  if (status === "generating") {
    // A v1 revision: refused while a v2 job owns the item, and never queued
    // onto an item that has had one (its worker would refuse the job).
    await db().runTransaction(async (tx) => {
      const data = (await tx.get(itemRef)).data();
      assertNoActiveGeneration(data);
      if (data?.generation) throw new Error("This item uses generation protocol v2; this revision can't revise it.");
      tx.update(itemRef, {
        generationStatus: "generating",
        generationError: null,
        generationStartedAt: Date.now(),
        generationChars: 0,
      });
    });
    return;
  }
  await itemRef.update({
    generationStatus: status,
    generationError: status === "failed" ? error : null,
    generationStartedAt: null,
    // A finished item must not report a count; the MCP only shows it while pending.
    generationChars: null,
  });
}

/**
 * Write how many characters a running generation has emitted.
 *
 * Deliberately a bare `update` of one field rather than going through updateItem:
 * this runs DURING generation, several times, and must not touch the taskId path,
 * the version record, billing, or the free-plan expiry bump. It is progress, not a
 * mutation of the item's content.
 *
 * Cleared by setItemGenerationStatus on any terminal status, so a finished item
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

// --- Generation lease (idempotency for the Cloud Tasks worker) --------------
//
// Cloud Tasks re-dispatches a task whenever it doesn't see a response within the
// dispatch window, and it cannot tell a dead attempt from a slow one. A
// generation that outruns that window is therefore re-dispatched WHILE the first
// attempt is still running, and both do a full LLM run against the same item.
// Observed 2026-08-28: three dispatches per job, a uniform 125s apart, every one
// of them generating.
//
// The lease makes the worker idempotent — the first attempt to claim an item
// wins and later attempts return without generating. It is held only for the
// life of an attempt and released on every terminal path, so a user's next
// update_item on the same item is never blocked by it. The expiry is the
// backstop for a worker that dies without releasing: it must outlive the longest
// possible attempt so that an UNEXPIRED lease always means a live attempt rather
// than a stuck one.
//
// It was 5 minutes, justified by "Cloud Run caps the request at 300s". That
// stopped being true on 2026-08-31: the Cloud Run timeout and the queue's
// dispatchDeadline are both 900s now, and CODEGEN_REQUEST_BUDGET_MS alone allows
// 420s before the parse/postTask/item-write that follow. So any generation past
// 300s expired its own lease while still running, and the queue's second attempt
// (retryConfig.maxAttempts = 2) could claim it and start a SECOND concurrent
// generation on the same item — the duplicate-generation failure of 2026-08-28,
// reopened from the other side. Matched to the 900s dispatch deadline: past that
// point Cloud Tasks has given up, so no attempt can still be live.
export const GENERATION_LEASE_MS = 15 * 60_000;

// "v2": the item has a v2 job pointer, so this v1 job must not touch it.
export type GenerationClaim = "claimed" | "busy" | "missing" | "v2";

export async function claimGeneration({
  auth,
  id,
  owner,
}: {
  auth: AuthArg;
  id: string;
  owner: string;
}): Promise<GenerationClaim> {
  const itemRef = db().doc(`users/${auth.uid}/items/${id}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists) return "missing" as GenerationClaim;
    const data = snap.data() || {};
    if (data.generation) return "v2" as GenerationClaim;
    const holder = data.generationLeaseOwner;
    const expires = Number(data.generationLeaseExpires) || 0;
    if (holder && holder !== owner && expires > Date.now()) {
      return "busy" as GenerationClaim;
    }
    tx.update(itemRef, {
      generationLeaseOwner: owner,
      generationLeaseExpires: Date.now() + GENERATION_LEASE_MS,
    });
    return "claimed" as GenerationClaim;
  });
}

// Release only what we still hold: if the lease already expired and another
// attempt took it, clearing it here would hand the item to a third.
export async function releaseGeneration({
  auth,
  id,
  owner,
}: {
  auth: AuthArg;
  id: string;
  owner: string;
}): Promise<void> {
  const itemRef = db().doc(`users/${auth.uid}/items/${id}`);
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists) return;
      if ((snap.data() || {}).generationLeaseOwner !== owner) return;
      tx.update(itemRef, {
        generationLeaseOwner: null,
        generationLeaseExpires: null,
      });
    });
  } catch (err) {
    // Best-effort: the lease expires on its own, and failing to release must
    // never turn a successful generation into a failed request.
    console.error("releaseGeneration()", "ERROR", id, err);
  }
}
