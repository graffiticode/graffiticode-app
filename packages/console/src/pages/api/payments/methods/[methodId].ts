import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../../../lib/plans-config';
import { getFirestore } from '../../../../utils/db';
import { requireUser } from '../../../../lib/api-auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: STRIPE_API_VERSION,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { methodId } = req.query;
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;

    if (!methodId || typeof methodId !== 'string') {
      return res.status(400).json({ error: 'Method ID is required' });
    }


    const db = getFirestore();

    // Get user data to verify ownership
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No payment methods found' });
    }

    // Check if this is the only payment method
    const paymentMethods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    });

    if (paymentMethods.data.length === 1) {
      // Check if user has active subscription
      const subscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'active',
        limit: 1,
      });

      if (subscriptions.data.length > 0) {
        return res.status(400).json({
          error: 'Cannot remove the only payment method while subscription is active',
          requiresAlternative: true,
        });
      }
    }

    // Detach the payment method
    await stripe.paymentMethods.detach(methodId);

    // If this was the default method, set another as default
    const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
    if (customer.invoice_settings?.default_payment_method === methodId) {
      const remainingMethods = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: 'card',
        limit: 1,
      });

      if (remainingMethods.data.length > 0) {
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            default_payment_method: remainingMethods.data[0].id,
          },
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Payment method removed',
    });
  } catch (error) {
    console.error('Error removing payment method:', error);
    return res.status(500).json({
      error: 'Failed to remove payment method',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}