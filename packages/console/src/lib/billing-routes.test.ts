/**
 * Regressions at the route boundary: the real route sources, loaded with a
 * stand-in Stripe, Firestore and auth, sharing one customer lock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStripe } from './fixtures/fake-stripe';
import { fakeUsersDb, loadRoute, response } from './fixtures/load-route';
import * as lockModule from './billing-customer-lock';
import * as purchaseModule from './billing-purchase';
import { reconcileDuplicateCards } from './billing-payment-methods';
import { sweepCustomer } from './billing-sweep';
import { firestoreReconcileQueue } from './billing-reconcile-queue';
import { fakeFirestore } from './fixtures/fake-firestore';
import { readFileSync } from 'node:fs';

const KEY_A = 'attempt-aaaaaaaaaaaaaaaa';

function world(opts: { now?: () => number; behaviour?: 'ok' | 'auth'; basePrice?: (plan: string, interval: string) => string; lock?: lockModule.CustomerLock } = {}) {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const pm = s.addCard(cus, 'fp_A', opts.behaviour ?? 'ok');
  s.customersById.get(cus).invoice_settings.default_payment_method = pm;
  const lock = opts.lock ?? lockModule.memoryCustomerLock(opts.now ?? Date.now);
  const users = fakeUsersDb({ stripeCustomerId: cus, subscription: { plan: 'demo' } });

  const common = {
    stripe: function Stripe() { return s; },
    '@graffiticode-app/core/utils/db/index': { getFirestore: () => users.db },
    '../../../lib/api-auth': { requireUser: async () => ({ uid: 'u1' }) },
    '../../../../lib/api-auth': { requireUser: async () => ({ uid: 'u1' }) },
    '../../../lib/with-installation': { withInstallation: (fn: any) => fn },
    '../../../../lib/with-installation': { withInstallation: (fn: any) => fn },
    '../../../lib/billing-customer-lock': { ...lockModule, firestoreCustomerLock: () => lock },
    '../../../../lib/billing-customer-lock': { ...lockModule, firestoreCustomerLock: () => lock },
    '../../../lib/billing-purchase': purchaseModule,
  };
  const plans = {
    STRIPE_API_VERSION: 'test',
    stripeBasePriceId: opts.basePrice ?? ((plan: string, interval: string) => `price_${plan}_${interval}`),
    stripeMeterPriceId: () => null,
    getPlan: () => ({ hardCap: false, overageRatePerItem: null }),
    defaultOverageCapUsd: () => 10,
    priceIdToPlan: (id?: string) => /^price_(pro|platinum)_/.exec(id ?? '')?.[1] ?? null,
    includedItemsFor: () => 500,
    isUpgrade: () => true,
    overageDollarsToItems: () => 50,
    defaultOverageCapFor: () => null,
    DEFAULT_PLAN: 'demo',
    PLANS: { pro: {}, platinum: {}, demo: {} },
  };
  const env = { STRIPE_SECRET_KEY: 'sk_test_route_only', NEXT_PUBLIC_URL: 'https://console.test' };
  const checkoutRoute = loadRoute('src/pages/api/payments/create-checkout-session.ts', {
    ...common,
    '@graffiticode-app/core/lib/plans-config': plans,
    '@graffiticode-app/core/lib/funnel-events': { emitEvent: () => {}, actor: () => ({}) },
  }, env);
  const quickRoute = loadRoute('src/pages/api/payments/quick-subscribe.ts', {
    ...common,
    '@graffiticode-app/core/lib/plans-config': plans,
    '@graffiticode-app/core/lib/stripe-helpers': { subscriptionPeriodEnd: () => null },
    '@graffiticode-app/core/lib/funnel-events': { emitPlanChanged: () => {}, hashUid: () => 'h' },
    'firebase-admin': { firestore: { FieldValue: { delete: () => '__delete__' } } },
  }, env);
  const setDefaultRoute = loadRoute('src/pages/api/payments/methods/set-default.ts', {
    ...common,
    '@graffiticode-app/core/lib/plans-config': plans,
  }, env);

  const call = async (route: (req: any, res: any) => Promise<unknown>, body: any) => {
    const res = response();
    await route({ method: 'POST', body, headers: {} }, res);
    return res;
  };
  return {
    s, cus, pm, lock, users,
    checkout: () => call(checkoutRoute, { planId: 'pro', interval: 'monthly' }),
    finalize: (subscriptionId: string) => call(quickRoute, { finalizeSubscriptionId: subscriptionId }),
    saved: (body: any = {}) => call(quickRoute, { planId: 'pro', interval: 'monthly', paymentMethodId: pm, attemptKey: KEY_A, confirmed: true, ...body }),
    setDefault: (methodId: string) => call(setDefaultRoute, { methodId }),
  };
}

const active = (s: FakeStripe, cus: string) => s.subsOf(cus, 'active');
function gate() {
  let release!: () => void;
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  return { entered, enteredP, release, releaseP };
}

// Review #2, as reproduced: Checkout paused creating its session while a saved-card purchase runs.
test('route: a Checkout session paused mid-create cannot complete into a second subscription', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const g = gate();
  const create = w.s.checkout.sessions.create;
  let paused = false;
  w.s.checkout.sessions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return create(p, o);
  };
  const checkout = w.checkout();
  await g.enteredP;
  now = lockModule.LEASE_MS + 1; // the paused request's lease runs out
  const saved = await w.saved();
  assert.equal(saved.code, 200);
  assert.equal(saved.body.success, true);
  g.release();
  const res = await checkout;
  assert.equal(res.code, 409); // no URL for a session that can't complete
  for (const sess of w.s.sessions.values()) {
    assert.notEqual(sess.status, 'open');
    assert.throws(() => w.s.completeCheckout(sess.id, w.pm));
  }
  assert.equal(active(w.s, w.cus).length, 1);
});

test('route: while Checkout holds the lease, a saved-card purchase waits for it, then expires the session', async () => {
  const w = world();
  const g = gate();
  const create = w.s.checkout.sessions.create;
  let paused = false;
  w.s.checkout.sessions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return create(p, o);
  };
  const checkout = w.checkout();
  await g.enteredP;
  const saved = w.saved();
  setTimeout(g.release, 50);
  const [c, sv] = await Promise.all([checkout, saved]);
  assert.equal(c.code, 200);
  assert.equal(sv.body.success, true);
  const sessionId = [...w.s.sessions.keys()][0];
  assert.equal(w.s.sessions.get(sessionId).status, 'expired');
  assert.throws(() => w.s.completeCheckout(sessionId, w.pm));
  assert.equal(active(w.s, w.cus).length, 1);
});

// Review #1 at the route.
test('route: a saved-card request whose lease expired mid-create and a second request yield one subscription', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const g = gate();
  const create = w.s.subscriptions.create;
  let paused = false;
  w.s.subscriptions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return create(p, o);
  };
  const first = w.saved({ attemptKey: KEY_A });
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  const second = await w.saved({ attemptKey: 'attempt-bbbbbbbbbbbbbbbb' });
  g.release();
  const one = await first;
  assert.equal(second.code, 409);
  assert.equal(second.body.hasSubscription, true);
  assert.equal(one.body.success, true);
  assert.equal(active(w.s, w.cus).length, 1);
});

// Review #3 at the route.
test('route: retrying a successful attempt after its subscription was canceled reports it ended and writes nothing', async () => {
  const w = world();
  const first = await w.saved();
  assert.equal(first.body.success, true);
  const writes = w.users.updates.length;
  await w.s.subscriptions.cancel(first.body.subscription.id);
  const retry = await w.saved();
  assert.equal(retry.code, 409);
  assert.equal(retry.body.attemptEnded, true);
  assert.equal(w.users.updates.length, writes);
});

test('route: the saved-card path needs an explicit confirmation and creates nothing without it', async () => {
  const w = world();
  const preview = await w.saved({ preview: true, confirmed: undefined });
  assert.equal(preview.code, 200);
  assert.equal(preview.body.savedCard.id, w.pm);
  const unconfirmed = await w.saved({ confirmed: undefined });
  assert.equal(unconfirmed.code, 400);
  assert.equal(unconfirmed.body.requiresConfirmation, true);
  assert.ok(!w.s.calls.includes('subscriptions.create'));
});

// Review #4: a console default change and reconciliation never interleave.
test('route: a default change made while reconciliation runs waits for it and is not overwritten', async () => {
  const w = world();
  const fresh = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  w.s.addSubscription(w.cus, fresh);
  const g = gate();
  const update = w.s.customers.update;
  let paused = false;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return update(id, p, o);
  };
  const reconcile = reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  await g.enteredP; // reconciliation is about to re-point the default
  const choice = w.setDefault(other); // the user picks a different card meanwhile
  setTimeout(g.release, 30);
  const [r, res] = await Promise.all([reconcile, choice]);
  assert.equal(r!.defaultSet, fresh);
  assert.equal(res.code, 200);
  assert.equal(w.s.defaultOf(w.cus), other); // the user's later choice stands
});

// Second review #3: an attempt key names one purchase, and the route writes what was bought.
test('route: recovering a reserved Pro purchase under a Platinum/annual request is refused and writes nothing', async () => {
  const w = world();
  await w.lock.run(w.cus, (l) => l.reserve({
    kind: 'saved-card', attemptKey: KEY_A, idempotencyKey: `saved-card-subscribe:${w.cus}:${KEY_A}`, createdAt: Date.now(),
    params: { customer: w.cus, items: [{ price: 'price_pro_monthly' }], default_payment_method: w.pm, payment_behavior: 'allow_incomplete',
      expand: ['latest_invoice.payments'], metadata: { userId: 'u1', planId: 'pro', interval: 'monthly', attemptKey: KEY_A, source: 'saved-card' } },
  }));
  const res = await w.saved({ planId: 'platinum', interval: 'annual' });
  assert.equal(res.code, 409);
  assert.equal(res.body.attemptMismatch, true);
  assert.equal(w.users.updates.length, 0);
  const subs = active(w.s, w.cus);
  assert.equal(subs.length, 1); // the reserved, confirmed Pro purchase
  assert.equal(subs[0].items.data[0].price.id, 'price_pro_monthly');
});

test('route: a successful purchase writes the plan and interval of the subscription’s price', async () => {
  const w = world();
  const res = await w.saved({ planId: 'platinum', interval: 'annual' });
  assert.equal(res.body.success, true);
  assert.deepEqual([res.body.subscription.plan, res.body.subscription.interval], ['platinum', 'annual']);
  const write = w.users.updates.at(-1)!;
  assert.deepEqual([write['subscription.plan'], write['subscription.interval']], ['platinum', 'annual']);
  assert.equal(active(w.s, w.cus)[0].items.data[0].price.id, 'price_platinum_annual');
});

// Second review #5: reconciliation's update lands after its lease expired and a console choice was made.
test('route: a console choice made while a stalled reconciliation lost its lease is restored', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const keeper = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, keeper);
  const g = gate();
  const update = w.s.customers.update;
  let paused = false;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return update(id, p, o);
  };
  const reconcile = reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  const chosen = await w.setDefault(other);
  assert.equal(chosen.code, 200);
  g.release();
  const r = await reconcile;
  assert.equal(r!.repairedChoice, other);
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
});

// Second review #2 at the route: a session issued before reservations existed.
test('route: an open Checkout session with no reservation is expired by a saved-card purchase', async () => {
  const w = world();
  const legacy = await w.s.checkout.sessions.create({ customer: w.cus, mode: 'subscription', line_items: [{ price: 'price_pro_monthly', quantity: 1 }] });
  assert.equal(await w.lock.run(w.cus, (l) => l.reservation()), null);
  assert.equal((await w.saved()).body.success, true);
  assert.equal(w.s.sessions.get(legacy.id).status, 'expired');
  assert.throws(() => w.s.completeCheckout(legacy.id, w.pm));
  assert.equal(active(w.s, w.cus).length, 1);
});

test('route: finalize writes the plan of the subscription\u2019s price, not its metadata or the request', async () => {
  const w = world({ behaviour: 'auth' });
  const started = await w.saved();
  assert.equal(started.body.requiresAction, true);
  const sub = w.s.subs.get(started.body.subscriptionId);
  sub.metadata.planId = 'platinum'; // metadata is not the entitlement
  sub.metadata.interval = 'annual';
  w.s.authenticate(w.s.invoicesById.get(sub.latest_invoice).payments.data[0].payment.payment_intent, true);
  const done = await w.finalize(started.body.subscriptionId);
  assert.equal(done.body.success, true);
  const write = w.users.updates.at(-1)!;
  assert.deepEqual([write['subscription.plan'], write['subscription.interval']], ['pro', 'monthly']);
});

test('route: when a requested plan\u2019s price maps to another plan, the price\u2019s plan is written', async () => {
  // e.g. a price rotated in Stripe ahead of the env: what was bought is what is granted.
  const w = world({ basePrice: () => 'price_pro_monthly' });
  const res = await w.saved({ planId: 'platinum', interval: 'annual' });
  assert.equal(res.body.success, true);
  const write = w.users.updates.at(-1)!;
  assert.deepEqual([write['subscription.plan'], write['subscription.interval']], ['pro', 'monthly']);
});

// Third review #1: the stale write applies but its response is lost.
test('route: a reconciliation write whose response is lost is still repaired, in the same run', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const keeper = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, keeper);
  const g = gate();
  const update = w.s.customers.update;
  let paused = false;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!paused) {
      paused = true; g.entered(); await g.releaseP;
      await update(id, p, o); // Stripe applies it...
      throw Object.assign(new Error('response lost'), { type: 'StripeConnectionError' }); // ...the caller never hears
    }
    return update(id, p, o);
  };
  const reconcile = reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 }).then(() => null, (e) => e);
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  assert.equal((await w.setDefault(other)).code, 200);
  g.release();
  assert.match(String((await reconcile)?.message), /response lost/); // the error is still reported
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
});

test('route: a reconciliation that dies mid-write leaves an obligation the next run settles', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const keeper = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, keeper);
  const update = w.s.customers.update;
  let died = false;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!died) { died = true; await update(id, p, o); return new Promise<never>(() => {}); } // applied, then the process is gone
    return update(id, p, o);
  };
  void reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  while (!died) await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 5));
  now = lockModule.LEASE_MS + 1; // the dead run's lease lapses
  assert.equal((await w.lock.run(w.cus, (l) => l.pendingWrites())).length, 1, 'the write was recorded before it was sent');
  assert.equal((await w.setDefault(other)).code, 200);
  w.s.customers.update = update;
  const next = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  assert.equal(next!.repairedChoice, other);
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
});

test('route: a lost response with the lease held throughout is reported and needs no repair', async () => {
  const w = world();
  const keeper = w.s.addCard(w.cus, 'fp_A');
  w.s.addSubscription(w.cus, keeper);
  const update = w.s.customers.update;
  let once = false;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!once) { once = true; await update(id, p, o); throw Object.assign(new Error('response lost'), { type: 'StripeConnectionError' }); }
    return update(id, p, o);
  };
  await assert.rejects(reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock }), /response lost/);
  assert.equal(w.s.defaultOf(w.cus), keeper); // its own intended write, with nothing to restore
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
});

// Third review #2: a reserved purchase names its card before Stripe shows anything for it.
test('route: cleanup defers while a purchase is reserved but not yet in Stripe, and the purchase completes', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const copy = w.s.addCard(w.cus, 'fp_A'); // a second copy of the card being purchased with
  const g = gate();
  const create = w.s.subscriptions.create;
  let paused = false;
  w.s.subscriptions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    if (!w.s.pms.get(p.default_payment_method).customer) {
      throw Object.assign(new Error('reserved payment method was detached'), { type: 'StripeInvalidRequestError', statusCode: 400 });
    }
    return create(p, o);
  };
  const purchase = w.saved();
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  assert.equal((await w.setDefault(copy)).code, 200); // the purchase's card is no longer the default
  const r = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  assert.ok(r!.plan.deferred.some((d) => /reserved/.test(d)), JSON.stringify(r!.plan.deferred));
  assert.deepEqual(r!.detached, []);
  assert.ok(w.s.pms.get(w.pm).customer, 'the reserved card is still attached');
  g.release();
  assert.equal((await purchase).body.success, true);
});

test('cleanup clears a finished purchase’s leftover reservation and proceeds', async () => {
  const w = world();
  const fresh = w.s.addCard(w.cus, 'fp_A');
  const sub = w.s.addSubscription(w.cus, fresh, 'active');
  await w.lock.run(w.cus, (l) => l.reserve({ kind: 'saved-card', attemptKey: KEY_A, idempotencyKey: 'k', params: {}, subscriptionId: sub, createdAt: Date.now() }));
  const r = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock });
  assert.equal(await w.lock.run(w.cus, (l) => l.reservation()), null);
  assert.deepEqual(r!.detached, [w.pm]);
});

// Fourth review #1: a replacement must not clear a write that can still land.
test('route: a stalled write that never reached Stripe is fenced off by the run that settles it', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const keeper = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, keeper);
  const g = gate();
  const update = w.s.customers.update;
  let paused = false;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; } // stalled before reaching Stripe
    return update(id, p, o);
  };
  const stalled = reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 }).then(() => null, (e) => e);
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  assert.equal((await w.setDefault(other)).code, 200);
  const settling = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  assert.equal(settling!.repairedChoice, null); // it never landed: nothing to repair
  const [watched] = await w.lock.run(w.cus, (l) => l.pendingWrites());
  assert.ok(watched?.claimedAt, 'claimed, and kept to be watched rather than forgotten');
  g.release(); // the old write finally goes out...
  assert.equal((await stalled)?.type, 'StripeIdempotencyError'); // ...and Stripe refuses its claimed key
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
});

test('route: a write Stripe accepted but has not applied is kept until it lands, then repaired over', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const keeper = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, keeper);
  const g = gate();
  let held = false;
  w.s.inFlight = async (endpoint) => {
    if (!held && endpoint.startsWith('customers.update') ) { held = true; g.entered(); await g.releaseP; }
  };
  const update = w.s.customers.update;
  let first = true;
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    const stale = first && String(o?.idempotencyKey).startsWith('pm-reconcile:') && p?.invoice_settings;
    if (stale) first = false;
    const out = await update(id, p, o);
    if (stale) return new Promise<never>(() => {}); // applied; its caller never hears (it died)
    return out;
  };
  void reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 }).catch(() => {});
  await g.enteredP; // Stripe is executing the old write
  now = lockModule.LEASE_MS + 1;
  assert.equal((await w.setDefault(other)).code, 200);
  const early = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  assert.ok(early!.plan.deferred.some((d) => /still in flight/.test(d)));
  assert.equal(early!.pendingWrites.length, 1, 'kept while it can still land');
  g.release();
  await new Promise((r) => setTimeout(r, 5)); // it lands (keeper); its caller is gone
  assert.equal(w.s.defaultOf(w.cus), keeper);
  const later = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock, waitMs: 5_000 });
  assert.equal(later!.repairedChoice, other);
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
});

// Fourth review #2.
test('route: dry-run reports pending writes and the repair they need, and writes nothing', async () => {
  const w = world();
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, w.pm);
  await w.lock.run(w.cus, async (l) => {
    await l.addPendingWrite({ id: 'w1', kind: 'set-default', target: w.pm, idempotencyKey: 'k1', sinceSeq: 0, at: 0 });
    await l.recordDefaultChoice({ paymentMethodId: other, fingerprint: 'fp_B', subscriptions: true });
  });
  const n = w.s.calls.length;
  const r = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'dry-run', lock: w.lock });
  assert.deepEqual(w.s.calls.slice(n).filter((c) => /update|detach/.test(c)), []);
  assert.ok(!w.s.keyed.has('k1'), 'no claim was sent');
  assert.equal(r!.pendingWrites.length, 1);
  assert.ok(r!.plan.deferred.some((d) => /not yet settled/.test(d)));
  assert.equal(w.s.defaultOf(w.cus), w.pm);
  assert.equal(w.s.subs.get(sub).default_payment_method, w.pm);
  assert.equal((await w.lock.run(w.cus, (l) => l.pendingWrites())).length, 1);
});

// Fourth review #3: the operator sweep shares production's coordination state.
test('route: the operator sweep sees a production purchase reservation and leaves its card attached', async () => {
  let now = 0;
  const db = fakeFirestore();
  const w = world({ lock: lockModule.firestoreCustomerLock(db as any, () => now) });
  const copy = w.s.addCard(w.cus, 'fp_A');
  const g = gate();
  const create = w.s.subscriptions.create;
  let paused = false;
  w.s.subscriptions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    if (!w.s.pms.get(p.default_payment_method).customer) {
      throw Object.assign(new Error('reserved card detached by operator sweep'), { type: 'StripeInvalidRequestError', statusCode: 400 });
    }
    return create(p, o);
  };
  const purchase = w.saved();
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  assert.equal((await w.setDefault(copy)).code, 200);
  // The sweep builds its own lock, but over the same Firestore: a separate process, shared state.
  const r = await sweepCustomer(w.s as any, db as any, w.cus, true);
  assert.equal(r, null); // deferred: left for the drain
  const queued = await firestoreReconcileQueue(db as any).get(w.cus);
  assert.ok(queued, 'queued for the drain while the purchase is reserved');
  assert.ok(w.s.pms.get(w.pm).customer, 'the reserved card is still attached');
  g.release();
  assert.equal((await purchase).body.success, true);
});

test('the sweep script uses only the shared coordination state', () => {
  const src = readFileSync(new URL('../../scripts/dedupe-payment-methods.ts', import.meta.url), 'utf8');
  assert.match(src, /sweepCustomer\(stripe, db,/);
  assert.match(src, /getFirestore\(\)/);
  assert.match(src, /await assertCoordinationReadable\(db\)/);
  assert.doesNotMatch(src, /memoryCustomerLock|reconcileDuplicateCards|CustomerLock\b/);
});

// Fifth review: Stripe may prune a claimed key after 24 hours, so the claim is not a permanent fence.
test('route: a stalled write that lands after its claimed key was pruned is found in the events and repaired', async () => {
  let now = 0;
  const w = world({ now: () => now });
  const keeper = w.s.addCard(w.cus, 'fp_A');
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, keeper);
  const g = gate();
  const update = w.s.customers.update;
  let paused = false;
  let landed!: () => void;
  const landedP = new Promise<void>((r) => { landed = r; });
  w.s.customers.update = async (id: string, p: any, o?: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; await update(id, p, o); landed(); return new Promise<never>(() => {}); }
    return update(id, p, o);
  };
  void reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock }).catch(() => {});
  await g.enteredP;
  now = lockModule.LEASE_MS + 1;
  const [pending] = await w.lock.run(w.cus, (l) => l.pendingWrites());
  assert.equal((await w.setDefault(other)).code, 200);
  await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock }); // claims and keeps it
  assert.ok(w.s.keyed.has(pending.idempotencyKey));
  w.s.keyed.delete(pending.idempotencyKey); // Stripe prunes the key (permitted after 24 hours)
  g.release();
  await landedP; // the original applies after all, and its caller is gone
  assert.equal(w.s.defaultOf(w.cus), keeper);
  const next = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock });
  assert.equal(next!.repairedChoice, other);
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
});

test('a write never claimed, older than Stripe’s key retention, is judged by the events, not the claim', async () => {
  const w = world();
  const other = w.s.addCard(w.cus, 'fp_B');
  const sub = w.s.addSubscription(w.cus, w.pm);
  const realNow = Date.now;
  const t0 = realNow();
  // An old write applied, its key since pruned: a claim would wrongly report "never applied".
  await w.s.customers.update(w.cus, { invoice_settings: { default_payment_method: w.pm } }, { idempotencyKey: 'pm-reconcile:old' });
  w.s.keyed.delete('pm-reconcile:old');
  await w.lock.run(w.cus, async (l) => {
    await l.addPendingWrite({ id: 'old', kind: 'set-default', target: w.pm, idempotencyKey: 'pm-reconcile:old', sinceSeq: 0, at: t0 });
    await l.recordDefaultChoice({ paymentMethodId: other, fingerprint: 'fp_B', subscriptions: true });
  });
  Date.now = () => t0 + 25 * 60 * 60 * 1000;
  try {
    const r = await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock });
    assert.equal(r!.repairedChoice, other);
  } finally {
    Date.now = realNow;
  }
  assert.equal(w.s.defaultOf(w.cus), other);
  assert.equal(w.s.subs.get(sub).default_payment_method, other);
});

test('a watched write is forgotten only after the events window', async () => {
  const w = world();
  const realNow = Date.now;
  const t0 = realNow();
  await w.lock.run(w.cus, (l) => l.addPendingWrite({ id: 'w', kind: 'detach', target: 'pm_x', idempotencyKey: 'pm-reconcile:w', sinceSeq: 0, at: t0, claimedAt: t0 }));
  try {
    Date.now = () => t0 + 28 * 24 * 60 * 60 * 1000;
    await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock });
    assert.equal((await w.lock.run(w.cus, (l) => l.pendingWrites())).length, 1);
    Date.now = () => t0 + 30 * 24 * 60 * 60 * 1000;
    await reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock: w.lock });
    assert.equal((await w.lock.run(w.cus, (l) => l.pendingWrites())).length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('a write whose send window closed is never sent', async () => {
  const w = world();
  w.s.addCard(w.cus, 'fp_A');
  w.s.addSubscription(w.cus, [...w.s.pms.keys()].at(-1)!);
  const realNow = Date.now;
  const t0 = realNow();
  let calls = 0;
  const lock: lockModule.CustomerLock = {
    run: (c, fn, o) => w.lock.run(c, async (lease) => fn({
      ...lease,
      // the writer stalls past its window between recording the write and sending it
      addPendingWrite: async (pw) => { await lease.addPendingWrite(pw); calls++; Date.now = () => t0 + 3 * 60 * 1000; },
    }), o),
  };
  try {
    await assert.rejects(reconcileDuplicateCards(w.s as any, w.cus, { mode: 'apply', lock }), { name: 'SendWindowClosed' });
  } finally {
    Date.now = realNow;
  }
  assert.ok(calls >= 1);
  assert.equal(w.s.defaultOf(w.cus), w.pm, 'the default was not changed');
  assert.ok(!w.s.eventLog.some((e) => e.request.idempotency_key?.startsWith('pm-reconcile:')), 'no reconciliation write reached Stripe');
  const [kept] = await w.lock.run(w.cus, (l) => l.pendingWrites());
  assert.ok(kept?.claimedAt, 'its key is claimed and the write watched');
});

// Seventh review #3: a read-only sweep must leave nothing an apply-mode drain could act on.
test('a dry-run sweep never creates queued work, whether it runs or finds the customer busy', async () => {
  const db = fakeFirestore();
  const lock = lockModule.firestoreCustomerLock(db as any);
  const w = world({ lock });
  w.s.addCard(w.cus, 'fp_A'); // a duplicate the apply mode would detach
  const queue = firestoreReconcileQueue(db as any);
  const r = await sweepCustomer(w.s as any, db as any, w.cus, false);
  assert.equal(r!.mode, 'dry-run');
  assert.equal(r!.plan.detach.length, 1);
  assert.equal(await queue.get(w.cus), null);
  let release!: () => void;
  const held = lock.run(w.cus, () => new Promise<void>((res) => { release = res; }));
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 2_000); // time moves: the 30s wait runs out while the 60s lease is still held
  try {
    await assert.rejects(sweepCustomer(w.s as any, db as any, w.cus, false), { name: 'CustomerLockBusy' });
  } finally {
    Date.now = realNow;
    release();
    await held;
  }
  assert.equal(await queue.get(w.cus), null, 'no apply-capable work left behind');
  assert.equal(w.s.attached(w.cus).length, 2, 'nothing detached');
});

test('the sweep probe reads a document id Firestore accepts', async () => {
  const { SWEEP_PROBE_ID, assertCoordinationReadable } = await import('./billing-sweep');
  assert.doesNotMatch(SWEEP_PROBE_ID, /^__.*__$/, 'Firestore reserves ids of the form __name__');
  assert.doesNotMatch(SWEEP_PROBE_ID, /^cus_/);
  assert.match(SWEEP_PROBE_ID as string, /^[A-Za-z0-9-]+$/, 'no slashes, no dot-only ids');
  await assertCoordinationReadable(fakeFirestore() as any);
});
