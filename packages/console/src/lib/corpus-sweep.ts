// Corpus health sweep: regenerate corpus prompts and compare against what the corpus stored.
//
// TWO MODES, ONE ENGINE.
//   sample (weekly, scheduled) — 10 prompts per language, every language, by rotation.
//   full   (manual only)       — every prompt of one or more named languages.
// Full sweeps are deliberately NOT triggered automatically. A full sweep of L0169 is 214
// generations; auto-firing that from a signal whose noise floor nobody has measured is how a
// monitor turns into a bill. The weekly alarm names the command instead.
//
// ROTATION, NOT RANDOM — the same argument as the daily ping. Week N takes corpus indices
// [10N, 10N+10) mod size, so successive weeks walk the whole corpus without repeats and any week
// is reproducible from its number. Random sampling re-tests some prompts by luck and leaves
// others never exercised.
//
// THE ALARM IS DELIBERATELY SENSITIVE. Anything that is not "regenerated and matched" is
// reported: a human reads it and decides whether to spend a full sweep. That is why there is no
// threshold to tune and no repeat-trial control — at n=1 per prompt a structural diff genuinely
// cannot be told from sampling noise by machine, and pretending otherwise would either invent a
// threshold from nothing or triple the cost to measure a floor a person can eyeball.
//
// WHAT A DIFF DOES AND DOES NOT MEAN. The baseline is frozen code that may have been written by a
// different model under a different dialect. `model`/`dialect` provenance is recorded going
// forward (scripts/create-items-from-prompts.ts), but corpus rows written before that carry none
// — so for those, `baselineModel: null` is reported and a diff is genuinely ambiguous. The first
// sweeps establish an attributed baseline; they do not deliver a verdict.
//
// BILLING BOUNDARY, as with the ping: generate and stop. Never createItem/updateItem.
import { getFirestore } from "../utils/db";
import { generateCodeForRequest } from "./code-generation/generate-for-request";
import { getCredentialsForApiKey } from "./api-credentials";
import { getBaseUrlForApi, getApiTask, getLanguageLexicon } from "./api";
import { compareShape, type ShapeLevel } from "./code-shape";
import { harnessItemId } from "./harness-item-ids";
import { PING_LANGUAGES } from "./corpus-ping";
import { unparse } from "@graffiticode/parser";

/** Same set as the daily ping: registered, has a corpus, not deprecated or internal. */
export const SWEEP_LANGUAGES = PING_LANGUAGES;

export const SAMPLE_SIZE = 10;
const CONCURRENCY = 4;
const STEP_TIMEOUT_MS = 180_000;

export type SweepVerdict =
  /** Regenerated, compiled, and matched the corpus entry (possibly with different literals). */
  | "match"
  /** Regenerated and compiled, but the program's SHAPE differs from the corpus entry. */
  | "structure"
  /** Did not generate, or generated something that does not compile. */
  | "failed";

export interface SweepResult {
  lang: string;
  exampleRef: string;
  verdict: SweepVerdict;
  /** Set when verdict is "failed". */
  stage?: "generate" | "empty" | "compile";
  error?: string;
  /** Set when verdict is "structure" — vocabulary that separates the two programs. */
  onlyInBaseline?: string[];
  onlyInFresh?: string[];
  /** True when a program could not be canonicalized or unparsed from its AST, so the comparison used raw source. */
  degraded?: boolean;
  shapeLevel?: ShapeLevel;
  /** What wrote the stored baseline, when the corpus records it. Null for pre-provenance rows. */
  baselineModel: string | null;
  freshModel?: string;
  latencyMs: number;
}

export interface SweepRun {
  at: string;
  mode: "sample" | "full";
  week?: number;
  langs: string[];
  results: SweepResult[];
  match: number;
  structure: number;
  failed: number;
}

