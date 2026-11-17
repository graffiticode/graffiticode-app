// Stripe in the browser, for the installation's publishable key from its
// public configuration (/api/config). Loaded on first use, once per key, and
// never with a built-in or test key: an installation without one gets null,
// and its payment forms say payments aren't available.
// The pure entry point: the default one inserts Stripe.js as soon as it is
// imported, before the configuration has loaded. This one inserts it only
// when loadStripe is called, with the installation's key.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";
import { usePublicConfig } from "./public-config";

const loaded = new Map<string, Promise<Stripe | null>>();

export function useStripePromise(): Promise<Stripe | null> | null {
  const key = usePublicConfig().billing.stripePublishableKey;
  if (!key) return null;
  if (!loaded.has(key)) loaded.set(key, loadStripe(key));
  return loaded.get(key)!;
}
