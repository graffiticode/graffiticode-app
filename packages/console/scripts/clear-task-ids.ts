#!/usr/bin/env node

import admin from 'firebase-admin';

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

const args = process.argv.slice(2);

if (args.includes('--help') || !args.includes('--lang')) {
  console.log(`
Usage: npx tsx scripts/clear-task-ids.ts --lang <language> [--mark <marks>] [--dry-run]

Clears taskId from items so they will be reposted on next access.

Options:
  --lang <language>   Language code (e.g., "0158") [required]
  --mark <marks>      Filter by mark value(s), comma-separated (default: all)
  --dry-run           Show what would be cleared without making changes
  --help              Show this help message
`);
  process.exit(args.includes('--help') ? 0 : 1);
}

const userId = args.includes('--uid')
  ? args[args.indexOf('--uid') + 1]
  : '2c9d72e315fbafb128011bc32739666c7e6e7eb9';
const lang = args[args.indexOf('--lang') + 1];
const markValues: number[] | null = args.includes('--mark')
  ? args[args.indexOf('--mark') + 1].split(',').map(v => parseInt(v.trim()))
  : null;
const dryRun = args.includes('--dry-run');

if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app'
});

async function main() {
  const db = admin.firestore();
  let query: any = db.collection(`users/${userId}/items`).where('lang', '==', lang);

  if (markValues) {
    if (markValues.length === 1) {
      query = query.where('mark', '==', markValues[0]);
    } else {
      query = query.where('mark', 'in', markValues);
    }
  }

  const snapshot = await query.get();
  const markLabel = markValues ? `mark=${markValues.join(',')}` : 'all marks';
  console.log(`Found ${snapshot.size} items for L${lang} (${markLabel})`);

  if (dryRun) {
    console.log('Dry run - no changes made');
    let withTaskId = 0;
    snapshot.forEach(doc => {
      if (doc.data().taskId) withTaskId++;
    });
    console.log(`${withTaskId} items have taskIds that would be cleared`);
    process.exit(0);
  }

  let cleared = 0;
  let skipped = 0;
  const batchSize = 20;
  const docs = snapshot.docs;

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    await Promise.all(batch.map(async (doc) => {
      const data = doc.data();
      if (data.taskId) {
        await doc.ref.update({ taskId: admin.firestore.FieldValue.delete() });
        cleared++;
      } else {
        skipped++;
      }
    }));
    process.stdout.write(`\r${cleared + skipped}/${docs.length}`);
  }
  console.log(`\nDone. Cleared: ${cleared}, Skipped (no taskId): ${skipped}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
