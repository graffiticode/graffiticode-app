import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { getFirestore } from '../../../utils/db';
import { STRIPE_API_VERSION, stripeBasePriceId, stripeMeterPriceId, getPlan, defaultOverageCapUsd, type PlanId, type BillingInterval } from '../../../lib/plans-config';
import { emitEvent, actor } from '../../../lib/funnel-events';
import { requireUser } from '../../../lib/api-auth';

// Initialize Stripe only if secret key is available
let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
}

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
    const { planId, interval, overageLimitUsd } = req.body;

    // uid omitted deliberately: these uids are wallet addresses, and the
    // privacy contract keeps them out of the logs (see hashUid in funnel-events).
    console.log('Create checkout session request:', { planId, interval, overageLimitUsd });

    if (!planId || !interval) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Bronze pay-as-you-go enrollment: the base fee is $0 and only a monthly
    // price exists, so an "annual" request here is a client bug, not a choice.
    const planConfig = getPlan(planId);
    const isPayAsYouGoEnrollment = planConfig.hardCap && planConfig.overageRatePerItem != null;
    const effectiveInterval: BillingInterval = isPayAsYouGoEnrollment
      ? 'monthly'
      : (interval as BillingInterval);

    // Enrollment is never uncapped: the customer is putting a card behind a
    // $0-base plan, and "unlimited by default" there is how a trial user gets a
    // four-figure surprise. No cap sent means the plan default ($10 on Bronze).
    let enrollmentCapUsd: number | null = null;
    if (isPayAsYouGoEnrollment) {
      const usd = overageLimitUsd == null || overageLimitUsd === ''
        ? defaultOverageCapUsd(planId)
        : Number(overageLimitUsd);
      if (usd == null || !Number.isFinite(usd) || usd <= 0) {
        return res.status(400).json({
          error: 'Invalid monthly spend cap',
          details: 'Pass overageLimitUsd as a positive dollar amount, or omit it for the default.',
        });
      }
      enrollmentCapUsd = usd;
    }

    // Validate Stripe configuration
    if (!stripe) {
      console.error('STRIPE_SECRET_KEY is not configured');
      return res.status(500).json({ error: 'Payment system not configured. Please contact support.' });
    }

    // Get or create Stripe customer for user
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    let stripeCustomerId = userData?.stripeCustomerId;

    // Verify if existing customer ID is valid in current mode
    if (stripeCustomerId) {
      try {
        await stripe.customers.retrieve(stripeCustomerId);
      } catch (error: any) {
        if (error.code === 'resource_missing') {
          console.log(`Customer ${stripeCustomerId} doesn't exist in current Stripe mode, creating new...`);
          stripeCustomerId = null;
          // Clear the invalid customer ID
          await db.collection('users').doc(userId).update({
            stripeCustomerId: null
          });
        } else {
          throw error;
        }
      }
    }

    // Create Stripe customer if doesn't exist
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: {
          userId: userId,
        },
        email: userData?.email,
        name: userData?.name,
      });

      stripeCustomerId = customer.id;

      // Save Stripe customer ID to user document
      await db.collection('users').doc(userId).update({
        stripeCustomerId,
      });
    }

    // Get the appropriate price ID
    const priceId = stripeBasePriceId(planId as PlanId, effectiveInterval);

    console.log('Price ID mapping:', { planId, interval: effectiveInterval, priceId });

    // Check if price IDs are still placeholders
    if (!priceId || priceId === 'undefined' || priceId.includes('TEST_')) {
      console.error('Price IDs not configured. Please create products in Stripe TEST dashboard first.');
      return res.status(503).json({
        error: 'Payment system configuration incomplete',
        details: 'Stripe products have not been created yet. Please create Pro and Max products in your Stripe TEST dashboard and update the price IDs in .env.local',
        instruction: 'Go to https://dashboard.stripe.com/test/products to create products',
        currentPriceId: priceId
      });
    }

    if (!priceId.startsWith('price_')) {
      console.error('Invalid price ID format:', { planId, interval, priceId });
      return res.status(400).json({
        error: 'Invalid price configuration',
        details: 'Price ID must start with "price_"'
      });
    }

    // Check for existing active or trialing subscription
    const [activeSubs, trialingSubs] = await Promise.all([
      stripe.subscriptions.list({ customer: stripeCustomerId, status: 'active', limit: 1 }),
      stripe.subscriptions.list({ customer: stripeCustomerId, status: 'trialing', limit: 1 }),
    ]);
    const existingSubscriptions = {
      data: [...activeSubs.data, ...trialingSubs.data],
    };

    // If user has an existing subscription, they should use quick-subscribe (Payment Methods tab)
    // Stripe Checkout cannot properly handle subscription upgrades/downgrades with prorations
    if (existingSubscriptions.data.length > 0) {
      return res.status(400).json({
        error: 'Cannot change subscription through checkout',
        message: 'To upgrade or downgrade your plan, please add a payment method in the Payment Methods tab first.',
        requiresPaymentMethod: true,
      });
    }

    // Get customer's default payment method if exists
    let defaultPaymentMethod = null;
    if (stripeCustomerId) {
      const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
      defaultPaymentMethod = customer.invoice_settings?.default_payment_method;
    }

    // Subscription line items: the flat base price (billed in advance) plus,
    // when the tier has one, its metered overage price (billed in arrears). The
    // metered line carries no quantity — usage is reported via meter events.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: priceId, quantity: 1 },
    ];
    const meterPriceId = stripeMeterPriceId(planId as PlanId);
    if (meterPriceId) {
      lineItems.push({ price: meterPriceId });
    }

    // Create checkout session for NEW subscriptions only
    const sessionConfig: Stripe.Checkout.SessionCreateParams = {
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'subscription',
      success_url: `${process.env.NEXT_PUBLIC_URL}/billing?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_URL}/billing?canceled=true`,
      // Allow modifying quantities, promo codes, etc
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      // Save payment method for future use (subscription mode). On a Bronze
      // enrollment the amount due today is $0, so this flag is the only thing
      // making Stripe collect a card at all — the entire point of the flow.
      payment_method_collection: 'always',
      metadata: {
        userId,
        planId,
        interval: effectiveInterval,
      },
      // Carried on the SUBSCRIPTION, not the session: customer.subscription.created
      // is where the plan (and now the cap) is written, and a session that is
      // never completed must leave no trace.
      subscription_data: {
        metadata: {
          userId,
          planId,
          ...(enrollmentCapUsd != null ? { overageLimitUsd: String(enrollmentCapUsd) } : {}),
        },
      },
    };

    if (isPayAsYouGoEnrollment) {
      // Keep Bronze on calendar months. Usage is counted per billing period, so
      // an anchor that drifted with the enrollment date would silently move
      // everyone's reset day off the 1st and make usage reports incomparable.
      sessionConfig.subscription_data!.billing_cycle_anchor_config = { day_of_month: 1 };
      // The base price is $0; a proration line for it would only be noise.
      sessionConfig.subscription_data!.proration_behavior = 'none';
    }

    // If customer has a saved payment method, configure to use it
    if (defaultPaymentMethod) {
      console.log('Customer has default payment method:', defaultPaymentMethod);

      // Tell Stripe to use saved payment methods
      sessionConfig.payment_method_collection = 'if_required';
      sessionConfig.customer_update = {
        address: 'auto',
      };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    // Intent, not a plan change — a session that's never completed is an
    // abandoned checkout, which is why the digest reports this separately from
    // plan_changed rather than as a second revenue line.
    emitEvent('checkout_started', { ...actor({ uid: userId }), to: planId, interval });

    return res.status(200).json({
      checkoutUrl: session.url
    });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}