/**
 * compare-0178-split.ts — diff the L0178 corpus generated BEFORE the instructions/directive split
 * against the same prompts generated AFTER it.
 *
 * The split moved ~14KB of Data API knowledge out of instructions.md (read by BOTH code generation
 * and spec generation) into spec-directive.md (read by spec generation only). The claim being
 * tested is that the moved prose was inert for CODE generation — a program in this dialect is
 * `data-job` + a paging policy + one block + request fields, and none of signing, transport,
 * envelope shape, rate limits, async or write safety is expressible in one. If the claim holds the
 * programs should be substantially unchanged; anything that moved is the measurement.
 *
 * Pairs items by name: `NNN` is the pre-split corpus row, `NNN-split` its post-split twin. Reads
 * stored ASTs directly (item docs carry `code`), so there is no API round trip.
 *
 * Usage:
 *   npx tsx scripts/compare-0178-split.ts "$(cat prompts.json)"
 */
import "./eval-env";

import { unparse } from "@graffiticode/parser";
import { getLanguageLexicon } from "../src/lib/api";
import { getFirestore } from "../src/utils/db";

const UID = process.env.CORPUS_UID || "2c9d72e315fbafb128011bc32739666c7e6e7eb9";
const SUFFIX = process.env.SPLIT_SUFFIX || "-split";
const BLOCKS = ["items-get", "responses-get"];

/** Whitespace-insensitive: a reflow is not a behaviour change. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

interface Row {
  name: string;
  status: "same" | "differs" | "missing-before" | "missing-after";
  block: string;
  paging: string;
  invented: string[];
  before?: string;
  after?: string;
}

async function main() {
  const prompts: Record<string, string> = JSON.parse(process.argv[2] || "{}");
  if (!Object.keys(prompts).length) {
    console.error("Pass a JSON map of item name -> prompt");
    process.exit(1);
  }
  const lex = await getLanguageLexicon("0178");
  const db = getFirestore();

  // One read of the whole language, then match in memory — 36 prompts x 2 lookups is 72 queries
  // otherwise, and names are not unique across languages so each would need the lang filter anyway.
  const snap = await db.collection(`users/${UID}/items`).where("lang", "==", "0178").get();
  const byName = new Map<string, any>();
  for (const d of snap.docs) byName.set(String((d.data() as any).name), d.data());

  const rows: Row[] = [];
  for (const [name, prompt] of Object.entries(prompts)) {
    const before = byName.get(name);
    const after = byName.get(`${name}${SUFFIX}`);
    if (!before?.code) { rows.push({ name, status: "missing-before", block: "-", paging: "-", invented: [] }); continue; }
    if (!after?.code) { rows.push({ name, status: "missing-after", block: "-", paging: "-", invented: [] }); continue; }

    const b = norm(unparse(before.code, lex || {}, {}));
    const a = norm(unparse(after.code, lex || {}, {}));

    const block = BLOCKS.find(x => new RegExp(`\\b${x}\\b`).test(a)) || "NONE";
    const paging = /\bpaging\s+EXHAUSTIVE\b/.test(a) ? "EXHAUSTIVE"
      : /\bpaging\s+SINGLE-PAGE\b/.test(a) ? "SINGLE-PAGE" : "none";
    // A literal the prompt never supplied. Fabrication is the failure mode that LOOKS like success:
    // it makes a program more complete and emits fewer warnings, so every compiler signal agrees.
    const lits = [...new Set((a.match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1)))];
    const invented = lits.filter(l => !prompt.toLowerCase().includes(l.toLowerCase()));

    rows.push({ name, status: a === b ? "same" : "differs", block, paging, invented, before: b, after: a });
  }

  for (const r of rows) {
    const flag = r.invented.length ? `  INVENTED ${JSON.stringify(r.invented)}` : "";
    console.log(`${r.status.padEnd(14)} ${r.name}  ${r.block}/${r.paging}${flag}`);
  }

  const differs = rows.filter(r => r.status === "differs");
  console.log(`\n${rows.filter(r => r.status === "same").length} identical, ${differs.length} differ, ` +
    `${rows.filter(r => r.status.startsWith("missing")).length} missing`);

  for (const r of differs) {
    console.log(`\n──── ${r.name}  ${prompts[r.name]}`);
    console.log(`  before: ${r.before}`);
    console.log(`  after : ${r.after}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
