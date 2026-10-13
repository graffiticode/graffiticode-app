#!/usr/bin/env node
/*
 * Backfill users/{uid}.signInEmail values into the auth-service linked_emails
 * registry.
 *
 * Usage:
 *   AUTH_SERVICE_URL=https://auth.graffiticode.org \
 *   INTERNAL_API_KEY=<value from Cloud Run> \
 *   npx tsx scripts/migrate-signin-email-to-linked-emails.ts          # dry-run
 *
 *   ... --apply                                                       # write
 */

import admin from 'firebase-admin';

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

const apply = process.argv.includes('--apply');
const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || 'https://auth.graffiticode.org').replace(/\/$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

if (!INTERNAL_API_KEY) {
  console.error('Error: INTERNAL_API_KEY env var required');
  console.error('Fetch from: gcloud run services describe auth --project graffiticode --region us-central1 --format="value(spec.template.spec.containers[0].env)"');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Outcome {
  migrated: number;
  skippedNoEmail: number;
  skippedSameUid: number;
  conflicts: { uid: string; email: string; conflictUid: string }[];
  errors: { uid: string; email: string; message: string }[];
}

async function postLinkedEmail(uid: string, email: string): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${AUTH_SERVICE_URL}/linked-emails/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': INTERNAL_API_KEY,
    },
    body: JSON.stringify({ uid, email }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const outcome: Outcome = {
    migrated: 0,
    skippedNoEmail: 0,
    skippedSameUid: 0,
    conflicts: [],
    errors: [],
  };

  const snap = await db.collection('users').get();
  console.log(`Found ${snap.size} user docs`);

  let scanned = 0;
  for (const doc of snap.docs) {
    scanned += 1;
    if (scanned % 100 === 0) {
      console.log(`...scanned ${scanned}`);
    }
    const data = doc.data();
    const email = typeof data?.signInEmail === 'string' ? data.signInEmail.trim() : '';
    if (!email) {
      outcome.skippedNoEmail += 1;
      continue;
    }
    const uid = doc.id;

    if (!apply) {
      console.log(`would migrate ${email} → ${uid}`);
      outcome.migrated += 1;
      continue;
    }

    const { ok, status, body } = await postLinkedEmail(uid, email);
    if (ok) {
      outcome.migrated += 1;
      console.log(`migrated ${email} → ${uid}`);
    } else if (status === 409) {
      const conflictUid = body?.error?.details?.conflictUid;
      if (conflictUid === uid) {
        outcome.skippedSameUid += 1;
      } else {
        outcome.conflicts.push({ uid, email, conflictUid });
        console.error(`CONFLICT: email=${email} signin_uid=${uid} linked_uid=${conflictUid}`);
      }
    } else {
      const message = body?.error?.message || `HTTP ${status}`;
      outcome.errors.push({ uid, email, message });
      console.error(`error for ${email} (${uid}): ${message}`);
    }

    if (outcome.migrated % 50 === 0) {
      await sleep(50);
    }
  }

  console.log('---');
  console.log(`Migrated:           ${outcome.migrated}`);
  console.log(`Skipped (no email): ${outcome.skippedNoEmail}`);
  console.log(`Skipped (same uid): ${outcome.skippedSameUid}`);
  console.log(`Conflicts:          ${outcome.conflicts.length}`);
  console.log(`Errors:             ${outcome.errors.length}`);
  if (outcome.conflicts.length) {
    console.log('\nConflict detail:');
    for (const c of outcome.conflicts) {
      console.log(`  ${c.email}: signin_uid=${c.uid} → already linked to ${c.conflictUid}`);
    }
  }
  if (!apply) {
    console.log('\nDry-run. Re-run with --apply to write.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
