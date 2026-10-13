#!/usr/bin/env node

/**
 * Migrate Starter subscribers to Pro.
 *
 * The Starter plan is discontinued. Existing Starter subscribers are switched to the
 * Pro price with proration_behavior:'none' and billing_cycle_anchor:'unchanged' — i.e.
 * they get Pro's allocation immediately for the rest of the current cycle at NO extra
 * charge, and renew at the Pro price on their existing renewal date (unless they
 * cancel before then). Subscribers already canceling (cancel_at_period_end) are left
 * canceling. After migration the Starter Stripe prices are archived.
 *
 * Requires env: STRIPE_SECRET_KEY, STRIPE_STARTER_MONTHLY_PRICE_ID,
 * STRIPE_STARTER_ANNUAL_PRICE_ID, STRIPE_PRO_MONTHLY_PRICE_ID,
 * STRIPE_PRO_ANNUAL_PRICE_ID, GRAFFITICODE_APP_CREDENTIALS.
 *
 * Usage:
 *   npx tsx scripts/migrate-starter-to-pro.ts                 # dry-run (default)
 *   npx tsx scripts/migrate-starter-to-pro.ts --execute       # apply changes
 *   npx tsx scripts/migrate-starter-to-pro.ts --execute --no-archive
 *   npx tsx scripts/migrate-starter-to-pro.ts --user <uid>    # single user (dry-run)
 *   npx tsx scripts/migrate-starter-to-pro.ts --user <uid> --execute
 */

import Stripe from 'stripe';
import admin from 'firebase-admin';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('Error: STRIPE_SECRET_KEY environment variable not set');
  process.exit(1);
}

const PRO_UNITS = 100000;

const PRICE_PAIRS = [
  {
    interval: 'monthly' as const,
    starter: process.env.STRIPE_STARTER_MONTHLY_PRICE_ID,
    pro: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
  },
  {
    interval: 'annual' as const,
    starter: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID,
    pro: process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
  },
];

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-08-01' } as Stripe.StripeConfig);

// Firebase admin (graffiticode-app project) — same bootstrap as other admin scripts.
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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: { execute: boolean; archive: boolean; user?: string; help: boolean } = {
    execute: false,
    archive: true,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--no-archive') opts.archive = false;
    else if (arg === '--help') opts.help = true;
    else if (arg === '--user' && i + 1 < args.length) opts.user = args[++i];
  }
  return opts;
}

function printUsage() {
  console.log(`
Usage: npx tsx scripts/migrate-starter-to-pro.ts [options]

Options:
  --execute       Apply changes (default is a dry run)
  --no-archive    Skip archiving the old Starter prices after migration
  --user <uid>    Only migrate the single user with this Firestore uid
  --help          Show this help
`);
}

/** Update the Firestore user doc for a given Stripe customer to reflect Pro. */
async function updateFirestoreForCustomer(
  customerId: string,
  interval: 'monthly' | 'annual',
  subscriptionId: string,
  dryRun: boolean
): Promise<string | null> {
  const snap = await db
    .collection('users')
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();

  if (snap.empty) {
    console.log(`    ! No Firestore user for customer ${customerId} (Stripe updated regardless)`);
    return null;
  }

  const userId = snap.docs[0].id;
  if (dryRun) {
    console.log(`    [dry-run] Would set user ${userId}: plan=pro, units=${PRO_UNITS}, interval=${interval}`);
    return userId;
  }

  await db.collection('users').doc(userId).update({
    'subscription.plan': 'pro',
    'subscription.units': PRO_UNITS,
    'subscription.interval': interval,
    'subscription.updatedAt': new Date().toISOString(),
  });
  await db.collection('subscription_events').add({
    userId,
    type: 'migrated_starter_to_pro',
    subscriptionId,
    interval,
    timestamp: new Date(),
  });
  console.log(`    Updated user ${userId}: plan=pro, units=${PRO_UNITS}`);
  return userId;
}