/** Weeks since the Unix epoch, UTC — the rotation cursor for sample mode. */
export function weekIndex(now: Date = new Date()): number {
  return Math.floor(now.getTime() / (7 * 86_400_000));
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

interface CorpusEntry {
  ref: string;
  prompt: string;
  code: string;
  taskId: string | null;
  model: string | null;
}

/**
 * Corpus entries for a language, ordered by doc id so a week's slice is reproducible.
 * `week === null` returns the whole corpus (full mode).
 */
async function corpusFor(lang: string, week: number | null): Promise<CorpusEntry[]> {
  const snap = await getFirestore()
    .collection("training_examples")
    .where("lang", "==", lang)
    .get();
  if (snap.empty) return [];

  const docs = snap.docs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const all: CorpusEntry[] = docs
    .map((d) => ({
      ref: d.id,
      prompt: String(d.get("prompt") || "").trim(),
      code: String(d.get("code") || "").trim(),
      // task_id for AST-based comparison; absent on older rows.
      taskId: (d.get("task_id") as string) ?? null,
      // Written by create-items-from-prompts going forward; absent on older rows.
      model: (d.get("model") as string) ?? null,
    }))
    // `code` is required even when task_id is present: it is the fallback baseline.
    .filter((e) => e.prompt && e.code);

  if (week === null || all.length <= SAMPLE_SIZE) return all;
  const start = (week * SAMPLE_SIZE) % all.length;
  // Wrap, so a slice near the end of the corpus is still SAMPLE_SIZE long.
  return Array.from({ length: SAMPLE_SIZE }, (_, i) => all[(start + i) % all.length]);
}

/**
 * How many prompts a sweep of this language would generate. Lets the manual runner print the
 * cost and confirm before spending, without reaching into Firestore itself.
 */
export async function sweepSize(lang: string, mode: "sample" | "full"): Promise<number> {
  const snap = await getFirestore()
    .collection("training_examples")
    .where("lang", "==", lang)
    .select()
    .get();
  return mode === "full" ? snap.size : Math.min(SAMPLE_SIZE, snap.size);
}

async function taskCompiles(taskId: string, accessToken: string): Promise<{ compiled: boolean; error?: string }> {
  try {
    // ?refresh=1 recompiles rather than answering from the compile cache. A
    // taskId is content-addressed over {lang, code} and carries no compiler
    // version, so a verdict cached before a language shipped a breaking change
    // keeps returning a clean 200 — a program the checker now rejects reads as
    // a PASS. This check exists to assert "this compiles", so it must reach the
    // compiler, not the record. (L0172, 2026-09-04: three regenerated programs
    // came out byte-identical to April ones and inherited their April verdicts.)
    const resp = await fetch(`${getBaseUrlForApi()}/data?id=${encodeURIComponent(taskId)}&refresh=1`, {
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (resp.status !== 200) return { compiled: false, error: `/data returned ${resp.status}` };
    const body: any = await resp.json();
    const obj = body?.data;
    const errors = Array.isArray(obj?.errors) ? obj.errors : [];
    if (errors.length > 0) {
      const message = errors
        .map((e: any) => (typeof e === "string" ? e : e?.message || JSON.stringify(e)))
        .join("; ");
      return { compiled: false, error: `Compile error: ${message}` };
    }
    if (obj?.data == null) return { compiled: false, error: "/data returned no compile output" };
    return { compiled: true };
  } catch (x: any) {
    return { compiled: false, error: `/data fetch failed: ${x?.message || x}` };
  }
}

/**
 * Get source code by fetching the AST from a taskId and unparsing it.
 * This ensures comparison uses the canonical AST representation, not stored source strings.
 */
async function getSourceFromTaskId(
  taskId: string,
  lang: string,
  auth: { token: string },
): Promise<string | null> {
  try {
    const apiTask = await getApiTask({ auth, id: taskId });
    const taskList = Array.isArray(apiTask) ? apiTask : [apiTask];
    const taskData = taskList[0] || apiTask;
    if (!taskData?.code) return null;

    const code = typeof taskData.code === "string"
      ? JSON.parse(taskData.code)
      : taskData.code;

    const lexicon = await getLanguageLexicon(lang, auth.token);
    return unparse(code, lexicon || {});
  } catch {
    return null;
  }
}

async function sweepOne(
  lang: string,
  entry: CorpusEntry,
  auth: { uid: string; token: string },
): Promise<SweepResult> {
  const started = Date.now();
  const base = { lang, exampleRef: entry.ref, baselineModel: entry.model, latencyMs: 0 };

  try {
    const gen: any = await withTimeout(
      generateCodeForRequest({
        auth,
        prompt: entry.prompt,
        language: lang,
        options: { maxTokens: 4096 },
        currentSrc: null,
        // Both required for the same reason as the daily ping: itemId so a dialect reading
        // get-val-public "itemId" resolves, skipScopeGate so a corpus prompt is replayed under
        // the regime it was authored in (see corpus-ping.ts PingOutcome).
        itemId: harnessItemId("sweep", lang),
        skipScopeGate: true,
      }),
      `generate L${lang} ${entry.ref}`,
    );

    const elapsed = () => Date.now() - started;
    if (gen?.errors?.length > 0) {
      return { ...base, verdict: "failed", stage: "generate", error: String(gen.errors[0]?.message || gen.errors[0]), latencyMs: elapsed() };
    }
    if (!gen?.src || !gen?.taskId) {
      return { ...base, verdict: "failed", stage: "empty", error: "generation returned no source or taskId", latencyMs: elapsed() };
    }
    const compile = await taskCompiles(gen.taskId, auth.token);
    if (!compile.compiled) {
      return { ...base, verdict: "failed", stage: "compile", error: compile.error, latencyMs: elapsed() };
    }

    // Compare unparsed ASTs when both sides have one; otherwise both fall back to raw source.
    // Never mix the two — unparse formatting alone would read as a shape difference.
    const [baselineAst, freshAst] = await Promise.all([
      entry.taskId ? getSourceFromTaskId(entry.taskId, lang, auth) : null,
      getSourceFromTaskId(gen.taskId, lang, auth),
    ]);
    const unparsed = baselineAst !== null && freshAst !== null;
    const diff = unparsed
      ? await compareShape(lang, baselineAst, freshAst)
      : await compareShape(lang, entry.code, gen.src);
    // `values` collapses into match on purpose: differing invented literals mean the prompt
    // underdetermined the content, not that the program changed.
    const verdict: SweepVerdict = diff.level === "structure" ? "structure" : "match";
    return {
      ...base,
      verdict,
      freshModel: gen.model || undefined,
      shapeLevel: diff.level,
      degraded: diff.degraded || !unparsed || undefined,
      ...(verdict === "structure" ? { onlyInBaseline: diff.onlyInA.slice(0, 12), onlyInFresh: diff.onlyInB.slice(0, 12) } : {}),
      latencyMs: elapsed(),
    };
  } catch (err: any) {
    return { ...base, verdict: "failed", stage: "generate", error: err?.message || String(err), latencyMs: Date.now() - started };
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

export interface SweepOptions {
  langs?: string[];
  /** "sample" takes 10 per language by rotation; "full" takes every corpus row. */
  mode?: "sample" | "full";
  now?: Date;
  /** Called after each language finishes — progress for the manual runner. */
  onLangDone?: (lang: string, results: SweepResult[]) => void;
}

export async function runSweep(opts: SweepOptions = {}): Promise<SweepRun> {
  const langs = opts.langs ?? SWEEP_LANGUAGES;
  const mode = opts.mode ?? "sample";
  const now = opts.now ?? new Date();
  const week = mode === "sample" ? weekIndex(now) : null;

  const apiKey = process.env.EVAL_API_KEY || process.env.GC_API_KEY_SECRET || "";
  if (!apiKey) throw new Error("EVAL_API_KEY or GC_API_KEY_SECRET must be set");
  const credentials: any = await getCredentialsForApiKey(apiKey);
  const auth = { uid: credentials.uid, token: credentials.idToken };

  const results: SweepResult[] = [];
  for (const lang of langs) {
    const entries = await corpusFor(lang, week);
    const got = await pool(entries.map((e) => () => sweepOne(lang, e, auth)), CONCURRENCY);
    results.push(...got);
    opts.onLangDone?.(lang, got);
  }

  const count = (v: SweepVerdict) => results.filter((r) => r.verdict === v).length;
  return {
    at: now.toISOString(),
    mode,
    ...(week !== null ? { week } : {}),
    langs,
    results,
    match: count("match"),
    structure: count("structure"),
    failed: count("failed"),
  };
}

/**
 * The alarm text. LOUD by design: full sweeps are manual, so this message is the only thing
 * standing between a regression and nobody noticing. It always states the totals, names every
 * affected language, and carries the exact command to investigate — a person should never have to
 * go and look up how to escalate.
 */
export function formatSweepSms(run: SweepRun, reportUrl?: string): string {
  const total = run.results.length;
  const langsOf = (v: SweepVerdict) =>
    [...new Set(run.results.filter((r) => r.verdict === v).map((r) => `L${r.lang}`))];

  if (run.failed === 0 && run.structure === 0) {
    return `corpus sweep wk${run.week}: ${total}/${total} match`;
  }

  const parts: string[] = [];
  if (run.failed > 0) parts.push(`${run.failed} FAILED (${langsOf("failed").join(" ")})`);
  if (run.structure > 0) parts.push(`${run.structure} changed shape (${langsOf("structure").join(" ")})`);

  const affected = [...new Set([...langsOf("failed"), ...langsOf("structure")])]
    .map((l) => l.replace(/^L/, ""))
    .join(",");
  const cmd = `npm run corpus-sweep -- --langs ${affected}`;

  return `corpus sweep wk${run.week}: ${parts.join(" · ")} of ${total}. Full sweep: ${cmd}` +
    (reportUrl ? ` ${reportUrl}` : "");
}

/**
 * The document id a run is stored under, and the id its report link addresses. ONE definition:
 * computing it separately at the call sites means a change to either makes every existing report
 * link 404, and nothing would fail until somebody opened one.
 *
 * Contains no dot, which is what keeps the three-part sweep token unambiguous (report-link.ts).
 */
export function sweepRunId(run: SweepRun): string {
  return run.mode === "sample" ? `wk${run.week}` : `full-${run.at.replace(/[:.]/g, "-")}`;
}

export async function recordSweepRun(run: SweepRun): Promise<void> {
  await getFirestore().collection("corpus-sweep-runs").doc(sweepRunId(run)).set(run, { merge: true });
}
