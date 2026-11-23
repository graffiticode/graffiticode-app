import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStripe } from './fixtures/fake-stripe';
import { fakeFirestore } from './fixtures/fake-firestore';
import { LEASE_MS, memoryCustomerLock, firestoreCustomerLock, type CustomerLock } from './billing-customer-lock';
import {
  RECONCILE_ON, RETRY_SOON_MS, WATCH_REVISIT_MS, backoff, eventCustomerId, firestoreReconcileQueue,
  memoryReconcileQueue, processDueWork, runReconcileWork, type ReconcileQueue,
} from './billing-reconcile-queue';

test('the customer an event concerns, for every event that triggers reconciliation', () => {
  const ev = (type: string, object: any, previous_attributes: any = {}) => ({ type, data: { object, previous_attributes } }) as any;
  assert.equal(eventCustomerId(ev('customer.updated', { object: 'customer', id: 'cus_1' })), 'cus_1');
  assert.equal(eventCustomerId(ev('payment_method.detached', { object: 'payment_method', id: 'pm_1', customer: null }, { customer: 'cus_2' })), 'cus_2');
  assert.equal(eventCustomerId(ev('payment_method.attached', { object: 'payment_method', id: 'pm_1', customer: 'cus_3' })), 'cus_3');
  assert.equal(eventCustomerId(ev('customer.subscription.updated', { object: 'subscription', id: 'sub_1', customer: 'cus_4' })), 'cus_4');
  assert.equal(eventCustomerId(ev('checkout.session.completed', { object: 'checkout.session', id: 'cs_1', customer: { id: 'cus_5' } })), 'cus_5');
  assert.equal(eventCustomerId(ev('invoice.paid', { object: 'invoice', id: 'in_1', customer: 'cus_6' })), 'cus_6');
  for (const t of ['customer.updated', 'payment_method.detached', 'customer.subscription.updated']) assert.ok(RECONCILE_ON.has(t), t);
});

for (const [name, make] of [
  ['memory', (now: () => number) => memoryReconcileQueue(now)],
  ['firestore', (now: () => number) => firestoreReconcileQueue(fakeFirestore() as any, now)],
] as Array<[string, (now: () => number) => ReconcileQueue]>) {
  test(`${name} queue: a trigger during a run is not lost; due order; reschedule keeps the item`, async () => {
    let now = 1_000;
    const q = make(() => now);
    await q.enqueue('cus_a', 'e1');
    const tok = async (c: string) => { const i = (await q.get(c))!; return { generation: i.generation, seq: i.seq }; };
    const started = await tok('cus_a');
    await q.enqueue('cus_a', 'e2'); // arrives mid-run
    await q.complete('cus_a', started);
    assert.ok(await q.get('cus_a'), 'the newer trigger keeps it');
    await q.complete('cus_a', await tok('cus_a'));
    assert.equal(await q.get('cus_a'), null);

    await q.enqueue('cus_b', 'x', 5_000);
    await q.enqueue('cus_c', 'x', 2_000);
    now = 3_000;
    assert.deepEqual((await q.due(now, 10)).map((i) => i.customerId), ['cus_c']);
    await q.reschedule('cus_c', await tok('cus_c'), 9_000, { attempts: 2, lastError: 'boom' });
    assert.deepEqual(await q.due(now, 10), []);
    const kept = (await q.get('cus_c'))!;
    assert.deepEqual([kept.dueAt, kept.attempts, kept.lastError], [9_000, 2, 'boom']);
  });
}

function scene(lock: CustomerLock = memoryCustomerLock()) {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const pm = s.addCard(cus, 'fp_A');
  s.customersById.get(cus).invoice_settings.default_payment_method = pm;
  let now = 10_000;
  const q = memoryReconcileQueue(() => now);
  return { s, cus, pm, q, lock, clock: { get: () => now, set: (t: number) => { now = t; } } };
}

test('work: a run with nothing left completes and removes the item', async () => {
  const { s, cus, q, lock, clock } = scene();
  await q.enqueue(cus, 'test');
  const out = await runReconcileWork(s as any, lock, q, cus, 'apply', clock.get);
  assert.equal(out.kind, 'done');
  assert.equal(await q.get(cus), null);
});

test('work: a busy lock keeps the item, retried soon, without counting a failure', async () => {
  const { s, cus, q, lock, clock } = scene();
  await q.enqueue(cus, 'test');
  let release!: () => void;
  const held = lock.run(cus, () => new Promise<void>((r) => { release = r; }));
  const out = await runReconcileWork(s as any, lock, q, cus, 'apply', clock.get);
  release();
  await held;
  assert.equal(out.kind, 'again');
  const item = (await q.get(cus))!;
  assert.equal(item.dueAt, clock.get() + RETRY_SOON_MS);
  assert.equal(item.attempts, 0);
});

