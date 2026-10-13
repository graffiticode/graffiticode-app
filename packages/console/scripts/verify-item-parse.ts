/**
 * verify-item-parse.ts — re-parse every stored item under the CURRENT parser.
 *
 * Stored programs are ASTs, so a parser change can silently alter what they mean
 * on the way back out. @graffiticode/parser 1.6.0 in particular turns text after
 * a program's terminating `..` into a parse ERROR, where it used to be discarded
 * (which is how items got truncated to their preamble in the first place). That
 * fix is right, but it also means a program that has round-tripped cleanly for
 * weeks can start failing — and the first person to notice would be a user
 * opening the item and seeing inline errors.
 *
 * This sweep answers "does anything stored still parse?" before that happens.
 * Read-only: no writes, no generation, no cost beyond Firestore reads.
 *
 * Each item is taken through the same path the editor uses — unparse the stored
 * AST to source, then parseCode it back — with the owner's credentials and the
 * item's own id injected, exactly as the console would. Without those, every
 * program reading `get-val-private "learnosity-secret"` or `get-val-public
 * "itemId"` would report a spurious failure.
 *
 * Outcomes per item:
 *   ok           parses clean
 *   parse-error  unparse -> parse round trip now fails (the regression to find)
 *   stub         parses, but authored nothing — already-truncated, pre-existing
 *                damage rather than a new break (see repair-truncated-items.ts)
 *   unparse-fail unparse itself threw
 *   no-ast       item has no stored code object; invisible to this check
 *
 * Usage:
 *   npx tsx scripts/verify-item-parse.ts --lang 0176
 *   npx tsx scripts/verify-item-parse.ts --lang 0176 --lang 0158
 *   npx tsx scripts/verify-item-parse.ts --lang 0176 --uid <uid> --limit 50
 *
 * Requires: GRAFFITICODE_APP_CREDENTIALS (prod Firestore). Nothing in the graffiticode
 * project is read — the AST is read from the item doc, not the task store.
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap

import { unparse } from "@graffiticode/parser";
import { getFirestore } from "../src/utils/db";
import {
  parseCode,
} from "../src/pages/api/resolvers";

const DEFAULT_UID = "2c9d72e315fbafb128011bc32739666c7e6e7eb9";

function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((v, i) => {
    if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}
function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const LANGS = argAll("lang").length ? argAll("lang") : ["0176"];
const UID = arg("uid", DEFAULT_UID)!;
const LIMIT = parseInt(arg("limit", "0")!, 10);

/** Parses but authored nothing — no bracketed content outside string literals. */
function isStub(src?: string | null): boolean {
  if (!src) return true;
  return !src.replace(/"(\\.|[^"\\])*"/g, '""').includes("[");
}

async function main() {
  const db = getFirestore();

  let grandFail = 0;
  for (const lang of LANGS) {
    const snap = await db.collection(`users/${UID}/items`).where("lang", "==", lang).get();
    const docs = LIMIT > 0 ? snap.docs.slice(0, LIMIT) : snap.docs;

    const counts = { ok: 0, "parse-error": 0, stub: 0, "unparse-fail": 0, "no-ast": 0 };
    const failures: Array<{ id: string; name: string; why: string }> = [];

    for (const d of docs) {
      const x = d.data() as any;
      const label = String(x.name || "(unnamed)").slice(0, 40);
      if (!x.code || typeof x.code !== "object") { counts["no-ast"]++; continue; }

      let src: string;
      try {
        const lexicon = await getLexicon(lang);
        src = unparse(x.code, lexicon);
      } catch (e: any) {
        counts["unparse-fail"]++;
        failures.push({ id: d.id, name: label, why: `unparse threw: ${e?.message || e}` });
        continue;
      }

      // The item's own id is a public value, exactly as the console injects it.
      const res = await parseCode({
        lang,
        src,
        publicValues: { itemId: d.id },
      });

      const why = res.errors ? res.errors.map((e: any) => e.message).join("; ") : "";
      if (res.errors) {
        counts["parse-error"]++;
        failures.push({ id: d.id, name: label, why });
      } else if (isStub(src)) {
        counts.stub++;
      } else {
        counts.ok++;
      }
    }

    const total = docs.length;
    console.log(
      `L${lang}: ${total} items — ok ${counts.ok}, parse-error ${counts["parse-error"]}, ` +
      `stub ${counts.stub}, unparse-fail ${counts["unparse-fail"]}, no-ast ${counts["no-ast"]}`,
    );
    if (failures.length) {
      console.log(`  failures:`);
      for (const f of failures) console.log(`    ${f.id}  ${f.name.padEnd(40)} ${f.why.slice(0, 120)}`);
    }
    grandFail += counts["parse-error"] + counts["unparse-fail"];
    console.log();
  }

  console.log(
    grandFail === 0
      ? "No round-trip regressions: everything stored still parses."
      : `${grandFail} item(s) no longer round-trip — these would show inline errors in the editor.`,
  );
}

const lexCache = new Map<string, any>();
async function getLexicon(lang: string) {
  if (lexCache.has(lang)) return lexCache.get(lang);
  const res = await fetch(`https://api.graffiticode.org/L${lang}/lexicon.json`);
  if (!res.ok) throw new Error(`lexicon fetch failed: ${res.status}`);
  const lex = await res.json();
  lexCache.set(lang, lex);
  return lex;
}

main().catch((e) => { console.error(e); process.exit(1); });
