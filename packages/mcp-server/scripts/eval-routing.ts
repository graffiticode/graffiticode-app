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
//
// The installation: PROFILE_DIR selects it, as it does for the servers, and it is loaded before
// anything reads the catalog, the instructions or the tool descriptions (routing-surface.ts).
// Without PROFILE_DIR the eval measures the built-in Graffiticode surface, unchanged. With a
// profile, the instructions, the discovery tools' descriptions, the create_item description and
// the inlined catalog are the profile's, and a case whose language the profile doesn't offer is
// judged "not-offered" (planCase): asking or declining passes, creating anywhere fails.
//
//   PROFILE_DIR=<profile checkout> ANTHROPIC_API_KEY=… GRAFFITICODE_API_KEY=… npx tsx scripts/eval-routing.ts

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Types only: the modules themselves are imported by loadRoutingSurface, after the installation
// is loaded.
import type { ToolContext } from "../src/tools.js";
import type { AuthContext } from "../src/api.js";
import {
  evidenceLines, inlinedCatalogIds, judge, loadRoutingSurface, planCase, replyClassifier, routeOnce,
  type ExpectUpdate, type FixtureItem, type Outcome, type RoutingSurface,
} from "./routing-surface.js";
import { surveyFixture } from "./routing-fixtures.js";

const MODEL = "claude-opus-4-8";
const RUNS_PER_CASE = Number(process.env.EVAL_RUNS ?? 3);
// A local checkout of the skills: graffiticode-app's packages/skills, run from packages/mcp-server.
const SKILLS_REPO = process.env.GRAFFITICODE_SKILLS_PATH ?? "../skills";

const catalogOnly = process.argv.includes("--catalog-only");
// create_item is offered to the model as the installation serves it. `--legacy-create-stub`
// restores the short stub text earlier runs used, only to compare against them.
const legacyCreateStub = process.argv.includes("--legacy-create-stub");

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

