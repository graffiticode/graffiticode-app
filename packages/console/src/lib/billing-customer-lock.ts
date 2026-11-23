/**
 * Per-customer coordination for billing operations that read Stripe state and
 * then act on it: purchases (saved-card subscribe, Checkout), duplicate-card
 * reconciliation, and the console's own default-card changes.
 *
 * Two parts, kept in one record per customer:
 *
 *  - A lease (holder + expiry) that serializes operations. It expires on its
 *    own (LEASE_MS), so a crashed holder delays the next operation rather than
 *    blocking it. Because it can expire while its holder is still running,
 *    the lease alone never decides anything that must happen at most once.
 *
 *  - A purchase reservation: the in-flight purchase's exact Stripe create
 *    parameters and idempotency key, written before the create call and kept
 *    after the lease is released (for Checkout, while its session can still
 *    be completed). Whoever holds the lease next recovers that purchase first,
 *    by replaying the create with the same key, which returns the original
 *    object instead of making another (billing-purchase.ts), before allowing
 *    a different one.
 *
 * Reservation writes are fenced: they succeed only while the writer still
 * holds the lease, so a holder whose lease was taken over can't overwrite the
 * new holder's record.
 */
import { randomUUID } from 'node:crypto';
import { LOCK_COLLECTION, WORK_COLLECTION, ensureWork, type WorkItem } from './billing-work-item';

export const LEASE_MS = 60_000;

export class CustomerLockBusy extends Error {
  constructor(customerId: string) {
    super(`Billing operation already in progress for ${customerId}`);
    this.name = 'CustomerLockBusy';
  }
}

/** The lease was taken over (it expired while this holder ran). */
export class LeaseLost extends Error {
  constructor(customerId: string) {
    super(`Billing lease for ${customerId} was taken over`);
    this.name = 'LeaseLost';
  }
}

export type PurchaseReservation =
  | {
      kind: 'saved-card';
      attemptKey: string;
      idempotencyKey: string;
      /** Stripe.SubscriptionCreateParams, as sent. */
      params: Record<string, unknown>;
      subscriptionId?: string;
      createdAt: number;
    }
  | {
      kind: 'checkout';
      idempotencyKey: string;
      /** Stripe.Checkout.SessionCreateParams, as sent. */
      params: Record<string, unknown>;
      sessionId?: string;
      createdAt: number;
    };

/**
 * The latest default-card choice made through the console, recorded under the
 * lease. Stripe has no conditional update, so a holder whose lease expired
 * mid-write can still land a write after a later console change; this record
 * is what lets it notice and put the user's choice back
 * (billing-payment-methods.ts).
 */
export interface DefaultChoice {
  paymentMethodId: string;
  /** The card's fingerprint, so an equivalent copy can stand in if this one is gone. */
  fingerprint: string | null;
  /** Whether the choice also applied to the customer's active subscriptions. */
  subscriptions: boolean;
  /** Increases with every recorded choice. */
  seq: number;
}

export interface LeaseHandle {
  customerId: string;
  /** Throws LeaseLost if this holder no longer has the lease. */
  assertHeld(): Promise<void>;
  reservation(): Promise<PurchaseReservation | null>;
  /** Fenced: throws LeaseLost if the lease was taken over. */
  reserve(r: PurchaseReservation): Promise<void>;
  /** Fenced: throws LeaseLost if the lease was taken over. */
  clearReservation(): Promise<void>;
  /** Fenced: extend the lease to a full LEASE_MS from now. Call before each Stripe write. */
  renew(): Promise<void>;
  defaultChoice(): Promise<DefaultChoice | null>;
  /** Fenced: record a console default-card change; returns its seq. */
  recordDefaultChoice(c: Omit<DefaultChoice, 'seq'>): Promise<number>;
  /** Reconciliation writes sent (or about to be sent) and not yet known to be settled. */
  pendingWrites(): Promise<PendingWrite[]>;
  /** Fenced: record a write before sending it. */
  addPendingWrite(w: PendingWrite): Promise<void>;
  /** Fenced: forget writes known to be settled. */
  removePendingWrites(ids: string[]): Promise<void>;
}

