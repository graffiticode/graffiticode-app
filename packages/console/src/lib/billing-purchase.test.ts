import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStripe } from './fixtures/fake-stripe';
import { LEASE_MS, memoryCustomerLock, type CustomerLock } from './billing-customer-lock';
import {
  createReservedCheckoutSession,
  finalizeSavedCardSubscription,
  isAttemptKey,
  startSavedCardSubscription,
} from './billing-purchase';

const KEY_A = 'attempt-aaaaaaaaaaaaaaaa';
const KEY_B = 'attempt-bbbbbbbbbbbbbbbb';

function setup(behaviour: 'ok' | 'auth' | 'decline' | 'processing' | 'throw' = 'ok', lock: CustomerLock = memoryCustomerLock()) {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const pm = s.addCard(cus, 'fp_A', behaviour);
  s.customersById.get(cus).invoice_settings.default_payment_method = pm;
  const start = (attemptKey = KEY_A, paymentMethodId = pm) => startSavedCardSubscription(s as any, lock, {
    customerId: cus, userId: 'u1', planId: 'pro', interval: 'monthly', paymentMethodId, attemptKey, items: [{ price: 'price_pro' }],
  });
  const finalize = (subscriptionId: string) => finalizeSavedCardSubscription(s as any, lock, { customerId: cus, subscriptionId });
  const checkout = () => createReservedCheckoutSession(s as any, lock, cus, () => ({
    customer: cus, mode: 'subscription', line_items: [{ price: 'price_pro', quantity: 1 }], success_url: 'https://x.test/ok', cancel_url: 'https://x.test/no',
  }));
  return { s, cus, pm, lock, start, finalize, checkout };
}

const piOf = (s: FakeStripe, subId: string) => s.invoicesById.get(s.subs.get(subId).latest_invoice).payments.data[0].payment.payment_intent;
const open = (s: FakeStripe, cus: string) => s.subsOf(cus).filter((x) => !['canceled', 'incomplete_expired'].includes(x.status));
const active = (s: FakeStripe, cus: string) => s.subsOf(cus, 'active');
function gate() {
  let release!: () => void;
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const releaseP = new Promise<void>((r) => { release = r; });
  return { entered, enteredP, release, releaseP };
}

test('attempt keys must be long, opaque tokens', () => {
  assert.equal(isAttemptKey(KEY_A), true);
  assert.equal(isAttemptKey('short'), false);
  assert.equal(isAttemptKey('has spaces in it, sixteen+'), false);
  assert.equal(isAttemptKey(undefined), false);
});

test('a card that pays makes one active subscription with that card and no new card', async () => {
  const { s, cus, pm, start } = setup('ok');
  assert.equal((await start()).kind, 'active');
  assert.equal(s.subsOf(cus).length, 1);
  assert.equal(s.subsOf(cus)[0].default_payment_method, pm);
  assert.deepEqual(s.attached(cus), [pm]);
});

// Review #3: Stripe replays the original response for a reused key.
test('a replayed successful attempt reports the subscription as it is now, not as it was', async () => {
  const { s, cus, start } = setup('ok');
  const first = await start(KEY_A);
  assert.equal(first.kind, 'active');
  await s.subscriptions.cancel((first as any).subscription.id);
  const retry = await start(KEY_A);
  assert.equal(retry.kind, 'ended');
  assert.equal(active(s, cus).length, 0);
});

// Review #1: the lease expires while the first create is still in flight.
test('a holder whose lease expired mid-create and the one that took over share one subscription', async () => {
  let now = 0;
  const { s, cus, start } = setup('ok', memoryCustomerLock(() => now));
  const g = gate();
  const create = s.subscriptions.create;
  let paused = false;
  s.subscriptions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return create(p, o);
  };
  const first = start(KEY_A);
  await g.enteredP;
  now = LEASE_MS + 1;
  const second = await start(KEY_B); // recovers attempt A before deciding
  g.release();
  const original = await first;
  assert.equal(second.kind, 'has_subscription');
  assert.equal(original.kind, 'active');
  assert.equal(active(s, cus).length, 1);
  assert.equal(s.calls.filter((c) => c === 'subscriptions.create').length, 1);
});

