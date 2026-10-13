// Reports item-creation usage to Stripe's Billing Meter for metered tiers.
//
// The subscription carries a metered (usage-based) price; we send one meter
// event per successfully created item and Stripe bills the overage above the
// included bucket in arrears on the next invoice. Contact-sales tiers have no
// meter and are skipped. Best-effort: never throws into the create path.
import Stripe from 'stripe';
import { STRIPE_API_VERSION, getPlan, grantCoversItem, payAsYouGoEnabled, type SubscriptionState } from './plans-config';

let stripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (stripe) return stripe;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  return stripe;
}

export async function reportItemUsage({
  subscription,
  stripeCustomerId,
  identifier,
  periodItemCount,
}: {
  /** The cached `users/{uid}.subscription` map — plan AND enrollment state. */
  subscription: SubscriptionState | undefined | null;
  stripeCustomerId: string | undefined | null;
  /** Idempotency key (Stripe dedupes within a 24h window). Use itemId__taskId. */
  identifier?: string;
  /** This item's position in the period's count, for grant-covered items. */
  periodItemCount?: number;
}): Promise<void> {
  try {
    const plan = subscription?.plan;
    const planConfig = getPlan(plan);
    const eventName = planConfig.stripe.meterEventName;
    if (!eventName || !stripeCustomerId) return;

    // A hard-capped tier only meters once it has enrolled in pay-as-you-go.
    // The stripeCustomerId check above is NOT sufficient on its own: a Bronze
    // user who opens Checkout and abandons it still gets a customer id written,
    // and would then meter every item against a customer with no metered
    // subscription. Enrollment is the thing that makes billing legitimate, so
    // it is checked here — the single choke point every create funnels through
    // — rather than at the call site where a future caller could miss it.
    if (planConfig.hardCap && !payAsYouGoEnabled(subscription)) return;
    // Included by a per-account grant that Stripe's graduated tier can't see.
    if (periodItemCount != null && grantCoversItem(plan, subscription, periodItemCount)) return;
    const client = getStripe();
    if (!client) return;

    // A test-mode key cannot see a live customer, so every meter event below
    // would 404 into the catch and vanish. That is exactly how a month of items
    // got counted in prod Firestore and never reported to Stripe. It is not a
    // transient failure and retrying will not fix it, so say so once, loudly,
    // instead of letting it read as ordinary best-effort noise.
    if (process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
      console.error(
        'reportItemUsage()', 'KEY_MODE_MISMATCH',
        'test-mode STRIPE_SECRET_KEY cannot meter live customer',
        stripeCustomerId, 'item', identifier,
      );
      return;
    }

    await client.billing.meterEvents.create({
      event_name: eventName,
      payload: { stripe_customer_id: stripeCustomerId, value: '1' },
      ...(identifier ? { identifier } : {}),
    });
  } catch (err) {
    console.error('reportItemUsage()', 'ERROR', err);
  }
}
