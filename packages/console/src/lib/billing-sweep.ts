/**
 * The operator sweep for duplicate cards (scripts/dedupe-payment-methods.ts),
 * run on the same coordination state as production: the installation's
 * Firestore lease, purchase reservations, recorded default choices and pending
 * writes (billing-customer-lock.ts). A sweep with its own state would not see
 * a purchase in flight and could detach the card it is about to bill, so
 * there is deliberately no other lock here. Its work goes through the same
 * durable queue as the webhook's (billing-reconcile-queue.ts).
 */
import { firestoreCustomerLock } from './billing-customer-lock';
import { reconcileDuplicateCards, type ReconcileResult, type ReconcileStripe } from './billing-payment-methods';
import { firestoreReconcileQueue, runReconcileWork } from './billing-reconcile-queue';

type Db = Parameters<typeof firestoreCustomerLock>[0];

export async function sweepCustomer(
  stripe: ReconcileStripe,
  db: Db,
  customerId: string,
  apply: boolean,
): Promise<ReconcileResult | null> {
  const lock = firestoreCustomerLock(db);
  if (!apply) {
    // Read-only: plan under the shared lease, report, and leave no work behind
    // that a later apply-mode drain could act on.
    return reconcileDuplicateCards(stripe, customerId, { mode: 'dry-run', lock, waitMs: 30_000 });
  }
  // Recorded as queued work first, like the webhook's, so a sweep that dies
  // mid-write leaves its pending writes on the drain's list.
  const queue = firestoreReconcileQueue(db as any);
  await queue.enqueue(customerId, 'operator sweep');
  const outcome = await runReconcileWork(stripe, lock, queue, customerId, 'apply');
  if (outcome.kind === 'again') {
    // Busy, failed, deferred or still watching: queued, and the drain picks it up.
    console.log(`${customerId}: queued for the drain (${outcome.why})`);
    return null;
  }
  return outcome.result;
}

/** Refuse to sweep unless the shared coordination state can be read. */
export async function assertCoordinationReadable(db: Db): Promise<void> {
  await db.runTransaction(async (tx: any) => {
    await tx.get(db.collection('stripe_customer_locks').doc('__sweep_probe__'));
  });
}
