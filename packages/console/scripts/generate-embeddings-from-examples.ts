/**
 * Script to generate training_examples.json from help field in items collection
 *
 * This script fetches items from the items collection which contain all necessary
 * data including help field with dialog interactions, code, mark, etc.
 *
 * Usage:
 * node scripts/generate-embeddings-from-examples.js [options]
 *
 * Options:
 *   --limit <number>                 Maximum number of items to process (default: 100000)
 *   --output <path>                  Output file path (default: ./training_examples.json)
 *   --service-account <path>         Path to Firebase service account JSON file
 *   --items-collection <name>        Name of the items collection (default: items)
 *   --lang <language>                Filter items by language code (e.g., "0159")
 *   --mark <mark>                    Filter items by mark value (default: 1)
 *   --all-langs                      Process all languages (default behavior)
 *   --store-mode <mode>              Storage mode: 'file' or 'vector' (default: vector)
 *   --vector-collection <name>       Vector store collection name (default: training_examples)
 *   --batch-size <number>            Batch size for vector updates (default: 10)
 *   --attempts <number>              Attempts per batch before it counts as failed (default: 3)
 *   --step-timeout <seconds>         Cap on one embedding request or batch write (default: 120)
 *   --no-caffeinate                  macOS: do not keep the machine awake for the run
 *   --skip-gate                      Store even if a language's corpus gate fails (see lang-gate.ts)
 *
 * Examples:
 *   # Basic usage with defaults (stores in vector database)
 *   node scripts/generate-embeddings-from-examples.js
 *
 *   # Generate examples only for a specific language
 *   node scripts/generate-embeddings-from-examples.js --lang 0159
 *
 *   # Generate examples with specific mark value
 *   node scripts/generate-embeddings-from-examples.js --lang 0159 --mark 2
 *
 *   # Save to file instead of vector database
 *   node scripts/generate-embeddings-from-examples.js --store-mode file
 *
 *   # Use custom vector collection name
 *   node scripts/generate-embeddings-from-examples.js --vector-collection custom_examples
 */

import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import {
  createEmbeddingText,
  addDocumentWithEmbedding,
  generateBatchEmbeddings
} from '../src/lib/embedding-service';
import { verifyExampleForPrompt } from '../src/lib/lang-embedding';
import { FieldValue } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import { unparse } from '@graffiticode/parser';
import { execSync, spawn } from 'child_process';
import { findCorpusGate, runCorpusGate } from './lang-gate';

/** item id → the example number create-items-from-prompts gave it, for the gate's report. */
const exampleNumbers = new Map<string, number>();

// Load environment variables. Keys live in .env.local (as for the other corpus scripts, via
// eval-env); .env still fills anything .env.local leaves unset.
dotenv.config({ path: '.env.local' });
dotenv.config();

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

// Use the local graffiticode-app key file if available and no other credentials are set
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const localKeyPath = '/Users/jeffdyer/graffiticode-app-key.json';
  if (fs.existsSync(localKeyPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = localKeyPath;
    console.log(`Using local service account key: ${localKeyPath}`);
  } else if (process.env.GOOGLE_APP_CREDENTIALS) {
    // Fallback to GOOGLE_APP_CREDENTIALS if set
    const credValue = process.env.GOOGLE_APP_CREDENTIALS;
    // Check if it's JSON content (starts with {) or a file path
    if (credValue.trim().startsWith('{')) {
      // It's JSON content, write it to a temp file
      const tempFile = '/tmp/temp-service-account.json';
      fs.writeFileSync(tempFile, credValue);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tempFile;
      console.log('Using credentials from GOOGLE_APP_CREDENTIALS (JSON content)');
    } else {
      // It's a file path
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credValue;
      console.log(`Using credentials from GOOGLE_APP_CREDENTIALS (file): ${credValue}`);
    }
  }
}

