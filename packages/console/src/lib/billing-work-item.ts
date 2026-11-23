/**
 * The durable reconciliation work item (one per Stripe customer) and the rule
 * for recording a trigger on it, shared by the work queue
 * (billing-reconcile-queue.ts) and by the customer lock, which records work in
 * the same transaction as each pending write (billing-customer-lock.ts).
 */
import { randomUUID } from 'node:crypto';

export const WORK_COLLECTION = 'stripe_reconcile_work';
export const LOCK_COLLECTION = 'stripe_customer_locks';

export interface WorkItem {
  customerId: string;
  /** Unique per creation of the item; never reused after it is deleted. */
  generation: string;
  dueAt: number;
  seq: number;
  attempts: number;
  reason: string;
  lastError: string | null;
}

/**
 * A trigger: create the item, or bump its seq (so any run that read it
 * earlier can no longer complete it) and bring its due time forward.
 */
export function withTrigger(cur: WorkItem | null, customerId: string, reason: string, dueAt: number): WorkItem {
  return cur
    ? { ...cur, dueAt: Math.min(cur.dueAt, dueAt), seq: cur.seq + 1, reason }
    : { customerId, generation: randomUUID(), dueAt, seq: 1, attempts: 0, reason, lastError: null };
}

/**
 * Make sure work exists, due by `dueAt`, without counting as a new trigger:
 * a run's own pending writes must not stop it completing its item, which the
 * queue guards separately (complete refuses while pending writes remain).
 */
export function ensureWork(cur: WorkItem | null, customerId: string, reason: string, dueAt: number): WorkItem {
  return cur
    ? (cur.dueAt <= dueAt ? cur : { ...cur, dueAt })
    : { customerId, generation: randomUUID(), dueAt, seq: 1, attempts: 0, reason, lastError: null };
}
