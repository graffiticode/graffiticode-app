#!/usr/bin/env node

/**
 * Script to run code generation over language examples from the language repo and create a mapping file.
 *
 * This script:
 * 1. Extracts prompts from the language's examples.md (served asset, or a local checkout —
 *    see scripts/lang-examples.ts)
 * 2. Runs code generation on each prompt using the code-generation-service
 * 3. Creates a mapping file in training/data/{lang}-codegen-mapping.json with results
 *
 * Usage:
 *   npx tsx scripts/run-codegen-0176.ts [options]
 *
 * Options:
 *   --lang <code>        Language code (default: 0176)
 *   --limit <number>     Maximum number of examples to process (default: all)
 *   --output <path>      Output file path (default: training/data/{lang}-codegen-mapping.json)
 *   --start <index>      Start processing from example index (default: 0)
 *   --dry-run            Print extracted prompts without running code gen
 */

import "./eval-env"; // Production bootstrap (MUST be first)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readExamplesMarkdown } from "./lang-examples";
import { generateCode } from "../src/lib/code-generation-service";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);

const langCode = args.includes("--lang")
  ? args[args.indexOf("--lang") + 1]
  : "0176";

const limit = args.includes("--limit")
  ? parseInt(args[args.indexOf("--limit") + 1])
  : Infinity;

const outputPath = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : `training/data/${langCode}-codegen-mapping.json`;

const startIdx = args.includes("--start")
  ? parseInt(args[args.indexOf("--start") + 1])
  : 0;

const dryRun = args.includes("--dry-run");

interface TrainingExample {
  id: string;
  prompt: string;
  exampleNumber: number;
}

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
 * Extract examples from markdown file in the language repo
 */
function extractExamples(content: string): TrainingExample[] {
  const examples: TrainingExample[] = [];

  // Split by lines and extract numbered prompts
  const lines = content.split("\n");
  let exampleCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Match numbered lines: "1. Create a ...", "2. Create a ...", etc.
    const match = trimmed.match(/^(\d+[a-z]?)\.\s+(.+)$/);
    if (match) {
      exampleCount++;
      const numberStr = match[1];
      const prompt = match[2];

      examples.push({
        id: `0176-example-${exampleCount}`,
        prompt,
        exampleNumber: exampleCount,
      });
    }
  }

  return examples;
}

/**
 * Normalize code by replacing any lrn-id value with example.id
 */
function normalizeCode(code: string, exampleId: string): string {
  return code.replace(
    /set-var "lrn-id" (?:"[^"]*"|get-val-public "[^"]*")/g,
    `set-var "lrn-id" "${exampleId}"`
  );
}

/**
 * Run code generation on a single example
 */
async function generateCodeForExample(
  example: TrainingExample,
  auth: any,
  lang: string
): Promise<CodeGenResult> {
  try {
    const result = await generateCode({
      auth,
      prompt: example.prompt,
      lang,
      itemId: example.id,
      options: {
        maxTokens: 4096,
      },
      rid: `test-${example.id}`,
    });

    const compiled = !!result.taskId && !!result.code;
    const normalizedCode = normalizeCode(result.code || "", example.id);

    return {
      id: example.id,
      exampleNumber: example.exampleNumber,
      prompt: example.prompt,
      generatedCode: normalizedCode,
      compiled,
      fixAttempts: result.fixAttempts || 0,
      cost: result.cost || 0,
      taskId: result.taskId || null,
      verification: result.verification,
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      id: example.id,
      exampleNumber: example.exampleNumber,
      prompt: example.prompt,
      generatedCode: "",
      compiled: false,
      fixAttempts: 0,
      cost: 0,
      timestamp: new Date().toISOString(),
      error: error.message || String(error),
    };
  }
}

/**
 * Main execution
 */
async function main() {
  let examplesMd: string;
  try {
    examplesMd = (await readExamplesMarkdown(langCode)).text;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const examples = extractExamples(examplesMd);
  const slice = examples.slice(startIdx, Math.min(startIdx + limit, examples.length));

  console.log(`Extracted ${examples.length} examples, processing ${slice.length}${dryRun ? " (dry run)" : ""}`);

  if (dryRun) {
    console.log("\nExtracted prompts:");
    slice.forEach((ex) => {
      console.log(`\n[${ex.exampleNumber}] ${ex.id}:`);
      console.log(`  ${ex.prompt}`);
    });
    return;
  }

  // Get authentication from EVAL_API_KEY (dedicated eval account)
  const gcApiKey = process.env.EVAL_API_KEY;
  if (!gcApiKey) {
    console.error("Error: EVAL_API_KEY environment variable not set");
    process.exit(1);
  }

  let credentials: any;
  try {
    credentials = await getCredentialsForApiKey(gcApiKey);
  } catch (error: any) {
    console.error("Error getting credentials:", error.message);
    process.exit(1);
  }

  // Convert credentials to auth format: idToken becomes token
  const auth = {
    token: credentials.idToken,
    uid: credentials.uid,
  };

  const results: CodeGenResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < slice.length; i++) {
    const example = slice[i];
    process.stdout.write(
      `[${i + 1}/${slice.length}] Processing ${example.id}... `
    );

    const result = await generateCodeForExample(example, auth, langCode);
    results.push(result);

    if (result.error) {
      console.log(`ERROR: ${result.error}`);
      errorCount++;
    } else if (result.compiled) {
      console.log(`✓ Compiled`);
      successCount++;
    } else {
      console.log(`✗ Did not compile (${result.fixAttempts} fix attempts)`);
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write results to file
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  console.log(`\n✓ Mapping file written to: ${outputPath}`);
  console.log(`Summary: ${successCount} compiled, ${errorCount} errors out of ${slice.length} examples`);
  console.log(`Compilation rate: ${((successCount / slice.length) * 100).toFixed(1)}%`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
