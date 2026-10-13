/**
 * eval-cases-from-mcp.ts — author eval cases from a language's PUBLIC MCP surface, and only that.
 *
 * WHY THIS EXISTS
 *   scripts/eval-holdout.ts keeps an eval case from BEING a training example. It cannot keep one
 *   from being a paraphrase of one. The corpus is dense, so a case seeded from mark-1 data and
 *   then reworded passes the gate clean while RAG still retrieves a near-answer for it — and the
 *   sweep partly measures which family copies a supplied solution best. That is the exact axis a
 *   family ordering is supposed to measure, so the contamination is directional, not noise.
 *
 *   The fix has to be at the source: author the cases from a surface that has never seen the
 *   corpus. `get_language_info` is that surface — the authoring guide, item types, scope, and
 *   example prompts an MCP agent gets before it writes its first request. Cases written from it
 *   are what a real caller would ask for, which makes them both independent AND more externally
 *   valid than corpus-derived ones.
 *
 *   Independence here is STRUCTURAL, not a promise: this file imports no Firestore client and no
 *   app module that reaches one. It cannot read `training_examples` even by mistake. Keep it that
 *   way — the moment this script can see the corpus, its output stops being evidence of anything.
 *   Measuring the result is a separate job (scripts/eval-case-proximity.ts), and measuring is fine;
 *   feeding the corpus back into AUTHORING is not.
 *
 * WHAT "THE MCP SURFACE" MEANS, EXACTLY
 *   One GraphQL query against the console API — the same one graffiticode-mcp-server issues in
 *   src/api.ts `getLanguageInfo`, which is what backs both `get_language_info` and the
 *   `graffiticode://language/L{id}/user-guide` resource. Fields used: authoringGuide,
 *   supportedItemTypes, scope, examplePrompts, usageGuide. If that query changes there, change it
 *   here; the point is that this script sees neither more nor less than an agent does.
 *
 * OUTPUT
 *   <out-dir>/<lang>.json            bare [{ id, prompt }] — the shape model-eval.ts loads
 *   <out-dir>/<lang>.provenance.json what it was authored from and by whom
 *
 *   The set goes in its own directory (default data/model-eval/mcp/) rather than replacing the
 *   corpus-seeded set, so the two can be run against each other. `loadCases` requires a bare
 *   array, which is why provenance is a sidecar rather than a wrapper object.
 *
 * CREATE CASES ONLY. Every case is a fresh authoring request with no `currentCode`. The update
 * path is unmeasured across every dialect and is worth fixing, but it is a different job: an
 * update case needs a believable prior program, and the only honest sources for one are a real
 * item or a generation — neither of which this script's independence rule allows it to reach.
 *
 * USAGE
 *   npm run eval:cases -- --lang 0176                 # 8 cases from L0176's MCP surface
 *   npm run eval:cases -- --lang 0176 --count 12
 *   npm run eval:cases -- --lang 0166 --out-dir data/model-eval/mcp
 *   npm run eval:cases -- --lang 0176 --dry-run       # print the surface + prompt, spend nothing
 *
 * Then gate and run it like any other set:
 *   npm run eval:holdout -- --lang 0176 --set-dir data/model-eval/mcp
 *   npm run eval -- --lang 0176 --set-dir data/model-eval/mcp --limit 8
 */
import * as dotenv from "dotenv";
import axios from "axios";
import { writeFileSync, mkdirSync, existsSync } from "fs";

dotenv.config({ path: ".env.local" });

// Deliberately NOT ./eval-env: that bootstraps prod Firestore for the harness. This script needs
// an Anthropic key and a public HTTP endpoint, nothing else, and the missing bootstrap is part of
// the independence guarantee above.

/** Where the MCP server reads language info from (graffiticode-mcp-server/src/api.ts CONSOLE_API_URL). */
const CONSOLE_API_URL = process.env.GRAFFITICODE_CONSOLE_URL || "https://console.graffiticode.org/api";

/**
 * Verbatim from graffiticode-mcp-server/src/api.ts `getLanguageInfo`, minus the routing fields
 * that steer language CHOICE rather than authoring (id/name/description/routingHint/domains are
 * about picking L0176 at all; by the time cases are being written that decision is made).
 */
const LANGUAGE_INFO_QUERY = `
  query GetLanguageInfo($id: String!) {
    language(id: $id) {
      id
      name
      description
      authoringGuide
      supportedItemTypes
      examplePrompts { prompt produces notes }
      usageGuide
      scope { summary inScope outOfScope }
    }
  }
`;

