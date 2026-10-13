#!/usr/bin/env node

/**
 * Generate code examples and create them as items in Firestore.
 *
 * Single-pass script combining code generation + item creation:
 * 1. Extracts prompts from the language's examples.md (served asset, or a local checkout —
 *    see scripts/lang-examples.ts)
 * 2. Generates code for each prompt via generateCode(). An example written as
 *    `**Turn 1** — …` / `**Turn 2** — …` is a CONVERSATION: each turn is its own
 *    request, and every turn after the first edits the source the previous one
 *    produced (L0182: turn 1 takes a survey, turn 2 answers that same item). One
 *    example is still one item — the last turn's source — whose recorded help is
 *    every turn.
 * 3. Normalizes lrn-id references to the example id
 * 4. Recompiles the normalized source to get a real taskId
 * 5. Creates the item via createItem() library function, which handles Firestore write + billing
 *
 * Usage:
 *   npx tsx scripts/generate-and-create-items.ts --lang <code> --mark <number> [options]
 *
 * Required:
 *   --lang <code>        Language code (required)
 *   --mark <number>      Training mark to assign (required)
 *
 * Options:
 *   --limit <number>     Maximum examples to process (default: all)
 *   --start <index>      Start from example index (default: 0)
 *   --refresh            Delete existing items of same lang/mark before creating new ones, and
 *                        their rows in the vector store, so retrieval cannot hand the generator
 *                        the program being replaced
 *   --only <n,n,...>     Re-run only these example numbers (labels from examples.md);
 *                        with --refresh, deletes only those examples' items
 *   --scope-gate         Allow the scope gate to re-route out-of-scope prompts (default: pinned to --lang)
 *   --timeout <seconds>  Per-step wall-clock cap; a stalled request fails that attempt (default: 300)
 *   --compile-timeout <seconds>  Cap on the /data compile check, which normally answers in
 *                        under a second (default: 60)
 *   --attempts <n>       Attempts per example before it counts as failed (default: 3). A failed
 *                        attempt — a stalled request, an expired token, a program that did not
 *                        compile — is retried with a fresh token; an item it already created is
 *                        deleted first, so a retry never leaves a duplicate.
 *   --vector-collection <name>  The vector store --refresh clears replaced items from
 *                        (default: training_examples, as generate-embeddings-from-examples)
 *   --dry-run            Extract and print prompts only, no generation/creation
 *   --output <path>      Write a JSON audit log here (default: none — nothing reads it back)
 *
 * Note: Items are created under the authenticated user's own account (auth.uid);
 * there is no --user override. Every item created counts as one billable item and
 * will increment the account's monthly item quota and (for paid plans) emit Stripe meter events.
 */

import "./eval-env"; // Production bootstrap (MUST be first)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import admin from "firebase-admin";
import { generateCodeForRequest } from "../src/lib/code-generation/generate-for-request";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { getBaseUrlForApi } from "../src/lib/api";
import { createItem, parseCode, postTask } from "../src/pages/api/resolvers";
import { readExamplesMarkdown } from "./lang-examples";
import { dialectFingerprint, formatFingerprint, type DialectFingerprint } from "./eval-dialect-fingerprint";

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
  console.error("Usage: npx tsx scripts/generate-and-create-items.ts --lang <code> --mark <number> [options]");
  process.exit(1);
}

const langCode = langStr;
const markValue = parseInt(markStr);

const limit = args.includes("--limit")
  ? parseInt(args[args.indexOf("--limit") + 1])
  : Infinity;

const startIdx = args.includes("--start")
  ? parseInt(args[args.indexOf("--start") + 1])
  : 0;

const refresh = args.includes("--refresh");

/**
 * PROVENANCE — what produced this corpus entry, recorded ON the item.
 *
 * A corpus row is evidence about a (prompt, MODEL, DIALECT) triple, and it was recording only the
 * prompt. That makes a later regeneration uninterpretable: when a re-run differs from the stored
 * code, nothing distinguishes "the pipeline regressed" from "MODEL_PRIORITY moved months ago" —
 * and it has moved (L0175 routes to gpt-5.6-sol today, L0177 to gpt-5.6-terra, the rest
 * Sonnet/Haiku). The corpus health sweep cannot tell drift from a routing change without this.
 *
 * The dialect fingerprint is resolved ONCE per run, not per example: it is one HTTP fetch of the
 * language's instructions.md, identical for every example in the run.
 */
