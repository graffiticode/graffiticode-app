#!/usr/bin/env node
// Backfill a user's Firestore `subscription` from their live Stripe subscription.
// Use when a checkout/upgrade succeeded in Stripe but the webhook never wrote it back.
//
// Confirm (dry-run):
//   STRIPE_LIVE_KEY=sk_live_... npx tsx scripts/backfill-subscription.ts <uid>
// Apply:
//   STRIPE_LIVE_KEY=sk_live_... npx tsx scripts/backfill-subscription.ts <uid> --apply
// Override plan mapping if price id isn't in env:
//   ... --plan pro

import admin from 'firebase-admin';
import Stripe from 'stripe';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

const liveKey = process.env.STRIPE_LIVE_KEY;
if (!liveKey || !liveKey.startsWith('sk_live_')) {
  console.error('Error: set STRIPE_LIVE_KEY=sk_live_... in the environment for this run.');
  process.exit(1);
}
if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
const db = admin.firestore();
const stripe = new Stripe(liveKey, { apiVersion: STRIPE_API_VERSION });

// Plan + item allowance come from the central config (src/lib/plans-config).
// Price ids come from env; in a test-mode .env.local these are test ids and
// won't match a live sub — use --plan then.
import { STRIPE_API_VERSION, priceIdToPlan, includedItemsFor, type PlanId } from '../src/lib/plans-config';
import { subscriptionPeriod } from '../src/lib/stripe-helpers';

async function main() {
  const args = process.argv.slice(2);
  const uid = args.find(a => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const planOverride = (() => { const i = args.indexOf('--plan'); return i >= 0 ? args[i + 1] : null; })();
  if (!uid) { console.error('Usage: backfill-subscription.ts <uid> [--plan starter|pro|teams] [--apply]'); process.exit(1); }

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) { console.error(`No user ${uid}`); process.exit(1); }
  const user = userSnap.data() || {};
  const customerId = user.stripeCustomerId;
  if (!customerId) { console.error('User has no stripeCustomerId'); process.exit(1); }
  console.log(`user ${uid} | customer ${customerId} | existing subscription: ${JSON.stringify(user.subscription)}`);

  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  console.log(`\nlive subscriptions: ${subs.data.length}`);
  subs.data.forEach(s => {
    const p = s.items.data[0]?.price;
    const per = subscriptionPeriod(s);
    const fmt = (t?: number) => t ? new Date(t * 1000).toISOString() : 'n/a';
    console.log(`  ${s.id} status=${s.status} price=${p?.id} amount=${p?.unit_amount} interval=${p?.recurring?.interval} period ${fmt(per.start)} -> ${fmt(per.end)}`);
  });

  const active = subs.data.find(s => ['active', 'trialing', 'past_due'].includes(s.status));
  if (!active) { console.error('\nNo active/trialing subscription found in live Stripe; nothing to backfill.'); process.exit(1); }

  const resolvedName = active.items.data.map(it => priceIdToPlan(it?.price?.id)).find(Boolean) || null;
  let planInfo = resolvedName ? { name: resolvedName, units: includedItemsFor(resolvedName) } : null;
  if (planOverride) {
    planInfo = { name: planOverride as PlanId, units: includedItemsFor(planOverride) };
  }
  if (!planInfo) {
    const priceId = active.items.data[0]?.price.id || '';
    console.error(`\nPrice ${priceId} does not map to a known plan (likely test-vs-live price ids).`);
    console.error(`Re-run with --plan <silver|gold|platinum internal id: pro|teams|platinum> after confirming from the Stripe dashboard.`);
    process.exit(1);
  }

  const updateData: Record<string, any> = {
    'subscription.status': active.status,
    'subscription.plan': planInfo.name,
    'subscription.units': planInfo.units,
    'subscription.stripeSubscriptionId': active.id,
    'subscription.currentPeriodStart': (() => { const p = subscriptionPeriod(active).start; return p ? new Date(p * 1000).toISOString() : null; })(),
    'subscription.currentPeriodEnd': (() => { const p = subscriptionPeriod(active).end; return p ? new Date(p * 1000).toISOString() : null; })(),
    'subscription.cancelAtPeriodEnd': active.cancel_at_period_end,
    'subscription.updatedAt': new Date().toISOString(),
  };

  console.log(`\n${apply ? 'APPLYING' : 'DRY-RUN — would write'}:`);
  console.log(JSON.stringify(updateData, null, 2));

  if (apply) {
    await userRef.update(updateData);
    await db.collection('subscription_events').add({
      userId: uid, type: 'manual_backfill', subscriptionId: active.id, plan: planInfo.name, timestamp: new Date(),
    });
    console.log('\n✅ Written. Re-run scripts/diagnose-usage-limit.ts to verify the gate now passes.');
  } else {
    console.log('\n(dry-run) re-run with --apply to commit.');
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
