#!/usr/bin/env node
/**
 * Convert plain-array `embedding` fields to Firestore vectors.
 *
 * findNearest only matches vector-typed fields, so a document whose embedding is
 * stored as a plain array is invisible to vector search. The 2026-09-28 run of
 * generate-embeddings-from-examples.ts wrote arrays for every language it touched
 * (L0000, L0169-L0183), which emptied retrieval for them without any error.
 *
 * This rewrites only the `embedding` field, reusing the stored numbers — no
 * re-embedding, no OpenAI calls. Documents already holding a vector are skipped.
 * Dry run by default.
 *
 * Usage:
 *   npx tsx scripts/fix-embedding-vectors.ts [--apply] [--lang 0179]
 *                                            [--collection training_examples]
 *
 * Requires GRAFFITICODE_APP_CREDENTIALS (or ADC) with write access to graffiticode-app.
 */

import admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (process.env.GRAFFITICODE_APP_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
}

const args = process.argv.slice(2);
const argValue = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const apply = args.includes("--apply");
const lang = argValue("--lang");
const collection = argValue("--collection") || "training_examples";

// Not the 500-write cap but transaction size: each doc carries 1536 floats plus
// its vector-index entries, and 400 per batch failed with "Transaction too big".
const BATCH_SIZE = 50;

async function main() {
  admin.initializeApp({ projectId: "graffiticode-app" });
  const db = admin.firestore();

  let query: FirebaseFirestore.Query = db.collection(collection);
  if (lang) query = query.where("lang", "==", lang);
  const snap = await query.select("lang", "embedding").get();

  const toFix: Array<{ ref: FirebaseFirestore.DocumentReference; values: number[] }> = [];
  const byLang: Record<string, { array: number; vector: number; none: number }> = {};
  for (const doc of snap.docs) {
    const embedding = doc.get("embedding");
    const l = doc.get("lang") ?? "?";
    const counts = (byLang[l] ??= { array: 0, vector: 0, none: 0 });
    if (Array.isArray(embedding)) {
      counts.array++;
      toFix.push({ ref: doc.ref, values: embedding });
    } else if (embedding == null) {
      counts.none++;
    } else {
      counts.vector++;
    }
  }

  console.log(`${collection}${lang ? ` lang=${lang}` : ""}: ${snap.size} docs`);
  for (const [l, c] of Object.entries(byLang).sort()) {
    console.log(`  ${l}  array=${c.array} vector=${c.vector} none=${c.none}`);
  }

  if (!apply) {
    console.log(`\nDry run: ${toFix.length} docs would be converted. Re-run with --apply.`);
    return;
  }

  let written = 0;
  for (let i = 0; i < toFix.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, values } of toFix.slice(i, i + BATCH_SIZE)) {
      batch.update(ref, { embedding: FieldValue.vector(values) });
    }
    await batch.commit();
    written += Math.min(BATCH_SIZE, toFix.length - i);
    console.log(`  converted ${written}/${toFix.length}`);
  }
  console.log(`\nDone: ${written} docs converted.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
