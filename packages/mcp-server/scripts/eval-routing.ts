// Routing eval: does an agent pick the RIGHT language for a prompt?
//
//   ANTHROPIC_API_KEY=<key> GRAFFITICODE_API_KEY=<key> npx tsx scripts/eval-routing.ts
//   ANTHROPIC_API_KEY=… GRAFFITICODE_API_KEY=… npx tsx scripts/eval-routing.ts --catalog-only
//
// eval-cross-language.ts calls the API directly, so it can't catch a routing bug — routing
// happens in the model's head. This eval puts a model in the loop with the REAL agent-facing
// surface (SERVER_INSTRUCTIONS + the live list_languages/get_language_info tool schemas and
// handlers from src/tools.ts, plus the assessments + learnosity SKILL.md bodies), gives it a
// prompt, and asserts which `language` it passes to create_item. create_item is stubbed — nothing
// is generated.
//
// The regression this exists to lock down: prompts that merely mention an assessment ("a
// 5-question quiz on the water cycle") were routing to the Learnosity languages (L0158/L0176),
// which are vendor-specific and should be chosen ONLY when the user names Learnosity.
//
// A negative assertion alone could not finish the job. "Did not route to Learnosity" is
// satisfied by calling nothing at all, so once the Learnosity leak was fixed the generic-quiz
// cases went green — and stayed green through the whole period the catalog had no ungated
// general assessment language and a model, correctly, declined to use Graffiticode for a quiz.
// The eval was measuring the absence of a wrong answer, not the presence of a right one.
// `expectReachable` (see Case) asserts the positive outcome, so a silent no-call now fails.
//
// Routing is stochastic, so each case runs N times; a 1-of-N regression is still a regression.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SERVER_INSTRUCTIONS,
  buildServerInstructions,
  listLanguagesTool,
  getLanguageInfoTool,
  handleListLanguages,
  handleGetLanguageInfo,
  type ToolContext,
} from "../src/tools.js";
// The RAW catalog (unprefixed ids), because buildServerInstructions formats the
// "L####" itself — handleListLanguages already prefixes and would double it.
import { listLanguages as apiListLanguages, type AuthContext } from "../src/api.js";

const MODEL = "claude-opus-4-8";
const RUNS_PER_CASE = Number(process.env.EVAL_RUNS ?? 3);
const SKILLS_REPO = process.env.GRAFFITICODE_SKILLS_PATH ?? "../graffiticode-skills";

const catalogOnly = process.argv.includes("--catalog-only");

// `--only <substr>` runs just the cases whose tag, `why`, or prompt contains <substr>.
// `--only starter` is the pre-resubmission check: the three ChatGPT storefront prompts,
// which are the only cases whose exact wording is chosen by someone outside this repo.
const onlyArg = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const gcKey = process.env.GRAFFITICODE_API_KEY;
if (!gcKey) {
  console.error("Set GRAFFITICODE_API_KEY to run this eval.");
  process.exit(2);
}
const auth: AuthContext = { type: "firebase", token: gcKey, source: "raw" };
const ctx: ToolContext = { auth };

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- The languages under test -------------------------------------------------------------

const LEARNOSITY = ["L0158", "L0176", "L0177"];
const norm = (id: string) => `L${id.replace(/^L/i, "").padStart(4, "0")}`.toUpperCase();

// --- A. Catalog invariants (deterministic, no model) ---------------------------------------

