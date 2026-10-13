#!/usr/bin/env node

/**
 * Change Stripe prices for subscription plans.
 *
 * Creates new Stripe prices, migrates active subscribers, and archives old prices.
 * Outputs new price IDs to update in .env.local.
 *
 * Usage:
 *   npx tsx scripts/change-stripe-prices.ts --plan starter --monthly 15 --annual 150
 *   npx tsx scripts/change-stripe-prices.ts --plan pro --monthly 120 --annual 1200
 *   npx tsx scripts/change-stripe-prices.ts --plan starter --monthly 15 --annual 150 --migrate
 *   npx tsx scripts/change-stripe-prices.ts --plan starter --monthly 15 --annual 150 --migrate --dry-run
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('Error: STRIPE_SECRET_KEY environment variable not set');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-08-01' } as Stripe.StripeConfig);

type PlanId = 'starter' | 'pro' | 'teams';

const ENV_KEYS: Record<PlanId, { monthly: string; annual: string }> = {
  starter: {
    monthly: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
    annual: 'STRIPE_STARTER_ANNUAL_PRICE_ID',
  },
  pro: {
    monthly: 'STRIPE_PRO_MONTHLY_PRICE_ID',
    annual: 'STRIPE_PRO_ANNUAL_PRICE_ID',
  },
  teams: {
    monthly: 'STRIPE_TEAMS_MONTHLY_PRICE_ID',
    annual: 'STRIPE_TEAMS_ANNUAL_PRICE_ID',
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--migrate') {
      opts.migrate = true;
    } else if (arg === '--help') {
      opts.help = true;
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      opts[arg.slice(2)] = args[++i];
    }
  }
  return opts;
}

function printUsage() {
  console.log(`
Usage: npx tsx scripts/change-stripe-prices.ts [options]

Options:
  --plan <plan>       Plan to update: starter, pro, or teams (required)
  --monthly <amount>  New monthly price in dollars (at least one of --monthly/--annual required)
  --annual <amount>   New annual price in dollars
  --migrate           Migrate active subscribers to new prices
  --dry-run           Show what would happen without making changes
  --help              Show this help

Examples:
  # Create new prices (outputs env vars to update)
  npx tsx scripts/change-stripe-prices.ts --plan starter --monthly 15 --annual 150

  # Create new prices and migrate subscribers
  npx tsx scripts/change-stripe-prices.ts --plan starter --monthly 15 --annual 150 --migrate

  # Preview migration without changes
  npx tsx scripts/change-stripe-prices.ts --plan starter --monthly 15 --annual 150 --migrate --dry-run

After running:
  1. Update .env.local with the printed price IDs
  2. Update src/utils/plans.ts if dollar amounts or units changed
  3. Redeploy with: npm run gcp:build
`);
}

async function getProductForPrice(priceId: string): Promise<string | null> {
  try {
    const price = await stripe.prices.retrieve(priceId);
    return typeof price.product === 'string' ? price.product : null;
  } catch {
    return null;
  }
}

async function createPrice(
  productId: string,
  amount: number,
  interval: 'month' | 'year',
  dryRun: boolean
): Promise<string> {
  const unitAmount = Math.round(amount * 100);
  if (dryRun) {
    console.log(`  [dry-run] Would create ${interval}ly price: $${amount} (${unitAmount} cents)`);
    return `price_dry_run_${interval}`;
  }
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency: 'usd',
    recurring: { interval },
  });
  console.log(`  Created ${interval}ly price: ${price.id} ($${amount})`);
  return price.id;
}

async function archivePrice(priceId: string, dryRun: boolean) {
  if (dryRun) {
    console.log(`  [dry-run] Would archive old price: ${priceId}`);
    return;
  }
  await stripe.prices.update(priceId, { active: false });
  console.log(`  Archived old price: ${priceId}`);
}

async function migrateSubscribers(
  oldPriceId: string,
  newPriceId: string,
  interval: string,
  dryRun: boolean
): Promise<number> {
  let count = 0;
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Stripe.SubscriptionListParams = {
      price: oldPriceId,
      status: 'active',
      limit: 100,
    };
    if (startingAfter) params.starting_after = startingAfter;

    const subs = await stripe.subscriptions.list(params);

    for (const sub of subs.data) {
      const item = sub.items.data.find(
        (si: Stripe.SubscriptionItem) => si.price.id === oldPriceId
      );
      if (!item) continue;

      if (dryRun) {
        console.log(`  [dry-run] Would migrate subscription ${sub.id} (customer: ${sub.customer})`);
      } else {
        await stripe.subscriptions.update(sub.id, {
          items: [{ id: item.id, price: newPriceId }],
          proration_behavior: 'none',
        });
        console.log(`  Migrated subscription ${sub.id}`);
      }
      count++;
    }

    hasMore = subs.has_more;
    if (subs.data.length > 0) {
      startingAfter = subs.data[subs.data.length - 1].id;
    }
  }

  // Also check trialing subscriptions
  hasMore = true;
  startingAfter = undefined;
  while (hasMore) {
    const params: Stripe.SubscriptionListParams = {
      price: oldPriceId,
      status: 'trialing',
      limit: 100,
    };
    if (startingAfter) params.starting_after = startingAfter;

    const subs = await stripe.subscriptions.list(params);

    for (const sub of subs.data) {
      const item = sub.items.data.find(
        (si: Stripe.SubscriptionItem) => si.price.id === oldPriceId
      );
      if (!item) continue;

      if (dryRun) {
        console.log(`  [dry-run] Would migrate trialing subscription ${sub.id}`);
      } else {
        await stripe.subscriptions.update(sub.id, {
          items: [{ id: item.id, price: newPriceId }],
          proration_behavior: 'none',
        });
        console.log(`  Migrated trialing subscription ${sub.id}`);
      }
      count++;
    }

    hasMore = subs.has_more;
    if (subs.data.length > 0) {
      startingAfter = subs.data[subs.data.length - 1].id;
    }
  }

  return count;
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  const planId = opts.plan as PlanId;
  if (!planId || !ENV_KEYS[planId]) {
    console.error('Error: --plan must be one of: starter, pro, teams');
    printUsage();
    process.exit(1);
  }

  const monthlyAmount = opts.monthly ? parseFloat(opts.monthly as string) : null;
  const annualAmount = opts.annual ? parseFloat(opts.annual as string) : null;
  const dryRun = !!opts.dryRun;
  const migrate = !!opts.migrate;

  if (!monthlyAmount && !annualAmount) {
    console.error('Error: provide at least one of --monthly or --annual');
    process.exit(1);
  }

  if (dryRun) console.log('=== DRY RUN MODE ===\n');

  const envKeys = ENV_KEYS[planId];
  const oldMonthlyId = process.env[envKeys.monthly];
  const oldAnnualId = process.env[envKeys.annual];

  // Determine the product ID from an existing price
  let productId: string | null = null;
  for (const id of [oldMonthlyId, oldAnnualId]) {
    if (id) {
      productId = await getProductForPrice(id);
      if (productId) break;
    }
  }

  if (!productId) {
    console.error(`Error: Could not find Stripe product for ${planId} plan.`);
    console.error(`Make sure ${envKeys.monthly} or ${envKeys.annual} is set in your environment.`);
    process.exit(1);
  }

  console.log(`Plan: ${planId}`);
  console.log(`Product: ${productId}\n`);

  const newPriceIds: Record<string, string> = {};

  // Create new prices
  if (monthlyAmount) {
    console.log(`Creating monthly price: $${monthlyAmount}/month`);
    newPriceIds.monthly = await createPrice(productId, monthlyAmount, 'month', dryRun);
  }
  if (annualAmount) {
    console.log(`Creating annual price: $${annualAmount}/year`);
    newPriceIds.annual = await createPrice(productId, annualAmount, 'year', dryRun);
  }

  // Migrate subscribers
  if (migrate) {
    console.log('\nMigrating subscribers...');
    let totalMigrated = 0;

    if (monthlyAmount && oldMonthlyId) {
      console.log(`\n  Monthly (${oldMonthlyId} → ${newPriceIds.monthly}):`);
      const count = await migrateSubscribers(oldMonthlyId, newPriceIds.monthly, 'monthly', dryRun);
      totalMigrated += count;
      if (count === 0) console.log('  No active monthly subscribers to migrate');
    }

    if (annualAmount && oldAnnualId) {
      console.log(`\n  Annual (${oldAnnualId} → ${newPriceIds.annual}):`);
      const count = await migrateSubscribers(oldAnnualId, newPriceIds.annual, 'annual', dryRun);
      totalMigrated += count;
      if (count === 0) console.log('  No active annual subscribers to migrate');
    }

    console.log(`\nTotal migrated: ${totalMigrated}`);
  }

  // Archive old prices
  if (migrate && !dryRun) {
    console.log('\nArchiving old prices...');
    if (monthlyAmount && oldMonthlyId) await archivePrice(oldMonthlyId, dryRun);
    if (annualAmount && oldAnnualId) await archivePrice(oldAnnualId, dryRun);
  }

  // Output env var updates
  console.log('\n--- Update .env.local with these values ---');
  if (monthlyAmount) console.log(`${envKeys.monthly}=${newPriceIds.monthly}`);
  if (annualAmount) console.log(`${envKeys.annual}=${newPriceIds.annual}`);

  if (!migrate) {
    console.log('\nNote: Run with --migrate to move existing subscribers to the new prices.');
  }
  if (dryRun) {
    console.log('\nThis was a dry run. No changes were made.');
  } else {
    console.log('\nDon\'t forget to:');
    console.log('1. Update .env.local with the new price IDs');
    console.log('2. Update plans.ts if the unit amounts or features changed');
    console.log('3. Redeploy with: npm run gcp:build');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
