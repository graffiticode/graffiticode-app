// Loud warnings when a sponsor account nears or passes its limits.
//
// Sponsored items are debited from the sponsor past any cap (debitSponsor in
// resolvers.ts), so nothing ever stops them — this is the only signal that a
// sponsor's included items or spend cap are being used up. Each stage fires once
// per billing period: email to the operator (ALERT_EMAIL_TO) and the sponsor
// account's owner, plus SMS to the operator.
import Stripe from "stripe";
import { getFirestore } from "../utils/db";
import { sendEmail, operatorEmails } from "./alert-email";
import { sendSms } from "./alert-sms";
import { hashUid } from "./funnel-events";
import {
  STRIPE_API_VERSION,
  effectiveIncludedItems,
  getPlan,
  isHardCappedFor,
  overageRateFor,
} from "./plans-config";

const db = getFirestore();

export type SponsorStage = "included_80" | "included_100" | "cap_80" | "cap_100";
const STAGE_ORDER: SponsorStage[] = ["included_80", "included_100", "cap_80", "cap_100"];

/** The highest stage this usage has reached, or null below 80% of included. */
export function sponsorStage({
  used,
  included,
  capItems,
  metered,
}: {
  used: number;
  included: number;
  capItems: number | null;
  metered: boolean;
}): SponsorStage | null {
  if (!(included > 0)) return null;
  let stage: SponsorStage | null = null;
  if (used >= included * 0.8) stage = "included_80";
  if (used >= included) stage = "included_100";
  // Only a metered account has a cap to approach; uncapped overage has no stage.
  if (metered && capItems !== null && capItems > 0) {
    if (used >= included + capItems * 0.8) stage = "cap_80";
    if (used >= included + capItems) stage = "cap_100";
  }
  return stage;
}

async function ownerEmail(sponsorData: FirebaseFirestore.DocumentData | undefined): Promise<string | null> {
  if (typeof sponsorData?.email === "string" && sponsorData.email) return sponsorData.email;
  const customerId = sponsorData?.stripeCustomerId;
  if (!process.env.STRIPE_SECRET_KEY || !customerId) return null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
    const customer = await stripe.customers.retrieve(customerId);
    if ((customer as Stripe.DeletedCustomer).deleted === true) return null;
    return (customer as Stripe.Customer).email ?? null;
  } catch {
    return null;
  }
}

/**
 * Check the sponsor's usage after a debit and warn on a newly reached stage.
 * Best-effort: never throws into the create path.
 */
export async function maybeAlertSponsorLimit({
  sponsorUid,
  sponsorData,
  sponsorName,
  periodStart,
  now,
}: {
  sponsorUid: string;
  sponsorData: FirebaseFirestore.DocumentData | undefined;
  sponsorName: string | null;
  periodStart: Date;
  now: Date;
}): Promise<void> {
  try {
    const subscription = sponsorData?.subscription || {};
    const plan = subscription.plan;
    const usageDoc = await db.collection("usage").doc(sponsorUid).get();
    const used = Number(usageDoc.data()?.currentMonthTotal) || 0;
    const included = effectiveIncludedItems(plan, subscription, now);
    const metered = !isHardCappedFor(plan, subscription);
    const capItems = typeof subscription.overageLimitItems === "number" ? subscription.overageLimitItems : null;

    const stage = sponsorStage({ used, included, capItems, metered });
    if (!stage) return;

    // Once per stage per period; a later stage still fires after an earlier one.
    const rank = STAGE_ORDER.indexOf(stage);
    const ref = db.collection("sponsor-alerts").doc(`${sponsorUid}__${periodStart.toISOString().slice(0, 10)}`);
    const fired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? Number(snap.data()?.rank) : -1;
      if (prev >= rank) return false;
      tx.set(ref, { rank, stage, used, updated: now.toISOString() }, { merge: true });
      return true;
    });
    if (!fired) return;

    const name = sponsorName ?? "A sponsor";
    const planName = getPlan(plan).displayName;
    const rate = overageRateFor(plan);
    const capUsd = typeof subscription.overageLimitUsd === "number" ? `$${subscription.overageLimitUsd} ` : "";
    const detail: Record<SponsorStage, string> = {
      included_80: `has used ${used} of its ${included} included ${planName} items this period (80%).`,
      included_100: metered
        ? `has used all ${included} included ${planName} items. Sponsored items now bill as overage${rate ? ` at $${rate.toFixed(2)}/item` : ""}.`
        : `has used all ${included} included ${planName} items. It has no pay-as-you-go, so further sponsored items are counted but NOT billed.`,
      cap_80: `is at 80% of its ${capUsd}spend cap (${used - included} of ${capItems} overage items).`,
      cap_100: `has reached its ${capUsd}spend cap. Sponsored items are NOT stopped by the cap and keep billing past it.`,
    };
    const reached = stage.endsWith("_100");
    const summary = `${name} sponsor account ${detail[stage]}`;
    const billingUrl = process.env.NEXT_PUBLIC_URL ? `${process.env.NEXT_PUBLIC_URL}/billing` : null;

    // Stable prefix for a log-based alert. Hashed uid and counts only.
    console.warn(`[sponsor-alert] ${stage} sponsor=${hashUid(sponsorUid)} used=${used} included=${included} cap=${capItems ?? "none"}`);

    const owner = await ownerEmail(sponsorData);
    await Promise.all([
      sendEmail({
        to: [...operatorEmails(), ...(owner ? [owner] : [])],
        subject: `${reached ? "URGENT: sponsor limit reached" : "WARNING: sponsor nearing limit"} — ${name}`,
        text: [
          summary,
          "",
          `Plan: ${planName} · Used this period: ${used} · Included: ${included}` +
            (capItems !== null ? ` · Spend cap: ${capUsd}(${capItems} items)` : ""),
          billingUrl ? `\nReview usage or raise the cap: ${billingUrl}` : "",
          owner ? "" : "\n(No owner email on file for this account — operator only.)",
        ].join("\n"),
      }),
      sendSms(`[Graffiticode] ${reached ? "URGENT" : "WARNING"}: ${summary}`),
    ]);
  } catch (err) {
    console.error("maybeAlertSponsorLimit()", "ERROR", err);
  }
}
