/**
 * eval-case-proximity.ts — how close is each eval case to what RAG would hand the model?
 *
 * WHY THIS EXISTS
 *   scripts/eval-holdout.ts answers "is this case IN the corpus" — normalized exact/contains
 *   overlap, a gate that fails the run. That is the right check for the failure it names, and it
 *   is blind to the one that actually bites: the corpus is dense, so a case that is a PARAPHRASE
 *   of a training example passes the gate clean while retrieval still puts a near-answer in the
 *   generation prompt. The sweep then partly measures which family copies a supplied solution
 *   best — precisely the axis a family ordering is meant to measure, so the error is directional.
 *
 *   This script measures that directly, and does not gate on it. There is no defensible threshold
 *   to fail a run at: a case SHOULD retrieve related examples (that is what makes the dialect
 *   learnable), and how much help is too much is a judgment about the specific pair. So this
 *   prints what retrieval would supply and leaves the call to a human.
 *
 * WHAT IT REPORTS, per case
 *   top1        the nearest corpus example's combined score, UNFILTERED — the honest "is there
 *               something close" number, whether or not the generator would use it.
 *   supplied    how many examples clear MIN_COMBINED_SCORE (0.50) and are actually pasted into
 *               the generation prompt. This is what the model SEES; top1 is what exists.
 *   The two differ often, and conflating them is how "the case is held out" turns into a false
 *   sense of independence.
 *
 * COMPARING SETS
 *   Pass --set-dir more than once to score several sets for the same language side by side. That
 *   is the intended use: a corpus-seeded set and an MCP-derived one (scripts/eval-cases-from-mcp.ts)
 *   scored the same way turns "cases seeded from training data probably retrieve closer neighbours"
 *   from a hypothesis into a number.
 *
 * FAITHFULNESS
 *   Retrieval runs through the SAME path the generator uses — extractSearchQuery + queryFacets +
 *   hybridSearch on `training_examples`, with the generator's own weights and limit. A bespoke
 *   embedding comparison would measure a channel no caller has. The raw top-1 comes from
 *   hybridSearch directly because getRelevantExamples applies the 0.50 filter and would report
 *   nothing at all for a case whose nearest neighbour is distant — which is the interesting case.
 *
 * COSTS: one embedding call per case. No generation, no compile.
 *
 * USAGE
 *   npm run eval:proximity -- --lang 0176 --set-dir data/model-eval --set-dir data/model-eval/mcp
 *   npm run eval:proximity -- --lang 0176 --set-dir data/model-eval/mcp --show 2
 */
import "./eval-env"; // MUST be first: prod Firestore/auth bootstrap before any app import

import { readFileSync, existsSync } from "fs";
import { getRelevantExamples, extractSearchQuery } from "../src/lib/code-generation-service";
import { hybridSearch } from "../src/lib/embedding-service";
import { queryFacets } from "../src/lib/lang-embedding";
import admin from "firebase-admin";

/** getRelevantExamples' own gate — the line between "exists" and "the model sees it". */
const MIN_COMBINED_SCORE = 0.50;
/** The generator's retrieval limit, so `supplied` means what it means in production. */
const GEN_LIMIT = 3;

interface EvalCase { id: string; prompt: string }

interface CaseProximity {
  id: string;
  top1: number;
  top1Similarity: number;
  supplied: number;
  nearest: string;
}

function firestore() {
  try {
    return admin.firestore();
  } catch {
    if (!admin.apps.length) admin.initializeApp();
    return admin.firestore();
  }
}

function loadCases(setDir: string, lang: string): EvalCase[] {
  const path = `${setDir}/${lang}.json`;
  if (!existsSync(path)) throw new Error(`No eval set at ${path}`);
  const cases = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(cases) || !cases.length) throw new Error(`Empty eval set: ${path}`);
  return cases;
}

