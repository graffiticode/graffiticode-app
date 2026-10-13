#!/usr/bin/env node
// Clear stale users/{uid}.subscription.preservedAllocation / preservedUntil.
//
// preservedAllocation exists so a customer who downgrades keeps the LARGER
// bucket they already paid for until the period ends. Compile-unit-era values
// (e.g. 250) linger on docs and, before the plans-config fix, were applied
// unconditionally — capping paid accounts below their own plan (a Silver
// account showing a 250-item limit instead of 1,000).
//
// The read paths now take max(planIncluded, preserved), so a stale value is
// inert. This script removes the leftovers so the docs stop lying.
//
// Categories:
//   capping   preserved < plan's included AND unexpired  -> was actively wrong
//   expired   preservedUntil in the past                 -> inert leftover
//   raising   preserved > plan's included AND unexpired  -> real grace bucket, kept
//   legacy    raising, but the value matches no plan's allowance -> compile-unit
//             leftover (e.g. 250) inflating a bucket it was never meant to;
//             cleared only with --clear-legacy-raising
//
// A genuine preserved allocation is always some plan's includedItems (or 12x it
// for an annual sub), because that is the only thing the downgrade paths write.
// A value outside that set predates item-based pricing.
//
// Usage:
//   npx tsx scripts/clear-stale-preserved-allocation.ts            # dry-run
//   npx tsx scripts/clear-stale-preserved-allocation.ts --apply
//   npx tsx scripts/clear-stale-preserved-allocation.ts --clear-legacy-raising --apply
//   npx tsx scripts/clear-stale-preserved-allocation.ts --uid <uid> --apply

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PLANS, DEFAULT_PLAN, includedItemsFor } from '../src/lib/plans-config';

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

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');
const CLEAR_LEGACY_RAISING = process.argv.includes('--clear-legacy-raising');

// Every allocation the downgrade paths can legitimately write: a plan's monthly
// included items, or 12x that for an annual subscription.
const VALID_ALLOCATIONS = new Set<number>(
  Object.values(PLANS).flatMap(p => [p.includedItems, p.includedItems * 12]),
);
const ONLY_UID = (() => {
  const i = process.argv.indexOf('--uid');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);
  const docs = ONLY_UID
    ? [await db.collection('users').doc(ONLY_UID).get()].filter(d => d.exists)
    : (await db.collection('users').get()).docs;

  const now = new Date();
  let capping = 0, expired = 0, raising = 0, legacyRaising = 0, cleared = 0;

  for (const doc of docs) {
    const sub = (doc.data() as any)?.subscription;
    const preserved = sub?.preservedAllocation;
    const until = sub?.preservedUntil;
    if (typeof preserved !== 'number' || !until) continue;

    const plan = sub.plan || DEFAULT_PLAN;
    const included = includedItemsFor(plan);
    const planLabel = (PLANS as any)[plan]?.displayName || plan;
    const unexpired = new Date(until) > now;

    if (unexpired && preserved > included) {
      if (VALID_ALLOCATIONS.has(preserved)) {
        raising++;
        console.log(`  KEEP    ${doc.id}: ${planLabel} includes ${included}, preserved ${preserved} until ${until} (real grace bucket)`);
        continue;
      }
      legacyRaising++;
      console.log(`  LEGACY  ${doc.id}: ${planLabel} includes ${included}, preserved ${preserved} until ${until} — matches no plan allowance (compile-unit leftover)${CLEAR_LEGACY_RAISING ? '' : '  [kept; pass --clear-legacy-raising]'}`);
      if (!CLEAR_LEGACY_RAISING) continue;
    } else if (unexpired) {
      capping++;
      console.log(`  CAPPING ${doc.id}: ${planLabel} includes ${included} but preserved ${preserved} until ${until}`);
    } else {
      expired++;
      console.log(`  EXPIRED ${doc.id}: ${planLabel}, preserved ${preserved} until ${until} (inert)`);
    }

    if (APPLY) {
      await doc.ref.update({
        'subscription.preservedAllocation': admin.firestore.FieldValue.delete(),
        'subscription.preservedUntil': admin.firestore.FieldValue.delete(),
      });
      cleared++;
    }
  }

  console.log(`\nDone. capping=${capping} expired=${expired} legacy-raising=${legacyRaising} kept(real)=${raising} cleared=${cleared}`);
  if ((capping || expired || (legacyRaising && CLEAR_LEGACY_RAISING)) && !APPLY) {
    console.log('Re-run with --apply to clear them.');
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
