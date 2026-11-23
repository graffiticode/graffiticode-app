#!/usr/bin/env node
/**
 * Exercise the saved-card subscribe flow and duplicate-card reconciliation
 * against Stripe TEST mode. Refuses any key that isn't sk_test_.
 *
 * Creates its own product and price (reused across runs) and one customer per
 * scenario, tagged metadata.gc_billing_test; customers are deleted at the end
 * unless --keep is passed.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-test-mode-billing.ts [--keep]
 *
 * Not covered here: completing a real 3D Secure challenge (that needs a
 * browser; the script settles the payment server-side with another test card
 * instead) and Checkout's hosted page (the script reproduces its result: a
 * second copy of the card, attached, billing a new subscription).
 */
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '@graffiticode-app/core/lib/plans-config';
import { memoryCustomerLock } from '../src/lib/billing-customer-lock';
import { CHECKOUT_TTL_S } from '../src/lib/billing-purchase';
import { claimWrite, landedKeys, readCustomerPaymentState, reconcileDuplicateCards } from '../src/lib/billing-payment-methods';
import { createReservedCheckoutSession, finalizeSavedCardSubscription, startSavedCardSubscription } from '../src/lib/billing-purchase';

const KEY = process.env.STRIPE_SECRET_KEY ?? '';
if (!KEY.startsWith('sk_test_')) {
  console.error('Refusing: STRIPE_SECRET_KEY must be a test-mode key (sk_test_...).');
  process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
const lock = memoryCustomerLock();
const KEEP = process.argv.includes('--keep');
const created: string[] = [];
const key = () => `att_${crypto.randomUUID().replace(/-/g, '')}`;

async function annualPrice(monthly: string): Promise<string> {
  const m = await stripe.prices.retrieve(monthly);
  for await (const p of stripe.prices.list({ product: m.product as string, active: true, limit: 100 })) {
    if (p.recurring?.interval === 'year') return p.id;
  }
  return (await stripe.prices.create({ product: m.product as string, currency: 'usd', unit_amount: 10000, recurring: { interval: 'year' } })).id;
}
const piOfSub = async (subId: string) => {
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ['latest_invoice.payments'] });
  return (sub.latest_invoice as Stripe.Invoice).payments!.data[0].payment.payment_intent as string;
};

async function testPrice(): Promise<string> {
  for await (const p of stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] })) {
    if ((p.product as Stripe.Product).metadata?.gc_billing_test === '1') return p.id;
  }
  const product = await stripe.products.create({ name: 'gc billing test (test mode)', metadata: { gc_billing_test: '1' } });
  const price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } });
  return price.id;
}

async function customer(card?: string): Promise<{ id: string; pm: string | null }> {
  const c = await stripe.customers.create({ metadata: { gc_billing_test: '1' } });
  created.push(c.id);
  if (!card) return { id: c.id, pm: null };
  const pm = await attach(c.id, card);
  await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: pm } });
  return { id: c.id, pm };
}
async function attach(customerId: string, card: string) {
  return (await stripe.paymentMethods.attach(card, { customer: customerId })).id;
}
async function attachedCards(customerId: string) {
  return (await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 100 })).data.map((m) => m.id).sort();
}
async function openSubs(customerId: string) {
  return (await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })).data
    .filter((s) => !['canceled', 'incomplete_expired'].includes(s.status));
}
async function defaultOf(customerId: string) {
  const c = await stripe.customers.retrieve(customerId) as Stripe.Customer;
  return c.invoice_settings?.default_payment_method as string | null;
}
const sessionParams = (customerId: string, price: string): Stripe.Checkout.SessionCreateParams => ({
  customer: customerId, mode: 'subscription', line_items: [{ price, quantity: 1 }],
  success_url: 'https://example.test/ok', cancel_url: 'https://example.test/no',
});
const reconcile = (customerId: string) => reconcileDuplicateCards(stripe, customerId, { mode: 'apply', lock, waitMs: 30_000 });

