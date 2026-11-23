import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CustomerLockBusy,
  LEASE_MS,
  LeaseLost,
  firestoreCustomerLock,
  memoryCustomerLock,
  withCustomerLease,
  type CustomerLock,
  type PurchaseReservation,
} from './billing-customer-lock';
import { response } from './fixtures/load-route';
import { fakeFirestore } from './fixtures/fake-firestore';

const reservation: PurchaseReservation = { kind: 'saved-card', attemptKey: 'k', idempotencyKey: 'i', params: { a: 1 }, createdAt: 1 };

for (const [name, make] of [
  ['memory', (now: () => number) => memoryCustomerLock(now)],
  ['firestore', (now: () => number) => firestoreCustomerLock(fakeFirestore() as any, now)],
] as Array<[string, (now: () => number) => CustomerLock]>) {
  test(`${name}: one holder at a time; a waiter that can't get it in time is told busy`, async () => {
    const lock = make(Date.now);
    let inside = 0;
    let max = 0;
    const work = () => lock.run('cus', async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 20)); inside--; }, { waitMs: 5_000 });
    await Promise.all([work(), work(), work()]);
    assert.equal(max, 1);
    let release!: () => void;
    const held = lock.run('cus', () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(lock.run('cus', async () => 1, { waitMs: 0 }), CustomerLockBusy);
    release();
    await held;
  });

  test(`${name}: the reservation outlives the lease and the next holder sees it`, async () => {
    const lock = make(Date.now);
    await lock.run('cus', (l) => l.reserve(reservation));
    assert.deepEqual(await lock.run('cus', (l) => l.reservation()), reservation);
    await lock.run('cus', (l) => l.clearReservation());
    assert.equal(await lock.run('cus', (l) => l.reservation()), null);
  });

  test(`${name}: after a takeover the old holder's writes are refused and the new holder's record stands`, async () => {
    let now = 0;
    const lock = make(() => now);
    let resume!: () => void;
    const paused = new Promise<void>((r) => { resume = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const old = lock.run('cus', async (l) => {
      entered();
      await paused;
      await assert.rejects(l.reserve({ ...reservation, attemptKey: 'old' }), LeaseLost);
      await assert.rejects(l.clearReservation(), LeaseLost);
      await assert.rejects(l.assertHeld(), LeaseLost);
    });
    await inside;
    now = LEASE_MS + 1;
    await lock.run('cus', (l) => l.reserve({ ...reservation, attemptKey: 'new' }));
    resume();
    await old;
    assert.equal(((await lock.run('cus', (l) => l.reservation())) as any).attemptKey, 'new');
  });
}

for (const [name, make] of [
  ['memory', (now: () => number) => memoryCustomerLock(now)],
  ['firestore', (now: () => number) => firestoreCustomerLock(fakeFirestore() as any, now)],
] as Array<[string, (now: () => number) => CustomerLock]>) {
  test(`${name}: renewal extends the lease; recorded default choices are fenced and sequenced`, async () => {
    let now = 0;
    const lock = make(() => now);
    await lock.run('cus', async (l) => {
      now = LEASE_MS - 1;
      await l.renew();
      now = LEASE_MS + 10; // past the original expiry, inside the renewed one
      await l.assertHeld();
      assert.equal(await l.recordDefaultChoice({ paymentMethodId: 'pm_1', fingerprint: 'fp', subscriptions: true }), 1);
      assert.equal(await l.recordDefaultChoice({ paymentMethodId: 'pm_2', fingerprint: 'fp', subscriptions: false }), 2);
    });
    assert.deepEqual(await lock.run('cus', (l) => l.defaultChoice()), { paymentMethodId: 'pm_2', fingerprint: 'fp', subscriptions: false, seq: 2 });
    let resume!: () => void;
    const paused = new Promise<void>((r) => { resume = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const stale = lock.run('cus', async (l) => {
      entered();
      await paused;
      await assert.rejects(l.renew(), LeaseLost);
      await assert.rejects(l.recordDefaultChoice({ paymentMethodId: 'pm_x', fingerprint: null, subscriptions: false }), LeaseLost);
    });
    await inside;
    now += LEASE_MS + 1;
    await lock.run('cus', async () => {});
    resume();
    await stale;
    assert.equal((await lock.run('cus', (l) => l.defaultChoice()))!.seq, 2);
  });
}

for (const [name, make] of [
  ['memory', (now: () => number) => memoryCustomerLock(now)],
  ['firestore', (now: () => number) => firestoreCustomerLock(fakeFirestore() as any, now)],
] as Array<[string, (now: () => number) => CustomerLock]>) {
  test(`${name}: pending writes are fenced, tracked individually, and outlive the lease`, async () => {
    let now = 0;
    const lock = make(() => now);
    const w = (id: string) => ({ id, kind: 'set-default' as const, target: 'pm', idempotencyKey: `k-${id}`, sinceSeq: 0, at: 0 });
    await lock.run('cus', async (l) => {
      await l.addPendingWrite(w('a'));
      await l.addPendingWrite(w('b'));
    });
    assert.deepEqual((await lock.run('cus', (l) => l.pendingWrites())).map((x) => x.id), ['a', 'b']);
    let resume!: () => void;
    const paused = new Promise<void>((r) => { resume = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const stale = lock.run('cus', async (l) => {
      entered();
      await paused;
      await assert.rejects(l.removePendingWrites(['a']), LeaseLost); // can't forget what may still land
      await assert.rejects(l.addPendingWrite(w('c')), LeaseLost);
    });
    await inside;
    now += LEASE_MS + 1;
    await lock.run('cus', (l) => l.removePendingWrites(['b']));
    resume();
    await stale;
    assert.deepEqual((await lock.run('cus', (l) => l.pendingWrites())).map((x) => x.id), ['a']);
  });
}

test('withCustomerLease answers 409 while another operation holds the lease', async () => {
  const lock = memoryCustomerLock();
  let release!: () => void;
  const held = lock.run('cus', () => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 5));
  const res = response();
  const started = Date.now();
  const p = withCustomerLease(lock, 'cus', res, async () => 'ran');
  setTimeout(release, 50); // frees in time: the route waits and runs
  assert.equal(await p, 'ran');
  assert.ok(Date.now() - started >= 40);
  await held;
});
