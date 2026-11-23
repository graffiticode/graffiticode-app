/**
 * The browser side of a saved-card purchase (billing-purchase.ts): send the
 * confirmed attempt, run at most one 3D Secure challenge, and finalize.
 *
 * Kept free of React and of HTTP details so it can be tested directly;
 * PricingPlans supplies the dependencies.
 *
 * A purchase opens at most one challenge. When Stripe.js returns an error
 * (https://docs.stripe.com/js/payment_intents/confirm_card_payment), or
 * throws, the server is asked once where the payment stands. A decline ends
 * the attempt (its subscription is already canceled). Anything still awaiting
 * authentication is left for the user to retry deliberately, never reopened
 * here.
 */
export type PostResult = { status: number; data: any };

export interface SavedCardClientDeps {
  /** POST to quick-subscribe. Resolves with any HTTP status; rejects only when no response arrived. */
  post(body: Record<string, unknown>): Promise<PostResult>;
  /** Stripe.js confirmCardPayment, or null when Stripe.js isn't available. */
  confirmCardPayment: ((clientSecret: string) => Promise<{ error?: { type?: string; code?: string; message?: string } }>) | null;
  confirm(message: string): boolean;
  alert(message: string): void;
  startCheckout(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type SavedCardResult =
  | 'active'          // subscribed
  | 'declined'        // the card was declined; the user chose not to try another
  | 'checkout'        // declined, and the user went on to Checkout with another card
  | 'auth_incomplete' // authentication wasn't completed; nothing was charged, the attempt can be retried
  | 'processing'      // the payment is still resolving; the plan updates when it does
  | 'busy';           // another billing change was in progress; nothing happened

const POLLS = 10;
const POLL_MS = 3_000;

export async function runSavedCardPurchase(
  deps: SavedCardClientDeps,
  body: Record<string, unknown>,
  onAttemptEnded: () => void,
): Promise<SavedCardResult> {
  let challenged = false;
  let challengeError: string | null = null;
  let r = await deps.post(body);

  for (;;) {
    const d = r.data ?? {};
    if (r.status >= 200 && r.status < 300 && d.success) {
      onAttemptEnded();
      return 'active';
    }
    if (d.declined || d.attemptEnded) {
      onAttemptEnded(); // the server canceled it; a new attempt starts fresh
      const message = d.error || challengeError || 'Your card was declined.';
      if (deps.confirm(`${message}\n\nPay with a different card instead?`)) {
        await deps.startCheckout();
        return 'checkout';
      }
      return 'declined';
    }
    if (d.busy) {
      deps.alert(d.error || 'Another billing change is in progress. Please try again in a moment.');
      return 'busy';
    }
    if (d.requiresAction) {
      if (challenged || !deps.confirmCardPayment) {
        deps.alert(
          (challengeError ? `${challengeError}\n\n` : '') +
          'Your card needs to be authenticated before it can be charged, and that wasn’t completed. ' +
          'You haven’t been charged. Choose the plan again when you’re ready.',
        );
        return 'auth_incomplete';
      }
      challenged = true;
      try {
        const result = await deps.confirmCardPayment(d.clientSecret);
        challengeError = result?.error ? result.error.message || 'Authentication failed.' : null;
      } catch (e: any) {
        challengeError = e?.message || 'Authentication was interrupted.';
      }
      // Whatever Stripe.js reported, the server's view decides what happened.
      r = await deps.post({ finalizeSubscriptionId: d.subscriptionId });
      continue;
    }
    if (d.processing) {
      for (let i = 0; i < POLLS; i++) {
        await deps.sleep(POLL_MS);
        const again = await deps.post({ finalizeSubscriptionId: d.subscriptionId });
        if (!again.data?.processing) {
          r = again;
          break;
        }
      }
      if (r.data?.processing) {
        deps.alert('Your payment is still processing. Your plan will update when it completes.');
        return 'processing';
      }
      continue;
    }
    // Any other answer is an error; the attempt key is kept, so a retry resumes it.
    throw Object.assign(new Error(d.error || `Subscription request failed (${r.status})`), { response: r });
  }
}
