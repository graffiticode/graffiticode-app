// The generation protocol floor, and the guard that keeps any content change
// from writing around a running v2 job (app tier Phase 3.5). Protocol v1 was
// retired 2026-10-17: every producer reserves v2 jobs; the floor stays as the
// record (and the deploy check) that no image older than R1 may serve.
//
// v1: the producer marks the item "generating" and enqueues the whole job; the
// worker claims a lease on the item and completes through updateItem.
// v2: Firestore owns the job (generation-jobs/{id}), and the item carries a
// pointer to it, `generation: {id, state}`. Until v2 is enabled no item has a
// pointer, so every guard here is inert.
//
// The effective protocol is max(GENERATION_PROTOCOL, the Firestore floor at
// system/generation-protocol.minProtocol). The floor is written once, by
// scripts/enable-generation-v2.ts, and is never lowered: after that, setting
// the env var back to v1 or redeploying with it changes nothing.
import { db } from "./db.js";
import { coreConfig } from "./config.js";
import { ConflictError } from "./errors.js";

export type GenerationState = "reserved" | "running" | "completed" | "failed";
export type GenerationPointer = { id: string; state: GenerationState };

export const PROTOCOL_DOC = "system/generation-protocol";
const FLOOR_TTL_MS = 60_000;

let floor: { value: number; readAt: number } | null = null;

// Forgets the cached floor (tests, and after the enable script writes it).
export function resetProtocolFloorCache() {
  floor = null;
}

export async function protocolFloor(now = Date.now()): Promise<number> {
  if (floor && now - floor.readAt < FLOOR_TTL_MS) return floor.value;
  const snap = await db().doc(PROTOCOL_DOC).get();
  const value = Number(snap.data()?.minProtocol) || 1;
  floor = { value, readAt: now };
  return value;
}

export async function effectiveProtocol(now = Date.now()): Promise<{ configured: number; minProtocol: number; effective: number }> {
  const configured = coreConfig().generationProtocol;
  const minProtocol = await protocolFloor(now);
  return { configured, minProtocol, effective: Math.max(configured, minProtocol) };
}

export const isActiveGeneration = (item: { generation?: GenerationPointer | null } | null | undefined) =>
  item?.generation?.state === "reserved" || item?.generation?.state === "running";

export const GENERATION_IN_PROGRESS_MESSAGE =
  "This item is still generating. Wait for it to finish (get_item / render_item), then try again.";

// Every content-changing path calls this inside the transaction that writes.
export function assertNoActiveGeneration(item: { generation?: GenerationPointer | null } | null | undefined) {
  if (isActiveGeneration(item)) {
    throw new ConflictError("generation_in_progress", GENERATION_IN_PROGRESS_MESSAGE);
  }
}

// Writes the v2 floor (scripts/enable-generation-v2.ts, after the drain check).
// One-way: an existing floor is never lowered, and writing it again is a no-op.
export async function activateGenerationV2({ by, now = Date.now() }: { by: string; now?: number }) {
  const ref = db().doc(PROTOCOL_DOC);
  const result = await db().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (Number(current?.minProtocol) >= 2) return { changed: false, floor: current };
    const floor = { minProtocol: 2, activatedAt: now, activatedBy: by };
    tx.set(ref, floor);
    return { changed: true, floor };
  });
  resetProtocolFloorCache();
  return result;
}

// Staging only: removes the floor, for rehearsing the rollout again. Refused in
// production, and anywhere a v2 job exists: an item with a pointer must never
// meet a v1 producer.
export const PRODUCTION_PROJECT = "graffiticode-app";

export async function removeFloorForStaging({ project }: { project: string }) {
  if (!project || project === PRODUCTION_PROJECT) {
    throw new Error("The generation-protocol floor is never lowered in production.");
  }
  const anyJob = await db().collection("generation-jobs").limit(1).get();
  if (!anyJob.empty) {
    throw new Error("v2 jobs exist in this project; items carry pointers, so the floor stays.");
  }
  await db().doc(PROTOCOL_DOC).delete();
  resetProtocolFloorCache();
}
