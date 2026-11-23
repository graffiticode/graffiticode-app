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
} from '@graffiticode-app/core/lib/plans-config';
import { subscriptionPeriodEnd } from '@graffiticode-app/core/lib/stripe-helpers';
import { emitPlanChanged, hashUid } from '@graffiticode-app/core/lib/funnel-events';
import { getFirestore } from '@graffiticode-app/core/utils/db/index';
import * as admin from 'firebase-admin';
import { requireUser } from '../../../lib/api-auth';
import { withInstallation } from "../../../lib/with-installation";
import { CustomerLockBusy, LeaseLost, firestoreCustomerLock } from '../../../lib/billing-customer-lock';
import {
  finalizeSavedCardSubscription,
  isAttemptKey,
  startSavedCardSubscription,
  type SavedCardOutcome,
} from '../../../lib/billing-purchase';

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

// The card shown for confirmation: the customer's invoice default when it is
// an attached card, else their newest card. Read-only.
async function savedCardFor(stripe: Stripe, customerId: string) {
  const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 100 });
  const defaultId = typeof customer.invoice_settings?.default_payment_method === 'string'
    ? customer.invoice_settings.default_payment_method
    : customer.invoice_settings?.default_payment_method?.id;
  const card = cards.data.find(pm => pm.id === defaultId) ?? cards.data[0];
  return card ? { id: card.id, brand: card.card?.brand ?? 'card', last4: card.card?.last4 ?? '' } : null;
}

// Every saved-card outcome except `active` is answered here; `active`
// continues to the shared subscription write below.
function respondToOutcome(res: NextApiResponse, outcome: SavedCardOutcome): boolean {
  switch (outcome.kind) {
    case 'active':
      return false;
    case 'requires_action':
      res.status(200).json({ requiresAction: true, clientSecret: outcome.clientSecret, subscriptionId: outcome.subscriptionId });
      return true;
    case 'processing':
      res.status(202).json({ processing: true, subscriptionId: outcome.subscriptionId });
      return true;
    case 'declined':
      // The incomplete subscription is already canceled, so nothing is pending.
      res.status(402).json({ declined: true, error: outcome.message, declineCode: outcome.declineCode, canceled: true });
      return true;
    case 'ended':
      res.status(409).json({ attemptEnded: true, error: 'That payment attempt has ended. Please try again.' });
      return true;
    case 'has_subscription':
      res.status(409).json({ hasSubscription: true, error: 'You already have a subscription. Refresh the page to change it.' });
      return true;
    case 'mismatch':
      // The attempt key already names a different purchase; nothing new was charged.
      res.status(409).json({ attemptMismatch: true, error: 'That payment attempt was for a different plan. Refresh the page and try again.' });
      return true;
    case 'invalid':
      res.status(400).json({ error: outcome.reason });
      return true;
  }
}

