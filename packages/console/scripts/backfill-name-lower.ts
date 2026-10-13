#!/usr/bin/env node
// Backfill users/{uid}.nameLower from users/{uid}.name, so the account lookup
// (findAccounts, src/lib/account-lookup.ts) can find accounts named before
// nameLower was written. One-off; safe to re-run (only writes docs whose
// nameLower is missing or stale). Prints counts only, never names or ids.
//
// Confirm (dry-run):
//   npx tsx scripts/backfill-name-lower.ts
// Apply:
//   npx tsx scripts/backfill-name-lower.ts --apply

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

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
const db = admin.firestore();

// Must match normalizeName in src/lib/account-lookup.ts (not imported: that
// module pulls in the app's Firestore setup).
const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

async function main() {
  const apply = process.argv.includes('--apply');
  const users = await db.collection('users').get();
  let noName = 0;
  let current = 0;
  const stale: FirebaseFirestore.DocumentReference[] = [];
  const updates = new Map<string, string>();
  for (const doc of users.docs) {
    const { name, nameLower } = doc.data() || {};
    if (typeof name !== 'string' || !name.trim()) { noName++; continue; }
    const want = normalizeName(name);
    if (nameLower === want) { current++; continue; }
    stale.push(doc.ref);
    updates.set(doc.id, want);
  }
  console.log(`users: ${users.size} | no name: ${noName} | nameLower current: ${current} | to write: ${stale.length}`);
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }
  let written = 0;
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    for (const ref of stale.slice(i, i + 400)) {
      batch.update(ref, { nameLower: updates.get(ref.id) });
    }
    await batch.commit();
    written += Math.min(400, stale.length - i);
  }
  console.log(`wrote nameLower on ${written} users`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
