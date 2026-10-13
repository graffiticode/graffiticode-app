/**
 * verify-0177-corpus.ts — check freshly generated L0177 items before they become training data,
 * and mark only the ones that pass.
 *
 * WHY VERIFY AND MARK LIVE IN ONE SCRIPT. A corpus row that teaches the wrong thing is worse than a
 * missing one — this dialect spent a day proving it, and the pre-template-fix corpus taught the
 * generator to fabricate a serving domain. When checking and marking were separate commands I
 * marked an item whose check had actually failed: it had answered a list-configuration request with
 * `filter { status: { in: [...] } }` — a FETCH expression, not an `author-embed` program — which
 * parsed, compiled, and reported `ready`. Every status signal said success. Passing `--mark` here
 * marks ONLY the rows that passed in the same run, so that gap cannot reopen.
 *
 * WHAT IT CHECKS, all things a human would otherwise eyeball:
 *   view      — the request mapped to an actual authoring view (an item browser must not become
 *               `item-edit`, and a program with no view at all is not an integration design)
 *   invented  — no string literal in the program that the prompt never supplied. This dialect's
 *               instructions forbid inventing `domain`/`user-id`/`reference`, and a fabricated one
 *               makes the design MORE complete and emits FEWER warnings, so the compiler's signals
 *               all point the wrong way.
 *
 * Reads the item's stored AST directly (item docs carry `code`), so there is no API round trip and
 * no dependence on cross-account task reads.
 *
 * Usage:
 *   npx tsx scripts/verify-0177-corpus.ts '{"042":"Embed an item browser for our authors."}'
 *   npx tsx scripts/verify-0177-corpus.ts "$(cat prompts.json)" --mark
 */
import "./eval-env";

import { unparse } from "@graffiticode/parser";
import { getLanguageLexicon } from "../src/lib/api";
import { getFirestore } from "../src/utils/db";

/** Whose items to inspect. Defaults to the account the training corpus is harvested from. */
const UID = process.env.CORPUS_UID || "2c9d72e315fbafb128011bc32739666c7e6e7eb9";
const VIEWS = ["item-edit", "item-list", "activity-edit", "activity-list"];
const MARK = process.argv.includes("--mark");
/** Mark 1 is the training set (the RAG corpus). */
const TRAINING_MARK = 1;

interface Verdict { name: string; id: string; ok: boolean; why: string }

async function main() {
  const prompts: Record<string, string> = JSON.parse(process.argv[2] || "{}");
  if (!Object.keys(prompts).length) {
    console.error('Pass a JSON map of item name -> prompt, e.g. \'{"042":"Embed an item browser…"}\'');
    process.exit(1);
  }
  const lex = await getLanguageLexicon("0177");
  const db = getFirestore();
  const verdicts: Verdict[] = [];

  for (const [name, prompt] of Object.entries(prompts)) {
    // Query by name, then fall back to nothing rather than guessing — a name that matches no item
    // is a miss to report, not an item to mark. (A name lookup raced a fresh write once; the fix is
    // to fail visibly here rather than to mark on an empty result.)
    const snap = await db.collection(`users/${UID}/items`)
      .where("lang", "==", "0177").where("name", "==", name).get();
    if (snap.empty) { verdicts.push({ name, id: "-", ok: false, why: "no item with that name" }); continue; }

    const doc = snap.docs[0];
    const data = doc.data() as any;
    if (!data.code) {
      verdicts.push({ name, id: doc.id, ok: false, why: `no code (${data.generationStatus ?? "unknown"})` });
      continue;
    }

    const src = unparse(data.code, lex || {}, {}).replace(/\s+/g, " ");
    const view = VIEWS.find(v => new RegExp(`\\b${v}\\b`).test(src));
    const literals = [...new Set((src.match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1)))];
    const invented = literals.filter(l => !prompt.toLowerCase().includes(l.toLowerCase()));

    const problems: string[] = [];
    if (!view) problems.push("no view — not an author-embed design");
    if (invented.length) problems.push(`INVENTED ${JSON.stringify(invented)}`);
    verdicts.push({ name, id: doc.id, ok: !problems.length, why: problems.join("; ") || `view=${view}` });
  }

  for (const v of verdicts) console.log(`${v.ok ? "PASS" : "FAIL"}  ${v.name}  ${v.id}  ${v.why}`);
  const passed = verdicts.filter(v => v.ok);
  console.log(`\n${passed.length}/${verdicts.length} pass`);

  if (MARK) {
    for (const v of passed) {
      await db.doc(`users/${UID}/items/${v.id}`).update({ mark: TRAINING_MARK });
      console.log(`marked ${v.name} (${v.id}) mark=${TRAINING_MARK}`);
    }
    const skipped = verdicts.length - passed.length;
    if (skipped) console.log(`${skipped} left unmarked — fix or discard them before they become corpus`);
  }
  process.exit(passed.length === verdicts.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
