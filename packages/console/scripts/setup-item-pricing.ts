/**
 * Provision Stripe objects for item-based pricing:
 *   - one Billing Meter (event_name "item_created", sum aggregation)
 *   - per metered tier: a product, a monthly (and, where the tier offers one,
 *     annual) flat base price, and a metered overage price (referencing the
 *     meter) at the tier's per-item rate
 *
 * Bronze is included and is the odd one out: its base price is $0/month and it
 * has no annual price. The $0 price still has to exist — it is the line item
 * priceIdToPlan matches to resolve the plan on subscription webhooks, and
 * without it the webhook refuses to sync a pay-as-you-go enrollment.
 *
 * Idempotent: prices are created with stable `lookup_key`s and reused if present;
 * the meter is matched by event_name. Prints the env vars to set afterwards.
 *
 * REPRICING: Stripe prices are immutable, so when plans-config changes a rate or
 * an included bucket the metered price cannot be edited — this script mints a
 * NEW tiered price and moves the lookup key to it (`transfer_lookup_key`). Reuse
 * is therefore value-based, not shape-based: a stale price is reported and
 * replaced. Two things do NOT happen automatically and are on you:
 *   1. setting the printed STRIPE_*_METER_PRICE_ID env vars and redeploying;
 *   2. migrating EXISTING subscriptions onto the new metered price — until then
 *      they keep billing at the old rate/bucket. Customer spend caps stored as
 *      `overageLimitItems` are derived from the rate too and must be recomputed
 *      from `overageLimitUsd` (see overageDollarsToItems).
 * Base (flat) prices are only ever reused; a mismatch is warned about, never
 * silently replaced, because their ids are what priceIdToPlan matches on every
 * live subscription.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/setup-item-pricing.ts [--dry-run] [--only demo,pro]
 *
 * `--only` restricts the run to named plan ids. Use it against LIVE: the paid
 * tiers' prices already exist and carry real subscribers, and if any of them
 * was created outside this script (no `gc_*` lookup key) an unfiltered run would
 * MINT A DUPLICATE and print its id as the one to set. Pasting that env var
 * would then stop priceIdToPlan from recognizing every existing subscription.
 *
 * Run against TEST mode first. After running, copy the printed env vars into
 * .env.local (dev) / .env.production (prod) and redeploy.
 */
import Stripe from 'stripe';
import { PLANS, STRIPE_API_VERSION, type PlanConfig } from '../src/lib/plans-config';

const DRY_RUN = process.argv.includes('--dry-run');
const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is required');
  process.exit(1);
}
const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });

const METER_EVENT_NAME = 'item_created';
// Every tier that meters overage — Bronze included, since pay-as-you-go gave it
// a rate. `starter` is discontinued and deliberately absent.
const METERED_TIERS: PlanConfig[] = [PLANS.demo, PLANS.pro, PLANS.teams, PLANS.platinum];

// --only demo,pro → provision just those plan ids.
const onlyArg = process.argv[process.argv.indexOf('--only') + 1];
const ONLY = process.argv.includes('--only') && onlyArg && !onlyArg.startsWith('--')
  ? new Set(onlyArg.split(',').map(s => s.trim()).filter(Boolean))
  : null;
if (process.argv.includes('--only') && !ONLY) {
  console.error('--only requires a comma-separated list of plan ids, e.g. --only demo');
  process.exit(1);
}
const TIERS = ONLY ? METERED_TIERS.filter(p => ONLY.has(p.id)) : METERED_TIERS;
if (!TIERS.length) {
  console.error(`--only matched no plans. Known: ${METERED_TIERS.map(p => p.id).join(', ')}`);
  process.exit(1);
}

// cents-as-decimal string for a dollar amount (handles sub-cent per-item rates).
// Cast to any at call sites: Stripe types unit_amount_decimal as a branded Decimal.
const cents = (usd: number): any => (usd * 100).toString();

