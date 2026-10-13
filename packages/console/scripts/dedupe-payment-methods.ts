#!/usr/bin/env node
/**
 * One-off sweep to collapse duplicate payment methods (same card attached as
 * multiple PaymentMethod objects). Mirrors the webhook dedup in
 * src/pages/api/webhooks/stripe.ts (dedupePaymentMethods).
 *
 * Dry-run by default — prints what it WOULD detach. Pass --apply to detach.
 *
 *   STRIPE_SECRET_KEY=sk_live_... npx tsx scripts/dedupe-payment-methods.ts
 *   STRIPE_SECRET_KEY=sk_live_... npx tsx scripts/dedupe-payment-methods.ts --apply
 *   STRIPE_SECRET_KEY=sk_live_... npx tsx scripts/dedupe-payment-methods.ts --customer cus_X --apply
 */
import Stripe from 'stripe';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('Set STRIPE_SECRET_KEY (use the LIVE key for production).');
  process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: '2022-08-01' });

const APPLY = process.argv.includes('--apply');
const customerArgIdx = process.argv.indexOf('--customer');
const ONLY_CUSTOMER = customerArgIdx >= 0 ? process.argv[customerArgIdx + 1] : null;

const IN_USE = ['active', 'trialing', 'past_due', 'incomplete'];

async function dedupeCustomer(customerId: string): Promise<number> {
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (methods.data.length < 2) return 0;

  // Group PMs by card fingerprint (same fingerprint = same physical card).
  const byFingerprint = new Map<string, Stripe.PaymentMethod[]>();
  for (const pm of methods.data) {
    const fp = pm.card?.fingerprint;
    if (!fp) continue;
    (byFingerprint.get(fp) ?? byFingerprint.set(fp, []).get(fp)!).push(pm);
  }

  const groups = [...byFingerprint.values()].filter((g) => g.length > 1);
  if (groups.length === 0) return 0;

  const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
  const customerDefault = customer.invoice_settings?.default_payment_method as string | undefined;

  // Protect PMs referenced by in-use subscriptions.
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  const protectedIds = new Set<string>(
    subs.data
      .filter((s) => IN_USE.includes(s.status))
      .map((s) => s.default_payment_method as string)
      .filter(Boolean),
  );

  let detachedCount = 0;
  for (const group of groups) {
    // Keep the customer default if it's in this group, else the newest card.
    let keep = group.find((pm) => pm.id === customerDefault);
    if (!keep) {
      keep = group.reduce((a, b) => (a.created > b.created ? a : b));
      if (APPLY) {
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: keep.id },
        });
      }
    }

    const card = `${keep.card?.brand} ****${keep.card?.last4}`;
    const toDetach = group.filter((pm) => pm.id !== keep!.id && !protectedIds.has(pm.id));
    if (toDetach.length === 0) continue;

    console.log(
      `${customerId}  ${card}: keep ${keep.id}, ${APPLY ? 'detaching' : 'would detach'} ${toDetach
        .map((pm) => pm.id)
        .join(', ')}`,
    );
    if (APPLY) {
      for (const pm of toDetach) {
        await stripe.paymentMethods.detach(pm.id);
        detachedCount++;
      }
    } else {
      detachedCount += toDetach.length;
    }
  }
  return detachedCount;
}

async function main() {
  console.log(APPLY ? '=== APPLYING (detaching duplicates) ===' : '=== DRY RUN (no changes) — pass --apply to detach ===');
  let customers = 0;
  let totalDetached = 0;

  if (ONLY_CUSTOMER) {
    totalDetached += await dedupeCustomer(ONLY_CUSTOMER);
    customers = 1;
  } else {
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      customers++;
      totalDetached += await dedupeCustomer(customer.id);
    }
  }

  console.log(
    `\nScanned ${customers} customer(s). ${APPLY ? 'Detached' : 'Would detach'} ${totalDetached} duplicate payment method(s).`,
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
