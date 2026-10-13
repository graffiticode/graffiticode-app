#!/usr/bin/env node

/**
 * Hard-cap the anonymous free-plan (MCP trial) account at its plan's included
 * items.
 *
 * The trial is a real account with a real subscription, and checkItemCreateAllowed
 * caps a paid tier at `includedItems + overageLimitItems` whenever that field is
 * a number (src/lib/usage-service.ts). Setting it to 0 therefore turns the paid
 * branch into a hard cap at the plan allowance — no parallel counter, no
 * hardcoded number, and the cap follows the account if it's moved between tiers.
 *
 * It also guarantees the trial can never accrue billable overage even if a meter
 * report ever leaked past the free-plan guard in recordBillableItem.
 *
 * Usage:
 *   npx tsx scripts/cap-trial-account.ts [--uid <uid>] [--apply]
 *
 * Reads FREE_PLAN_UID from the environment when --uid is omitted. Dry-run by
 * default; pass --apply to write.
 */

import admin from 'firebase-admin';
import { effectiveIncludedItems, getPlan, DEFAULT_PLAN } from '../src/lib/plans-config';

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  console.error('Set it to the path of your graffiticode-app service account key');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const uidFlag = args.indexOf('--uid');
  const uid = uidFlag >= 0 ? args[uidFlag + 1] : process.env.FREE_PLAN_UID;

  if (!uid) {
    console.error('Error: no uid. Pass --uid <uid> or set FREE_PLAN_UID.');
    process.exit(1);
  }

  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    throw new Error(`Trial account ${uid} not found`);
  }

  const subscription = userDoc.data()?.subscription || {};
  const plan = subscription.plan || DEFAULT_PLAN;
  const included = effectiveIncludedItems(plan, subscription);
  const current = subscription.overageLimitItems;

  console.log(`Trial account:      ${uid}`);
  console.log(`Plan:               ${plan} (${getPlan(plan).displayName})`);
  console.log(`Included items:     ${included}`);
  console.log(`overageLimitItems:  ${current === undefined ? '(unset — currently UNCAPPED)' : current}`);

  if (current === 0) {
    console.log('\nAlready hard-capped. Nothing to do.');
    return;
  }

  console.log(`\n→ set subscription.overageLimitItems = 0 (hard cap at ${included} items/period)`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  await userRef.update({ 'subscription.overageLimitItems': 0 });
  console.log('\nApplied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