async function ensureMeter(): Promise<string> {
  const existing = await stripe.billing.meters.list({ status: 'active', limit: 100 });
  const found = existing.data.find(m => m.event_name === METER_EVENT_NAME);
  if (found) {
    console.log(`meter: reusing ${found.id} (${METER_EVENT_NAME})`);
    return found.id;
  }
  if (DRY_RUN) {
    console.log(`meter: WOULD create meter event_name=${METER_EVENT_NAME}`);
    return 'mtr_DRYRUN';
  }
  const meter = await stripe.billing.meters.create({
    display_name: 'Items created',
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  });
  console.log(`meter: created ${meter.id}`);
  return meter.id;
}

async function ensureProduct(plan: PlanConfig): Promise<string> {
  const lookup = `gc_${plan.id}`;
  const existing = await stripe.products.search({ query: `metadata['gc_plan']:'${plan.id}'`, limit: 1 }).catch(() => null);
  if (existing?.data?.[0]) {
    console.log(`product[${plan.id}]: reusing ${existing.data[0].id}`);
    return existing.data[0].id;
  }
  if (DRY_RUN) {
    console.log(`product[${plan.id}]: WOULD create "${plan.displayName}"`);
    return `prod_DRYRUN_${plan.id}`;
  }
  const product = await stripe.products.create({
    name: `Graffiticode ${plan.displayName}`,
    metadata: { gc_plan: plan.id, gc_lookup: lookup },
  });
  console.log(`product[${plan.id}]: created ${product.id}`);
  return product.id;
}

async function ensurePrice(lookupKey: string, params: Stripe.PriceCreateParams): Promise<string> {
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  if (existing.data[0]) {
    // Stripe prices are IMMUTABLE: a base fee that moved in plans-config cannot
    // be edited into this price. Reuse is still the right default here (the base
    // price id is what priceIdToPlan matches on every live subscription), but it
    // must never be silent — otherwise a repricing run prints "reusing" and the
    // operator reads it as "provisioned".
    const want = params.unit_amount;
    const got = existing.data[0].unit_amount;
    if (typeof want === 'number' && got !== want) {
      console.warn(
        `  price[${lookupKey}]: !! STALE — Stripe has $${(got ?? 0) / 100}, plans-config wants $${want / 100}. ` +
        'Reusing the existing price (it carries live subscribers). Mint a replacement and migrate deliberately.',
      );
    }
    console.log(`  price[${lookupKey}]: reusing ${existing.data[0].id}`);
    return existing.data[0].id;
  }
  if (DRY_RUN) {
    console.log(`  price[${lookupKey}]: WOULD create ${JSON.stringify(params.recurring)} ${params.unit_amount ?? params.unit_amount_decimal}`);
    return `price_DRYRUN_${lookupKey}`;
  }
  const price = await stripe.prices.create({ ...params, lookup_key: lookupKey });
  console.log(`  price[${lookupKey}]: created ${price.id}`);
  return price.id;
}

// Does a live tiered price carry exactly the graduated tiers plans-config asks
// for — free up to includedItems, then the per-item rate? Compared in decimal
// cents so $0.025/item (a sub-cent unit_amount) survives the round trip.
function meteredTiersMatch(price: Stripe.Price, plan: PlanConfig): boolean {
  const tiers = price.tiers;
  if (!tiers || tiers.length !== 2) return false;
  const [free, paid] = tiers;
  const freeAmount = Number(free.unit_amount_decimal ?? free.unit_amount ?? 0);
  const paidAmount = Number(paid.unit_amount_decimal ?? paid.unit_amount ?? 0);
  return (
    price.tiers_mode === 'graduated' &&
    free.up_to === plan.includedItems &&
    freeAmount === 0 &&
    paid.up_to === null &&
    paidAmount === Number(cents(plan.overageRatePerItem as number))
  );
}

const describeTiers = (price: Stripe.Price): string => {
  const tiers = price.tiers;
  if (!tiers?.length) return `${price.tiers_mode ?? price.billing_scheme} (tiers not returned)`;
  return tiers
    .map(t => `${t.up_to ?? 'inf'}@${Number(t.unit_amount_decimal ?? t.unit_amount ?? 0) / 100}`)
    .join(' / ');
};

const describeWanted = (plan: PlanConfig): string =>
  `${plan.includedItems}@0 / inf@${plan.overageRatePerItem}`;

