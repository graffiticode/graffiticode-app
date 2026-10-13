import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import {
  STRIPE_API_VERSION,
  stripeBasePriceId,
  stripeMeterPriceId,
  priceIdToPlan,
  includedItemsFor,
  isUpgrade as isPlanUpgrade,
  overageDollarsToItems,
  defaultOverageCapFor,
  DEFAULT_PLAN,
  PLANS,
  type PlanId,
  type BillingInterval,
} from '../../../lib/plans-config';
import { subscriptionPeriodEnd } from '../../../lib/stripe-helpers';
import { emitPlanChanged, hashUid } from '../../../lib/funnel-events';
import { getFirestore } from '../../../utils/db';
import * as admin from 'firebase-admin';
import { requireUser } from '../../../lib/api-auth';

// Initialize Stripe only if secret key is available
let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
}

// A paid subscription carries two line items: the flat base (licensed) price
// and the metered overage price. Identify them by usage_type.
function splitItems(sub: Stripe.Subscription) {
  const metered = sub.items.data.find(it => it.price?.recurring?.usage_type === 'metered');
  const base = sub.items.data.find(it => it.id !== metered?.id) ?? sub.items.data[0];
  return { base, metered };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!stripe) {
    return res.status(500).json({ error: 'Payment system not configured' });
  }

  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;
    const { planId, interval } = req.body;

    if (!planId || !interval) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get user and their Stripe customer
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;
    const currentPlan = userData?.subscription?.plan || 'starter';

    if (!stripeCustomerId) {
      return res.status(400).json({
        error: 'No payment method on file',
        requiresCheckout: true
      });
    }

    // Get customer's default payment method
    const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
    let defaultPaymentMethod = customer.invoice_settings?.default_payment_method;

    // If no default is set, check if there are any payment methods and use one
    if (!defaultPaymentMethod) {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: 'card',
        limit: 1,
      });

      if (paymentMethods.data.length > 0) {
        // Use the first payment method and set it as default
        defaultPaymentMethod = paymentMethods.data[0].id;
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            default_payment_method: defaultPaymentMethod,
          },
        });
      } else {
        return res.status(400).json({
          error: 'No payment method on file',
          requiresCheckout: true
        });
      }
    }

    // Resolve the flat base price and (for paid tiers) the metered overage price.
    const basePriceId = stripeBasePriceId(planId as PlanId, interval as BillingInterval);
    const meterPriceId = stripeMeterPriceId(planId as PlanId);

    if (!basePriceId || !basePriceId.startsWith('price_')) {
      return res.status(400).json({
        error: 'Invalid plan configuration'
      });
    }

    // Build the target line items for an in-place subscription update: swap the
    // base item's price and align the metered item (swap, add, or drop).
    const buildUpdateItems = (sub: Stripe.Subscription): Stripe.SubscriptionUpdateParams.Item[] => {
      const { base, metered } = splitItems(sub);
      const items: Stripe.SubscriptionUpdateParams.Item[] = [{ id: base.id, price: basePriceId }];
      if (meterPriceId) {
        items.push(metered ? { id: metered.id, price: meterPriceId } : { price: meterPriceId });
      } else if (metered) {
        items.push({ id: metered.id, deleted: true });
      }
      return items;
    };

    // Check if user already has an active or trialing subscription
    const [activeSubs, trialingSubs] = await Promise.all([
      stripe.subscriptions.list({ customer: stripeCustomerId, status: 'active', limit: 1 }),
      stripe.subscriptions.list({ customer: stripeCustomerId, status: 'trialing', limit: 1 }),
    ]);
    const existingSubscriptions = {
      data: [...activeSubs.data, ...trialingSubs.data],
    };

    let subscription: Stripe.Subscription;
    let isUpgrade = false;
    let oldAllocation = 0;
    let existingSub: Stripe.Subscription | null = null;

    if (existingSubscriptions.data.length > 0) {
      // User has existing subscription - update it
      existingSub = existingSubscriptions.data[0];
      const { base } = splitItems(existingSub);

      // Determine the current plan and interval from the base line item.
      //
      // NEVER guess the existing plan. priceIdToPlan resolves against the
      // STRIPE_*_PRICE_ID env vars, so a rotated price — or an env whose mode
      // does not match STRIPE_SECRET_KEY — makes a real paid price match
      // nothing. The old `|| 'starter'` fallback turned that into a silent
      // downgrade of a paying customer: a Gold->Silver change would read as a
      // Starter *upgrade* (isStarterUpgrade below), take the upgrade branch,
      // and therefore skip the preservedAllocation write entirely — dropping
      // them from 10,000 items to 500 mid-period after they had paid for
      // Gold, and losing the proration credit too. Silently, with no error.
      //
      // A genuine Starter straggler resolves to 'starter' through
      // priceIdToPlan, so that fallback only ever fired on the broken case.
      //
      // Fall back to the cached plan — the webhook, reconciler and on-read
      // repair now all refuse to write an unmappable one, so it is either
      // correct or absent, never confidently wrong — and refuse outright if
      // neither source can name the plan. This value classifies both the
      // Stripe proration behavior and the customer's item allowance; guessing
      // it wrong costs them money either way.
      const cachedPlan = userData?.subscription?.plan;
      const existingPlan: PlanId | null = (priceIdToPlan(base?.price?.id) as PlanId | null)
        ?? (cachedPlan && cachedPlan in PLANS ? (cachedPlan as PlanId) : null);

      if (!existingPlan) {
        console.error(
          `[quick-subscribe] REFUSING plan change for user ${hashUid(userId)}: subscription ` +
          `${existingSub.id} carries base price ${base?.price?.id}, which maps to no known ` +
          `plan, and the cached plan ${JSON.stringify(cachedPlan)} is not a known plan ` +
          `either. This is a configuration problem (a rotated price, or STRIPE_*_PRICE_ID ` +
          `not matching the mode of STRIPE_SECRET_KEY) — NOT a Starter account. Refusing ` +
          `rather than misclassifying the change as an upgrade, which would drop the ` +
          `customer's preserved allocation. Fix the env and retry.`,
        );
        return res.status(500).json({
          error: 'We could not determine your current plan, so this change was not applied. ' +
            'Your subscription is unchanged. Please try again shortly.',
        });
      }

      const currentInterval: BillingInterval = base?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly';

      // Starter is discontinued; let stragglers upgrade out of it cleanly.
      // Treat Starter -> any paid plan as an upgrade so we don't write a
      // preserved-allocation cap (which would limit them to Starter's units).
      const isStarterUpgrade = existingPlan === 'starter' && planId !== 'starter';

      // Determine if this is an upgrade or downgrade (config-driven tier order).
      isUpgrade =
        isStarterUpgrade ||
        isPlanUpgrade(existingPlan, planId as PlanId) ||
        (currentInterval === 'monthly' && interval === 'annual');

      const updateItems = buildUpdateItems(existingSub);

      if (isUpgrade) {
        // For upgrades: apply immediately with proration credit for unused time.
        if (existingSub.schedule) {
          await stripe.subscriptionSchedules.release(existingSub.schedule as string);
        }

        subscription = await stripe.subscriptions.update(existingSub.id, {
          items: updateItems,
          // Starter migrations switch with no immediate charge (billed at next
          // renewal); other upgrades prorate the difference immediately.
          proration_behavior: isStarterUpgrade ? 'none' : 'create_prorations',
          ...(isStarterUpgrade ? { billing_cycle_anchor: 'unchanged' as const } : {}),
          metadata: { userId, planId, interval },
        });
      } else {
        // For downgrades/lateral moves: apply immediately but preserve the
        // renewal date and the old (larger) item allowance until period end.
        oldAllocation = includedItemsFor(existingPlan);
        if (currentInterval === 'annual') {
          oldAllocation = oldAllocation * 12;
        }

        if (existingSub.schedule) {
          await stripe.subscriptionSchedules.release(existingSub.schedule as string);
        }

        subscription = await stripe.subscriptions.update(existingSub.id, {
          items: updateItems,
          proration_behavior: 'none', // No proration - immediate switch without credits/charges
          metadata: { userId, planId, interval },
          // Preserve the billing cycle anchor to keep the same renewal date
          billing_cycle_anchor: 'unchanged',
        });
      }
    } else {
      // No existing subscription - create one with base + metered line items.
      subscription = await stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [
          { price: basePriceId },
          ...(meterPriceId ? [{ price: meterPriceId }] : []),
        ],
        default_payment_method: defaultPaymentMethod as string,
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
        },
        expand: ['latest_invoice.payment_intent'],
        metadata: {
          userId,
          planId,
          interval,
        },
      });
    }

    // Check if payment needs confirmation (3D Secure, etc) - only for new subscriptions
    if (subscription.latest_invoice) {
      const latestInvoice = subscription.latest_invoice as Stripe.Invoice;
      // NOTE: `invoice.payment_intent` was removed from the Invoice shape in
      // recent API versions; the expand path still returns it at runtime. Cast
      // to keep the 3DS confirmation flow — verify against the new API in test mode.
      const paymentIntent = (latestInvoice as any).payment_intent as Stripe.PaymentIntent;

      if (paymentIntent && paymentIntent.status === 'requires_action') {
        // Payment requires additional authentication
        return res.status(200).json({
          requiresAction: true,
          clientSecret: paymentIntent.client_secret,
          subscriptionId: subscription.id,
        });
      }
    }

    // Update user's subscription info in database
    const updateData: any = {
      'subscription.status': subscription.status,
      'subscription.stripeSubscriptionId': subscription.id,
      'subscription.plan': planId,
      'subscription.interval': interval,
      'subscription.updatedAt': new Date().toISOString(),
    };

    // Re-derive the spend cap against the NEW plan's per-item rate.
    //
    // The cap is stored twice: overageLimitUsd is what the customer chose, and
    // overageLimitItems is what the gate enforces, converted at their plan's
    // rate. A plan change moves the rate, so carrying the item count across
    // silently changes the dollar ceiling they agreed to — Bronze→Silver
    // ($0.40→$0.20) would halve a $20 cap to $10 of headroom while the UI kept
    // saying $20. Honor the dollars; recompute the items.
    const capUsd = userData?.subscription?.overageLimitUsd;
    if (typeof capUsd === 'number' && capUsd > 0) {
      const recomputed = overageDollarsToItems(planId as PlanId, capUsd);
      if (recomputed != null) {
        updateData['subscription.overageLimitItems'] = recomputed;
      }
    }

    // A brand-new subscription starts capped at its base fee unless the account
    // already has a cap. The webhook writes the same default; doing it here too
    // means a webhook that never lands can't leave a new customer uncapped.
    if (!existingSub) {
      const cap = defaultOverageCapFor(planId, userData?.subscription);
      if (cap) {
        updateData['subscription.overageLimitUsd'] = cap.overageLimitUsd;
        updateData['subscription.overageLimitItems'] = cap.overageLimitItems;
      }
    }

    // If this was a downgrade, store the preserved allocation
    if (existingSub && !isUpgrade) {
      updateData['subscription.preservedAllocation'] = oldAllocation;
      const subEnd = subscriptionPeriodEnd(subscription);
      updateData['subscription.preservedUntil'] = subEnd ? new Date(subEnd * 1000).toISOString() : null;
    } else if (currentPlan === 'starter') {
      // If upgrading from starter, clear any preserved fields and canceledAt
      updateData['subscription.preservedAllocation'] = admin.firestore.FieldValue.delete();
      updateData['subscription.preservedUntil'] = admin.firestore.FieldValue.delete();
      updateData['subscription.canceledAt'] = admin.firestore.FieldValue.delete();
    }

    await db.collection('users').doc(userId).update(updateData);

    // The in-app plan write. Stripe's customer.subscription.updated webhook will
    // land on the same value moments later; emitPlanChanged's from !== to guard
    // is what keeps that from reporting the change a second time.
    emitPlanChanged({
      uid: userId,
      from: currentPlan ?? DEFAULT_PLAN,
      to: planId,
      reason: 'subscription_sync',
    });

    return res.status(200).json({
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan: planId,
        interval,
      },
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    return res.status(500).json({
      error: 'Failed to create subscription',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}