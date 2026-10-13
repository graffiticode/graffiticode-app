#!/usr/bin/env node
/**
 * Re-baseline corpus rows — what to run when a sweep flags a change you have decided is right.
 *
 * The sweep compares each fresh generation against the program its corpus row points at
 * (`task_id`, falling back to `code`). When the generator's output changes on purpose (a new
 * instruction, a better model), every row written before the change keeps getting flagged and
 * the sweep stops being able to see anything else. This regenerates the rows, shows the diffs,
 * and on confirmation rewrites them.
 *
 * It writes BOTH sides, in one batch per row, because a corpus row is derived from an item:
 *   - the source item (users/<eval uid>/items/<item_id>): taskId, code (AST), model, help
 *   - the corpus row: code, task_id, model, messages, embedding — moved to the id
 *     generate-embeddings-from-examples.ts would give it (`lang_itemId_taskId`), old id deleted
 * Updating only the row would be undone by the next generate-embeddings run; updating only the
 * item would leave a stale row beside the new one, both served by RAG.
 *
 * These rows are the RAG examples too, so a re-baseline changes what the model is shown, not just
 * what the sweep compares against. Read the diffs.
 *
 * By default only rows whose SHAPE changed are written; rows that differ only in literals are
 * left alone (rewriting them is churn the sweep already ignores). --all-rows writes those too.
 *
 * Usage:
 *   npm run corpus-rebaseline -- --from-run wk2961 --langs 0178       # what that sweep flagged
 *   npm run corpus-rebaseline -- --langs 0175                         # every L0175 row
 *   npm run corpus-rebaseline -- --langs 0178 --refs <ref>,<ref>      # just these rows
 *   npm run corpus-rebaseline -- --langs 0175 --count                 # how many, no generation
 *   npm run corpus-rebaseline -- --langs 0175 --dry-run --json out.json  # diffs only, no writes
 *
 * COST. One real generation per selected row on the eval account, whether or not it is written.
 * Above 100 the script asks before generating; writing always asks unless --yes is passed.
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap

import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { FieldValue } from "firebase-admin/firestore";
import { unparse } from "@graffiticode/parser";
import { getFirestore } from "../src/utils/db";
import { generateCodeForRequest } from "../src/lib/code-generation/generate-for-request";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { getBaseUrlForApi, getApiTask, getLanguageLexicon } from "../src/lib/api";
import { compareShape, type ShapeLevel } from "../src/lib/code-shape";
import { createEmbeddingText, generateBatchEmbeddings } from "../src/lib/embedding-service";
import { verifyExampleForPrompt } from "../src/lib/lang-embedding";
import { harnessItemId } from "../src/lib/harness-item-ids";
import { SWEEP_LANGUAGES } from "../src/lib/corpus-sweep";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const has = (name: string) => args.includes(`--${name}`);
const list = (s: string | null) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : null);

const fromRun = flag("from-run");
const langsArg = list(flag("langs"));
const refsArg = list(flag("refs"));
const allRows = has("all-rows");
const dryRun = has("dry-run");
const countOnly = has("count");
const jsonOut = flag("json");
const limit = flag("limit") ? parseInt(flag("limit")!, 10) : Infinity;

if (!fromRun && !langsArg) {
  console.error("Error: pass --langs 0175,0178 and/or --from-run <sweep run id, e.g. wk2961>");
  process.exit(1);
}
const unknown = (langsArg ?? []).filter((l) => !SWEEP_LANGUAGES.includes(l));
if (unknown.length > 0) {
  console.error(`Error: not in the sweep set: ${unknown.join(", ")}`);
  process.exit(1);
}

const CONCURRENCY = 4;
const CONFIRM_ABOVE = 100;
const STEP_TIMEOUT_MS = 180_000;

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

interface Row {
  ref: string;
  lang: string;
  itemId: string;
  prompt: string;
  code: string;
  taskId: string | null;
  data: FirebaseFirestore.DocumentData;
}

interface Proposal {
  ref: string;
  lang: string;
  itemId: string;
  status: "changed" | "same" | "failed" | "blocked";
  reason?: string;
  level?: ShapeLevel;
  onlyInBaseline?: string[];
  onlyInFresh?: string[];
  baselineModel?: string | null;
  freshModel?: string;
  oldTaskId?: string | null;
  newTaskId?: string;
  baselineCode?: string;
  freshCode?: string;
  freshAst?: unknown;
}

async function selectRows(): Promise<Row[]> {
  const db = getFirestore();
  let refs: string[] | null = refsArg;

  if (fromRun) {
    const run = await db.collection("corpus-sweep-runs").doc(fromRun).get();
    if (!run.exists) throw new Error(`no sweep run ${fromRun} in corpus-sweep-runs`);
    const flagged = (run.get("results") as any[])
      .filter((r) => r.verdict === "structure")
      .filter((r) => !langsArg || langsArg.includes(r.lang))
      .map((r) => r.exampleRef as string);
    refs = refs ? refs.filter((r) => flagged.includes(r)) : flagged;
  }

  let rows: Row[];
  const toRow = (d: FirebaseFirestore.DocumentSnapshot): Row => ({
    ref: d.id,
    lang: String(d.get("lang") || ""),
    itemId: String(d.get("item_id") || ""),
    prompt: String(d.get("prompt") || "").trim(),
    code: String(d.get("code") || "").trim(),
    taskId: (d.get("task_id") as string) ?? null,
    data: d.data() || {},
  });

  if (refs) {
    const snaps = refs.length ? await db.getAll(...refs.map((r) => db.collection("training_examples").doc(r))) : [];
    const missing = snaps.filter((s) => !s.exists).map((s) => s.id);
    // A row flagged by an older sweep may have been re-baselined (and so moved) since.
    for (const m of missing) console.warn(`  skip ${m}: no longer in training_examples`);
    rows = snaps.filter((s) => s.exists).map(toRow);
  } else {
    rows = [];
    for (const lang of langsArg!) {
      const snap = await db.collection("training_examples").where("lang", "==", lang).get();
      rows.push(...snap.docs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(toRow));
    }
  }

  return rows.filter((r) => r.prompt && r.code && r.itemId).slice(0, limit);
}

async function unparseTask(taskId: string, lang: string, token: string): Promise<{ src: string; ast: unknown }> {
  const apiTask: any = await getApiTask({ auth: { token }, id: taskId });
  const task = (Array.isArray(apiTask) ? apiTask[0] : apiTask) || apiTask;
  if (!task?.code) throw new Error(`task ${taskId} has no code`);
  const ast = typeof task.code === "string" ? JSON.parse(task.code) : task.code;
  const src = unparse(ast, (await getLanguageLexicon(lang, token)) || {}, {}).trim();
  return { src, ast };
}

async function taskCompiles(taskId: string, token: string): Promise<string | null> {
  try {
    const resp = await fetch(`${getBaseUrlForApi()}/data?id=${encodeURIComponent(taskId)}&refresh=1`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (resp.status !== 200) return `/data returned ${resp.status}`;
    const obj: any = (await resp.json())?.data;
    const errors = Array.isArray(obj?.errors) ? obj.errors : [];
    if (errors.length) return errors.map((e: any) => (typeof e === "string" ? e : e?.message || JSON.stringify(e))).join("; ");
    if (obj?.data == null) return "/data returned no compile output";
    return null;
  } catch (x: any) {
    return `/data fetch failed: ${x?.message || x}`;
  }
}

async function propose(row: Row, auth: { uid: string; token: string }): Promise<Proposal> {
  const base = { ref: row.ref, lang: row.lang, itemId: row.itemId, baselineModel: row.data.model ?? null, oldTaskId: row.taskId };
  try {
    // Same call the sweep makes, so what gets written is what the sweep will next compare.
    const gen: any = await withTimeout(
      generateCodeForRequest({
        auth,
        prompt: row.prompt,
        language: row.lang,
        options: { maxTokens: 4096 },
        currentSrc: null,
        itemId: harnessItemId("rebaseline", row.lang),
        skipScopeGate: true,
      }),
      `generate L${row.lang} ${row.ref}`,
    );
    if (gen?.errors?.length) return { ...base, status: "failed", reason: String(gen.errors[0]?.message || gen.errors[0]) };
    if (!gen?.src || !gen?.taskId) return { ...base, status: "failed", reason: "generation returned no source or taskId" };
    const compileError = await taskCompiles(gen.taskId, auth.token);
    if (compileError) return { ...base, status: "failed", reason: `compile: ${compileError}` };

    const fresh = await unparseTask(gen.taskId, row.lang, auth.token);
    const baselineCode = row.taskId
      ? await unparseTask(row.taskId, row.lang, auth.token).then((t) => t.src).catch(() => row.code)
      : row.code;
    const common = {
      ...base,
      freshModel: gen.model || undefined,
      newTaskId: gen.taskId,
      baselineCode,
      freshCode: fresh.src,
      freshAst: fresh.ast,
    };

    // The same two gates generate-embeddings-from-examples.ts applies before storing a row.
    const stubs = fresh.src.match(/\/\*\s*[A-Z][A-Z0-9_]*\s*\*\//g);
    if (stubs) return { ...common, status: "blocked", reason: `unparse produced ${stubs.length} stub(s)` };
    const drift = verifyExampleForPrompt(row.lang, { prompt: row.prompt, code: fresh.src });
    if (drift && !drift.ok) return { ...common, status: "blocked", reason: `drift gate: ${drift.blocking.join("; ")}` };

    const diff = await compareShape(row.lang, baselineCode, fresh.src);
    return {
      ...common,
      status: diff.level === "structure" ? "changed" : "same",
      level: diff.level,
      onlyInBaseline: diff.onlyInA.slice(0, 12),
      onlyInFresh: diff.onlyInB.slice(0, 12),
    };
  } catch (err: any) {
    return { ...base, status: "failed", reason: err?.message || String(err) };
  }
}

function unifiedDiff(a: string, b: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rebaseline-"));
  writeFileSync(join(dir, "baseline"), a + "\n");
  writeFileSync(join(dir, "fresh"), b + "\n");
  try {
    execFileSync("diff", ["-u", join(dir, "baseline"), join(dir, "fresh")]);
    return "(identical)";
  } catch (e: any) {
    // diff exits 1 when the files differ; its output is the diff.
    return String(e.stdout || "").split("\n").slice(2).join("\n");
  }
}

/** Replace the code in the item's last bot code turn. `help` is stored as a JSON string or an array. */
function rewriteHelp(help: unknown, code: string): unknown | undefined {
  const parsed = typeof help === "string" ? JSON.parse(help) : help;
  if (!Array.isArray(parsed)) return undefined;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i];
    if (m?.type === "bot" && m.help?.type === "code") {
      parsed[i] = { ...m, help: { ...m.help, text: code } };
      return typeof help === "string" ? JSON.stringify(parsed) : parsed;
    }
  }
  return undefined;
}