test('work: a failure keeps the item with backoff and the error', async () => {
  const { s, cus, q, lock, clock } = scene();
  await q.enqueue(cus, 'test');
  const list = s.paymentMethods.list;
  s.paymentMethods.list = async () => { throw new Error('stripe down'); };
  await runReconcileWork(s as any, lock, q, cus, 'apply', clock.get);
  await runReconcileWork(s as any, lock, q, cus, 'apply', clock.get);
  const item = (await q.get(cus))!;
  assert.equal(item.attempts, 2);
  assert.equal(item.dueAt, clock.get() + backoff(2));
  assert.match(item.lastError!, /stripe down/);
  s.paymentMethods.list = list;
  assert.equal((await runReconcileWork(s as any, lock, q, cus, 'apply', clock.get)).kind, 'done');
  assert.equal(await q.get(cus), null);
});

test('work: while writes are watched the item is revisited, within the watch window', async () => {
  const { s, cus, q, lock, clock } = scene();
  await lock.run(cus, (l) => l.addPendingWrite({ id: 'w', kind: 'set-default', target: 'pm_x', idempotencyKey: 'pm-reconcile:w', sinceSeq: 0, at: Date.now(), claimedAt: Date.now() }));
  await q.enqueue(cus, 'test');
  const out = await runReconcileWork(s as any, lock, q, cus, 'apply', clock.get);
  assert.equal(out.kind, 'again');
  assert.equal((await q.get(cus))!.dueAt, clock.get() + WATCH_REVISIT_MS);
  assert.ok(WATCH_REVISIT_MS < 24 * 60 * 60 * 1000, 'revisited many times inside the 29-day watch');
});

test('drain: runs only due items, and leaves the rest', async () => {
  const { s, cus, q, lock, clock } = scene();
  const other = s.addCustomer();
  await q.enqueue(cus, 'now');
  await q.enqueue(other, 'later', clock.get() + 60_000);
  const ran = await processDueWork(s as any, lock, q, 'apply', { now: clock.get });
  assert.deepEqual(ran.map((r) => r.customerId), [cus]);
  assert.ok(await q.get(other));
});

test('dry-run work is drained too, and changes nothing', async () => {
  const { s, cus, q, lock, clock } = scene(firestoreCustomerLock(fakeFirestore() as any));
  s.addCard(cus, 'fp_A');
  await q.enqueue(cus, 'test');
  const n = s.calls.length;
  const out = await runReconcileWork(s as any, lock, q, cus, 'dry-run', clock.get);
  assert.equal(out.kind, 'done');
  assert.ok(!s.calls.slice(n).some((c) => /update|detach/.test(c)));
});

// Seventh review #1: a stale worker must not touch work that was completed and created again.
for (const [name, make] of [
  ['memory', (now: () => number) => memoryReconcileQueue(now)],
  ['firestore', (now: () => number) => firestoreReconcileQueue(fakeFirestore() as any, now)],
] as Array<[string, (now: () => number) => ReconcileQueue]>) {
  test(`${name} queue: a stale worker can neither complete nor reschedule a recreated item`, async () => {
    const q = make(() => 1_000);
    await q.enqueue('cus', 'first');
    const seen = (await q.get('cus'))!;
    const token = { generation: seen.generation, seq: seen.seq };
    await q.complete('cus', token); // worker B finishes it
    await q.enqueue('cus', 'new trigger'); // and a new trigger creates it again, at seq 1
    const recreated = (await q.get('cus'))!;
    assert.equal(recreated.seq, token.seq);
    assert.notEqual(recreated.generation, token.generation);
    await q.complete('cus', token); // worker A, stale
    await q.reschedule('cus', token, 99_999, { attempts: 5, lastError: 'stale' });
    assert.deepEqual(await q.get('cus'), recreated);
  });
}

