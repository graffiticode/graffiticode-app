#!/usr/bin/env node

/**
 * Seed users/{uid}/versions from history that already exists on items.
 *
 * Going forward, versions are recorded server-side whenever an item's taskId
 * changes (recordVersion() in src/pages/api/resolvers.ts). This script recovers
 * what came before: the help transcript happens to record a taskId per chat
 * turn, so those turns become version records, and the item's current taskId
 * becomes the newest one.
 *
 * Note what this can NOT recover: versions produced by editing code directly in
 * the editor never touched help, so they were already lost. That gap is exactly
 * why versions are now recorded explicitly.
 *
 * Version doc ids are deterministic (`${itemId}__${taskId}`), so this is
 * idempotent — re-running writes nothing new.
 *
 *   npx tsx scripts/backfill-item-versions.ts [--lang 0166] [--dry-run] [--uid <uid>]
 */

import admin from 'firebase-admin';

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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: { lang?: string; uid?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang') opts.lang = args[++i];
    else if (args[i] === '--uid') opts.uid = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
    }
  }
  return opts;
}

// Chat turns carry the taskId they produced. System notes (from shareItem) do
// too, but they describe someone else's task — skip them.
function taskIdsFromHelp(help: unknown): { taskId: string; createdAt: number | null }[] {
  let entries: any = help;
  for (let i = 0; i < 2 && typeof entries === 'string'; i++) {
    try {
      entries = JSON.parse(entries || '[]');
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  const out: { taskId: string; createdAt: number | null }[] = [];
  for (const entry of entries) {
    if (!entry || entry.type !== 'user' || typeof entry.taskId !== 'string') continue;
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
    out.push({ taskId: entry.taskId, createdAt: Number.isFinite(ts) ? ts : null });
  }
  return out;
}

async function main() {
  const { lang, uid, dryRun } = parseArgs();
  console.log(
    `Backfilling item versions${lang ? ` for lang ${lang}` : ''}${uid ? ` for uid ${uid}` : ''}` +
    `${dryRun ? ' (dry run)' : ''}...\n`
  );

  // Per-user subcollection queries, NOT a collection-group query: `lang` is only
  // indexed at COLLECTION scope, and adding a COLLECTION_GROUP exemption just for
  // a one-time script isn't worth it.
  const userRefs = uid
    ? [db.doc(`users/${uid}`)]
    : await db.collection('users').listDocuments();

  console.log(`Scanning ${userRefs.length} user(s)...`);

  let itemsSeen = 0;
  let versionsWritten = 0;
  let itemsWithoutTask = 0;

  const itemDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const userRef of userRefs) {
    let query = userRef.collection('items') as FirebaseFirestore.Query;
    if (lang) query = query.where('lang', '==', lang);
    const snap = await query.get();
    itemDocs.push(...snap.docs);
  }

  for (const doc of itemDocs) {
    const data = doc.data();
    // users/{uid}/items/{itemId} — the uid is the grandparent of the doc.
    const ownerUid = doc.ref.parent.parent?.id;
    if (!ownerUid) continue;
    // Free-plan items expire on their own; don't seed history for them.
    if (data.freePlan) continue;
    itemsSeen++;

    const upstreamLangs = Array.isArray(data.upstreamLangs) ? data.upstreamLangs : [];
    const seen = new Set<string>();
    const records: { taskId: string; createdAt: number; source: string }[] = [];

    for (const { taskId, createdAt } of taskIdsFromHelp(data.help)) {
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      records.push({
        taskId,
        createdAt: createdAt ?? Number(data.created) ?? Date.now(),
        source: 'backfill',
      });
    }

    // The item's live taskId is the newest version — and for items with no help
    // (or help without task ids) it's the only one we can recover.
    if (typeof data.taskId === 'string' && data.taskId && !seen.has(data.taskId)) {
      seen.add(data.taskId);
      records.push({
        taskId: data.taskId,
        createdAt: Number(data.updated) || Number(data.created) || Date.now(),
        source: 'backfill',
      });
    }

    if (!records.length) {
      itemsWithoutTask++;
      continue;
    }

    for (const record of records) {
      const versionRef = db.doc(
        `users/${ownerUid}/versions/${doc.id}__${record.taskId}`
      );
      if (dryRun) {
        versionsWritten++;
        continue;
      }
      // create-if-absent: never clobber a record written by the live path.
      const existing = await versionRef.get();
      if (existing.exists) continue;
      await versionRef.set({
        itemId: doc.id,
        taskId: record.taskId,
        lang: data.lang,
        upstreamLangs,
        langs: [data.lang, ...upstreamLangs],
        name: data.name ?? null,
        mark: data.mark ?? null,
        client: data.client ?? 'console',
        source: record.source,
        createdAt: record.createdAt,
      });
      versionsWritten++;
    }
  }

  console.log(`Items scanned:            ${itemsSeen}`);
  console.log(`Items with no taskId:     ${itemsWithoutTask}`);
  console.log(`Versions ${dryRun ? 'that would be written' : 'written'}: ${versionsWritten}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
