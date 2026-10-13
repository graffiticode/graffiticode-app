#!/usr/bin/env node
// One-off: correct subscription.preservedAllocation for an account whose plan
// was stale in Firestore at downgrade time (missed webhook).
// Usage: npx tsx scripts/set-preserved-allocation.ts <userId> <units>
import admin from 'firebase-admin';

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Set GRAFFITICODE_APP_CREDENTIALS');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

async function main() {
  const userId = process.argv[2];
  const units = Number(process.argv[3]);
  if (!userId || !Number.isFinite(units)) {
    console.error('Usage: set-preserved-allocation.ts <userId> <units>');
    process.exit(1);
  }
  const ref = db.collection('users').doc(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`user ${userId} not found`);
    process.exit(1);
  }
  const before = snap.data()?.subscription?.preservedAllocation;
  await ref.update({ 'subscription.preservedAllocation': units });
  console.log(`users/${userId}: preservedAllocation ${before} -> ${units}`);
}

main().then(() => process.exit(0));