/** Replace the code in the row's last assistant code message, keeping its fence language. */
function rewriteMessages(messages: any[] | undefined, code: string): any[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.startsWith("```")) {
      const fence = m.content.match(/^```(\S*)/)?.[1] ?? "";
      out[i] = { ...m, content: `\`\`\`${fence}\n${code}\n\`\`\`` };
      return out;
    }
  }
  return undefined;
}

async function write(proposals: Proposal[], rows: Map<string, Row>, uid: string) {
  const db = getFirestore();
  const now = new Date().toISOString();

  // Embed everything first: a failure here should leave nothing half-written.
  const texts = proposals.map((p) => {
    const { embeddingText: _old, ...data } = rows.get(p.ref)!.data;
    return createEmbeddingText({ ...data, code: p.freshCode });
  });
  const embeddings = await generateBatchEmbeddings(texts);

  let written = 0;
  for (const [i, p] of proposals.entries()) {
    const row = rows.get(p.ref)!;
    const itemRef = db.doc(`users/${uid}/items/${p.itemId}`);
    const item = await itemRef.get();
    if (!item.exists) {
      console.log(`  SKIP ${p.ref}: source item users/${uid}/items/${p.itemId} not found`);
      continue;
    }

    const help = rewriteHelp(item.get("help"), p.freshCode!);
    const messages = rewriteMessages(row.data.messages, p.freshCode!);
    if (help === undefined) console.log(`  warn ${p.ref}: item help has no code turn; left as is`);

    const newRef = db.collection("training_examples").doc(`${p.lang}_${p.itemId}_${p.newTaskId}`);
    const batch = db.batch();
    batch.update(itemRef, {
      taskId: p.newTaskId,
      code: p.freshAst,
      model: p.freshModel ?? null,
      ...(help !== undefined ? { help } : {}),
      rebaselinedAt: now,
    });
    batch.set(newRef, {
      ...row.data,
      code: p.freshCode,
      task_id: p.newTaskId,
      model: p.freshModel ?? null,
      ...(messages !== undefined ? { messages } : {}),
      embedding: FieldValue.vector(embeddings[i]),
      embeddingText: texts[i],
      embeddingUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: now,
      rebaselinedAt: now,
      rebaselinedFrom: p.ref,
    });
    if (newRef.id !== p.ref) batch.delete(db.collection("training_examples").doc(p.ref));
    await batch.commit();
    written++;
    console.log(`  wrote ${p.ref} → ${newRef.id}`);
  }
  return written;
}

