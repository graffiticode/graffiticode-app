import { getFirestore } from "../utils/db";
import { effectiveIncludedItems, isHardCappedFor, overageRateFor, getPlan, DEFAULT_PLAN } from "./plans-config";
import { repairSubscriptionFromStripe, subscriptionCacheIsEmpty } from "./subscription-cache";

export interface ItemCreateAllowedResult {
  allowed: boolean;
  reason?: string;
  /**
   * Which limit denied the create, when one did. Lets the caller report the wall
   * without re-deriving the plan or pattern-matching on `reason`.
   */
  wall?: "plan_item_limit" | "overage_cap";
  /** Items created this billing period. */
  currentUsage?: number;
  /** Included + (customer overage limit, if any). Infinity when uncapped. */
  totalAvailable?: number;
  /**
   * The plan's included bucket alone, before any overage allowance. Always
   * finite, unlike totalAvailable — callers deriving a rate from the budget
   * (the trial daily pace) must use this, or a plan with no overage cap set
   * yields an infinite rate and silently stops pacing.
   */
  includedItems?: number;
  /**
   * End of the current billing period, when the subscription declares one.
   * Returned so callers pacing usage across the period (the trial daily cap)
   * don't have to re-read the user doc.
   */
  periodEnd?: Date;
  /**
   * The account is on a hard-capped tier that OFFERS pay-as-you-go but hasn't
   * enrolled — i.e. adding a card would clear this wall. Lets a caller render
   * "add a payment method to continue" instead of "upgrade" without re-deriving
   * the plan, the same way `wall` saves it pattern-matching on `reason`.
   */
  payAsYouGoAvailable?: boolean;
  /** Per-item overage rate for the plan, so callers can quote it in the wall copy. */
  overageRatePerItem?: number | null;
}

export interface ItemCreateAllowedOptions {
  /**
   * Deny on infra error instead of the default fail-open. Right for the shared
   * anonymous trial account, where there is no tenant to bill and no user to
   * notify — a Firestore blip must not become an open bar.
   */
  failClosed?: boolean;
  /**
   * Skip reconciling the stored counter against the period's usage records.
   * That query reads every record in the period, so on the trial account (which
   * runs at its full allowance every month, by design) it grows without bound
   * and runs on every create. Trust the counter there; reconcile out-of-band.
   */
  skipSelfHeal?: boolean;
  /**
   * Skip repairing an empty `users/{uid}.subscription` cache from Stripe.
   *
   * The repair costs one Stripe call on a cache miss for a Stripe-linked
   * account, then never again. Set this for the shared anonymous trial account:
   * it has no Stripe customer, so the repair is a guaranteed no-op, and for a
   * path that runs on every anonymous create the check is not worth carrying.
   */
  skipSubscriptionRepair?: boolean;
}

/**
 * Gate item CREATION against the account's item budget for the period.
 *
 * - Hard-capped tiers (Bronze with no card on file): blocked once
 *   `currentUsage >= includedItems`. Clearing it means enrolling in
 *   pay-as-you-go, not necessarily upgrading.
 * - Metered tiers (paid, or Bronze enrolled in pay-as-you-go): allowed up to
 *   `includedItems + overageLimitItems`; when the customer set no overage cap
 *   (`overageLimitItems` null/absent), unlimited — overage bills in arrears via
 *   the Stripe meter.
 *
 * currentUsage is the item count for the period. It is derived from the stored
 * counter, self-healed against the sum of `units` on usage records since the
 * period start (billable item records carry units: 1; compiles/generations
 * carry units: 0, so the sum equals the item count).
 */
