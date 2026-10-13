import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { getFirestore } from '../../../utils/db';
import { STRIPE_API_VERSION, includedItemsFor, effectiveIncludedItems, preservedAllocationApplies, overageRateFor, priceIdToPlan, DEFAULT_PLAN } from '../../../lib/plans-config';
import { subscriptionPeriod } from '../../../lib/stripe-helpers';
import { requireUser } from '../../../lib/api-auth';

// Initialize Stripe only if secret key is available
let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;


    // Get user data from Firestore
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(userId).get();

    // For new users without a document, return demo tier
    if (!userDoc.exists) {
      const now = new Date();
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      return res.status(200).json({
        plan: 'demo',
        interval: 'monthly',
        status: 'active',
        currentBillingPeriod: {
          start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
          end: endOfMonth.toISOString(),
        },
        cancelAtPeriodEnd: false,
        nextBillingDate: endOfMonth.toISOString(),
        units: includedItemsFor('demo'),        overageRate: null,
        hasActiveSubscription: false,
        trialUsedAt: null,
      });
    }

    const userData = userDoc.data();
    let stripeCustomerId = userData?.stripeCustomerId;

    // If Stripe is not configured or no Stripe customer, return demo/starter tier
    if (!stripe || !stripeCustomerId) {
      const preservedRenewalDate = userData?.subscription?.renewalDate || null;
      const plan = userData?.subscription?.plan || 'demo';

      // For demo/free users, calculate end of current month as renewal date
      const now = new Date();
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1); // First day of next month = renewal
      const renewalDate = preservedRenewalDate || endOfMonth.toISOString();

      const units = includedItemsFor(plan);

      return res.status(200).json({
        plan,
        interval: 'monthly',
        status: 'active',
        currentBillingPeriod: {
          start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
          end: endOfMonth.toISOString(),
        },
        cancelAtPeriodEnd: false,
        nextBillingDate: renewalDate,
        units,        overageRate: null,
        hasActiveSubscription: false,
        trialUsedAt: userData?.trialUsedAt || null,
      });
    }

    // Verify the customer exists in current mode (test/live)
    try {
      await stripe.customers.retrieve(stripeCustomerId);
    } catch (error: any) {
      if (error.code === 'resource_missing') {
        // Customer doesn't exist in current mode, treat as demo tier
        const preservedRenewalDate = userData?.subscription?.renewalDate || null;
        const plan = userData?.subscription?.plan || 'demo';
        const now = new Date();
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const renewalDate = preservedRenewalDate || endOfMonth.toISOString();
        const units = includedItemsFor(plan);

        return res.status(200).json({
          plan,
          interval: 'monthly',
          status: 'active',
          currentBillingPeriod: {
            start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
            end: endOfMonth.toISOString(),
          },
          cancelAtPeriodEnd: false,
          nextBillingDate: renewalDate,
          units,          overageRate: null,
          hasActiveSubscription: false,
          trialUsedAt: userData?.trialUsedAt || null,
        });
      }
      throw error;
    }

    // Get active subscriptions from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'active',
      limit: 1,
    });

    // Also check for trialing subscriptions
    if (!subscriptions.data.length) {
      const trialingSubscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'trialing',
        limit: 1,
      });
      subscriptions.data.push(...trialingSubscriptions.data);
    }

    // If no active subscription, return demo/starter tier with preserved renewal date if available
    if (!subscriptions.data.length) {
      // Check if there's a preserved renewal date from a previous subscription
      const preservedRenewalDate = userData?.subscription?.renewalDate || null;

      const plan = userData?.subscription?.plan || 'demo';

      // For demo/free users, calculate end of current month as renewal date
      const now = new Date();
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const renewalDate = preservedRenewalDate || endOfMonth.toISOString();

      // Preserved allocation from a downgrade only ever raises the allowance.
      const preservedUntil = userData?.subscription?.preservedUntil;
      const hasPreservedAllocation = preservedAllocationApplies(plan, userData?.subscription, now);
      const units = effectiveIncludedItems(plan, userData?.subscription, now);

      return res.status(200).json({
        plan,
        interval: 'monthly',
        status: 'active',
        currentBillingPeriod: {
          start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
          end: endOfMonth.toISOString(),
        },
        cancelAtPeriodEnd: false,
        nextBillingDate: renewalDate,
        units,        overageRate: null,
        isUsingPreservedAllocation: hasPreservedAllocation,
        preservedUntil: hasPreservedAllocation ? preservedUntil : null,
        hasActiveSubscription: false,
        trialUsedAt: userData?.trialUsedAt || null,
      });
    }

    const subscription = subscriptions.data[0];
    // A subscription carries the flat base price plus (for paid tiers) a metered
    // overage price. Match the base price to resolve the plan, and read the
    // interval from the base (licensed) price rather than the metered one.
    const baseItem = subscription.items.data.find(it => priceIdToPlan(it?.price?.id)) || subscription.items.data[0];
    const planName = priceIdToPlan(baseItem?.price?.id) || DEFAULT_PLAN;

    // Get billing interval from the base price.
    const stripeInterval = baseItem?.price.recurring?.interval;
    const interval = stripeInterval === 'year' ? 'annual' : stripeInterval === 'month' ? 'monthly' : null;

    // The plan's own bucket (annual plans include 12x the monthly item bucket),
    // raised by a downgrade's preserved allocation while that grace window lasts.
    const preservedUntil = userData?.subscription?.preservedUntil;
    const baseUnits = interval === 'annual'
      ? includedItemsFor(planName) * 12
      : includedItemsFor(planName);
    const hasPreservedAllocation = preservedAllocationApplies(planName, userData?.subscription, new Date(), baseUnits);
    const planUnits = effectiveIncludedItems(planName, userData?.subscription, new Date(), baseUnits);

    // Check for scheduled changes and get the correct renewal date
    let scheduledPlan = null;
    let scheduledInterval = null;
    const period = subscriptionPeriod(subscription);
    let effectiveRenewalDate = period.end;

    if (subscription.schedule) {
      try {
        const schedule = await stripe.subscriptionSchedules.retrieve(subscription.schedule as string);

        // Check if there are future phases
        if (schedule.phases && schedule.phases.length > 1) {
          // Get the current phase (phase[0]) for the renewal date
          const currentPhase = schedule.phases[0];
          if (currentPhase.end_date) {
            effectiveRenewalDate = currentPhase.end_date as number;
          }

          // Get the next phase (phase[1]) for scheduled changes
          const nextPhase = schedule.phases[1];
          if (nextPhase && nextPhase.items && nextPhase.items.length > 0) {
            const nextPriceId = nextPhase.items[0].price as string;
            scheduledPlan = priceIdToPlan(nextPriceId) || null;

            // Get the scheduled interval from the price
            const nextPrice = await stripe.prices.retrieve(nextPriceId);
            const nextInterval = nextPrice.recurring?.interval;
            scheduledInterval = nextInterval === 'year' ? 'annual' : nextInterval === 'month' ? 'monthly' : null;
          }
        }
      } catch (scheduleError) {
        console.error('Error fetching subscription schedule:', scheduleError);
        // Continue without scheduled info
      }
    }

    // For Starter plan, show 'active' instead of 'trialing' during free trial
    const displayStatus = (planName === 'starter' && subscription.status === 'trialing')
      ? 'active'
      : subscription.status;

    return res.status(200).json({
      plan: planName,
      interval,
      scheduledPlan,
      scheduledInterval,
      status: displayStatus,
      currentBillingPeriod: {
        start: period.start ? new Date(period.start * 1000).toISOString() : null,
        end: effectiveRenewalDate ? new Date(effectiveRenewalDate * 1000).toISOString() : null,
      },
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      nextBillingDate: effectiveRenewalDate
        ? new Date(effectiveRenewalDate * 1000).toISOString()
        : null,
      units: planUnits,      overageRate: overageRateFor(planName),
      stripeSubscriptionId: subscription.id,
      isUsingPreservedAllocation: hasPreservedAllocation,
      preservedUntil: hasPreservedAllocation ? preservedUntil : null,
      hasActiveSubscription: true,
      trialUsedAt: userData?.trialUsedAt || null,
    });
  } catch (error) {
    console.error('Error fetching subscription:', error);
    return res.status(500).json({
      error: 'Failed to fetch subscription',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}