import { getFirestore } from '../../utils/db';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../lib/plans-config';
import { requireUser } from '../../lib/api-auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: STRIPE_API_VERSION,
});

// A Stripe setup intent for the caller's own customer. Any ?id= is ignored.
const handler = async (req, res) => {
  const auth = await requireUser(req);
  if (!auth) return res.status(401).end();
  try {
    const client = await getFirestore().doc(`users/${auth.uid}`).get();
    const customerId = client.data()?.stripeCustomer?.id;
    if (!customerId) return res.status(404).json({ error: 'No billing customer for this account' });
    const stripeSetupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });
    res.json({ client_secret: stripeSetupIntent.client_secret });
  } catch (e) {
    console.info("GET /secret error=" + e);
    res.status(400).end();
  }
};

export default handler;
