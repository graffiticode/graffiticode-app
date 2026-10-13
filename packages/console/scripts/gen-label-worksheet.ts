/**
 * gen-label-worksheet.ts — emit a human-readable labeling worksheet for a dialect:
 * the scoring anchors up top, then each case's prompt (intent) with every candidate
 * program side by side, so a labeler can score overall 1–5 by eye. Reads the same
 * two files calibration uses — data/model-eval/labels/<lang>.json (id, model, code)
 * and data/model-eval/<lang>.json (prompts) — so the worksheet never drifts.
 *
 * Output: data/model-eval/labels/label-review-<lang>.md (gitignored, local).
 * Scores still go in labels/<lang>.json (or via the item mark → pull-eval-labels).
 *
 * Usage: npx tsx scripts/gen-label-worksheet.ts [--lang 0166]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { ANCHOR_DISCIPLINE, SOFT_BAND_DISCIPLINE, anchorTableMarkdown, anchorVersion } from "../src/lib/judge-service";

const LANG = (() => {
  const i = process.argv.indexOf("--lang");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "0166";
})();

const ANCHORS = `# L${LANG} labeling worksheet

Score each candidate **overall 1–5** (in \`data/model-eval/labels/${LANG}.json\`, or by setting the
item mark in the console eval tab → \`pull-eval-labels\`).

${ANCHOR_DISCIPLINE}

${anchorTableMarkdown(LANG)}

## Awarding 4 and 5

\`\`\`
${SOFT_BAND_DISCIPLINE}
\`\`\`

Rules of thumb: **1 doesn't work · 2 wrong or incomplete · 3 correct and complete · 4–5 this
dialect's soft qualities.** Scores 1–3 mean the same thing in every dialect; only 4 and 5 are
dialect-specific. If a candidate is correct and complete and you cannot point at a specific soft
quality above, it is a **3** — clustering at 3 is a legitimate result, not a failure to discriminate.

Ranking tip: compare the candidates WITHIN a case before assigning absolute scores. Comparative
judgment is more reliable on close items, and it keeps the rank variance --calibrate needs.

Anchor version: **${anchorVersion(LANG)}** (record this on rows you score; \`--calibrate\` skips rows
scored under a different version).

<!-- Anchors render from overallAnchors(lang) in src/lib/judge-service.ts — the judge scores against
     the same source, so the human and the judge cannot drift onto different scales. Edit them there,
     and bump that dialect's \`version\` when you change a band's meaning. -->
`;

function main() {
  const labelsPath = `data/model-eval/labels/${LANG}.json`;
  const setPath = `data/model-eval/${LANG}.json`;
  if (!existsSync(labelsPath)) { console.error(`No labels at ${labelsPath}`); process.exit(1); }
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as any[];
  const prompts = new Map<string, string>(
    (existsSync(setPath) ? JSON.parse(readFileSync(setPath, "utf8")) : []).map((c: any) => [c.id, c.prompt]),
  );

  // Group candidates by case id, preserving first-seen order.
  const byCase = new Map<string, any[]>();
  for (const l of labels) (byCase.get(l.id) ?? byCase.set(l.id, []).get(l.id)!).push(l);

  const parts: string[] = [ANCHORS];
  for (const [caseId, cands] of byCase) {
    parts.push(`\n## ${caseId}\n`);
    const prompt = cands[0]?.prompt || prompts.get(caseId);
    if (prompt) parts.push(`**Prompt:** ${prompt}\n`);
    for (const c of cands) {
      parts.push(`### ${c.model || "candidate"}\n`);
      parts.push("```\n" + (c.code ?? "(no code)") + "\n```\n");
    }
  }

  const out = `data/model-eval/labels/label-review-${LANG}.md`;
  writeFileSync(out, parts.join("\n"));
  console.log(`Wrote worksheet (${byCase.size} cases, ${labels.length} candidates) → ${out}`);
}

main();