/** Swap a single subscription from the Starter price to the Pro price. */
async function migrateSubscription(
  sub: Stripe.Subscription,
  starterPriceId: string,
  proPriceId: string,
  interval: 'monthly' | 'annual',
  dryRun: boolean
): Promise<boolean> {
  const item = sub.items.data.find((si) => si.price.id === starterPriceId);
  if (!item) return false;

  const canceling = sub.cancel_at_period_end ? ' (canceling at period end — preserved)' : '';
  if (dryRun) {
    console.log(`  [dry-run] Would migrate ${sub.id} (customer ${sub.customer}, ${sub.status})${canceling}`);
  } else {
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: proPriceId }],
      proration_behavior: 'none',
      billing_cycle_anchor: 'unchanged',
      metadata: { ...sub.metadata, planId: 'pro', interval, migratedFrom: 'starter' },
    });
    console.log(`  Migrated ${sub.id} (customer ${sub.customer})${canceling}`);
  }

  await updateFirestoreForCustomer(sub.customer as string, interval, sub.id, dryRun);
  return true;
}

/** Iterate all subscriptions on a Starter price (active + trialing) and migrate them. */
async function migratePrice(
  starterPriceId: string,
  proPriceId: string,
  interval: 'monthly' | 'annual',
  dryRun: boolean
): Promise<number> {
  let count = 0;
  for (const status of ['active', 'trialing'] as const) {
    let startingAfter: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const params: Stripe.SubscriptionListParams = {
        price: starterPriceId,
        status,
        limit: 100,
      };
      if (startingAfter) params.starting_after = startingAfter;

      const subs = await stripe.subscriptions.list(params);
      for (const sub of subs.data) {
        if (await migrateSubscription(sub, starterPriceId, proPriceId, interval, dryRun)) count++;
      }
      hasMore = subs.has_more;
      if (subs.data.length > 0) startingAfter = subs.data[subs.data.length - 1].id;
    }
  }
  return count;
}

/** Migrate a single user by uid (looks up their starter subscription in Stripe). */
async function migrateSingleUser(
  uid: string,
  dryRun: boolean
): Promise<number> {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    console.error(`Error: no Firestore user ${uid}`);
    return 0;
  }
  const customerId = userDoc.data()?.stripeCustomerId;
  if (!customerId) {
    console.error(`Error: user ${uid} has no stripeCustomerId`);
    return 0;
  }

  const starterPriceIds = new Set(PRICE_PAIRS.map((p) => p.starter).filter(Boolean) as string[]);
  let count = 0;
  for (const status of ['active', 'trialing'] as const) {
    const subs = await stripe.subscriptions.list({ customer: customerId, status, limit: 100 });
    for (const sub of subs.data) {
      const item = sub.items.data.find((si) => starterPriceIds.has(si.price.id));
      if (!item) continue;
      const pair = PRICE_PAIRS.find((p) => p.starter === item.price.id);
      if (!pair?.pro) continue;
      if (await migrateSubscription(sub, pair.starter as string, pair.pro, pair.interval, dryRun)) count++;
    }
  }
  if (count === 0) console.log(`  No Starter subscription found for user ${uid}`);
  return count;
}

async function archivePrice(priceId: string, dryRun: boolean) {
  if (dryRun) {
    console.log(`  [dry-run] Would archive Starter price ${priceId}`);
    return;
  }
  await stripe.prices.update(priceId, { active: false });
  console.log(`  Archived Starter price ${priceId}`);
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const dryRun = !opts.execute;
  console.log(dryRun ? '=== DRY RUN (pass --execute to apply) ===\n' : '=== EXECUTING ===\n');

  // Validate price config.
  for (const pair of PRICE_PAIRS) {
    if (!pair.starter || !pair.pro) {
      console.error(`Error: missing price IDs for ${pair.interval} (starter=${pair.starter}, pro=${pair.pro})`);
      process.exit(1);
    }
  }

  let total = 0;

  if (opts.user) {
    console.log(`Migrating single user: ${opts.user}\n`);
    total = await migrateSingleUser(opts.user, dryRun);
  } else {
    for (const pair of PRICE_PAIRS) {
      console.log(`\n${pair.interval}: ${pair.starter} → ${pair.pro}`);
      const count = await migratePrice(pair.starter as string, pair.pro as string, pair.interval, dryRun);
      if (count === 0) console.log('  No subscribers to migrate');
      total += count;
    }
  }

  console.log(`\nTotal migrated: ${total}`);

  // Archive old Starter prices (full migration only, not single-user).
  if (opts.archive && !opts.user) {
    console.log('\nArchiving Starter prices...');
    for (const pair of PRICE_PAIRS) {
      await archivePrice(pair.starter as string, dryRun);
    }
  } else if (opts.user) {
    console.log('\nSkipping price archive (single-user mode).');
  }

  if (dryRun) console.log('\nThis was a dry run. No changes were made.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