async function catalogInvariants() {
  console.log("\n=== Catalog invariants (live console) ===");

  const ids = async (args: { domain?: string; search?: string }) => {
    const res = (await handleListLanguages(ctx, args)) as { languages: any[] };
    return res.languages.map((l) => norm(l.id));
  };

  const assessments = await ids({ domain: "assessments" });
  check(
    "domain:assessments excludes the Learnosity languages",
    !assessments.some((id) => LEARNOSITY.includes(id)),
    `got ${assessments.join(", ")}`,
  );

  const learnosity = await ids({ domain: "learnosity" });
  check(
    "domain:learnosity contains L0176 (item content), and no longer the retired L0158",
    learnosity.includes("L0176") && !learnosity.includes("L0158"),
    `got ${learnosity.join(", ")}`,
  );

  for (const term of ["quiz", "multiple choice", "assessment", "test"]) {
    const hits = await ids({ search: term });
    check(
      `search:"${term}" returns no Learnosity language`,
      !hits.some((id) => LEARNOSITY.includes(id)),
      `got ${hits.join(", ") || "(none)"}`,
    );
  }

  // The gate must not make them undiscoverable to someone who actually wants Learnosity.
  const branded = await ids({ search: "learnosity" });
  check(
    'search:"learnosity" still finds them',
    branded.includes("L0176"),
    `got ${branded.join(", ") || "(none)"}`,
  );

  // A named brand outranks the item-type word beside it (console `brands`, 2026-09-16).
  // "mystic wonk quiz" once searched as a quiz: L0180 matched "quiz" and L0182 did not.
  const brandSearches: Array<[string, string[]]> = [
    ["mystic wonk quiz", ["L0182"]],
    ["MysticWonk questionnaire", ["L0182"]],
    ["learnosity multiple choice", ["L0176", "L0177", "L0178"]],
  ];
  for (const [term, want] of brandSearches) {
    const hits = await ids({ search: term });
    check(
      `search:"${term}" ranks the brand's language first`,
      want.includes(hits[0]),
      `got ${hits.join(", ") || "(none)"}`,
    );
  }

  const withHints = (await handleListLanguages(ctx, { domain: "assessments" })) as {
    languages: Array<{ id: string; when_to_use?: string }>;
  };
  const missing = withHints.languages.filter((l) => !l.when_to_use).map((l) => norm(l.id));
  check(
    "every assessments language ships a when_to_use on the wire",
    missing.length === 0,
    missing.length ? `missing on ${missing.join(", ")}` : "",
  );

  const l0176 = (await handleGetLanguageInfo(ctx, { language: "L0176" })) as {
    description: string;
    when_to_use?: string;
    not_for?: string[];
  };
  const gateText = `${l0176.description} ${l0176.when_to_use ?? ""}`.toLowerCase();
  check(
    "get_language_info(L0176) states the Learnosity-only gate",
    gateText.includes("only when") && gateText.includes("learnosity"),
    l0176.description,
  );
  // not_for comes from the language server's scope.json, fetched through the API gateway. In local
  // dev that gateway is often unreachable (.env.local points NEXT_PUBLIC_GC_API_URL at
  // localhost:3100), and every language's scope comes back null. Report that as "could not run"
  // rather than failing — a silent null here is an environment problem, not a catalog regression.
  if ((l0176.not_for?.length ?? 0) === 0) {
    console.log(
      "SKIP  get_language_info(L0176) surfaces not_for — no scope from the language server " +
        "(unreachable lang-server assets; point NEXT_PUBLIC_GC_API_URL at a live API gateway)",
    );
  } else {
    check("get_language_info(L0176) surfaces not_for (out-of-scope)", true, `${l0176.not_for!.length} entries`);
  }
}

// --- B. Routing eval (model in the loop) ----------------------------------------------------

interface Case {
  prompt: string;
  /** Must route here on every run. */
  expect?: string;
  /**
   * Must REACH this language: a `create` has to name it, and clarifying (`ask`) is acceptable,
   * but a no-call FAILS.
   *
   * This exists because `expectNot` cannot say it. A model that calls nothing trivially
   * satisfies "did not route to Learnosity", so the generic-quiz cases below scored PASS
   * throughout the period the catalog had no ungated general assessment language and a model
   * correctly refused to use Graffiticode at all — the eval was green precisely while the gap
   * was open. Assert the positive outcome, or the check measures nothing.
   */
  expectReachable?: string;
  /**
   * Must NOT route here. A no-call passes on purpose: when nothing in the catalog fits, saying
   * so IS the right answer, and demanding a call would invite the nearest-match failure this
   * eval exists to catch.
   */
  expectNot?: string[];
  why?: string;
  /** Free-form label for `--only`. */
  tag?: string;
}

