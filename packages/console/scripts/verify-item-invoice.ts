/**
 * End-to-end test-clock verification of item-based billing.
 *
 * Creates a customer on a Stripe test clock, subscribes to a paid tier (flat
 * base + tiered metered overage), reports N items of metered usage, advances the
 * clock one billing cycle, and prints the renewal invoice — which should read
 * base + (items over included) x rate.
 *
 * Test mode only. Requires the STRIPE_*_PRICE_ID / _METER_PRICE_ID env vars
 * (run scripts/setup-item-pricing.ts first).
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/verify-item-invoice.ts [--plan pro] [--items 600]
 *
 * Example: Silver (pro), 600 items -> invoice $100 base + 100 x $0.20 = $120.
 */
import Stripe from 'stripe';
import { STRIPE_API_VERSION, stripeBasePriceId, stripeMeterPriceId, getPlan, includedItemsFor, overageRateFor, type PlanId } from '../src/lib/plans-config';
import { subscriptionPeriod } from '../src/lib/stripe-helpers';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY || !KEY.startsWith('sk_test_')) { console.error('A test-mode STRIPE_SECRET_KEY (sk_test_...) is required'); process.exit(1); }
const stripe = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION });

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const plan = arg('plan', 'pro') as PlanId;
const items = parseInt(arg('items', '600'), 10);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main() {
  const basePriceId = stripeBasePriceId(plan, 'monthly');
  const meterPriceId = stripeMeterPriceId(plan);
  const eventName = getPlan(plan).stripe.meterEventName;
  if (!basePriceId || !meterPriceId || !eventName) {
    console.error(`Missing Stripe price/meter env for plan "${plan}". Run setup-item-pricing.ts and source .env.local.`);
    process.exit(1);
  }
  const included = includedItemsFor(plan);
  const rate = overageRateFor(plan) as number;
  const expectedOverage = Math.max(0, items - included);
  console.log(`\nplan=${plan} included=${included} rate=$${rate}/item items=${items} -> expected overage ${expectedOverage} x $${rate} = $${(expectedOverage * rate).toFixed(2)}\n`);

  // 1) Test clock frozen at "now".
  const now = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now });
  console.log(`test clock: ${clock.id}`);

  // 2) Customer on the clock, with a default test card.
  const customer = await stripe.customers.create({ name: `item-billing-verify-${plan}`, test_clock: clock.id });
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  console.log(`customer: ${customer.id}`);

  // 3) Subscription: flat base (advance) + tiered metered overage (arrears).
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: basePriceId }, { price: meterPriceId }],
    payment_behavior: 'allow_incomplete',
  });
  const period = subscriptionPeriod(sub);
  console.log(`subscription: ${sub.id} status=${sub.status} period ${new Date((period.start ?? now) * 1000).toISOString()} -> ${new Date((period.end ?? now) * 1000).toISOString()}`);

  // 4) Report N items of metered usage within the current period (one summed event).
  await stripe.billing.meterEvents.create({
    event_name: eventName,
    payload: { stripe_customer_id: customer.id, value: String(items) },
    timestamp: now,
  });
  console.log(`reported ${items} items to meter "${eventName}"`);

  // 5) Advance the clock just past the period end to trigger the renewal invoice.
  const advanceTo = (period.end ?? (now + 2678400)) + 3600;
  console.log(`advancing clock to ${new Date(advanceTo * 1000).toISOString()} ...`);
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: advanceTo });
  // Wait for the clock to finish advancing.
  for (let i = 0; i < 30; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clock.id);
    if (c.status === 'ready') break;
    await sleep(2000);
  }

  // 6) Print the newest invoice (the renewal): base for the new period + metered arrears.
  let invoice: Stripe.Invoice | undefined;
  for (let i = 0; i < 30; i++) {
    const invoices = await stripe.invoices.list({ customer: customer.id, limit: 5 });
    invoice = invoices.data.sort((a, b) => (b.created) - (a.created))[0];
    if (invoices.data.length >= 2) break; // creation invoice + renewal invoice
    await sleep(2000);
  }

  console.log(`\n=== newest invoice ===`);
  if (!invoice) { console.log('no invoice found'); return; }
  console.log(`id=${invoice.id} status=${invoice.status} total=${dollars(invoice.total)} (${invoice.billing_reason})`);
  for (const line of invoice.lines.data) {
    console.log(`  - ${line.description ?? line.price?.id ?? ''}: ${dollars(line.amount)}`);
  }
  console.log(`\nExpected ≈ ${dollars(getPlan(plan).basePriceMonthly * 100 + Math.round(expectedOverage * rate * 100))} (base + overage).`);
  console.log(`(Test clock ${clock.id} + customer ${customer.id} remain in your test account — delete when done.)\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
