// The only recovery mechanism for generation protocol v2 (app tier Phase 3.5),
// run every minute by Cloud Scheduler through the console's
// /api/internal/sweep-generations. It works from Firestore alone: due jobs get
// their next dispatch slot (or fail, past their deadline or out of slots), and
// due effects are carried out — pending ones whose backoff has passed, and
// in-flight ones whose processor's lease expired.
//
// Both queries are single-field ranges on a due time; terminal jobs and
// effects carry a due time of NEVER, so they drop out without a composite index.
import { db } from "./db.js";
import { redispatchJob } from "./generation-jobs.js";
import { processEffect } from "./effects.js";

export type SweepResult = { jobs: Record<string, number>; effects: Record<string, number>; truncated: boolean };

export async function sweep({ now = Date.now(), limit = 100, budgetMs = 45_000 }: { now?: number; limit?: number; budgetMs?: number } = {}): Promise<SweepResult> {
  const until = Date.now() + budgetMs;
  const result: SweepResult = { jobs: {}, effects: {}, truncated: false };
  const count = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

  const jobs = await db().collection("generation-jobs")
    .where("dispatch.nextDispatchAt", "<=", now).orderBy("dispatch.nextDispatchAt").limit(limit).get();
  for (const doc of jobs.docs) {
    if (Date.now() > until) { result.truncated = true; break; }
    try {
      count(result.jobs, await redispatchJob(doc.id, now));
    } catch (err) {
      console.error("[sweep] job", doc.id, err);
      count(result.jobs, "error");
    }
  }

  const effects = await db().collection("effects")
    .where("nextAttemptAt", "<=", now).orderBy("nextAttemptAt").limit(limit).get();
  for (const doc of effects.docs) {
    if (Date.now() > until) { result.truncated = true; break; }
    try {
      count(result.effects, (await processEffect(doc.id, { now })) ?? "not-due");
    } catch (err) {
      console.error("[sweep] effect", doc.id, err);
      count(result.effects, "error");
    }
  }
  if (jobs.size === limit || effects.size === limit) result.truncated = true;
  return result;
}
