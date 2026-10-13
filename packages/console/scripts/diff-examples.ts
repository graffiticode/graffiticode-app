#!/usr/bin/env node
/**
 * Generate git-style diffs for specific corpus examples.
 * Fetches original AST from taskId, unparses it, regenerates fresh code, and diffs them.
 */

import "./eval-env";
import admin from "firebase-admin";
import { unparse } from "@graffiticode/parser";
import { generateCodeForRequest } from "../src/lib/code-generation/generate-for-request";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { getApiTask, getLanguageLexicon } from "../src/lib/api";

const EVAL_UID = "2c9d72e315fbafb128011bc32739666c7e6e7eb9";

interface Example {
  lang: string;
  exampleNumber: number;
}

const EXAMPLES: Example[] = [
  { lang: "0175", exampleNumber: 26 },
  { lang: "0175", exampleNumber: 27 },
  { lang: "0175", exampleNumber: 30 },
  { lang: "0178", exampleNumber: 17 },
  { lang: "0179", exampleNumber: 33 },
  { lang: "0181", exampleNumber: 7 },
];

function diffLines(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const result: string[] = [];

  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    const aLine = aLines[i] ?? "";
    const bLine = bLines[i] ?? "";
    if (aLine !== bLine) {
      if (aLines[i] !== undefined) result.push(`- ${aLine}`);
      if (bLines[i] !== undefined) result.push(`+ ${bLine}`);
    } else {
      result.push(`  ${aLine}`);
    }
  }
  return result.join("\n");
}

/**
 * Fetch AST for a taskId and unparse it to source code
 */
async function getSourceFromTaskId(
  taskId: string,
  lang: string,
  auth: { token: string }
): Promise<string> {
  // Get the AST from the API (pass composite ID directly, API will decode)
  const apiTask = await getApiTask({ auth, id: taskId });
  // API returns array for composite IDs
  const taskList = Array.isArray(apiTask) ? apiTask : [apiTask];
  const taskData = taskList[0] || apiTask;
  if (!taskData || !taskData.code) {
    throw new Error(`No code found for taskId ${taskId}`);
  }

  // Parse the code if it's a string
  const code = typeof taskData.code === "string"
    ? JSON.parse(taskData.code)
    : taskData.code;

  // Get lexicon for unparsing
  const lexicon = await getLanguageLexicon(lang, auth.token);

  // Unparse AST to source
  return unparse(code, lexicon || {});
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: "graffiticode-app",
      credential: admin.credential.applicationDefault(),
    });
  }
  const db = admin.firestore();

  const gcApiKey = process.env.EVAL_API_KEY || process.env.GC_API_KEY_SECRET;
  if (!gcApiKey) {
    console.error("Error: EVAL_API_KEY or GC_API_KEY_SECRET not set");
    process.exit(1);
  }

  const credentials = await getCredentialsForApiKey(gcApiKey);
  const auth = { token: credentials.idToken, uid: credentials.uid };

  for (const ex of EXAMPLES) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`L${ex.lang} Example ${ex.exampleNumber}`);
    console.log("=".repeat(60));

    // Fetch original item
    const snap = await db
      .collection("users")
      .doc(EVAL_UID)
      .collection("items")
      .where("lang", "==", ex.lang)
      .where("exampleNumber", "==", ex.exampleNumber)
      .limit(1)
      .get();

    if (snap.empty) {
      console.log("  (not found in corpus)");
      continue;
    }

    const doc = snap.docs[0];
    const data = doc.data();
    const taskId = data.taskId || "";
    const prompt = data.prompt || "";

    if (!prompt) {
      console.log("  (no prompt found)");
      continue;
    }

    if (!taskId) {
      console.log("  (no taskId found)");
      continue;
    }

    console.log(`Prompt: ${prompt.substring(0, 100)}...`);
    console.log(`TaskId: ${taskId.substring(0, 50)}...`);
    console.log("");

    try {
      // Get original source by unparsing the AST from taskId
      const originalSrc = await getSourceFromTaskId(taskId, ex.lang, auth);

      // Regenerate fresh code
      const result = await generateCodeForRequest({
        auth,
        prompt,
        language: ex.lang,
        options: { maxTokens: 4096 },
        currentSrc: null,
        currentData: null,
        itemId: `diff-test-${ex.lang}-${ex.exampleNumber}`,
      });

      if (!result.taskId) {
        console.log("  Error: generation returned no taskId");
        continue;
      }

      // Get fresh source by unparsing AST from taskId (same as baseline)
      const freshSrc = await getSourceFromTaskId(result.taskId, ex.lang, auth);

      if (originalSrc.trim() === freshSrc.trim()) {
        console.log("  [MATCH] No differences");
      } else {
        console.log("--- original (from taskId AST)");
        console.log("+++ fresh (regenerated)");
        console.log(diffLines(originalSrc, freshSrc));
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
