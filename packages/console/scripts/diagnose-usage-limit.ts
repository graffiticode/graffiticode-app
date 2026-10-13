#!/usr/bin/env node
// Diagnose why a user is blocked by the usage limit.
// Usage: npx tsx scripts/diagnose-usage-limit.ts <emailOrUid>

import admin from 'firebase-admin';
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

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

// Allowances come from the central config — never a local map (the old mirrored
// map here went stale when compile units were retired for item-based pricing).
import {
  PLANS, DEFAULT_PLAN, includedItemsFor, effectiveIncludedItems, isHardCapped, overageRateFor,
} from '../src/lib/plans-config';

async function findUid(arg: string): Promise<string | null> {
  if (!arg.includes('@')) {
    const doc = await db.doc(`users/${arg}`).get();
    if (doc.exists) return arg;
  }
  for (const field of ['email', 'signInEmail', 'notificationEmail']) {
    const snap = await db.collection('users').where(field, '==', arg).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('Usage: diagnose-usage-limit.ts <emailOrUid>'); process.exit(1); }

  const uid = await findUid(arg);
  if (!uid) { console.error(`No user found for "${arg}"`); process.exit(1); }

  const userData = (await db.doc(`users/${uid}`).get()).data() || {};
  const sub = userData.subscription || {};
  const usageDoc = await db.collection('usage').doc(uid).get();
  const storedTotal = usageDoc.exists ? (usageDoc.data()?.currentMonthTotal || 0) : 0;
  const lastReset = usageDoc.data()?.lastReset;

  const now = new Date();
  const plan = sub.plan || DEFAULT_PLAN;
  const planKnown = plan in PLANS;
  const planIncluded = includedItemsFor(plan);
  // Preserved allocation only ever RAISES the allowance (see plans-config).
  const includedItems = effectiveIncludedItems(plan, sub, now);
  const preservedApplied = includedItems > planIncluded;
  const preservedUnexpired = !!(sub.preservedUntil && sub.preservedAllocation && new Date(sub.preservedUntil) > now);

  const periodStart = sub.currentPeriodStart
    ? new Date(sub.currentPeriodStart)
    : new Date(now.getFullYear(), now.getMonth(), 1);

  const recs = await db.collection('usage')
    .where('userId', '==', uid)
    .where('createdAt', '>=', periodStart)
    .get();
  // Only billable item records count; legacy compile/ai_generation records carry
  // compile-unit `units` and are not items.
  let calc = 0;
  recs.docs.forEach(d => { const r = d.data(); if (r.type === 'item_created') calc += r.units || 0; });

  const currentUsage = calc; // checkItemCreateAllowed syncs stored -> calc
  const hardCap = isHardCapped(plan);
  const overageLimitItems = typeof sub.overageLimitItems === 'number' ? sub.overageLimitItems : null;
  const totalAvailable = hardCap
    ? includedItems
    : (overageLimitItems === null ? Infinity : includedItems + overageLimitItems);
  const allowed = currentUsage < totalAvailable;

  console.log(`\n=== Usage-limit diagnosis for ${userData.email || userData.signInEmail || uid} ===`);
  console.log(`uid:                 ${uid}`);
  console.log(`\n-- subscription --`);
  console.log(`plan:                ${plan}  ${planKnown ? `(${PLANS[plan as keyof typeof PLANS].displayName}, ${planIncluded} items/mo)` : `  ⚠️  UNKNOWN KEY → falls back to ${DEFAULT_PLAN} (${includedItemsFor(DEFAULT_PLAN)})`}`);
  console.log(`status:              ${sub.status}`);
  console.log(`units (stored):      ${sub.units}${typeof sub.units === 'number' && sub.units !== planIncluded ? `  ⚠️ stale (plan includes ${planIncluded}); display-only, run reconcile-subscriptions.ts` : ''}`);
  console.log(`overageLimitItems:   ${overageLimitItems === null ? 'none (uncapped)' : overageLimitItems}`);
  console.log(`currentPeriodStart:  ${sub.currentPeriodStart}`);
  console.log(`currentPeriodEnd:    ${sub.currentPeriodEnd}`);
  console.log(`stripeSubscriptionId:${sub.stripeSubscriptionId}`);
  console.log(`updatedAt:           ${sub.updatedAt}`);
  if (sub.preservedAllocation) {
    const state = preservedApplied
      ? '  ACTIVE (raises allowance)'
      : preservedUnexpired
        ? `  (unexpired but ignored — ${sub.preservedAllocation} < plan's ${planIncluded}; stale leftover, safe to delete)`
        : ' (expired)';
    console.log(`preservedAllocation: ${sub.preservedAllocation} until ${sub.preservedUntil}${state}`);
  }
  console.log(`\n-- usage doc --`);
  console.log(`currentMonthTotal:   ${storedTotal}`);
  console.log(`lastReset:           ${lastReset}`);
  console.log(`\n-- recomputed (what checkItemCreateAllowed does) --`);
  console.log(`periodStart used:    ${periodStart.toISOString()}`);
  console.log(`usage records since: ${recs.size}`);
  console.log(`items counted:       ${calc}  ${calc !== storedTotal ? `(differs from stored ${storedTotal})` : ''}`);
  console.log(`includedItems:       ${includedItems}${preservedApplied ? '  (via preserved allocation)' : ''}`);
  console.log(`overage rate:        ${overageRateFor(plan) === null ? 'n/a (hard cap)' : `$${overageRateFor(plan)}/item`}`);
  console.log(`totalAvailable:      ${totalAvailable === Infinity ? 'unlimited (paid, no spend cap)' : totalAvailable}`);
  console.log(`\n>>> allowed:         ${allowed}  (${currentUsage} < ${totalAvailable === Infinity ? '∞' : totalAvailable})`);
  if (!allowed) {
    console.log(`\nVERDICT: blocked because used ${currentUsage} >= available ${totalAvailable}.`);
    if (!planKnown) console.log(`  → ROOT CAUSE likely: plan "${plan}" is not a known key, so allocation defaulted to ${DEFAULT_PLAN} (${includedItemsFor(DEFAULT_PLAN)}).`);
    else if (hardCap) console.log(`  → plan "${plan}" is hard-capped at ${includedItems} items/mo; upgrade to create more.`);
    else console.log(`  → overage spend cap reached (${overageLimitItems} items past the included ${includedItems}); raise or remove the cap.`);
  }
  console.log('');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
