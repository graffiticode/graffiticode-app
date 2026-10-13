#!/usr/bin/env tsx
// Delete a row from the auth-service `linked-emails` Firestore collection.
// Use after deleting a user account directly in Firestore: removes the stale
// email -> uid mapping so the email can be re-added or re-claimed.
//
//   (after `gcloud auth application-default login`)
//   npx tsx scripts/delete-linked-email.ts <email>

import crypto from 'crypto';
import admin from 'firebase-admin';

// The graffiticode project, as the operator's own application-default
// credentials (`gcloud auth application-default login`), never a
// service-account key file: GOOGLE_APPLICATION_CREDENTIALS is cleared so a key
// path left in the environment isn't picked up instead.
if (process.env.GRAFFITICODE_CREDENTIALS) {
  console.warn('GRAFFITICODE_CREDENTIALS is no longer read; using application-default credentials');
}
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const email = process.argv[2];
if (!email) {
  console.error('usage: delete-linked-email.ts <email>');
  process.exit(1);
}

const normalize = (s: string) => s.trim().toLowerCase();
const docId = (s: string) => crypto.createHash('sha256').update(normalize(s)).digest('hex');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode',
});

const db = admin.firestore();

(async () => {
  const id = docId(email);
  const ref = db.doc(`linked-emails/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`linked-emails/${id} does not exist — nothing to delete`);
    process.exit(0);
  }
  console.log(`deleting linked-emails/${id}:`);
  console.log(JSON.stringify(snap.data(), null, 2));
  await ref.delete();
  console.log('deleted');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
