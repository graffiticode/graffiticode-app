/**
 * Durable reconciliation work, one item per Stripe customer.
 *
 * Reconciliation must run again whenever a customer's card state may need it:
 * after the events that change it (including a late landing of an earlier
 * reconciliation write), after a run that was busy or failed, and while
 * pending or watched writes remain (billing-payment-methods.ts). A webhook
 * that ran reconciliation inline and acknowledged a busy or failed run would
 * lose that work, so the webhook only records it here, then tries it once;
 * a scheduled drain (api/internal/billing-reconcile) runs whatever is due.
 *
 * An item is only ever completed or rescheduled by the run that saw it last.
 * Each item carries a random `generation` assigned when it is created, and a
 * `seq` that every trigger bumps; a run holds both (a WorkToken) and changes
 * the item only if both still match. So a trigger that arrives mid-run is not
 * lost, and a worker that read an item which was since completed and created
 * again can't touch the new one.
 */
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { CustomerLockBusy, LeaseLost, type CustomerLock } from './billing-customer-lock';
import { reconcileDuplicateCards, type ReconcileMode, type ReconcileResult, type ReconcileStripe } from './billing-payment-methods';
import { LOCK_COLLECTION, WORK_COLLECTION, withTrigger, type WorkItem } from './billing-work-item';

export type { WorkItem } from './billing-work-item';

/** What a run saw: the item's generation and seq when it started. */
export interface WorkToken { generation: string; seq: number }

export interface ReconcileQueue {
  /** Record that the customer needs reconciling (now, unless an earlier due time is already set). */
  enqueue(customerId: string, reason: string, dueAt?: number): Promise<void>;
  get(customerId: string): Promise<WorkItem | null>;
  /** Items due by `now`, soonest first. */
  due(now: number, limit: number): Promise<WorkItem[]>;
  /**
   * Delete the item only if it is still the one the run saw (same generation
   * and seq) and the customer has no pending writes, read in the same
   * transaction: a write another run recorded (and may never reschedule, if it
   * died) keeps the work.
   */
  complete(customerId: string, token: WorkToken | null): Promise<void>;
  /**
   * The run still has outstanding work (a retry, or writes pending or watched),
   * so work for the customer must exist, due by `dueAt`, whatever happened to
   * the run's own item meanwhile:
   *  - still its item, unchanged: updated (due time, attempts, error);
   *  - its item with a newer trigger: stays due as it is (already sooner);
   *  - gone (another worker completed it): created again, as a new generation;
   *  - another generation now: made due no later than `dueAt` (if not due
   *    already), and nothing else touched, so its own token stays valid.
   */
  reschedule(customerId: string, token: WorkToken | null, dueAt: number, update: { attempts: number; lastError: string | null; reason?: string }): Promise<void>;
}

