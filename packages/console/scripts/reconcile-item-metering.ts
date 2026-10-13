#!/usr/bin/env node
/**
 * Reconcile billable items in Firestore against what Stripe was actually told.
 *
 * Two things silently diverge and nothing else notices:
 *
 *  1. Items counted but never metered. recordBillableItem() writes the usage
 *     row and then reports a Stripe meter event best-effort — reportItemUsage()
 *     swallows every failure. A month of items can be counted against a live
 *     account's allowance with Stripe never hearing about a single one.
 *
 *  2. A metered line that does not span the cycle. Stripe aggregates a metered
 *     price only over the window its subscription item existed, and the
 *     graduated ladder restarts its free tier per line period. Attach the
 *     metered price mid-cycle and the invoice bills a few days' usage against a
 *     full month's free bucket — a $0 overage line that looks perfectly normal.
 *
 * Read-only. Compares, per account: Firestore item_created units, the Stripe
 * meter's own total for that customer, and the metered line on the invoice that
 * closed the cycle.
 *
 * Requires a LIVE Stripe key to see live customers. The live key lives in a
 * commented line of .env.local:
 *
 *   eval "$(grep '^# STRIPE_SECRET_KEY=sk_live' .env.local | sed 's/^# /export /')"
 *   env -u FIRESTORE_EMULATOR_HOST \
 *     GRAFFITICODE_APP_CREDENTIALS=$HOME/graffiticode-app-key.json \
 *     npx tsx scripts/reconcile-item-metering.ts --cycle last
 *
 * Usage:
 *   --cycle last|current   which billing cycle to check (default: last)
 *   --uid <uid>            limit to one account
 *   --quiet                only print accounts that diverge
 */
import admin from 'firebase-admin';
import Stripe from 'stripe';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local (existing env wins, so a live key can be exported inline).
try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { }

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Error: STRIPE_SECRET_KEY not set');
  process.exit(1);
}

import { STRIPE_API_VERSION, includedItemsFor, overageRateFor, getPlan } from '../src/lib/plans-config';
import { classifyLine, linePriceId } from '../src/lib/stripe-invoice-lines';

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const has = (name: string) => process.argv.includes(`--${name}`);

const CYCLE = arg('cycle', 'last');
const ONLY_UID = arg('uid');
const QUIET = has('quiet');

if (CYCLE !== 'last' && CYCLE !== 'current') {
  console.error('Error: --cycle must be "last" or "current"');
  process.exit(1);
}

const testKey = process.env.STRIPE_SECRET_KEY.startsWith('sk_test_');
if (testKey) {
  console.warn('WARNING: test-mode Stripe key against prod Firestore — every live customer will look unmetered.\n');
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GRAFFITICODE_APP_CREDENTIALS, 'utf8'))),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

const DAY = 86400;
const floorDay = (d: Date) => Math.floor(d.getTime() / 1000 / DAY) * DAY;
const ceilDay = (d: Date) => Math.ceil(d.getTime() / 1000 / DAY) * DAY;
const iso = (secs: number) => new Date(secs * 1000).toISOString();
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

interface Row {
  uid: string;
  plan: string;
  customer: string;
  windowStart: number;
  windowEnd: number;
  firestore: number;
  metered: number;
  problems: string[];
}

/**
 * Firestore item_created units for one account over a window.
 *
 * Sums `units` rather than counting docs, matching checkItemCreateAllowed's
 * self-heal — local-run rows carry units: 0 and must not read as a shortfall.
 */
async function firestoreItems(uid: string, startSecs: number, endSecs: number): Promise<number> {
  const snap = await db.collection('usage')
    .where('userId', '==', uid)
    .where('createdAt', '>=', new Date(startSecs * 1000))
    .where('createdAt', '<', new Date(endSecs * 1000))
    .get();
  let total = 0;
  for (const d of snap.docs) {
    const r = d.data();
    if (r.type === 'item_created') total += r.units || 0;
  }
  return total;
}

/** What Stripe's own meter recorded for this customer over the same window. */
async function meteredItems(customer: string, startSecs: number, endSecs: number): Promise<number> {
  const meters = await stripe.billing.meters.list({ limit: 100 });
  let total = 0;
  for (const m of meters.data) {
    if (m.status !== 'active' || m.event_name !== 'item_created') continue;
    let starting_after: string | undefined;
    // Day buckets: a full cycle is ~31 rows, but page anyway rather than
    // silently truncating at the API's per-page limit.
    for (;;) {
      const page: any = await stripe.billing.meters.listEventSummaries(m.id, {
        customer,
        start_time: startSecs,
        end_time: endSecs,
        value_grouping_window: 'day',
        limit: 100,
        ...(starting_after ? { starting_after } : {}),
      });
      for (const s of page.data) total += s.aggregated_value;
      if (!page.has_more || !page.data.length) break;
      starting_after = page.data[page.data.length - 1].id;
    }
  }
  return total;
}

/**
 * The metered line on the invoice that closed this cycle, if any.
 *
 * A line whose period is shorter than the cycle is the mid-cycle-attach bug:
 * Stripe billed only the days the subscription item existed, and the graduated
 * free tier applied to that short window in full.
 */
