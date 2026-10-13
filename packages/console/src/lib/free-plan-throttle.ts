import { getFirestore } from "../utils/db";
import { FreePlanError, buildSignupUrl } from "./free-plan-context";

const db = getFirestore();

// Runaway-loop guard for anonymous free-plan traffic.
//
// This is NOT the trial's budget — that is denominated in items and lives in
// free-plan-quota.ts + the trial account's own plan allowance. This file exists
// only to stop an agent stuck in a retry loop from firing generations as fast as
// the network allows. It is deliberately session-keyed and therefore
// UUID-bypassable; that's acceptable for a loop guard, and would not be for a
// budget, which is why the budget no longer lives here.

const DEFAULT_BURST_WINDOW_SECONDS = 60;

/**
 * Per-surface ceilings. Separate buckets, because these surfaces have wildly
 * different legitimate rates and one shared counter would have to be sized for
 * the loudest of them — which would stop bounding the expensive one.
 *
 * GENERATION is tight: an LLM call is the only genuinely costly thing here, and
 * nothing legitimate fires five of them a minute.
 *
 * API is deliberately loose. get_item long-polls a generating item every 2.5s
 * for up to 45s (see the MCP server's GET_ITEM_POLL_INTERVAL_MS), i.e. ~18
 * requests from ONE tool call, and a generation runs 60-110s so an agent may
 * make several such calls back to back. A ceiling anywhere near the generation
 * one would break the first item a user ever creates. This is a hammering
 * guard, not a quota — the quota is items.
 *
 * COMPILE sits between them: cheap per call, but it reaches a compiler service.
 */
export const BURST = {
  GENERATION: { bucket: "burst", env: "FREE_PLAN_BURST_LIMIT", fallback: 5 },
  API: { bucket: "burst-api", env: "FREE_PLAN_API_BURST_LIMIT", fallback: 120 },
  COMPILE: { bucket: "burst-compile", env: "FREE_PLAN_COMPILE_BURST_LIMIT", fallback: 30 },
} as const;

export type BurstSurface = typeof BURST[keyof typeof BURST];

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildBurstError(
  retryAfterSeconds: number,
  limit: number,
  windowSeconds: number,
): FreePlanError {
  return new FreePlanError("free_plan_rate_limit_exceeded", 429, {
    error: "free_plan_rate_limit_exceeded",
    message:
      `The Graffiticode free plan allows ${limit} requests every ${windowSeconds} seconds. ` +
      `Please retry in ${retryAfterSeconds}s, or create a free account at graffiticode.org/signup ` +
      `to remove this limit.`,
    retry_after_seconds: retryAfterSeconds,
    signup_url: buildSignupUrl("rate_limit"),
  });
}

// Sliding-window limiter: a Firestore doc holding the recent hit timestamps
// (epoch ms) for a key, pruned to the window on every call. Swap for a Redis
// sliding window if per-key write volume ever warrants it.
export async function checkBurstLimit(
  key: string,
  surface: BurstSurface = BURST.GENERATION,
  now = new Date(),
): Promise<void> {
  const limit = intEnv(surface.env, surface.fallback);
  const windowSeconds = intEnv("FREE_PLAN_BURST_WINDOW_SECONDS", DEFAULT_BURST_WINDOW_SECONDS);
  const windowMs = windowSeconds * 1000;
  const nowMs = now.getTime();
  const cutoff = nowMs - windowMs;

  const ref = db
    .collection("free-plan-state")
    .doc("sessions")
    .collection(key)
    .doc(surface.bucket);

  const retryAfterSeconds = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const raw = snap.exists ? snap.data()?.hits : undefined;
    // Keep only hits still inside the window; this prunes the array each call so
    // it stays bounded by `limit` rather than growing unbounded.
    const recent = (Array.isArray(raw) ? raw : [])
      .map(Number)
      .filter((t) => Number.isFinite(t) && t > cutoff);

    if (recent.length >= limit) {
      // Over the limit: persist the pruned window but do NOT record this hit.
      // The caller may retry once the oldest in-window hit ages out a slot.
      const oldest = Math.min(...recent);
      tx.set(ref, { hits: recent, updated: now.toISOString() }, { merge: true });
      return Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    }

    recent.push(nowMs);
    tx.set(ref, { hits: recent, updated: now.toISOString() }, { merge: true });
    return 0;
  });

  if (retryAfterSeconds > 0) {
    throw buildBurstError(retryAfterSeconds, limit, windowSeconds);
  }
}
