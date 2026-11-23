#!/usr/bin/env node
/**
 * Sweep for duplicate payment methods (the same card attached as several
 * PaymentMethods), with the same reconciliation and the same coordination
 * state as the webhook (src/lib/billing-sweep.ts): the installation's
 * Firestore lease, purchase reservations and pending writes. It refuses to run
 * when that state can't be read, in either mode.
 *
 * Dry run by default: prints the plan and any pending writes. --apply makes
 * the changes (detaching is irreversible) and settles pending writes.
 *
 *   GOOGLE_CLOUD_PROJECT=<installation project> STRIPE_SECRET_KEY=... \
 *     npx tsx scripts/dedupe-payment-methods.ts [--customer cus_X] [--apply]
 */
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '@graffiticode-app/core/lib/plans-config';
import { getFirestore } from '@graffiticode-app/core/utils/db/index';
import { assertCoordinationReadable, sweepCustomer } from '../src/lib/billing-sweep';
import { CustomerLockBusy } from '../src/lib/billing-customer-lock';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('Set STRIPE_SECRET_KEY.');
  process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });
const APPLY = process.argv.includes('--apply');
const i = process.argv.indexOf('--customer');
const ONLY = i >= 0 ? process.argv[i + 1] : null;
const db = getFirestore();

async function one(customerId: string) {
  let r;
  try {
    r = await sweepCustomer(stripe, db, customerId, APPLY);
  } catch (e) {
    if (!(e instanceof CustomerLockBusy)) throw e;
    // Dry run only (apply queues instead): nothing was read or changed.
    console.log(`${customerId}: busy (another billing operation holds it); run again to see its plan`);
    return 0;
  }
  if (!r) return 0;
  if (r.pendingWrites.length) console.log(`${customerId}: ${r.pendingWrites.length} pending write(s): ${r.pendingWrites.map((w) => `${w.kind} ${w.target}`).join(', ')}`);
  if (r.repairedChoice) console.log(`${customerId}: re-applied the console's default choice ${r.repairedChoice}`);
  if (r.plan.deferred.length) {
    console.log(`${customerId}: deferred (${r.plan.deferred.join('; ')})`);
    return 0;
  }
  if (!r.plan.detach.length && !r.plan.setDefault) return 0;
  const verb = APPLY ? 'detached' : 'would detach';
  console.log(`${customerId}: ${r.plan.setDefault ? `default -> ${r.plan.setDefault}; ` : ''}${verb} ${
    (APPLY ? r.detached : r.plan.detach.map((d) => d.id)).join(', ') || 'nothing'}${
    r.skipped.length ? `; skipped ${r.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}` : ''}`);
  return APPLY ? r.detached.length : r.plan.detach.length;
}

async function main() {
  await assertCoordinationReadable(db); // never sweep on state production can't see
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (no changes); pass --apply to make them ===');
  let customers = 0;
  let total = 0;
  if (ONLY) {
    customers = 1;
    total = await one(ONLY);
  } else {
    for await (const c of stripe.customers.list({ limit: 100 })) {
      customers++;
      total += await one(c.id);
    }
  }
  console.log(`\nScanned ${customers} customer(s). ${APPLY ? 'Detached' : 'Would detach'} ${total} duplicate payment method(s).`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