async function scoreCase(c: EvalCase, lang: string): Promise<CaseProximity> {
  // Same query the generator would embed for this prompt.
  const searchQuery = extractSearchQuery(c.prompt, lang);
  const facets = queryFacets(lang, searchQuery);

  // Unfiltered nearest neighbours.
  const raw = await hybridSearch({
    collection: "training_examples",
    query: searchQuery,
    limit: GEN_LIMIT,
    lang,
    db: firestore(),
    vectorWeight: 0.7,
    facets,
  });
  const hits = Array.isArray(raw) ? raw : [];
  const best = hits[0];
  const top1 = best ? (best.combinedScore ?? best.similarity ?? 0) : 0;

  // What the generator would actually paste in.
  const supplied = await getRelevantExamples({ prompt: c.prompt, lang, limit: GEN_LIMIT });

  return {
    id: c.id,
    top1,
    top1Similarity: best?.similarity ?? 0,
    supplied: Array.isArray(supplied) ? supplied.length : 0,
    nearest: (best?.prompt || best?.task || "").replace(/\s+/g, " ").trim(),
  };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseArgs(argv: string[]) {
  const a = { lang: "", setDirs: [] as string[], show: 0 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--lang") a.lang = argv[++i];
    else if (v === "--set-dir") a.setDirs.push(argv[++i]);
    // Print the N nearest retrieved prompts per case, for reading what "close" actually means
    // here. The aggregate cannot tell you whether a 0.72 neighbour is the same item in different
    // words or a different item that shares vocabulary; only reading them can.
    else if (v === "--show") a.show = Math.max(0, parseInt(argv[++i], 10) || 0);
  }
  if (!a.lang) { console.error("Provide --lang (e.g. --lang 0176)"); process.exit(1); }
  a.lang = a.lang.replace(/^L/i, "");
  if (!a.setDirs.length) a.setDirs.push("data/model-eval");
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaries: { setDir: string; rows: CaseProximity[] }[] = [];

  for (const setDir of args.setDirs) {
    const cases = loadCases(setDir, args.lang);
    console.log(`\n[proximity] ${setDir}/${args.lang}.json — ${cases.length} cases`);
    const rows: CaseProximity[] = [];
    for (const c of cases) {
      const r = await scoreCase(c, args.lang);
      rows.push(r);
      const flag = r.top1 >= 0.75 ? " ***" : r.top1 >= MIN_COMBINED_SCORE ? " *" : "";
      console.log(
        `  ${r.id.padEnd(42)} top1 ${r.top1.toFixed(3)}  supplied ${r.supplied}/${GEN_LIMIT}${flag}`,
      );
      if (args.show) console.log(`      nearest: ${r.nearest.slice(0, 160)}`);
    }
    summaries.push({ setDir, rows });
  }

  console.log(`\n${"set".padEnd(30)} n   top1-mean  top1-med  >=0.75  supplied>=1  supplied-mean`);
  for (const { setDir, rows } of summaries) {
    const tops = rows.map((r) => r.top1);
    const mean = tops.reduce((s, x) => s + x, 0) / (tops.length || 1);
    const near = rows.filter((r) => r.top1 >= 0.75).length;
    const withAny = rows.filter((r) => r.supplied > 0).length;
    const suppliedMean = rows.reduce((s, r) => s + r.supplied, 0) / (rows.length || 1);
    console.log(
      `${setDir.padEnd(30)} ${String(rows.length).padEnd(3)} ` +
      `${mean.toFixed(3).padEnd(10)} ${median(tops).toFixed(3).padEnd(9)} ` +
      `${String(near).padEnd(7)} ${String(withAny).padEnd(12)} ${suppliedMean.toFixed(2)}`,
    );
  }
  console.log(
    `\n'*' top1 >= ${MIN_COMBINED_SCORE} (the generator would paste it in) · '***' top1 >= 0.75 (very close).\n` +
    `Neither is a failure. A dialect the corpus covers well SHOULD retrieve related examples; what\n` +
    `matters is whether the neighbour answers the case. Re-run with --show 1 and read them.`,
  );
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