let runDialect: DialectFingerprint | null = null;

// Re-run named examples rather than a slice. --start/--limit index the extracted
// LIST, which is not the example's label, so repairing "example 66" meant
// counting entries in examples.md by hand. Takes labels: --only 11,66,109.
// With --refresh, only those examples' items are deleted; the rest of the
// corpus is left alone.
const only: Set<number> | null = args.includes("--only")
  ? new Set(
      args[args.indexOf("--only") + 1]
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n)),
    )
  : null;

// The request orchestrator re-routes a fresh create whose prompt reads as
// out-of-scope for --lang. For a training harness that is wrong: a re-routed
// example silently lands in another language's corpus. Pin the head by default;
// --scope-gate restores the production behavior.
if (!args.includes("--scope-gate")) {
  process.env.SCOPE_GATE_ENABLED = "false";
}
const dryRun = args.includes("--dry-run");

const vectorCollection = args.includes("--vector-collection")
  ? args[args.indexOf("--vector-collection") + 1]
  : "training_examples";

// Wall-clock cap per network step. Nothing in this script timed out, so a single
// stalled request blocked the whole run indefinitely — observed hanging a batch
// driver for 14 minutes with the process asleep on 0.4s of CPU. A timed-out
// example is recorded as an error and the run moves on.
const stepTimeoutMs = (args.includes("--timeout")
  ? parseInt(args[args.indexOf("--timeout") + 1], 10)
  : 300) * 1000;

// A compile answers in under a second; a request that has not answered in a minute is stuck
// (2026-10-09: one /data request held an example for the full 300s), and is better retried.
const compileTimeoutMs = (args.includes("--compile-timeout")
  ? parseInt(args[args.indexOf("--compile-timeout") + 1], 10)
  : 60) * 1000;

// Each example gets this many attempts. The target is that every example in a run lands: a
// 2026-10-09 run lost 40 of 124 to one stuck request and a laptop sleep (stale sockets, then an
// expired token), none of which a retry with a fresh token would have failed.
const maxAttempts = Math.max(1, args.includes("--attempts")
  ? parseInt(args[args.indexOf("--attempts") + 1], 10)
  : 3);

// Opt-in. This script creates the items itself — the audit log is a diagnostic,
// not an input, and nothing reads it back (the two-step run-codegen ->
// upload-codegen-mapping pipeline that consumed a mapping file is retired). It
// used to be written on every run, which left training/data/ accumulating
// hundreds of KB of superseded logs. Pass --output to get one.
const outputPath = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : null;

interface TrainingExample {
  id: string;
  /** The whole conversation, turns joined — what the item records as its prompt. */
  prompt: string;
  /** One entry per request. Single-turn examples have exactly one. */
  turns: string[];
  exampleNumber: number;
}

interface AuditLogEntry {
  exampleId: string;
  exampleNumber: number;
  firestoreItemId?: string;
  prompt: string;
  generatedCode?: string;
  normalizedCode?: string;
  compiled: boolean;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  // Repair turns the generator needed. 0 = compiled first try. Without it, "did
  // this need fixing?" was only inferable from an inflated token count.
  fixAttempts?: number | null;
  // Per-turn cost and repairs, one entry per request made. A multi-turn example
  // spends on every turn, and a single top-level `usage` reports only the last —
  // which understates a two-turn example by about half.
  turns: Array<{
    prompt: string;
    model?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    fixAttempts?: number | null;
    /** Whether this turn's source compiled. Only the last turn becomes the item. */
    compiled?: boolean;
  }>;
  taskId?: string | null;
  upstreamLangs?: string[];
  /** Which model actually wrote this. See PROVENANCE below. */
  model?: string | null;
  created?: boolean;
  error?: string;
  timestamp: string;
}

// A turn marker inside an example: "**Turn 2** — Pick the two you would fund first."
// Some examples are a CONVERSATION, not a single request (L0182: turn 1 takes a
// survey, turn 2 answers the item turn 1 made). Written as one numbered entry
// whose first line carries the marker and whose continuation lines carry the
// rest, so the turns of an example stay visibly one example.
const TURN_MARKER = /^\*\*Turn\s+\d+\*\*\s*(?:[—–-]\s*)?(.*)$/;