test('work: a run that waited on the lock while its item was completed and recreated leaves the new item', async () => {
  const { s, cus, q, lock, clock } = scene();
  await q.enqueue(cus, 'first');
  let release!: () => void;
  const held = lock.run(cus, () => new Promise<void>((r) => { release = r; }));
  const stale = runReconcileWork(s as any, lock, q, cus, 'apply', clock.get); // reads its token, then waits
  await new Promise((r) => setTimeout(r, 20));
  const first = (await q.get(cus))!;
  await q.complete(cus, { generation: first.generation, seq: first.seq }); // another worker finished it
  await q.enqueue(cus, 'new trigger');
  const recreated = (await q.get(cus))!;
  release();
  await held;
  assert.equal((await stale).kind, 'done');
  assert.deepEqual(await q.get(cus), recreated, 'the new trigger survives');
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Eighth review #1: after a lost lease the result must still report retained watches.
test('work: a run that loses its lease still reports its watched write, and schedules the revisit', async () => {
  let clock = 0;
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const old = s.addCard(cus, 'fp_A');
  const keeper = s.addCard(cus, 'fp_A');
  s.customersById.get(cus).invoice_settings.default_payment_method = old;
  s.addSubscription(cus, keeper);
  const lock = memoryCustomerLock(() => clock);
  const q = memoryReconcileQueue(() => clock);
  const at = Date.now();
  await lock.run(cus, (l) => l.addPendingWrite({ id: 'watch', kind: 'set-default', target: old, idempotencyKey: 'pm-reconcile:watch', sinceSeq: 0, at, sendBy: at + 120_000, claimedAt: at }));
  await q.enqueue(cus, 'watch');
  let reads = 0;
  s.onRead = () => { if (++reads === 2) clock = LEASE_MS + 1; }; // the lease lapses before the next write
  const outcome = await runReconcileWork(s as any, lock, q, cus, 'apply', () => clock);
  assert.equal(outcome.kind, 'again');
  assert.equal((await lock.run(cus, (l) => l.pendingWrites())).length, 1);
  const item = await q.get(cus);
  assert.ok(item, 'work kept for the watch');
  assert.equal(item!.dueAt, clock + WATCH_REVISIT_MS);
});

// Eighth review #2: a run that still has outstanding effects keeps durable work, whoever completed its item.
test('work: an overlapping run keeps its retry after another run completed the item', async () => {
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const old = s.addCard(cus, 'fp_A');
  s.addCard(cus, 'fp_A');
  s.customersById.get(cus).invoice_settings.default_payment_method = old;
  const lock = memoryCustomerLock();
  const q = memoryReconcileQueue();
  await q.enqueue(cus, 'operator apply');
  const atComplete = gate(), allowComplete = gate(), atSend = gate(), allowSend = gate();
  const slowQueue = { ...q, complete: async (c: string, t: any) => { atComplete.resolve(); await allowComplete.promise; return q.complete(c, t); } };
  const first = runReconcileWork(s as any, lock, slowQueue, cus, 'dry-run');
  await atComplete.promise; // done with Stripe, about to acknowledge
  s.paymentMethods.detach = async () => { atSend.resolve(); await allowSend.promise; throw Object.assign(new Error('response unavailable'), { type: 'StripeConnectionError' }); };
  const second = runReconcileWork(s as any, lock, q, cus, 'apply'); // read the same token
  await atSend.promise; // and recorded its pending write
  allowComplete.resolve();
  await first;
  assert.equal(await q.get(cus), null); // the first run completed the item
  allowSend.resolve();
  const out = await second;
  assert.equal(out.kind, 'again');
  assert.equal((await lock.run(cus, (l) => l.pendingWrites())).length, 1);
  const item = await q.get(cus);
  assert.ok(item, 'the outstanding write still has durable work');
  assert.ok(item!.dueAt <= Date.now() + 60 * 60 * 1000);
});

test('rescheduling onto a recreated item only ever brings its due time forward', async () => {
  const q = memoryReconcileQueue(() => 1_000);
  await q.enqueue('cus', 'first', 50_000);
  const i0 = (await q.get('cus'))!;
  const old = { generation: i0.generation, seq: i0.seq };
  await q.complete('cus', old);
  await q.enqueue('cus', 'new', 50_000);
  const fresh = (await q.get('cus'))!;
  await q.reschedule('cus', old, 20_000, { attempts: 3, lastError: 'x' });
  const after = (await q.get('cus'))!;
  assert.deepEqual({ ...after, dueAt: 0 }, { ...fresh, dueAt: 0 }, 'generation, seq, attempts and error untouched');
  assert.equal(after.dueAt, 20_000);
  await q.reschedule('cus', old, 90_000, { attempts: 3, lastError: 'x' });
  assert.equal((await q.get('cus'))!.dueAt, 20_000, 'never pushed later');
});

test('a stale reschedule leaves an already-due recreated item exactly as it is', async () => {
  const q = memoryReconcileQueue(() => 1_000);
  await q.enqueue('cus', 'first');
  const i0 = (await q.get('cus'))!;
  await q.complete('cus', { generation: i0.generation, seq: i0.seq });
  await q.enqueue('cus', 'new'); // due now
  const fresh = (await q.get('cus'))!;
  await q.reschedule('cus', { generation: i0.generation, seq: i0.seq }, 10, { attempts: 4, lastError: 'stale' });
  assert.deepEqual(await q.get('cus'), fresh);
});

// Ninth review: a run that dies after recording a pending write must not have its work deleted by another run's completion.
for (const [name, make] of [
  ['firestore', (now: () => number) => { const db = fakeFirestore(); return { lock: firestoreCustomerLock(db as any, now), q: firestoreReconcileQueue(db as any, now) }; }],
  ['memory (linked)', (now: () => number) => {
    const items = new Map();
    const lock = memoryCustomerLock(now, { workItems: items });
    return { lock, q: memoryReconcileQueue(now, { items, pendingCount: lock.pendingCount }) };
  }],
] as Array<[string, (now: () => number) => { lock: CustomerLock; q: ReconcileQueue }]>) {
  test(`${name}: completion is fenced by a pending write whose caller died`, async () => {
    let clock = Date.now();
    const s = new FakeStripe();
    const cus = s.addCustomer();
    const old = s.addCard(cus, 'fp_A');
    s.addCard(cus, 'fp_A');
    s.customersById.get(cus).invoice_settings.default_payment_method = old;
    const { lock, q } = make(() => clock);
    await q.enqueue(cus, 'operator apply');
    const atComplete = gate(), allowComplete = gate(), atSend = gate();
    const slowQueue = { ...q, complete: async (c: string, t: any) => { atComplete.resolve(); await allowComplete.promise; return q.complete(c, t); } };
    const a = runReconcileWork(s as any, lock, slowQueue, cus, 'dry-run', () => clock); // finishes, then pauses before completing
    await atComplete.promise;
    const detach = s.paymentMethods.detach;
    s.paymentMethods.detach = async () => { atSend.resolve(); return new Promise<never>(() => {}); }; // B dies mid-call
    void runReconcileWork(s as any, lock, q, cus, 'apply', () => clock);
    await atSend.promise; // B recorded its pending write and is gone
    allowComplete.resolve();
    await a;
    const item = await q.get(cus);
    assert.ok(item, 'the pending write keeps durable work');
    // Later: B's lease lapses and the work comes due; the drain settles B's write.
    s.paymentMethods.detach = detach;
    clock += 10 * 60 * 1000;
    const ran = await processDueWork(s as any, lock, q, 'apply', { now: () => clock });
    assert.deepEqual(ran.map((r) => r.customerId), [cus]);
    const [watched] = await lock.run(cus, (l) => l.pendingWrites());
    assert.ok(watched?.claimedAt, 'claimed (it never reached Stripe) and watched');
    assert.ok(await q.get(cus), 'and still covered by work, for its revisit');
  });
}

test('a run that settles its own writes still completes its item', async () => {
  const items = new Map();
  const lock = memoryCustomerLock(Date.now, { workItems: items });
  const q = memoryReconcileQueue(Date.now, { items, pendingCount: lock.pendingCount });
  const s = new FakeStripe();
  const cus = s.addCustomer();
  const old = s.addCard(cus, 'fp_A');
  s.addCard(cus, 'fp_A');
  s.customersById.get(cus).invoice_settings.default_payment_method = old;
  await q.enqueue(cus, 'test');
  const out = await runReconcileWork(s as any, lock, q, cus, 'apply');
  assert.equal(out.kind, 'done');
  assert.equal(s.attached(cus).length, 1, 'it wrote (detached the duplicate)');
  assert.equal(await q.get(cus), null);
});

for (const [name, make] of [
  ['firestore', (now: () => number) => { const db = fakeFirestore(); return { lock: firestoreCustomerLock(db as any, now), q: firestoreReconcileQueue(db as any, now) }; }],
  ['memory (linked)', (now: () => number) => {
    const items = new Map();
    const lock = memoryCustomerLock(now, { workItems: items });
    return { lock, q: memoryReconcileQueue(now, { items, pendingCount: lock.pendingCount }) };
  }],
] as Array<[string, (now: () => number) => { lock: CustomerLock; q: ReconcileQueue }]>) {
  test(`${name}: recording a pending write creates work when none exists, due after its send window`, async () => {
    const t = Date.now();
    const { lock, q } = make(() => t);
    assert.equal(await q.get('cus'), null);
    await lock.run('cus', (l) => l.addPendingWrite({ id: 'w', kind: 'detach', target: 'pm_x', idempotencyKey: 'pm-reconcile:w', sinceSeq: 0, at: t, sendBy: t + 120_000 }));
    const item = await q.get('cus'); // its writer may die now; the work is already durable
    assert.ok(item);
    assert.ok(item!.dueAt > t + 120_000 && item!.dueAt <= t + 180_000, String(item!.dueAt - t));
    const before = item!;
    await lock.run('cus', (l) => l.addPendingWrite({ id: 'w2', kind: 'detach', target: 'pm_y', idempotencyKey: 'pm-reconcile:w2', sinceSeq: 0, at: t, sendBy: t + 120_000 }));
    assert.deepEqual(await q.get('cus'), before, 'an existing item is not re-triggered (its runs can still complete it)');
  });
}
