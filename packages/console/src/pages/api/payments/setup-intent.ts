import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../../lib/plans-config';
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
    let stripeCustomerId = userData?.stripeCustomerId;

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

    // Create a SetupIntent for saving card details
    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      usage: 'off_session', // For future charges
      metadata: {
        userId,
      },
    });

    return res.status(200).json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    });
  } catch (error) {
    console.error('Error creating setup intent:', error);
    return res.status(500).json({
      error: 'Failed to create setup intent',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}