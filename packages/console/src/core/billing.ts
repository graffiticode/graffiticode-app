// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import admin from "firebase-admin";
import { currentEnv } from "../lib/token-usage-service";
import { reportItemUsage } from "../lib/item-metering";
import { maybeAlertSponsorLimit } from "../lib/sponsor-alerts";
import { emitEvent, actor } from "../lib/funnel-events";
import { recordTrialItem } from "../lib/free-plan-quota";
import { isLanguageSponsored, languageSponsor, languageSponsorUid } from "../lib/languages";
import { db } from "./db";
import type { AuthArg } from "./types";
import type { VersionSource } from "./versions";

export function periodStartFor(subscription: { currentPeriodStart?: string | number } | undefined, now: Date): Date {
  return subscription?.currentPeriodStart
    ? new Date(subscription.currentPeriodStart)
    : new Date(now.getFullYear(), now.getMonth(), 1);
}

// Increment an account's monthly item counter, resetting at its billing-period
// boundary (mirrors logCompile). currentMonthTotal is the item count for the period.
// Returns the new count (from the snapshot, so approximate under concurrency).
export async function incrementItemCounter(
  uid: string,
  periodStart: Date,
  now: Date,
  usageDoc?: admin.firestore.DocumentSnapshot,
): Promise<number> {
  const ref = db().collection("usage").doc(uid);
  const doc = usageDoc ?? await ref.get();
  const lastReset = doc.exists && doc.data()?.lastReset ? new Date(doc.data()?.lastReset) : null;
  if (lastReset && lastReset >= periodStart) {
    await ref.update({
      currentMonthTotal: admin.firestore.FieldValue.increment(1),
      lastUpdated: now.toISOString(),
    });
    return (doc.data()?.currentMonthTotal || 0) + 1;
  }
  await ref.set({
    currentMonthTotal: 1,
    lastReset: periodStart.toISOString(),
    lastUpdated: now.toISOString(),
  });
  return 1;
}

/**
 * Charge a sponsored item to the sponsor: a units: 1 usage row under the
 * sponsor's uid, its monthly counter, and a meter event on its Stripe customer.
 *
 * Deliberately NOT gated on the sponsor's cap — sponsorship is uncapped, so
 * items past the allowance are metered as the sponsor's overage. The sponsor's
 * OWN creates still see this volume in checkItemCreateAllowed. A hard-capped
 * sponsor (unenrolled Bronze) is counted but never metered: reportItemUsage
 * refuses it, so a sponsor needs a metered plan to actually be invoiced.
 */
export async function debitSponsor({
  sponsorUid,
  creatorUid,
  itemId,
  taskId,
  lang,
  client,
  env,
  now,
}: {
  sponsorUid: string;
  creatorUid: string;
  itemId: string;
  taskId: string;
  lang?: string;
  client?: string;
  env: string;
  now: Date;
}) {
  const sponsorDoc = await db().collection("users").doc(sponsorUid).get();
  const sponsorData = sponsorDoc.exists ? sponsorDoc.data() : {};
  const subscription = sponsorData?.subscription || {};
  await db().collection("usage").add({
    userId: sponsorUid,
    itemId,
    taskId,
    units: 1,
    // Whose item this paid for. Firestore-only; never logged or shown.
    sponsoredFor: creatorUid,
    createdAt: now,
    timestamp: now.toISOString(),
    lang: lang ?? null,
    client: client ?? "console",
    env,
    type: "item_created",
  });
  const periodStart = periodStartFor(subscription, now);
  const periodItemCount = await incrementItemCounter(sponsorUid, periodStart, now);
  await reportItemUsage({
    subscription,
    stripeCustomerId: sponsorData?.stripeCustomerId,
    identifier: `${itemId}__${taskId}`,
    periodItemCount,
  });
  // Nothing stops a sponsor at its limits, so warn loudly as it nears or passes them.
  await maybeAlertSponsorLimit({
    sponsorUid,
    sponsorData,
    sponsorName: languageSponsor(lang),
    periodStart,
    now,
  });
}

/**
 * Count a billable item exactly once — the first time a distinct item gains a
 * valid taskId (its first successful compile). Called from createItem (sync /
 * template creates) and from updateItem's no-taskId -> first-taskId transition
 * (async console/MCP creates whose artifact is filled in by the worker).
 *
 * Excludes revisions (taskId -> different taskId), share/claim copies, and
 * anonymous free-plan sessions (metered separately). Idempotent via a `billed`
 * flag on the item doc set inside a transaction, so overlapping paths and
 * retries never double-count.
 *
 * Effects: writes a `type: 'item_created'` usage record (units: 1), increments
 * the monthly counter (mirroring logCompile's period reset), and reports one
 * Stripe meter event for paid tiers. Best-effort: never throws into the caller.
 *
 * Local runs (tsx scripts) record the usage row at units: 0 and stop there —
 * they write to prod Firestore but cannot reach the live Stripe customer, so
 * counting them would consume a real allowance nothing could ever invoice.
 */
