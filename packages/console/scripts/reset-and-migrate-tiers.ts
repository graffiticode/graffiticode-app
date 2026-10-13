/**
 * Cutover migration for item-based pricing (graffiticode-app Firestore).
 *
 * For every account:
 *   - reset usage/{uid}.currentMonthTotal to 0 (fresh item counter, lastReset now)
 *   - resync subscription.units to the plan's item allowance (includedItemsFor)
 *   - clear stale compile-scale / prepaid-overage fields (overageUnits,
 *     autoOverage*, preservedAllocation/Until, lastOveragePurchase)
 *
 * Plan ids are unchanged (demo/pro/teams/platinum); only the numbers migrate.
 * Stripe is not touched here — use migrate-to-item-pricing.ts for that.
 *
 * Usage:
 *   npx tsx scripts/reset-and-migrate-tiers.ts [--apply]   (default: dry run)
 */
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { includedItemsFor } from '../src/lib/plans-config';

const APPLY = process.argv.includes('--apply');

if (!admin.apps.length) {
  const keyPath = process.env.GRAFFITICODE_APP_CREDENTIALS;
  admin.initializeApp({
    credential: keyPath ? admin.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8'))) : admin.credential.applicationDefault(),
    projectId: 'graffiticode-app',
  });
}
const db = admin.firestore();
const del = admin.firestore.FieldValue.delete();

async function main() {
  const nowISO = new Date().toISOString();
  const usersSnap = await db.collection('users').get();
  console.log(`\n=== Reset usage + migrate tiers${APPLY ? '' : ' (DRY RUN)'} — ${usersSnap.size} accounts ===\n`);

  let batch = db.batch();
  let ops = 0, resets = 0, migrated = 0;

  const flush = async () => { if (APPLY && ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const doc of usersSnap.docs) {
    const uid = doc.id;
    const sub = (doc.data() as any).subscription;

    // Reset the item counter for everyone.
    batch.set(db.collection('usage').doc(uid), { currentMonthTotal: 0, lastReset: nowISO }, { merge: true });
    ops++; resets++;

    // Migrate the subscription doc's numbers (only if a subscription exists).
    if (sub && sub.plan) {
      batch.update(doc.ref, {
        'subscription.units': includedItemsFor(sub.plan),
        'subscription.overageUnits': del,
        'subscription.autoOverageEnabled': del,
        'subscription.autoOverageLockUntil': del,
        'subscription.preservedAllocation': del,
        'subscription.preservedUntil': del,
        'subscription.lastOveragePurchase': del,
        'subscription.updatedAt': nowISO,
      });
      ops++; migrated++;
      if (migrated <= 20) console.log(`  ${uid}: plan=${sub.plan} units ${sub.units ?? '?'} -> ${includedItemsFor(sub.plan)}`);
    }

    if (ops >= 400) await flush();
  }
  await flush();

  console.log(`\naccounts=${usersSnap.size} usageReset=${resets} subscriptionsMigrated=${migrated}${APPLY ? '' : ' (dry run — re-run with --apply)'}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