// Set in main(), before anything below runs.
let surface: RoutingSurface;

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
    const res = (await surface.handleListLanguages(ctx, args)) as { languages: any[] };
    return res.languages.map((l) => norm(l.id));
  };

  const assessments = await ids({ domain: "assessments" });
  check(
    "domain:assessments excludes the Learnosity languages",
    !assessments.some((id) => LEARNOSITY.includes(id)),
    `got ${assessments.join(", ")}`,
  );

  // Checks that name a language only apply where the installation offers it.
  const skip = (name: string, id: string) => console.log(`SKIP  ${name} — the installation doesn't offer ${id}`);
  const learnosity = await ids({ domain: "learnosity" });
  if (surface.offered("L0176")) {
    check(
      "domain:learnosity contains L0176 (item content), and no longer the retired L0158",
      learnosity.includes("L0176") && !learnosity.includes("L0158"),
      `got ${learnosity.join(", ")}`,
    );
  } else skip("domain:learnosity contains L0176", "L0176");

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
  if (surface.offered("L0176")) {
    check(
      'search:"learnosity" still finds them',
      branded.includes("L0176"),
      `got ${branded.join(", ") || "(none)"}`,
    );
  } else skip('search:"learnosity" still finds them', "L0176");

  // A named brand outranks the item-type word beside it (console `brands`, 2026-09-16).
  // FigJam is a brand both FigJam languages carry (L0186 places by coordinates, L0187 lays
  // out automatically), so either may rank first; "retro" alone would not pick them over
  // nothing. L0182 carried a brand until 2026-09-22 (87cfc14: generic surveys, no brand), and
  // its brand searches were removed from this eval with it.
  const brandSearches: Array<[string, string[]]> = [
    ["figjam retro board", ["L0186", "L0187"]],
    ["learnosity multiple choice", ["L0176", "L0177", "L0178"]],
  ];
  for (const [term, want] of brandSearches) {
    if (!want.some((id) => surface.offered(id))) {
      skip(`search:"${term}" ranks the brand's language first`, want.join("/"));
      continue;
    }
    const hits = await ids({ search: term });
    check(
      `search:"${term}" ranks the brand's language first`,
      want.includes(hits[0]),
      `got ${hits.join(", ") || "(none)"}`,
    );
  }

  const withHints = (await surface.handleListLanguages(ctx, { domain: "assessments" })) as {
    languages: Array<{ id: string; when_to_use?: string }>;
  };
  const missing = withHints.languages.filter((l) => !l.when_to_use).map((l) => norm(l.id));
  check(
    "every assessments language ships a when_to_use on the wire",
    missing.length === 0,
    missing.length ? `missing on ${missing.join(", ")}` : "",
  );

  if (surface.offered("L0176")) {
    const l0176 = (await surface.handleGetLanguageInfo(ctx, { language: "L0176" })) as {
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
  } else skip("get_language_info(L0176) states the Learnosity-only gate", "L0176");

  // Every language a case expects must be one discovery advertises, or the case asserts an
  // outcome the catalog has made impossible (a case expected the deprecated L0173 for months).
  // Cases the installation doesn't offer are judged "not-offered" instead (planCase).
  const advertised = new Set(await ids({}));
  const expected = [...new Set(CASES.filter((c) => planCase(c, surface).kind === "as-written")
    // New items only: an existing item (expectUpdate) needn't be in what discovery advertises.
    .map((c) => c.expect ?? c.expectReachable).filter((id): id is string => Boolean(id)))];
  const stale = expected.filter((id) => !advertised.has(id));
  check("every language the cases expect is advertised by discovery", stale.length === 0,
    stale.length ? `not advertised: ${stale.join(", ")}` : `${expected.length} expected languages`);

  // With a profile: discovery lists, and the instructions inline, only what the installation
  // offers. A language it doesn't offer must not be advertised in either place.
  if (surface.receipt) {
    const listed = await ids({});
    const unoffered = listed.filter((id) => !surface.offered(id));
    check("list_languages returns only languages the installation offers", unoffered.length === 0, unoffered.length ? `also ${unoffered.join(", ")}` : `${listed.length} listed`);
    const inlined = inlinedCatalogIds(surface.instructions(await surface.listCatalog({ auth })));
    const extra = inlined.filter((id) => !surface.offered(id));
    check("the instructions inline only languages the installation offers", extra.length === 0, extra.length ? `also ${extra.join(", ")}` : `${inlined.length} inlined`);
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
  /**
   * A survey the user already has: the run must render this item (served from SURVEYS) and
   * then call update_item on it, naming each of these ideas in its modification.
   */
  expectUpdate?: ExpectUpdate;
  /**
   * The user's fixed answer to a clarifying question. With `expect`, the run must clarify first
   * (ask_user, or a text reply the classifier calls `clarify`), then create from this reply.
   */
  followUp?: string;
  why?: string;
  /** Free-form label for `--only`. */
  tag?: string;
}

// The surveys the survey cases answer, as render_item would return them.
const SURVEYS: Record<string, FixtureItem> = {
  "svy-office-2026": surveyFixture("svy-office-2026", {
    name: "office-improvements", title: "Office improvements",
    ideas: ["standing desks", "quiet room", "better coffee", "more plants"], minChoices: 1, maxChoices: 3,
  }),
  "svy-remote-2026": surveyFixture("svy-remote-2026", {
    name: "remote-work", title: "Remote work",
    ideas: ["flexible hours", "no-meeting Fridays", "home office stipend"], minChoices: 1, maxChoices: 2,
  }),
};

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
    // Concrete, so creating is the right response. Its vague predecessor ("Create a short quiz
    // to test my students on photosynthesis.") drew clarifying questions, which the server
    // instructions ask for ("Make a quiz on fractions" -> ask how many questions).
    prompt: "Create a 4-question multiple-choice quiz on photosynthesis for grade 7 students, one correct answer per question.",
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
  // enforces this server-side (and refuses a brand request for a different kind of artifact,
  // which this eval cannot see, because create_item is stubbed). These assert the agent gets
  // there on its own, from the catalog line naming the brand. "quiz" would pull L0180; FigJam
  // names the board, and automatic layout names L0187 (L0186 is placement by coordinates).
  {
    tag: "brand",
    prompt:
      "Make a FigJam board of quiz ideas for our team retro: sticky notes in three columns " +
      "(keep, drop, try), laid out automatically.",
    expectReachable: "L0187",
    why: "brand beats the noun, and automatic layout is L0187",
  },
  {
    tag: "brand",
    prompt:
      "Make a FigJam board with a sticky note 'Plan' at x=100, y=200 and a sticky note 'Ship' " +
      "at x=400, y=200, joined by an arrow.",
    expectReachable: "L0186",
    why: "explicit coordinates are L0186",
  },
  // L0182 takes an existing survey and records a response; it doesn't author questionnaires.
  // Answering one is render_item then update_item on the survey's id, so these cases name a
  // survey the eval serves (SURVEYS) and the run must record a response naming the ideas
  // chosen. Until 2026-09-22 these were Mystic Wonk brand cases (87cfc14 removed the brand).
  {
    tag: "survey",
    prompt:
      "Take our office-improvements survey (item svy-office-2026) and record my response: " +
      "standing desks first, then a quiet room.",
    expectUpdate: { itemId: "svy-office-2026", mentions: ["standing desks", "quiet room"] },
    why: "answering an existing ranked-choice survey",
  },
  {
    tag: "survey",
    prompt: "Answer the remote-work survey svy-remote-2026 for me: I'd choose flexible hours, then no-meeting Fridays.",
    expectUpdate: { itemId: "svy-remote-2026", mentions: ["flexible hours", "no-meeting Fridays"] },
    why: "answering an existing ranked-choice survey",
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
  // L0184, not L0173: L0173 is Deprecated, and the catalog drops deprecated languages, so it
  // is no longer advertised and this case asserted an outcome the catalog had made impossible. The values are given, so
  // creating is the right response rather than asking for them.
  {
    prompt: "A bar chart of Q3 revenue by region: North $120k, South $95k, East $140k, West $80k.",
    expect: "L0184",
  },
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
    // The server instructions give "Create an invoice" as THE example of a request to clarify
    // (ask "What line items and amounts?"), and the 2026-11-21 run did exactly that, 3 of 3. So
    // this case clarifies first, gets these line items, and must then create in L0179.
    followUp:
      "Line items: website design, 12 hours at $95; logo design, 1 at $450; hosting setup, 1 at $120.",
    expect: "L0179",
  },
  { tag: "starter", prompt: "Create a concept web on how rain forms that students complete by dragging terms into place.", expect: "L0183" },
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

async function routingEval() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("Set ANTHROPIC_API_KEY to run the routing eval (or pass --catalog-only).");
    process.exit(2);
  }
  const client = new Anthropic({ apiKey: anthropicKey });
  // Text-only replies are judged from the whole reply, by a small model (routing-surface.ts).
  const classifyReply = replyClassifier(client);

  // The real agent-facing surface: server instructions + the two skills that teach
  // discovery.
  //
  // Instructions are built the way server.ts builds them — with the live catalog
  // inlined — because that is what changes routing. Testing the bare
  // SERVER_INSTRUCTIONS would measure a prompt no client is ever sent, and the
  // whole point of inlining the catalog is that the model can now route WITHOUT
  // calling list_languages first. If the catalog fetch fails we fall back to the
  // bare text, exactly as the server does.
  let catalogForInstructions: Awaited<ReturnType<RoutingSurface["listCatalog"]>> | null = null;
  try {
    catalogForInstructions = await surface.listCatalog({ auth });
  } catch {
    catalogForInstructions = null;
  }
  const instructions = surface.instructions(catalogForInstructions);
  // Counted from the instructions themselves: the catalog fetched is filtered before it is
  // inlined (discovery and the installation's offer), so its length overstates what is shown.
  const inlined = inlinedCatalogIds(instructions).length;
  console.log(
    `instructions: ${instructions.length} chars` +
      (catalogForInstructions ? ` (catalog inlined: ${inlined} languages, of ${catalogForInstructions.length} fetched)` : " (no catalog — bare)")
  );
  console.log(
    legacyCreateStub
      ? "create_item: the legacy stub text (--legacy-create-stub; no client is sent it)"
      : `create_item: as served (${surface.createItemTool.description.length} chars)`,
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
      Array.from({ length: RUNS_PER_CASE }, () =>
        routeOnce(client, {
          prompt: c.prompt, system, model: MODEL, surface, ctx, legacyCreateStub,
          items: SURVEYS, followUp: c.followUp, classifyReply,
        })),
    );

    const summarize = (o: Outcome) =>
      o.kind === "create" ? `${o.language}${o.afterClarification ? " (after clarifying)" : ""}`
        : o.kind === "update" ? `update ${o.itemId}`
          : o.kind === "ask" ? "ASKED"
            : o.kind === "exhausted" ? "EXHAUSTED"
              : `text: ${o.reply ?? "unclassified"}`;
    // A run that wrote content into the chat fails whatever else it did; flag it in the summary.
    const flagged = (o: Outcome) => `${summarize(o)}${o.replies.some((r) => r.reply === "content") ? " +content" : ""}`;
    // Discovery calls per run, appended to the detail. This is the latency metric:
    // "disc 0,0,0" means every run routed straight to create_item, skipping the two
    // pre-flight calls that used to cost ~14s before generation even started.
    const disc = outcomes.map((o) => o.discovery ?? 0);
    const detail =
      outcomes.map(flagged).join(", ") + `  [disc ${disc.join(",")}]`;

    // A non-routing outcome is only meaningful if you can read what it said — print it so a
    // "no-call" that quietly authored a quiz in chat can't hide behind a green check.
    // Full replies, so a reader can check each classification against the text it judged.
    // Every reply each run wrote (a clarification it continued past included), with its verdict.
    if (process.env.EVAL_VERBOSE) for (const line of evidenceLines(outcomes)) console.log(line);

    const { ok, label } = judge(c, planCase(c, surface), outcomes);
    check(label, ok, detail);
  }
}

async function main() {
  // The installation first: everything below reads it.
  surface = await loadRoutingSurface(process.env);
  const r = surface.receipt;
  console.log(r
    ? `installation: ${r.installationId} (profile ${r.profileDigest.slice(0, 12)}${r.profileRef ? ` at ${r.profileRef.slice(0, 12)}` : ""})`
    : "installation: built-in Graffiticode (no PROFILE_DIR)");
  await catalogInvariants();
  if (!catalogOnly) await routingEval();

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