interface ExamplePrompt { prompt: string; produces?: string | null; notes?: string | null }
interface LanguageSurface {
  id: string;
  name?: string | null;
  description?: string | null;
  authoringGuide?: string | null;
  supportedItemTypes?: string[] | null;
  examplePrompts?: ExamplePrompt[] | null;
  usageGuide?: string | null;
  scope?: { summary?: string | null; inScope?: string[] | null; outOfScope?: string[] | null } | null;
}

interface EvalCase { id: string; prompt: string }

async function fetchSurface(lang: string): Promise<LanguageSurface> {
  const { data } = await axios.post(
    CONSOLE_API_URL,
    { query: LANGUAGE_INFO_QUERY, variables: { id: lang.replace(/^L/i, "") } },
    { headers: { "Content-Type": "application/json" } },
  );
  if (data?.errors?.length) {
    throw new Error(`language info query failed: ${JSON.stringify(data.errors).slice(0, 300)}`);
  }
  const language = data?.data?.language;
  if (!language) throw new Error(`No language info for ${lang} at ${CONSOLE_API_URL}`);
  return language;
}

/**
 * The authoring brief.
 *
 * Every rule here is one an existing set already follows implicitly; writing them down is what
 * makes the output reproducible rather than a matter of who ran it. The two that carry the most
 * weight:
 *
 *   - "supply the content" — a case that says "write an item about photosynthesis" measures the
 *     model's biology as much as its dialect. Handing over the stem, the key, and the distractors
 *     makes a failure attributable to the language, which is the only thing a family ordering can
 *     act on.
 *   - "do not reuse the example prompts' subject matter" — the example prompts are the one part of
 *     this surface a corpus example could plausibly resemble, since both describe the same feature
 *     set. Fresh subject matter is what keeps a generated case from landing on top of a corpus
 *     example by accident. scripts/eval-case-proximity.ts checks whether it worked.
 */
function buildSystemPrompt(): string {
  return [
    "You author evaluation cases for a code-generation benchmark.",
    "",
    "A case is a single natural-language request that a user would send to a content-authoring",
    "backend. The backend turns it into a program in a domain-specific language and compiles it.",
    "The benchmark runs the same case against several LLMs and compares what they produce, so a",
    "case is only useful if the request is unambiguous enough that two correct implementations",
    "would look substantially the same.",
    "",
    "RULES",
    "1. SUPPLY THE CONTENT. Give the stem, the correct answer, and any distractors or options in",
    "   the request itself. Never say 'write a question about X' and leave the model to invent the",
    "   subject knowledge — that measures the model's world knowledge, not its ability to author in",
    "   the language.",
    "2. NAME THE ITEM TYPE explicitly, using the language's own vocabulary.",
    "3. STATE THE SCORING MODEL where the type supports more than one (exact match, partial credit,",
    "   accepted alternates, tolerance). Where it does not, say nothing about scoring.",
    "4. COVER THE SURFACE. Across the set, exercise as many distinct item types and documented",
    "   capabilities as the count allows — one case each, not variations on one type.",
    "5. USE FRESH SUBJECT MATTER. Do not reuse the topics, wording, or scenarios of the example",
    "   prompts you are given. Pick different subject domains entirely. The example prompts show you",
    "   the FORM a good request takes; they are not content to copy.",
    "6. ONE ITEM PER CASE, authored from scratch. Never reference another item, a previous request,",
    "   or an existing program.",
    "7. STAY IN SCOPE. If the language states what it is not for, do not write a case that asks for",
    "   it. Out-of-scope requests measure the router, not the generator.",
    "8. Each prompt should read like something a real user typed: 1-4 sentences, concrete, no",
    "   meta-commentary about testing or evaluation.",
    "",
    "OUTPUT FORMAT",
    "Return ONLY a JSON array, no prose and no code fence. Each element:",
    '  { "id": "kebab-case-slug", "prompt": "the request text", "targets": "item type or capability" }',
    "The id should name what the case exercises (e.g. 'cloze-dropdown-three-blanks'). `targets` is",
    "a short label used for coverage reporting; it is not sent to the backend.",
  ].join("\n");
}

