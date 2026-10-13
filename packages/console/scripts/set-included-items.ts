#!/usr/bin/env node

/**
 * Bump an account's included items above its plan's allowance — e.g. a Silver
 * account at 1,000 items/month instead of 500.
 *
 * Writes subscription.includedItemsOverride and includedItemsOverridePlan (the
 * account's current plan). The grant applies only while the account stays on
 * that plan; moving tiers makes it inert without a cleanup. Items inside the
 * granted band are withheld from the Stripe meter (grantCoversItem in
 * src/lib/plans-config.ts), so they are free on the invoice as well as in the gate.
 *
 * --this-cycle expires the grant at the end of the current billing period
 * (subscription.currentPeriodEnd, or the end of the calendar month when the
 * account has no Stripe period). Without it the grant is permanent.
 *
 * Usage:
 *   npx tsx scripts/set-included-items.ts --uid <uid> --items 1000 [--this-cycle] [--apply]
 *   npx tsx scripts/set-included-items.ts --uid <uid> --clear [--apply]
 *
 * Dry-run by default; pass --apply to write.
 */

import admin from 'firebase-admin';
import { effectiveIncludedItems, getPlan, includedItemsFor, DEFAULT_PLAN } from '../src/lib/plans-config';

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const clear = args.includes('--clear');
  const thisCycle = args.includes('--this-cycle');
  const uid = flag(args, '--uid');
  const items = Number(flag(args, '--items'));

  if (!uid || (!clear && !(Number.isInteger(items) && items > 0))) {
    console.error('Usage: set-included-items.ts --uid <uid> (--items <n> [--this-cycle] | --clear) [--apply]');
    process.exit(1);
  }

  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw new Error(`User ${uid} not found`);

  const subscription = userDoc.data()?.subscription || {};
  const plan = subscription.plan || DEFAULT_PLAN;
  const planIncluded = includedItemsFor(plan);

  console.log(`Account:          ${uid}`);
  console.log(`Plan:             ${plan} (${getPlan(plan).displayName}, ${planIncluded} items/mo)`);
  console.log(`Current override: ${subscription.includedItemsOverride ?? '(none)'}` +
    (subscription.includedItemsOverridePlan ? ` on ${subscription.includedItemsOverridePlan}` : '') +
    (subscription.includedItemsOverrideUntil ? ` until ${subscription.includedItemsOverrideUntil}` : ''));
  console.log(`Effective now:    ${effectiveIncludedItems(plan, subscription)}`);

  // End of the period the counter is currently counting (mirrors periodStartFor).
  let until: string | null = null;
  if (thisCycle) {
    const now = new Date();
    const end = subscription.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd)
      : new Date(now.getFullYear(), now.getMonth() + 1, 1);
    if (end <= now) {
      throw new Error(`currentPeriodEnd ${subscription.currentPeriodEnd} is in the past — subscription cache is stale; run reconcile-subscriptions.ts first`);
    }
    until = end.toISOString();
  }

  const update = clear
    ? {
        'subscription.includedItemsOverride': admin.firestore.FieldValue.delete(),
        'subscription.includedItemsOverridePlan': admin.firestore.FieldValue.delete(),
        'subscription.includedItemsOverrideUntil': admin.firestore.FieldValue.delete(),
      }
    : {
        'subscription.includedItemsOverride': items,
        'subscription.includedItemsOverridePlan': getPlan(plan).id,
        'subscription.includedItemsOverrideUntil': until ?? admin.firestore.FieldValue.delete(),
      };

  if (clear) {
    console.log(`\n→ clear override (back to ${planIncluded} items/mo)`);
  } else {
    if (items <= planIncluded) {
      console.warn(`\n⚠️  ${items} is not above the plan's ${planIncluded}; the override will be inert.`);
    }
    if (getPlan(plan).hardCap && !subscription.stripeSubscriptionId) {
      console.log('\nNote: unenrolled hard-capped account — the override raises its hard cap.');
    }
    const after = effectiveIncludedItems(plan, { ...subscription, includedItemsOverride: items, includedItemsOverridePlan: getPlan(plan).id });
    console.log(`\n→ set includedItemsOverride = ${items} on ${getPlan(plan).id} (effective ${after} items/mo)` +
      (until ? `, expires ${until}` : ', permanent'));
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  await userRef.update(update);
  console.log('\nApplied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