export async function checkItemCreateAllowed(
  uid: string,
  options: ItemCreateAllowedOptions = {},
): Promise<ItemCreateAllowedResult> {
  try {
    const db = getFirestore();

    // Current usage from the stored counter.
    const usageDoc = await db.collection('usage').doc(uid).get();
    let currentUsage = usageDoc.exists ? (usageDoc.data()?.currentMonthTotal || 0) : 0;

    // Subscription → plan, included allowance, optional customer overage cap.
    const userDoc = await db.doc(`users/${uid}`).get();
    const userData = userDoc.data() || {};
    let subscription = userData.subscription || {};

    // An empty cache on a Stripe-linked account means "we don't know this
    // account's plan", NOT "this account is free". Treating the two as the same
    // is how a paying customer gets hard-blocked at 25 items while the billing
    // UI — which reads Stripe directly — shows 0 of 500 used. Repair from
    // Stripe once and write it back; subsequent creates are cache-only again.
    // Skipped for free-plan/anonymous callers, which have no Stripe customer.
    if (!options.skipSubscriptionRepair &&
        subscriptionCacheIsEmpty(subscription) &&
        userData.stripeCustomerId) {
      const repaired = await repairSubscriptionFromStripe(uid, userData.stripeCustomerId);
      if (repaired) subscription = { ...subscription, ...repaired };
    }

    const plan = subscription.plan || DEFAULT_PLAN;
    // Preserved allocation from a downgrade keeps the old (larger) bucket for a
    // grace window; it can only raise the allowance, never cap it.
    const now = new Date();
    const includedItems = effectiveIncludedItems(plan, subscription, now);
    const periodEnd = subscription.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd)
      : undefined;

    // Self-heal the stored counter against the actual records for the period.
    if (!options.skipSelfHeal) {
      try {
        const periodStart = subscription.currentPeriodStart
          ? new Date(subscription.currentPeriodStart)
          : new Date(now.getFullYear(), now.getMonth(), 1);
        const usageRecords = await db.collection('usage')
          .where('userId', '==', uid)
          .where('createdAt', '>=', periodStart)
          .get();
        // Count only billable item records. Pre-migration compile/ai_generation
        // records carry non-zero compile-unit `units` and must not be counted as
        // items (new such records write units: 0, but old ones linger in-period).
        let calculatedTotal = 0;
        usageRecords.docs.forEach(doc => {
          const r = doc.data();
          if (r.type === 'item_created') calculatedTotal += r.units || 0;
        });
        if (calculatedTotal !== currentUsage) {
          console.log(`checkItemCreateAllowed: syncing stored (${currentUsage}) → calculated (${calculatedTotal})`);
          currentUsage = calculatedTotal;
          await db.collection('usage').doc(uid).update({ currentMonthTotal: calculatedTotal });
        }
      } catch (err) {
        console.error('checkItemCreateAllowed: error calculating actual usage', err);
      }
    }

    const overageRatePerItem = overageRateFor(plan);

    // Hard-capped: no overage path for THIS account — blocked at the included
    // bucket. For Bronze that state is escapable (enroll in pay-as-you-go);
    // for contact-sales tiers it isn't, so the copy has to differ.
    if (isHardCappedFor(plan, subscription)) {
      const totalAvailable = includedItems;
      const allowed = currentUsage < totalAvailable;
      // A rate exists but we're still capped ⇒ the tier offers pay-as-you-go and
      // this account simply hasn't put a card on file yet.
      const payAsYouGoAvailable = overageRatePerItem != null;
      const rate = overageRatePerItem != null ? `$${overageRatePerItem.toFixed(2)}` : '';
      return {
        allowed,
        reason: allowed
          ? undefined
          : payAsYouGoAvailable
            ? `${getPlan(plan).displayName} includes ${includedItems} items this month — add a payment method to continue at ${rate}/item, or upgrade`
            : 'Item limit reached — upgrade to create more',
        wall: allowed ? undefined : 'plan_item_limit',
        currentUsage,
        totalAvailable,
        includedItems,
        periodEnd,
        payAsYouGoAvailable,
        overageRatePerItem,
      };
    }

    // Metered: allow up to the customer's overage cap, or unlimited when unset.
    const overageLimit = typeof subscription.overageLimitItems === 'number'
      ? subscription.overageLimitItems
      : null;
    const totalAvailable = overageLimit === null ? Infinity : includedItems + overageLimit;
    const allowed = currentUsage < totalAvailable;
    return {
      allowed,
      reason: allowed ? undefined : 'Overage spend limit reached — raise or remove your cap to create more',
      wall: allowed ? undefined : 'overage_cap',
      currentUsage,
      totalAvailable,
      includedItems,
      periodEnd,
      payAsYouGoAvailable: false,
      overageRatePerItem,
    };
  } catch (error) {
    console.error('checkItemCreateAllowed error:', error);
    // Fail open on infra errors so a transient Firestore blip doesn't block a
    // paying tenant. Anonymous trial callers pass failClosed: there is no
    // account to bill and no user to notify, so a blip must not open the bar.
    if (options.failClosed) {
      return { allowed: false, reason: 'Unable to verify item limit' };
    }
    return { allowed: true, reason: 'Unable to verify item limit' };
  }
}