test('a holder whose lease expired after a stale read is fenced off before it creates', async () => {
  let now = 0;
  const { s, cus, start } = setup('ok', memoryCustomerLock(() => now));
  const g = gate();
  const list = s.subscriptions.list;
  let paused = false;
  s.subscriptions.list = async (p: any) => {
    const stale = await list(p); // read before the takeover...
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return stale; // ...acted on after it
  };
  const first = start(KEY_A);
  await g.enteredP;
  now = LEASE_MS + 1;
  assert.equal((await start(KEY_B)).kind, 'active');
  g.release();
  await assert.rejects(first, { name: 'LeaseLost' });
  assert.equal(active(s, cus).length, 1);
});

test('retrying the same attempt, in sequence or concurrently, never creates a second subscription', async () => {
  const { s, cus, start } = setup('ok');
  const outs = await Promise.all([start(), start(), start()]);
  outs.push(await start());
  assert.equal(s.calls.filter((c) => c === 'subscriptions.create').length, 1);
  assert.equal(s.subsOf(cus).length, 1);
  assert.ok(outs.every((o) => o.kind === 'active'), JSON.stringify(outs.map((o) => o.kind)));
});

test('concurrent attempts with different keys still leave one live subscription', async () => {
  const { s, cus, start } = setup('ok');
  const outs = await Promise.all([start(KEY_A), start(KEY_B)]);
  assert.deepEqual(outs.map((o) => o.kind).sort(), ['active', 'has_subscription']);
  assert.equal(open(s, cus).length, 1);
});

test('3D Secure: requires_action, retries resume it, and finalize activates it after authentication', async () => {
  const { s, cus, start, finalize } = setup('auth');
  const first = await start();
  assert.equal(first.kind, 'requires_action');
  const again = await start();
  assert.equal((again as any).subscriptionId, (first as any).subscriptionId);
  assert.equal(s.calls.filter((c) => c === 'subscriptions.create').length, 1);
  const subId = (first as any).subscriptionId;
  s.authenticate(piOf(s, subId), true);
  assert.equal((await finalize(subId)).kind, 'active');
  assert.equal(open(s, cus).length, 1);
});

test('3D Secure failure ends declined, with the incomplete subscription canceled', async () => {
  const { s, cus, start, finalize } = setup('auth');
  const subId = ((await start()) as any).subscriptionId;
  s.authenticate(piOf(s, subId), false);
  const out = await finalize(subId);
  assert.equal(out.kind, 'declined');
  assert.equal(open(s, cus).length, 0);
  assert.equal((await start(KEY_A)).kind, 'ended');
  assert.equal(open(s, cus).length, 0);
});

test('an abandoned 3D Secure attempt is canceled before a new attempt creates another', async () => {
  const { s, cus, start } = setup('auth');
  const first = await start(KEY_A);
  const second = await start(KEY_B);
  assert.equal(second.kind, 'requires_action');
  assert.notEqual((second as any).subscriptionId, (first as any).subscriptionId);
  assert.equal(s.subs.get((first as any).subscriptionId).status, 'incomplete_expired');
  assert.equal(open(s, cus).length, 1);
});

test('a declined card leaves no subscription behind, and a new attempt can try again', async () => {
  const { s, cus, start } = setup('decline');
  const out = await start(KEY_A);
  assert.equal(out.kind, 'declined');
  assert.equal((out as any).declineCode, 'generic_decline');
  assert.equal(open(s, cus).length, 0);
  assert.equal((await start(KEY_B)).kind, 'declined');
  assert.equal(open(s, cus).length, 0);
});

test('a card error raised by the create call is a decline, and its leftover subscription is canceled', async () => {
  const { s, cus, start } = setup('throw');
  assert.equal((await start()).kind, 'declined');
  assert.equal(open(s, cus).length, 0);
});

test('a payment still processing blocks a second attempt and a Checkout session', async () => {
  const { s, cus, start, finalize, checkout } = setup('processing');
  const first = await start(KEY_A);
  assert.equal(first.kind, 'processing');
  assert.equal((await start(KEY_B)).kind, 'processing');
  assert.equal((await checkout()).kind, 'processing');
  assert.equal(s.calls.filter((c) => c === 'subscriptions.create').length, 1);
  assert.ok(!s.calls.includes('checkout.sessions.create'));
  assert.equal((await finalize((first as any).subscriptionId)).kind, 'processing');
  assert.equal(open(s, cus).length, 1);
});

