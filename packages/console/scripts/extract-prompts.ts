#!/usr/bin/env node

/**
 * Script to extract prompts from language examples in the language repo.
 *
 * Outputs a JSON file with the prompts for review and processing.
 *
 * Usage:
 *   npx tsx scripts/extract-prompts.ts [options]
 *
 * Options:
 *   --lang <code>     Language code (default: 0176)
 *   --output <path>   Output file path (default: training/data/{lang}-prompts.json)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readExamplesMarkdown } from "./lang-examples";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Prompt {
  id: string;
  exampleNumber: number;
  prompt: string;
}

// Parse command line arguments
const args = process.argv.slice(2);

const langCode = args.includes("--lang")
  ? args[args.indexOf("--lang") + 1]
  : "0176";

const outputPath = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : `training/data/${langCode}-prompts.json`;

/**
 * Extract examples from markdown file in the language repo
 */
function extractPrompts(content: string, lang: string): Prompt[] {
  const prompts: Prompt[] = [];

  // Split by lines and extract numbered prompts
  const lines = content.split("\n");
  let exampleCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Match numbered lines: "1. Create a ...", "2. Create a ...", etc.
    const match = trimmed.match(/^(\d+[a-z]?)\.\s+(.+)$/);
    if (match) {
      exampleCount++;
      const prompt = match[2];

      prompts.push({
        id: `${lang}-example-${exampleCount}`,
        exampleNumber: exampleCount,
        prompt,
      });
    }
  }

  return prompts;
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

  const prompts = extractPrompts(examplesMd, langCode);

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write results to file
  fs.writeFileSync(outputPath, JSON.stringify(prompts, null, 2));

  console.log(`✓ Extracted ${prompts.length} prompts to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
