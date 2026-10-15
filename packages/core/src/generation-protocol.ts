// Which generation protocol producers use, and the guards that keep v1 (legacy)
// work from writing around a v2 job (app tier Phase 3.5).
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

// A v1 job may write only to an item that has never had a v2 job, and only
// while it still holds the item's legacy lease.
export const legacyMayComplete = (item: any, leaseOwner: string) =>
  !item?.generation && item?.generationLeaseOwner === leaseOwner;

export class LegacyJobRefused extends ConflictError {
  constructor() {
    super("legacy_job_refused", "A v1 generation job may not write to an item owned by the v2 protocol.");
    this.name = "LegacyJobRefused";
  }
}
