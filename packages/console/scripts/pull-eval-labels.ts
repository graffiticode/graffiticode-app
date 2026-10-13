/**
 * pull-eval-labels.ts — read human scores off the eval-account review items and
 * fill data/model-eval/labels/<lang>.json for judge calibration (--calibrate).
 *
 * Each client='eval' item (created by create-eval-items.ts) is one candidate,
 * named "<caseId> · <model-short>". You review it in the console /items eval tab
 * and set its MARK (1–5). overall = mark directly (green/1 = 1 … black/5 = 5).
 *
 * Fidelity note: --calibrate uses `overall` only, so mark alone is sufficient.
 * Unmarked items sit at the creation default mark 1 → overall 1; that's fine —
 * the labeler can see which are genuinely 1. Dry-run (print) is the default;
 * pass --write to persist.
 *
 * Prereqs (same as model-eval): .env.local EVAL_API_KEY + GRAFFITICODE_APP_CREDENTIALS.
 * Usage:
 *   npx tsx scripts/pull-eval-labels.ts [--lang 0166]           # dry run (print)
 *   npx tsx scripts/pull-eval-labels.ts [--lang 0166] --write   # write labels
 */
import "./eval-env"; // MUST be first: prod Firestore/auth bootstrap before app imports

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { getFirestore } from "../src/utils/db";
import { anchorVersion } from "../src/lib/judge-service";

const LANG = (() => {
  const i = process.argv.indexOf("--lang");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "0166";
})();
const WRITE = process.argv.includes("--write");
// Partial passes: treat items still at the default mark 1 as UNREVIEWED (overall
// null → excluded from calibration) rather than a genuine score of 1. Off by
// default (a full pass takes mark 1 at face value).
const SKIP_DEFAULT = process.argv.includes("--skip-default");

// Direct: overall = mark (green/1 = 1 … black/5 = 5).
const markToOverall = (m: number) => Math.min(5, Math.max(1, Math.round(m)));
const shortOf = (m: string) =>
  m.includes("opus") ? "opus" : m.includes("sonnet") ? "sonnet" : m.includes("haiku") ? "haiku" : m;

async function main() {
  const apiKey = process.env.EVAL_API_KEY;
  if (!apiKey) { console.error("Set EVAL_API_KEY in .env.local"); process.exit(1); }

  const labelsPath = `data/model-eval/labels/${LANG}.json`;
  if (!existsSync(labelsPath)) { console.error(`No labels file at ${labelsPath}`); process.exit(1); }
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as any[];

  const creds = await getCredentialsForApiKey(apiKey);
  const snap = await getFirestore().collection(`users/${creds.uid}/items`)
    .where("client", "==", "eval").where("lang", "==", LANG).get();
  if (snap.empty) { console.error(`No client='eval' lang=${LANG} items in the eval account`); process.exit(1); }

  const rows = snap.docs.map((d) => {
    const data = d.data();
    const [caseId, short] = String(data.name || "").split(" · ");
    const mark = Number(data.mark ?? 1);
    return { caseId, short, mark, overall: markToOverall(mark) };
  }).sort((a, b) => (a.caseId || "").localeCompare(b.caseId || "") || (a.short || "").localeCompare(b.short || ""));

  // Apply to the in-memory labels (matched by caseId + short model).
  let matched = 0, skipped = 0, unmatched: string[] = [];
  for (const r of rows) {
    const lab = labels.find((l) => l.id === r.caseId && shortOf(l.model || "") === r.short);
    if (!lab) { unmatched.push(`${r.caseId} · ${r.short}`); continue; }
    if (SKIP_DEFAULT && r.mark === 1) { lab.overall = null; delete lab.anchorVersion; skipped++; continue; }
    lab.overall = r.overall;
    // Stamp WHICH anchors this score was given against. The 4-5 band is dialect-specific and
    // versioned, so a bare number is not self-describing: --calibrate needs to know whether a 4
    // meant what a 4 means now, and skips the row when it didn't.
    lab.anchorVersion = anchorVersion(LANG);
    matched++;
  }

  // Print the table.
  console.log(`\n${WRITE ? "WRITE" : "DRY RUN (pass --write to persist)"}${SKIP_DEFAULT ? "  [--skip-default: mark 1 = unreviewed]" : ""} — ${labelsPath}\n`);
  console.log(["case", "model", "mark", "→ overall"].map((h, i) => h.padEnd([24, 8, 6, 11][i])).join(""));
  for (const r of rows) {
    const skip = SKIP_DEFAULT && r.mark === 1;
    console.log([
      (r.caseId || "?").padEnd(24), (r.short || "?").padEnd(8),
      String(r.mark).padEnd(6), (skip ? "— (unreviewed)" : String(r.overall)).padEnd(11),
    ].join(""));
  }
  if (unmatched.length) console.log(`\n⚠ no label row for: ${unmatched.join(", ")}`);
  if (skipped) console.log(`\n${skipped} item(s) at default mark 1 left unreviewed (overall null).`);

  if (WRITE) {
    writeFileSync(labelsPath, JSON.stringify(labels, null, 2) + "\n");
    console.log(`\nWrote overall for ${matched} candidate(s) → ${labelsPath}`);
  } else {
    console.log(`\nWould set overall for ${matched} candidate(s). Re-run with --write to persist.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