const scenarios: Array<[string, (price: string) => Promise<void>]> = [
  ['differing fingerprints are left alone', async () => {
    const c = await customer('pm_card_visa');
    await attach(c.id, 'pm_card_mastercard');
    await attach(c.id, 'pm_card_amex');
    const before = await attachedCards(c.id);
    const r = await reconcile(c.id);
    assert.deepEqual(r!.plan.detach, []);
    assert.deepEqual(await attachedCards(c.id), before);
  }],

  ['saved card pays: one active subscription, no new card', async (price) => {
    const c = await customer('pm_card_visa');
    const out = await startSavedCardSubscription(stripe, lock, { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: key(), items: [{ price }] });
    assert.equal(out.kind, 'active');
    assert.equal((await openSubs(c.id)).length, 1);
    assert.deepEqual(await attachedCards(c.id), [c.pm]);
  }],

  ['concurrent retries: same key and different keys leave one subscription', async (price) => {
    const c = await customer('pm_card_visa');
    const k = key();
    const p = { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, items: [{ price }] };
    const outs = await Promise.all([
      startSavedCardSubscription(stripe, lock, { ...p, attemptKey: k }),
      startSavedCardSubscription(stripe, lock, { ...p, attemptKey: k }),
      startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() }),
    ]);
    assert.ok(outs.every((o) => o.kind === 'active' || o.kind === 'has_subscription'), JSON.stringify(outs.map((o) => o.kind)));
    assert.equal((await openSubs(c.id)).length, 1);
  }],

  ['authentication required: requires_action, retries resume, a new attempt replaces it, payment completes', async (price) => {
    const c = await customer('pm_card_authenticationRequired');
    const p = { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, items: [{ price }] };
    const k = key();
    const first = await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: k });
    assert.equal(first.kind, 'requires_action', JSON.stringify(first));
    const again = await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: k });
    assert.equal(again.kind, 'requires_action');
    assert.equal((again as any).subscriptionId, (first as any).subscriptionId);
    assert.equal((await openSubs(c.id)).length, 1);

    const second = await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() });
    assert.equal(second.kind, 'requires_action');
    assert.equal((await stripe.subscriptions.retrieve((first as any).subscriptionId)).status, 'incomplete_expired');
    assert.equal((await openSubs(c.id)).length, 1);

    assert.equal((await finalizeSavedCardSubscription(stripe, lock, { customerId: c.id, subscriptionId: (second as any).subscriptionId })).kind, 'requires_action');
    // Settle the payment server-side, as a completed challenge would.
    const sub = await stripe.subscriptions.retrieve((second as any).subscriptionId, { expand: ['latest_invoice.payments'] });
    const piId = (sub.latest_invoice as Stripe.Invoice).payments!.data[0].payment.payment_intent as string;
    await stripe.paymentIntents.confirm(piId, { payment_method: 'pm_card_visa' });
    const done = await finalizeSavedCardSubscription(stripe, lock, { customerId: c.id, subscriptionId: (second as any).subscriptionId });
    assert.equal(done.kind, 'active', JSON.stringify(done));
  }],

  ['decline: no subscription is left, and a new attempt may try again', async (price) => {
    const c = await customer('pm_card_chargeCustomerFail');
    const p = { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, items: [{ price }] };
    const out = await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() });
    assert.equal(out.kind, 'declined', JSON.stringify(out));
    assert.equal((await openSubs(c.id)).length, 0);
    assert.equal((await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() })).kind, 'declined');
    assert.equal((await openSubs(c.id)).length, 0);
  }],

  ['Checkout replaces a stale authentication attempt', async (price) => {
    const c = await customer('pm_card_authenticationRequired');
    await startSavedCardSubscription(stripe, lock, { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: key(), items: [{ price }] });
    const out = await createReservedCheckoutSession(stripe, lock, c.id, () => sessionParams(c.id, price));
    assert.equal(out.kind, 'created');
    assert.equal((await openSubs(c.id)).length, 0);
  }],

  ['a saved-card purchase expires an open Checkout session, which then cannot be paid', async (price) => {
    const c = await customer('pm_card_visa');
    const out = await createReservedCheckoutSession(stripe, lock, c.id, () => sessionParams(c.id, price));
    assert.equal(out.kind, 'created');
    const sessionId = (out as any).session.id;
    const exp = (out as any).session.expires_at - Math.floor(Date.now() / 1000);
    assert.ok(exp > 29 * 60 && exp <= 32 * 60, `expires in ${exp}s`);
    assert.equal((await startSavedCardSubscription(stripe, lock, { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: key(), items: [{ price }] })).kind, 'active');
    assert.equal((await stripe.checkout.sessions.retrieve(sessionId)).status, 'expired');
    assert.equal((await createReservedCheckoutSession(stripe, lock, c.id, () => sessionParams(c.id, price))).kind, 'has_subscription');
    assert.equal((await openSubs(c.id)).length, 1);
  }],

  ['a replayed successful attempt reports the canceled subscription as ended', async (price) => {
    const c = await customer('pm_card_visa');
    const p = { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: key(), items: [{ price }] };
    const first = await startSavedCardSubscription(stripe, lock, p);
    assert.equal(first.kind, 'active');
    await stripe.subscriptions.cancel((first as any).subscription.id);
    assert.equal((await startSavedCardSubscription(stripe, lock, p)).kind, 'ended');
  }],

  ['replacement after the payment completed keeps the original: voiding a paid invoice is refused', async (price) => {
    const c = await customer('pm_card_authenticationRequired');
    const p = { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, items: [{ price }] };
    const first = (await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() })) as any;
    assert.equal(first.kind, 'requires_action');
    await stripe.paymentIntents.confirm(await piOfSub(first.subscriptionId), { payment_method: 'pm_card_visa' }); // completes first
    const second = await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() });
    assert.equal(second.kind, 'has_subscription', JSON.stringify(second));
    assert.equal((await openSubs(c.id)).length, 1);
    assert.equal((await stripe.subscriptions.retrieve(first.subscriptionId)).status, 'active');
  }],

  ['replacement voids the waiting invoice first, after which its payment cannot complete', async (price) => {
    const c = await customer('pm_card_authenticationRequired');
    const p = { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, items: [{ price }] };
    const first = (await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() })) as any;
    const pi = await piOfSub(first.subscriptionId);
    assert.equal((await startSavedCardSubscription(stripe, lock, { ...p, attemptKey: key() })).kind, 'requires_action');
    await assert.rejects(stripe.paymentIntents.confirm(pi, { payment_method: 'pm_card_visa' }));
    assert.equal((await stripe.paymentIntents.retrieve(pi)).status, 'canceled');
    assert.equal((await openSubs(c.id)).length, 1);
  }],

  ['an open Checkout session with no reservation is expired by a saved-card purchase', async (price) => {
    const c = await customer('pm_card_visa');
    const legacy = await stripe.checkout.sessions.create(sessionParams(c.id, price));
    assert.equal((await startSavedCardSubscription(stripe, lock, { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: key(), items: [{ price }] })).kind, 'active');
    assert.equal((await stripe.checkout.sessions.retrieve(legacy.id)).status, 'expired');
  }],

  ['an attempt key reused for a different price is refused', async (price) => {
    const c = await customer('pm_card_visa');
    const k = key();
    const base = { customerId: c.id, userId: 'test', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: k };
    assert.equal((await startSavedCardSubscription(stripe, lock, { ...base, planId: 'pro', items: [{ price }] })).kind, 'active');
    const other = await startSavedCardSubscription(stripe, lock, { ...base, planId: 'platinum', interval: 'annual', items: [{ price: await annualPrice(price) }] });
    assert.equal(other.kind, 'mismatch');
    assert.equal((await openSubs(c.id)).length, 1);
  }],

  ['a Checkout replay with a stale expiry is rejected by Stripe and cleared, not left blocking', async (price) => {
    const c = await customer('pm_card_visa');
    const stale = { ...sessionParams(c.id, price), expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S - 120 - 60 };
    await lock.run(c.id, (l) => l.reserve({ kind: 'checkout', idempotencyKey: `checkout-session:${c.id}:${key()}`, params: stale as any, createdAt: Date.now() - 120_000 }));
    assert.equal((await startSavedCardSubscription(stripe, lock, { customerId: c.id, userId: 'test', planId: 'pro', interval: 'monthly', paymentMethodId: c.pm!, attemptKey: key(), items: [{ price }] })).kind, 'active');
    assert.equal(await lock.run(c.id, (l) => l.reservation()), null);
    const sessions = await stripe.checkout.sessions.list({ customer: c.id, limit: 10 });
    assert.equal(sessions.data.length, 0, 'the rejected replay created nothing');
  }],

  ['a claim fences off a write that never reached Stripe; a claim on an applied write reports it applied', async () => {
    const c = await customer('pm_card_visa');
    const other = await attach(c.id, 'pm_card_mastercard');
    const w = (k: string, kind: 'set-default' | 'detach' = 'set-default') => ({ id: k, kind, target: other, idempotencyKey: k, sinceSeq: 0, at: 0 });
    // Never sent: the claim takes the key, and the original arriving later is refused.
    const unsent = `gc-test-${key()}`;
    assert.equal(await claimWrite(stripe, c.id, w(unsent)), 'never-applied');
    await assert.rejects(
      stripe.customers.update(c.id, { invoice_settings: { default_payment_method: other } }, { idempotencyKey: unsent }),
      (e: any) => e?.type === 'StripeIdempotencyError',
    );
    assert.equal(await defaultOf(c.id), c.pm, 'the fenced write did not apply');
    // Applied first (an update, and a detach on another endpoint): the claim is refused as a reused key.
    const sent = `gc-test-${key()}`;
    await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: other } }, { idempotencyKey: sent });
    assert.equal(await claimWrite(stripe, c.id, w(sent)), 'applied');
    const spare = await attach(c.id, 'pm_card_amex');
    const detached = `gc-test-${key()}`;
    await stripe.paymentMethods.detach(spare, {}, { idempotencyKey: detached });
    assert.equal(await claimWrite(stripe, c.id, w(detached, 'detach')), 'applied');
  }],

  ['Stripe events name the idempotency key of the write that caused them', async () => {
    const c = await customer('pm_card_visa');
    const other = await attach(c.id, 'pm_card_mastercard');
    const spare = await attach(c.id, 'pm_card_amex');
    const at = Date.now();
    const w = (k: string, kind: 'set-default' | 'detach', target: string) => ({ id: k, kind, target, idempotencyKey: k, sinceSeq: 0, at });
    const ku = `gc-test-${key()}`, kd = `gc-test-${key()}`, never = `gc-test-${key()}`;
    const opts = (k: string) => ({ idempotencyKey: k, timeout: 20_000, maxNetworkRetries: 0 as const });
    await stripe.customers.update(c.id, { invoice_settings: { default_payment_method: other } }, opts(ku));
    await stripe.paymentMethods.detach(spare, {}, opts(kd));
    let found = new Set<string>();
    for (let i = 0; i < 10 && found.size < 2; i++) { // events can take a moment to list
      await new Promise((r) => setTimeout(r, 1500));
      found = await landedKeys(stripe, [w(ku, 'set-default', other), w(kd, 'detach', spare), w(never, 'set-default', other)]);
    }
    assert.deepEqual([...found].sort(), [ku, kd].sort());
  }],

  ['event orders: attach during open Checkout defers; after it settles both orders converge', async (price) => {
    // Order 1: attach while a Checkout session is open, subscription after.
    const a = await customer('pm_card_visa');
    const session = await stripe.checkout.sessions.create({ customer: a.id, mode: 'subscription', line_items: [{ price, quantity: 1 }], success_url: 'https://example.test/ok', cancel_url: 'https://example.test/no' });
    const freshA = await attach(a.id, 'pm_card_visa');
    const early = await reconcile(a.id);
    assert.ok(early!.plan.deferred.some((d) => d.includes('checkout session')), JSON.stringify(early!.plan));
    assert.deepEqual(await attachedCards(a.id), [a.pm!, freshA].sort());
    await stripe.subscriptions.create({ customer: a.id, items: [{ price }], default_payment_method: freshA });
    await stripe.checkout.sessions.expire(session.id);
    await reconcile(a.id);

    // Order 2: subscription first, the attach event delivered late.
    const b = await customer('pm_card_visa');
    const freshB = await attach(b.id, 'pm_card_visa');
    await stripe.subscriptions.create({ customer: b.id, items: [{ price }], default_payment_method: freshB });
    await reconcile(b.id);
    await reconcile(b.id);

    assert.deepEqual(await attachedCards(a.id), [freshA]);
    assert.deepEqual(await attachedCards(b.id), [freshB]);
    assert.equal(await defaultOf(a.id), freshA);
    assert.equal(await defaultOf(b.id), freshB);
  }],

  ['duplicate deliveries and concurrent reconciliations detach each copy once', async (price) => {
    const c = await customer('pm_card_visa');
    const fresh = await attach(c.id, 'pm_card_visa');
    await attach(c.id, 'pm_card_visa');
    await stripe.subscriptions.create({ customer: c.id, items: [{ price }], default_payment_method: fresh });
    const results = await Promise.all([reconcile(c.id), reconcile(c.id), reconcile(c.id)]);
    assert.equal(results.reduce((n, r) => n + r!.detached.length, 0), 2);
    assert.equal((await reconcile(c.id))!.detached.length, 0);
    assert.deepEqual(await attachedCards(c.id), [fresh]);
  }],

  ['multiple subscriptions keep the copy each one bills', async (price) => {
    const c = await customer('pm_card_visa');
    const x = await attach(c.id, 'pm_card_visa');
    const y = await attach(c.id, 'pm_card_visa');
    const spare = await attach(c.id, 'pm_card_visa');
    await stripe.subscriptions.create({ customer: c.id, items: [{ price }], default_payment_method: x });
    await stripe.subscriptions.create({ customer: c.id, items: [{ price }], default_payment_method: y });
    const r = await reconcile(c.id);
    assert.deepEqual(r!.detached.sort(), [c.pm!, spare].sort());
    assert.deepEqual(await attachedCards(c.id), [x, y].sort());
  }],

  ['a payment awaiting authentication defers reconciliation', async (price) => {
    const c = await customer('pm_card_visa');
    const pending = await attach(c.id, 'pm_card_authenticationRequired');
    await attach(c.id, 'pm_card_visa');
    await stripe.paymentIntents.create({ customer: c.id, amount: 500, currency: 'usd', payment_method: pending, confirm: true, payment_method_types: ['card'] });
    const state = await readCustomerPaymentState(stripe, c.id);
    assert.ok(state.unsettled.some((u) => u.includes('requires_action')), JSON.stringify(state.unsettled));
    const before = await attachedCards(c.id);
    const r = await reconcile(c.id);
    assert.ok(r!.plan.deferred.length > 0);
    assert.deepEqual(await attachedCards(c.id), before);
    void price;
  }],
];

async function main() {
  const price = await testPrice();
  let failed = 0;
  for (const [name, run] of scenarios) {
    try {
      await run(price);
      console.log(`ok    ${name}`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL  ${name}\n      ${e?.message?.split('\n').join('\n      ')}`);
    }
  }
  if (!KEEP) for (const id of created) await stripe.customers.del(id).catch(() => {});
  console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios passed${KEEP ? ` (kept ${created.length} test customers)` : ''}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