// Metered overage price, TIERED so the included bucket is free (covered by the
// flat base fee) and only items above `includedItems` are charged at the rate.
// Reporting one meter event per item then yields base + (overage x rate).
async function ensureMeteredPrice(lookupKey: string, productId: string, plan: PlanConfig, meterId: string): Promise<string> {
  // `tiers` is only returned when explicitly expanded — without this the match
  // check below would see an undefined tier list on every price and re-mint.
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1, active: true, expand: ['data.tiers'] });
  const found = existing.data[0];
  // Reuse only when the price actually MATCHES plans-config. Checking the shape
  // alone (billing_scheme === 'tiered') was how a repricing could pass through
  // this script untouched: the old price is tiered too, so the run reported
  // "reusing" and printed the STALE id as the env var to set. Tiers are
  // immutable, so a mismatch means minting a new price and moving the lookup key.
  if (found && found.billing_scheme === 'tiered' && meteredTiersMatch(found, plan)) {
    console.log(`  price[${lookupKey}]: reusing tiered ${found.id}`);
    return found.id;
  }
  if (found) {
    console.log(`  price[${lookupKey}]: STALE ${found.id} — ${describeTiers(found)} != wanted ${describeWanted(plan)}`);
  }
  if (DRY_RUN) {
    console.log(`  price[${lookupKey}]: WOULD create tiered (0 up to ${plan.includedItems}, then ${plan.overageRatePerItem}/item)`);
    return `price_DRYRUN_${lookupKey}`;
  }
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    billing_scheme: 'tiered',
    tiers_mode: 'graduated',
    tiers: [
      { up_to: plan.includedItems, unit_amount: 0 },
      { up_to: 'inf', unit_amount_decimal: cents(plan.overageRatePerItem as number) },
    ],
    recurring: { interval: 'month', usage_type: 'metered', meter: meterId },
    lookup_key: lookupKey,
    // If a prior (flat) price holds this lookup key, move it to the new tiered one.
    ...(found ? { transfer_lookup_key: true } : {}),
  });
  console.log(`  price[${lookupKey}]: created tiered ${price.id}${found ? ' (transferred lookup key from ' + found.id + ')' : ''}`);
  return price.id;
}

async function main() {
  console.log(`\n=== Provisioning item-based pricing${DRY_RUN ? ' (DRY RUN)' : ''} ===`);
  console.log(`plans: ${TIERS.map(p => p.id).join(', ')}${ONLY ? ' (--only)' : ''}\n`);
  const meterId = await ensureMeter();
  const envLines: string[] = [];

  for (const plan of TIERS) {
    console.log(`\n--- ${plan.displayName} (${plan.id}) ---`);
    const productId = await ensureProduct(plan);

    const monthly = await ensurePrice(`gc_${plan.id}_monthly`, {
      product: productId,
      currency: 'usd',
      unit_amount: plan.basePriceMonthly * 100,
      recurring: { interval: 'month' },
    });
    envLines.push(`${plan.stripe.baseMonthlyPriceIdEnv}=${monthly}`);

    // Bronze is monthly-only; don't mint an annual $0 price nobody can select.
    if (plan.stripe.baseAnnualPriceIdEnv) {
      const annual = await ensurePrice(`gc_${plan.id}_annual`, {
        product: productId,
        currency: 'usd',
        unit_amount: plan.basePriceAnnual * 100,
        recurring: { interval: 'year' },
      });
      envLines.push(`${plan.stripe.baseAnnualPriceIdEnv}=${annual}`);
    }

    const metered = await ensureMeteredPrice(`gc_${plan.id}_meter`, productId, plan, meterId);
    envLines.push(`${plan.stripe.meterPriceIdEnv}=${metered}`);
  }

  console.log(`\n=== Set these env vars (${DRY_RUN ? 'dry-run placeholders' : 'real ids'}) ===\n`);
  console.log(envLines.join('\n'));
  console.log('\nNote: STRIPE_PRO_* and STRIPE_TEAMS_* base prices already exist for');
  console.log('legacy Silver/Gold subscribers — only reuse/rotate them deliberately.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