function buildUserPrompt(surface: LanguageSurface, count: number): string {
  const parts: string[] = [];
  parts.push(`Language: L${surface.id}${surface.name ? ` (${surface.name})` : ""}`);
  if (surface.description) parts.push(`\nDescription:\n${surface.description}`);
  if (surface.scope?.summary) parts.push(`\nScope summary:\n${surface.scope.summary}`);
  if (surface.scope?.inScope?.length) {
    parts.push(`\nIn scope:\n${surface.scope.inScope.map((s) => `- ${s}`).join("\n")}`);
  }
  if (surface.scope?.outOfScope?.length) {
    parts.push(`\nOut of scope (never write a case for these):\n${surface.scope.outOfScope.map((s) => `- ${s}`).join("\n")}`);
  }
  if (surface.supportedItemTypes?.length) {
    parts.push(`\nSupported item types:\n${surface.supportedItemTypes.join(", ")}`);
  }
  if (surface.authoringGuide) parts.push(`\nAuthoring guide:\n${surface.authoringGuide}`);
  if (surface.examplePrompts?.length) {
    parts.push(
      "\nExample prompts (FORM to imitate, CONTENT to avoid — pick different subjects):\n" +
      surface.examplePrompts
        .map((e) => `- [${e.produces || "?"}] ${e.prompt}${e.notes ? `\n    note: ${e.notes}` : ""}`)
        .join("\n"),
    );
  }
  if (surface.usageGuide) parts.push(`\nFull user guide:\n${surface.usageGuide}`);
  parts.push(
    `\n\nWrite exactly ${count} cases for this language, following every rule. ` +
    `Return the JSON array and nothing else.`,
  );
  return parts.join("\n");
}

const AUTHOR_MAX_TOKENS = 16384;

