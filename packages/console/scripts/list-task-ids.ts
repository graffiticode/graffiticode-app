/**
 * list-task-ids.ts — emit the taskId of every stored item of a given language.
 *
 * Exists to feed `clear-compile.ts --prefix`, which lives in the OTHER Firestore
 * project: items are in graffiticode-app (GRAFFITICODE_APP_CREDENTIALS), compile
 * records are in graffiticode (the operator's application-default credentials).
 * The two use different credentials, which is why this is a pipe rather than one script.
 *
 * Ids go to stdout, one per line, so the pipe stays clean; everything else to stderr.
 *
 * Usage:
 *   npx tsx scripts/list-task-ids.ts --lang 0176
 *   npx tsx scripts/list-task-ids.ts --lang 0176 --uid <uid>
 *   npx tsx scripts/list-task-ids.ts --lang 0176 | npx tsx scripts/clear-compile.ts --prefix
 *
 * Requires: GRAFFITICODE_APP_CREDENTIALS (prod Firestore).
 */
import "./eval-env"; // MUST be first: prod Firestore bootstrap

import { getFirestore } from "../src/utils/db";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const LANG = arg("lang");
const UID = arg("uid");

async function main() {
  if (!LANG) {
    console.error("Usage: npx tsx scripts/list-task-ids.ts --lang <nnnn> [--uid <uid>]");
    process.exit(1);
  }
  const db = getFirestore();
  const taskIds = new Set<string>();
  let scanned = 0;

  const collect = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
    for (const d of docs) {
      scanned++;
      const taskId = (d.data() as any).taskId;
      // Shared items and items whose first compile never landed have no taskId,
      // so there is no compile record to clear (see getItems in resolvers.ts).
      if (typeof taskId === "string" && taskId) taskIds.add(taskId);
    }
  };

  if (UID) {
    const snap = await db.collection(`users/${UID}/items`).where("lang", "==", LANG).get();
    collect(snap.docs);
  } else {
    try {
      const snap = await db.collectionGroup("items").where("lang", "==", LANG).get();
      collect(snap.docs);
    } catch (err: any) {
      // A collection-group query on `lang` needs its own index, which may not
      // exist. Walking users one at a time uses the per-collection index that
      // the console's own queries already rely on.
      if (err?.code !== 9 && !/FAILED_PRECONDITION|requires an index/i.test(String(err?.message))) {
        throw err;
      }
      console.error("[list-task-ids] no collection-group index; sweeping users individually");
      const users = await db.collection("users").listDocuments();
      for (const user of users) {
        const snap = await user.collection("items").where("lang", "==", LANG).get();
        collect(snap.docs);
      }
    }
  }

  for (const id of taskIds) process.stdout.write(id + "\n");
  console.error(`L${LANG}: ${scanned} items scanned, ${taskIds.size} distinct taskIds`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
