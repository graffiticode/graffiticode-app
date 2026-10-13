import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../../lib/plans-config';
import { subscriptionPeriodEnd } from '../../../lib/stripe-helpers';
import { emitPlanChanged } from '../../../lib/funnel-events';
import { getFirestore } from '../../../utils/db';
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


    const db = getFirestore();

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    // Find subscription that's set to cancel at period end
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'active',
      limit: 10,
    });

    // Also check for trialing subscriptions (e.g., Starter plan trial)
    const trialingSubscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'trialing',
      limit: 10,
    });
    subscriptions.data.push(...trialingSubscriptions.data);

    const cancelingSubscription = subscriptions.data.find(
      sub => sub.cancel_at_period_end === true
    );

    if (!cancelingSubscription) {
      return res.status(400).json({
        error: 'No subscription scheduled for cancellation found'
      });
    }

    // Check if customer has a valid payment method
    const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
    const defaultPaymentMethod = customer.invoice_settings?.default_payment_method;

    // Also check for any attached payment methods
    const paymentMethods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
      limit: 1,
    });

    const hasPaymentMethod = defaultPaymentMethod || paymentMethods.data.length > 0;

    // If no payment method, redirect to checkout to add one
    if (!hasPaymentMethod) {
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'setup',
        payment_method_types: ['card'],
        success_url: `${process.env.NEXT_PUBLIC_URL}/billing?resumed=true`,
        cancel_url: `${process.env.NEXT_PUBLIC_URL}/billing?canceled=true`,
        metadata: {
          userId,
          action: 'resume_subscription',
          subscriptionId: cancelingSubscription.id,
        },
      });

      return res.status(200).json({
        success: false,
        requiresPaymentMethod: true,
        checkoutUrl: session.url,
        message: 'Please add a payment method to resume your subscription',
      });
    }

    // Resume the subscription by removing the cancellation
    const resumedSubscription = await stripe.subscriptions.update(
      cancelingSubscription.id,
      {
        cancel_at_period_end: false,
        metadata: {
          ...cancelingSubscription.metadata,
          resumedAt: new Date().toISOString(),
        },
      }
    );

    // Log the resumption event
    await db.collection('subscription_events').add({
      userId,
      type: 'resumption',
      subscriptionId: resumedSubscription.id,
      timestamp: new Date(),
      previousCancelAt: cancelingSubscription.cancel_at
        ? new Date(cancelingSubscription.cancel_at * 1000).toISOString()
        : null,
    });

    // Update user document
    await db.collection('users').doc(userId).update({
      'subscription.status': 'active',
      'subscription.cancelAt': null,
      'subscription.canceledAt': null,
      'subscription.resumedAt': new Date().toISOString(),
    });

    // A recovered cancellation. The plan value never moved, so this reports the
    // decision rather than a transition.
    emitPlanChanged({
      uid: userId,
      from: userData?.subscription?.plan,
      to: userData?.subscription?.plan,
      reason: 'resume_requested',
    });

    return res.status(200).json({
      success: true,
      subscription: {
        id: resumedSubscription.id,
        status: resumedSubscription.status,
        cancelAtPeriodEnd: resumedSubscription.cancel_at_period_end,
        currentPeriodEnd: (() => {
          const end = subscriptionPeriodEnd(resumedSubscription);
          return end ? new Date(end * 1000).toISOString() : null;
        })(),
      },
      message: 'Subscription has been resumed successfully',
    });
  } catch (error) {
    console.error('Error resuming subscription:', error);
    return res.status(500).json({
      error: 'Failed to resume subscription',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}