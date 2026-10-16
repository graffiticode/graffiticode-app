// Idempotency keys for the REST API's POSTs that start a generation (app tier
// Phase 3.5 design, used from Phase 4). A client retrying with the same key
// gets the original response, never a second item or job.
//
// idempotency-keys/{sha256(scope:key)} moves claimed -> bound -> completed:
//   claimed    a request is working on it (claimToken names which one)
//   bound      the reservation transaction recorded what it made, {itemId,
//              generationId}, in the same commit as the job
//   completed  the response was stored and is replayed
// A key bound but not completed (the request died after reserving) is
// answered by rebuilding the response from what it made; nothing is reserved
// or dispatched again. A claim that never bound is abandoned after 30s and can
// be taken over. Keys expire after 24 hours (expiresAt; a Firestore TTL policy
// deletes them, and an expired key reads as absent).
import { createHash, randomUUID } from "crypto";
import type admin from "firebase-admin";
import { db } from "./db.js";
import { ConflictError } from "./errors.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const CLAIM_TAKEOVER_MS = 30_000;

export type IdempotencyOp = { itemId: string; generationId: string };
export type StoredResponse = { status: number; headers: Record<string, string>; body: unknown };
export type IdempotencyClaim = { ref: admin.firestore.DocumentReference; claimToken: string };

export type ClaimResult =
  | ({ kind: "claimed" } & IdempotencyClaim)
  | { kind: "replay"; response: StoredResponse }
  | { kind: "bound"; op: IdempotencyOp; claim: IdempotencyClaim }
  | { kind: "in_flight" }
  | { kind: "mismatch" };

export const idempotencyRef = (scope: string, key: string) =>
  db().doc(`idempotency-keys/${createHash("sha256").update(`${scope}:${key}`).digest("hex")}`);

export async function claimIdempotencyKey({ scope, key, fingerprint, now = Date.now() }: {
  scope: string; key: string; fingerprint: string; now?: number;
}): Promise<ClaimResult> {
  const ref = idempotencyRef(scope, key);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    const live = d && (d.expiresAt?.toMillis?.() ?? Number(d.expiresAt)) > now;
    const claim = () => {
      const claimToken = randomUUID();
      tx.set(ref, { fingerprint, state: "claimed", claimToken, claimedAt: now, expiresAt: new Date(now + IDEMPOTENCY_TTL_MS) });
      return { kind: "claimed", ref, claimToken } as ClaimResult;
    };
    if (!live) return claim();
    if (d.fingerprint !== fingerprint) return { kind: "mismatch" } as ClaimResult;
    if (d.state === "completed") return { kind: "replay", response: d.response } as ClaimResult;
    if (d.state === "bound") return { kind: "bound", op: d.op, claim: { ref, claimToken: d.claimToken } } as ClaimResult;
    if (now - Number(d.claimedAt) < CLAIM_TAKEOVER_MS) return { kind: "in_flight" } as ClaimResult;
    // Abandoned before it bound anything: nothing was made, so redoing it is safe.
    const claimToken = randomUUID();
    tx.update(ref, { claimToken, claimedAt: now });
    return { kind: "claimed", ref, claimToken } as ClaimResult;
  });
}

// Inside the reservation transaction: read first (reads before writes)...
export async function readClaim(tx: admin.firestore.Transaction, claim: IdempotencyClaim | null | undefined) {
  return claim ? (await tx.get(claim.ref)).data() : null;
}

// ...then bind, in the same commit as the job. A claim taken over meanwhile
// means another request owns the key now: this one must not reserve.
export function bindClaim(tx: admin.firestore.Transaction, claim: IdempotencyClaim | null | undefined, current: any, op: IdempotencyOp) {
  if (!claim) return;
  if (current?.state !== "claimed" || current?.claimToken !== claim.claimToken) {
    throw new ConflictError("idempotency_key_in_use", "Another request with this Idempotency-Key is in progress.");
  }
  tx.update(claim.ref, { state: "bound", op });
}

export async function completeIdempotencyKey(claim: IdempotencyClaim, response: StoredResponse) {
  await db().runTransaction(async (tx) => {
    const d = (await tx.get(claim.ref)).data();
    if (d?.state !== "bound" || d.claimToken !== claim.claimToken) return;
    tx.update(claim.ref, { state: "completed", response });
  });
}

// The request failed before binding (a validation, quota or auth refusal):
// nothing was made, so let the client retry with the same key.
export async function releaseIdempotencyKey(claim: IdempotencyClaim) {
  await db().runTransaction(async (tx) => {
    const d = (await tx.get(claim.ref)).data();
    if (d?.state === "claimed" && d.claimToken === claim.claimToken) tx.delete(claim.ref);
  });
}
