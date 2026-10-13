#!/usr/bin/env node
/**
 * Manual corpus sweep — the escalation the weekly alarm names.
 *
 * The weekly job samples 10 prompts per language and is deliberately sensitive; when it flags
 * something, this is what you run to find out whether it is real. It regenerates EVERY corpus
 * prompt for the named languages and compares each against what the corpus stored, so a change
 * that showed up in 2 of 10 samples is either confirmed across the whole corpus or exposed as
 * noise.
 *
 * Deliberately never triggered automatically: a full sweep of L0169 is 214 generations. Auto-
 * firing that off a signal whose noise floor nobody has measured is how a monitor becomes a bill.
 *
 * Usage:
 *   npm run corpus-sweep -- --langs 0173,0176      # full sweep of those languages
 *   npm run corpus-sweep -- --all                  # every language (expensive — see below)
 *   npm run corpus-sweep -- --langs 0175 --sample  # 10 by rotation, what the weekly job does
 *   npm run corpus-sweep -- --langs 0175 --dry-run # how many prompts it WOULD generate
 *   npm run corpus-sweep -- --langs 0173 --json out.json
 *   npm run corpus-sweep -- --langs 0179 --sample --no-record   # an A/B arm, not corpus history
 *
 * COST. Every prompt is one real generation on the eval account. --all is ~960 generations; the
 * script prints the count and, unless --yes is passed, requires confirmation above a threshold.
 * Nothing here creates items, so none of it is billable as items — but it is real model spend.
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap

import { writeFileSync } from "fs";
import { createInterface } from "readline";
import {
  runSweep,
  recordSweepRun,
  sweepSize,
  SWEEP_LANGUAGES,
  type SweepResult,
  type SweepRun,
} from "../src/lib/corpus-sweep";

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
  console.error("Error: pass --langs 0173,0176 or --all");
  console.error("       (the weekly alarm names the exact --langs to use)");
  process.exit(1);
}

const unknown = langs.filter((l) => !SWEEP_LANGUAGES.includes(l));
if (unknown.length > 0) {
  console.error(`Error: not in the sweep set: ${unknown.join(", ")}`);
  console.error(`       sweep set: ${SWEEP_LANGUAGES.join(", ")}`);
  process.exit(1);
}

const mode = has("sample") ? "sample" : "full";
const CONFIRM_ABOVE = 100;

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

function line(r: SweepResult): string {
  const tag = r.verdict === "match" ? "  match" : r.verdict === "structure" ? "CHANGED" : " FAILED";
  const head = `  ${tag}  L${r.lang}  ${r.exampleRef}  ${String(r.latencyMs).padStart(6)}ms`;
  if (r.verdict === "failed") return `${head}\n           ${r.stage}: ${String(r.error).slice(0, 140)}`;
  if (r.verdict === "structure") {
    const prov = `baseline=${r.baselineModel ?? "unrecorded"} fresh=${r.freshModel ?? "?"}`;
    const deltas = [
      r.onlyInBaseline?.length ? `only in baseline: ${r.onlyInBaseline.join(" ")}` : "",
      r.onlyInFresh?.length ? `only in fresh: ${r.onlyInFresh.join(" ")}` : "",
    ].filter(Boolean);
    // Both empty is a real case, not a missing value: the two programs use the identical
    // vocabulary and differ in how much of it or how it is arranged — an extra row, a repeated
    // attribute. Printing a blank line there reads as a bug in this script.
    const only = deltas.length ? deltas.join("  |  ") : "same vocabulary, different counts or arrangement";
    return `${head}\n           ${prov}${r.degraded ? " (raw compare — canonicalize failed)" : ""}\n           ${only}`;
  }
  return head;
}

async function main() {
  // Count first, so --dry-run and the confirmation both know the real size.
  const counts: Record<string, number> = {};
  for (const lang of langs) counts[lang] = await sweepSize(lang, mode);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log(`corpus sweep — mode=${mode}`);
  for (const lang of langs) console.log(`  L${lang}: ${counts[lang]} prompts`);
  console.log(`  TOTAL: ${total} generations\n`);

  if (has("dry-run")) { console.log("(dry run — nothing generated)"); return; }

  if (total > CONFIRM_ABOVE && !has("yes")) {
    const a = await ask(`This will run ${total} real generations. Continue? [y/N] `);
    if (!/^y(es)?$/i.test(a.trim())) { console.log("aborted"); return; }
  }

  const started = Date.now();
  const run: SweepRun = await runSweep({
    langs,
    mode,
    onLangDone: (lang, results) => {
      const bad = results.filter((r) => r.verdict !== "match");
      console.log(`L${lang}: ${results.length - bad.length}/${results.length} match` +
        (bad.length ? `, ${bad.length} to look at` : ""));
      for (const r of bad) console.log(line(r));
    },
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`match ${run.match}  changed ${run.structure}  failed ${run.failed}   of ${run.results.length}`);
  console.log(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  // Pre-provenance rows make a shape change ambiguous — say so rather than letting the number
  // read as a verdict.
  const unattributed = run.results.filter((r) => r.verdict === "structure" && !r.baselineModel).length;
  if (unattributed > 0) {
    console.log(`\nNOTE: ${unattributed} of the ${run.structure} changed rows have no baseline model recorded,`);
    console.log(`      so the change cannot be separated from a model switch. Rows created after`);
    console.log(`      provenance landed carry it; older ones never will.`);
  }

  const out = flag("json");
  if (out) { writeFileSync(out, JSON.stringify(run, null, 2)); console.log(`\nwrote ${out}`); }

  // A/B runs are not corpus history. `corpus-sweep-runs` is read as a time series of the
  // corpus against the CURRENT configuration; a run made under a deliberately different
  // config (CODEGEN_EFFORT while deciding whether to set it, a pinned model) is a different
  // experiment wearing the same clothes, and silently filed next to the weekly ones it looks
  // like a regression that nobody can explain later. Opt out explicitly rather than
  // remembering to delete rows afterwards.
  if (has("no-record")) {
    console.log(`not recorded (--no-record)`);
    return;
  }
  await recordSweepRun(run);
  console.log(`recorded to corpus-sweep-runs`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