test('a card that is not on this account, or an existing subscription, is refused without a charge', async () => {
  const { s, cus, start } = setup('ok');
  const stranger = s.addCard(s.addCustomer(), 'fp_Z');
  assert.equal((await start(KEY_A, stranger)).kind, 'invalid');
  s.addSubscription(cus, null, 'active');
  assert.equal((await start(KEY_B)).kind, 'has_subscription');
  assert.equal(s.calls.filter((c) => c === 'subscriptions.create').length, 0);
});

test('finalize refuses a subscription the saved-card flow did not create', async () => {
  const { s, cus, finalize } = setup('ok');
  const other = s.addSubscription(cus, null, 'incomplete');
  assert.equal((await finalize(other)).kind, 'invalid');
  assert.equal(s.subs.get(other).status, 'incomplete');
});

// Review #2: Checkout and saved-card purchases share one reservation.
test('a saved-card purchase expires an open Checkout session, which can then no longer complete', async () => {
  const { s, cus, pm, start, checkout } = setup('ok');
  const c = await checkout();
  assert.equal(c.kind, 'created');
  const sessionId = (c as any).session.id;
  assert.equal((await start()).kind, 'active');
  assert.equal(s.sessions.get(sessionId).status, 'expired');
  assert.throws(() => s.completeCheckout(sessionId, pm));
  assert.equal(active(s, cus).length, 1);
});

test('Checkout paused mid-create loses its lease; the saved-card purchase that took over expires the session first', async () => {
  let now = 0;
  const { s, cus, pm, start, checkout } = setup('ok', memoryCustomerLock(() => now));
  const g = gate();
  const create = s.checkout.sessions.create;
  let paused = false;
  s.checkout.sessions.create = async (p: any, o: any) => {
    if (!paused) { paused = true; g.entered(); await g.releaseP; }
    return create(p, o);
  };
  const pending = checkout();
  await g.enteredP;
  now = LEASE_MS + 1;
  assert.equal((await start()).kind, 'active'); // replays the session create, expires it, then subscribes
  g.release();
  await assert.rejects(pending, { name: 'CustomerLockBusy' });
  const sessions = [...s.sessions.values()];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'expired');
  assert.throws(() => s.completeCheckout(sessions[0].id, pm));
  assert.equal(active(s, cus).length, 1);
});

test('a new Checkout session replaces an open one; a completed one makes later purchases see the subscription', async () => {
  const { s, cus, pm, start, checkout } = setup('ok');
  const first = (await checkout()) as any;
  const second = (await checkout()) as any;
  assert.equal(s.sessions.get(first.session.id).status, 'expired');
  assert.equal(s.sessions.get(second.session.id).status, 'open');
  s.completeCheckout(second.session.id, pm);
  assert.equal((await checkout()).kind, 'has_subscription');
  assert.equal((await start()).kind, 'has_subscription');
  assert.equal(active(s, cus).length, 1);
});

test('Checkout replaces a saved-card attempt still waiting for 3D Secure', async () => {
  const { s, cus, start, checkout } = setup('auth');
  const attempt = (await start()) as any;
  assert.equal((await checkout()).kind, 'created');
  assert.equal(s.subs.get(attempt.subscriptionId).status, 'incomplete_expired');
  assert.equal(open(s, cus).length, 0);
});

test('Checkout sessions are created to expire, bounding their reservation', async () => {
  const { s, checkout } = setup('ok');
  const before = Math.floor(Date.now() / 1000);
  const c = (await checkout()) as any;
  const exp = s.sessions.get(c.session.id).expires_at;
  assert.ok(exp >= before + 30 * 60 && exp <= before + 32 * 60, String(exp - before));
});

// Second review #1: authentication completes while another purchase replaces the attempt.
test('authentication completing just before replacement keeps the original, with one payment', async () => {
  const { s, cus, pm, start } = setup('auth');
  const pending = (await start(KEY_A)) as any;
  const void_ = s.invoices.voidInvoice;
  s.invoices.voidInvoice = async (id: string) => {
    s.authenticate(piOf(s, pending.subscriptionId), true); // lands first
    return void_(id);
  };
  s.behaviour.set(pm, 'ok');
  const out = await start(KEY_B);
  assert.equal(out.kind, 'has_subscription');
  assert.equal((out as any).subscriptionId, pending.subscriptionId);
  assert.equal([...s.pis.values()].filter((p) => p.status === 'succeeded').length, 1);
  assert.equal(active(s, cus).length, 1);
  assert.ok(!s.calls.includes(`cancel ${pending.subscriptionId}`));
});

