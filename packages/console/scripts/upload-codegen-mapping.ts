#!/usr/bin/env node

/**
 * Script to upload generated code mappings to Firestore as training items.
 *
 * This script:
 * 1. Reads a codegen mapping file (training/data/{lang}-codegen-mapping.json)
 * 2. Optionally deletes existing items for the language/mark (--refresh)
 * 3. Uploads each item with the example id and generated code
 * 4. Tags items with the specified mark value
 *
 * Usage:
 *   npx tsx scripts/upload-codegen-mapping.ts --lang <code> --mark <number> [options]
 *
 * Required:
 *   --lang <code>         Language code (required)
 *   --mark <number>       Mark to assign (required)
 *
 * Options:
 *   --user <uid>          User ID to upload items to (default: EVAL_UID)
 *   --input <path>        Input mapping file (default: training/data/{lang}-codegen-mapping.json)
 *   --refresh             Delete existing items of same lang/mark before uploading
 *   --dry-run             Show what would be uploaded without uploading
 *   --limit <number>      Upload only first N items (default: all)
 *   --start <index>       Start from example index (default: 0)
 */

import "./eval-env"; // Production bootstrap (MUST be first)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);

const langStr = args.includes("--lang")
  ? args[args.indexOf("--lang") + 1]
  : null;

const markStr = args.includes("--mark")
  ? args[args.indexOf("--mark") + 1]
  : null;

if (!langStr || !markStr) {
  console.error("Error: --lang and --mark parameters are required");
  console.error("Usage: npx tsx scripts/upload-codegen-mapping.ts --lang <code> --mark <number> [options]");
  process.exit(1);
}

const langCode = langStr;
const mark = parseInt(markStr);

const userIdParam = args.includes("--user")
  ? args[args.indexOf("--user") + 1]
  : null;

const inputPath = args.includes("--input")
  ? args[args.indexOf("--input") + 1]
  : `training/data/${langCode}-codegen-mapping.json`;

const refresh = args.includes("--refresh");
const dryRun = args.includes("--dry-run");
const limit = args.includes("--limit")
  ? parseInt(args[args.indexOf("--limit") + 1])
  : Infinity;
const startIdx = args.includes("--start")
  ? parseInt(args[args.indexOf("--start") + 1])
  : 0;

interface CodeGenResult {
  id: string;
  exampleNumber: number;
  prompt: string;
  generatedCode: string;
  compiled: boolean;
  fixAttempts: number;
  cost: number;
  taskId: string | null;
  verification: any;
  timestamp: string;
  error?: string;
}

/**
 * Delete existing mark items for the language
 */
async function deleteExistingItems(db: admin.firestore.Firestore, userId: string, lang: string, markValue: number): Promise<number> {
  console.log(`Querying existing L${lang} items with mark=${markValue} for user ${userId}...`);

  // Query for items with matching lang and mark in user's collection
  const query = db
    .collection("users")
    .doc(userId)
    .collection("items")
    .where("lang", "==", lang)
    .where("mark", "==", markValue);

  const snapshot = await query.get();
  let deleted = 0;

  console.log(`Found ${snapshot.size} existing items to delete`);

  for (const doc of snapshot.docs) {
    if (!dryRun) {
      await doc.ref.delete();
    }
    deleted++;
  }

  return deleted;
}

/**
 * Upload a single item
 */
async function uploadItem(
  db: admin.firestore.Firestore,
  userId: string,
  result: CodeGenResult,
  lang: string,
  markValue: number
): Promise<boolean> {
  const itemId = result.id;
  const paddedExample = String(result.exampleNumber).padStart(3, '0');
  const itemName = paddedExample;

  const itemData = {
    id: itemId,
    name: itemName,
    lang,
    mark: markValue,
    prompt: result.prompt,
    src: result.generatedCode,
    compiled: result.compiled,
    taskId: result.taskId,
    cost: result.cost,
    fixAttempts: result.fixAttempts,
    createdAt: new Date(result.timestamp),
    updatedAt: admin.firestore.Timestamp.now(),
    // Metadata
    source: "codegen-mapping",
    exampleNumber: result.exampleNumber,
    app: "console",
  };

  if (!dryRun) {
    await db
      .collection("users")
      .doc(userId)
      .collection("items")
      .doc(itemId)
      .set(itemData, { merge: false });
  }

  return true;
}

/**
 * Main execution
 */
async function main() {
  // Initialize Firebase if not already initialized
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: "graffiticode-app",
      credential: admin.credential.applicationDefault(),
    });
  }

  // Get Firestore instance
  const db = admin.firestore();

  console.log(`Uploading codegen mapping for L${langCode} with mark=${mark}`);
  console.log(`Input file: ${inputPath}`);

  // Read mapping file
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Mapping file not found: ${inputPath}`);
    process.exit(1);
  }

  const mappingContent = fs.readFileSync(inputPath, "utf-8");
  const allResults: CodeGenResult[] = JSON.parse(mappingContent);
  const results = allResults.slice(startIdx, Math.min(startIdx + limit, allResults.length));

  console.log(`Loaded ${allResults.length} results, processing ${results.length}${dryRun ? " (dry run)" : ""}`);

  // Get user ID
  const userId = userIdParam || process.env.GC_API_KEY_UID;
  if (!userId) {
    console.error("Error: --user parameter required or GC_API_KEY_UID environment variable not set");
    process.exit(1);
  }

  console.log(`Uploading to user: ${userId}`);

  // Step 1: Optionally delete existing items
  if (refresh) {
    const deleted = await deleteExistingItems(db, userId, langCode, mark);
    console.log(`${dryRun ? "[DRY RUN] Would delete" : "Deleted"} ${deleted} existing items`);
  }

  // Step 2: Upload items
  let uploadedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    process.stdout.write(`[${i + 1}/${results.length}] Uploading ${result.id}... `);

    try {
      await uploadItem(db, userId, result, langCode, mark);
      console.log("✓");
      uploadedCount++;
    } catch (error: any) {
      console.log(`✗ Error: ${error.message}`);
      failedCount++;
    }
  }

  console.log(`\n✓ Complete`);
  console.log(`Uploaded: ${uploadedCount}, Failed: ${failedCount} out of ${results.length}`);
  if (dryRun) {
    console.log("(DRY RUN - no items were actually uploaded)");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
