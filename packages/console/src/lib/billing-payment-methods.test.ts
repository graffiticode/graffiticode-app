import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStripe } from './fixtures/fake-stripe';
import { memoryCustomerLock } from './billing-customer-lock';
import { planReconciliation, readCustomerPaymentState, reconcileDuplicateCards, reconcileModeFromEnv, sameCard } from './billing-payment-methods';

const apply = (s: FakeStripe, customer: string, lock = memoryCustomerLock()) =>
  reconcileDuplicateCards(s as any, customer, { mode: 'apply', lock, waitMs: 5_000 });

/** The production case: an old default card, then Checkout attaches a second copy and bills it. */
function checkoutDuplicate() {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const old = s.addCard(cus, 'fp_A');
  s.customersById.get(cus).invoice_settings.default_payment_method = old;
  return { s, cus, old };
}

test('the mode defaults to dry-run; only "apply" and "off" change it', () => {
  assert.equal(reconcileModeFromEnv(undefined), 'dry-run');
  assert.equal(reconcileModeFromEnv('yes'), 'dry-run');
  assert.equal(reconcileModeFromEnv('apply'), 'apply');
  assert.equal(reconcileModeFromEnv('off'), 'off');
});

test('same card needs two card methods with equal, present fingerprints', () => {
  const s = new FakeStripe();
  const pm = (fp: string | null, type = 'card') => s.pms.get(s.addCard(null, fp, 'ok', type));
  assert.equal(sameCard(pm('fp_A'), pm('fp_A')), true);
  assert.equal(sameCard(pm('fp_A'), pm('fp_B')), false);
  assert.equal(sameCard(pm(null), pm(null)), false);
  assert.equal(sameCard(pm('fp_A'), pm(null, 'link')), false);
});

test('different or missing fingerprints leave every method attached', async () => {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const a = s.addCard(cus, 'fp_A');
  s.addCard(cus, 'fp_B');
  s.addCard(cus, null);
  s.addCard(cus, null);
  s.addCard(cus, null, 'ok', 'link');
  s.customersById.get(cus).invoice_settings.default_payment_method = a;
  const before = s.attached(cus);
  const r = await apply(s, cus);
  assert.deepEqual(r!.plan.detach, []);
  assert.deepEqual(s.attached(cus), before);
  assert.ok(!s.calls.some((c) => c.startsWith('detach') || c === 'customers.update'));
});

test('a Checkout duplicate keeps the copy the subscription bills and re-points the default to it', async () => {
  const { s, cus, old } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  s.addSubscription(cus, fresh);
  const r = await apply(s, cus);
  assert.equal(r!.defaultSet, fresh);
  assert.deepEqual(r!.detached, [old]);
  assert.deepEqual(s.attached(cus), [fresh]);
  assert.equal(s.defaultOf(cus), fresh);
});

test('with nothing referencing either copy, the customer default is kept', async () => {
  const { s, cus, old } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  const r = await apply(s, cus);
  assert.equal(r!.defaultSet, null);
  assert.deepEqual(r!.detached, [fresh]);
  assert.equal(s.defaultOf(cus), old);
});

test('both event orders converge on the same result', async () => {
  // Order 1: the attach event arrives while Checkout is still open, before the subscription exists.
  const one = checkoutDuplicate();
  const cs = one.s.openCheckout(one.cus);
  const fresh1 = one.s.addCard(one.cus, 'fp_A');
  const early = await apply(one.s, one.cus);
  assert.ok(early!.plan.deferred.length > 0, 'deferred while checkout is open');
  assert.deepEqual(early!.detached, []);
  assert.deepEqual(one.s.attached(one.cus), [one.old, fresh1].sort());
  one.s.addSubscription(one.cus, fresh1);
  one.s.completeCheckout(cs);
  await apply(one.s, one.cus); // checkout.session.completed

  // Order 2: the subscription and checkout events arrive first, the attach event last.
  const two = checkoutDuplicate();
  const fresh2 = two.s.addCard(two.cus, 'fp_A');
  two.s.addSubscription(two.cus, fresh2);
  await apply(two.s, two.cus); // customer.subscription.created
  await apply(two.s, two.cus); // payment_method.attached, delivered late

  assert.deepEqual(one.s.attached(one.cus), [fresh1]);
  assert.deepEqual(two.s.attached(two.cus), [fresh2]);
  assert.equal(one.s.defaultOf(one.cus), fresh1);
  assert.equal(two.s.defaultOf(two.cus), fresh2);
});

test('the attach event before the subscription exists, with no checkout session, does not strand the new card', async () => {
  // A subscription created right after (saved-card flow or API) must find its card.
  const { s, cus } = checkoutDuplicate();
  const pi = s.addPaymentIntent(cus, null, 'processing');
  const fresh = s.addCard(cus, 'fp_A');
  s.pis.get(pi).payment_method = fresh;
  const r = await apply(s, cus);
  assert.ok(r!.plan.deferred.some((d) => d.includes('processing')));
  assert.ok(s.attached(cus).includes(fresh));
});

test('duplicate deliveries are no-ops after the first', async () => {
  const { s, cus } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  s.addSubscription(cus, fresh);
  const first = await apply(s, cus);
  const second = await apply(s, cus);
  const third = await apply(s, cus);
  assert.equal(first!.detached.length, 1);
  assert.deepEqual([second!.detached, third!.detached], [[], []]);
  assert.equal(s.calls.filter((c) => c.startsWith('detach')).length, 1);
});

