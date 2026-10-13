/**
 * Provider-neutral code generation service
 *
 * This service implements:
 * 1. Language detection from prompts
 * 2. Provider routing and model-tier selection
 * 3. Token usage tracking
 * 4. Code verification via Graffiticode API
 * 5. LLM-assisted compile-error correction
 * 6. Retrieval of relevant examples to enhance generation accuracy
 */

import * as fs from "fs";
import * as path from "path";
import { postApiCompile, getLanguageAsset, getLanguageLexicon, isLangOverridden, languageOfflineMessage, isLanguageOfflineError } from "./api";
import { postTask, getData, parseCode } from "../pages/api/resolvers";
import admin from "firebase-admin";
import { ragLog, generateRequestId } from "./logger";
import {
  generateEmbedding,
  createEmbeddingText,
  vectorSearch,
  hybridSearch,
} from "./embedding-service";
import {
  generateCodeWithContinuation,
  SystemBlock,
} from "./llm-generation-service";
import {
  CLAUDE_MODELS,
  GenerationTier,
  LanguageGenerationPolicy,
  modelForProvider,
  modelRejectsTemperature,
  parseLanguageGenerationPolicy,
  resolveGenerationRoute,
} from "./llm-models";
import { modeTierFor } from "./model-priority";
import {
  type RequestBudget,
  BUDGET_ERROR_CODE,
  budgetSummary,
  exhausted,
  tripped,
} from "./request-budget";
import { safeRAGAnalytics } from "./rag-analytics-safe";
import { findBestLanguages } from "./language-router";
import { stripQueryPassage, queryFacets } from "./lang-embedding";
import { getRAGConfig, withRAGFallback, getJudgeMode } from "./rag-config";
import { judgeCode } from "./judge-service";
import { ragAnalytics } from "./rag-analytics";
import { parser } from "@graffiticode/parser";
import {
  compilePromptSpec,
  compileRepairPromptSpec,
  buildContextPack,
  classifyCompilerError,
  parseStructuredErrors,
  isDSPyEnabled,
  shouldFallbackToLegacy,
  ConversationSummary,
  RetrievedChunk,
} from "./dspy-service";
import {
  renderPromptSpecToMessages,
  convertLegacyPromptToRendered,
  formatPromptSpecForLog,
  RenderContext,
} from "./prompt-renderer";
import { checkBurstLimit } from "./free-plan-throttle";
import { recordSpend } from "./free-plan-quota";
import { estimateUsdCost } from "./model-pricing";
import { FreePlanError, buildSignupUrl } from "./free-plan-context";
import { recordTokenUsage, Stage } from "./token-usage-service";

// Sentinel itemId injected during code-generation verification. Side-effecting
// dialects MUST treat a compile whose itemId (e.g. L0158's `lrn-id`) equals this
// value as a DRY RUN: validate the program but skip external writes and the
// credential gates that guard them, since verification runs without the user's
// account credentials. Mirrored by VERIFY_ITEM_ID in the L0158 compiler.
export const VERIFY_ITEM_ID = "verify-itemid";

const MIN_FREE_PLAN_PROMPT = 20;
// Caps the prompt the MCP server sends — a windowed dialog (last ~6 user turns +
// the new request), with the current source and system instructions excluded.
// It is NOT a cap on a single description: an iterating session accumulates here.
const MAX_FREE_PLAN_PROMPT = 10000;

// Global cache for language assets with TTL
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const languageAssetsCache = {
  instructions: new Map<
    string,
    {
      value: string;
      generationPolicy: LanguageGenerationPolicy;
      expires: number;
    }
  >(),
  templates: new Map<string, string>(),
};

// Preserve the existing imports used by the router and spec generator.
export { CLAUDE_MODELS, modelRejectsTemperature };

/**
 * Max output tokens per generation chunk.
 *
 * This sizes the ANSWER, and it is not a latency dial. On Sonnet 5 thinking is on
 * by default (nothing here sends `thinking`, and adaptive is the default), the
 * thinking tokens are billed inside `output_tokens`, and `max_tokens` caps thinking
 * PLUS the response text. So this number decides whether a turn that thinks for a
 * while still has room left to write the program.
 *
 * 16384 rather than 8192, reversing 2026-09-09. That change halved the ceiling to
 * bound the DURATION of a silent chunk (~150s to ~80s at ~100 tok/s), which it did.
 * But the zero-output failure it was aimed at is the thinking phase exhausting this
 * budget before the text block opens — `out=<cap> chars=0 stop=max_tokens`, where
 * `out` is always exactly the cap — so lowering the cap makes that MORE likely, not
 * less. Measured on one L0179-shaped prompt, 3 runs per cell, effort at the API
 * default:
 *
 *   cap=2048   first text [14390ms, never, never]   chars [826, 0, 0]   zero-output 2/3
 *   cap=8192   first text [11900, 16863, 15816ms]   chars [2770, 2228, 1347]  zero-output 0/3
 *
 * Same arm, same prompt: the smaller cap is the failure. Duration belongs to the
 * watchdogs that already own it — firstTokenMs() before the first content token,
 * turnBudgetMs() after it, and the request deadline over the whole run — none of
 * which need this number to be small.
 *
 * The lever that actually shortens the thinking phase is `effort` (low/medium cut
 * time-to-first-text from ~12-17s to ~1-1.8s in the same trials, for equal or more
 * code). It is deliberately NOT set here: the 2026-09-04 corpus sweep found global
 * `low` broke 3 of 18 stably-matching prompts and `medium` 2, with zero
 * improvements, so moving it is an `npm run eval` decision, not a default.
 *
 * Keep this ABOVE the per-chunk ceiling in CODEGEN_MAX_OUTPUT_TOKENS_TOTAL — see the
 * note there; a total below one chunk silently disables the continuation loop.
 */
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * Upper bound on a client-supplied `maxTokens`. 64k is 4x the server default
 * and above any model's practical single-response output, so it bounds abuse
 * without capping legitimate long programs.
 */
export const MAX_CLIENT_MAX_TOKENS = 65536;

/**
 * Always returns Graffiticode as the language
 * @param {string} prompt - User's input prompt (ignored)
 * @returns {string} Always returns "graffiticode"
 */
function detectLanguage(prompt) {
  // Always return Graffiticode regardless of prompt content
  return "graffiticode";
}

/**
 * Get Firestore database reference with initialization check
 * @returns {FirebaseFirestore.Firestore} Firestore database instance
 */
function getFirestoreDb() {
  // Get existing Firestore instance or initialize if needed
  try {
    return admin.firestore();
  } catch (error) {
    // If admin isn't initialized, initialize it
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    return admin.firestore();
  }
}

/**
 * Parse markdown training examples file into structured data
 * @param {string} markdownContent - Content of the markdown file
 * @returns {Array} Array of parsed examples
 */
