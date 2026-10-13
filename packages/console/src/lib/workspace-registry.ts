// Durable record of when each workspace FIRST attempted to create an item.
//
// This exists for exactly one number: the agent OMTM, "Weekly New Creating
// Workspaces" (marketing/graffiticode-funnel-and-omtm-contract.md §4). That
// metric is not computable from logs — Cloud Logging retains ~30 days, so past
// that every returning workspace re-reads as new, and the funnel-daily rollup
// stores COUNTS, not sets, so it can say how many workspaces were active but
// never which. One create-if-absent write per workspace fixes both.
//
// "Workspace" here is the same thing sessionNamespace already means elsewhere in
// this repo: the anonymous unit that owns items and survives reconnects. This is
// a new TOP-LEVEL `workspaces` collection; nothing else in the codebase uses
// that name.
//
// No backfill, by decision (2026-08-07): the clock starts at first deploy, and
// the first week counts pre-existing workspaces as new. Reports must label that
// week and drop it from trend lines.

import { getFirestore } from "../utils/db";
import { isoWeek, type FirstOutcome, type WorkspaceAuth } from "./workspace-week";

export {
  OMTM_CLOCK_START,
  isoWeek,
  isoWeekBounds,
  type FirstOutcome,
  type WorkspaceAuth,
} from "./workspace-week";

export interface WorkspaceRow {
  firstCreateAttemptAt: FirebaseFirestore.Timestamp;
  firstCreateAttemptWeek: string;
  auth: WorkspaceAuth;
  clientKind: string;
  geoCountry?: string;
  lang?: string;
  firstOutcome: FirstOutcome;
  internal: boolean;
  schema: number;
}

const COLLECTION = "workspaces";
const SCHEMA = 1;

/** Client-asserted, so cap and scrub it before it becomes a report row. */
function sanitizeClientKind(v: unknown): string {
  if (typeof v !== "string") return "unknown";
  const t = v.trim().slice(0, 64);
  if (!t || !/^[A-Za-z0-9._/ -]+$/.test(t)) return "unknown";
  return t;
}

function sanitizeGeo(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Z]{2}$/.test(v) ? v : undefined;
}

/**
 * Keys this instance has already registered. `create()` on an existing doc still
 * costs a full round trip, and a busy workspace creates many items, so a warm
 * instance skips the call after the first. Bounded because Cloud Run instances
 * are long-lived; correctness never depends on it.
 */
const seen = new Set<string>();
const SEEN_MAX = 5000;

/**
 * Record a workspace's first-ever create attempt. Returns true iff this call is
 * the one that created the row.
 *
 * Best-effort by contract, like emitEvent() and maybeAlertBudget(): every
 * failure is swallowed. This runs in the create path and must never be the
 * reason an item fails to be created.
 */
export async function registerFirstCreateAttempt(input: {
  key: string;
  auth: WorkspaceAuth;
  lang?: string;
  clientKind?: string;
  geoCountry?: string;
  internal: boolean;
}): Promise<boolean> {
  const { key } = input;
  if (!key) return false;
  if (seen.has(key)) return false;

  try {
    const now = new Date();
    const row: Record<string, unknown> = {
      // The admin SDK stores a JS Date as a Timestamp; reads give one back.
      firstCreateAttemptAt: now,
      firstCreateAttemptWeek: isoWeek(now),
      auth: input.auth,
      clientKind: sanitizeClientKind(input.clientKind),
      firstOutcome: "pending" as FirstOutcome,
      // ALWAYS written, even when false: an absent field is invisible to
      // `where("internal","==",false)`, which would silently drop rows.
      internal: input.internal,
      schema: SCHEMA,
    };
    const geo = sanitizeGeo(input.geoCountry);
    if (geo) row.geoCountry = geo;
    if (input.lang) row.lang = input.lang;

    await getFirestore().collection(COLLECTION).doc(key).create(row);
    if (seen.size < SEEN_MAX) seen.add(key);
    return true;
  } catch (err: unknown) {
    // ALREADY_EXISTS (gRPC code 6) is the expected path for every returning
    // workspace, not an error. Matched on the code, never the message.
    if ((err as { code?: number })?.code === 6) {
      if (seen.size < SEEN_MAX) seen.add(key);
      return false;
    }
    console.error("[workspace-registry] register failed", err);
    return false;
  }
}

/**
 * Move a workspace's first attempt from `pending` to its terminal outcome.
 *
 * Guarded on `pending` inside a transaction, which is what makes this safe to
 * call from every generation: only the first attempt is still pending, so later
 * ones no-op. It can never touch firstCreateAttemptAt.
 */
export async function resolveFirstOutcome(
  key: string | undefined,
  outcome: Exclude<FirstOutcome, "pending">,
): Promise<void> {
  if (!key) return;
  try {
    const ref = getFirestore().collection(COLLECTION).doc(key);
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if (snap.get("firstOutcome") !== "pending") return;
      tx.update(ref, { firstOutcome: outcome });
    });
  } catch (err) {
    console.error("[workspace-registry] resolve failed", err);
  }
}