async function authorCases(args: {
  surface: LanguageSurface; count: number; model: string; apiKey: string;
}): Promise<{ cases: (EvalCase & { targets?: string })[]; usage: any }> {
  const { surface, count, model, apiKey } = args;
  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(surface, count) }],
      max_tokens: AUTHOR_MAX_TOKENS,
      // Case authoring is judgment work — which capabilities to cover, what makes a request
      // unambiguous — so adaptive thinking rather than the spec path's disabled setting.
      thinking: { type: "adaptive" },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      timeout: 10 * 60 * 1000,
    },
  );

  // A truncated array is not recoverable and must not be written: the tail cases would be missing
  // with no signal in the file itself. Same reasoning as spec-generation-service's ceiling check.
  if (resp.data?.stop_reason === "max_tokens") {
    throw new Error(
      `case authoring hit the ${AUTHOR_MAX_TOKENS}-token ceiling and was truncated; ` +
      `lower --count or raise AUTHOR_MAX_TOKENS`,
    );
  }

  const text = (resp.data?.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err: any) {
    throw new Error(`model did not return parseable JSON (${err.message}): ${json.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("model returned JSON that is not an array");
  return { cases: parsed as (EvalCase & { targets?: string })[], usage: resp.data?.usage };
}

/**
 * Reject what the harness would choke on, and report what a human should look at.
 *
 * Deliberately NOT a quality judgment — nothing here decides whether a case is a GOOD case. That
 * takes reading them, and the point of writing the set to disk is that someone can.
 */
function validate(cases: (EvalCase & { targets?: string })[], count: number): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, c] of cases.entries()) {
    if (!c || typeof c.id !== "string" || typeof c.prompt !== "string") {
      problems.push(`case ${i}: missing id or prompt`);
      continue;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) problems.push(`case ${i}: id "${c.id}" is not kebab-case`);
    if (seen.has(c.id)) problems.push(`duplicate id "${c.id}"`);
    seen.add(c.id);
    if (c.prompt.trim().length < 40) problems.push(`case "${c.id}": prompt is suspiciously short`);
  }
  if (cases.length !== count) problems.push(`asked for ${count} cases, got ${cases.length}`);
  return problems;
}

/**
 * Content-word overlap between each generated case and the example prompts it was shown.
 *
 * This is a WEAK check on purpose. It catches a case that lifted an example's scenario wholesale;
 * it says nothing about the corpus, which this script cannot see. Real proximity is measured by
 * scripts/eval-case-proximity.ts against what RAG would actually retrieve.
 */
const STOP = new Set(("a an the and or but if then of for to in on at by with from as is are was " +
  "were be been being this that these those it its into about over under item question create " +
  "write make add show give correct answer answers option options student students").split(" "));

function contentWords(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function maxOverlapWithExamples(prompt: string, examples: ExamplePrompt[]): number {
  const a = contentWords(prompt);
  if (!a.size) return 0;
  let worst = 0;
  for (const e of examples) {
    const b = contentWords(e.prompt);
    if (!b.size) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    worst = Math.max(worst, shared / Math.min(a.size, b.size));
  }
  return worst;
}

function parseArgs(argv: string[]) {
  const a = {
    lang: "", count: 8, outDir: "data/model-eval/mcp",
    model: "claude-opus-5", dryRun: false, force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--lang") a.lang = argv[++i];
    else if (v === "--count") a.count = Math.max(1, parseInt(argv[++i], 10) || 8);
    else if (v === "--out-dir") a.outDir = argv[++i];
    // The authoring model is a variable worth being able to move: an Anthropic model writing the
    // cases that rank Anthropic against OpenAI is a bias worth being able to test rather than
    // argue about. Re-author with --model gpt-* equivalent reasoning by hand if it matters.
    else if (v === "--model") a.model = argv[++i];
    // Print the surface and the prompt without calling the API. Free, and the fastest way to see
    // whether a language's MCP surface is rich enough to author from at all.
    else if (v === "--dry-run") a.dryRun = true;
    // Overwrite an existing set. Off by default: these files get labeled and cited by eval runs,
    // so silently replacing one invalidates every citation that names it.
    else if (v === "--force") a.force = true;
  }
  if (!a.lang) { console.error("Provide --lang (e.g. --lang 0176)"); process.exit(1); }
  a.lang = a.lang.replace(/^L/i, "");
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = `${args.outDir}/${args.lang}.json`;
  const provPath = `${args.outDir}/${args.lang}.provenance.json`;

  if (existsSync(outPath) && !args.force && !args.dryRun) {
    console.error(`${outPath} already exists. Pass --force to overwrite (and re-run any eval that cites it).`);
    process.exit(1);
  }

  console.log(`[cases] fetching L${args.lang} MCP surface from ${CONSOLE_API_URL}`);
  const surface = await fetchSurface(args.lang);
  const examples = surface.examplePrompts || [];
  console.log(
    `[cases] surface: ${(surface.supportedItemTypes || []).length} item types, ` +
    `${examples.length} example prompts, ` +
    `${(surface.authoringGuide || "").length} chars authoring guide, ` +
    `${(surface.usageGuide || "").length} chars user guide`,
  );

  if (args.dryRun) {
    console.log(`\n--- system ---\n${buildSystemPrompt()}`);
    console.log(`\n--- user ---\n${buildUserPrompt(surface, args.count)}`);
    console.log("\n[cases] dry run — nothing generated, nothing spent.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("Set ANTHROPIC_API_KEY (.env.local)"); process.exit(1); }

  console.log(`[cases] authoring ${args.count} cases with ${args.model}`);
  const { cases, usage } = await authorCases({ surface, count: args.count, model: args.model, apiKey });

  const problems = validate(cases, args.count);
  if (problems.length) {
    console.error(`[cases] rejected — the model's output does not satisfy the case contract:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  // Strip `targets` from the written set: model-eval's EvalCase does not carry it, and a field the
  // harness ignores in a file the harness reads is a trap for the next reader. It is kept in
  // provenance, where coverage is the whole point.
  const written: EvalCase[] = cases.map((c) => ({ id: c.id, prompt: c.prompt.trim() }));

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(written, null, 2)}\n`);
  writeFileSync(provPath, `${JSON.stringify({
    lang: args.lang,
    authoredBy: args.model,
    source: {
      endpoint: CONSOLE_API_URL,
      query: "GetLanguageInfo (graffiticode-mcp-server/src/api.ts)",
      itemTypes: surface.supportedItemTypes || [],
      examplePromptCount: examples.length,
      authoringGuideChars: (surface.authoringGuide || "").length,
      usageGuideChars: (surface.usageGuide || "").length,
    },
    // The claim this file exists to support.
    corpusAccess: "none — this script imports no Firestore client and never reads training_examples",
    mode: "create-only (no currentCode on any case)",
    usage,
    cases: cases.map((c) => ({
      id: c.id,
      targets: c.targets || null,
      maxOverlapWithExamplePrompts: Number(maxOverlapWithExamples(c.prompt, examples).toFixed(3)),
    })),
  }, null, 2)}\n`);

  const covered = new Set(cases.map((c) => c.targets).filter(Boolean));
  const types = surface.supportedItemTypes || [];
  console.log(`\n[cases] wrote ${written.length} cases → ${outPath}`);
  console.log(`[cases] provenance → ${provPath}`);
  console.log(`[cases] targets covered: ${[...covered].join(", ") || "(none labeled)"}`);
  if (types.length) {
    const missing = types.filter((t) => ![...covered].some((c) => String(c).includes(t)));
    if (missing.length) console.log(`[cases] item types with no case: ${missing.join(", ")}`);
  }
  for (const c of cases) {
    const ov = maxOverlapWithExamples(c.prompt, examples);
    if (ov > 0.5) console.log(`[cases] WARNING "${c.id}" shares ${(ov * 100).toFixed(0)}% of its content words with an example prompt`);
  }
  console.log(`\nNext: npm run eval:holdout -- --lang ${args.lang} --set-dir ${args.outDir}`);
}

main().catch((err) => {
  console.error(err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err);
  process.exit(1);
});