/** A run with in-flight writes, or one that was busy, is retried soon. */
export const RETRY_SOON_MS = 60_000;
/** While writes are watched (claimed, may still land late), check back this often. */
export const WATCH_REVISIT_MS = 6 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export function backoff(attempts: number): number {
  return Math.min(RETRY_SOON_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/**
 * The customer an event concerns. A Customer event names it by the object's
 * own id; a detached payment method no longer has a customer, so it comes
 * from the event's previous attributes; everything else carries `customer`.
 */
export function eventCustomerId(event: Pick<Stripe.Event, 'type' | 'data'>): string | null {
  const obj = event.data.object as { object?: string; id?: string; customer?: string | { id: string } | null };
  const idOf = (c: string | { id: string } | null | undefined) => (c == null ? null : typeof c === 'string' ? c : c.id);
  if (obj.object === 'customer') return obj.id ?? null;
  if (event.type === 'payment_method.detached') {
    return idOf(obj.customer) ?? idOf((event.data.previous_attributes as any)?.customer);
  }
  return idOf(obj.customer);
}

/** Events after which a customer's cards, or an earlier reconciliation write, may need reconciling. */
export const RECONCILE_ON = new Set<string>([
  'payment_method.attached',
  'payment_method.detached',
  'customer.updated',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'setup_intent.succeeded',
  'invoice.paid',
]);

export type WorkOutcome =
  | { kind: 'done'; result: ReconcileResult | null }
  | { kind: 'again'; dueAt: number; why: string };

/**
 * Run one customer's reconciliation as queued work. Never drops the item on
 * a busy lock or an error; keeps it while pending or watched writes remain.
 */
export async function runReconcileWork(
  stripe: ReconcileStripe,
  lock: CustomerLock,
  queue: ReconcileQueue,
  customerId: string,
  mode: ReconcileMode,
  now: () => number = Date.now,
): Promise<WorkOutcome> {
  const item = await queue.get(customerId);
  const token: WorkToken | null = item ? { generation: item.generation, seq: item.seq } : null;
  const attempts = (item?.attempts ?? 0) + 1;
  let result: ReconcileResult | null;
  try {
    result = await reconcileDuplicateCards(stripe, customerId, { mode, lock, waitMs: 5_000 });
  } catch (e) {
    const busy = e instanceof CustomerLockBusy || e instanceof LeaseLost;
    const dueAt = now() + (busy ? RETRY_SOON_MS : backoff(attempts));
    const why = busy ? 'busy' : `failed: ${(e as Error)?.message ?? String(e)}`;
    await queue.reschedule(customerId, token, dueAt, { attempts: busy ? attempts - 1 : attempts, lastError: busy ? null : why });
    return { kind: 'again', dueAt, why };
  }
  const writes = result?.pendingWrites ?? [];
  const inFlight = writes.some((w) => !w.claimedAt);
  if (writes.length || result?.plan.deferred.length) {
    // Deferred (a purchase settling, a write in flight) or still watching: come back.
    const dueAt = now() + (inFlight || (result?.plan.deferred.length ?? 0) > 0 ? RETRY_SOON_MS : WATCH_REVISIT_MS);
    const why = writes.length ? `${writes.length} write(s) ${inFlight ? 'in flight' : 'watched'}` : `deferred: ${result!.plan.deferred.join('; ')}`;
    await queue.reschedule(customerId, token, dueAt, { attempts: 0, lastError: null });
    return { kind: 'again', dueAt, why };
  }
  await queue.complete(customerId, token);
  return { kind: 'done', result };
}

/** The scheduled drain: run every due item. */
export async function processDueWork(
  stripe: ReconcileStripe,
  lock: CustomerLock,
  queue: ReconcileQueue,
  mode: ReconcileMode,
  opts: { now?: () => number; limit?: number } = {},
): Promise<Array<{ customerId: string; outcome: WorkOutcome }>> {
  const now = opts.now ?? Date.now;
  const out: Array<{ customerId: string; outcome: WorkOutcome }> = [];
  for (const item of await queue.due(now(), opts.limit ?? 50)) {
    out.push({ customerId: item.customerId, outcome: await runReconcileWork(stripe, lock, queue, item.customerId, mode, now) });
  }
  return out;
}

type Item = WorkItem;

/** Storage with an atomic read-modify-write per customer, plus a due query. */
interface QueueStore {
  update<T>(customerId: string, fn: (cur: Item | null) => { next?: Item | null; result: T }): Promise<T>;
  /** Delete the item if `ok(cur)` and the customer has no pending writes, atomically. */
  deleteIfClear(customerId: string, ok: (cur: Item | null) => boolean): Promise<void>;
  due(now: number, limit: number): Promise<Item[]>;
}

function queueOver(store: QueueStore, now: () => number): ReconcileQueue {
  const same = (cur: Item | null, t: WorkToken | null) => !!cur && !!t && cur.generation === t.generation && cur.seq === t.seq;
  return {
    enqueue: (customerId, reason, dueAt) => store.update(customerId, (cur) => ({
      next: withTrigger(cur, customerId, reason, dueAt ?? now()),
      result: undefined,
    })),
    get: (customerId) => store.update(customerId, (cur) => ({ result: cur })),
    due: (at, limit) => store.due(at, limit),
    complete: (customerId, token) => store.deleteIfClear(customerId, (cur) => same(cur, token)),
    reschedule: (customerId, token, dueAt, u) => store.update(customerId, (cur) => {
      if (!cur) {
        return {
          next: { customerId, generation: randomUUID(), dueAt, seq: 1, attempts: u.attempts, reason: u.reason ?? 'retry', lastError: u.lastError },
          result: undefined,
        };
      }
      if (!token || cur.generation !== token.generation) {
        // Due by then at the latest; an item already due is left exactly as it is.
        const by = Math.max(dueAt, now());
        return cur.dueAt <= by ? { result: undefined } : { next: { ...cur, dueAt: by }, result: undefined };
      }
      if (cur.seq !== token.seq) {
        // A newer trigger arrived meanwhile: it is already due; keep its time, record the error.
        return { next: { ...cur, attempts: u.attempts, lastError: u.lastError }, result: undefined };
      }
      return { next: { ...cur, dueAt, attempts: u.attempts, reason: u.reason ?? cur.reason, lastError: u.lastError }, result: undefined };
    }),
  };
}

/**
 * In-process queue, for tests. Pass the memory lock's pendingCount (and link
 * the lock to `items`) to get the same completion fence as Firestore.
 */
export function memoryReconcileQueue(
  now: () => number = Date.now,
  opts: { items?: Map<string, Item>; pendingCount?: (customerId: string) => number } = {},
): ReconcileQueue & { items: Map<string, Item> } {
  const items = opts.items ?? new Map<string, Item>();
  const q = queueOver({
    async deleteIfClear(customerId, ok) {
      const cur = items.get(customerId) ?? null;
      if (ok(cur) && (opts.pendingCount?.(customerId) ?? 0) === 0) items.delete(customerId);
    },
    async update(customerId, fn) {
      const cur = items.get(customerId) ?? null;
      const { next, result } = fn(cur ? { ...cur } : null);
      if (next === null) items.delete(customerId);
      else if (next) items.set(customerId, { ...next });
      return result;
    },
    async due(at, limit) {
      return [...items.values()].filter((i) => i.dueAt <= at).sort((a, b) => a.dueAt - b.dueAt).slice(0, limit);
    },
  }, now);
  return Object.assign(q, { items });
}

interface QueueFirestore {
  collection(name: string): { doc(id: string): any; where(field: string, op: string, value: unknown): any };
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/** Firestore-backed queue (collection `stripe_reconcile_work`, one document per customer). */
export function firestoreReconcileQueue(db: QueueFirestore, now: () => number = Date.now): ReconcileQueue {
  const col = () => db.collection(WORK_COLLECTION);
  return queueOver({
    deleteIfClear(customerId, ok) {
      return db.runTransaction(async (tx) => {
        const ref = col().doc(customerId);
        const snap = await tx.get(ref);
        const lock = await tx.get(db.collection(LOCK_COLLECTION).doc(customerId));
        const pending = lock.exists ? (lock.data()?.pendingWrites ?? []) : [];
        if (ok(snap.exists ? (snap.data() as Item) : null) && pending.length === 0) tx.delete(ref);
      });
    },
    update(customerId, fn) {
      return db.runTransaction(async (tx) => {
        const ref = col().doc(customerId);
        const snap = await tx.get(ref);
        const { next, result } = fn(snap.exists ? (snap.data() as Item) : null);
        if (next === null) tx.delete(ref);
        else if (next) tx.set(ref, next);
        return result;
      });
    },
    async due(at, limit) {
      const snap = await col().where('dueAt', '<=', at).orderBy('dueAt').limit(limit).get();
      return snap.docs.map((d: any) => d.data() as Item);
    },
  }, now);
}
