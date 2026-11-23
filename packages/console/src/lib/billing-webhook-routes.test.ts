/**
 * The webhook and the scheduled drain as recovery triggers for watched
 * reconciliation writes: the real route sources, a stand-in Stripe and
 * Firestore, sharing the production lock and queue implementations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStripe } from './fixtures/fake-stripe';
import { fakeFirestore } from './fixtures/fake-firestore';
import { loadRoute, response } from './fixtures/load-route';
import * as lockModule from './billing-customer-lock';
import * as pmModule from './billing-payment-methods';
import * as queueModule from './billing-reconcile-queue';

function world() {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const pm = s.addCard(cus, 'fp_A');
  const other = s.addCard(cus, 'fp_B');
  const sub = s.addSubscription(cus, other);
  s.customersById.get(cus).invoice_settings.default_payment_method = other;
  const db = fakeFirestore();
  const lock = lockModule.firestoreCustomerLock(db as any);
  const queue = queueModule.firestoreReconcileQueue(db as any);
  let deliver: any = null;
  const shared = {
    stripe: function Stripe() { return s; },
    '@graffiticode-app/core/lib/plans-config': {
      STRIPE_API_VERSION: 'test', priceIdToPlan: () => null, includedItemsFor: () => 0, getPlan: () => ({}), overageDollarsToItems: () => null,
      defaultOverageCapFor: () => null, defaultOverageCapUsd: () => null, DEFAULT_PLAN: 'demo',
    },
    '../../../lib/with-installation': { withInstallation: (fn: any) => fn },
    '../../../lib/billing-payment-methods': pmModule,
    '../../../lib/billing-customer-lock': lockModule,
    '../../../lib/billing-reconcile-queue': queueModule,
  };
  const env = { STRIPE_SECRET_KEY: 'sk_test_route_only', STRIPE_WEBHOOK_SECRET: 'whsec_route_only', STRIPE_PM_RECONCILE: 'apply', INTERNAL_JOB_SECRET: 'job-secret' };
  const webhook = loadRoute('src/pages/api/webhooks/stripe.ts', {
    ...shared,
    '@graffiticode-app/core/utils/db/index': { getFirestore: () => db, default: { firestore: { FieldValue: { delete: () => null } } } },
    '@graffiticode-app/core/lib/funnel-events': { emitPlanChanged: () => {}, emitEvent: () => {}, actor: () => ({}) },
    micro: { buffer: async () => Buffer.alloc(0) },
    '../../../lib/stripe-webhook-verify': { verifyStripeEvent: () => deliver },
  }, env);
  const drain = loadRoute('src/pages/api/internal/billing-reconcile.ts', {
    ...shared,
    '@graffiticode-app/core/utils/db/index': { getFirestore: () => db },
  }, env);
  const withEnv = async <T>(fn: () => Promise<T>) => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  return {
    s, cus, pm, other, sub, db, lock, queue,
    deliverEvent: (event: any) => withEnv(async () => { deliver = event; const res = response(); await webhook({ method: 'POST', headers: { 'stripe-signature': 't' } }, res); return res; }),
    runDrain: () => withEnv(async () => { const res = response(); await drain({ method: 'POST', headers: { 'x-internal-job-secret': 'job-secret' } }, res); return res; }),
  };
}

/** A watched (claimed) reconciliation write that then lands late, overwriting the user's choice. */
async function lateLanding(w: ReturnType<typeof world>) {
  const key = 'pm-reconcile:late';
  const at = Date.now();
  await w.lock.run(w.cus, async (l) => {
    await l.recordDefaultChoice({ paymentMethodId: w.other, fingerprint: 'fp_B', subscriptions: true });
    await l.addPendingWrite({ id: 'late', kind: 'set-default', target: w.pm, idempotencyKey: key, sinceSeq: 0, at, sendBy: at + 120_000, claimedAt: at });
  });
  await w.s.customers.update(w.cus, { invoice_settings: { default_payment_method: w.pm } }, { idempotencyKey: key });
  w.s.subs.get(w.sub).default_payment_method = w.pm;
  return w.s.eventLog.find((e) => e.request?.idempotency_key === key);
}

// Sixth review, as reproduced: a late customer.updated through the actual webhook route.
test('webhook: a late customer.updated runs reconciliation for that customer and repairs it', async () => {
  const w = world();
  const event = await lateLanding(w);
  assert.equal(event.type, 'customer.updated');
  assert.equal(w.s.defaultOf(w.cus), w.pm);
  const res = await w.deliverEvent(event);
  assert.equal(res.code, 200);
  assert.equal(w.s.defaultOf(w.cus), w.other);
  assert.equal(w.s.subs.get(w.sub).default_payment_method, w.other);
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
  assert.equal(await w.queue.get(w.cus), null);
});

