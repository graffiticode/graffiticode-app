/**
 * check-0177-recipe.ts — deterministic regression checks on the RECIPE L0177 produces.
 *
 * WHY THIS EXISTS, AND WHY NOTHING ELSE COVERS IT. L0177's product is the get_spec recipe, not the
 * `author-embed` program. Everything else that validates this dialect validates the program: the
 * compiler checks the design, model-eval measures compile/holes/warnings, spec-directive.test.ts
 * pins the directive TEXT. All of it can be green while the recipe hands a developer instructions
 * that cannot work.
 *
 * That is not hypothetical. On 2026-08-12 an implementer built against a generated activity-edit
 * recipe and found three defects, and a sweep of 12 recipes saved that day (5 designs x 2 models x
 * 2 directive versions) showed how uniform they were:
 *
 *   - init() argument order: 10 of 10 argument-bearing calls emitted
 *     `init(initObject, callbacks, "<element>")`. ZERO correct. The callbacks land in the selector
 *     slot, no listener is ever registered, and the page is silently blank — the exact failure the
 *     recipe's own gotchas warn about. It was asserted in instructions.md under a [verified]
 *     marking, so every recipe copied it faithfully.
 *   - `request.user`: 0 of 12 said it must be an OBJECT. A bare `user_id` fails init outright.
 *   - ready-vs-loaded: 12 of 12 opened verification with "readyListener fires", 0 of 12 checked
 *     that content actually loaded. errorListener can fire AFTER ready (inaccessible
 *     organisation_id → error 10000), so that first step passes on a broken editor.
 *
 * Uniform across designs AND models, because all three live in the shared canonical knowledge that
 * every recipe receives verbatim. A better model copies a wrong constant just as faithfully — which
 * is why no amount of model comparison would have caught this, and why the check belongs here
 * rather than in the model eval.
 *
 * WHAT THIS CAN AND CANNOT DO. It catches REGRESSION to a known-wrong form. It would not have found
 * any of these the first time; only building against the recipe did. Treat a green run as "the
 * three facts we paid to learn are still being taught", not as "the recipe is correct".
 *
 * USAGE (prod env, like other scripts/):
 *   npx tsx scripts/check-0177-recipe.ts                  # 3 L0177 eval items
 *   npx tsx scripts/check-0177-recipe.ts --limit 6
 *   npx tsx scripts/check-0177-recipe.ts --item <itemId>  # a specific item
 *   npx tsx scripts/check-0177-recipe.ts --print          # dump each recipe
 *
 * Exits non-zero if any check fails, so it can gate a dialect deploy.
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap before app imports

import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { generateSpec } from "../src/lib/spec-generation-service";
import { getFirestore } from "../src/utils/db";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
};
const LIMIT = parseInt(arg("limit") || "3", 10);
const ONLY_ITEM = arg("item");
const PRINT = process.argv.includes("--print");

interface Check {
  name: string;
  /** Fails when this matches — a known-wrong form the recipe must never emit. */
  forbid?: RegExp;
  /** Fails when this does NOT match — a fact the recipe must carry. */
  require?: RegExp;
  why: string;
}

const CHECKS: Check[] = [
  {
    name: "init-argument-order",
    // `init(<anything>, <anything containing callbacks/listeners>, "<selector string>")` — the
    // signature that silently drops both listeners. Matched on the callbacks-then-string SHAPE
    // rather than the literal string that appeared in the bad recipes, because the model renames
    // the element freely ("learnosity-author", "<element>", "<your-target-element-id>" all
    // occurred) and a rule keyed to one of those would miss the next rename.
    forbid: /LearnosityAuthor\.init\s*\([^)]*(?:callbacks|readyListener|errorListener)[^)]*,\s*["'`]/i,
    why: "callbacks in the selector slot ⇒ no listener registered ⇒ silent blank editor",
  },
  {
    name: "init-documented-form",
    // Either documented form: (options, selector, callbacks) or the demo repo's (options, callbacks).
    require: /LearnosityAuthor\.init\s*\([^)]*,\s*(?:["'`#.][^)]*,\s*)?(?:callbacks|\{[^)]*(?:readyListener|errorListener))/i,
    why: "recipe must show a call in a form that actually registers the listeners",
  },
  {
    name: "user-is-an-object",
    require: /user\s*[:=]\s*\{|`?user`?\s+(?:object|must be an object)|be an object/i,
    why: "a bare user_id string fails init: 'A user attribute must be provided and be an object'",
  },
  {
    name: "ready-is-not-proof-of-load",
    require: /10000|content (?:request|is visible|actually load)|actually loads|after ready|proves init only/i,
    why: "errorListener can fire AFTER readyListener; a ready-only check passes on a broken editor",
  },
];

async function pickTaskIds(uid: string): Promise<Array<{ itemId: string; taskId: string; name: string }>> {
  const db = getFirestore();
  if (ONLY_ITEM) {
    const doc = await db.doc(`users/${uid}/items/${ONLY_ITEM}`).get();
    const d = doc.data() as any;
    if (!d?.taskId) throw new Error(`item ${ONLY_ITEM} has no taskId`);
    return [{ itemId: ONLY_ITEM, taskId: d.taskId, name: d.name || "unnamed" }];
  }
  const snap = await db.collection(`users/${uid}/items`)
    .where("client", "==", "eval").where("lang", "==", "0177").get();
  const rows = snap.docs
    .map((doc) => ({ itemId: doc.id, ...(doc.data() as any) }))
    .filter((r) => r.taskId)
    // Spread across cases rather than taking the first N alphabetically, so a run samples
    // different views instead of three variants of one design.
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const step = Math.max(1, Math.floor(rows.length / LIMIT));
  return rows.filter((_, i) => i % step === 0).slice(0, LIMIT)
    .map((r) => ({ itemId: r.itemId, taskId: r.taskId, name: r.name || "unnamed" }));
}

async function main() {
  const apiKey = process.env.EVAL_API_KEY;
  if (!apiKey) { console.error("Set EVAL_API_KEY in .env.local"); process.exit(1); }
  const creds = await getCredentialsForApiKey(apiKey);
  const auth = { token: creds.idToken, uid: creds.uid };

  const targets = await pickTaskIds(creds.uid);
  if (!targets.length) { console.error("No L0177 eval items found. Run scripts/create-eval-items.ts --lang 0177 first."); process.exit(1); }
  console.log(`checking ${targets.length} recipe(s) for L0177\n`);

  let failures = 0;
  for (const t of targets) {
    const { spec } = await generateSpec({ auth, taskId: t.taskId });
    if (PRINT) console.log(`\n----- ${t.name}\n${spec}\n-----\n`);
    console.log(`${t.name}  (${spec.length} chars)`);
    for (const c of CHECKS) {
      const bad = c.forbid ? c.forbid.test(spec) : c.require ? !c.require.test(spec) : false;
      if (bad) failures++;
      console.log(`  ${bad ? "FAIL" : "ok  "}  ${c.name}${bad ? `  — ${c.why}` : ""}`);
      if (bad && c.forbid) {
        const m = spec.match(c.forbid);
        if (m) console.log(`        emitted: ${m[0].slice(0, 120)}`);
      }
    }
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED` : "all checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