// The entitlement a subscription actually carries: its base price's plan and
// billing interval, never the request's. Null when the price maps to no plan
// (the same refusal the webhook makes rather than guess).
function entitlementOf(sub: Stripe.Subscription): { planId: PlanId; interval: BillingInterval } | null {
  for (const item of sub.items?.data ?? []) {
    const plan = priceIdToPlan(item.price?.id) as PlanId | null;
    if (plan) return { planId: plan, interval: item.price?.recurring?.interval === 'year' ? 'annual' : 'monthly' };
  }
  return null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
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
    const { preview, paymentMethodId, attemptKey, confirmed, finalizeSubscriptionId } = req.body ?? {};
    let { planId, interval } = req.body ?? {};

    if (!finalizeSubscriptionId && (!planId || !interval)) {
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

    const lock = firestoreCustomerLock(db);

    // After 3D Secure, or while a payment is processing: report where the
    // saved-card subscription stands. Only an `active` one is written below.
    let subscription: Stripe.Subscription | null = null;
    if (finalizeSubscriptionId) {
      if (typeof finalizeSubscriptionId !== 'string') {
        return res.status(400).json({ error: 'Invalid subscription id' });
      }
      const outcome = await finalizeSavedCardSubscription(stripe, lock, {
        customerId: stripeCustomerId,
        subscriptionId: finalizeSubscriptionId,
      });
      if (respondToOutcome(res, outcome)) return;
      subscription = (outcome as Extract<SavedCardOutcome, { kind: 'active' }>).subscription;
      const entitlement = entitlementOf(subscription);
      if (!entitlement) {
        console.error(`[quick-subscribe] subscription ${subscription.id} has no price that maps to a plan; not writing it`);
        return res.status(500).json({ error: 'We could not determine your plan. Your payment went through; please refresh shortly.' });
      }
      ({ planId, interval } = entitlement);
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
    const [activeSubs, trialingSubs] = subscription
      ? [{ data: [] }, { data: [] }]
      : await Promise.all([
          stripe.subscriptions.list({ customer: stripeCustomerId, status: 'active', limit: 1 }),
          stripe.subscriptions.list({ customer: stripeCustomerId, status: 'trialing', limit: 1 }),
        ]);
    const existingSubscriptions = {
      data: [...activeSubs.data, ...trialingSubs.data],
    };

    let isUpgrade = false;
    let oldAllocation = 0;
    let existingSub: Stripe.Subscription | null = null;

    if (subscription) {
      // Finalized above.
    } else if (existingSubscriptions.data.length > 0) {
      // An in-place plan change takes no payment now, but still needs a card
      // on file for the prorated invoice.
      const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
      if (!customer.invoice_settings?.default_payment_method) {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: stripeCustomerId,
          type: 'card',
          limit: 1,
        });
        if (paymentMethods.data.length === 0) {
          return res.status(400).json({
            error: 'No payment method on file',
            requiresCheckout: true
          });
        }
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            default_payment_method: paymentMethods.data[0].id,
          },
        });
      }

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
      // No live subscription: subscribe with a card already on file, charged
      // now (billing-purchase.ts). The client first asks for a preview, shows
      // the card and gets the user's confirmation, then sends the card's id and
      // an attempt key that it reuses for retries of the same attempt.
      const savedCard = await savedCardFor(stripe, stripeCustomerId);
      if (!savedCard) {
        return res.status(400).json({ error: 'No payment method on file', requiresCheckout: true });
      }
      if (preview) {
        return res.status(200).json({ savedCard });
      }
      if (confirmed !== true || typeof paymentMethodId !== 'string' || !isAttemptKey(attemptKey)) {
        return res.status(400).json({ error: 'Confirm the card to charge', requiresConfirmation: true, savedCard });
      }
      const outcome = await startSavedCardSubscription(stripe, lock, {
        customerId: stripeCustomerId,
        userId,
        planId,
        interval,
        paymentMethodId,
        attemptKey,
        items: [
          { price: basePriceId },
          ...(meterPriceId ? [{ price: meterPriceId }] : []),
        ],
      });
      if (respondToOutcome(res, outcome)) return;
      subscription = (outcome as Extract<SavedCardOutcome, { kind: 'active' }>).subscription;
      // Write what was bought, not what was asked for.
      const entitlement = entitlementOf(subscription);
      if (!entitlement) {
        console.error(`[quick-subscribe] subscription ${subscription.id} has no price that maps to a plan; not writing it`);
        return res.status(500).json({ error: 'We could not determine your plan. Your payment went through; please refresh shortly.' });
      }
      ({ planId, interval } = entitlement);
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
    if (error instanceof CustomerLockBusy || error instanceof LeaseLost) {
      // Another billing request for this customer is in progress; nothing was charged here.
      return res.status(409).json({ busy: true, error: 'Another billing change is in progress. Please try again in a moment.' });
    }
    console.error('Error creating subscription:', error);
    return res.status(500).json({
      error: 'Failed to create subscription',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

export default withInstallation(handler);
