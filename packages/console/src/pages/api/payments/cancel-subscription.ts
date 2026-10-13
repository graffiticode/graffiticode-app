import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { STRIPE_API_VERSION, includedItemsFor, priceIdToPlan, DEFAULT_PLAN, PLANS, type PlanId } from '../../../lib/plans-config';
import { subscriptionPeriodEnd } from '../../../lib/stripe-helpers';
import { emitPlanChanged, hashUid } from '../../../lib/funnel-events';
import { getFirestore } from '../../../utils/db';
import * as admin from 'firebase-admin';
import { requireUser } from '../../../lib/api-auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: STRIPE_API_VERSION,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;
    const { reason, feedback, immediately = false } = req.body;


    const db = getFirestore();

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Get active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'active',
      limit: 1,
    });

    if (!subscriptions.data.length) {
      // Also check for trialing subscriptions
      const trialingSubscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'trialing',
        limit: 1,
      });

      if (!trialingSubscriptions.data.length) {
        return res.status(400).json({ error: 'No active subscription found' });
      }

      subscriptions.data.push(...trialingSubscriptions.data);
    }

    const subscription = subscriptions.data[0];

    // Calculate current plan's allocation to preserve on immediate cancellation
    // (downgrade to Free), so the user keeps what they paid for until period end.
    // Derive the allocation from the LIVE Stripe price — NOT from the Firestore
    // `subscription.plan`, which can be stale if a prior webhook didn't land
    // (that staleness is what previously fell back to the bogus Starter 2,000).
    // null (not 0) means "we could not determine it" — see the refusal below.
    let currentAllocation: number | null = null;
    if (immediately) {
      // Resolve the live base price to a plan and take its monthly item bucket
      // from plans-config (never a hardcoded map — those went stale when
      // compile units were retired for item-based pricing).
      const priceId = subscription.items.data.map(it => it?.price?.id).find(id => priceIdToPlan(id))
        || subscription.items.data[0]?.price.id;

      // NEVER fall back to DEFAULT_PLAN here. priceIdToPlan resolves against
      // the STRIPE_*_PRICE_ID env vars, so a rotated price (or an env whose
      // mode does not match STRIPE_SECRET_KEY) makes every paid price match
      // nothing — and `?? DEFAULT_PLAN` then wrote preservedAllocation: 25
      // onto a customer who had just cancelled a Gold plan. The grace window
      // exists precisely because they paid through period end and should keep
      // their 10,000-item bucket; 25 items under a hard-capped plan locks them
      // out of a period they already paid for.
      //
      // The live Stripe price stays the primary source (the cached plan can be
      // stale if a webhook never landed). But the cache is now a safe *last*
      // resort: the webhook, reconciler and on-read repair all refuse to write
      // an unmappable plan, so it is either correct or absent.
      const cachedPlan = userData?.subscription?.plan;
      const cancelingPlan = priceIdToPlan(priceId)
        ?? (cachedPlan && cachedPlan in PLANS ? (cachedPlan as PlanId) : null);

      if (cancelingPlan) {
        currentAllocation = includedItemsFor(cancelingPlan);
        console.log('Preserving allocation on downgrade to free:', {
          priceId,
          plan: cancelingPlan,
          preservedAllocation: currentAllocation,
        });
      } else {
        // The cancellation itself still proceeds — the customer asked for it
        // and is entitled to it. Only the grace allocation is withheld, and
        // omitting it is recoverable (scripts/set-preserved-allocation.ts)
        // whereas a written 25 looks deliberate and would not be noticed.
        console.error(
          `[cancel-subscription] Cancelling ${subscription.id} for user ${hashUid(userId)} WITHOUT a ` +
          `preserved allocation: price ${priceId} maps to no known plan and the cached plan ` +
          `${JSON.stringify(cachedPlan)} is not a known plan either. This is a configuration ` +
          `problem (a rotated price, or STRIPE_*_PRICE_ID not matching the mode of ` +
          `STRIPE_SECRET_KEY) — NOT a free account. Writing DEFAULT_PLAN's allowance here ` +
          `would cap a customer who paid through period end. Fix the env, then restore the ` +
          `grace window with scripts/set-preserved-allocation.ts.`,
        );
      }
    }

    // Cancel the subscription
    let canceledSubscription: Stripe.Subscription;

    if (immediately) {
      // Cancel immediately
      canceledSubscription = await stripe.subscriptions.cancel(subscription.id);
    } else {
      // Cancel at the end of the current billing period
      canceledSubscription = await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
        metadata: {
          ...subscription.metadata,
          cancelReason: reason || 'user_requested',
          cancelFeedback: feedback || '',
          canceledAt: new Date().toISOString(),
        },
      });
    }

    // Log cancellation in Firestore
    await db.collection('subscription_events').add({
      userId,
      type: 'cancellation',
      subscriptionId: subscription.id,
      reason: reason || 'user_requested',
      feedback: feedback || '',
      immediately,
      timestamp: new Date(),
      cancelAt: canceledSubscription.cancel_at
        ? new Date(canceledSubscription.cancel_at * 1000).toISOString()
        : null,
    });

    // Update user document
    // When immediately canceling (downgrading to starter), preserve the renewal date from the subscription
    const updateData: any = {
      'subscription.status': immediately ? 'active' : 'canceling',
      'subscription.cancelAtPeriodEnd': !immediately, // Track if canceling at period end
      'subscription.cancelAt': canceledSubscription.cancel_at
        ? new Date(canceledSubscription.cancel_at * 1000).toISOString()
        : null,
    };

    // Only update plan if immediately canceling (downgrading to free)
    if (immediately) {
      updateData['subscription.plan'] = 'demo';
    }

    // Only set canceledAt for actual cancellations, not downgrades to free
    if (!immediately) {
      updateData['subscription.canceledAt'] = new Date().toISOString();
    }

    // Preserve the renewal date and allocation when downgrading to free
    const subPeriodEnd = subscriptionPeriodEnd(subscription);
    if (immediately && subPeriodEnd) {
      updateData['subscription.renewalDate'] = new Date(subPeriodEnd * 1000).toISOString();
      updateData['subscription.interval'] = null; // Bronze has no interval
      // Clearing this is also what un-enrolls a Bronze pay-as-you-go account:
      // payAsYouGoEnabled() keys off it, so the account drops back to the
      // included-items hard cap on its very next create.
      updateData['subscription.stripeSubscriptionId'] = null;
      // Both fields or neither: preservedUntil without an allocation is a
      // grace window with nothing in it.
      if (currentAllocation !== null) {
        updateData['subscription.preservedAllocation'] = currentAllocation; // Preserve old plan's allocation
        updateData['subscription.preservedUntil'] = new Date(subPeriodEnd * 1000).toISOString();
      }

      // Clear any previous canceledAt field for downgrades
      updateData['subscription.canceledAt'] = admin.firestore.FieldValue.delete();
    }

    await db.collection('users').doc(userId).update(updateData);

    // Immediate cancellation moves the plan now; a period-end cancellation is a
    // decision whose plan write lands later (via customer.subscription.deleted).
    // Report the decision when it's made — a month's delay makes it useless for
    // retention — and let the eventual sync report the transition separately.
    emitPlanChanged({
      uid: userId,
      from: userData?.subscription?.plan ?? DEFAULT_PLAN,
      to: DEFAULT_PLAN,
      reason: immediately ? 'subscription_sync' : 'cancel_requested',
    });

    return res.status(200).json({
      success: true,
      subscription: {
        id: canceledSubscription.id,
        status: canceledSubscription.status,
        cancelAtPeriodEnd: canceledSubscription.cancel_at_period_end,
        cancelAt: canceledSubscription.cancel_at
          ? new Date(canceledSubscription.cancel_at * 1000).toISOString()
          : null,
        currentPeriodEnd: (() => {
          const end = subscriptionPeriodEnd(canceledSubscription);
          return end ? new Date(end * 1000).toISOString() : null;
        })(),
      },
      message: immediately
        ? 'Subscription canceled immediately'
        : `Subscription will be canceled at the end of the current billing period`,
    });
  } catch (error: any) {
    console.error('Error canceling subscription:', error);

    // Handle Stripe-specific errors
    if (error.type === 'StripeInvalidRequestError') {
      return res.status(400).json({
        error: 'Invalid subscription request',
        details: error.message,
        code: error.code
      });
    }

    return res.status(500).json({
      error: 'Failed to cancel subscription',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}