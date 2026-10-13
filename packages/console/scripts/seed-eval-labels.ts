/**
 * seed-eval-labels.ts — turn a model-eval run into hand-label candidates.
 *
 * The label loop needs one program per (case, model) sitting in
 * data/model-eval/labels/<lang>.json with `overall: null`, so a human can score
 * it and --calibrate can compare human to judge. This lifts those programs out
 * of a run's output JSON.
 *
 * It picks the SAME representative the judge scored (pickRepresentative —
 * median-latency success). That is the whole point: if the human labeled a
 * different trial than the judge scored, --calibrate would measure the gap
 * between two different programs and report it as judge disagreement.
 *
 * Existing rows are never overwritten. A row that already carries a human score
 * is evidence; re-seeding must not silently replace its code (which would
 * invalidate the score attached to it) or reset the score.
 *
 * Usage:
 *   npx tsx scripts/seed-eval-labels.ts --lang 0176
 *   npx tsx scripts/seed-eval-labels.ts --lang 0176 --models gpt-5.6-terra
 *   npx tsx scripts/seed-eval-labels.ts --lang 0176 --from model-eval-<ts>.json
 *
 * Then: npx tsx scripts/create-eval-items.ts --lang <lang>   (renders them in /items)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { pickRepresentative } from "./eval-representative";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}

const LANG = arg("lang") || "0166";
const ONLY_MODELS = (arg("models") || "").split(",").map(s => s.trim()).filter(Boolean);
const DRY = process.argv.includes("--dry-run");

/** Newest model-eval output, unless --from names one. */
function resolveRunFile(): string {
  const explicit = arg("from");
  if (explicit) {
    if (!existsSync(explicit)) { console.error(`No such run file: ${explicit}`); process.exit(1); }
    return explicit;
  }
  // Newest by MTIME, not by name. A name sort is wrong here: "-" (0x2d) sorts
  // before "." (0x2e), so the legacy `model-eval.json` sorts AFTER every
  // `model-eval-<iso>.json` and a name sort silently picks the stale one.
  const candidates = readdirSync(".")
    .filter(f => /^model-eval.*\.json$/.test(f))
    .map(f => ({ f, mtime: statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    console.error("No model-eval*.json in the cwd. Run a sweep first, or pass --from.");
    process.exit(1);
  }
  return candidates[0].f;
}

function main() {
  const runFile = resolveRunFile();
  const run = JSON.parse(readFileSync(runFile, "utf8"));

  // A run whose hold-out gate was bypassed produced retrieval-assisted programs.
  // Those are fine to eyeball but must not become the labeled evidence behind an
  // ordering, so refuse rather than quietly contaminate the label set.
  if (typeof run.holdout === "string" && run.holdout.startsWith("LEAK")) {
    console.error(`\n${runFile} was produced with --allow-leak (${run.holdout}).`);
    console.error("Refusing to seed labels from it: those candidates were graded with the answer in context.\n");
    process.exit(1);
  }

  const runsForLang = (run.runs || []).filter((r: any) => String(r.lang) === LANG);
  if (!runsForLang.length) {
    console.error(`No runs for lang ${LANG} in ${runFile}.`);
    process.exit(1);
  }

  const labelsPath = `data/model-eval/labels/${LANG}.json`;
  const labels: any[] = existsSync(labelsPath)
    ? JSON.parse(readFileSync(labelsPath, "utf8"))
    : [];

  // Bucket by (case, model); variantId is the grouping key in the harness, and
  // for a model sweep the two coincide.
  const buckets = new Map<string, any[]>();
  for (const r of runsForLang) {
    // Compiling runs only — same rule as the harness's repCode. A human should
    // not be asked to score a program that never compiled: the objective metric
    // already counted that failure, and labeling it would feed --calibrate a
    // comparison the judge should never have been given either.
    if (!r.finalCompile || !r.code) continue;
    const model = r.model || r.variantId;
    if (ONLY_MODELS.length && !ONLY_MODELS.includes(model)) continue;
    const k = `${r.caseId}␟${model}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r);
  }

  let added = 0, skipped = 0, empty = 0;
  for (const [k, rs] of [...buckets].sort()) {
    const [caseId, model] = k.split("␟");
    if (labels.some(l => l.id === caseId && l.model === model)) {
      skipped++;
      continue;
    }
    const rep = pickRepresentative(rs);
    if (!rep?.code) { empty++; console.error(`  – ${caseId} · ${model}: no successful run`); continue; }
    labels.push({
      id: caseId, model, code: rep.code,
      overall: null, correctness: null, instructionFollowing: null, idiomaticity: null,
      // Convergence context (present once a run came from --converge; absent on older run files).
      // Recorded, NOT filtered on: a session that never converged still produced the program a
      // user would receive, and dropping those would hand the labeler only the wins — the same
      // inflation the anchors in labels/README.md exist to prevent. It also lets --calibrate
      // slice judge-vs-human agreement by how much iteration the item took.
      ...(rep.turns !== undefined ? { turns: rep.turns, converged: !!rep.converged, warningsFixable: rep.warningsFixable ?? null } : {}),
      // Which dialect version this program was verified against. A label is a judgment about an
      // artifact, and an artifact is only valid against the compiler that accepted it — L0175
      // tightened its c1-t10 validation and turned a clean candidate into four hard errors
      // without a single character of the program changing.
      ...(rep.dialect ? { dialect: rep.dialect } : {}),
    });
    added++;
    const conv = rep.turns !== undefined
      ? `, ${rep.turns} turn(s)${rep.converged ? "" : `, ${rep.warningsFixable ?? "?"} warning(s) left`}`
      : "";
    console.error(`  + ${caseId} · ${model}  (trial ${rep.trial}, ${(rep.latencyMs / 1000).toFixed(1)}s${conv})`);
  }

  labels.sort((a, b) =>
    String(a.id).localeCompare(String(b.id)) || String(a.model).localeCompare(String(b.model)));

  console.error(
    `\nfrom ${runFile}: +${added} new, ${skipped} already present` +
    `${empty ? `, ${empty} with no successful run` : ""} → ${labels.length} rows`,
  );
  const unlabeled = labels.filter(l => l.overall == null).length;
  console.error(`${unlabeled} of ${labels.length} await a human score.`);

  if (DRY) { console.error("\n--dry-run: nothing written."); return; }
  writeFileSync(labelsPath, JSON.stringify(labels, null, 2) + "\n");
  console.error(`wrote ${labelsPath}`);
  console.error(`next: npx tsx scripts/create-eval-items.ts --lang ${LANG}`);
}

main();