const CASES: Case[] = [
  // Generic assessment requests. These must reach L0180 — the ungated general assessment
  // language, registered 2026-09-01. Before it existed they asserted only `expectNot:
  // LEARNOSITY` and passed on a silent no-call, which is how the eval stayed green while
  // "make me a five-question quiz" had nowhere to go.
  {
    prompt: "Make a 5-question multiple-choice quiz on the water cycle.",
    expectReachable: "L0180",
    why: "generic quiz",
  },
  {
    prompt: "Create a short quiz to test my students on photosynthesis.",
    expectReachable: "L0180",
    why: "generic quiz",
  },
  // Cloze was a no-call case while L0180 covered choice interactions ONLY, with a note to
  // "promote this to expectReachable when text entry ships". It has shipped: L0180's
  // routingHint now documents fill-in-the-blank (text-entry), dropdown cloze (inline-choice)
  // and word-bank cloze (gap-match). Declining is no longer correct, and the eval asserting
  // that it is would have blocked the language the catalog now advertises.
  {
    prompt: "Write a cloze fill-in-the-blank item about mitosis.",
    expectReachable: "L0180",
    why: "text entry shipped; cloze is L0180's now",
  },
  // Learnosity is named — it must still win.
  // Each names Learnosity AND specifies the content — so routing is the only open question. (An
  // underspecified prompt like "I need an item for our Learnosity item bank" makes a good agent
  // ask what the item is about, which tells us nothing about routing.)
  { prompt: "Author a Learnosity MCQ on adding fractions.", expect: "L0176" },
  {
    prompt:
      "I need an item for our Learnosity item bank: a grade 8 multiple-choice question on the " +
      "causes of the American Civil War, four options, one correct.",
    expect: "L0176",
  },
  {
    prompt:
      "Make a quiz item for our LMS — we use the Learnosity Items API. A short-text question " +
      "asking students which organelle is the powerhouse of the cell.",
    expect: "L0176",
  },
  // A named brand decides the language, even under the wrong noun. The console's scope gate
  // enforces this server-side (and refuses a brand request for a different kind of artifact —
  // "Mystic Wonk concept web" — which this eval cannot see, because create_item is stubbed).
  // These assert the agent gets there on its own, from the catalog line naming the brand.
  {
    tag: "brand",
    prompt: "Make a Mystic Wonk quiz about what our team should prioritize next quarter.",
    expectReachable: "L0182",
    why: "brand beats the noun: a Mystic Wonk quiz is a survey",
  },
  {
    tag: "brand",
    prompt: "Answer the Mystic Wonk test about office improvements.",
    expectReachable: "L0182",
    why: "brand beats the noun",
  },
  {
    tag: "brand",
    prompt: "Fill in the Mystic Wonk questionnaire on remote work.",
    expectReachable: "L0182",
    why: "brand beats the noun",
  },
  {
    tag: "brand",
    prompt: "Pull all items from our Learnosity item bank with the Data API.",
    expect: "L0178",
    why: "brand names the family; the Data API names the member",
  },
  // The specialists must still be reachable.
  { prompt: "Grade 5 ELA reading item on citing evidence from an informational passage.", expect: "L0175" },
  // L0181, not L0159. L0159 was the flashcard answer when it was the only card language;
  // it has since been narrowed to match and memory (concentration) GAMES and marked
  // `hidden`, so it is withheld from the catalog and cannot be routed to at all — this
  // case asserted an outcome the catalog had made impossible. L0181 is the flashcard
  // language and says so: "Route here for 'flashcards' ... Flashcards ONLY: matching games
  // and memory (concentration) card games are L0159."
  { prompt: "Flashcards for Spanish vocabulary — 10 common food words with their English translations.", expect: "L0181" },
  // L0179, not L0166: L0166 is the legacy spreadsheet dialect and ships a when_to_use that
  // says so on the wire ("Deprecated in favor of L0179 — prefer L0179 for all new spreadsheet
  // content"). A model that picks L0179 here is obeying that hint, so expecting L0166 asserted
  // that routing must IGNORE a deprecation notice we deliberately publish.
  { prompt: "A spreadsheet problem where students compute column totals with SUM.", expect: "L0179" },
  { prompt: "A concept web where students link the causes of the Great Depression.", expect: "L0183" },
  { prompt: "A bar chart of quarterly revenue for four regions.", expect: "L0173" },
  // The three ChatGPT directory starter prompts, VERBATIM. They belong here because a
  // storefront prompt has to route on its own words: the person typing it copied it off a
  // card and knows nothing about the catalog, so a prompt that only works when an operator
  // names the language is a prompt that fails in front of the person deciding whether to
  // install. Re-run with `--only starter` before any listing resubmission, and whenever a
  // language they touch is deprecated.
  //
  // Prompt 1 is the one that moved: it was recorded against L0166, which left the catalog
  // entirely when L0179 superseded it. Note that `list_languages(search: "invoice")` returns
  // NOTHING — this prompt routes on the inlined catalog reading "invoice" as a spreadsheet,
  // not on search, which is why it is asserted rather than assumed.
  //
  // The wording changed on 2026-09-17, and the trailing clause is the change: the old
  // prompt's RECORDED output claimed currency formatting, and the prompt as written does
  // not produce any — verified against production that day, no `$` and no format directive
  // anywhere in the result. The record had blamed L0166's deprecation, which was wrong on
  // the facts: L0179 formats currency perfectly well when ASKED, it just does not
  // volunteer it. Asking costs 18 characters and makes the recorded expectation true.
  // Keep this string identical to starter prompt 1 in `openai-listing-copy.md`; it is
  // 120 of the portal's 128 characters.
  {
    tag: "starter",
    prompt:
      "Create an invoice with line items, quantity, unit price, a line total per row, " +
      "and a grand total, formatted as currency.",
    expect: "L0179",
  },
  { tag: "starter", prompt: "Create a concept web explaining how rain forms.", expect: "L0183" },
  {
    tag: "starter",
    prompt:
      "Create a Learnosity water cycle assessment: one multiple-choice and one " +
      "fill-in-the-blank, answers marked.",
    expect: "L0176",
  },
];

