import type Stripe from 'stripe';

/**
 * Verify a Stripe webhook against the current signing secret, then the previous one.
 *
 * Rotation (2026-10-24): Stripe's "roll signing secret" signs each event with both the old and the new secret
 * for up to 24 hours. Holding the new one in STRIPE_WEBHOOK_SECRET and the old in STRIPE_WEBHOOK_SECRET_PREVIOUS
 * means neither the deploy nor a rollback inside that window drops a delivery; once the window ends, the
 * previous secret is removed. Returns the event, or throws the current secret's verification error.
 */
export function verifyStripeEvent(
  stripe: Pick<Stripe, 'webhooks'>,
  payload: Buffer | string,
  signature: string,
  secrets: Array<string | undefined>,
): Stripe.Event {
  const candidates = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (candidates.length === 0) throw new Error('No webhook signing secret configured');
  let firstError: unknown;
  for (const secret of candidates) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError;
}