test('authentication attempted just after replacement fails, and only the replacement is paid', async () => {
  const { s, cus, pm, start } = setup('auth');
  const pending = (await start(KEY_A)) as any;
  const cancel = s.subscriptions.cancel;
  let lateAuth: unknown = null;
  s.subscriptions.cancel = async (id: string) => {
    if (id === pending.subscriptionId) {
      try { s.authenticate(piOf(s, pending.subscriptionId), true); } catch (e) { lateAuth = e; } // after the void
    }
    return cancel(id);
  };
  s.behaviour.set(pm, 'ok');
  assert.equal((await start(KEY_B)).kind, 'active');
  assert.ok(lateAuth, 'the voided payment cannot complete');
  assert.equal([...s.pis.values()].filter((p) => p.status === 'succeeded').length, 1);
  assert.equal(active(s, cus).length, 1);
});

test('Checkout keeps an attempt whose authentication completed first, instead of replacing it', async () => {
  const { s, cus, start, checkout } = setup('auth');
  const pending = (await start(KEY_A)) as any;
  const void_ = s.invoices.voidInvoice;
  s.invoices.voidInvoice = async (id: string) => { s.authenticate(piOf(s, pending.subscriptionId), true); return void_(id); };
  assert.equal((await checkout()).kind, 'has_subscription');
  assert.ok(!s.calls.includes('checkout.sessions.create'));
  assert.equal(active(s, cus).length, 1);
});

// Second review #2: sessions with no reservation (issued before this release).
test('open Checkout sessions without a reservation are expired by either purchase path', async () => {
  for (const path of ['saved', 'checkout'] as const) {
    const { s, cus, pm, start, checkout } = setup('ok');
    const legacy = await s.checkout.sessions.create({ customer: cus, mode: 'subscription' });
    const setupMode = await s.checkout.sessions.create({ customer: cus, mode: 'setup' });
    assert.notEqual(path === 'saved' ? (await start()).kind : (await checkout()).kind, 'has_subscription');
    assert.equal(s.sessions.get(legacy.id).status, 'expired');
    assert.equal(s.sessions.get(setupMode.id).status, 'open'); // adds a card, never a subscription
    assert.throws(() => s.completeCheckout(legacy.id, pm));
    assert.ok(active(s, cus).length <= 1);
  }
});

// Second review #3.
test('an attempt key reused with different parameters is refused, without a second subscription', async () => {
  const { s, cus, start, lock } = setup('ok');
  assert.equal((await start(KEY_A)).kind, 'active');
  const changed = await startSavedCardSubscription(s as any, lock, {
    customerId: cus, userId: 'u1', planId: 'platinum', interval: 'annual', paymentMethodId: s.defaultOf(cus), attemptKey: KEY_A, items: [{ price: 'price_platinum_annual' }],
  });
  assert.equal(changed.kind, 'mismatch');
  assert.equal(s.subsOf(cus).length, 1);
});

// Second review #4: a reservation whose create never reached Stripe, recovered after its expiry went stale.
test('a Checkout reservation that never reached Stripe does not block either path once its expiry is stale', async () => {
  for (const next of ['saved', 'checkout'] as const) {
    const { s, start, checkout, lock, cus } = setup('ok');
    const create = s.checkout.sessions.create;
    let fail = true;
    s.checkout.sessions.create = async (p: any, o: any) => {
      if (fail) { fail = false; throw Object.assign(new Error('connection failed before reaching Stripe'), { type: 'StripeConnectionError' }); }
      return create(p, o);
    };
    await assert.rejects(checkout(), /connection failed/);
    assert.ok(await lock.run(cus, (l) => l.reservation()));
    const realNow = Date.now;
    const base = realNow();
    Date.now = () => base + 120_000; // two minutes later: 29 minutes left on the stored expiry
    try {
      const out = next === 'saved' ? await start() : await checkout();
      assert.equal(out.kind, next === 'saved' ? 'active' : 'created');
      assert.equal(await lock.run(cus, (l) => l.reservation()) === null, next === 'saved');
    } finally {
      Date.now = realNow;
    }
  }
});
