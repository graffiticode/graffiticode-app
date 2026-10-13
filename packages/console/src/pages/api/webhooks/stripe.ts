import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { getFirestore } from '../../../utils/db';
import admin from '../../../utils/db';
import { buffer } from 'micro';
import { STRIPE_API_VERSION, priceIdToPlan, includedItemsFor, getPlan, overageDollarsToItems, defaultOverageCapFor, defaultOverageCapUsd, DEFAULT_PLAN } from '../../../lib/plans-config';
import { emitPlanChanged, emitEvent, actor } from '../../../lib/funnel-events';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: STRIPE_API_VERSION,
});

// Disable body parsing, need raw body for webhook signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// Detach duplicate cards (same fingerprint) for a customer, keeping exactly one.
// Runs on payment_method.attached, so it covers every entry point: Checkout,
// SetupIntent, and the manual add endpoint. Exported for the one-off cleanup
// script (scripts/dedupe-payment-methods.ts).
export async function dedupePaymentMethods(
  stripeClient: Stripe,
  customerId: string,
  attachedPmId: string,
): Promise<{ keepId: string; detached: string[] } | undefined> {
  const attached = await stripeClient.paymentMethods.retrieve(attachedPmId);
  const fingerprint = attached.card?.fingerprint;
  if (!fingerprint) return;

  // All card PMs sharing this fingerprint = the same physical card.
  const all = await stripeClient.paymentMethods.list({ customer: customerId, type: 'card' });
  const dupes = all.data.filter((pm) => pm.card?.fingerprint === fingerprint);
  if (dupes.length < 2) return; // nothing to collapse

  const customer = (await stripeClient.customers.retrieve(customerId)) as Stripe.Customer;
  const customerDefault = customer.invoice_settings?.default_payment_method as string | undefined;

  // Protect any PM an in-use subscription points at (covers the Checkout race
  // where the new card was just wired up as the subscription's default).
  const subs = await stripeClient.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  const protectedIds = new Set<string>(
    subs.data
      .filter((s) => ['active', 'trialing', 'past_due', 'incomplete'].includes(s.status))
      .map((s) => s.default_payment_method as string)
      .filter(Boolean),
  );

  // Keep the customer's current default if it's one of the dupes; otherwise keep
  // the newest (the just-attached card) and promote it to default.
  let keepId = dupes.find((pm) => pm.id === customerDefault)?.id;
  if (!keepId) {
    keepId = dupes.reduce((a, b) => (a.created > b.created ? a : b)).id;
    await stripeClient.customers.update(customerId, {
      invoice_settings: { default_payment_method: keepId },
    });
  }

  const detached: string[] = [];
  for (const pm of dupes) {
    if (pm.id === keepId || protectedIds.has(pm.id)) continue;
    await stripeClient.paymentMethods.detach(pm.id);
    detached.push(pm.id);
  }
  return { keepId, detached };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event: Stripe.Event;

  try {
    const buf = await buffer(req);
    const sig = req.headers['stripe-signature'] as string;

    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  const db = getFirestore();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;

        if (!userId) {
          console.error('No userId in checkout session metadata');
          break;
        }

        // Handle setup mode sessions (e.g., adding payment method to resume subscription)
        if (session.mode === 'setup' && session.metadata?.action === 'resume_subscription') {
          const subscriptionId = session.metadata.subscriptionId;

          if (subscriptionId) {
            // Resume the subscription
            await stripe.subscriptions.update(subscriptionId, {
              cancel_at_period_end: false,
            });

            // Update user document
            await db.collection('users').doc(userId).update({
              'subscription.status': 'active',
              'subscription.cancelAt': null,
              'subscription.canceledAt': null,
              'subscription.resumedAt': new Date().toISOString(),
            });

            // Log the event
            await db.collection('subscription_events').add({
              userId,
              type: 'subscription_resumed_via_checkout',
              sessionId: session.id,
              subscriptionId,
              timestamp: new Date(),
            });
          }

          break;
        }

        // Update user's subscription status
        await db.collection('users').doc(userId).update({
          'subscription.status': 'active',
          'subscription.stripeSubscriptionId': session.subscription,
          'subscription.updatedAt': new Date().toISOString(),
        });

        // Log the event
        await db.collection('subscription_events').add({
          userId,
          type: 'checkout_completed',
          sessionId: session.id,
          subscriptionId: session.subscription,
          timestamp: new Date(),
        });

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        // Find user by Stripe customer ID
        const usersQuery = await db
          .collection('users')
          .where('stripeCustomerId', '==', customerId)
          .limit(1)
          .get();

        if (usersQuery.empty) {
          console.error('No user found for customer:', customerId);
          break;
        }

        const userDoc = usersQuery.docs[0];
        const userId = userDoc.id;
        const userData = userDoc.data();

        // Get plan details. A subscription may carry two prices (flat base +
        // metered overage); match the base price to resolve the plan.
        const items = subscription.items.data as any[];
        const firstItem = items[0];

        // NEVER fall back to DEFAULT_PLAN for an unmappable price.
        //
        // priceIdToPlan compares the price id against STRIPE_*_PRICE_ID env
        // vars. If a price is rotated in Stripe before this service's env is
        // updated — or the env is otherwise misconfigured — every paid price
        // stops matching, and `|| DEFAULT_PLAN` would write `demo` over an
        // active paid subscription. That is a silent downgrade of a paying
        // customer, applied unattended on an ordinary subscription event, and
        // it would then be enforced by checkItemCreateAllowed on their very
        // next item.
        //
        // Skip the whole write rather than a partial one: we do not know the
        // plan, and an existing customer's already-correct cached plan is
        // better left untouched than overwritten with a record whose plan is
        // wrong or missing but whose updatedAt says "synced". The error log
        // plus scripts/reconcile-subscriptions.ts are the recovery path, and
        // the on-read repair in src/lib/subscription-cache.ts retries once the
        // env is fixed.
        const planName = items.map(it => priceIdToPlan(it?.price?.id)).find(Boolean);
        if (!planName) {
          const priceIds = items.map(it => it?.price?.id).filter(Boolean).join(', ');
          console.error(
            `[stripe-webhook] REFUSING to sync subscription ${subscription.id} for customer ` +
            `${customerId}: none of its price ids [${priceIds}] map to a known plan. This is a ` +
            `configuration problem (a rotated price, or STRIPE_*_PRICE_ID not matching the mode ` +
            `of STRIPE_SECRET_KEY) — NOT a free-plan account. Left the cached subscription ` +
            `untouched; fix the env and run scripts/reconcile-subscriptions.ts.`,
          );
          break;
        }
        const planInfo = { name: planName, units: includedItemsFor(planName) };

        // API-version resilience: current_period_start/end moved from the
        // Subscription to its items in 2025-03-31.basil. Read the top-level
        // field (<=2024 payloads) or fall back to the first item (>=basil,
        // incl. the account-default 2026 endpoint). Guard undefined so a
        // missing value never yields an "Invalid Date".
        const sub = subscription as any;
        const periodStart = sub.current_period_start ?? firstItem?.current_period_start;
        const periodEnd = sub.current_period_end ?? firstItem?.current_period_end;

        // Pay-as-you-go enrollment on a hard-capped tier (Bronze): the customer
        // just put a card behind a $0-base plan by completing Checkout.
        const isEnrollment = event.type === 'customer.subscription.created' &&
          getPlan(planInfo.name).hardCap;

        // FIRST-PERIOD ANCHORING — do not "simplify" this away.
        //
        // Stripe stamps current_period_start = the moment of enrollment. The
        // gate (checkItemCreateAllowed) counts usage from currentPeriodStart, so
        // storing Stripe's value verbatim would make every item the customer
        // already created this month invisible — a user who enrolls at item 25
        // on the 20th would be handed 25 fresh included items, free, and again
        // every month they re-enrolled. Anchor the FIRST period to the calendar
        // month they actually spent those items in. billing_cycle_anchor_config
        // (day_of_month: 1, set at Checkout) makes Stripe's own periods
        // calendar-aligned from period 2 on, so the two agree from then.
        const enrollmentNow = new Date();
        const calendarMonthStart = new Date(Date.UTC(
          enrollmentNow.getUTCFullYear(),
          enrollmentNow.getUTCMonth(),
          1,
        ));
        const storedPeriodStart = isEnrollment
          ? calendarMonthStart.toISOString()
          : (periodStart ? new Date(periodStart * 1000).toISOString() : null);

        // Build update object
        const updateData: Record<string, any> = {
          'subscription.status': subscription.status,
          'subscription.plan': planInfo.name,
          'subscription.units': planInfo.units,
          'subscription.stripeSubscriptionId': subscription.id,
          'subscription.currentPeriodStart': storedPeriodStart,
          'subscription.currentPeriodEnd': periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
          'subscription.updatedAt': new Date().toISOString(),        };

        // The spend cap chosen during enrollment. It rides on the subscription's
        // metadata (not the session's) precisely so an abandoned Checkout writes
        // nothing — see create-checkout-session.ts.
        // Checkout always sends one; the plan default covers anything that doesn't.
        const capUsdRaw = subscription.metadata?.overageLimitUsd;
        if (isEnrollment) {
          const requested = Number(capUsdRaw);
          const capUsd = capUsdRaw && requested > 0 ? requested : defaultOverageCapUsd(planInfo.name);
          const capItems = capUsd != null ? overageDollarsToItems(planInfo.name, capUsd) : null;
          if (capItems != null) {
            updateData['subscription.overageLimitItems'] = capItems;
            updateData['subscription.overageLimitUsd'] = capUsd;
          } else {
            console.error(
              `[stripe-webhook] subscription ${subscription.id}: could not convert enrollment cap ` +
              `"${capUsdRaw}" to items for plan ${planInfo.name}; leaving the cap unset (uncapped).`,
            );
          }
        }

        // A new paid subscription starts capped at its base fee, unless the
        // account already has a cap (or an explicit "no cap"). quick-subscribe
        // writes the same default; this is the path that covers Checkout.
        if (event.type === 'customer.subscription.created' && !isEnrollment) {
          const cap = defaultOverageCapFor(planInfo.name, userData?.subscription);
          if (cap) {
            updateData['subscription.overageLimitUsd'] = cap.overageLimitUsd;
            updateData['subscription.overageLimitItems'] = cap.overageLimitItems;
          }
        }

        // Record trial usage if this is a trialing subscription and user hasn't used trial before
        if (subscription.status === 'trialing' && !userData?.trialUsedAt) {
          updateData.trialUsedAt = new Date().toISOString();
        }

        await db.collection('users').doc(userId).update(updateData);

        // The plan write is the one place every Stripe path converges, so this
        // is where the funnel event belongs — not on each webhook type.
        const previousPlan = userData?.subscription?.plan ?? DEFAULT_PLAN;
        if (isEnrollment && previousPlan === planInfo.name) {
          // Enrolling in pay-as-you-go is not a plan change — the tier is the
          // same on both sides. Reporting it as one would show up in the funnel
          // as a demo→demo "upgrade" worth $0 and inflate the plan-change count.
          emitEvent('payg_enabled', {
            ...actor({ uid: userId }),
            plan: planInfo.name,
            cap_usd: updateData['subscription.overageLimitUsd'] != null
              ? String(updateData['subscription.overageLimitUsd'])
              : 'unlimited',
          });
        } else {
          emitPlanChanged({
            uid: userId,
            from: previousPlan,
            to: planInfo.name,
            reason: 'subscription_sync',
          });
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        // Find user by Stripe customer ID
        const usersQuery = await db
          .collection('users')
          .where('stripeCustomerId', '==', customerId)
          .limit(1)
          .get();

        if (usersQuery.empty) {
          console.error('No user found for customer:', customerId);
          break;
        }

        const userDoc = usersQuery.docs[0];
        const userId = userDoc.id;

        // Always log the cancellation.
        await db.collection('subscription_events').add({
          userId,
          type: 'subscription_canceled',
          subscriptionId: subscription.id,
          timestamp: new Date(),
        });

        // Guard against out-of-order delivery: cancel-old + create-new (a common
        // re-subscribe pattern) can deliver this delete AFTER the new sub's
        // created/updated event. If the customer still has another active/
        // trialing subscription, this delete is for a superseded sub — do NOT
        // reset to free (that new sub's created/updated event governs the plan).
        const [activeSubs, trialingSubs] = await Promise.all([
          stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 3 }),
          stripe.subscriptions.list({ customer: customerId, status: 'trialing', limit: 3 }),
        ]);
        const otherLive = [...activeSubs.data, ...trialingSubs.data].filter(s => s.id !== subscription.id);
        if (otherLive.length > 0) {
          console.log(`subscription.deleted ${subscription.id}: customer ${customerId} still has ${otherLive.length} active/trialing sub(s); not resetting to free`);
          break;
        }

        // No other live subscription — reset to free tier.
        await db.collection('users').doc(userId).update({
          'subscription.status': 'canceled',
          'subscription.plan': DEFAULT_PLAN,
          'subscription.units': includedItemsFor(DEFAULT_PLAN),
          'subscription.stripeSubscriptionId': null,
          'subscription.canceledAt': new Date().toISOString(),
        });

        emitPlanChanged({
          uid: userId,
          from: userDoc.data()?.subscription?.plan ?? DEFAULT_PLAN,
          to: DEFAULT_PLAN,
          reason: 'subscription_sync',
        });

        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Find user by Stripe customer ID
        const usersQuery = await db
          .collection('users')
          .where('stripeCustomerId', '==', customerId)
          .limit(1)
          .get();

        if (!usersQuery.empty) {
          const userDoc = usersQuery.docs[0];
          const userId = userDoc.id;

          // Log successful payment
          await db.collection('payment_events').add({
            userId,
            type: 'invoice_paid',
            invoiceId: invoice.id,
            amount: invoice.amount_paid / 100,
            timestamp: new Date(),
          });

          if ((invoice as any).subscription ?? (invoice as any).parent?.subscription_details?.subscription) {
            // Subscription invoice: reset the item counter for the new billing
            // period. Any metered overage for the period just ended is already
            // billed on this invoice by Stripe (arrears).
            // invoice.subscription moved to invoice.parent.subscription_details
            // .subscription in 2025-03-31.basil; accept either shape.
            await db.collection('usage').doc(userId).set({
              currentMonthTotal: 0,
              lastReset: new Date().toISOString(),
            }, { merge: true });

            // Clear preserved allocation on renewal (subscription invoice paid)
            // This happens when a downgraded plan renews for the first time
            const userData = userDoc.data();
            if (userData?.subscription?.preservedAllocation) {
              await db.collection('users').doc(userId).update({
                'subscription.preservedAllocation': admin.firestore.FieldValue.delete(),
                'subscription.preservedUntil': admin.firestore.FieldValue.delete(),
              });
            }
          }
        }

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Find user by Stripe customer ID
        const usersQuery = await db
          .collection('users')
          .where('stripeCustomerId', '==', customerId)
          .limit(1)
          .get();

        if (!usersQuery.empty) {
          const userDoc = usersQuery.docs[0];
          const userId = userDoc.id;

          // Log failed payment
          await db.collection('payment_events').add({
            userId,
            type: 'payment_failed',
            invoiceId: invoice.id,
            amount: invoice.amount_due / 100,
            timestamp: new Date(),
            error: 'Payment failed',
          });

          // Update subscription status
          await db.collection('users').doc(userId).update({
            'subscription.paymentStatus': 'failed',
            'subscription.paymentFailedAt': new Date().toISOString(),
          });
        }

        break;
      }

      case 'payment_method.attached': {
        const paymentMethod = event.data.object as Stripe.PaymentMethod;
        const customerId = paymentMethod.customer as string;

        // Find user by Stripe customer ID
        const usersQuery = await db
          .collection('users')
          .where('stripeCustomerId', '==', customerId)
          .limit(1)
          .get();

        if (!usersQuery.empty) {
          const userDoc = usersQuery.docs[0];
          const userId = userDoc.id;

          // Log payment method addition
          await db.collection('payment_events').add({
            userId,
            type: 'payment_method_added',
            paymentMethodId: paymentMethod.id,
            brand: paymentMethod.card?.brand,
            last4: paymentMethod.card?.last4,
            timestamp: new Date(),
          });
        }

        // Collapse duplicate cards (same fingerprint). Isolated so a failure
        // here never fails the webhook (which would trigger Stripe retries).
        try {
          const result = await dedupePaymentMethods(stripe, customerId, paymentMethod.id);
          if (result?.detached.length) {
            console.log('Deduped payment methods', { customerId, ...result });
          }
        } catch (e) {
          console.error('Payment method dedup failed:', e);
        }

        break;
      }

      case 'setup_intent.succeeded': {
        const setupIntent = event.data.object as Stripe.SetupIntent;
        const customerId = setupIntent.customer as string;

        if (customerId) {
          // Find user by Stripe customer ID
          const usersQuery = await db
            .collection('users')
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();

          if (!usersQuery.empty) {
            const userDoc = usersQuery.docs[0];
            const userId = userDoc.id;

            // Log successful setup
            await db.collection('payment_events').add({
              userId,
              type: 'setup_intent_succeeded',
              setupIntentId: setupIntent.id,
              paymentMethodId: setupIntent.payment_method,
              timestamp: new Date(),
            });
          }
        }

        break;
      }

      default:
        // Unhandled event type
    }

    // Log all webhook events for debugging
    await db.collection('webhook_events').add({
      type: event.type,
      eventId: event.id,
      timestamp: new Date(),
      processed: true,
    });

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);

    // Log the error
    await db.collection('webhook_events').add({
      type: event.type,
      eventId: event.id,
      timestamp: new Date(),
      processed: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    // Return 200 to acknowledge receipt (prevents Stripe from retrying)
    res.status(200).json({ received: true, error: true });
  }
}