test('concurrent reconciliations detach each copy once', async () => {
  const { s, cus } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  s.addCard(cus, 'fp_A');
  s.addSubscription(cus, fresh);
  const lock = memoryCustomerLock();
  const results = await Promise.all([apply(s, cus, lock), apply(s, cus, lock), apply(s, cus, lock)]);
  assert.equal(results.reduce((n, r) => n + r!.detached.length, 0), 2);
  assert.equal(s.calls.filter((c) => c.startsWith('detach')).length, 2);
  assert.deepEqual(s.attached(cus), [fresh]);
});

test('copies used by different subscriptions are all kept; only the unused copy goes', async () => {
  const { s, cus, old } = checkoutDuplicate();
  const a = s.addCard(cus, 'fp_A');
  const b = s.addCard(cus, 'fp_A');
  const spare = s.addCard(cus, 'fp_A');
  s.addSubscription(cus, a);
  s.addSubscription(cus, b);
  s.addSubscription(cus, spare, 'canceled'); // an ended subscription is no reference
  const r = await apply(s, cus);
  assert.deepEqual(r!.detached.sort(), [old, spare].sort());
  assert.deepEqual(s.attached(cus), [a, b].sort());
  assert.ok([a, b].includes(s.defaultOf(cus)));
});

test('unpaid invoices, unfinished intents and schedules protect the copy they name', async () => {
  for (const ref of ['invoice', 'payment intent', 'setup intent', 'schedule'] as const) {
    const { s, cus } = checkoutDuplicate();
    const named = s.addCard(cus, 'fp_A');
    if (ref === 'invoice') s.addInvoice(cus, named, 'open');
    if (ref === 'payment intent') s.addPaymentIntent(cus, named, 'requires_payment_method');
    if (ref === 'setup intent') s.addSetupIntent(cus, named, 'requires_payment_method');
    if (ref === 'schedule') s.schedules.set('sub_sched_1', { id: 'sub_sched_1', customer: cus, status: 'active', default_settings: { default_payment_method: named }, phases: [] });
    await apply(s, cus);
    assert.ok(s.attached(cus).includes(named), `${ref} keeps its card`);
  }
});

test('an in-flight payment, setup or incomplete subscription defers everything', async () => {
  for (const make of [
    (s: FakeStripe, c: string) => s.addPaymentIntent(c, null, 'requires_action'),
    (s: FakeStripe, c: string) => s.addSetupIntent(c, null, 'processing'),
    (s: FakeStripe, c: string) => s.addSubscription(c, null, 'incomplete'),
    (s: FakeStripe, c: string) => s.openCheckout(c),
  ]) {
    const { s, cus } = checkoutDuplicate();
    s.addCard(cus, 'fp_A');
    make(s, cus);
    const before = s.attached(cus);
    const r = await apply(s, cus);
    assert.ok(r!.plan.deferred.length > 0);
    assert.deepEqual(s.attached(cus), before);
    assert.ok(!s.calls.includes('customers.update'));
  }
});

test('dry-run plans the same changes but makes none', async () => {
  const { s, cus, old } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  s.addSubscription(cus, fresh);
  const r = await reconcileDuplicateCards(s as any, cus, { mode: 'dry-run', lock: memoryCustomerLock() });
  assert.deepEqual(r!.plan.detach.map((d) => d.id), [old]);
  assert.equal(r!.plan.setDefault, fresh);
  assert.deepEqual(r!.detached, []);
  assert.ok(!s.calls.some((c) => c.startsWith('detach') || c === 'customers.update'));
  assert.equal(await reconcileDuplicateCards(s as any, cus, { mode: 'off', lock: memoryCustomerLock() }), null);
});

test('a reference that appears after planning stops the detach', async () => {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const keep = s.addCard(cus, 'fp_A');
  s.customersById.get(cus).invoice_settings.default_payment_method = keep;
  const spare = s.addCard(cus, 'fp_A');
  let reads = 0;
  s.onRead = () => { if (++reads === 2) s.addInvoice(cus, spare, 'open'); }; // between plan and detach
  const r = await apply(s, cus);
  assert.deepEqual(r!.detached, []);
  assert.match(r!.skipped[0].reason, /now referenced by invoice/);
  assert.ok(s.attached(cus).includes(spare));
});

test('the state reader lists what references each card and why the state is unsettled', async () => {
  const { s, cus } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  const sub = s.addSubscription(cus, fresh);
  s.openCheckout(cus);
  const state = await readCustomerPaymentState(s as any, cus);
  assert.deepEqual(state.references.get(fresh), [`subscription ${sub}`]);
  assert.equal(state.unsettled.length, 1);
  assert.equal(planReconciliation(state).detach.length, 0);
});

// Review #4: the planned default is re-validated immediately before it is applied.
test('a default changed after planning is not overwritten, and nothing else is changed either', async () => {
  const { s, cus, old } = checkoutDuplicate();
  const fresh = s.addCard(cus, 'fp_A');
  const other = s.addCard(cus, 'fp_B');
  s.addSubscription(cus, fresh);
  let reads = 0;
  s.onRead = () => { if (++reads === 2) s.customersById.get(cus).invoice_settings.default_payment_method = other; };
  const r = await apply(s, cus);
  assert.equal(r!.defaultSet, null);
  assert.match(r!.skipped[0].reason, /default changed/);
  assert.equal(s.defaultOf(cus), other);
  assert.ok(s.attached(cus).includes(old));
  assert.ok(!s.calls.some((c) => c.startsWith('detach') || c === 'customers.update'));
});