// Debug: Check if credentials are available
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(`Credentials set: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
  console.log('Warning: GOOGLE_APPLICATION_CREDENTIALS not set');
}

// Parse command line arguments
const args = process.argv.slice(2);
// Set a very high default limit or use the provided limit
const limit = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1])
  : 100000; // Very high limit to effectively get all documents

// Language filter settings
const filterByLanguage = args.includes('--lang');
const languageFilter = filterByLanguage
  ? args[args.indexOf('--lang') + 1]
  : null;

// Mark filter settings
const markValue = args.includes('--mark')
  ? parseInt(args[args.indexOf('--mark') + 1])
  : 1; // Default mark value

// Store mode: 'file' (default) or 'vector' to store in vector database
const storeMode = args.includes('--store-mode')
  ? args[args.indexOf('--store-mode') + 1]
  : 'vector'; // Default to vector store

// Collection name for vector store
const vectorCollection = args.includes('--vector-collection')
  ? args[args.indexOf('--vector-collection') + 1]
  : 'training_examples';

// Batch size for vector updates
const vectorBatchSize = args.includes('--batch-size')
  ? parseInt(args[args.indexOf('--batch-size') + 1])
  : 10;

// Each batch gets this many attempts. On 2026-10-09 two of thirteen L0186 batches were lost to
// one dropped connection (ECONNRESET), each a single attempt.
const maxAttempts = Math.max(1, args.includes('--attempts')
  ? parseInt(args[args.indexOf('--attempts') + 1])
  : 3);

// A stalled embedding request or batch write fails that attempt instead of holding the run.
const stepTimeoutMs = (args.includes('--step-timeout')
  ? parseInt(args[args.indexOf('--step-timeout') + 1])
  : 120) * 1000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(stepTimeoutMs / 1000)}s`)), stepTimeoutMs);
  });
  return Promise.race([work, bell]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// macOS: keep the machine awake for the run. A sleep drops every open connection.
if (process.platform === 'darwin' && !args.includes('--no-caffeinate')) {
  try {
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.warn('caffeinate unavailable: keep the machine awake for the run');
  }
}

// Determine output file path, adding language code to filename if filtering
let outputDir = "./";

// Support both --outdir and --output-dir for the directory parameter
if (args.includes('--outdir')) {
  outputDir = args[args.indexOf('--outdir') + 1];
} else if (args.includes('--output-dir')) {
  outputDir = args[args.indexOf('--output-dir') + 1];
}

// Make sure output directory ends with a slash
if (!outputDir.endsWith('/')) {
  outputDir += '/';
}

// We'll create the markdown file path at write time

if (storeMode === 'file') {
  console.log(`Using output directory: ${outputDir}`);
} else {
  console.log(`Storing in vector database collection: ${vectorCollection}`);
}

const serviceAccountPath = args.includes('--service-account')
  ? args[args.indexOf('--service-account') + 1]
  : null;

// Default user ID — the eval account (EVAL_UID in .env.local)
const defaultUserId = '2c9d72e315fbafb128011bc32739666c7e6e7eb9';

// Check if user parameter is provided
const userId = args.includes('--user')
  ? args[args.indexOf('--user') + 1]
  : defaultUserId;

// Collection settings
const itemsCollection = args.includes('--items-collection')
  ? args[args.indexOf('--items-collection') + 1]
  : 'items';

// Show help if requested
if (args.includes('--help')) {
  console.log(`
Usage: node scripts/generate-embeddings-from-examples.js [options]

This script fetches items from the users/{userId}/items subcollection and generates
training examples from the help field. Items contain all necessary data including
code, mark, and help dialogs.

Options:
  --limit <number>                 Maximum number of items to process (default: 100000)
  --output <path>                  Output file path (default: ./training_examples.json)
  --service-account <path>         Path to Firebase service account JSON file
  --user <userId>                  User ID to fetch items from (default: predefined ID)
  --items-collection <name>        Name of the items subcollection (default: items)
  --lang <language>                Filter items by language code (e.g., "0159")
  --mark <mark>                    Filter items by mark value (default: 1)
  --all-langs                      Process all languages (default behavior)
  --store-mode <mode>              Storage mode: 'file' or 'vector' (default: vector)
  --vector-collection <name>       Vector store collection name (default: training_examples)
  --batch-size <number>            Batch size for vector updates (default: 10)

Examples:
  # Basic usage with defaults (stores in vector database)
  node scripts/generate-embeddings-from-examples.js

  # Specify a different user ID
  node scripts/generate-embeddings-from-examples.js --user 1a2b3c4d5e6f

  # Generate examples only for a specific language
  node scripts/generate-embeddings-from-examples.js --lang 0159

  # Generate examples with specific mark value
  node scripts/generate-embeddings-from-examples.js --lang 0159 --mark 1
  
  # Save to file instead of vector database
  node scripts/generate-embeddings-from-examples.js --store-mode file
  
  # Use custom vector collection name
  node scripts/generate-embeddings-from-examples.js --vector-collection custom_examples
  `);
  process.exit(0);
}

// Initialize Firebase Admin SDK (as fallback if GraphQL is not available)
try {
  // Only initialize with service account if explicitly provided
  if (serviceAccountPath) {
    try {
      const serviceAccount = require(path.resolve(serviceAccountPath));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log(`Using service account from: ${serviceAccountPath}`);
    } catch (saError) {
      console.error(`Error loading service account file: ${saError.message}`);
      console.log('Falling back to application default credentials');
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: 'graffiticode-app'
      });
    }
  } else {
    // Initialize with application default credentials and explicit project ID
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: 'graffiticode-app'
    });
  }
  console.log('Firebase initialized successfully');
} catch (err) {
  // Ignore duplicate/conflicting app errors (Firebase already initialized by imports)
  if (err.code !== 'app/duplicate-app' && err.code !== 'app/invalid-app-options') {
    console.error('Firebase initialization error:', err);
    process.exit(1);
  } else {
    console.log('Firebase already initialized');
  }
}

// Cache lexicons
const lexiconCache: Record<string, any> = {};