export async function recordBillableItem({
  auth,
  itemId,
  taskId,
  lang,
  client,
  source,
}: {
  auth: AuthArg;
  itemId: string;
  taskId: string;
  lang?: string;
  client?: string;
  source?: VersionSource;
}) {
  try {
    if (!itemId || !taskId) return;
    // Share/claim copies re-post existing content; they are not authored items.
    if (source === "claim" || source === "share") return;

    const itemRef = db().doc(`users/${auth.uid}/items/${itemId}`);

    // Idempotency: count each distinct item once. Set `billed` on the item doc
    // in a transaction; bail if it's already billed or is a copy.
    const shouldCount = await db().runTransaction(async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists) return false;
      const d = snap.data() || {};
      if (d.billed) return false;
      if (d.sharedFrom || d.claimedFrom) return false;
      tx.update(itemRef, { billed: true, billedTaskId: taskId, billedAt: Date.now() });
      return true;
    });
    if (!shouldCount) return;

    const now = new Date();
    const env = currentEnv();

    // A tsx script (corpus generation, evals, backfills) writes to PROD
    // Firestore but carries .env.local's TEST Stripe key, so its meter events
    // can never reach the live customer — reportItemUsage() just swallows the
    // error. That divergence went unnoticed for a month: 906 items counted
    // against a live account's allowance that Stripe was never told about.
    // Local items stay in `usage` for cost telemetry (training runs are real
    // spend) but carry units: 0 — the same "recorded, never billed" shape
    // logCompile and the token meter already use, which is what keeps them out
    // of checkItemCreateAllowed's self-heal sum.
    //
    // A sponsored language is the other reason an item is real usage but not
    // billable: we carry its cost deliberately. Keyed on the LANGUAGE, which the
    // server decides (the scope gate re-routes a mis-labelled request), never on
    // `client`, which is caller-supplied and would therefore be a bypass.
    const sponsored = isLanguageSponsored(lang);
    const billable = env !== "local" && !sponsored;
    // The account that pays for a sponsored item, or null when we absorb it.
    const sponsorUid = sponsored && env !== "local" ? languageSponsorUid(lang) : null;

    // Audit record for the billable item.
    //
    // `nonBillableReason` separates the two kinds of units: 0 row, because they
    // are shown very differently — sponsored usage is the customer's and belongs
    // on their usage page, a local script run is ours and must never appear
    // there. Absent on rows written before this existed, which reads correctly
    // as "billable".
    await db().collection("usage").add({
      userId: auth.uid,
      itemId,
      taskId,
      units: billable ? 1 : 0,
      // Order matters: a local run in a sponsored language is BOTH, and "local"
      // has to win. Labelling it "sponsored" would put a training run on the
      // customer's usage page as though it were their own free usage.
      ...(billable ? {} : {
        nonBillableReason: env === "local" ? "local-script" : "sponsored",
      }),
      // Namespaced so a client/partner sponsor (`client:acme`) can be added
      // later without a migration, and so a cap can be derived retroactively.
      // Only on rows that are actually the customer's sponsored usage.
      ...(sponsored && env !== "local"
        ? { sponsorId: `lang:${String(lang).replace(/^L/i, "")}` }
        : {}),
      createdAt: now,
      timestamp: now.toISOString(),
      lang: lang ?? null,
      client: client ?? "console",
      // Same marker the ai_generation records carry. Without it the item count
      // could not be scoped to the same environment as the spend that produced
      // it, and cost-per-item divided prod-only generations by all-env items.
      env,
      type: "item_created",
    });

    // Increment the monthly counter, resetting at the billing-period boundary
    // (mirrors logCompile). currentMonthTotal is the item count for the period.
    const userDoc = await db().collection("users").doc(auth.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const subscription = userData?.subscription || {};
    const usageDoc = await db().collection("usage").doc(auth.uid).get();
    // The usage doc is created by the first billable item and never deleted, so
    // its absence is the account's first-ever item (not merely first this period).
    const firstForAccount = !usageDoc.exists;
    let periodItemCount: number | undefined;
    if (billable) {
      periodItemCount = await incrementItemCounter(auth.uid, periodStartFor(subscription, now), now, usageDoc);
    }

    emitEvent("item_created", {
      ...actor(auth),
      lang,
      app: client ?? "console",
      first_for_account: firstForAccount || undefined,
      source,
    });

    // A local run stops here. It is not the customer's usage at all: no
    // allowance consumed, no meter event, no trial pace. Its stdout never
    // reaches Cloud Logging, so the emitEvent above cannot reach the funnel
    // digest either.
    if (env === "local") return;

    // A sponsored item is free to its creator but not to its sponsor. Before the
    // trial return below, so a sponsored trial item is charged to the sponsor too.
    if (sponsorUid) {
      await debitSponsor({ sponsorUid, creatorUid: auth.uid, itemId, taskId, lang, client, env, now });
    }

    // Anonymous free-plan (MCP trial) items are COUNTED — the writes above are
    // what checkItemCreateAllowed reads, so the trial account's own plan
    // allowance becomes the monthly budget — but never INVOICED. Stop here,
    // before the meter report, and record the day's tally for the derived
    // daily pace. A sponsored trial item still counts toward pace: it is real
    // trial activity, it just isn't paid for by anyone.
    if (auth.freePlan) {
      await recordTrialItem(now);
      return;
    }

    // A sponsored item IS the customer's usage — it reached the funnel above and
    // it shows on their usage page — but nobody is invoiced for it, so it must
    // not reach the meter.
    if (!billable) return;

    // Report to the Stripe metered price (metered tiers only — paid, or Bronze
    // enrolled in pay-as-you-go). Best-effort.
    await reportItemUsage({
      subscription,
      stripeCustomerId: userData?.stripeCustomerId,
      identifier: `${itemId}__${taskId}`,
      periodItemCount,
    });
  } catch (error) {
    console.error("recordBillableItem()", "ERROR", itemId, taskId, error);
  }
}
// import { buildDynamicSchema } from "./schemas";

// Re-exported so existing importers of these symbols keep working after the
// move to lib/task-api.ts. New code should import from there directly. Stored
// user credentials (the old Credentials card) are retired: parse no longer
// reads them, and external APIs are reached only through a connection.
