/**
 * check-0176-answers.ts — what a clozeformula item ACTUALLY accepts, read off the compiled output.
 *
 * WHY NOT A REGEX. Twice in one afternoon a source-shape check called a candidate correct when it
 * was not:
 *   - `valid-response ["1/2"] invalid-response ["4/8"] method "equivSymbolic"` looked right and did
 *     not compile at all (`invalid-response` is not in the lexicon).
 *   - `valid-response ["1/2", "0.5", "2/4"]` against a single `{{response}}` looked right and means
 *     something else: the list is POSITIONAL, one entry per blank, so that is three blanks. One
 *     blank accepting three answers is the nested `[["1/2", "0.5", "2/4"]]`, which the compiler
 *     turns into Learnosity `alt_responses`.
 * Source text cannot distinguish either case from the real thing. The compiled validation can.
 *
 * So this compiles the candidate and reports, per blank, the set of responses that would score —
 * `valid_response` unioned with every `alt_responses` alternative. That is the behavioral question
 * the prompt asks ("1/2, 0.5 and 2/4 are accepted"), and it is invariant to which authoring form a
 * model chose, which matters because more than one form is legitimate.
 *
 * Read-only: ephemeral tasks, no writes, no generation.
 *
 *   npx tsx scripts/check-0176-answers.ts --from model-eval-<ts>.json --case clozeformula-equivalence \
 *     --accepts "1/2,0.5,2/4"
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap before app imports

import { readFileSync } from "fs";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import { parseCode, postTask, getData } from "../src/pages/api/resolvers";
import { VERIFY_ITEM_ID } from "../src/lib/code-generation-service";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
};

interface Compiled {
  errors: string[];
  /** One entry per {{response}} blank: every response that would score there. */
  acceptedPerBlank: string[][];
}

/**
 * Learnosity shape: `validation.valid_response.value` is an array of blanks, each an array of
 * `{value, method}`; `validation.alt_responses` is an array of the same shape, each a COMPLETE
 * alternative answer set. Union them per blank — a response scores if it appears in any of them.
 */
function acceptedFromValidation(v: any): string[][] {
  const blanksOf = (rv: any): string[][] =>
    (rv?.value || []).map((blank: any) => (blank || []).map((e: any) => String(e?.value ?? e)));
  const primary = blanksOf(v?.valid_response);
  const out: string[][] = primary.map((b) => [...b]);
  for (const alt of v?.alt_responses || []) {
    blanksOf(alt).forEach((blank, i) => {
      if (!out[i]) out[i] = [];
      for (const val of blank) if (!out[i].includes(val)) out[i].push(val);
    });
  }
  return out;
}

async function compileCandidate(code: string, auth: any): Promise<Compiled> {
  const parsed: any = await parseCode({ lang: "0176", src: code, publicValues: { itemId: VERIFY_ITEM_ID } });
  if (parsed.errors) return { errors: parsed.errors.map((e: any) => e?.message || String(e)), acceptedPerBlank: [] };
  const posted: any = await postTask({ auth, task: { lang: "0176", code: JSON.parse(parsed.code) }, ephemeral: true, isPublic: false });
  const resp: any = await getData({ authToken: auth.token, id: posted?.id });
  const raw = resp?.errors ?? [];
  const errors = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((e: any) => e?.message || String(e));
  // The compiled envelope nests the Learnosity payload twice and repeats it under `request`.
  // Read the first shape that actually carries a validation rather than assuming one — an
  // extractor that silently finds nothing reports "0 blanks accepted" and looks like a real
  // failure, which is the same wrong-for-the-wrong-reason trap this script exists to avoid.
  const validation =
    resp?.data?.data?.questions?.[0]?.validation ??
    resp?.data?.request?.questions?.[0]?.validation ??
    resp?.data?.questions?.[0]?.data?.validation;
  if (!errors.length && !validation) {
    return { errors: ["compiled, but no question validation found — extractor needs updating"], acceptedPerBlank: [] };
  }
  return { errors, acceptedPerBlank: errors.length ? [] : acceptedFromValidation(validation) };
}

async function main() {
  const from = arg("from");
  const caseId = arg("case", "clozeformula-equivalence")!;
  const accepts = (arg("accepts") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!from) { console.error("Pass --from <model-eval-*.json>"); process.exit(1); }

  const creds = await getCredentialsForApiKey(process.env.EVAL_API_KEY!);
  const auth = { token: creds.idToken, uid: creds.uid };
  const payload = JSON.parse(readFileSync(from, "utf8"));
  const runs = (payload.runs || []).filter((r: any) => r.caseId === caseId && r.code);
  if (!runs.length) { console.error(`No runs for case ${caseId} in ${from}`); process.exit(1); }

  console.log(`\n${caseId} — dialect ${payload.dialects?.["0176"]?.hash ?? "unrecorded"}`);
  if (accepts.length) console.log(`expecting ONE blank accepting exactly: ${accepts.join(", ")}\n`);

  let pass = 0;
  for (const r of runs.sort((a: any, b: any) => a.model.localeCompare(b.model) || a.trial - b.trial)) {
    const c = await compileCandidate(r.code, auth);
    let verdict = "";
    if (c.errors.length) {
      verdict = `FAIL compile (${c.errors.length}): ${c.errors[0].slice(0, 80)}`;
    } else if (accepts.length) {
      // The requirement is about ONE blank: extra blanks mean the positional list was misread.
      const blanks = c.acceptedPerBlank.length;
      const got = c.acceptedPerBlank[0] || [];
      const ok = blanks === 1 && accepts.every((a) => got.includes(a)) && got.length === accepts.length;
      if (ok) pass++;
      verdict = `${ok ? "PASS" : "FAIL"} blanks=${blanks} accepted=[${got.join(", ")}]`;
    } else {
      verdict = `blanks=${c.acceptedPerBlank.length} accepted=${JSON.stringify(c.acceptedPerBlank)}`;
    }
    console.log(`  ${String(r.model).padEnd(16)} t${r.trial}  ${verdict}`);
  }
  if (accepts.length) console.log(`\n${pass}/${runs.length} satisfy the requirement.`);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