function loadSkill(name: string): string {
  const path = resolve(SKILLS_REPO, name, "SKILL.md");
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${path}. Set GRAFFITICODE_SKILLS_PATH to the skills repo.`);
    process.exit(2);
  }
}

// Stub create_item: record the routing decision and stop. Nothing is generated.
const createItemStub = {
  name: "create_item",
  description:
    "Create interactive content in a Graffiticode language. Call list_languages() first to " +
    "discover available languages, then pass the language ID here.",
  input_schema: {
    type: "object" as const,
    properties: {
      language: { type: "string", description: "Language ID (e.g., 'L0166')" },
      description: { type: "string", description: "Natural language description of what to create" },
    },
    required: ["language", "description"],
  },
};

// The escape hatch: an agent with no good match should ASK, not force the closest language.
const askUserStub = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question. Use this when no available Graffiticode language fits " +
    "the request, instead of forcing the closest match.",
  input_schema: {
    type: "object" as const,
    properties: { question: { type: "string" } },
    required: ["question"],
  },
};

type Outcome =
| { kind: "create"; language: string; discovery?: number }
  | { kind: "ask"; question: string; discovery?: number }
  | { kind: "none"; text: string; discovery?: number };

async function routeOnce(client: Anthropic, prompt: string, system: string): Promise<Outcome> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  // How many list_languages/get_language_info calls the model made before deciding.
  // This is the latency metric the inlined catalog exists to move: each one costs
  // its own round-trip PLUS a model turnaround (measured 2.7s and 7.2s in a real
  // session), so a routing decision reached with 0 discovery calls is ~14s faster
  // than the same decision reached with 2.
  let discovery = 0;
  const tools = [
    { name: listLanguagesTool.name, description: listLanguagesTool.description, input_schema: listLanguagesTool.inputSchema },
    { name: getLanguageInfoTool.name, description: getLanguageInfoTool.description, input_schema: getLanguageInfoTool.inputSchema },
    createItemStub,
    askUserStub,
  ] as Anthropic.Tool[];

  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system,
      tools,
      messages,
    });

    const sayText = () =>
      res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();

    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) return { kind: "none", text: sayText(), discovery };

    // A routing decision ends the run.
    for (const call of calls) {
      if (call.name === "create_item") {
        return { kind: "create", language: norm(String((call.input as any).language ?? "")), discovery };
      }
      if (call.name === "ask_user") {
        return { kind: "ask", question: String((call.input as any).question ?? ""), discovery };
      }
    }

    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      let out: unknown;
      try {
        out =
          call.name === "list_languages"
            ? ((discovery += 1), await handleListLanguages(ctx, call.input as any))
            : ((discovery += 1), await handleGetLanguageInfo(ctx, call.input as any));
      } catch (err) {
        out = { error: String(err) };
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return { kind: "none", text: "(tool-loop exhausted)", discovery };
}

async function routingEval() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("Set ANTHROPIC_API_KEY to run the routing eval (or pass --catalog-only).");
    process.exit(2);
  }
  const client = new Anthropic({ apiKey: anthropicKey });

  // The real agent-facing surface: server instructions + the two skills that teach
  // discovery.
  //
  // Instructions are built the way server.ts builds them — with the live catalog
  // inlined — because that is what changes routing. Testing the bare
  // SERVER_INSTRUCTIONS would measure a prompt no client is ever sent, and the
  // whole point of inlining the catalog is that the model can now route WITHOUT
  // calling list_languages first. If the catalog fetch fails we fall back to the
  // bare text, exactly as the server does.
  let catalogForInstructions: Awaited<ReturnType<typeof apiListLanguages>> | null = null;
  try {
    catalogForInstructions = await apiListLanguages({ auth });
  } catch {
    catalogForInstructions = null;
  }
  const instructions = buildServerInstructions(catalogForInstructions);
  console.log(
    `instructions: ${instructions.length} chars` +
      (catalogForInstructions ? ` (catalog inlined: ${catalogForInstructions.length} languages)` : " (no catalog — bare)")
  );

  const system = [
    instructions,
    "\n\n--- Skill: assessments ---\n",
    loadSkill("assessments"),
    "\n\n--- Skill: learnosity ---\n",
    loadSkill("learnosity"),
  ].join("");

  const cases = onlyArg
    ? CASES.filter((c) =>
        `${c.tag ?? ""} ${c.why ?? ""} ${c.prompt}`.toLowerCase().includes(onlyArg.toLowerCase()),
      )
    : CASES;
  if (onlyArg && cases.length === 0) {
    console.error(`--only ${onlyArg} matched no cases.`);
    process.exit(2);
  }

  console.log(
    `\n=== Routing eval (${MODEL}, ${RUNS_PER_CASE} runs/case` +
      (onlyArg ? `, --only ${onlyArg}: ${cases.length} of ${CASES.length} cases` : "") +
      ") ===",
  );

  for (const c of cases) {
    const outcomes = await Promise.all(
      Array.from({ length: RUNS_PER_CASE }, () => routeOnce(client, c.prompt, system)),
    );

    const summarize = (o: Outcome) =>
      o.kind === "create" ? o.language : o.kind === "ask" ? "ASKED" : "no-call";
    // Discovery calls per run, appended to the detail. This is the latency metric:
    // "disc 0,0,0" means every run routed straight to create_item, skipping the two
    // pre-flight calls that used to cost ~14s before generation even started.
    const disc = outcomes.map((o) => o.discovery ?? 0);
    const detail =
      outcomes.map(summarize).join(", ") + `  [disc ${disc.join(",")}]`;

    // A non-routing outcome is only meaningful if you can read what it said — print it so a
    // "no-call" that quietly authored a quiz in chat can't hide behind a green check.
    if (process.env.EVAL_VERBOSE) {
      for (const o of outcomes) {
        if (o.kind === "ask") console.log(`        ASKED: ${o.question.slice(0, 220)}`);
        if (o.kind === "none") console.log(`        SAID:  ${o.text.slice(0, 220)}`);
      }
    }

    if (c.expect) {
      const ok = outcomes.every((o) => o.kind === "create" && o.language === c.expect);
      check(`${c.expect}  "${c.prompt}"`, ok, detail);
    } else if (c.expectReachable) {
      // Creating in the named language passes; asking a clarifying question passes, since that
      // is a legitimate response to an underspecified request. A no-call FAILS — that is the
      // whole point of this mode, and the outcome `expectNot` silently rewarded.
      const ok = outcomes.every(
        (o) => (o.kind === "create" && o.language === c.expectReachable) || o.kind === "ask",
      );
      check(
        `${c.expectReachable}  "${c.prompt}"${c.why ? ` (${c.why})` : ""}`,
        ok,
        detail,
      );
    } else {
      // Must not land on a gated language. Asking the user is a pass — that's the intended
      // behavior when no specialist fits.
      const ok = outcomes.every(
        (o) => !(o.kind === "create" && c.expectNot!.includes(o.language)),
      );
      check(`not-Learnosity  "${c.prompt}"${c.why ? ` (${c.why})` : ""}`, ok, detail);
    }
  }
}

async function main() {
  await catalogInvariants();
  if (!catalogOnly) await routingEval();

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