test('webhook: a payment_method.detached event is attributed through its previous customer', async () => {
  const w = world();
  const copy = w.s.addCard(w.cus, 'fp_A'); // pm and copy: an unreferenced duplicate pair
  const spare = w.s.addCard(w.cus, 'fp_C');
  await w.s.paymentMethods.detach(spare, {}, {});
  const event = w.s.eventLog.find((e) => e.type === 'payment_method.detached');
  assert.equal(event.data.object.customer, null); // as Stripe sends it
  const res = await w.deliverEvent(event);
  assert.equal(res.code, 200);
  // Reconciliation ran for that customer: one copy of the duplicate is gone.
  assert.equal([w.pm, copy].filter((id) => w.s.pms.get(id).customer === w.cus).length, 1);
  assert.equal(await w.queue.get(w.cus), null);
});

test('webhook: busy work stays queued, and the scheduled drain completes the repair', async () => {
  const w = world();
  const event = await lateLanding(w);
  let release!: () => void;
  const held = w.lock.run(w.cus, () => new Promise<void>((r) => { release = r; }));
  const res = await w.deliverEvent(event); // waits ~5s for the lease, then gives up
  assert.equal(res.code, 200);
  const item = await w.queue.get(w.cus);
  assert.ok(item, 'kept for retry');
  assert.equal(w.s.defaultOf(w.cus), w.pm);
  release();
  await held;
  await w.queue.reschedule(w.cus, { generation: item!.generation, seq: item!.seq }, Date.now() - 1, { attempts: 0, lastError: null }); // its retry time arrives
  const drained = await w.runDrain();
  assert.equal(drained.code, 200);
  assert.equal(drained.body.ran, 1);
  assert.equal(w.s.defaultOf(w.cus), w.other);
  assert.equal(await w.queue.get(w.cus), null);
});

test('webhook: if the work cannot be recorded, the event is not acknowledged', async () => {
  const w = world();
  const event = await lateLanding(w);
  const tx = w.db.runTransaction;
  (w.db as any).runTransaction = async (fn: any) => { throw new Error('firestore unavailable'); void fn; void tx; };
  const res = await w.deliverEvent(event);
  assert.equal(res.code, 500); // Stripe redelivers
});

test('drain: a watched write that lands with no webhook delivered is found on the next revisit', async () => {
  const w = world();
  await lateLanding(w); // its event is never delivered (e.g. the endpoint isn't subscribed to it)
  await w.queue.enqueue(w.cus, 'watch', Date.now() - 1); // the revisit scheduled while it was watched
  const drained = await w.runDrain();
  assert.equal(drained.body.ran, 1);
  assert.equal(w.s.defaultOf(w.cus), w.other);
  assert.equal(w.s.subs.get(w.sub).default_payment_method, w.other);
  assert.deepEqual(await w.lock.run(w.cus, (l) => l.pendingWrites()), []);
});

test('a run that leaves a watched write schedules its own revisit', async () => {
  const w = world();
  const at = Date.now();
  await w.lock.run(w.cus, (l) => l.addPendingWrite({ id: 'w', kind: 'set-default', target: w.pm, idempotencyKey: 'pm-reconcile:w2', sinceSeq: 0, at, sendBy: at + 120_000 }));
  await w.queue.enqueue(w.cus, 'test', Date.now() - 1);
  await w.runDrain(); // claims it (never sent) and keeps watching
  const item = await w.queue.get(w.cus);
  assert.ok(item && item.dueAt > Date.now() + 60 * 60 * 1000, 'revisit scheduled within the watch window');
});

// Seventh review #2: a business handler that fails must not skip recording the work.
test('webhook: work is recorded before the business handlers, so a handler failure still leaves it queued', async () => {
  const w = world();
  const copy = w.s.addCard(w.cus, 'fp_A');
  const collection = w.db.collection;
  (w.db as any).collection = (name: string) => {
    if (name === 'users') throw new Error('user lookup failed'); // payment_method.attached's handler
    return collection(name);
  };
  const event = { id: 'evt_attach', type: 'payment_method.attached', data: { object: { object: 'payment_method', id: copy, customer: w.cus }, previous_attributes: {} } };
  const res = await w.deliverEvent(event);
  assert.equal(res.code, 200); // the catch-all acknowledges...
  const item = await w.queue.get(w.cus);
  assert.ok(item, '...but only after the work was durably recorded');
  assert.equal(item!.reason, 'payment_method.attached');
});