async function main() {
  const rows = await selectRows();
  const byLang: Record<string, number> = {};
  for (const r of rows) byLang[r.lang] = (byLang[r.lang] || 0) + 1;

  console.log(`corpus rebaseline${fromRun ? ` — rows flagged by ${fromRun}` : ""}`);
  for (const [lang, n] of Object.entries(byLang)) console.log(`  L${lang}: ${n} rows`);
  console.log(`  TOTAL: ${rows.length} generations\n`);
  if (countOnly || rows.length === 0) return;

  if (rows.length > CONFIRM_ABOVE && !has("yes")) {
    const a = await ask(`This will run ${rows.length} real generations. Continue? [y/N] `);
    if (!/^y(es)?$/i.test(a.trim())) { console.log("aborted"); return; }
  }

  const apiKey = process.env.EVAL_API_KEY || process.env.GC_API_KEY_SECRET || "";
  if (!apiKey) throw new Error("EVAL_API_KEY or GC_API_KEY_SECRET must be set");
  const credentials: any = await getCredentialsForApiKey(apiKey);
  const auth = { uid: credentials.uid, token: credentials.idToken };

  const proposals = await pool(rows.map((r) => () => propose(r, auth)), CONCURRENCY);
  const toWrite = proposals.filter((p) => p.status === "changed" || (allRows && p.status === "same"));

  for (const p of proposals) {
    const tag = { changed: "CHANGED", same: "   same", failed: " FAILED", blocked: "BLOCKED" }[p.status];
    console.log(`${tag}  L${p.lang}  ${p.ref}  baseline=${p.baselineModel ?? "unrecorded"} fresh=${p.freshModel ?? "?"}`);
    if (p.reason) console.log(`         ${p.reason.slice(0, 200)}`);
    if (p.status === "changed") {
      console.log(`         only in baseline: ${p.onlyInBaseline?.join(" ") || "-"}  |  only in fresh: ${p.onlyInFresh?.join(" ") || "-"}`);
    }
    if (toWrite.includes(p)) console.log(unifiedDiff(p.baselineCode!, p.freshCode!).replace(/^/gm, "         "));
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(proposals.map(({ freshAst: _ast, ...p }) => p), null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }

  const count = (s: Proposal["status"]) => proposals.filter((p) => p.status === s).length;
  console.log(`\n${count("changed")} changed · ${count("same")} same shape · ${count("blocked")} blocked · ${count("failed")} failed`);
  console.log(`${toWrite.length} to write${allRows ? "" : " (shape changes only; --all-rows to include same-shape rows)"}`);

  if (dryRun) { console.log("(dry run — nothing written)"); return; }
  if (toWrite.length === 0) return;
  if (!has("yes")) {
    const a = await ask(`Rewrite ${toWrite.length} corpus rows and their source items? [y/N] `);
    if (!/^y(es)?$/i.test(a.trim())) { console.log("aborted — nothing written"); return; }
  }

  const written = await write(toWrite, new Map(rows.map((r) => [r.ref, r])), auth.uid);
  console.log(`\n${written}/${toWrite.length} rows re-baselined`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
