/**
 * Offline smoke test for the LLM-as-judge (src/lib/judge-service.ts).
 *
 * Exercises the judge END-TO-END with NO generation pipeline: no EVAL_API_KEY, no compile
 * server, no Firestore. It makes a few real judge calls (~a cent) against hardcoded
 * good/bad candidates and asserts the judge ranks them correctly and fails safe.
 *
 *   npx tsx scripts/judge-smoke.ts
 *
 * Exits non-zero on failure, so it's usable as a pre-commit / CI check. Needs ANTHROPIC_API_KEY
 * (from .env.local). This is the cheapest way to confirm the judge works before running the full
 * `model-eval --judge` sweep (which does require generation).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { updateRAGConfig, getJudgeMode } from "../src/lib/rag-config";
import { judgeCode, judgePair, judgePanel, judgeModelForFamily } from "../src/lib/judge-service";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("Set ANTHROPIC_API_KEY in .env.local"); process.exit(1); }
  updateRAGConfig({ enableJudge: true, judgeMode: "async" });

  const lang = "0166";
  const prompt = "Build a sheet with cells A1=10, A2=20, and A3 = the sum of A1 and A2.";

  // REAL L0166. Both programs below were verified to parse and compile cleanly
  // against api.graffiticode.org (`good` yields cells A1/A2/A3 with A3="=SUM(A1:A2)";
  // `bad` yields only A1), so a low score here is a judgment about quality rather
  // than about invalid syntax.
  //
  // This previously used core-Graffiticode-looking pseudocode (`'A1' = 10..`,
  // `add(cell 'A1', ...)`) which is NOT L0166 — the dialect is title/columns/cells.
  // That made the test actively misleading: the Anthropic judge scored the
  // "correct" candidate a 1, which was the RIGHT call on invalid code, and it was
  // easy to misread as the judge failing. Keep these fixtures compilable.
  const good = [
    'columns [',
    '  column A',
    '    width 100 {}',
    ']',
    'cells [',
    '  cell A1',
    '    text "10" {}',
    '  cell A2',
    '    text "20" {}',
    '  cell A3',
    '    text "=SUM(A1:A2)" {}',
    ']',
    '{',
    '  v: "0.0.1"',
    '}..',
  ].join("\n");
  // Compiles, but ignores A2 and the requested sum — "renders but wrong", a 2 or
  // below on the shared anchors.
  const bad = [
    'columns [',
    '  column A',
    '    width 100 {}',
    ']',
    'cells [',
    '  cell A1',
    '    text "10" {}',
    ']',
    '{',
    '  v: "0.0.1"',
    '}..',
  ].join("\n");

  const checks: { name: string; pass: boolean }[] = [];

  console.log("getJudgeMode() =", getJudgeMode());
  checks.push({ name: "getJudgeMode==async when enabled", pass: getJudgeMode() === "async" });

  const g = await judgeCode({ prompt, code: good, lang });
  const b = await judgeCode({ prompt, code: bad, lang });
  console.log("pointwise good.overall =", g?.overall, " bad.overall =", b?.overall);
  checks.push({ name: "pointwise returns verdicts", pass: !!g && !!b });
  checks.push({ name: "good >= bad (overall)", pass: !!g && !!b && g.overall >= b.overall });

  const p = await judgePair({ prompt, codeA: good, codeB: bad, lang });
  console.log("pairwise winner =", p?.winner, " agreed =", p?.agreed);
  checks.push({ name: "pairwise picks A (the good one)", pass: p?.winner === "A" });

  // Fail-safe: an unrecognized model must return null rather than throw. This is
  // the contract the inline production path depends on — a judge that throws would
  // take down the request it is only observing.
  const nil = await judgeCode({ prompt, code: good, lang, model: "not-a-real-model" });
  checks.push({ name: "unknown model => null (never throws)", pass: nil === null });

  // Panel: one judge per family. Verifies the provider-neutral path end to end —
  // this is the piece that makes a cross-family ordering defensible, so it is worth
  // the extra call.
  const panel = await judgePanel({ prompt, code: good, lang });
  console.log(
    "panel judges =", panel.entries.map((e) => `${e.judge}:${e.verdict?.overall ?? "null"}`).join(" "),
    " agreed =", panel.agreed, " spread =", panel.spread,
  );
  checks.push({ name: "panel scored at least one judge", pass: panel.scored.length >= 1 });
  if (process.env.OPENAI_API_KEY) {
    checks.push({ name: "panel scored BOTH families", pass: panel.scored.length === 2 });
    const gpt = await judgeCode({ prompt, code: good, lang, model: judgeModelForFamily("openai") });
    console.log("openai judge good.overall =", gpt?.overall);
    checks.push({ name: "openai judge returns a verdict", pass: !!gpt });
  } else {
    console.log("(no OPENAI_API_KEY — skipping the cross-family half; panel degraded to 1 judge)");
    checks.push({ name: "panel degrades to 1 judge without OPENAI_API_KEY", pass: panel.scored.length === 1 });
  }

  console.log("");
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  const ok = checks.every((c) => c.pass);
  console.log(`\nSMOKE: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
