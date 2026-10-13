/**
 * Repairs the denormalized `users/{uid}.subscription` cache from Stripe.
 *
 * WHY THIS EXISTS
 *
 * Two paths answer "what plan is this account on", and they read different
 * sources:
 *
 *   - the billing UI (`/api/payments/usage`) queries Stripe LIVE, so it shows
 *     the true plan, included bucket, and billing period;
 *   - the enforcement gate (`checkItemCreateAllowed`) reads this Firestore
 *     cache, because it runs on every item create and must be fast and
 *     available even when Stripe is not.
 *
 * The cache is written by the Stripe webhook. When a delivery is missed — or an
 * upgrade happens outside the app — the two diverge, and the divergence is
 * silent and one-directional: the UI cheerfully reports "0 of 500 items used"
 * while the gate hard-blocks at the free plan's 25. A paying customer sees an
 * empty usage bar and cannot create anything.
 *
 * It compounds, because a missing subscription also costs the gate the billing
 * PERIOD: its usage self-heal falls back to the calendar month, so it recounts
 * items from a period the customer isn't in and confirms the wrong total.
 *
 * So a missing cache is not "this account is on the free plan". It is "we do not
 * know what plan this account is on" — and for a Stripe-linked account those are
 * very different answers. This repairs it on read: one Stripe lookup on a cache
 * miss, written back so subsequent creates are cache-only again.
 *
 * Deliberately mirrors the webhook's mapping (`priceIdToPlan`, the same period
 * helpers) so a repaired cache is byte-comparable with a webhook-written one; if
 * these two ever disagree, the account would flip plan depending on which wrote
 * last. `scripts/reconcile-subscriptions.ts` does the same job in bulk.
 */
import Stripe from "stripe";
import { getFirestore } from "../utils/db";
import { STRIPE_API_VERSION, priceIdToPlan } from "./plans-config";
import { subscriptionPeriodStart, subscriptionPeriodEnd } from "./stripe-helpers";

export interface CachedSubscription {
  plan?: string;
  status?: string;
  stripeSubscriptionId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  overageLimitItems?: number;
  [key: string]: any;
}

let stripeClient: Stripe | null | undefined;
function getStripe(): Stripe | null {
  if (stripeClient !== undefined) return stripeClient;
  stripeClient = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
    : null;
  return stripeClient;
}

/**
 * True when the cache carries no usable plan. An empty object and a missing
 * field are the same thing here — both mean "never written".
 */
export function subscriptionCacheIsEmpty(subscription: any): boolean {
  return !subscription || typeof subscription.plan !== "string" || !subscription.plan;
}

/**
 * Re-derive one user's subscription from Stripe and write it back.
 *
 * Returns the repaired subscription, or null when there is nothing to repair —
 * no Stripe customer, no Stripe client configured, no active/trialing
 * subscription, or the lookup failed. Never throws: this runs inside the item
 * create path, and a Stripe outage must not take item creation down. A null
 * return leaves the caller on its existing default-plan behavior.
 */
export async function repairSubscriptionFromStripe(
  uid: string,
  stripeCustomerId: string | undefined | null,
): Promise<CachedSubscription | null> {
  if (!stripeCustomerId) return null;
  const stripe = getStripe();
  if (!stripe) return null;

  try {
    // Active first, then trialing — same order the billing UI uses, so the two
    // cannot disagree about which subscription is the current one.
    let subs = await stripe.subscriptions.list({
      customer: stripeCustomerId, status: "active", limit: 1,
    });
    if (!subs.data.length) {
      subs = await stripe.subscriptions.list({
        customer: stripeCustomerId, status: "trialing", limit: 1,
      });
    }
    const sub = subs.data[0];
    if (!sub) return null;

    // NEVER fall back to DEFAULT_PLAN here.
    //
    // priceIdToPlan resolves by comparing the subscription's price id against
    // env vars (STRIPE_PRO_PRICE_ID and friends). In an environment where one of
    // those is unset, a real paid price matches nothing — and `|| DEFAULT_PLAN`
    // would then write `demo` over an active Silver subscription, silently
    // downgrading a paying customer and looking authoritative doing it. Observed
    // for real: a local run mapped an active "Graffiticode Silver" $100/mo
    // subscription to demo/50 because STRIPE_PRO_PRICE_ID was missing.
    //
    // An unmappable price means the environment is misconfigured, not that the
    // customer is on the free plan. Those need opposite responses: refuse and
    // shout, rather than write a wrong plan. Leaving the cache empty keeps the
    // account on its existing behavior, which is recoverable; a written
    // downgrade is not.
    const plan = sub.items.data.map((it) => priceIdToPlan(it?.price?.id)).find(Boolean);
    if (!plan) {
      const priceIds = sub.items.data.map((it) => it?.price?.id).filter(Boolean).join(", ");
      console.error(
        `[subscription-cache] REFUSING to repair ${uid}: subscription ${sub.id} is ${sub.status} ` +
        `but none of its price ids [${priceIds}] map to a known plan. This is almost always a ` +
        `missing STRIPE_*_PRICE_ID in this environment — NOT a free-plan account. Fix the env ` +
        `and re-run; writing DEFAULT_PLAN here would downgrade a paying customer.`,
      );
      return null;
    }
    const start = subscriptionPeriodStart(sub);
    const end = subscriptionPeriodEnd(sub);

    const repaired: CachedSubscription = {
      plan,
      status: sub.status,
      stripeSubscriptionId: sub.id,
      currentPeriodStart: start ? new Date(start * 1000).toISOString() : null,
      currentPeriodEnd: end ? new Date(end * 1000).toISOString() : null,
    } as CachedSubscription;

    // Field-path writes so an unrelated field already on `subscription` (an
    // overage cap, a preserved allocation from a downgrade) survives the repair.
    const updates: Record<string, any> = {};
    for (const [k, v] of Object.entries(repaired)) updates[`subscription.${k}`] = v;
    updates["subscription.repairedAt"] = new Date().toISOString();
    await getFirestore().collection("users").doc(uid).update(updates);

    console.log(
      `[subscription-cache] repaired ${uid} from Stripe: plan=${plan} status=${sub.status} ` +
      `period=${repaired.currentPeriodStart}..${repaired.currentPeriodEnd} ` +
      `(webhook delivery was missed — check the Stripe endpoint's delivery log)`,
    );
    return repaired;
  } catch (err: any) {
    // Includes the common misconfiguration: a live customer id under a test key.
    console.error(`[subscription-cache] repair failed for ${uid}:`, err?.message || err);
    return null;
  }
}