/** Strip a leading "**Turn N** — " marker; return the prompt text either way. */
function stripTurnMarker(text: string): string {
  const m = text.match(TURN_MARKER);
  return (m ? m[1] : text).trim();
}

/**
 * Extract examples from the language's examples.md content (see scripts/lang-examples.ts for
 * where that content comes from — a local checkout, or the served asset).
 */
function extractExamples(content: string, langCode: string): TrainingExample[] {
  const examples: TrainingExample[] = [];

  const lines = content.split("\n");
  let exampleCount = 0;
  // The example whose continuation lines we are still reading, if any.
  let open: TrainingExample | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d+[a-z]?)\.\s+(.+)$/);
    if (match) {
      exampleCount++;
      const prompt = stripTurnMarker(match[2]);

      // Number the example by the LABEL written in examples.md, not by scan
      // order. A sub-lettered entry ("86a.") advances the counter without
      // advancing the label, and the two then disagree for every example after
      // it — which silently misnames items and misreports which prompt failed.
      // Fall back to the counter only for a label we can't read as a number.
      const label = Number.parseInt(match[1], 10);
      const exampleNumber = Number.isFinite(label) ? label : exampleCount;

      open = {
        id: `${langCode}-example-${exampleNumber}`,
        prompt,
        turns: [prompt],
        exampleNumber,
      };
      examples.push(open);
      continue;
    }

    // A later turn of the example we are inside. Only a turn MARKER continues an
    // example — an unmarked continuation line is prose (or a wrapped prompt), and
    // treating it as a turn would send the document's own commentary to the
    // generator as a request.
    if (open && TURN_MARKER.test(trimmed)) {
      const turn = stripTurnMarker(trimmed);
      if (turn) {
        open.turns.push(turn);
        open.prompt = open.turns.join("\n\n");
      }
      continue;
    }

    // Anything else ends the example: the turns of one example are written
    // together, so a blank line or a heading means the next marker belongs to
    // whatever comes after it, not to this one.
    if (!trimmed || trimmed.startsWith("#")) {
      open = null;
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
 * Reject if `work` outruns the step budget.
 *
 * The underlying request is NOT cancelled — an in-flight LLM or Firestore call
 * has no abort handle here — so a timed-out step may still be running when we
 * move on. That is why main() exits explicitly: an abandoned socket would
 * otherwise keep the event loop alive after the audit log is written.
 */
function withTimeout<T>(work: Promise<T>, label: string, ms = stepTimeoutMs): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([work, bell]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Ask the api to evaluate a task and report whether it actually compiled.
 *
 * postTask returning an id only means the AST was stored. Gating `compiled` on
 * a posted id reported a "compilation rate" that was really a post-success rate.
 *
 * The status code is no better: /data answers 200 unconditionally
 * (routes/data.js `res.status(200).json(createSuccessResponse({ data }))`) and
 * a compile failure rides inside that 200 as `{ data: null, errors: [...] }`.
 * Read the envelope: compiled means no errors AND a non-null payload.
 */
async function taskCompiles(
  taskId: string,
  accessToken: string,
): Promise<{ compiled: boolean; error?: string; data?: unknown }> {
  try {
    const resp = await fetch(
      // ?refresh=1 recompiles rather than answering from the compile cache. A
      // taskId is content-addressed over {lang, code} and carries no compiler
      // version, so a verdict cached before a language shipped a breaking change
      // keeps returning a clean 200 — a program the checker now rejects reads as
      // a PASS. This check exists to assert "this compiles", so it must reach the
      // compiler, not the record. (L0172, 2026-09-04: three regenerated programs
      // came out byte-identical to April ones and inherited their April verdicts.)
      `${getBaseUrlForApi()}/data?id=${encodeURIComponent(taskId)}&refresh=1`,
      { headers: { Authorization: accessToken }, signal: AbortSignal.timeout(compileTimeoutMs) },
    );
    if (resp.status !== 200) {
      return { compiled: false, error: `/data returned ${resp.status}` };
    }
    const body: any = await resp.json();
    const obj = body?.data;
    const errors = Array.isArray(obj?.errors) ? obj.errors : [];
    if (errors.length > 0) {
      const message = errors
        .map((e: any) => (typeof e === "string" ? e : e?.message || JSON.stringify(e)))
        .join("; ");
      return { compiled: false, error: `Compile error: ${message}` };
    }
    if (obj?.data == null) {
      return { compiled: false, error: "/data returned no compile output" };
    }
    // The compile output itself, not just the verdict: a later turn is handed it
    // as `currentData`, which for some dialects is the only place the values it
    // must edit against exist (L0182's ideas are fetched by the compiler, and
    // never appear in the program).
    return { compiled: true, data: obj.data };
  } catch (x: any) {
    return { compiled: false, error: `/data fetch failed: ${x?.message || x}` };
  }
}

/**
 * Delete existing items for this lang/mark
 */
/**
 * Delete the items this run replaces, and their rows in the vector store.
 *
 * The rows go too because retrieval reads them: a regenerated example whose old row survives is
 * generated with its own old program as the nearest example, and copies it — on 2026-10-12 three
 * L0186 regenerations (107, 109, 125) reproduced the program they were meant to replace until the
 * row was deleted by hand. Rows are keyed `lang_itemId_taskId` but found by `item_id`, which the
 * embedding script writes on every row.
 */
async function deleteExistingItems(db: admin.firestore.Firestore, userId: string, lang: string, markValue: number): Promise<number> {
  console.log(`Querying existing L${lang} items with mark=${markValue} for user ${userId}...`);

  const query = db
    .collection("users")
    .doc(userId)
    .collection("items")
    .where("lang", "==", lang)
    .where("mark", "==", markValue);

  const snapshot = await query.get();
  let deleted = 0;

  // Under --only, a re-run replaces just the named examples. Deleting the whole
  // mark would throw away the corpus we're repairing.
  const docs = only
    ? snapshot.docs.filter((d) => only.has(Number(d.data().exampleNumber)))
    : snapshot.docs;

  console.log(`Found ${docs.length} existing items to delete`);

  let vectors = 0;
  for (const doc of docs) {
    const rows = await db.collection(vectorCollection).where("item_id", "==", doc.id).get();
    for (const row of rows.docs) {
      if (!dryRun) await row.ref.delete();
      vectors++;
    }
    if (!dryRun) {
      await doc.ref.delete();
    }
    deleted++;
  }
  console.log(`${dryRun ? "Would delete" : "Deleted"} ${vectors} ${vectorCollection} row(s) for those items`);

  return deleted;
}

/**
 * Process one example: generate code, normalize, recompile, create item
 */
async function processExample(
  example: TrainingExample,
  auth: any,
  db: admin.firestore.Firestore
): Promise<AuditLogEntry> {
  const entry: AuditLogEntry = {
    exampleId: example.id,
    exampleNumber: example.exampleNumber,
    prompt: example.prompt,
    compiled: false,
    turns: [],
    upstreamLangs: [],
    timestamp: new Date().toISOString(),
  };

  try {
    // Same parse wiring the resolver uses (generate-for-request.ts): itemId is
    // the one parse-time value. Stored user credentials are retired.
    const publicValues: Record<string, string> = { itemId: example.id };

    /**
     * Compile one turn's source under THIS example's identity, and hand back what
     * it compiled to.
     *
     * Recompiles the normalized HEAD and re-attaches the upstream segments: only
     * segment 0 is ours to rewrite, and re-posting the head alone would drop the
     * chain and with it the upstream data. Same shape as the editor's hand-edit
     * path (src/components/editor.tsx).
     *
     * Run for EVERY turn, not just the last, because the next turn is generated
     * against this turn's data model — and that data model has to come from a
     * compile under the real `itemId` (publicValues above). A dialect that draws
     * per session keys on it: L0182's `you-can-choose` picks one of twelve
     * versions from `session-id`, so a data model compiled under generation's
     * `verify-itemid` sentinel would describe a survey this item never showed.
     */
    async function compileTurn(
      src: string,
      upstreamSegments: string[],
      label: string,
    ): Promise<{ taskId?: string; data?: unknown; error?: string }> {
      const parseResult = await withTimeout(
        parseCode({
          lang: langCode,
          src,
          publicValues,
          accessToken: auth.token,
        }),
        `parse ${label}`,
      );

      if (parseResult.errors && parseResult.errors.length > 0) {
        return { error: `Parse error: ${parseResult.errors[0].message}` };
      }

      const postResult = await withTimeout(
        postTask({
          auth,
          task: {
            lang: langCode,
            code: JSON.parse(parseResult.code),
          },
          ephemeral: false,
          isPublic: false,
        }),
        `postTask ${label}`,
      );

      if (!postResult || !postResult.id) {
        return { error: "postTask returned no taskId" };
      }

      const taskId = upstreamSegments.length > 0
        ? [postResult.id, ...upstreamSegments].join("+")
        : postResult.id;

      // A posted task is not a compiled one. Ask the api to actually evaluate the
      // chain — that is the only thing that proves the program runs.
      const check = await taskCompiles(taskId, auth.token);
      if (!check.compiled) {
        return { taskId, error: check.error || "task posted but did not compile" };
      }
      return { taskId, data: check.data ?? null };
    }

    // Step 1: Generate, one request per turn. This is the REQUEST-level
    // orchestrator, not the per-stage generator — it runs the scope gate, the
    // composition planner and its permission fence, generates any upstream
    // stages, and returns a `head+upstream` chained taskId. Importing the
    // per-stage generator here is what silently made every generated item atomic.
    //
    // A later turn EDITS what the previous one wrote, and is given both halves of
    // that state: the source as `currentSrc` and what the source COMPILED TO as
    // `currentData` — exactly what an update against a live item can see. The
    // second half is not a nicety: L0182 names a survey and nothing else, its
    // ideas being fetched by the compiler, so "take the survey" is answerable only
    // from the data model. Without it the model has never seen an idea, and
    // (correctly) declines to invent one.
    //
    // Only the LAST turn's source becomes the item. The intermediate states are
    // real requests, and really compiled, but not separate items: one example is
    // one item, and its recorded conversation (help) is every turn.
    let genResult: any = null;
    let normalizedCode = "";
    let currentData: unknown = null;

    for (let t = 0; t < example.turns.length; t++) {
      const turnPrompt = example.turns[t];
      const multi = example.turns.length > 1;
      const label = multi ? `${example.id} turn ${t + 1}` : example.id;
      const fail = (message: string) => {
        entry.error = multi ? `turn ${t + 1}: ${message}` : message;
        return entry;
      };

      genResult = await withTimeout(
        generateCodeForRequest({
          auth,
          prompt: turnPrompt,
          language: langCode,
          options: {
            maxTokens: 4096,
          },
          // The previous turn's source, normalized — so an lrn-id the first turn
          // wrote is already the example id the edit builds on.
          currentSrc: t === 0 ? null : normalizedCode,
          currentData,
          itemId: example.id,
        }),
        `generate ${label}`,
      );

      if (genResult.errors && genResult.errors.length > 0) {
        return fail(genResult.errors[0].message);
      }

      if (!genResult.src) {
        return fail("generateCodeForRequest returned empty source");
      }

      // Step 2: Normalize lrn-id to the example.id
      normalizedCode = normalizeCode(genResult.src, example.id);

      // Step 3: Compile this turn — the verdict for the last turn, the next
      // turn's `currentData` for any before it.
      const upstreamSegments = String(genResult.taskId || "").split("+").slice(1);
      const compiledTurn = await compileTurn(normalizedCode, upstreamSegments, label);

      entry.turns.push({
        prompt: turnPrompt,
        model: genResult.model || null,
        usage: genResult.usage || null,
        fixAttempts: genResult.fixAttempts ?? null,
        compiled: !compiledTurn.error,
      });

      entry.taskId = compiledTurn.taskId ?? null;
      if (compiledTurn.error) {
        return fail(compiledTurn.error);
      }
      currentData = compiledTurn.data ?? null;
    }

    // Top-level provenance describes the state that became the item — the last
    // turn. Per-turn cost and repairs are in entry.turns.
    entry.generatedCode = genResult.src || "";
    entry.usage = genResult.usage || null;
    entry.model = genResult.model || null;
    entry.fixAttempts = genResult.fixAttempts ?? null;
    entry.upstreamLangs = Array.isArray(genResult.upstreamLangs) ? genResult.upstreamLangs : [];
    entry.normalizedCode = normalizedCode;
    entry.compiled = true;

    // Step 4: Create the item via createItem() — this handles Firestore write + billing
    const itemName = String(example.exampleNumber).padStart(3, "0");
    // The recorded conversation is every turn, in order. generate-embeddings-from-examples
    // joins an example's user messages back into one prompt, so a two-turn example
    // reaches the corpus as the conversation that produced the code — which is what
    // the model has to learn to answer.
    const helpEntry = JSON.stringify(
      example.turns.map((turn) => ({
        type: "user",
        user: turn,
        help: { text: turn },
        timestamp: new Date().toISOString(),
      })),
    );
    const newItem = await withTimeout(createItem({
      auth,
      lang: langCode,
      name: itemName,
      taskId: entry.taskId,
      mark: markValue,
      help: helpEntry,
      source: "codegen-mapping",
      client: "training",
      // Without this the item and its version record lose the chain, and the
      // first compile with form data slices the upstream off (buildLayerCount).
      upstreamLangs: entry.upstreamLangs,
    }), `createItem ${example.id}`);

    entry.firestoreItemId = newItem.id;
    entry.created = true;

    // Step 5: Merge in audit metadata (prompt for reference, exampleNumber for audit).
    // Capped like every other step: on 2026-10-09 this write hung for 946s.
    await withTimeout(db
      .collection("users")
      .doc(auth.uid)
      .collection("items")
      .doc(newItem.id)
      .set(
        {
          prompt: example.prompt,
          exampleNumber: example.exampleNumber,
          // Provenance — see the note at runDialect. Written here rather than passed through
          // createItem so the shared resolver keeps one shape for every caller.
          model: entry.model ?? null,
          dialect: runDialect ? { hash: runDialect.hash, revised: runDialect.revised ?? null } : null,
          generatedAt: new Date().toISOString(),
        },
        { merge: true }
      ), `metadata ${example.id}`);

    return entry;
  } catch (error: any) {
    entry.error = error.message || String(error);
    return entry;
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

  // One fetch for the whole run; a failure costs attribution, never the run (dialectFingerprint
  // returns {hash:"unknown"} rather than throwing).
  runDialect = await dialectFingerprint(langCode);
  console.log(`[provenance] L${langCode} dialect ${formatFingerprint(runDialect)}`);

  const examples = extractExamples(examplesMd, langCode);
  const slice = only
    ? examples.filter((ex) => only.has(ex.exampleNumber))
    : examples.slice(startIdx, Math.min(startIdx + limit, examples.length));

  if (only) {
    const missing = [...only].filter((n) => !slice.some((ex) => ex.exampleNumber === n));
    if (missing.length > 0) {
      console.error(`Error: --only names examples not in examples.md: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  console.log(`Extracted ${examples.length} examples, processing ${slice.length}${dryRun ? " (dry run)" : ""}`);

  if (dryRun) {
    console.log("\nExtracted prompts:");
    slice.forEach((ex) => {
      console.log(`\n[${ex.exampleNumber}] ${ex.id}:`);
      ex.turns.forEach((turn, i) => {
        console.log(ex.turns.length > 1 ? `  turn ${i + 1}: ${turn}` : `  ${turn}`);
      });
    });
    return;
  }

  // Get authentication — default to EVAL_API_KEY (the dedicated eval account) so corpus
  // items land under EVAL_UID, not a personal account. Fall back to GC_API_KEY_SECRET
  // for backward compatibility.
  const gcApiKey = process.env.EVAL_API_KEY || process.env.GC_API_KEY_SECRET;
  if (!gcApiKey) {
    console.error("Error: EVAL_API_KEY or GC_API_KEY_SECRET environment variable not set");
    process.exit(1);
  }

  // macOS: keep the machine awake for the run. A sleep mid-run leaves every open socket stale
  // and lets the access token expire, and each example after it fails.
  if (process.platform === "darwin" && !args.includes("--no-caffeinate")) {
    try {
      spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
    } catch {
      console.warn("caffeinate unavailable: keep the machine awake for the run");
    }
  }

  let credentials: any;
  try {
    credentials = await getCredentialsForApiKey(gcApiKey);
  } catch (error: any) {
    console.error("Error getting credentials:", error.message);
    process.exit(1);
  }

  const auth = {
    token: credentials.idToken,
    uid: credentials.uid,
  };

  // Initialize Firestore for --refresh
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: "graffiticode-app",
      credential: admin.credential.applicationDefault(),
    });
  }
  const db = admin.firestore();

  console.log(`Generating and creating items for L${langCode} with mark=${markValue}`);
  console.log(`User: ${auth.uid}`);

  // Optionally delete existing items
  if (refresh) {
    const deleted = await deleteExistingItems(db, auth.uid, langCode, markValue);
    console.log(`Deleted ${deleted} existing items`);
  }

  const auditLog: AuditLogEntry[] = [];
  let compiledCount = 0;
  let createdCount = 0;
  let errorCount = 0;
  let retriedCount = 0;
  const failed: number[] = [];

  // A fresh token for every attempt: getCredentialsForApiKey caches one and re-exchanges the key
  // when it is within five minutes of expiry, so a long run (or one that slept) never posts with
  // an expired token.
  const refreshAuth = async () => {
    const fresh = await withTimeout(getCredentialsForApiKey(gcApiKey), "token refresh");
    auth.token = fresh.idToken;
  };

  for (let i = 0; i < slice.length; i++) {
    const example = slice[i];
    process.stdout.write(
      `[${i + 1}/${slice.length}] Processing ${example.id}` +
        (example.turns.length > 1 ? ` (${example.turns.length} turns)` : "") +
        `... `
    );

    let entry!: AuditLogEntry;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let refreshError: string | null = null;
      try {
        await refreshAuth();
      } catch (error: any) {
        refreshError = `token refresh: ${error.message || error}`;
      }
      entry = refreshError
        ? { exampleId: example.id, exampleNumber: example.exampleNumber, prompt: example.prompt, compiled: false, turns: [], upstreamLangs: [], timestamp: new Date().toISOString(), error: refreshError }
        : await processExample(example, auth, db);
      if (!entry.error && entry.compiled) break;
      // An attempt that created its item and then failed (the metadata write, say) leaves an item
      // behind; delete it so the retry does not add a second one.
      if (entry.firestoreItemId) {
        try {
          await withTimeout(db.collection("users").doc(auth.uid).collection("items").doc(entry.firestoreItemId).delete(), "delete partial item");
        } catch (error: any) {
          console.log(`\n  ! could not delete partial item ${entry.firestoreItemId}: ${error.message || error}`);
        }
      }
      if (attempt < maxAttempts) {
        const wait = 5 * attempt;
        process.stdout.write(`\n  ↻ attempt ${attempt} failed (${entry.error || "did not compile"}); retrying in ${wait}s... `);
        await new Promise((r) => setTimeout(r, wait * 1000));
        if (attempt === 1) retriedCount++;
      }
    }
    auditLog.push(entry);

    if (entry.error) {
      console.log(`✗ Error after ${maxAttempts} attempts: ${entry.error}`);
      errorCount++;
      failed.push(example.exampleNumber);
    } else if (entry.compiled) {
      console.log(`✓ Created (item: ${entry.firestoreItemId})`);
      compiledCount++;
      if (entry.created) {
        createdCount++;
      }
    } else {
      console.log(`✗ Did not compile`);
      failed.push(example.exampleNumber);
    }
  }

  // Write audit log
  if (outputPath) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(auditLog, null, 2));

    console.log(`\n✓ Audit log written to: ${outputPath}`);
  }

  console.log(`Summary:`);
  console.log(`  Processed: ${slice.length}`);
  console.log(`  Compiled: ${compiledCount}`);
  console.log(`  Created (billed): ${createdCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`  Needed a retry: ${retriedCount}`);
  console.log(`  Compilation rate: ${((compiledCount / slice.length) * 100).toFixed(1)}%`);
  if (failed.length) {
    console.log(`  Failed: ${failed.join(",")}`);
    console.log(`  Re-run them: --lang ${langCode} --mark ${markValue} --refresh --only ${failed.join(",")}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    // Exit explicitly. A step that timed out is still in flight — its socket
    // would otherwise hold the event loop open long after the audit log landed,
    // which is indistinguishable from the hang the timeouts exist to prevent.
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