function prefetchLexicon(lang: string): void {
  if (lexiconCache[lang] !== undefined) return;
  const urls = [
    `https://api.graffiticode.org/L${lang}/lexicon.json`,
    `https://api.graffiticode.org/L${lang}/lexicon.js`,
    `https://l${lang}.graffiticode.org/lexicon.json`,
  ];
  for (const url of urls) {
    try {
      const text = execSync(`curl -sf '${url}'`, { encoding: 'utf-8' });
      const parsed = JSON.parse(text.substring(text.indexOf("{")));
      if (parsed && Object.keys(parsed).length > 0) {
        lexiconCache[lang] = parsed;
        console.log(`  Lexicon for L${lang}: ${Object.keys(parsed).length} entries from ${url}`);
        return;
      }
    } catch {
      // try the next candidate
    }
  }
  console.error(`Error: could not fetch a lexicon for L${lang}`);
  lexiconCache[lang] = null;
}

function getCachedLexicon(lang: string): any {
  if (lexiconCache[lang] === undefined) {
    prefetchLexicon(lang);
  }
  return lexiconCache[lang];
}

// Function to extract a useful description from code
function extractDescription(code) {
  // Try to find comments in the code
  const commentMatch = code.match(/\|(.*?)(\.\.|$)/g);
  if (commentMatch && commentMatch.length > 0) {
    // Extract text from comments, remove the pipe, and join with spaces
    return commentMatch
      .map(comment => comment.replace(/\|/, '').trim())
      .filter(comment => comment.length > 5) // Filter out very short comments
      .join(' ')
      .replace(/\.\.$/g, '') // Remove trailing dots
      .trim();
  }

  // Try to extract purpose from variable and function names
  const mainVariables = code.match(/let\s+([a-zA-Z0-9_]+)\s*=/g);
  if (mainVariables && mainVariables.length > 0) {
    const varNames = mainVariables
      .map(v => v.replace(/let\s+/, '').replace(/\s*=/, ''))
      .filter(v => v.length > 3 && !['result', 'output', 'value', 'temp', 'data'].includes(v));

    if (varNames.length > 0) {
      return `Code working with ${varNames.join(', ')}`;
    }
  }

  // Fallback if no good description found
  return "Graffiticode example";
}

// Function to determine expected output from code
function determineExpectedOutput(code) {
  // Check if we have a result or output variable
  const resultMatch = code.match(/let\s+(result|output|total|sum|average|final\w*)\s*=\s*([^\.]+)/i);
  if (resultMatch) {
    const varName = resultMatch[1];
    // Try to simplify the expression a bit
    return `${varName} = [computed value]`;
  }

  // Check if there are function definitions that might be the main operation
  const functionMatch = code.match(/let\s+([a-zA-Z0-9_]+)\s*=\s*<[^>]+>/);
  if (functionMatch) {
    return `${functionMatch[1]} = <function>`;
  }

  return "Output depends on execution"; // Default fallback
}

// Function to generate an explanation from code
function generateExplanation(code, lang) {
  // Split code into statements
  const statements = code
    .split('..')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  let explanation = '';

  if (statements.length === 1) {
    // Single statement code
    explanation = `Simple ${lang} code that ${statements[0].includes('=') ? 'assigns a value' : 'executes an operation'}.`;
  } else if (statements.length <= 3) {
    // Few statements - give brief description
    explanation = `Short ${lang} program with ${statements.length} operations that manipulates data.`;
  } else {
    // Multi-statement program - try to classify it
    const hasMap = code.includes('map (');
    const hasFilter = code.includes('filter (');
    const hasReduce = code.includes('reduce (');
    const hasConditional = code.includes('if ') || code.includes(' ? ');
    const hasLambdas = (code.match(/<[^>]+>/g) || []).length;

    if (hasMap && hasFilter && hasReduce) {
      explanation = `Comprehensive ${lang} program that performs data transformation using map, filter, and reduce operations.`;
    } else if (hasMap && hasFilter) {
      explanation = `${lang} program that filters and transforms data collections.`;
    } else if (hasMap) {
      explanation = `${lang} program that transforms each element in a collection.`;
    } else if (hasFilter) {
      explanation = `${lang} program that filters elements from a collection.`;
    } else if (hasReduce) {
      explanation = `${lang} program that aggregates values from a collection.`;
    } else if (hasConditional && hasLambdas > 1) {
      explanation = `${lang} program with conditional logic and multiple function definitions.`;
    } else if (hasLambdas > 0) {
      explanation = `${lang} program that defines and uses custom functions.`;
    } else if (hasConditional) {
      explanation = `${lang} program with conditional logic to make decisions.`;
    } else {
      explanation = `Multi-step ${lang} program that processes data through several operations.`;
    }
  }

  return explanation;
}

// Function to extract a task description from dialog messages
function extractTaskFromMessages(messages) {
  // Concatenate all user messages to create a more comprehensive task description
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => m.content.trim())
    .filter(content => content.length > 0);
  
  if (userMessages.length > 0) {
    // If there are multiple messages, join them to create a complete conversation context
    if (userMessages.length > 1) {
      return userMessages.join("\n\n");
    }
    // Otherwise just return the single message
    return userMessages[0];
  }
  
  // Fallback
  return "Implement the following functionality";
}