/**
 * One reconciliation write to Stripe, recorded before it is sent and kept
 * until its effect is known to be settled: either its caller saw the response
 * while holding the lease throughout, or a later run claimed its idempotency
 * key at Stripe (billing-payment-methods.ts), after which the original can no
 * longer apply. Until then the write may still land, so it outlives its
 * caller's lease, failure or death.
 */
export interface PendingWrite {
  id: string;
  kind: 'set-default' | 'detach' | 'restore-default' | 'restore-subscription';
  /** The object written: a payment method or subscription id. */
  target: string;
  idempotencyKey: string;
  /** The default-choice seq the write was planned from; a later choice must win over it. */
  sinceSeq: number;
  at: number;
  /** The writer never sends after this (ms); its client neither retries nor outlasts it. */
  sendBy?: number;
  /**
   * When a later run claimed the key at Stripe. A claimed write is kept and
   * watched: the claim fences it only while Stripe retains the key, so later
   * runs look for it in Stripe's events instead.
   */
  claimedAt?: number;
}

export interface CustomerLock {
  /** Run fn while holding the customer's lease; throws CustomerLockBusy if it can't be had within waitMs. */
  run<T>(customerId: string, fn: (lease: LeaseHandle) => Promise<T>, opts?: { waitMs?: number }): Promise<T>;
}

interface Record_ {
  holder: string | null;
  expiresAt: number;
  reservation: PurchaseReservation | null;
  defaultChoice: DefaultChoice | null;
  pendingWrites: PendingWrite[];
}

/** Storage for one record per customer, with an atomic read-modify-write. */
/** Work to record in the same transaction as a change (see addPendingWrite). */
interface Trigger { reason: string; dueAt: number }

interface RecordStore {
  update<T>(customerId: string, fn: (cur: Record_ | null) => { next?: Record_; result: T; trigger?: Trigger }): Promise<T>;
}

/** A pending write's own work comes due just after its writer's send window, so a live writer isn't raced. */
const PENDING_WORK_GRACE_MS = 30_000;
const DEFAULT_SEND_WINDOW_MS = 2 * 60 * 1000;

function lockOver(store: RecordStore, now: () => number): CustomerLock {
  const held = (r: Record_ | null, holder: string) => !!r && r.holder === holder && r.expiresAt > now();
  return {
    async run(customerId, fn, opts = {}) {
      const holder = randomUUID();
      const deadline = now() + (opts.waitMs ?? 0);
      let delay = 100;
      const acquire = () => store.update(customerId, (cur) => {
        if (cur?.holder && cur.expiresAt > now()) return { result: false };
        return {
          next: { holder, expiresAt: now() + LEASE_MS, reservation: cur?.reservation ?? null, defaultChoice: cur?.defaultChoice ?? null, pendingWrites: cur?.pendingWrites ?? [] },
          result: true,
        };
      });
      while (!(await acquire())) {
        if (now() >= deadline) throw new CustomerLockBusy(customerId);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 1_000);
      }
      const fenced = (change: (r: Record_) => Record_) => store.update(customerId, (cur) => {
        if (!held(cur, holder)) throw new LeaseLost(customerId);
        return { next: change(cur!), result: undefined };
      });
      const lease: LeaseHandle = {
        customerId,
        assertHeld: () => store.update(customerId, (cur) => {
          if (!held(cur, holder)) throw new LeaseLost(customerId);
          return { result: undefined };
        }),
        reservation: () => store.update(customerId, (cur) => ({ result: cur?.reservation ?? null })),
        reserve: (reservation) => fenced((r) => ({ ...r, reservation })),
        clearReservation: () => fenced((r) => ({ ...r, reservation: null })),
        renew: () => fenced((r) => ({ ...r, expiresAt: now() + LEASE_MS })),
        defaultChoice: () => store.update(customerId, (cur) => ({ result: cur?.defaultChoice ?? null })),
        recordDefaultChoice: (c) => store.update(customerId, (cur) => {
          if (!held(cur, holder)) throw new LeaseLost(customerId);
          const seq = (cur!.defaultChoice?.seq ?? 0) + 1;
          return { next: { ...cur!, defaultChoice: { ...c, seq } }, result: seq };
        }),
        pendingWrites: () => store.update(customerId, (cur) => ({ result: cur?.pendingWrites ?? [] })),
        // Recording a pending write makes sure reconciliation work exists, in
        // the same transaction, so the write is covered even if its caller dies
        // before rescheduling. (The queue refuses to complete an item while the
        // customer has pending writes, so no run can delete it meanwhile.)
        addPendingWrite: (w) => store.update(customerId, (cur) => {
          if (!held(cur, holder)) throw new LeaseLost(customerId);
          return {
            next: { ...cur!, pendingWrites: [...(cur!.pendingWrites ?? []).filter((x) => x.id !== w.id), w] },
            result: undefined,
            trigger: { reason: `pending ${w.kind}`, dueAt: (w.sendBy ?? w.at + DEFAULT_SEND_WINDOW_MS) + PENDING_WORK_GRACE_MS },
          };
        }),
        removePendingWrites: (ids) => fenced((r) => ({ ...r, pendingWrites: (r.pendingWrites ?? []).filter((x) => !ids.includes(x.id)) })),
      };
      try {
        return await fn(lease);
      } finally {
        await store.update(customerId, (cur) =>
          cur?.holder === holder ? { next: { ...cur, holder: null, expiresAt: 0 }, result: undefined } : { result: undefined },
        ).catch(() => { /* the lease expires on its own */ });
      }
    },
  };
}