async function meteredInvoiceLine(customer: string, cycleStart: Date, cycleEnd: Date, problems: string[]) {
  const invoices = await stripe.invoices.list({ customer, limit: 12 });
  // The renewal invoice is created at the cycle boundary.
  const target = invoices.data.find(inv => Math.abs(inv.created - Math.floor(cycleEnd.getTime() / 1000)) < 3600);
  if (!target) {
    problems.push(`no invoice found at cycle end ${cycleEnd.toISOString()}`);
    return;
  }
  // Classify off the resolved Price. The obvious `l.price.recurring.usage_type`
  // is always undefined in Stripe SDK v22 — an InvoiceLineItem has no `price`,
  // it has `pricing.price_details.price` — so the original predicate here was
  // dead and only its description sniff was working. Shared with the usage
  // history route so the oracle and the feature cannot disagree by construction.
  const priceCache = new Map<string, any>();
  for (const l of target.lines.data as any[]) {
    (l as any).__invoiceCreated = target.created;
    const id = linePriceId(l);
    if (id && !priceCache.has(id)) {
      try { priceCache.set(id, await stripe.prices.retrieve(id)); } catch { /* fallback classifier covers it */ }
    }
  }
  const metered = (target.lines.data as any[]).filter(l => classifyLine(l, (id) => priceCache.get(id)) === 'metered');
  if (!metered.length) {
    problems.push(`invoice ${target.id} (${money(target.total)}) has NO metered line`);
    return;
  }
  for (const l of metered as any[]) {
    if (!l.period) continue;
    const covered = l.period.end - l.period.start;
    const cycle = Math.floor((cycleEnd.getTime() - cycleStart.getTime()) / 1000);
    // A renewal invoice's metered line trails the cycle by a few minutes; only
    // flag a line that misses a meaningful slice of it.
    if (covered < cycle - DAY) {
      const missedDays = ((cycle - covered) / DAY).toFixed(1);
      problems.push(
        `invoice ${target.id}: metered line covers only ${iso(l.period.start)} -> ${iso(l.period.end)} ` +
        `(${missedDays} days of the cycle unbilled), qty=${l.quantity}`,
      );
    }
  }
}

async function main() {
  const users = ONLY_UID
    ? [await db.doc(`users/${ONLY_UID}`).get()]
    : (await db.collection('users').get()).docs;

  const rows: Row[] = [];
  for (const doc of users) {
    if (!doc.exists) { console.error(`no such user: ${ONLY_UID}`); process.exit(1); }
    const x = doc.data() || {};
    const sub = x.subscription || {};
    const customer = x.stripeCustomerId;
    const plan = sub.plan;
    // Only accounts that can actually be metered are reconcilable.
    if (!customer || !plan || !getPlan(plan).stripe.meterEventName) continue;
    if (!sub.currentPeriodStart || !sub.currentPeriodEnd) continue;

    const curStart = new Date(sub.currentPeriodStart);
    const curEnd = new Date(sub.currentPeriodEnd);
    // The cached period is the CURRENT one; the previous cycle is the month
    // before it. Using the same length keeps a 28/31-day month honest.
    const len = curEnd.getTime() - curStart.getTime();
    const cycleStart = CYCLE === 'current' ? curStart : new Date(curStart.getTime() - len);
    const cycleEnd = CYCLE === 'current' ? new Date() : curStart;

    // Both sides read the identical day-aligned window, so any difference is
    // real rather than a boundary artifact.
    const windowStart = floorDay(cycleStart);
    const windowEnd = ceilDay(cycleEnd);

    const problems: string[] = [];
    const firestore = await firestoreItems(doc.id, windowStart, windowEnd);
    const metered = await meteredItems(customer, windowStart, windowEnd);

    if (firestore !== metered) {
      problems.push(`${firestore} items counted in Firestore, ${metered} reported to Stripe (${firestore - metered} unmetered)`);
    }
    if (CYCLE === 'last') {
      await meteredInvoiceLine(customer, cycleStart, cycleEnd, problems);
    }

    rows.push({ uid: doc.id, plan, customer, windowStart, windowEnd, firestore, metered, problems });
  }

  rows.sort((a, b) => b.firestore - a.firestore);
  let diverged = 0;
  for (const r of rows) {
    if (QUIET && !r.problems.length) continue;
    if (r.problems.length) diverged++;
    const included = includedItemsFor(r.plan);
    const rate = overageRateFor(r.plan);
    const over = Math.max(0, r.firestore - included);
    console.log(`\n${r.uid}  plan=${r.plan}  ${iso(r.windowStart).slice(0, 10)} -> ${iso(r.windowEnd).slice(0, 10)}`);
    console.log(`  firestore=${r.firestore}  stripe_meter=${r.metered}  included=${included}` +
      (over && rate ? `  expected overage: ${over} x $${rate} = $${(over * rate).toFixed(2)}` : '  (within allowance)'));
    for (const p of r.problems) console.log(`  ! ${p}`);
  }

  console.log(`\n${rows.length} meterable account(s) checked, ${diverged} with problems.`);
  if (diverged) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
