// Cross-language eval harness: exercises the get_spec adoption path end-to-end against a live
// console (defaults to prod; override with GRAFFITICODE_CONSOLE_URL for staging/local).
//
//   GRAFFITICODE_API_KEY=<key> npx tsx scripts/eval-cross-language.ts
//
// Flow (the "make this spreadsheet into a Learnosity question" scenario):
//   1. create_item(0166, budget spreadsheet)         -> source item
//   2. get_spec(source)                              -> platform-neutral English
//   3. create_item(0158, spec + intent framing)      -> Learnosity item (composer routes)
//   4. assert: salient content from step 1 survives into step 3, no source-language leakage.
//
// It asserts the agent did NOT route — it issued one high-quality 0158 request and let the
// composer compose. Content is LLM-generated, so checks are fidelity/smoke, not exact-match.

import { startCodeGeneration, getItemWithTask, getData, getSpec, type AuthContext } from "../src/api.js";

const apiKey = process.env.GRAFFITICODE_API_KEY;
if (!apiKey) {
  console.error("Set GRAFFITICODE_API_KEY to run this eval.");
  process.exit(2);
}
const auth: AuthContext = { type: "firebase", token: apiKey, source: "raw" };

// Distinctive labels so we can check that content propagates across the language boundary.
const LABELS = ["Rent", "Groceries", "Savings"];
const SPREADSHEET_PROMPT =
  `A simple monthly home-budget spreadsheet with rows labeled ${LABELS.join(", ")} and a Total ` +
  `row that sums them. Put dollar amounts in column B and a formula in the Total cell.`;
const LEARNOSITY_FRAMING =
  "\n\nMake this into a Learnosity assessment question where the learner completes the budget.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReady(itemId: string, label: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const item = await getItemWithTask({ auth, id: itemId });
    const status = item?.generationStatus;
    if (status === "failed") throw new Error(`${label} generation failed: ${item?.generationError}`);
    if ((status === "ready" || !status) && item?.task) return item;
    if (Date.now() > deadline) throw new Error(`${label} timed out (status=${status})`);
    await sleep(1500);
  }
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  console.log("1) create_item(0166, budget spreadsheet)…");
  const src = await startCodeGeneration({
    auth, lang: "0166", client: "eval", prompt: SPREADSHEET_PROMPT, modification: SPREADSHEET_PROMPT,
  });
  const srcItem = await waitReady(src.itemId, "0166 source");
  console.log(`   source item ${src.itemId} ready`);

  console.log("2) get_spec(source)…");
  const { spec, coverage } = await getSpec({ auth, id: src.itemId });
  console.log(`   spec (${spec.length} chars), coverage missing=${coverage?.missing?.length ?? "?"}`);
  const specHasLabels = LABELS.filter((l) => spec.toLowerCase().includes(l.toLowerCase()));
  check("spec preserves spreadsheet labels", specHasLabels.length === LABELS.length,
    `${specHasLabels.length}/${LABELS.length}`);
  check("spec is platform-neutral (no 0166 DSL terminator)", !spec.trim().endsWith(".."));

  console.log("3) create_item(0158, spec + framing) — composer routes…");
  const learnosityPrompt = spec + LEARNOSITY_FRAMING;
  const out = await startCodeGeneration({
    auth, lang: "0158", client: "eval", prompt: learnosityPrompt, modification: learnosityPrompt,
  });
  const outItem = await waitReady(out.itemId, "0158 target");
  const outSrc: string = outItem?.task?.src ?? "";
  // An assessment language carries its authored content in the compiled data (the Learnosity
  // payload), not the terse src — check there for fidelity.
  const outData = await getData({ auth, taskId: outItem.taskId });
  const outDataStr = JSON.stringify(outData ?? "");
  console.log(`   learnosity item ${out.itemId} ready (${outSrc.length} src / ${outDataStr.length} data chars)`);

  console.log("4) assertions…");
  const survived = LABELS.filter((l) => outDataStr.toLowerCase().includes(l.toLowerCase()));
  check("content survived into Learnosity item (data)", survived.length === LABELS.length, `${survived.length}/${LABELS.length} labels`);
  // The agent passed only a spec + intent; the composer should have identified 0166 + 0158 and
  // composed the pipeline itself — never the agent's job.
  check("composer routed/composed a pipeline", /data\s+use\s+"0166"|custom\s+lang\s+"0166"/.test(outSrc));
  check("target item is non-empty", outDataStr.length > 2);

  console.log(failures === 0 ? "\n✅ eval passed" : `\n❌ eval failed (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("eval error:", e?.message ?? e); process.exit(1); });