// Function to convert training examples to the standardized markdown format
function convertToMarkdownFormat(trainingExamples) {
  let markdown = `# Graffiticode Training Examples\n\n`;
  
  // Group examples by language
  const examplesByLang = {};
  trainingExamples.forEach(example => {
    const lang = example.lang;
    if (!examplesByLang[lang]) {
      examplesByLang[lang] = [];
    }
    examplesByLang[lang].push(example);
  });
  
  // Process each language group
  for (const [lang, examples] of Object.entries(examplesByLang)) {
    markdown += `## Language L${lang}\n\n`;
    
    // Add each example in the standardized format
    examples.forEach((example, index) => {
      // Extract a meaningful task description from the messages
      const prompt = extractTaskFromMessages(example.messages);
      
      // Clean up the code - remove trailing whitespace from each line
      const code = example.code.trim()
        .split('\n')
        .map(line => line.trimRight())
        .join('\n');
      
      // Use the standard format with "Prompt", "Chat Transcript", and "Code" sections
      // Code is always wrapped in triple backticks
      markdown += `### Prompt\n"${prompt}"\n\n`;
      
      // Add the full chat transcript in chronological order
      markdown += `### Chat Transcript\n\n`;
      // Messages are already in chronological order, as we preserved their order when parsing
      example.messages.forEach((message, msgIndex) => {
        const role = message.role === 'user' ? 'User' : 'Assistant';
        // Format the content with proper markdown for code blocks
        let content = message.content.trim();
        
        markdown += `**${role}**: ${content}\n\n`;
      });
      
      markdown += `### Code\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
      
      // Add separator between examples except after the last one
      if (index < examples.length - 1) {
        markdown += `---\n\n`;
      }
    });
    
    // Add separator between language sections except after the last one
    if (Object.keys(examplesByLang).indexOf(lang) < Object.keys(examplesByLang).length - 1) {
      markdown += `\n\n`;
    }
  }
  
  // Remove any trailing whitespace from the entire markdown content
  markdown = markdown.split('\n')
    .map(line => line.trimRight())
    .join('\n');
  
  return markdown;
}

/**
 * Store training examples in vector database
 * @param {Array} trainingExamples - Array of training examples
 * @param {Object} db - Firestore database instance
 * @param {string} lang - Language code for the log file
 * @param {Array} skippedItems - Array of items skipped during processing with reasons
 * @returns {Promise<Object>} - Statistics about the storage operation
 */
async function storeExamplesInVectorDatabase(trainingExamples, db, lang: string, skippedItems: Array<{id: string, reason: string}> = []) {
  const stats = {
    total: trainingExamples.length,
    stored: 0,
    errors: 0,
    skipped: 0,
    retried: 0,
    replaced: 0,
    failedBatches: [] as number[],
  };

  // Collect records for the log file
  const storedRecords: Array<{id: string, embeddingText: string, data: any}> = [];

  console.log(`\nStoring ${stats.total} examples in vector database...`);

  // Process in batches
  for (let i = 0; i < trainingExamples.length; i += vectorBatchSize) {
    const batch = trainingExamples.slice(i, i + vectorBatchSize);
    console.log(`Processing batch ${Math.floor(i / vectorBatchSize) + 1} (${batch.length} examples)...`);

    try {
      // Prepare texts for embedding
      const textsToEmbed = [];
      const docsToStore = [];

      for (const example of batch) {
        // Create a unique ID for the example
        const docId = `${example.lang}_${example.item_id}_${example.task_id || 'notask'}`;

        // Drift gate (facet-drift only, no compile): skip an example whose generated code does not
        // match the design its prompt asked for (e.g. prompt asks c1-t9 task model 3 / EBSR but the
        // code composed hot-text). null for unhooked langs / no declared target ⇒ passes through.
        const verdict = verifyExampleForPrompt(example.lang, {
          prompt: example.prompt || example.task,
          code: example.code || example.src,
        });
        if (verdict && !verdict.ok) {
          stats.skipped++;
          const reason = `Drift gate: ${verdict.blocking.join("; ")}`;
          console.warn(`  ⤫ Skipping example ${docId} — prompt↔code drift: ${verdict.blocking.join("; ")}`);
          skippedItems.push({ id: docId, reason });
          continue;
        }

        // Prepare document data
        const docData = {
          ...example,
          createdAt: FieldValue.serverTimestamp(),
          source: 'generate-embeddings-from-examples-script'
        };

        // Create embedding text. A multi-turn prompt is its user turns joined by blank lines,
        // while createEmbeddingText joins them by single newlines and appends them when the two
        // differ — so the conversation would be embedded twice. Hand it the turns as it joins them.
        const userTurns = (example.messages || [])
          .filter(m => m.role === 'user' && m.content)
          .map(m => String(m.content));
        const sameTurns = example.prompt &&
          example.prompt.replace(/\s+/g, ' ').trim() === userTurns.join(' ').replace(/\s+/g, ' ').trim();
        const embeddingText = createEmbeddingText(
          sameTurns ? { ...example, prompt: userTurns.join('\n') } : example,
        );
        textsToEmbed.push(embeddingText);
        docsToStore.push({ id: docId, data: docData, embeddingText });
      }

      // Embed and write the batch, retrying the pair: the write is a set by document id, so a
      // retry after a write that did land rewrites the same documents.
      const batchNumber = Math.floor(i / vectorBatchSize) + 1;
      for (let attempt = 1; ; attempt++) {
        try {
          console.log(`  Generating embeddings for ${textsToEmbed.length} examples...`);
          const embeddings = await withTimeout(generateBatchEmbeddings(textsToEmbed), `embeddings for batch ${batchNumber}`);

          // Store documents with embeddings
          const writeBatch = db.batch();

          // An item's row is keyed by its task, so an item edited since it was embedded (a new
          // taskId) would otherwise keep its old row beside the new one, and retrieval would
          // serve both programs. Its other rows go in the same atomic write.
          let replaced = 0;
          for (const doc of docsToStore) {
            const others = await withTimeout(
              db.collection(vectorCollection).where('item_id', '==', doc.data.item_id).get(),
              `older rows of ${doc.data.item_id}`,
            );
            for (const old of others.docs) {
              if (old.id === doc.id) continue;
              writeBatch.delete(old.ref);
              replaced++;
            }
          }

          docsToStore.forEach((doc, index) => {
            const docRef = db.collection(vectorCollection).doc(doc.id);
            // Must be a Firestore vector, not a plain array: findNearest only matches
            // vector-typed fields, so an array embedding is invisible to retrieval. The
            // 2026-09-28 run wrote arrays and silently emptied vector search for 14
            // languages (repair: scripts/fix-embedding-vectors.ts).
            const vectorValue = FieldValue.vector(embeddings[index]);

            writeBatch.set(docRef, {
              ...doc.data,
              embedding: vectorValue,
              embeddingText: textsToEmbed[index],
              embeddingUpdatedAt: FieldValue.serverTimestamp()
            }, { merge: true });

            console.log(`  Storing ${doc.id}`);
          });

          await withTimeout(writeBatch.commit(), `write for batch ${batchNumber}`);
          if (replaced) console.log(`  Removed ${replaced} older row(s) of these items (edited since they were embedded)`);
          stats.replaced += replaced;

          // Collect for the log file (without the vectors) only once the batch has landed.
          for (const doc of docsToStore) {
            storedRecords.push({ id: doc.id, embeddingText: doc.embeddingText, data: doc.data });
          }
          stats.stored += docsToStore.length;
          console.log(`  ✓ Batch stored successfully`);
          break;
        } catch (error) {
          if (attempt >= maxAttempts) {
            console.error(`  ✗ Batch ${batchNumber} failed after ${maxAttempts} attempts:`, error.message);
            stats.errors += docsToStore.length;
            stats.failedBatches.push(batchNumber);
            break;
          }
          const wait = 5 * attempt;
          console.warn(`  ↻ Batch ${batchNumber} attempt ${attempt} failed (${error.message}); retrying in ${wait}s...`);
          if (attempt === 1) stats.retried++;
          await new Promise(resolve => setTimeout(resolve, wait * 1000));
        }
      }

    } catch (error) {
      console.error(`  ✗ Error processing batch:`, error.message);
      stats.errors += batch.length;
    }

    // Add a small delay between batches to avoid rate limiting
    if (i + vectorBatchSize < trainingExamples.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Write embeddings log file (JSON with vectors elided)
  if (storedRecords.length > 0 || skippedItems.length > 0) {
    const logPath = path.join(process.cwd(), 'training', `l${lang}-embeddings.json`);
    const logData = {
      generatedAt: new Date().toISOString(),
      totalStored: storedRecords.length,
      totalSkipped: skippedItems.length,
      stored: storedRecords.map(record => ({
        id: record.id,
        embeddingText: record.embeddingText,
        embedding: '[1536 floats elided]',
        ...record.data,
      })),
      skipped: skippedItems,
    };

    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf8');
    console.log(`\n📝 Embeddings log written to ${logPath}`);
  }

  return stats;
}

/**
 * Function to fetch items from Firestore items collection
 * @param {string} lang - Language filter
 * @param {number} mark - Mark filter  
 * @param {number} limit - Maximum number of items to fetch
 * @returns {Promise<Array>} - Array of item objects with taskIds
 */
async function fetchItemsFromFirestore(lang, mark, limit) {
  try {
    const collectionPath = `users/${userId}/${itemsCollection}`;
    console.log(`Fetching items from Firestore collection '${collectionPath}' for lang=${lang}, mark=${mark}`);
    console.log(`User ID: ${userId}`);
    
    const db = admin.firestore();
    
    // Debug: Check if the user document exists
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      console.log(`Warning: User document '${userId}' does not exist in Firestore`);
      
      // List some existing users for debugging
      const usersSnapshot = await db.collection('users').limit(5).get();
      if (usersSnapshot.size > 0) {
        console.log(`Found ${usersSnapshot.size} user documents. Sample user IDs:`);
        usersSnapshot.forEach(doc => {
          console.log(`  - ${doc.id}`);
        });
      } else {
        console.log('No user documents found in the users collection');
      }
    } else {
      console.log(`User document '${userId}' exists`);
    }
    
    let query = db.collection('users').doc(userId).collection(itemsCollection);
    
    // Apply filters
    if (lang) {
      query = query.where('lang', '==', lang);
    }
    // Temporarily disable mark filter if mark is -1 (for debugging)
    if (mark !== undefined && mark !== null && mark !== -1) {
      query = query.where('mark', '==', mark);
    } else if (mark === -1) {
      console.log('Mark filter disabled for debugging');
    }
    if (limit) {
      query = query.limit(limit);
    }
    
    const snapshot = await query.get();
    console.log(`Query returned ${snapshot.size} documents`);
    
    // Debug: Try to get a count without any filters
    if (snapshot.size === 0) {
      const debugQuery = db.collection('users').doc(userId).collection(itemsCollection).limit(5);
      const debugSnapshot = await debugQuery.get();
      console.log(`Debug: Total documents in collection (no filters, limit 5): ${debugSnapshot.size}`);
      if (debugSnapshot.size > 0) {
        console.log('Debug: Sample document structure:');
        debugSnapshot.forEach(doc => {
          const data = doc.data();
          console.log(`  Doc ${doc.id}: lang=${data.lang}, mark=${data.mark}, hasHelp=${!!data.help}, hasSrc=${!!data.src}, hasCode=${!!data.code}`);
        });
      }
    }
    
    const items = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      // Don't filter by taskId - include all items that have help and code
      if (data.help && (data.src || data.code)) {
        items.push({
          id: doc.id,
          taskId: data.taskId || null,
          lang: data.lang,
          mark: data.mark,
          ...data
        });
      }
    });
    
    console.log(`Found ${items.length} items with help and code fields`);
    
    // If no items found, let's debug what's in the collection
    if (items.length === 0 && snapshot.size > 0) {
      console.log('Sample of documents found (first 3):');
      let count = 0;
      snapshot.forEach(doc => {
        if (count < 3) {
          const data = doc.data();
          console.log(`  Doc ${doc.id}:`, {
            hasHelp: !!data.help,
            hasSrc: !!data.src,
            hasCode: !!data.code,
            hasTaskId: !!data.taskId,
            lang: data.lang,
            mark: data.mark
          });
          count++;
        }
      });
    }
    
    return items;
  } catch (error) {
    console.error('Error fetching items from Firestore:', error);
    throw error;
  }
}



async function main() {
  try {
    // Check for OPENAI_API_KEY if using vector mode
    if (storeMode === 'vector' && !process.env.OPENAI_API_KEY) {
      console.error('Error: OPENAI_API_KEY environment variable is required for vector mode');
      console.error('Please set it in your .env file or environment');
      console.error('To use file mode instead, add --store-mode file');
      process.exit(1);
    }

    console.log(`Processing items for user: ${userId}`);
    console.log(`Items collection: ${itemsCollection}`);
    
    // Initialize statistics tracking
    const statistics = {
      languageCounts: {},     // Track count by language
      totalProcessed: 0,      // Total items processed
      totalItems: 0,          // Total items found
      itemsWithHelpArray: 0,  // Items that have a help array
      itemsWithEmptyHelp: 0,  // Items with empty help array
      itemsWithSrcCode: 0,    // Items with code in the src field
      skippedNoCode: 0,       // Items without code
      totalDialogPairs: 0,    // Total number of dialog pairs extracted
      totalMessages: 0        // Total individual messages processed
    };

    // Array to store training examples
    const trainingExamples = [];

    // Array to track skipped items with reasons
    const skippedItems: Array<{id: string, reason: string}> = [];

    // Determine languages to process
    const languagesToProcess = filterByLanguage
      ? [languageFilter]
      : ['0159', '0002', '0011', '0012', '0165']; // Add other languages as needed

    // Process each language
    for (const lang of languagesToProcess) {
      try {
        console.log(`\nProcessing items for language: L${lang} with mark: ${markValue}`);

        // Fetch items from the items collection
        const items = await fetchItemsFromFirestore(lang, markValue, limit);
        console.log(`Found ${items.length} items for L${lang}`);
        statistics.totalItems += items.length;

        // Process the items directly
        console.log(`Processing ${items.length} items for L${lang}`);

        for (const item of items) {
          const itemId = item.id;

          // Parse help field
          let help = [];
          try {
            help = JSON.parse(item.help);
          } catch (e) {
            console.log(`Item ${itemId} has invalid help JSON: ${e.message}`);
            continue;
          }

          // Check if this document has a valid help array
          if (!help || !Array.isArray(help)) {
            console.log(`Item ${itemId} has no help array`);
            continue;
          }

          if (help.length === 0) {
            console.log(`Item ${itemId} has an empty help array`);
            statistics.itemsWithEmptyHelp++;
            continue;
          }

          statistics.itemsWithHelpArray++;
          console.log(
            `Processing item ${itemId} with ${help.length} help messages`,
            console.log("help=" + JSON.stringify(help, null, 2)),
          );

          // Get the code - always unparse the AST
          let code: string;

          if (!item.code || typeof item.code !== 'object') {
            console.log(`No AST code in item ${itemId}`);
            skippedItems.push({ id: itemId, reason: 'No AST code' });
            statistics.skippedNoCode++;
            continue;
          }

          const lexicon = getCachedLexicon(lang);
          if (!lexicon) {
            console.log(`No lexicon for L${lang}, skipping ${itemId}`);
            skippedItems.push({ id: itemId, reason: `No lexicon for L${lang}` });
            statistics.skippedNoCode++;
            continue;
          }

          try {
            code = unparse(item.code, lexicon, {}).trim();
            // Check for unparse stubs
            const stubs = code.match(/\/\*\s*[A-Z][A-Z0-9_]*\s*\*\//g);
            if (stubs) {
              console.warn(`  ⤫ ${itemId}: unparse produced ${stubs.length} stub(s), skipping`);
              skippedItems.push({ id: itemId, reason: `Unparse produced ${stubs.length} stub(s)` });
              statistics.skippedNoCode++;
              continue;
            }
          } catch (e: any) {
            console.warn(`  ⚠️ ${itemId}: unparse failed: ${e.message}`);
            skippedItems.push({ id: itemId, reason: `Unparse failed: ${e.message}` });
            statistics.skippedNoCode++;
            continue;
          }

          // Skip if code is too short
          if (code.length < 2) {
            console.log(`Code too short in item ${itemId}`);
            skippedItems.push({ id: itemId, reason: `Code too short (${code.length} chars, min 2)` });
            statistics.skippedNoCode++;
            continue;
          }

          // Track items with valid source code
          statistics.itemsWithSrcCode++;
          statistics.languageCounts[lang] = (statistics.languageCounts[lang] || 0) + 1;

          // Process the help array to construct dialog messages
          const dialogMessages = [];
          let dialogPairs = 0;

          // Help array is in chronological order. We need to preserve this order
          // for the chat transcript while ensuring user/bot messages are correctly paired
          for (let i = 0; i < help.length; i++) {
            const message = help[i];
            
            // Skip invalid messages
            if (!message || typeof message !== 'object') continue;

            // Add user messages
            if (message.type === 'user' && message.user) {
              dialogMessages.push({
                role: 'user',
                content: message.user
              });
              
              // Look for a corresponding bot message that follows
              if (i+1 < help.length && help[i+1].type === 'bot' && help[i+1].help) {
                dialogPairs++;
              }
            }
            // Add bot messages
            else if (message.type === 'bot' && message.help) {
              const helpObj = message.help;
              let content = '';

              if (helpObj.type === 'text' && helpObj.text) {
                content = helpObj.text;
              } else if (helpObj.type === 'code' && helpObj.text) {
                // Format code with markdown
                content = `\`\`\`${helpObj.language || 'ocaml'}\n${helpObj.text}\n\`\`\``;
              }

              if (content) {
                dialogMessages.push({
                  role: 'assistant',
                  content: content
                });
              }
            }
          }

          // We've already counted the dialog pairs while parsing the messages

          statistics.totalDialogPairs += dialogPairs;
          statistics.totalMessages += dialogMessages.length;

          // Skip if there are no user messages at all
          const userMessages = dialogMessages.filter(m => m.role === 'user');
          if (userMessages.length === 0) {
            console.log(`Item ${itemId} has no user messages`);
            skippedItems.push({ id: itemId, reason: 'No user messages in help dialog' });
            continue;
          }

          // Generate explanation and expected output
          const explanation = generateExplanation(code, `L${lang}`);
          const expected_output = determineExpectedOutput(code);

          // Add to training examples. `prompt` and `model` are read by the corpus sweep, the
          // provenance backfill, and the drift gate below; rows without them are invisible to
          // the first two and pass the third unchecked. The item's own prompt is the authored
          // one; the joined user turns are the fallback for items written before it was stored.
          // The example number create-items-from-prompts stamped on the item: the gate reports by it,
          // so its `--only` hint is the list create-items takes.
          if (item.exampleNumber != null) exampleNumbers.set(itemId, Number(item.exampleNumber));
          trainingExamples.push({
            prompt: String(item.prompt || '').trim() || extractTaskFromMessages(dialogMessages),
            model: item.model ?? null,
            messages: dialogMessages,
            code,
            explanation,
            expected_output,
            lang,
            item_id: itemId,
            task_id: item.taskId,
            usage_count: item.count || 1,
            pair_count: dialogPairs
          });

          statistics.totalProcessed++;

          if (statistics.totalProcessed % 50 === 0) {
            console.log(`Processed ${statistics.totalProcessed} items with dialog so far...`);
          }
        }
      } catch (error) {
        console.error(`Error processing language L${lang}:`, error);
        // Continue with next language
        continue;
      }
    }

    console.log(
      "main",
      "trainingExamples=" + JSON.stringify(trainingExamples, null, 2),
    );

    // Print detailed statistics report
    console.log('\n===== FINAL STATISTICS =====');
    console.log(`Total items found: ${statistics.totalItems}`);
    console.log(`Items with help array: ${statistics.itemsWithHelpArray}`);
    console.log(`Items with empty help array: ${statistics.itemsWithEmptyHelp}`);
    console.log(`Items with valid source code: ${statistics.itemsWithSrcCode}`);
    console.log(`Items processed with dialog: ${statistics.totalProcessed}`);
    console.log(`Total dialog pairs: ${statistics.totalDialogPairs}`);
    console.log(`Total messages: ${statistics.totalMessages}`);
    console.log(`Skipped (no code): ${statistics.skippedNoCode}`);

    console.log('\nLanguage distribution:');
    for (const [lang, count] of Object.entries(statistics.languageCounts).sort((a, b) => b[1] - a[1])) {
      const percentage = (count / statistics.totalProcessed * 100).toFixed(2);
      console.log(`  - L${lang}: ${count} (${percentage}%)`);
    }
    console.log('======================\n');

    // Sort by usage count (most used first)
    trainingExamples.sort((a, b) => b.usage_count - a.usage_count);

    // Gate: a language that ships a corpus gate must pass it before any of its rows are written.
    // A failure stores nothing — not even other languages' rows — so a run is all or none.
    if (storeMode === 'vector') {
      const byLang = new Map<string, any[]>();
      for (const ex of trainingExamples) {
        if (!byLang.has(ex.lang)) byLang.set(ex.lang, []);
        byLang.get(ex.lang)!.push(ex);
      }
      const failed: string[] = [];
      for (const [lang, examples] of byLang) {
        const dir = findCorpusGate(lang);
        if (!dir) continue;
        console.log(`\nCorpus gate for L${lang} (${dir}) on ${examples.length} examples...`);
        const gate = runCorpusGate(dir, examples.map((ex) => ({
          label: exampleNumbers.has(ex.item_id) ? String(exampleNumbers.get(ex.item_id)) : `${ex.item_id} "${String(ex.prompt || '').slice(0, 60)}"`,
          code: ex.code,
        })));
        console.log(gate.output.split('\n').map((l) => `  ${l}`).join('\n'));
        if (!gate.ok) failed.push(lang);
      }
      if (failed.length) {
        if (args.includes('--skip-gate')) {
          console.warn(`\n⚠️  Corpus gate failed for ${failed.map((l) => `L${l}`).join(', ')}; storing anyway (--skip-gate).`);
        } else {
          console.error(`\n✗ Corpus gate failed for ${failed.map((l) => `L${l}`).join(', ')}: nothing stored. Regenerate the failing examples (create-items-from-prompts --refresh --only …), or pass --skip-gate to store anyway.`);
          process.exit(1);
        }
      }
    }

    // Store the examples based on the selected mode
    if (storeMode === 'vector') {
      // Store in vector database
      const db = admin.firestore();
      const storageStats = await storeExamplesInVectorDatabase(trainingExamples, db, languageFilter || 'all', skippedItems);
      
      console.log('\n===== VECTOR STORAGE STATISTICS =====');
      console.log(`Total examples: ${storageStats.total}`);
      console.log(`Successfully stored: ${storageStats.stored}`);
      console.log(`Errors: ${storageStats.errors}`);
      console.log(`Skipped: ${storageStats.skipped}`);
      console.log(`Batches that needed a retry: ${storageStats.retried}`);
      console.log(`Older rows removed (items edited since embedded): ${storageStats.replaced}`);
      if (storageStats.failedBatches.length) {
        console.log(`Failed batches: ${storageStats.failedBatches.join(', ')} — re-run the same command; documents are written by id, so a re-run fills the gaps without duplicates`);
      }
      console.log('=====================================\n');
      if (storageStats.errors > 0) process.exitCode = 1;
      
      if (storageStats.stored > 0) {
        console.log('✅ Training examples successfully stored in vector database');
        console.log(`Collection: ${vectorCollection}`);
        console.log('\n⚠️  Important: Deploy Firestore indexes for vector search');
        console.log('Run: firebase deploy --only firestore:indexes');
        console.log('This will enable vector similarity search on the embedding field');
      }
    } else {
      // Store in file (existing logic)
      // Make sure the output directory exists
      const fullOutputDir = path.resolve(process.cwd(), outputDir);
      if (!fs.existsSync(fullOutputDir)) {
        fs.mkdirSync(fullOutputDir, { recursive: true });
      }

      // Convert to the new markdown-like format
      const markdownExamples = convertToMarkdownFormat(trainingExamples);
      
      // Output path always uses .md extension
      const outputPathMd = path.join(fullOutputDir, `l${languageFilter || 'all'}-training-examples.md`);
      
      // Write to markdown file
      fs.writeFileSync(
        outputPathMd,
        markdownExamples,
        'utf8'
      );

      if (filterByLanguage) {
        console.log(`Successfully generated ${trainingExamples.length} training examples for language ${languageFilter}.`);
      } else {
        console.log(`Successfully generated ${trainingExamples.length} training examples across all languages.`);
      }
      console.log(`Generated file: ${outputPathMd}`);
    }

  } catch (error) {
    console.error('Error generating training examples:', error);
    process.exit(1);
  }

  // Clean exit (non-zero when any batch failed)
  process.exit(process.exitCode ?? 0);
}

// Run the script
main();
