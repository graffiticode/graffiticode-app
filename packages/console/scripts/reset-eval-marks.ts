/**
 * reset-eval-marks.ts — clear the human scores carried by a dialect's eval items.
 *
 * WHY THIS EXISTS. A label score lives in TWO places: `overall` in
 * data/model-eval/labels/<lang>.json, and the `mark` on the item in the eval account that
 * pull-eval-labels reads it from. Clearing the file leaves the marks, and the next pull silently
 * restores them — stamped with the CURRENT anchorVersion.
 *
 * That is the exact laundering the anchor-version guard exists to prevent, entering through a
 * channel the guard cannot see: it inspects rows in the labels file, and by then the stale
 * judgment has already been re-branded as a fresh one. Re-anchoring a dialect therefore has to
 * clear both sides, and this is the second half.
 *
 * Deliberately separate from create-eval-items, which refreshes item CONTENT and never writes
 * `mark` ("Refreshing content must never reset a score"). Resetting scores is a different, louder
 * act than refreshing code, and it should take its own command rather than ride along with one.
 *
 * DRY RUN BY DEFAULT — prints what it would clear. Pass --write to persist.
 *
 *   npx tsx scripts/reset-eval-marks.ts --lang 0176
 *   npx tsx scripts/reset-eval-marks.ts --lang 0176 --write
 *
 * Afterwards every item sits at the creation default of 1. Under the shared backbone a 1 means
 * "doesn't work", so pull with --skip-default: an item you have not reached then reads as
 * unreviewed instead of as a real score of 1.
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap before app imports

import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { updateItem } from "../src/pages/api/resolvers";
import { getFirestore } from "../src/utils/db";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
};

const LANG = arg("lang") || "0166";
const WRITE = process.argv.includes("--write");
const DEFAULT_MARK = 1;

async function main() {
  const apiKey = process.env.EVAL_API_KEY;
  if (!apiKey) { console.error("Set EVAL_API_KEY (the dedicated eval account) in .env.local"); process.exit(1); }
  const creds = await getCredentialsForApiKey(apiKey);
  const auth = { token: creds.idToken, uid: creds.uid };
  const db = getFirestore();

  // Same selector create-eval-items uses: this account's items tagged client='eval' for the lang.
  const snap = await db.collection(`users/${creds.uid}/items`).get();
  const items = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as any) }))
    .filter((it) => it.client === "eval" && String(it.lang) === LANG)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  if (!items.length) {
    console.error(`No client='eval' items for L${LANG} in account ${creds.uid}.`);
    return;
  }

  const marked = items.filter((it) => Number(it.mark || DEFAULT_MARK) !== DEFAULT_MARK);
  console.log(`\n${WRITE ? "WRITE" : "DRY RUN (pass --write to persist)"} — L${LANG}, ${items.length} eval item(s)\n`);
  console.log(["item", "mark", "→"].map((h, i) => h.padEnd([40, 6, 4][i])).join(""));
  for (const it of items) {
    const mark = Number(it.mark || DEFAULT_MARK);
    console.log([
      String(it.name || it.id).slice(0, 38).padEnd(40),
      String(mark).padEnd(6),
      (mark === DEFAULT_MARK ? "— (already default)" : String(DEFAULT_MARK)).padEnd(4),
    ].join(""));
  }
  console.log(`\n${marked.length} of ${items.length} carry a score.`);

  if (!WRITE) { console.log("Nothing written. Re-run with --write to clear them."); return; }
  for (const it of marked) {
    await updateItem({ auth, id: it.id, mark: DEFAULT_MARK } as any);
  }
  console.log(`Cleared ${marked.length} mark(s) → ${DEFAULT_MARK}.`);
  console.log(`Next: label in /items (App chip → eval), then pull with --skip-default:`);
  console.log(`  npx tsx scripts/pull-eval-labels.ts --lang ${LANG} --skip-default --write`);
}

main().catch((e) => { console.error(e); process.exit(1); });
