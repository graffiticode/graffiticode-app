#!/usr/bin/env node

// Reconcile the denormalized users/{uid}.subscription cache in Firestore against
// the source of truth in Stripe. The Stripe webhook (src/pages/api/webhooks/stripe.ts)
// is supposed to keep these in sync on customer.subscription.created/updated, but a
// missed/failed delivery (or a pre-webhook upgrade / manual edit) can leave the cache
// stale — e.g. plan="demo" while Stripe has an active pro subscription. This re-derives
// each user's subscription from Stripe using the webhook's exact PLAN_MAPPING and
// rewrites the cache to match.
//
// MUST run with the LIVE Stripe key (live customers won't resolve under a test key).
//
// Usage:
//   npx tsx scripts/reconcile-subscriptions.ts                 # dry-run, active subs only
//   npx tsx scripts/reconcile-subscriptions.ts --apply         # write fixes for active/trialing subs
//   npx tsx scripts/reconcile-subscriptions.ts --include-downgrades --apply
//                                                              # also reset users with no active sub to the free plan
//   npx tsx scripts/reconcile-subscriptions.ts --uid <uid>     # limit to one user

import admin from 'firebase-admin';
import Stripe from 'stripe';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local (existing env wins, so STRIPE_SECRET_KEY can be overridden inline)
try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Error: STRIPE_SECRET_KEY not set');
  process.exit(1);
}
if (process.env.STRIPE_SECRET_KEY.startsWith('sk_test')) {
  console.warn('WARNING: STRIPE_SECRET_KEY is a TEST-mode key — live customers will not resolve.');
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

const APPLY = process.argv.includes('--apply');
const INCLUDE_DOWNGRADES = process.argv.includes('--include-downgrades');
const ONLY_UID = (() => {
  const i = process.argv.indexOf('--uid');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

// Same mapping the webhook uses (src/pages/api/webhooks/stripe.ts).
import { STRIPE_API_VERSION, priceIdToPlan, includedItemsFor, DEFAULT_PLAN } from '../src/lib/plans-config';
import { subscriptionPeriod } from '../src/lib/stripe-helpers';

// Resolve the plan from a subscription's items (base price; a paid sub also
// carries a metered overage price). Item counts come from the central config.
function planInfoFor(sub: Stripe.Subscription): { name: string; units: number } | null {
  // Returns null when no price maps — NEVER DEFAULT_PLAN.
  //
  // priceIdToPlan compares against STRIPE_*_PRICE_ID env vars, which are
  // mode-specific: live price ids do not resolve under a test key and vice
  // versa. Running this script with a live key while .env.local still has the
  // TEST price ids active makes every paid price unmappable — and the old
  // `|| DEFAULT_PLAN` then reported "stripe plan=demo" for an active $100/mo
  // subscription. With --apply that writes the downgrade onto a paying account,
  // which is the exact opposite of reconciling.
  //
  // An unmappable price means the environment is misconfigured, not that the
  // customer is free. Skip the user and say so; a missed fix is recoverable, a
  // written downgrade is not.
  const name = sub.items.data.map(it => priceIdToPlan(it?.price?.id)).find(Boolean);
  if (!name) return null;
  return { name, units: includedItemsFor(name) };
}

async function activeSubFor(customerId: string): Promise<Stripe.Subscription | null> {
  let subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
  if (!subs.data.length) {
    subs = await stripe.subscriptions.list({ customer: customerId, status: 'trialing', limit: 1 });
  }
  return subs.data[0] || null;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}${INCLUDE_DOWNGRADES ? ' +downgrades' : ''}`);
  let query: admin.firestore.Query = db.collection('users');
  const snap = ONLY_UID
    ? { docs: [await db.collection('users').doc(ONLY_UID).get()].filter(d => d.exists) }
    : await query.get();
  console.log(`Scanning ${snap.docs.length} user(s)...\n`);

  let drift = 0, fixed = 0, ok = 0, skipped = 0;
  for (const doc of snap.docs) {
    const uid = doc.id;
    const data = doc.data() as any;
    const cur = data.subscription || {};
    const customerId = data.stripeCustomerId;
    if (!customerId) { skipped++; continue; }

    let sub: Stripe.Subscription | null = null;
    try { sub = await activeSubFor(customerId); }
    catch (e: any) { console.log(`  ${uid}: stripe error: ${e.message}`); skipped++; continue; }

    if (sub) {
      const planInfo = planInfoFor(sub);
      if (!planInfo) {
        const priceIds = sub.items.data.map(it => it?.price?.id).filter(Boolean).join(', ');
        console.log(
          `  UNMAPPABLE ${uid}: subscription ${sub.id} is ${sub.status} but none of its price ids ` +
          `[${priceIds}] map to a known plan — refusing to touch this account. This is almost ` +
          `always a live/test mode mismatch: check the STRIPE_*_PRICE_ID values match the mode of ` +
          `STRIPE_SECRET_KEY.`,
        );
        skipped++;
        continue;
      }
      const mismatch = cur.plan !== planInfo.name
        || cur.units !== planInfo.units
        || cur.stripeSubscriptionId !== sub.id
        || cur.status !== sub.status;
      if (!mismatch) { ok++; continue; }
      drift++;
      console.log(`  DRIFT ${uid}: firestore plan=${cur.plan}/units=${cur.units}/subId=${cur.stripeSubscriptionId} -> stripe plan=${planInfo.name}/units=${planInfo.units}/subId=${sub.id} (${sub.status})`);
      if (APPLY) {
        await db.collection('users').doc(uid).update({
          'subscription.status': sub.status,
          'subscription.plan': planInfo.name,
          'subscription.units': planInfo.units,
          'subscription.stripeSubscriptionId': sub.id,
          'subscription.currentPeriodStart': (() => { const p = subscriptionPeriod(sub).start; return p ? new Date(p * 1000).toISOString() : null; })(),
          'subscription.currentPeriodEnd': (() => { const p = subscriptionPeriod(sub).end; return p ? new Date(p * 1000).toISOString() : null; })(),
          'subscription.cancelAtPeriodEnd': sub.cancel_at_period_end,
          'subscription.updatedAt': new Date().toISOString(),
          'subscription.reconciledAt': new Date().toISOString(),
        });
        fixed++;
      }
    } else {
      // No active/trialing Stripe sub. Canonical free state is the default plan.
      const freeUnits = includedItemsFor(DEFAULT_PLAN);
      const claimsPaid = cur.plan && cur.plan !== DEFAULT_PLAN;
      if (!claimsPaid) { ok++; continue; }
      drift++;
      console.log(`  DRIFT ${uid}: firestore plan=${cur.plan} but NO active Stripe sub -> should be ${DEFAULT_PLAN}/${freeUnits}${INCLUDE_DOWNGRADES ? '' : '  (skipped; pass --include-downgrades to fix)'}`);
      if (APPLY && INCLUDE_DOWNGRADES) {
        await db.collection('users').doc(uid).update({
          'subscription.status': 'canceled',
          'subscription.plan': DEFAULT_PLAN,
          'subscription.units': freeUnits,
          'subscription.stripeSubscriptionId': null,
          'subscription.updatedAt': new Date().toISOString(),
          'subscription.reconciledAt': new Date().toISOString(),
        });
        fixed++;
      }
    }
  }

  console.log(`\nDone. in-sync=${ok} drift=${drift} fixed=${fixed} skipped(no customer/err)=${skipped}`);
  if (drift > 0 && !APPLY) console.log('Re-run with --apply to write the fixes.');
}

main().catch(e => { console.error(e); process.exit(1); });
