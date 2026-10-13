/**
 * Generate a usage-guide.md file for a Graffiticode language.
 *
 * Reads examples.md (natural language prompts) and spec.md (vocabulary reference)
 * from the language's spec directory, sends them to an LLM, and writes a
 * usage-guide.md that describes what the language can do and how to ask for it
 * — entirely in domain terms, with no DSL code.
 *
 * Usage:
 *   npx tsx scripts/generate-usage-guide.ts <language-id> [--spec-dir <path>]
 *
 * Examples:
 *   npx tsx scripts/generate-usage-guide.ts 0169
 *   npx tsx scripts/generate-usage-guide.ts 0166 --spec-dir /path/to/l0166/packages/api/spec
 *
 * Environment:
 *   OPENAI_API_KEY — Required. Used for the LLM call.
 *   USAGE_GUIDE_MODEL — Optional. Model to use (default: gpt-4o).
 */

import fs from "fs";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// --- CLI argument parsing ---

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help")) {
  console.log(`
Usage: npx tsx scripts/generate-usage-guide.ts <language-id> [options]

Arguments:
  language-id              Numeric language ID (e.g., 0169, 0166)

Options:
  --spec-dir <path>        Path to the language's spec directory.
                           Default: ../l<id>/packages/api/spec
  --output <path>          Output file path. Default: <spec-dir>/usage-guide.md
  --model <model>          LLM model to use (default: gpt-4o)
  --dry-run                Print the prompt without calling the LLM
  --help                   Show this help message

Examples:
  npx tsx scripts/generate-usage-guide.ts 0169
  npx tsx scripts/generate-usage-guide.ts 0166 --spec-dir ../l0166/packages/api/spec
  npx tsx scripts/generate-usage-guide.ts 0169 --dry-run
`);
  process.exit(0);
}

const languageId = args[0].replace(/^L/i, "");
const langLabel = `L${languageId}`;

// Resolve spec directory
const defaultSpecDir = path.resolve(
  process.cwd(),
  `../l${languageId}/packages/api/spec`
);
const specDir = args.includes("--spec-dir")
  ? path.resolve(args[args.indexOf("--spec-dir") + 1])
  : defaultSpecDir;

// Resolve output path
const outputPath = args.includes("--output")
  ? path.resolve(args[args.indexOf("--output") + 1])
  : path.join(specDir, "usage-guide.md");

// Model selection
const model = args.includes("--model")
  ? args[args.indexOf("--model") + 1]
  : process.env.USAGE_GUIDE_MODEL || "gpt-4o";

const dryRun = args.includes("--dry-run");

// --- Read source files ---

function readFile(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: ${label} not found at ${filePath}`);
    process.exit(1);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  console.log(`Read ${label}: ${filePath} (${content.length} chars)`);
  return content;
}

const examplesPath = path.join(specDir, "examples.md");
const specPath = path.join(specDir, "spec.md");

const examplesContent = readFile(examplesPath, "examples.md");
const specContent = readFile(specPath, "spec.md");

// --- Build the prompt ---

const systemPrompt = `You are a technical writer creating a usage guide for a Graffiticode language. Your audience is AI agents and human users who will describe what they want to create in natural language using the Graffiticode MCP tool or console.

Your output must:
1. Be written entirely in domain terms — what the user can CREATE, not how the code works
2. Contain ZERO DSL code, function signatures, or syntax examples
3. Organize capabilities by user intent (what someone would want to accomplish)
4. Include 2-4 natural language example requests per capability section, drawn from the training examples
5. Explain what the language CAN and CANNOT do
6. Include a section on iterating (using update_item to refine)
7. End with cross-references to other Graffiticode languages for things this language can't do
8. Begin with a brief overview of what the language creates and how to access it (MCP tool and console)
9. Include the CC-BY-4.0 SPDX license identifier as an HTML comment on the first line

The guide should read as: "Here is everything you can ask ${langLabel} to do, with examples of how to phrase your requests."

Do NOT include:
- Code blocks showing DSL syntax
- Function names or signatures from the spec
- Implementation details about how the compiler works
- References to instructions.md (that is internal)`;

const userPrompt = `Generate a usage-guide.md for ${langLabel}.

Here are the source materials:

## Training Examples (examples.md)
These are 161+ natural language prompts organized by capability category. Use these as the basis for the example requests in the guide. Consolidate and rephrase — don't include all 161.

${examplesContent}

## Vocabulary Specification (spec.md)
This describes what the language can express. Use this to understand capabilities, but do NOT reproduce code examples or function signatures in the output.

${specContent}

Generate the complete usage-guide.md now.`;

// --- Call the LLM ---

async function main() {
  if (dryRun) {
    console.log("\n=== SYSTEM PROMPT ===\n");
    console.log(systemPrompt);
    console.log("\n=== USER PROMPT (first 2000 chars) ===\n");
    console.log(userPrompt.slice(0, 2000) + "\n...[truncated]");
    console.log(`\nTotal prompt length: ~${(systemPrompt.length + userPrompt.length).toLocaleString()} chars`);
    console.log(`Output would be written to: ${outputPath}`);
    process.exit(0);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  const openai = new OpenAI();

  console.log(`\nGenerating usage guide for ${langLabel}...`);
  console.log(`Model: ${model}`);
  console.log(`Output: ${outputPath}`);

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 8000,
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      console.error("Error: No content returned from LLM");
      process.exit(1);
    }

    // Ensure the output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, content, "utf-8");

    console.log(`\nUsage guide written to: ${outputPath}`);
    console.log(`Length: ${content.length} chars, ~${content.split("\n").length} lines`);
    console.log(
      `Tokens used: ${response.usage?.prompt_tokens} prompt + ${response.usage?.completion_tokens} completion`
    );
  } catch (error) {
    console.error("Error calling LLM:", error);
    process.exit(1);
  }
}

main();