function parseMarkdownExamples(markdownContent) {
  try {
    const examples = [];
    // Split the content by sections
    const sections = markdownContent.split("---");

    for (const section of sections) {
      if (!section.trim()) continue;

      // Extract prompt and code from each section
      const promptMatch = section.match(/###\s*Prompt\s*\n"([^"]+)"/);
      const codeBlockMatch = section.match(
        /###\s*Code\s*\n\s*```\s*\n([\s\S]+?)\n\s*```/,
      );

      // Fall back to older format if needed
      const taskMatch =
        !promptMatch && section.match(/###\s*Task\s*\n"([^"]+)"/);
      const codeMatch =
        !codeBlockMatch &&
        section.match(/###\s*Graffiticode\s*\n([\s\S]+?)(?=\n\n|$)/);

      if (promptMatch && codeBlockMatch) {
        // New format
        examples.push({
          task: promptMatch[1].trim(),
          code: codeBlockMatch[1].trim(),
          // Create a messages array for compatibility with existing code
          messages: [
            { role: "user", content: promptMatch[1].trim() },
            {
              role: "assistant",
              content: `\`\`\`\n${codeBlockMatch[1].trim()}\n\`\`\``,
            },
          ],
        });
      } else if (taskMatch && codeMatch) {
        // Old format
        examples.push({
          task: taskMatch[1].trim(),
          code: codeMatch[1].trim(),
          // Create a messages array for compatibility with existing code
          messages: [
            { role: "user", content: taskMatch[1].trim() },
            {
              role: "assistant",
              content: `\`\`\`\n${codeMatch[1].trim()}\n\`\`\``,
            },
          ],
        });
      }
    }

    return examples;
  } catch (error) {
    console.error("Error parsing markdown examples:", error);
    return [];
  }
}

export function extractSearchQuery(prompt: string, lang?: string): string {
  const marker = "Now, please address this new request:\n";
  const idx = prompt.lastIndexOf(marker);
  let query = prompt;
  if (idx !== -1) {
    const latest = prompt.substring(idx + marker.length).trim();
    if (latest.length > 0) query = latest;
  }
  // For passage-bearing languages, strip the reading passage so the query vector lands in the same
  // (passage-free) space as the stored document vectors. No-op for languages without a hook.
  return stripQueryPassage(lang, query);
}

export async function getRelevantExamples({ prompt, lang, limit = 3, rid = null }) {
  // Extract just the latest user request for retrieval so conversation
  // context doesn't dilute the embedding similarity (and strip the reading passage for hooked langs).
  const searchQuery = extractSearchQuery(prompt, lang);
  // Best-effort design facets from the live prompt — used as a filter/boost during re-ranking.
  const facets = queryFacets(lang, searchQuery);

  try {
    if (rid) {
      ragLog(rid, "retrieval.start", {
        query: searchQuery.substring(0, 100),
        fullPromptLength: prompt.length,
        lang,
        k: limit,
        mode: "hybrid",
      });
    }

    const db = getFirestoreDb();

    // Try vector search first
    try {
      // Use hybrid search for better results
      const results = await hybridSearch({
        collection: "training_examples",
        query: searchQuery,
        limit: limit,
        lang: lang,
        db: db,
        rid: rid,  // Pass the request ID for analytics tracking
        vectorWeight: 0.7, // Balance between semantic and keyword matching
        facets, // Query-time facet filter/boost for hooked langs (e.g. L0175 target)
      });

      if (results && results.length > 0) {
        // Filter out low-quality matches — with a specific DSL, bad examples
        // are worse than no examples since the prompt already has detailed instructions.
        const MIN_COMBINED_SCORE = 0.50;
        const filteredResults = results.filter(doc => (doc.combinedScore || doc.similarity || 0) >= MIN_COMBINED_SCORE);

        // Transform the results to match the expected format
        const transformedResults = filteredResults.map(doc => {
          // The new format has these fields: lang, prompt, code, messages, tags, etc.
          return {
            task: doc.prompt || doc.task,
            code: doc.code,
            messages: doc.messages || [
              { role: "user", content: doc.prompt },
              { role: "assistant", content: `\`\`\`\n${doc.code}\n\`\`\`` }
            ],
            description: doc.prompt || doc.description,
            tags: doc.tags || [],
            expectedValues: doc.expectedValues || [],
            // Include scoring information
            similarity: doc.similarity,
            keywordScore: doc.keywordScore,
            combinedScore: doc.combinedScore,
            // Which path produced the example. The keyword fallback below hides a
            // dead vector search (2026-09-28: array embeddings, 14 languages), so
            // analytics and the corpus ping need to tell the two apart.
            retrievalSource: "vector" as const,
          };
        });

        if (rid) {
          ragLog(rid, "retrieval.result", {
            mode: "hybrid",
            k: limit,
            lang,
            resultCount: transformedResults.length,
            ids: results.map((r) => r.id || r.prompt?.substring(0, 50)),
            scores: results.map((r) => ({
              similarity: r.similarity,
              keywordScore: r.keywordScore,
              combinedScore: r.combinedScore,
            })),
          });
        }

        return transformedResults;
      }
    } catch (vectorError) {
      console.warn(
        "Vector search failed, falling back to keyword search:",
        vectorError.message,
      );

      if (rid) {
        ragLog(rid, "retrieval.fallback", {
          reason: vectorError.message,
          mode: "keyword",
        });
      }
    }

    // Fallback to keyword-based search if vector search fails or returns no results
    // Import local training data from markdown format only (fs/path imported at top —
    // inline require() breaks under ESM runners like tsx).
    let examples = [];

    // Load the markdown file from local /training directory
    const mdFilePath = path.join(
      process.cwd(),
      `./training/l${lang}-training-examples.md`,
    );

    if (fs.existsSync(mdFilePath)) {
      // Read and parse the markdown file
      const markdownContent = fs.readFileSync(mdFilePath, "utf8");
      examples = parseMarkdownExamples(markdownContent);
    } else {
      console.warn(`No training examples file found for L${lang}`);
      return [];
    }

    // Simple keyword matching to find relevant examples
    const keywords = prompt
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    // Score examples based on keyword matches
    const scoredExamples = examples.map((example) => {
      // For markdown examples, search through task and code
      let textToSearch = "";

      if (example.task) {
        // For markdown format
        textToSearch = (example.task + " " + example.code).toLowerCase();
      } else if (example.messages) {
        // For dialog-based examples
        textToSearch = example.messages
          .map((m) => m.content)
          .join(" ")
          .toLowerCase();
      } else {
        // Fallback for other formats
        textToSearch = (example.description || "").toLowerCase();
      }

      const score = keywords.reduce((sum, keyword) => {
        return sum + (textToSearch.includes(keyword) ? 1 : 0);
      }, 0);

      return { ...example, score };
    });

    const topExamples = scoredExamples
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (rid) {
      ragLog(rid, "retrieval.result", {
        mode: "keyword",
        k: limit,
        lang,
        resultCount: topExamples.length,
        ids: topExamples.map(
          (e) => e.task?.substring(0, 50) || e.description?.substring(0, 50),
        ),
        scores: topExamples.map((e) => ({ keywordScore: e.score })),
      });
    }

    return topExamples.map((e) => ({ ...e, retrievalSource: "keyword" as const }));
  } catch (error) {
    console.error("Error retrieving training examples:", error);

    if (rid) {
      ragLog(rid, "retrieval.error", {
        error: error.message,
      });
    }

    // Fallback to returning empty array if there's an error
    return [];
  }
}


/**
 * Reads dialect-specific instructions from the language server with caching
 * @param {string} lang - The language/dialect ID (e.g., "0002", "0159")
 * @returns {Promise<string>} - The dialect-specific instructions, or empty string if none found
 */
async function readDialectAssets(
  lang,
  accessToken?: string,
): Promise<{
  value: string;
  generationPolicy: LanguageGenerationPolicy;
}> {
  const cacheKey = `L${lang}`;
  // When this language is overridden for the caller the fetch is redirected to a
  // test revision, so bypass the shared (lang-keyed) instructions cache on read
  // and write. Non-overridden languages keep using the shared cache.
  const overridden = await isLangOverridden(lang, accessToken);
  const cached = !overridden && languageAssetsCache.instructions.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached;
  }

  try {
    const instructions = await getLanguageAsset(`L${lang}`, 'instructions.md', accessToken);
    // Routing directives are private configuration and must never enter the
    // prompt. The legacy gc:model=opus directive maps to the quality tier.
    const { cleaned, policy: generationPolicy } =
      parseLanguageGenerationPolicy(instructions || "");
    const value = cleaned ? `\n${cleaned}\n` : "";
    const entry = {
      value,
      generationPolicy,
      expires: Date.now() + CACHE_TTL_MS,
    };
    if (!overridden) {
      languageAssetsCache.instructions.set(cacheKey, entry);
    }
    return entry;
  } catch (error) {
    console.error(`Error fetching dialect instructions from language server for L${lang}:`, error);
    const entry = {
      value: "",
      generationPolicy: {},
      expires: Date.now() + CACHE_TTL_MS,
    };
    if (!overridden) {
      languageAssetsCache.instructions.set(cacheKey, entry);
    }
    return entry;
  }
}

export async function readDialectInstructions(lang, accessToken?: string): Promise<string> {
  return (await readDialectAssets(lang, accessToken)).value;
}

// Provider/tier preference declared by a dialect's instructions. Shares the
// cached instructions fetch, so this adds no extra language-service request.
async function readDialectGenerationPolicy(
  lang,
  accessToken?: string,
): Promise<LanguageGenerationPolicy> {
  return (await readDialectAssets(lang, accessToken)).generationPolicy;
}

// Static tail of the dialect system prompt — language-independent. Concatenated
// onto the per-dialect block so a single text section carries everything stable
// per-language; one cache_control breakpoint then caches the whole prefix.
const DIALECT_PROMPT_STATIC_TAIL = `
## Response Requirements
- **IMPORTANT**: When current code is provided in the context, treat it as the starting point and make only the necessary incremental changes requested by the user. Preserve existing data, formatting, and structure unless specifically asked to modify them.

## Core Syntax Rules
- Use \`let name = value..\` for declarations
- All functions are prefix notation: \`add 1 2\` (no infix allowed)
- Lambdas use angle brackets: \`<x y: expr>\`
- CRITICAL: ONLY use \`..\` (double dots) to terminate \`let\` declarations and the program
- CRITICAL: EVERY program MUST have zero or more let declarations followed by JUST ONE expression ending with \`..\`
- Use parentheses to pass functions or delay application: \`map (double) [1 2 3]\`
- Whitespace separates tokens; commas and parens are optional but allowed
- Static types are inferred; no type annotations
- No mutation; all data is immutable
- Function calls with too few arguments return a partially applied function (currying)

## Built-in Types
- **Numbers**: \`42\`, \`-3.14\`
- **Strings**: \`"hello"\` or multiline with \`'hello,\nworld!'\`;
  - Quotes inside strings should NEVER be escaped
  - For nested quotes, use different quote types: \`"He said 'hello'"\` or \`'She said "goodbye"'\`
  - Supports interpolation: \` \\\`hello, \${name}!\\\` \`
  - IMPORTANT: A literal backslash inside a string must be written DOUBLED — "\\times", "\\(", "\\frac{1}{2}". A single backslash is read as an escape, so "\times" is a TAB and "\frac" is a formfeed
  - IMPORTANT: Write real newlines; never emit the two characters \n as a stand-in
- **Booleans**: \`true\`, \`false\`; **Null**: \`null\`
- **Lists**: \`[1 2 3]\`; support pattern matching
- **Records**: \`{name: "Alice" age: 30}\`; access via \`get\`, support destructuring
- **Tags**: The \`tag\` keyword constructs a tag value: \`tag red\`, \`tag blue\`. Use \`let\` to bind a tag to a name like any other value: \`let x = tag medium..\`

## Pattern Matching
Use \`case\` for match expressions:
\`\`\`
case x of
  tag red: "red"
  tag blue: "blue"
  _: "unknown"
end
\`\`\`

Supports destructuring for lists \`[x, rest]\` and records \`{name}\`. Wildcard \`_\` matches anything.

## Control Flow
Use \`if condition then expr1 else expr2\`. Always return a value.

## Functions
- All functions have fixed arity
- Functions can be anonymous or assigned to \`let\`
- Recursion is allowed

## Comments
Block comments: \`/* comment */\`

## Built-In Functions

### Arithmetic
\`add\`, \`sub\`, \`mul\`, \`div\`, \`mod\`

### Comparison
\`eq\`, \`ne\`, \`lt\`, \`le\`, \`gt\`, \`ge\`

### List Ops
\`hd\`, \`tl\`, \`last\`, \`isEmpty\`, \`nth\`, \`take\`, \`drop\`, \`range\`, \`filter\`, \`map\`, \`reduce\`

### Record/List Access
\`get\`, \`set\`

### Output
\`print\`

Only return idiomatic, valid Graffiticode. Use readable names. Output **only the code** unless explanation is requested.

CRITICAL REMINDER: Put generated code between \`\`\` (triple backticks) to distinguish code from commentary.`;

/**
 * Returns the appropriate system prompt blocks for a given dialect.
 *
 * Returns structured system blocks so Anthropic can retain a
 * `cache_control: ephemeral` breakpoint. OpenAI receives the same block text
 * flattened into Responses API instructions.
 * Within a language the entire prefix is stable across requests, so one
 * breakpoint at the end of the per-dialect block caches the whole thing.
 *
 * @param {string} lang - The language/dialect ID (e.g., "0002", "0159")
 * @returns {Promise<SystemBlock[]>} - System content blocks ready for /v1/messages
 */
async function getSystemPromptForDialect(lang: string, accessToken?: string): Promise<SystemBlock[]> {
  // Preamble: small, lang-interpolated. Combined into the cached block below
  // since (preamble + dialect + tail) is stable for a given language.
  const preamble = `
You are a programming assistant that translates natural language into code written in a functional DSL called **Graffiticode**, specifically dialect L${lang}.

Graffiticode is designed for end-user programming. Its syntax is simple, functional, and punctuation-light. Use only the language features below.`;

  // Big, lang-stable block fetched from the language server (TTL-cached locally).
  const fileInstructions = await readDialectInstructions(lang, accessToken);

  // Out-of-scope clause references the dialect ID so it lives with the
  // per-language prefix rather than the static tail.
  const outOfScope = `
## Out-of-Scope Detection
If the user's request is clearly outside the capabilities of this dialect (L${lang}), do NOT generate code. Instead, respond with ONLY:
OUT_OF_SCOPE: <one sentence explaining what this dialect does and why the request doesn't fit>
When in doubt, attempt to generate code. Only use OUT_OF_SCOPE when you are confident the request cannot be fulfilled.`;

  const dialectBlock = (preamble + (fileInstructions || "") + outOfScope + DIALECT_PROMPT_STATIC_TAIL).trim();

  return [
    {
      type: "text",
      text: dialectBlock,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * Create a prompt for an LLM that will generate high-quality code
 * @param {string} userPrompt - The user's original prompt
 * @param {Array} examples - Relevant examples to include
 * @param {string} lang - The language/dialect ID (e.g., "0002", "0159")
 * @param {string} currentCode - The current code (if available) to use as a starting point
 * @returns {string} - A well-formatted generation prompt
 */
/**
 * The <CURRENT_DATA> block: what the current code COMPILES TO, when the caller has it.
 *
 * Source and data are not the same information, and for some dialects the
 * difference is the whole request. L0182 names a survey and nothing else — its
 * ideas, title and bounds are fetched by the compiler from the back end — so a
 * program's own text cannot tell the model what is in the survey it takes. An
 * edit like "take the survey" was therefore unanswerable from <CURRENT_CODE>
 * alone: the generator has never seen an idea, and L0182's instructions rightly
 * forbid guessing one (a guessed position lands in range and records the wrong
 * ideas silently). Handed the compiled record, the same request is obvious.
 *
 * Only ever CONTEXT: the model edits the source, never this. Capped because a
 * compiled item can be far larger than the program that wrote it (L0176 items
 * run to tens of KB), and a truncated data model still answers "what is in here?".
 */
const MAX_CURRENT_DATA_CHARS = 6000;

function renderCurrentDataSection(currentData: unknown): string {
  if (currentData == null) return "";
  let rendered: string;
  try {
    rendered = JSON.stringify(currentData, null, 2) ?? "";
  } catch {
    // A compiled record that will not serialize (a cycle) is context we can do
    // without — never a reason to fail the generation it was decorating.
    return "";
  }
  if (!rendered) return "";
  const clipped = rendered.length > MAX_CURRENT_DATA_CHARS
    ? rendered.slice(0, MAX_CURRENT_DATA_CHARS) + "\n… (truncated)"
    : rendered;
  return `\n<CURRENT_DATA>
What the current code compiles to. This is context to read, not code to edit — the program to change is <CURRENT_CODE> above. Values that live here rather than in the source (a set the compiler fetched, say) are visible to you ONLY here, so name them exactly as they appear.
\`\`\`json
${clipped}
\`\`\`
`;
}

async function createCodeGenerationPrompt(
  userPrompt,
  examples = [],
  lang = "0000",
  currentCode = null,
  rid = null,
  conversationSummary = null,
  upstreamContext: { lang: string; sample?: unknown } | null = null,
  accessToken?: string,
  currentData: unknown = null,
  downstreamContext: { lang: string; src: string } | null = null,
) {
  // Dialect-specific blocks (cached per-language). The dialect block already
  // carries cache_control: ephemeral, so the per-language prefix is reused
  // across requests within the 5-minute Anthropic cache window.
  const dialectBlocks = await getSystemPromptForDialect(lang, accessToken);

  // Developer instructions are static across all languages and all calls.
  // Adding a second cache breakpoint extends the cached prefix to include
  // them — both blocks together get reused on subsequent requests.
  const developerInstructions = `
## APPROACH

1. **Analyze the request** carefully to understand what the user wants
2. **Review any existing code** to understand the current state
3. **Plan minimal changes** that accomplish the goal without over-engineering
4. **Generate valid Graffiticode** that compiles successfully
5. **Preserve existing structure** unless explicitly asked to change it

## GUIDELINES

- Keep solutions simple and focused on the request
- Don't add features beyond what was asked
- Use meaningful variable names
- Add comments only where logic isn't self-evident
- Ensure all \`let\` statements end with \`..\`
- Ensure the program ends with \`..\``.trim();

  const systemBlocks: SystemBlock[] = [
    ...dialectBlocks,
    {
      type: "text",
      text: developerInstructions,
      cache_control: { type: "ephemeral" },
    },
  ];

  const systemPromptCharCount = systemBlocks.reduce((sum, b) => sum + b.text.length, 0);

  // Format retrieved examples for context
  const retrievedContext = examples.length > 0
    ? examples.map((ex, i) => {
        if (ex.task && ex.code) {
          return `Example ${i + 1}: ${ex.task}\n\`\`\`\n${ex.code}\n\`\`\``;
        }
        return "";
      }).filter(Boolean).join("\n\n")
    : "No similar examples found.";

  // Format conversation summary
  const conversationContext = conversationSummary
    ? `Turn ${conversationSummary.turnCount || 1} of conversation.${
        conversationSummary.previousRequests?.length
          ? " Previously: " + conversationSummary.previousRequests.slice(-3).join("; ")
          : ""
      }`
    : "First turn of conversation.";

  // Composition: when this program sits above an upstream stage in a pipeline,
  // tell the model the upstream's dialect and a concrete sample of the data
  // model it produces, so the head authors `data use "<lang>"` against real
  // fields rather than guessing the shape.
  const upstreamSection = upstreamContext
    ? `\n<UPSTREAM_DATA_MODEL>
This program is one stage of a composition pipeline. At runtime it consumes a data model produced by an upstream Graffiticode program written in dialect L${upstreamContext.lang}. Bind to that upstream with \`data use "${upstreamContext.lang}"\`.${
        upstreamContext.sample != null
          ? ` The upstream produces data shaped like:\n\`\`\`json\n${JSON.stringify(upstreamContext.sample, null, 2).slice(0, 2000)}\n\`\`\``
          : ""
      }
`
    : "";

  // The reverse: this program is an UPSTREAM, and the head that reads its output has already
  // been generated. Show it that program, so the field names it produces are the ones the head
  // reads. Without this the two are generated independently from the same request and agree
  // only by luck — an L0184 chart reading `columns ["region" "revenue"]` from an L0185 program
  // that named its total "amount" fails to compile. A section of its own, not text in the
  // request, so retrieval and the request-language checks still see only the user's words.
  const downstreamSection = downstreamContext
    ? `\n<DOWNSTREAM_CONSUMER>
This program is an upstream stage of a composition pipeline. At runtime its output is read by the L${downstreamContext.lang} program below, which binds it with \`data use\`. Where that program reads named fields of this output (for example a dataset's \`columns\`), produce those fields with exactly those names. Author only this program, as the request asks; the consumer is shown for the names it reads, not to be copied.
\`\`\`
${downstreamContext.src.slice(0, 3000)}
\`\`\`
`
    : "";

  const currentDataSection = renderCurrentDataSection(currentData);

  // Build user message using USER_TEMPLATE format (matches dspy-service)
  const userMessage = `<USER_REQUEST>
${userPrompt}

<CURRENT_CODE>
${currentCode ? `\`\`\`\n${currentCode}\n\`\`\`` : "No existing code."}
${currentDataSection}
<CONVERSATION_SUMMARY>
${conversationContext}

<RETRIEVED_CONTEXT>
${retrievedContext}

When a retrieved example closely matches the user's request, follow its coding patterns and techniques. If there is existing current code, apply the example's patterns to the current code rather than replacing it.
${upstreamSection}${downstreamSection}
<OUTPUT_FORMAT>
Emit the Graffiticode between triple backticks, must end with "..". Then on new lines emit two tagged summary blocks:

<DESCRIPTION>One sentence describing what the code does.</DESCRIPTION>
<CHANGE_SUMMARY>One sentence describing what changed from the previous version — content, scoring, theme, metadata, tags. Skip formatting, whitespace, and internal plumbing. Output exactly "Initial code" when there is no previous version. Output exactly "Saved; no content changes" for save-only operations that write to a backing store without changing the authored content.</CHANGE_SUMMARY>`;

  if (rid) {
    ragLog(rid, "prompt.build", {
      dialect: `L${lang}`,
      examplesIncluded: examples.length,
      tokenEstimate: Math.ceil(
        (systemPromptCharCount + userMessage.length) / 4,
      ),
      charCount: systemPromptCharCount + userMessage.length,
      hasCurrentCode: !!currentCode,
      hasCurrentData: !!currentDataSection,
      hasConversationSummary: !!conversationSummary,
      sectionsIncluded: ["system", "developer", "user"],
      systemBlockCount: systemBlocks.length,
    });
  }

  const promptData = {
    system: systemBlocks,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  };

  return JSON.stringify(promptData, null, 2);
}

/**
 * Verify the generated code using the Graffiticode API
 * @param {string} code - The generated code to verify
 * @param {string} accessToken - Authentication token for the API
 * @returns {Promise<Object>} - Compilation results including any errors
 */
async function verifyCode(code, authToken, lang, rid = null, isPublic = false) {

  const startTime = Date.now();

  if (rid) {
    ragLog(rid, "verification.start", {
      codeLength: code.length,
    });
  }

  try {
    // Parse first to catch syntax errors before posting
    // Inject the verification sentinel itemId so dialects that read
    // `get-val-public "itemId"` (e.g. L0158's `set-var "lrn-id"`) compile cleanly
    // during verification AND treat it as a dry run — skipping side-effecting
    // writes (e.g. save-to-itembank) and their credential gates, since the user's
    // account credentials aren't injected here. The real itemId + credentials are
    // substituted by the resolver's parseCode before the saved task is posted, so
    // this placeholder never reaches storage and the real compile does the write.
    const parseResult = await parseCode({ lang, src: code, publicValues: { itemId: VERIFY_ITEM_ID } });
    if (parseResult.errors) {
      if (rid) {
        ragLog(rid, "verification.parse_error", {
          errors: parseResult.errors,
          latency: Date.now() - startTime,
        });
      }
      return {
        status: "error",
        error: {
          message: parseResult.errors.map(e => e.message).join("; "),
        },
        errors: parseResult.errors,
        data: null,
      };
    }

    // Post the parsed AST
    const task = { lang, code: JSON.parse(parseResult.code) };
    let id;
    try {
      const result = await postTask({
        auth: { token: authToken },
        task,
        ephemeral: true,
        // Free-plan tasks (head + composition upstream segments) are posted
        // public so the auth-less MCP widget iframe can render them by taskId.
        isPublic,
      });
      id = result?.id;
    } catch (postError) {
      console.error("postTask() ERROR", postError);
      if (isLanguageOfflineError(postError)) {
        return {
          status: "error",
          error: { message: languageOfflineMessage(lang), statusCode: postError.statusCode || 503 },
          data: null,
        };
      }
      return {
        status: "error",
        error: {
          message: `Failed to post task: ${postError.message || 'Internal Server Error'}`,
          statusCode: postError.statusCode || 500
        },
        data: null,
      };
    }

    if (!id) {
      return {
        status: "error",
        error: { message: "No task ID returned from postTask" },
        data: null,
      };
    }

    const compileResponse = await getData({ authToken, id });
    // Check if the response indicates an error but doesn't have a standardized error format
    if (compileResponse.status === "error" && !compileResponse.error) {
      // Provide a standardized error object
      compileResponse.error = {
        message: "Compilation failed",
        details: compileResponse.data?.errors || "Unknown error",
      };
    }

    // Check for specific error patterns in the response data
    if (/*compileResponse.status === "success" &&*/ compileResponse.data) {
      // Sometimes errors are embedded in the data object
      if (
        compileResponse.data.errors &&
        compileResponse.data.errors.length > 0
      ) {
        compileResponse.status = "error";
        compileResponse.errors = {
          message: "Compilation succeeded but found errors in code",
          details: compileResponse.data.errors,
        };
      }
    }
    if (rid) {
      ragLog(rid, "verification.complete", {
        status: compileResponse.status,
        hasErrors:
          !!compileResponse.errors || compileResponse.status === "error",
        errorSummary: compileResponse.errors
          ? JSON.stringify(compileResponse.errors).substring(0, 300)
          : null,
        latency: Date.now() - startTime,
      });
    }

    compileResponse.taskId = id;
    return compileResponse;
  } catch (error) {
    console.error("Error verifying Graffiticode:", error);

    if (rid) {
      ragLog(rid, "verification.error", {
        error: error.message,
        latency: Date.now() - startTime,
      });
    }

    return {
      status: "error",
      error: { message: isLanguageOfflineError(error) ? languageOfflineMessage(lang) : error.message },
      data: null,
    };
  }
}

// A verification result is a success when there's no error object, the status
// isn't "error", and the errors field is empty. Critically, `getData` returns
// `{ data, errors: [] }` with NO `status` field on success — so checking
// `status === "success"` never matched, and an empty `errors: []` array is
// truthy, which made the fix loop run wasted repair rounds on already-compiled
// code. Treat an empty errors array (or none) as success.
function verificationSucceeded(vr: any): boolean {
  if (!vr) return false;
  if (vr.error) return false;
  if (vr.status === "error") return false;
  const e = vr.errors;
  if (Array.isArray(e)) return e.length === 0;
  return !e;
}

/**
 * Render a list of compiler errors as the text a repair turn reads.
 */
function formatErrorList(errors) {
  return errors
    .map((err) => {
      if (typeof err === "string") {
        return err;
      }

      let errMsg = "";

      if (err.message) {
        errMsg += err.message;
      }

      if (err.line) {
        errMsg += ` at line ${err.line}`;
      }

      if (err.col) {
        errMsg += `, column ${err.col}`;
      }

      if (err.expected) {
        errMsg += `\nExpected: ${err.expected}`;
      }

      if (err.found) {
        errMsg += `\nFound: ${err.found}`;
      }

      return errMsg;
    })
    .join("\n\n");
}

/**
 * Parse error information from Graffiticode compilation results
 * @param {Object} errorInfo - Error information from the API
 * @returns {string} - Formatted error details
 */
function parseGraffiticodeErrors(errorInfo) {
  let formattedErrors = "";

  // Handle different error formats. The FIRST shape here is the one a real
  // compile failure arrives in: the language server answers
  // `{ data: null, errors: [...] }` and getData hands that envelope straight
  // back. Without this branch it fell through to the JSON.stringify catch-all,
  // and the repair turn got a serialized blob where the error messages belong.
  if (Array.isArray(errorInfo.errors) && errorInfo.errors.length > 0) {
    formattedErrors = formatErrorList(errorInfo.errors);
  } else if (errorInfo.error && errorInfo.error.message) {
    formattedErrors = errorInfo.error.message;
  } else if (errorInfo.data && errorInfo.data.errors) {
    // Extract and format each error
    const errors = Array.isArray(errorInfo.data.errors)
      ? errorInfo.data.errors
      : [errorInfo.data.errors];

    formattedErrors = formatErrorList(errors);
  } else if (typeof errorInfo === "string") {
    formattedErrors = errorInfo;
  } else {
    formattedErrors = JSON.stringify(errorInfo, null, 2);
  }

  return formattedErrors;
}

/**
 * Build the user turn that reports compile errors back to the model as a
 * continuation of the original conversation. Unlike createErrorFixPrompt this
 * carries no code or system primer — the errant code is appended separately as
 * the assistant turn, and the dialect rules already live in the original system
 * prompt.
 * @param {Object} errorInfo - Information about the errors from compilation
 * @returns {string} - The user-turn content asking for a fix
 */
function buildErrorFeedback(errorInfo) {
  const formattedErrors = parseGraffiticodeErrors(errorInfo);
  return `The code you just produced failed to compile with these errors:\n\n${formattedErrors}\n\nFix them and return the complete corrected program in a single code block.`;
}

/**
 * Create a prompt for an LLM to fix code based on compilation errors
 * @param {string} code - The original code that had errors
 * @param {Object} errorInfo - Information about the errors from compilation
 * @returns {string} - A prompt for fixing the code
 */
function createErrorFixPrompt(code, errorInfo) {
  // Parse and format the error information
  const formattedErrors = parseGraffiticodeErrors(errorInfo);

  return JSON.stringify(
    {
      system: `You are an expert Graffiticode programmer tasked with fixing code errors.
Graffiticode is a minimal, prefix, expression-oriented language with these key features:
- \`let\` bindings with syntax: \`let name = value..\`
- No infix operators; use prefix calls like \`add 1 2\`
- Function application is prefix: \`fn arg1 arg2\`
- Use parentheses to control application order: \`map (double) [1 2 3]\`
- Anonymous lambdas use angle brackets: \`<x y: expr>\`
- Lists: \`[1 2 3]\`
- Records: \`{ name: "Alice" age: 30 }\`
- Access via \`get\`, \`nth\`, \`hd\`, \`tl\`, etc.
- Conditionals use \`if condition then x else y\`
- Includes built-in functions: \`map\`, \`filter\`, \`reduce\`
- Recursion is common; loops are not used
- Whitespace separates tokens; no commas required
- Block comments: \`/* comment */\`
- IMPORTANT: All let statements MUST end with a double dot (..)
- IMPORTANT: A literal backslash inside a string must be written DOUBLED — "\\times", "\\(", "\\frac{1}{2}". A single backslash is read as an escape, so "\times" is a TAB and "\frac" is a formfeed
- IMPORTANT: Write real newlines; never emit the two characters \n as a stand-in
- IMPORTANT: Only generate valid Graffiticode. Avoid comments; elide any commentary

Common Graffiticode errors and solutions:
1. Missing double dot (..) at the end of a let statement
2. Missing parentheses around function references: use (functionName) not functionName
3. Incorrect function application: use prefix notation like "add x y" not "x + y"
4. Improper lambda syntax: use angle brackets like <x: body> not other formats

When fixing code:
1. Carefully analyze the error messages
2. Make minimal changes to fix the issues
3. Return ONLY the corrected code with no additional commentary
4. Ensure all code is syntactically valid
5. Avoid comments unless essential; use /* */ for block comments`,
      messages: [
        {
          role: "user",
          content: `The following Graffiticode has compilation errors:\n\n${code}\n\nError details:\n${formattedErrors}\n\nPlease fix the code and return only the corrected version.`,
        },
      ],
    },
    null,
    2,
  );
}


/**
 * Processes generated source to fix common issues and extract only the src portion
 * @param {string} content - The content returned by the generation provider
 * @param {string} lang - The language/dialect ID (e.g., "0002", "0159")
 * @returns {Promise<string>} - The processed and reformatted src with fixes applied
 */
// Extract the <DESCRIPTION> and <CHANGE_SUMMARY> summary blocks the model is
// asked to emit after the code block. Returns { description, changeSummary }
// with either field null when the tag is absent — DSPy-rendered prompts don't
// request these tags today, so null is the expected case on that path.
function extractSummaryTags(content) {
  if (!content) return { description: null, changeSummary: null };
  const descMatch = content.match(/<DESCRIPTION>([\s\S]*?)<\/DESCRIPTION>/);
  const summaryMatch = content.match(/<CHANGE_SUMMARY>([\s\S]*?)<\/CHANGE_SUMMARY>/);
  return {
    description: descMatch ? descMatch[1].trim() : null,
    changeSummary: summaryMatch ? summaryMatch[1].trim() : null,
  };
}

/**
 * Decide whether a repair turn actually answered with a program, and return the
 * text to treat as source.
 *
 * The guard here used to be "does the response contain a ``` fence". It doesn't
 * hold: a repair is a CONTINUATION of the generation conversation, and the model
 * frequently answers by just emitting the corrected program, unfenced. Those
 * responses were discarded — measured on L0176, a repair that had correctly
 * rewritten `stimulus "What is 3 × 4?"` to `\\(3 \\times 4\\)` was thrown away,
 * the loop re-reported the identical error, and the broken program shipped.
 *
 * So test the thing the guard was really after — prose vs program — by handing
 * the body to the dialect's own parser. A chatty non-answer won't reformat; a
 * bare program will, errors and all (they're semantic, not syntactic).
 *
 * @returns the source to process, or null when the response carried no program
 */
async function fixResponseToSource(content, lang, accessToken?: string): Promise<string | null> {
  if (!content) return null;
  // Fenced: hand it back whole — processGeneratedCode extracts the block.
  if (/```[\s\S]*```/.test(content)) return content;

  const body = content
    .replace(/<DESCRIPTION>[\s\S]*?<\/DESCRIPTION>/g, "")
    .replace(/<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/g, "")
    .trim();
  if (!body) return null;

  try {
    const lexicon = await getLanguageLexicon(lang, accessToken);
    const reformatted = await parser.reformat(lang, body, lexicon, {});
    return /^\/\*\s*ERROR:/.test(reformatted) ? null : body;
  } catch {
    return null;
  }
}

/**
 * Undo the escaping a model applies when it returns its program as if it were a
 * JSON string: every backslash doubled, every newline written as a literal `\n`.
 *
 * This MUST NOT be applied to source that is already well-formed. A literal
 * backslash in a Graffiticode string is written doubled — `"\\times"` — so
 * halving it yields `"\times"`, where `\t` is an escape and the value becomes a
 * TAB. That silently destroys most LaTeX: `\times \theta \text` (\t),
 * `\frac` (\f), `\newline` (\n), `\right` (\r), `\begin \binom` (\b), `\vec` (\v).
 */
function unescapeJsonStyle(text: string): string {
  return text.replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
}

async function processGeneratedCode(content, lang = "0000", rid = null, accessToken?: string) {
  if (!content) return content;

  const originalLength = content.length;

  // Try to extract src from between triple backticks
  const codeBlockRegex = /```(?:[\w]*\n|\n)?([\s\S]*?)```/;
  const match = content.match(codeBlockRegex);

  // If we found a code block, extract it
  let src = match ? match[1].trim() : content;
  let processed = src;
  const codeBlockExtracted = !!match;

  // Try to reformat the src using the parser. Reformat is also the ORACLE for
  // the un-escape below: source the dialect's parser can read is well-formed and
  // must be left alone.
  let parsedCleanly = false;
  let recoveredByUnescape = false;
  try {
    const lexicon = await getLanguageLexicon(lang, accessToken);
    const reformatted = await parser.reformat(lang, processed, lexicon, {});

    // If reformat produced an error comment, keep the original src
    if (/^\/\*\s*ERROR:/.test(reformatted)) {
      if (rid) {
        ragLog(rid, "reformat.error", {
          error: "reformat produced error comment",
          lang: `L${lang}`,
        });
      }
      console.warn(`Failed to reformat src for L${lang}: reformat produced error comment`);
    } else {
      processed = reformatted;
      parsedCleanly = true;
      if (rid) {
        ragLog(rid, "reformat.success", {
          lang: `L${lang}`,
          lengthBefore: src.length,
          lengthAfter: processed.length,
        });
      }
    }

    // It didn't parse. The classic cause is a model that returned the program as
    // if it were a JSON string. Try that un-escape, and keep it ONLY if it is
    // what makes the program parse — never on the strength of the pattern alone.
    if (!parsedCleanly) {
      const unescaped = unescapeJsonStyle(processed);
      if (unescaped !== processed) {
        const retry = await parser.reformat(lang, unescaped, lexicon, {});
        if (!/^\/\*\s*ERROR:/.test(retry)) {
          processed = retry;
          recoveredByUnescape = true;
          if (rid) {
            ragLog(rid, "unescape.recovered", { lang: `L${lang}` });
          }
        }
      }
    }
  } catch (reformatError) {
    // If reformatting fails, log it but continue with the original src
    if (rid) {
      ragLog(rid, "reformat.error", {
        error: reformatError.message,
        lang: `L${lang}`,
      });
    }
    console.warn(`Failed to reformat src for L${lang}:`, reformatError.message);
  }

  // Last resort. This un-escape used to run unconditionally, and it was the
  // single largest source of broken LaTeX in generated items: the model wrote
  // the correct `"\\times"`, this halved it to `"\\t..."` — a TAB — and the
  // compiler then reported a raw \t that the model had never written. Worse, the
  // repair loop could not win: the compiler's own message says "write every
  // backslash doubled", the model complied, and this undid it again, so every
  // attempt produced the identical error.
  //
  // Now it only runs when the parser could neither read the source nor be
  // consulted (no lexicon, reformat threw) — where the old blind behavior is
  // still the best guess available.
  if (!parsedCleanly && !recoveredByUnescape) {
    processed = unescapeJsonStyle(processed);
  }

  if (rid) {
    ragLog(rid, "postprocess", {
      codeBlockExtracted,
      parsedCleanly,
      recoveredByUnescape,
      lengthBefore: originalLength,
      lengthAfter: processed.length,
    });
  }

  return processed;
}

/**
 * Generate code, verify it, and fix if needed, using relevant examples
 * @param {Object} params - Parameters for code generation
 * @param {string} params.prompt - The user's prompt
 * @param {Object} params.language - The target language object (e.g. {id: 2, name: "L0002"})
 * @param {Object} params.options - Options for the API call
 * @param {Object} params.auth - Authentication object containing token for verification
 * @returns {Promise<Object>} - The final code response
 */
interface GenerateCodeOptions {
  // INTERNAL ONLY — no GraphQL field maps to `tier` or `model`. The eval harness
  // (scripts/model-eval.ts) calls generateCode() in-process and uses them to pin a
  // single model so it measures one variable; a client cannot reach them, which is
  // what keeps model choice a server decision.
  tier?: GenerationTier;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxContinuations?: number;  // Max number of continuation chunks (default: 10)
  /**
   * Live progress sink: called with the RUNNING TOTAL of visible characters as
   * they stream, across continuation chunks and repairs.
   *
   * Declared on this type, not just on StreamOptions, because the options bag is
   * rebuilt field-by-field on the way down — an unnamed field is dropped with no
   * type error, which is precisely how this went inert on its first deploy. Being
   * a distinct type is what now makes the omission a compile failure instead of a
   * silent one.
   */
  onOutput?: (writtenChars: number) => void;
  /**
   * Wall-clock deadline (epoch ms) for the WHOLE request, created once by the
   * caller (see generate-for-request.ts) and threaded through every generation
   * this request makes. Bounds the repair loop, which would otherwise multiply
   * any per-generation limit by MAX_FIX_ATTEMPTS.
   */
  deadlineAt?: number;
  /**
   * Token ceiling for the WHOLE request, threaded exactly like `deadlineAt`
   * above and for the same reason — one budget per request, not one per stage.
   * Charged in requestProvider. Callers outside a request pass
   * `unlimitedBudget()`.
   */
  budget?: RequestBudget;
  // Optional thinking/effort passthrough. Off by default (API model defaults
  // apply). Set both identically across models for a MATCHED comparison — e.g.
  // Sonnet 5 runs adaptive thinking by default while Opus 4.8 does not, so a
  // naive A/B is unfair. Applies to the initial generation call.
  thinking?: unknown;  // e.g. { type: "adaptive" } | { type: "disabled" }
  effort?: string;     // "low" | "medium" | "high" | "xhigh" | "max"
}

export async function generateCode({
  auth,
  prompt,
  lang,
  options = {},
  currentCode = null,
  currentData = null,
  rid = null,
  userId = null,
  sessionId = null,
  conversationSummary = null,
  upstreamContext = null,
  downstreamContext = null,
  precomputedExamples = null,
  itemId = null,
}: {
  auth: any;
  prompt: string;
  lang?: string;
  options?: GenerateCodeOptions;
  currentCode?: string | null;
  /**
   * What `currentCode` compiles to, when the caller already has it. Context for
   * the model, never something it edits — see the <CURRENT_DATA> block in
   * createCodeGenerationPrompt for why a dialect can need it.
   */
  currentData?: unknown;
  rid?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  conversationSummary?: ConversationSummary | null;
  upstreamContext?: { lang: string; sample?: unknown } | null;
  /** The head program that will read this upstream's output — see createCodeGenerationPrompt. */
  downstreamContext?: { lang: string; src: string } | null;
  precomputedExamples?: any[] | null;
  /**
   * The item this generation is for, when one exists. Null on a fresh create —
   * the item is created after generation returns — which is why the usage record
   * also carries the generated taskId: `users/{uid}/versions` maps that back to
   * an itemId, so cost is attributable either way.
   */
  itemId?: string | null;
}) {
  const accessToken = auth?.token;
  const isFreePlan = !!auth?.freePlan;

  if (isFreePlan) {
    const trimmed = (prompt || "").trim();
    if (trimmed.length < MIN_FREE_PLAN_PROMPT) {
      throw new FreePlanError("free_plan_description_too_short", 400, {
        error: "free_plan_description_too_short",
        message: `Please describe what you want in at least ${MIN_FREE_PLAN_PROMPT} characters.`,
      });
    }
    if (trimmed.length > MAX_FREE_PLAN_PROMPT) {
      const signupUrl = buildSignupUrl("prompt_too_long");
      // Self-contained message: only the string propagates back through the MCP
      // tool result, so the recovery paths and URL must live in the text itself.
      throw new FreePlanError("free_plan_description_too_long", 400, {
        error: "free_plan_description_too_long",
        message:
          `This request plus the recent conversation is ${trimmed.length} characters, over the ` +
          `${MAX_FREE_PLAN_PROMPT}-character free-plan limit. To continue: send a shorter request, ` +
          `or create a new item to reset the conversation, or sign in to remove the limit — ${signupUrl}`,
        limit: MAX_FREE_PLAN_PROMPT,
        length: trimmed.length,
        signup_url: signupUrl,
      });
    }
    // Runaway-loop guard only. The trial's actual budget is denominated in
    // items and enforced at item creation (assertItemCreateAllowed) and at
    // revision (assertRevisionsRemaining) — both in resolvers.ts, both anchored
    // to durable Firestore state rather than to the caller's session id.
    if (auth?.sessionNamespace) {
      await checkBurstLimit(auth.sessionNamespace);
    }
  }
  // NOTE: item-based billing gates at item CREATION (createItem /
  // startCodeGeneration), not here — generation and its iterations are free.
  // Editing an existing item runs generateCode without consuming item budget.

  // Generate request ID if not provided
  const requestId = rid || generateRequestId();

  // Clamp max output tokens into [DEFAULT_MAX_TOKENS, MAX_CLIENT_MAX_TOKENS].
  //
  // The floor: a client must not be able to request a cap so small it forces
  // large programs to chunk — continuation can corrupt or restart a long
  // program (see llm-generation-service).
  //
  // The ceiling: `maxTokens` is a client-supplied GraphQL field
  // (CodeGenerationOptions), and until this clamp existed the Math.max floor
  // let a caller name any number at all — every chunk of every repair attempt
  // of every composed stage, multiplied. A ceiling here is cheaper than
  // discovering the multiplication in a bill.
  options = {
    ...options,
    maxTokens: Math.min(
      Math.max(options.maxTokens ?? 0, DEFAULT_MAX_TOKENS),
      MAX_CLIENT_MAX_TOKENS,
    ),
  };

  // Which FAMILY serves this request comes from the language's static priority
  // list (src/lib/model-priority.ts) — never from the caller. The dialect still
  // chooses its TIER, i.e. how much model to spend within that family.
  const dialectPolicy = !options.model
    ? await readDialectGenerationPolicy(lang, accessToken)
    : {};
  let tierToUse: GenerationTier =
    options.tier || dialectPolicy.tier || "balanced";
  // create vs update straight off the arguments: a revision has currentCode, a fresh
  // authoring does not. No prompt heuristic is involved. Both resolve identically unless
  // the language's table entry declares an `update` tier.
  const generationMode = currentCode ? "update" : "create";
  let plannedRoute = resolveGenerationRoute({
    lang,
    tier: tierToUse,
    model: options.model,
    mode: generationMode,
  });
  tierToUse = plannedRoute.tier;
  let modelToUse =
    options.model ||
    modelForProvider(plannedRoute.providers[0], plannedRoute.tier);

  // Start analytics tracking with the user's latest message (not full conversation context)
  const userQuery = extractSearchQuery(prompt);
  safeRAGAnalytics.startRequest(requestId, userQuery, userId, sessionId, {
    lang,
    hasCurrentCode: !!currentCode,
    model: modelToUse,
    provider: plannedRoute.providers[0],
    tier: plannedRoute.tier,
  });

  // Tier selection best practices:
  // - balanced: default for most generation
  // - quality: complex, multi-step dialects
  // - fast: small, mechanical property updates

  try {
    const config = getRAGConfig();
    let relevantExamples = [];

    // Reuse a retrieval the caller already performed (the resolver runs the
    // head-lang retrieval once for the compose-trigger gate, then hands it back
    // here so the head code gen doesn't embed+search a second time).
    if (Array.isArray(precomputedExamples)) {
      relevantExamples = precomputedExamples;
      // The resolver ran retrieval before this request's analytics record
      // existed, so its trackRetrieval no-op'd. Record the reused examples now
      // (record is live after startRequest above) so the RAG report shows them.
      // Recorded even when EMPTY: skipping empty retrievals left no trace of the
      // 2026-09-28 outage, where every affected request simply had no retrieval
      // field and looked like it never searched.
      const usedKeywordFallback = relevantExamples.some((ex) => ex.retrievalSource === "keyword");
      safeRAGAnalytics.trackRetrieval(
        requestId,
        relevantExamples.map((ex, idx) => ({
          id: ex.id || `example-${idx}`,
          similarity: ex.similarity,
          keywordScore: ex.keywordScore,
          combinedScore: ex.combinedScore,
          prompt: ex.task || ex.description || "",
          code: ex.code,
        })),
        usedKeywordFallback ? "keyword" : "hybrid",
        0,
        0.7,
      );
      if (relevantExamples.length > 0) {
        safeRAGAnalytics.markDocumentsUsed(
          requestId,
          relevantExamples.map((ex, idx) => ex.id || `example-${idx}`),
        );
      }
    } else if (config.enableVectorSearch || config.fallbackToKeywordSearch) {
      // Start retrieval stage
      safeRAGAnalytics.startStage(requestId, "retrieval");

      try {
        // Retrieve relevant examples with timeout protection
        relevantExamples = await withRAGFallback(
          async () => {
            return await getRelevantExamples({
              prompt,
              lang,
              limit: 3,
              rid: requestId,
            });
          },
          () => {
            // Fallback: return empty array if retrieval fails completely
            console.warn(`RAG retrieval failed for request ${requestId}, continuing without examples`);
            return [];
          },
          "example_retrieval"
        );
      } catch (error) {
        // Even if withRAGFallback fails, continue without examples
        console.warn("Failed to retrieve examples, continuing without them:", error.message);
        relevantExamples = [];
      }

      // hybridSearch recorded its own (vector) result. When the keyword fallback
      // supplied the examples instead, record that, so a dead vector search shows
      // as "keyword" rather than passing for a healthy one.
      if (relevantExamples?.some((ex) => ex.retrievalSource === "keyword")) {
        safeRAGAnalytics.trackRetrieval(
          requestId,
          relevantExamples.map((ex, idx) => ({
            id: ex.id || `example-${idx}`,
            similarity: ex.similarity,
            keywordScore: ex.keywordScore,
            prompt: ex.task || ex.description || "",
            code: ex.code,
          })),
          "keyword",
          0,
        );
      }

      safeRAGAnalytics.endStage(requestId, "retrieval");

      // Mark which documents will be used
      if (relevantExamples && relevantExamples.length > 0) {
        safeRAGAnalytics.markDocumentsUsed(
          requestId,
          relevantExamples.map((ex, idx) => ex.id || `example-${idx}`)
        );
      }
    }

    // Try DSPy service for prompt construction (with fallback to legacy)
    let formattedPrompt: string;
    let usedDSPy = false;
    let promptSpecId: string | null = null;

    // Convert retrieved examples to RetrievedChunk format
    const retrievedChunks: RetrievedChunk[] = (relevantExamples || []).map((ex, idx) => ({
      id: ex.id || `example-${idx}`,
      prompt: ex.task || ex.description || "",
      code: ex.code || "",
      similarity: ex.similarity,
      keywordScore: ex.keywordScore,
      combinedScore: ex.combinedScore,
      tags: ex.tags,
    }));

    // Build context pack for DSPy
    const contextPack = buildContextPack({
      latestAsk: prompt,
      currentCode,
      conversationSummary,
      retrievedChunks,
      constraints: {
        dialect: lang,
        maxOutputTokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      },
      taskType: "codegen",
    });

    // Try DSPy service if enabled — but not for a composition stage: the context pack has no
    // place for the upstream or downstream program, so a DSPy prompt would drop exactly what
    // makes the two stages agree on field names.
    if (isDSPyEnabled() && !upstreamContext && !downstreamContext) {
      try {
        const promptSpec = await compilePromptSpec(contextPack, requestId);

        if (promptSpec) {
          // Render PromptSpec to the provider-neutral message format.
          const renderContext: RenderContext = {
            userRequest: prompt,
            currentCode,
            conversationSummary,
            retrievedChunks,
            dialect: lang,
          };

          const rendered = renderPromptSpecToMessages(promptSpec, renderContext);

          // The compiled record has no slot in the DSPy templates (they live in
          // the DSPy service, not here), so append it to the last user message
          // rather than let this path silently drop it — an update that needs the
          // data model needs it under either prompt builder.
          const dataSection = renderCurrentDataSection(currentData);
          if (dataSection) {
            for (let i = rendered.messages.length - 1; i >= 0; i--) {
              if (rendered.messages[i].role === "user") {
                rendered.messages[i] = {
                  ...rendered.messages[i],
                  content: `${rendered.messages[i].content}\n${dataSection}`,
                };
                break;
              }
            }
          }

          // Convert to legacy format for compatibility with generateCodeWithContinuation.
          // Wrap the system prompt as a single content-block with cache_control:ephemeral
          // so Anthropic can cache the prefix; OpenAI receives the same text.
          const dspySystemBlocks: SystemBlock[] = [
            {
              type: "text",
              text: rendered.systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ];
          formattedPrompt = JSON.stringify({
            system: dspySystemBlocks,
            messages: rendered.messages,
          }, null, 2);

          usedDSPy = true;
          promptSpecId = promptSpec.specId;

          if (requestId) {
            ragLog(requestId, "dspy.prompt.rendered", {
              specId: promptSpec.specId,
              version: promptSpec.version,
              messageCount: rendered.messages.length,
            });
          }
        }
      } catch (error: any) {
        console.warn("DSPy prompt compilation failed, falling back to legacy:", error.message);
        if (requestId) {
          ragLog(requestId, "dspy.prompt.fallback", {
            reason: error.message,
          });
        }
      }
    }

    // Fall back to legacy prompt construction if DSPy didn't produce a result
    if (!usedDSPy) {
      // Create a well-formatted Graffiticode prompt with dialect instructions.
      formattedPrompt = await createCodeGenerationPrompt(
        prompt,
        relevantExamples,
        lang,
        currentCode,
        rid,
        conversationSummary,
        upstreamContext,
        accessToken,
        currentData,
        downstreamContext,
      );
    }

    // Check formatted prompt for property update pattern and adjust model if needed
    if (
      !options.model &&
      !options.tier &&
      dialectPolicy.tier !== "quality"
    ) {
      try {
        // Parse the JSON formatted prompt to check the actual user content
        const promptData = JSON.parse(formattedPrompt);
        const lastUserMessage = promptData.messages[promptData.messages.length - 1];
        const userContent = lastUserMessage.content;

        // More robust detection of property updates
        // Look for property-related keywords followed by a JSON object in code blocks
        const propertiesPattern = /\b(propert(y|ies)(\s+(value|values|change|changes|update|updates))?)\b.*```json\s*[\n\s]*\{[\s\S]*?\}\s*[\n\s]*```/i;
        const hasPropertiesWithJson = propertiesPattern.test(userContent);

        // Also check for specific property update phrases
        const propertyUpdatePhrases = [
          "using these property",
          "use these property",
          "use these changed property",
          "apply these property",
          "apply property",
          "update.*property",
          "update.*using.*property",
          "property value",
          "property change",
          "property update",
          "properties value",
          "properties change",
          "properties update",
          "style.*property",
          "css.*property",
          "formatting.*property"
        ];

        const hasPropertyPhrase = propertyUpdatePhrases.some(phrase =>
          new RegExp(phrase, 'i').test(userContent)
        );

        // Check if this looks like a property update request
        let isPropertyUpdate = hasPropertiesWithJson || (hasPropertyPhrase && userContent.includes('```json'));

        if (isPropertyUpdate) {
          // Additional check: is this within a conversation context or direct?
          const hasNewRequestPattern = userContent.includes("Now, please address this new request:");

          // For property updates in conversation, check if they're in the current request
          if (hasNewRequestPattern) {
            const newRequestIndex = userContent.lastIndexOf("Now, please address this new request:");
            const afterNewRequest = userContent.substring(newRequestIndex);
            const propertyUpdateInCurrentRequest = propertiesPattern.test(afterNewRequest) ||
                                                  propertyUpdatePhrases.some(phrase =>
                                                    new RegExp(phrase, 'i').test(afterNewRequest)
                                                  );

            if (!propertyUpdateInCurrentRequest) {
              isPropertyUpdate = false;
            }
          }

          if (isPropertyUpdate) {
            // Check if current code is small enough for simple property updates
            // Haiku can handle property updates for code up to 4KB efficiently
            const currentCodeSize = currentCode ? currentCode.length : 0;

            if (currentCodeSize < 4000) {
              // Use the fast tier for property updates with code under 4KB.
              // Re-resolving with the same lang keeps the family ordering intact:
              // only the tier changes, so an OpenAI-first language downgrades to
              // gpt-5.6-luna rather than jumping families to Haiku.
              tierToUse = modeTierFor(lang, "propertyUpdate") || "fast";
              plannedRoute = resolveGenerationRoute({
                lang,
                tier: tierToUse,
                mode: "propertyUpdate",
              });
              modelToUse = modelForProvider(
                plannedRoute.providers[0],
                // Per-family override wins, same as the generation path — otherwise this
                // pre-flight estimate names a model the route will not actually use.
                plannedRoute.tierByProvider?.[plannedRoute.providers[0]] ?? plannedRoute.tier,
              );
            }
          }
        }
      } catch (e) {
        // Failed to parse formatted prompt for model selection
      }
    }

    // Size only, never content. `formattedPrompt` is the serialized {system, messages}: the
    // system half is the dialect instructions, but `messages` carries the USER'S REQUEST, so
    // dumping it logged prompts outright — which the privacy contract forbids (lengths only).
    // Size is also what this line was actually diagnostic for: a context that suddenly doubles,
    // or instructions that failed to load and left the prompt near-empty.
    console.log(
      `[code-gen] rid=${requestId} lang=L${lang} promptBytes=${formattedPrompt?.length ?? 0}`,
    );

    // Start generation stage
    safeRAGAnalytics.startStage(requestId, "generation");
    const generationStartTime = Date.now();

    const generationOptions = {
      lang,
      tier: tierToUse,
      ...(options.model ? { model: options.model } : {}),
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      maxContinuations: options.maxContinuations || 10,  // Conservative default
      // The request-wide deadline. These options are built field-by-field, so
      // anything not named here is silently dropped — omitting this made the
      // budget inert without any type error to say so.
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
      // The live progress sink. Named here for the reason the deadline comment
      // above gives: this bag is rebuilt field-by-field, so an unnamed field is
      // dropped with no type error. That is exactly what happened on 2026-09-09 —
      // the counter ticked in a direct call to generateCodeWithContinuation and
      // never fired in production, because production goes through here.
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      // Passthrough (undefined ⇒ omitted ⇒ API model default). Set to match models.
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
    };
    const onGenerationProgress = requestId
      ? (message: string) => ragLog(requestId, "streaming.progress", { message })
      : undefined;

    // Use the streaming service (always, as it handles both short and long responses)
    let streamResult = await generateCodeWithContinuation({
      formattedPrompt,  // Using the formatted prompt with examples
      lang,
      currentCode,
      options: generationOptions,
      onProgress: onGenerationProgress,
    });

    // The zero-output thinking spiral: the first chunk spent its whole max_tokens
    // reasoning and never opened a text block. 2 of 98 L0179 generations over
    // 2026-09-16..30, while healthy runs think a median ~1s and at most ~83s — so
    // no cap separates the two, and a second thinking turn usually spirals again
    // (rid aab712e5 thought 127s more for 475 chars). Regenerate ONCE with thinking
    // off, pinned to the same model so the setting can't reach another family.
    // `spiralOutputTokens` is kept out of the repair gate below: those tokens are
    // already spent and say nothing about what repairing the retry would cost.
    let spiralOutputTokens = 0;
    const retryHeadroomMs = 60_000;
    if (
      streamResult.stopEarly === "no_output" &&
      streamResult.provider === "anthropic" &&
      options.thinking === undefined &&
      (!options.deadlineAt || options.deadlineAt - Date.now() > retryHeadroomMs)
    ) {
      console.log(`[code-gen] rid=${rid} lang=L${lang} no_output — regenerating with thinking disabled`);
      const spiral = streamResult;
      const retry = await generateCodeWithContinuation({
        formattedPrompt,
        lang,
        currentCode,
        options: { ...generationOptions, model: spiral.model, thinking: { type: "disabled" } },
        onProgress: onGenerationProgress,
      });
      spiralOutputTokens = spiral.usage.outputTokens;
      streamResult = {
        ...retry,
        usage: {
          inputTokens: spiral.usage.inputTokens + retry.usage.inputTokens,
          outputTokens: spiral.usage.outputTokens + retry.usage.outputTokens,
          cacheCreationInputTokens: spiral.usage.cacheCreationInputTokens + retry.usage.cacheCreationInputTokens,
          cacheReadInputTokens: spiral.usage.cacheReadInputTokens + retry.usage.cacheReadInputTokens,
          reasoningTokens: spiral.usage.reasoningTokens + retry.usage.reasoningTokens,
        },
        attempts: [...spiral.attempts, ...retry.attempts],
      };
    }

    const generationLatency = Date.now() - generationStartTime;
    safeRAGAnalytics.endStage(requestId, "generation");
    modelToUse = streamResult.model;
    tierToUse = streamResult.tier;
    const providerUsed = streamResult.provider;
    const providerAttempts = streamResult.attempts.map((attempt) => ({
      stage: "generation",
      ...attempt,
    }));
    let totalCostUsd = estimateUsdCost(
      streamResult.usage,
      modelToUse,
      new Date(),
      providerUsed,
    );

    // Surface normalized provider usage. Input/cache counts use a disjoint
    // convention for both APIs, so cost and cache telemetry remain comparable.
    {
      const u = streamResult.usage || { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 };
      console.log(
        `[code-gen] rid=${rid} lang=L${lang} provider=${providerUsed} model=${modelToUse} tier=${tierToUse} ` +
        `input=${u.inputTokens} output=${u.outputTokens} ` +
        `cache_create=${u.cacheCreationInputTokens || 0} cache_read=${u.cacheReadInputTokens || 0} ` +
        `latencyMs=${generationLatency}` +
        // Which effort actually went on the wire — the per-language table entry, the
        // global CODEGEN_EFFORT, or neither. Absent when nothing was sent.
        (streamResult.effort ? ` effort=${streamResult.effort}` : "") +
        // Where the output tokens actually went. `output` alone cannot separate
        // three very different things: code we kept, prose the model wrapped
        // around it (which carries the <DESCRIPTION>/<CHANGE_SUMMARY> tags we
        // parse, so it is not free to remove), and reasoning tokens — which
        // Anthropic folds into output_tokens without reporting, and which no
        // output-format change can remove. rawChars is everything emitted;
        // codeChars is what survived assembly. The gap is prose + discarded
        // restarts; `reasoning` splits out the part only OpenAI reports.
        ` reasoning=${u.reasoningTokens || 0}` +
        (streamResult.rawChars !== undefined ? ` rawChars=${streamResult.rawChars}` : "") +
        ` codeChars=${(streamResult.code || "").length}` +
        // Only present when the continuation loop cut the run short. Absent is
        // the normal case and stays absent so existing log parsing is unaffected.
        (streamResult.stopEarly ? ` stopEarly=${streamResult.stopEarly}` : "") +
        (streamResult.chunks > 1 ? ` chunks=${streamResult.chunks}` : "") +
        // Time to the first visible character — the reasoning phase, which the
        // `reasoning=` field above CANNOT report on Anthropic (it folds thinking into
        // output_tokens and breaks out nothing). `think=never` means no text block
        // ever opened: the whole budget went to thinking, which is the zero-output
        // spiral. See ProviderRequestResult.reasoning.
        (streamResult.reasoning
          ? ` think=${streamResult.reasoning.msToFirstText === null
              ? "never"
              : streamResult.reasoning.msToFirstText + "ms"}`
          : "")
      );
      if (requestId) {
        ragLog(requestId, "llm.usage", {
          provider: providerUsed,
          routeSource: streamResult.routeSource,
          priority: streamResult.priority,
          tier: tierToUse,
          model: modelToUse,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens || 0,
          cacheReadInputTokens: u.cacheReadInputTokens || 0,
          latencyMs: generationLatency,
          fallbackReason: streamResult.fallbackReason || null,
          stopEarly: streamResult.stopEarly || null,
          chunks: streamResult.chunks,
          attempts: streamResult.attempts,
        });
      }
      if (isFreePlan) {
        // Telemetry only — the free-plan budget is items, not dollars.
        recordSpend(totalCostUsd).catch((err) => {
          console.error("[free-plan] failed to record spend", err);
        });
      }
    }

    if (streamResult.error) {
      safeRAGAnalytics.trackError(requestId, "generation", streamResult.error);
      safeRAGAnalytics.trackGeneration(requestId, {
        model: modelToUse,
        latencyMs: generationLatency,
        success: false,
        errorMessage: streamResult.error,
      }, "");
      // Record BEFORE the throw. The success-path recordTokenUsage call is ~350
      // lines below this point, so until now a failed generation wrote no usage
      // row at all — a retry storm left no trace and every cost report
      // understated spend by exactly the failures. streamResult.usage now
      // carries every provider attempt's tokens, failed ones included.
      if (auth?.uid) {
        await recordTokenUsage({
          auth,
          rid: requestId,
          stage: "code_gen",
          itemId: itemId ?? null,
          generatedTaskId: null,
          lang,
          provider: providerUsed,
          model: modelToUse,
          tier: tierToUse ?? null,
          usage: streamResult.usage,
          outcome: "failed",
          extra: {
            fallbackReason: streamResult.fallbackReason || null,
            stopEarly: streamResult.stopEarly || null,
            providerAttempts: streamResult.attempts ?? [],
            error: String(streamResult.error).slice(0, 200),
          },
        }).catch((err) => {
          console.error("[token-usage] failed to record failed generation", err);
        });
      }
      throw new Error(streamResult.error);
    }

    // Track successful generation
    safeRAGAnalytics.trackGeneration(requestId, {
      model: modelToUse,
      totalTokens: (streamResult.usage.inputTokens + streamResult.usage.outputTokens) || 0,
      latencyMs: generationLatency,
      temperature: options.temperature || 0.2,
      maxTokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      success: true,
    }, streamResult.code);

    // Check for out-of-scope signal before processing
    const outOfScopeMatch = streamResult.code?.match(/^OUT_OF_SCOPE:\s*(.+)/m);
    if (outOfScopeMatch) {
      const reason = outOfScopeMatch[1].trim();
      console.log(`[code-gen] rid=${rid} lang=${lang} out-of-scope: ${reason}`);
      const routing = await findBestLanguages({ userRequest: prompt, outOfScopeReason: reason, currentLang: lang, rid, itemId, auth, budget: options?.budget });

      let errorMessage = `Out of scope: ${reason}`;
      if (routing.suggestions.length > 0) {
        errorMessage += "\n\nSuggested alternatives:\n" +
          routing.suggestions.map(s => `- L${s.id} (${s.description}): ${s.reason}`).join("\n");
      }

      return {
        // Same code as the scope gate's refusal in generate-for-request.ts: a
        // correct "no", which callers must be able to tell from a broken generation.
        errors: [{ message: errorMessage, code: "out_of_scope" }],
        code: null,
        taskId: null,
        lang,
        model: modelToUse,
        provider: providerUsed,
        tier: tierToUse,
        usage: {
          input_tokens: streamResult.usage.inputTokens,
          output_tokens: streamResult.usage.outputTokens,
        },
      };
    }

    // Process the generated code to fix any issues
    let generatedCode = await processGeneratedCode(streamResult.code, lang, rid, accessToken);
    let verificationResult = null;
    let fixAttempts = 0;
    // A compiler reports the FIRST violation it hits, so a program with stacked
    // errors reveals them one turn at a time: fix the stimulus and the next
    // compile complains about the template. A flat 2 could therefore never
    // converge on a three-error program — it burned both turns making real
    // progress and returned code that still failed. The ceiling is now high
    // enough to walk a chain, and the loop exits the moment a turn stops making
    // progress (see errorSignature below), so a stuck repair still costs two
    // turns rather than five.
    const MAX_FIX_ATTEMPTS = 5;
    // Error correction is a narrow, mechanical task, so it runs balanced regardless of what
    // the language spends on authoring — a dialect may override that in MODEL_PRIORITY when
    // it has evidence its repairs need more (or less).
    const repairTier: GenerationTier = modeTierFor(lang, "repair") || "balanced";

    // Preserve the original conversation so compile-error fixes are a genuine
    // continued turn (same system + history) rather than a stateless "repair
    // this snippet" prompt. basePrompt is null only if formattedPrompt won't
    // parse — in that case we fall back to the legacy createErrorFixPrompt.
    let basePrompt: { system: any; messages: any[] } | null = null;
    try {
      const parsed = JSON.parse(formattedPrompt);
      if (parsed && Array.isArray(parsed.messages)) basePrompt = parsed;
    } catch {
      basePrompt = null;
    }
    const conversationMessages: any[] = basePrompt ? [...basePrompt.messages] : [];
    let lastRawOutput = streamResult.code; // model's most recent raw output
    // The errors the previous attempt was asked to fix. A repair that produces
    // the identical error made no progress, and another turn won't either.
    let lastErrorSignature: string | null = null;
    // Repair spend, tracked alongside finalUsage rather than as a separate doc.
    // The Stage union declares "repair" and nothing writes it, so repair cost
    // has been indistinguishable from authoring cost in the per-item rollup. A
    // second doc would fix that but change the record COUNT per generation,
    // which every existing cost query treats as "one generation" — carrying the
    // subtotal on the existing doc separates the two without moving that
    // denominator.
    const repairTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let finalUsage = {
      prompt_tokens: streamResult.usage.inputTokens,
      completion_tokens: streamResult.usage.outputTokens,
      total_tokens: streamResult.usage.inputTokens + streamResult.usage.outputTokens,
      // Tracked separately from prompt_tokens because they price differently
      // (1.25x write, 0.1x read) and are disjoint from it — the API reports the
      // three counts side by side, and the prompt is their sum. Without these
      // the recorded cost is not just imprecise but structurally wrong: a
      // well-cached generation looks nearly free.
      cache_creation_tokens: streamResult.usage.cacheCreationInputTokens || 0,
      cache_read_tokens: streamResult.usage.cacheReadInputTokens || 0,
      // A SUBSET of completion_tokens (providers that report it bill it at the
      // output rate and include it there), carried for attribution only — never
      // added into a total. See TokenUsage.reasoningTokens.
      reasoning_tokens: streamResult.usage.reasoningTokens || 0,
    };

    // Estimate compile units from initial generation.
    // Skip fix attempts if already expensive (>50 units).
    const MAX_UNITS_FOR_FIXES = 50;
    const estimatedUnits = Math.ceil((finalUsage.total_tokens - spiralOutputTokens) / 750);

    // Verify the code if an access token is provided. An empty program has nothing
    // to repair: sending it through the loop started a second full generation that
    // spiraled like the first (~150s each, rids 0a7a069d and aab712e5).
    if (accessToken && generatedCode?.trim()) {
      safeRAGAnalytics.startStage(requestId, "compilation");

      // Attempt to verify and fix the code up to MAX_FIX_ATTEMPTS times, or until
      // the request's wall-clock budget is spent — whichever comes first.
      //
      // The attempt COUNT was never the real bound: each repair attempt starts a
      // full generation, so five attempts against a slow language could outlast
      // any per-generation limit. Checking the shared deadline here is what keeps
      // MAX_FIX_ATTEMPTS from multiplying it.
      while (fixAttempts < MAX_FIX_ATTEMPTS && estimatedUnits <= MAX_UNITS_FOR_FIXES) {
        if (options?.deadlineAt && Date.now() >= options.deadlineAt) {
          console.log(
            `[code-gen] rid=${rid} repair loop stopped: request budget spent after ${fixAttempts} attempt(s)`,
          );
          break;
        }
        // The token twin of the deadline check above, and the same reasoning:
        // MAX_FIX_ATTEMPTS is per generateCode, so composition multiplies it.
        // Breaking degrades the request to "return the unrepaired program and
        // its compile errors" — the existing failure mode — rather than
        // refusing outright, which is the right call for a repair breach.
        if (options?.budget && exhausted(options.budget)) {
          console.log(
            `[budget] rid=${rid} repair loop stopped ${budgetSummary(options.budget)} attempts=${fixAttempts}`,
          );
          break;
        }
        verificationResult = await verifyCode(generatedCode, accessToken, lang, requestId, isFreePlan);

        // If compilation was successful, break the loop. (Success = no real
        // errors; getData returns no `status` field and `errors: []` on success.)
        if (verificationSucceeded(verificationResult)) {
          safeRAGAnalytics.endStage(requestId, "compilation");
          safeRAGAnalytics.trackCompilation(requestId, {
            success: true,
            taskId: verificationResult.taskId,
            retryCount: fixAttempts,
            finalCode: generatedCode,
          });
          break;
        }

        // Otherwise there were real errors — try to fix them.
        if (!verificationSucceeded(verificationResult)) {
          // Classify the error type
          const errorType = classifyCompilerError(verificationResult);
          const structuredErrors = parseStructuredErrors(verificationResult);

          // Progress check. Errors that CHANGE between turns mean the repair is
          // walking down a chain of violations and deserves another turn;
          // errors that repeat mean the model is stuck on one it can't see, and
          // every further turn is spend for nothing.
          const errorSignature = structuredErrors.length > 0
            ? structuredErrors.map((e) => e.message).sort().join("\n")
            : parseGraffiticodeErrors(verificationResult);
          if (errorSignature === lastErrorSignature) {
            if (requestId) {
              ragLog(requestId, "fix.stalled", {
                attemptNumber: fixAttempts + 1,
                errorCount: structuredErrors.length,
                errorSummary: errorSignature.substring(0, 300),
              });
            }
            break;
          }
          lastErrorSignature = errorSignature;

          if (requestId) {
            ragLog(requestId, "fix.attempt", {
              attemptNumber: fixAttempts + 1,
              maxAttempts: MAX_FIX_ATTEMPTS,
              errorType,
              errorCount: structuredErrors.length,
              errorSummary: JSON.stringify(
                verificationResult.errors || verificationResult.error,
              ).substring(0, 300),
            });
          }

          let fixPrompt: string;
          let usedDSPyRepair = false;

          // For semantic errors, try DSPy repair flow if enabled
          if (errorType === "semantic" && isDSPyEnabled()) {
            try {
              const repairContextPack = {
                ...contextPack,
                taskType: "repair" as const,
                lastModelOutput: generatedCode,
                structuredCompilerErrors: structuredErrors,
              };

              const repairSpec = await compileRepairPromptSpec(repairContextPack, requestId);

              if (repairSpec) {
                const renderContext: RenderContext = {
                  userRequest: prompt,
                  currentCode: generatedCode,
                  conversationSummary,
                  retrievedChunks,
                  dialect: lang,
                };

                const rendered = renderPromptSpecToMessages(repairSpec, renderContext);

                fixPrompt = JSON.stringify({
                  system: rendered.systemPrompt,
                  messages: rendered.messages,
                }, null, 2);

                usedDSPyRepair = true;

                if (requestId) {
                  ragLog(requestId, "dspy.repair.rendered", {
                    specId: repairSpec.specId,
                    errorType,
                    errorCount: structuredErrors.length,
                  });
                }
              }
            } catch (error: any) {
              console.warn("DSPy repair compilation failed, falling back to legacy:", error.message);
              if (requestId) {
                ragLog(requestId, "dspy.repair.fallback", {
                  reason: error.message,
                  errorType,
                });
              }
            }
          }

          // Fall back to legacy fix prompt if DSPy repair didn't produce a result
          if (!usedDSPyRepair) {
            if (basePrompt) {
              // Continue the original conversation: append the model's prior
              // output as an assistant turn, then the compile errors as a user
              // turn. Accumulates across attempts so a later attempt sees the
              // whole repair history. (If a prior attempt went via DSPy, that
              // turn isn't captured here — acceptable.)
              conversationMessages.push({ role: "assistant", content: lastRawOutput });
              conversationMessages.push({ role: "user", content: buildErrorFeedback(verificationResult) });
              fixPrompt = JSON.stringify({ system: basePrompt.system, messages: conversationMessages });
            } else {
              // formattedPrompt didn't parse — use the stateless legacy prompt.
              fixPrompt = createErrorFixPrompt(generatedCode, verificationResult);
            }
          }

          // Repairs start on the provider that completed generation. Unless the
          // caller pinned a raw model, use that provider's balanced tier.
          const fixResult = await generateCodeWithContinuation({
            formattedPrompt: fixPrompt,
            lang,
            currentCode: generatedCode,
            options: {
              lang,
              tier: repairTier,
              // Pin the repair to the family that produced the program. A repair
              // is a continuation of that output, so handing it to another family
              // means asking a model to fix code it did not write against a
              // dialect it may rank differently. A model pin gives us exactly
              // that family with no failover.
              model:
                options.model ||
                modelForProvider(providerUsed, repairTier),
              temperature: 0.1, // Lower temperature for more deterministic fixes
              maxTokens: options.maxTokens || DEFAULT_MAX_TOKENS,
              maxContinuations: 10,
              // Same request deadline as the initial generation, deliberately not
              // a fresh one: a repair is part of the request that spawned it.
              ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
              // A repair is still the same request from the caller's side, and its
              // output is still output — a user watching should see it move.
              ...(options.onOutput ? { onOutput: options.onOutput } : {}),
              ...(options.effort !== undefined
                ? { effort: options.effort }
                : {}),
            },
            onProgress: requestId ? (message) => ragLog(requestId, "fix.progress", { message }) : undefined
          });
          providerAttempts.push(
            ...fixResult.attempts.map((attempt) => ({
              stage: `repair_${fixAttempts + 1}`,
              ...attempt,
            })),
          );

          if (fixResult.error) {
            console.error("Failed to fix code:", fixResult.error);
            break;
          }

          // Add fix attempt usage to total
          finalUsage.prompt_tokens += fixResult.usage.inputTokens;
          finalUsage.completion_tokens += fixResult.usage.outputTokens;
          finalUsage.total_tokens += fixResult.usage.inputTokens + fixResult.usage.outputTokens;
          finalUsage.cache_creation_tokens += fixResult.usage.cacheCreationInputTokens || 0;
          finalUsage.cache_read_tokens += fixResult.usage.cacheReadInputTokens || 0;
          finalUsage.reasoning_tokens += fixResult.usage.reasoningTokens || 0;
          repairTokens.input += fixResult.usage.inputTokens;
          repairTokens.output += fixResult.usage.outputTokens;
          repairTokens.cacheCreation += fixResult.usage.cacheCreationInputTokens || 0;
          repairTokens.cacheRead += fixResult.usage.cacheReadInputTokens || 0;
          const fixCostUsd = estimateUsdCost(
            fixResult.usage,
            fixResult.model,
            new Date(),
            fixResult.provider,
          );
          totalCostUsd += fixCostUsd;

          if (isFreePlan) {
            recordSpend(fixCostUsd).catch((err) => {
              console.error("[free-plan] failed to record fix spend", err);
            });
          }

          fixAttempts++;

          // Track the model's raw output so the next iteration appends the
          // correct assistant turn (even if this fix lacked a code block).
          lastRawOutput = fixResult.code;

          // Update the generated code with the fixed version and process to fix escaping issues.
          // Accept the fix if it carries a program at all — see fixResponseToSource.
          const fixedSource = await fixResponseToSource(fixResult.code, lang, accessToken);
          if (fixedSource) {
            generatedCode = await processGeneratedCode(fixedSource, lang, requestId, accessToken);
          } else {
            if (requestId) {
              ragLog(requestId, "fix.skipped", {
                reason: "fix response carried no program",
                attempt: fixAttempts,
                responseLength: fixResult.code ? fixResult.code.length : 0,
              });
            }
          }
        } else {
          // No errors found, break the loop
          break;
        }
      }

      // Track the final compilation result whenever we leave the loop with code
      // that still doesn't compile — max attempts, a stalled repair, or a failed
      // fix call. Keying this on max-attempts alone recorded nothing for the
      // other two exits, so a stuck repair vanished from the analytics.
      if (verificationResult && !verificationSucceeded(verificationResult)) {
        safeRAGAnalytics.endStage(requestId, "compilation");
        safeRAGAnalytics.trackCompilation(requestId, {
          success: false,
          errorMessage: verificationResult.error?.message || "Max fix attempts reached",
          retryCount: fixAttempts,
          finalCode: generatedCode,
        });
      }

    }

    // Extract the model's description + change-summary from the raw output
    // before we strip the code block. Null when the tags aren't present.
    const { description, changeSummary } = extractSummaryTags(generatedCode);

    // Ensure the code is properly processed one final time before returning
    const finalProcessedCode = await processGeneratedCode(generatedCode, lang, rid, accessToken);

    // Token telemetry. Under item-based billing, code generation and its
    // iterations are FREE (billing is per successful item via recordBillableItem),
    // so we record units: 0 and never touch the monthly item counter.
    if (auth?.uid && finalUsage.total_tokens > 0) {
      const stage: Stage = "code_gen"; // fixAttempts distinguishes first-try vs repaired in the flat log
      const tokenUsage = {
        inputTokens: finalUsage.prompt_tokens,
        outputTokens: finalUsage.completion_tokens,
        cacheCreationInputTokens: finalUsage.cache_creation_tokens,
        cacheReadInputTokens: finalUsage.cache_read_tokens,
        reasoningTokens: finalUsage.reasoning_tokens,
      };
      const userDoc = await getFirestoreDb().doc(`users/${auth.uid}`).get();
      const plan = userDoc.data()?.subscription?.plan || "demo";

      await recordTokenUsage({
        auth,
        rid: requestId,
        stage,
        itemId: itemId ?? null,
        generatedTaskId: verificationResult?.taskId ?? null,
        lang,
        provider: providerUsed,
        model: modelToUse,
        tier: tierToUse,
        usage: tokenUsage,
        extra: {
          routeSource: streamResult.routeSource,
          priority: streamResult.priority,
          providerAttempts,
          fallbackReason: streamResult.fallbackReason ?? null,
          plan,
          fixAttempts,
          // Subset of `tokens` above, not an addition — the share of this
          // generation spent repairing rather than authoring.
          repairTokens,
        },
      });
    }

    // Complete analytics tracking — mark as failed if compilation had errors
    const compilationSucceeded = verificationResult ? verificationSucceeded(verificationResult) : true;
    await safeRAGAnalytics.completeRequest(requestId, compilationSucceeded);

    // Return formatted response with the language name
    const result = {
      code: finalProcessedCode,
      description,
      changeSummary,
      taskId: verificationResult?.taskId || null,
      lang: lang,
      model: modelToUse,
      provider: providerUsed,
      tier: tierToUse,
      providerAttempts,
      fallbackReason: streamResult.fallbackReason ?? null,
      usage: {
        input_tokens: finalUsage.prompt_tokens,
        output_tokens: finalUsage.completion_tokens,
      },
      verification: verificationResult,
      fixAttempts,
      streaming: true,
      chunks: streamResult.chunks,
      requestId: requestId,
      usedDSPy,
      promptSpecId,
    };

    // Inline-async LLM-as-judge: fire-and-forget quality scoring, NEVER awaited and NEVER able to
    // affect the response. Writes to rag_analytics/{requestId} out of band (post-completeRequest,
    // so trackJudge uses a Firestore update, not the already-deleted in-memory record). Zero
    // user-facing latency; flag-gated (JUDGE_MODE=async), default off.
    if (getJudgeMode() === "async" && finalProcessedCode) {
      judgeCode({ prompt, code: finalProcessedCode, lang, currentCode, rid: requestId, itemId })
        .then((result) => {
          if (!result) return;
          const { verdict, usage } = result;
          ragAnalytics.trackJudge(requestId, verdict);
          if (usage) {
            recordTokenUsage({
              auth,
              rid: requestId,
              stage: "judge",
              itemId: itemId ?? null,
              lang,
              provider: verdict.model.includes("gpt") ? "openai" : "anthropic",
              model: verdict.model,
              usage,
            }).catch(() => {
              // Never throw from usage recording
            });
          }
        })
        .catch(() => { /* judge failures must never surface */ });
    }

    return result;
  } catch (error) {
    console.error(`Error generating code for ${lang}:`, error);

    // Track the error in analytics
    if (requestId) {
      safeRAGAnalytics.trackError(requestId, "request", error);
      await safeRAGAnalytics.completeRequest(requestId, false);
    }

    throw new Error(`Failed to generate code for ${lang}: ${error.message}`);
  }
}
