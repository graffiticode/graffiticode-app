#!/usr/bin/env node
/**
 * Backfill model provenance on unattributed corpus entries.
 *
 * Corpus entries written before 2026-08-31 have no `model` field, so sweep diffs
 * cannot distinguish a regression from a model switch. This script regenerates
 * each unattributed entry using the current MODEL_PRIORITY routing and stamps
 * the result — establishing a known baseline for future sweeps.
 *
 * WHAT IT DOES:
 *   1. Finds training_examples where model is null
 *   2. Regenerates each prompt through the current pipeline
 *   3. If it compiles, updates the corpus entry with { model, code, updatedAt }
 *   4. Reports shape changes but still updates (the new code IS the baseline)
 *
 * Usage:
 *   npm run backfill-provenance -- --langs 0169,0173    # specific languages
 *   npm run backfill-provenance -- --all                # every language
 *   npm run backfill-provenance -- --langs 0169 --dry-run
 *   npm run backfill-provenance -- --langs 0169 --limit 10
 *
 * COST: One generation per unattributed corpus entry. Use --dry-run to count first.
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap

import admin from "firebase-admin";
import { generateCodeForRequest } from "../src/lib/code-generation/generate-for-request";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { getBaseUrlForApi } from "../src/lib/api";
import { compareShape } from "../src/lib/code-shape";
import { harnessItemId } from "../src/lib/harness-item-ids";
import { SWEEP_LANGUAGES } from "../src/lib/corpus-sweep";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const has = (name: string) => args.includes(`--${name}`);

const langsArg = flag("langs");
const langs = has("all")
  ? SWEEP_LANGUAGES
  : langsArg
    ? langsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

if (!langs) {
  console.error("Error: pass --langs 0169,0173 or --all");
  process.exit(1);
}

const dryRun = has("dry-run");
const limit = flag("limit") ? parseInt(flag("limit")!, 10) : Infinity;
const CONCURRENCY = 4;
const STEP_TIMEOUT_MS = 180_000;

interface CorpusEntry {
  id: string;
  lang: string;
  prompt: string;
  code: string;
}

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function taskCompiles(taskId: string, accessToken: string): Promise<{ compiled: boolean; error?: string }> {
  try {
    const resp = await fetch(`${getBaseUrlForApi()}/data?id=${encodeURIComponent(taskId)}&refresh=1`, {
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (resp.status !== 200) return { compiled: false, error: `/data returned ${resp.status}` };
    const body: any = await resp.json();
    const obj = body?.data;
    const errors = Array.isArray(obj?.errors) ? obj.errors : [];
    if (errors.length > 0) {
      return { compiled: false, error: errors.map((e: any) => e?.message || e).join("; ") };
    }
    if (obj?.data == null) return { compiled: false, error: "no compile output" };
    return { compiled: true };
  } catch (x: any) {
    return { compiled: false, error: x?.message || String(x) };
  }
}

async function getUnattributedEntries(db: admin.firestore.Firestore, lang: string): Promise<CorpusEntry[]> {
  const snap = await db
    .collection("training_examples")
    .where("lang", "==", lang)
    .get();

  return snap.docs
    .filter((d) => !d.get("model")) // no model = unattributed
    .map((d) => ({
      id: d.id,
      lang: String(d.get("lang") || ""),
      prompt: String(d.get("prompt") || "").trim(),
      code: String(d.get("code") || "").trim(),
    }))
    .filter((e) => e.prompt && e.code);
}

interface BackfillResult {
  id: string;
  lang: string;
  status: "updated" | "failed" | "shape-changed";
  model?: string;
  error?: string;
  shapeLevel?: string;
}

async function backfillOne(
  entry: CorpusEntry,
  auth: { uid: string; token: string },
  db: admin.firestore.Firestore,
): Promise<BackfillResult> {
  const base = { id: entry.id, lang: entry.lang };

  try {
    const gen: any = await withTimeout(
      generateCodeForRequest({
        auth,
        prompt: entry.prompt,
        language: entry.lang,
        options: { maxTokens: 4096 },
        currentSrc: null,
        itemId: harnessItemId("backfill", entry.lang),
        skipScopeGate: true,
      }),
      `generate ${entry.id}`,
    );

    if (gen?.errors?.length > 0) {
      return { ...base, status: "failed", error: gen.errors[0]?.message || String(gen.errors[0]) };
    }
    if (!gen?.src || !gen?.taskId) {
      return { ...base, status: "failed", error: "no source or taskId" };
    }

    const compile = await taskCompiles(gen.taskId, auth.token);
    if (!compile.compiled) {
      return { ...base, status: "failed", error: compile.error };
    }

    // Compare shape
    const diff = await compareShape(entry.lang, entry.code, gen.src);
    const shapeChanged = diff.level === "structure";

    // Update the corpus entry with provenance (and new code if shape matches)
    if (!dryRun) {
      await db.collection("training_examples").doc(entry.id).update({
        model: gen.model || "unknown",
        // Only update code if shape matches — otherwise we're changing what the corpus teaches
        ...(shapeChanged ? {} : { code: gen.src }),
        updatedAt: new Date().toISOString(),
        backfilledAt: new Date().toISOString(),
      });
    }

    return {
      ...base,
      status: shapeChanged ? "shape-changed" : "updated",
      model: gen.model,
      shapeLevel: diff.level,
    };
  } catch (err: any) {
    return { ...base, status: "failed", error: err?.message || String(err) };
  }
}

async function pool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const apiKey = process.env.EVAL_API_KEY || process.env.GC_API_KEY_SECRET || "";
  if (!apiKey) throw new Error("EVAL_API_KEY or GC_API_KEY_SECRET must be set");

  const credentials: any = await getCredentialsForApiKey(apiKey);
  const auth = { uid: credentials.uid, token: credentials.idToken };

  const db = admin.firestore();

  console.log(`backfill corpus provenance — ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`languages: ${langs.join(", ")}`);
  if (limit < Infinity) console.log(`limit: ${limit} per language`);
  console.log();

  let totalUpdated = 0;
  let totalShapeChanged = 0;
  let totalFailed = 0;

  for (const lang of langs) {
    let entries = await getUnattributedEntries(db, lang);
    if (entries.length === 0) {
      console.log(`L${lang}: no unattributed entries`);
      continue;
    }

    if (limit < entries.length) {
      entries = entries.slice(0, limit);
    }

    console.log(`L${lang}: ${entries.length} unattributed entries`);

    if (dryRun) continue;

    const results = await pool(
      entries.map((e) => () => backfillOne(e, auth, db)),
      CONCURRENCY,
    );

    const updated = results.filter((r) => r.status === "updated").length;
    const shapeChanged = results.filter((r) => r.status === "shape-changed").length;
    const failed = results.filter((r) => r.status === "failed").length;

    console.log(`  updated: ${updated}  shape-changed: ${shapeChanged}  failed: ${failed}`);

    // Report failures
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`    FAIL ${r.id}: ${r.error}`);
    }
    // Report shape changes
    for (const r of results.filter((r) => r.status === "shape-changed")) {
      console.log(`    SHAPE ${r.id}: stamped ${r.model} but code differs (${r.shapeLevel})`);
    }

    totalUpdated += updated;
    totalShapeChanged += shapeChanged;
    totalFailed += failed;
  }

  console.log();
  console.log(`${"=".repeat(50)}`);
  console.log(`TOTAL: updated ${totalUpdated}  shape-changed ${totalShapeChanged}  failed ${totalFailed}`);
  if (dryRun) console.log(`(dry run — nothing written)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