/**
 * In-process store, for tests and scripts. Link a memory queue's items to
 * record pending writes' work there in the same step, as Firestore does.
 */
export function memoryCustomerLock(
  now: () => number = Date.now,
  opts: { workItems?: Map<string, WorkItem> } = {},
): CustomerLock & { pendingCount(customerId: string): number } {
  const records = new Map<string, Record_>();
  const lock = lockOver({
    async update(customerId, fn) {
      const cur = records.get(customerId) ?? null;
      const { next, result, trigger } = fn(cur ? structuredClone(cur) : null);
      if (next) records.set(customerId, structuredClone(next));
      if (trigger && opts.workItems) {
        opts.workItems.set(customerId, ensureWork(opts.workItems.get(customerId) ?? null, customerId, trigger.reason, trigger.dueAt));
      }
      return result;
    },
  }, now);
  return Object.assign(lock, { pendingCount: (customerId: string) => records.get(customerId)?.pendingWrites?.length ?? 0 });
}

/**
 * For API routes that change a customer's cards or default: run fn under the
 * customer's lease, or answer 409 when another billing operation holds it.
 */
export async function withCustomerLease<T>(
  lock: CustomerLock,
  customerId: string,
  res: { status(code: number): { json(body: unknown): unknown } },
  fn: (lease: LeaseHandle) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await lock.run(customerId, fn, { waitMs: 10_000 });
  } catch (e) {
    if (e instanceof CustomerLockBusy || e instanceof LeaseLost) {
      res.status(409).json({ busy: true, error: 'Another billing change is in progress. Please try again in a moment.' });
      return undefined;
    }
    throw e;
  }
}

/** Minimal Firestore surface the lock needs (the Admin SDK's Firestore satisfies it). */
interface LockFirestore {
  collection(name: string): { doc(id: string): any };
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/** Firestore-backed store shared by every console instance. */
export function firestoreCustomerLock(db: LockFirestore, now: () => number = Date.now): CustomerLock {
  const ref = (customerId: string) => db.collection(LOCK_COLLECTION).doc(customerId);
  return lockOver({
    update(customerId, fn) {
      return db.runTransaction(async (tx) => {
        // All reads first, as Firestore transactions require.
        const snap = await tx.get(ref(customerId));
        const workRef = db.collection(WORK_COLLECTION).doc(customerId);
        const work = await tx.get(workRef);
        const data = snap.exists ? snap.data() : null;
        const cur: Record_ | null = data
          ? { holder: data.holder ?? null, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : 0, reservation: data.reservation ?? null, defaultChoice: data.defaultChoice ?? null, pendingWrites: data.pendingWrites ?? [] }
          : null;
        const { next, result, trigger } = fn(cur);
        if (next) tx.set(ref(customerId), next);
        if (trigger) tx.set(workRef, ensureWork(work.exists ? (work.data() as WorkItem) : null, customerId, trigger.reason, trigger.dueAt));
        return result;
      });
    },
  }, now);
}
