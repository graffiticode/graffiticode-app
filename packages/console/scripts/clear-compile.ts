#!/usr/bin/env node

/**
 * clear-compile.ts — delete cached compile records from the graffiticode project.
 *
 * Usage:
 *   npx tsx scripts/clear-compile.ts <taskId> [taskId ...]
 *   <source of ids> | npx tsx scripts/clear-compile.ts [--prefix] [--dry-run]
 *
 *   --prefix   treat each id as a prefix, so `taskId` also clears every
 *              `taskId+dataId` chain compiled from it. Needed when clearing a
 *              whole language, whose taskIds come from list-task-ids.ts:
 *                npx tsx scripts/list-task-ids.ts --lang 0176 \
 *                  | npx tsx scripts/clear-compile.ts --prefix
 *   --dry-run  report what would be deleted, delete nothing
 *
 * Requires: application-default credentials (`gcloud auth application-default login`)
 * with access to the graffiticode project (NOT graffiticode-app).
 */
import admin from 'firebase-admin';

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

// The graffiticode project, as the operator's own application-default
// credentials (`gcloud auth application-default login`), never a
// service-account key file: GOOGLE_APPLICATION_CREDENTIALS is cleared so a key
// path left in the environment isn't picked up instead.
if (process.env.GRAFFITICODE_CREDENTIALS) {
  console.warn('GRAFFITICODE_CREDENTIALS is no longer read; using application-default credentials');
}
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "graffiticode"
});
const db = admin.firestore();

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

const PREFIX = process.argv.includes('--prefix');
const DRY_RUN = process.argv.includes('--dry-run');

async function clearOne(id: string): Promise<'deleted' | 'missing'> {
  const compileRef = db.doc(`compiles/${id}`);
  const doc = await compileRef.get();
  if (!doc.exists) return 'missing';
  if (!DRY_RUN) await compileRef.delete();
  return 'deleted';
}

// Highest code point Firestore sorts into a document id — the standard
// "every id starting with this prefix" upper bound.
const PREFIX_END = "\uf8ff";

/**
 * A task's compiles are stored under the id chain that produced them — the bare
 * taskId, and `taskId+dataId` for every distinct form state that was compiled.
 * The docs carry no lang, so clearing a language means a document-id prefix
 * sweep from each of its taskIds. Returns how many records were removed.
 */
async function clearPrefix(prefix: string): Promise<number> {
  const snap = await db.collection('compiles')
    .orderBy(admin.firestore.FieldPath.documentId())
    .startAt(prefix)
    .endAt(prefix + PREFIX_END)
    .get();
  if (snap.empty) return 0;
  if (!DRY_RUN) await Promise.all(snap.docs.map(d => d.ref.delete()));
  return snap.size;
}

async function main() {
  // taskIds from args, plus any newline-separated ids piped on stdin (single-process batch)
  const ids = [
    ...process.argv.slice(2).filter(a => !a.startsWith('--')),
    ...(await readStdin()).split('\n'),
  ].map(s => s.trim()).filter(Boolean);

  if (ids.length === 0) {
    console.log('Usage: npx tsx scripts/clear-compile.ts [--prefix] [--dry-run] <taskId> [taskId ...]');
    console.log('   or: <source of ids> | npx tsx scripts/clear-compile.ts [--prefix]');
    console.log('  taskId: The compile record ID (e.g., eyJ0YXNrSWRzIjpbIk11OXFvMU81N29Ta0cwcXF4U3BXIl19)');
    console.log('  --prefix: treat each id as a prefix, clearing `id` and every `id+dataId` chain');
    console.log('  --dry-run: report what would be deleted, delete nothing');
    process.exit(1);
  }

  if (PREFIX) {
    let cleared = 0;
    let empty = 0;
    const batchSize = 20;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const counts = await Promise.all(batch.map(clearPrefix));
      counts.forEach(n => (n > 0 ? (cleared += n) : empty++));
      process.stdout.write(`\r${Math.min(i + batchSize, ids.length)}/${ids.length} prefixes`);
    }
    console.log(
      `\n${DRY_RUN ? 'Would delete' : 'Done. Deleted'}: ${cleared} compile records ` +
      `from ${ids.length} prefixes (${empty} with none)`,
    );
    return;
  }

  let deleted = 0;
  let missing = 0;
  const batchSize = 20;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(clearOne));
    results.forEach(r => (r === 'deleted' ? deleted++ : missing++));
    if (ids.length > 1) process.stdout.write(`\r${deleted + missing}/${ids.length}`);
  }

  if (ids.length === 1) {
    console.log(missing
      ? `Compile record not found: ${ids[0]}`
      : `${DRY_RUN ? 'Would delete' : 'Deleted'} compile record: ${ids[0]}`);
    if (missing) process.exit(1);
  } else {
    console.log(`\nDone. ${DRY_RUN ? 'Would delete' : 'Deleted'}: ${deleted}, Not found: ${missing}`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
