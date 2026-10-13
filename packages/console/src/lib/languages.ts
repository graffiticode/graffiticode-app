import { getLanguageScope, getLanguageServerDoc } from "./language-server-client";

export interface Language {
  id: string;
  name: string;
  description: string;
  longDescription?: string;
  routingHint?: string;
  // The words people actually type for what this language makes, when the catalog
  // text doesn't contain them. `search` scores against name, description and the
  // routing/scope prose — all of which are written in OUR vocabulary, not the
  // user's. "invoice" returned nothing while L0179 is exactly the language for one,
  // because the catalog says "Spreadsheets" and a person asking for an invoice does
  // not say spreadsheet. Same shape as the generic-quiz gap: the language existed
  // and the word didn't reach it.
  //
  // These are ARTIFACT NAMES and synonyms — what the output would be called — never
  // aspirational. A keyword that pulls a language into a request it cannot satisfy
  // recreates the nearest-match failure the vendor gate exists to prevent, and it
  // does it below the gate where nothing checks. Scored as secondary, so a language
  // whose NAME matches still outranks one that merely lists the word.
  keywords?: string[];
  domains: string[];
  status?: string;
  // Internal dialect (e.g. the L0010 composition planner). Registered so the
  // console recognizes it and can show its items for curation, but excluded
  // from the planner's candidate catalog (it must never propose itself).
  internal?: boolean;
  // Withheld from the CATALOG — the `languages` query and the planner's candidate
  // list — while still registered everywhere else. A language lands here when it
  // works well enough to keep authoring but not well enough to be recruited for:
  // its output can't be finished from a chat (L0172 needs a human to wire up the
  // Figma side) or it isn't done (L0174).
  //
  // Deliberately NOT `selectLanguages()`, which drives the console's own signed-in
  // picker and tools gallery — hiding a language from discovery must not take it
  // away from the person still building it. findLanguageById also keeps answering,
  // so existing items render and `language(id)` still resolves.
  hidden?: boolean;
  // Populated from each lang server's scope.json, but ONLY when a caller asks for
  // it with `listLanguages({ enrich: true })` — the catalog listing does not.
  //
  // This reverses an earlier intent recorded here, that scope.json would become
  // universal and the static `description`/`routingHint` would then be trimmed.
  // Listing and detail are deliberately different surfaces now: listing answers
  // "what exists" from static metadata and must be fast enough to route against,
  // while scope.json stays authoritative for single-language detail via
  // getLanguageInfo(). Making the listing depend on ~19 other services to answer
  // is what took it to 57-75s. If this text should ever be authoritative for
  // listing too, publish it INTO the catalog at language-deploy time rather than
  // fetching it on every read.
  summary?: string;
  inScope?: string[];
  outOfScope?: string[];
  // Vendor gate. A language that only makes sense for a named vendor/platform (its output
  // is that vendor's format) lists the gate terms here. Such a language is a legitimate
  // answer ONLY when the user named the vendor — never as the fallback for a generic
  // request that happens to share its item types. Enforced in listLanguages(): a gated
  // language is withheld from a `search` that doesn't name the gate, so its honest but
  // generic in_scope text ("multiple-choice items") can't pull it into a plain quiz
  // request. It stays reachable by naming the vendor, by domain-scoping to the gate
  // domain, or in the unfiltered full catalog.
  gatedBy?: string[];
  // Proper nouns — a product, vendor or platform this language serves. Naming one is the
  // strongest routing signal there is, stronger than any item-type word beside it: "<Brand>
  // quiz", where <Brand> is a survey product, is that survey with the wrong noun, not a quiz.
  // When the ask names a brand, the scope gate may only land in the languages that carry it,
  // and refuses the request when none of them fits ("<Brand> concept web"). `gatedBy` terms
  // count as brands too (see brandTerms), so a gate is also a pull.
  brands?: string[];
  // Composition permission allowlist: the upstream dialects this language is ALLOWED to
  // compose with (consume/embed). This is the hard fence — a head may only bind upstreams
  // within it; the client can never create an undeclared edge.
  //   - explicit list (e.g. ["0179"]) — may compose ONLY with those upstreams
  //   - ["*"] — may compose with any non-internal authoring language
  //   - absent / empty — ATOMIC ONLY (no composition)
  //
  // A PERMISSION, NOT A TRIGGER. Nothing here makes a language compose. Composition is
  // reactive: the head generates first, and if its program emitted `data use "<lang>"` the
  // console generates that upstream — if this list allows it. What decides to emit the
  // binding is the language's OWN instructions.md (see L0176's "Pipeline Composition"
  // section, the reference implementation). A language listed here whose instructions never
  // mention composing is atomic in practice, which is the correct default.
  //
  // Deprecating an edge (removing an id here) stops NEW compositions only — bindings already
  // present in an item's source are grandfathered at edit time, so live content never breaks.
  // See composesWithFor / fenceComposition in language-router.ts.
  composesWith?: string[];
  // Anonymous free-plan (MCP trial) scope. Marking ANY language with this turns
  // the trial into an allowlist: only marked languages may be created without an
  // account, and everything else returns a structured
  // `language_not_in_trial_scope` listing what is allowed.
  //
  // Ships inert on purpose. With nothing marked the gate is a no-op, so
  // deploying it can't silently take languages away from trial users mid-task;
  // enabling it is then a reversible data change (mark the set) rather than a
  // release. See freePlanLanguageIds() / isLanguageInFreePlanScope().
  freePlan?: boolean;
  // Sponsor: items created in this language are free to the customer — not
  // metered to Stripe and not counted against the plan allowance. Used to carry
  // the cost of a language we're promoting.
  //
  // Distinct from `freePlan` above, and the two answer different questions:
  // `freePlan` asks "may an ANONYMOUS caller create this at all", `sponsor`
  // asks "who pays for it once created". They compose without interacting — an
  // anonymous trial item in a sponsored language is simply free twice over.
  //
  // Uncapped by design: while this is set, every item in the language is free,
  // and ending a sponsorship is a flag flip after which items bill normally with
  // no wall and no notice. There is deliberately no per-user or global budget
  // yet; usage rows carry a `sponsorId` so one can be added later and evaluated
  // against history that already exists.
  //
  // Safe as a LANGUAGE flag specifically because the server decides an item's
  // language (the scope gate re-routes a mis-labelled request), so a caller
  // cannot elect into it. The same idea keyed on `client` would be a billing
  // bypass — `client` is caller-supplied. See isLanguageSponsored().
  //
  // The value is the sponsor's display name, shown to the customer on the Usage
  // tab — attribution is most of the point of sponsoring. Setting it also makes
  // the language's `status` "Sponsored" (see LANGUAGES).
  sponsor?: string;
  // Where the "Sponsored by" footer on the Tools gallery links to.
  sponsorUrl?: string;
  // The account that pays for this language's items: each one is debited from
  // its allowance and metered to its Stripe customer, past any cap. Unset means
  // we absorb the cost.
  sponsorUid?: string;
}

export const LANGUAGES: Language[] = ([
  // Self-composition (L0000 → L0000) is an internal test edge for the `data use` machinery:
  // resolveUpstreams, the fence, splitRequest, upstream generation, chaining, schema
  // validation and the atomic fallback, with no second language in the loop. L0000's
  // instructions.md binds only when a request describes a separate producer program.
  // An L0000 → L0170 edge was considered and rejected: L0170 already inherits L0000.
  { id: "0000", name: "L0000", composesWith: ["0000"], description: "Base language — functional expressions rendered as JSON", routingHint: "The root Graffiticode language that every dialect inherits from. Evaluates a closed functional program — arithmetic, strings, lists and ranges, records and tags, lambdas and let-bound helpers, pattern matching, comparisons and conditionals, map/filter/reduce — and renders the result as plain JSON. Route here only for a request to compute or transform plain values. Does NOT author content: assessments, quizzes, spreadsheets, charts, maps, diagrams, boards, flashcards and surveys belong to the dialects that extend it. No rendered UI beyond the JSON view, no side effects, and no external I/O.", domains: [], sponsor: "Artcompiler Inc.", sponsorUrl: "https://artcompiler.com", sponsorUid: "24493e1c7a7f1ad57e3c478087c74c2dacb0cba1", status: "Sponsored" },
  // L0001 is DEPRECATED — retained as a repo for historical reference only. Do not re-enable.
  // L0002 (core) is superseded by L0003, an L0000-based starter language. It stays out of the
  // registry, but its service keeps running and the console still bundles its Form
  // (FormReact.tsx, `npm run refresh`) for the ~240 L0002 items that exist (2026-10-04).
  // { id: "0002", name: "L0002", description: "Core language", domains: [] },
  { id: "0003", name: "L0003", description: "Starter language — hello, image, theme, and print", domains: [], hidden: true },
  { id: "0010", name: "L0010", description: "Composition planner (internal)", routingHint: "Internal composition-planning dialect: maps a request to an ordered language sequence (`plan [...]` → { langs }). Not a content-authoring target.", domains: [], status: "Internal", internal: true },
  { id: "0013", name: "L0013", description: "Screenshot thumbnails (internal)", routingHint: "Internal utility dialect: renders an existing item's form view to a cropped PNG thumbnail and uploads it (`snap item \"<id>\" {}`). Not a content-authoring target.", domains: [], status: "Internal", internal: true },
  { id: "0014", name: "L0014", description: "TransLaTeX rule sets (internal)", routingHint: "Internal utility dialect: authors TransLaTeX translation rule sets (`words`/`types`/`rules`/`tests` → { options, tests }). Not a content-authoring target.", domains: [], status: "Internal", internal: true },
  // { id: "0011", name: "L0011", description: "Property editors", domains: [] },
  // { id: "0012", name: "L0012", description: "Object viewers", domains: [] },
  // { id: "0137", name: "L0137", description: "Data transformers", domains: [] },
  // { id: "0146", name: "L0146", description: "SVG scrapers", domains: [] },
  // { id: "0147", name: "L0147", description: "Chart renderers", domains: [] },
  // { id: "0150", name: "L0150", description: "Free shipping calculators", domains: [] },
  // { id: "0151", name: "L0151", description: "Spreadsheets questions", domains: [] },
  { id: "0152", name: "L0152", description: "Interactive map questions", routingHint: "Interactive map-based questions — learners answer by clicking or identifying locations on a map (states, capitals, countries, regions).", domains: ["assessments"], status: "Deprecated" },
  { id: "0153", name: "L0153", description: "Area model questions", routingHint: "Area model multiplication questions with visual grid representations.", domains: ["assessments"], status: "Beta" },
  { id: "0154", name: "L0154", description: "Magic square questions", routingHint: "Magic square puzzle questions with grid-based number placement.", domains: ["assessments"], status: "Beta" },
  // { id: "0155", name: "L0155", description: "Stoplight questions", domains: [] },
  // { id: "0156", name: "L0156", description: "Short text scorers", domains: [] },
  // { id: "0157", name: "L0157", description: "Geoboard manipulatives", domains: [] },
  { id: "0158", name: "L0158", description: "Learnosity assessment items (legacy; prefer L0176). Use ONLY when the user names Learnosity or a Learnosity Item Bank / LMS.", routingHint: "Do NOT use for generic quizzes, tests, or practice items that don't name Learnosity. Deprecated in favor of L0176 — prefer L0176 for all new Learnosity item content. Learnosity assessment items — MCQ, short text, cloze, formula, classification, order list, and choice matrix question types via Learnosity API.", domains: ["learnosity"], gatedBy: ["learnosity"], status: "Deprecated" },
  // Flashcards moved to L0181 — same study loop, rebuilt on L0000. L0159 keeps match and
  // memory, which L0181 does not do, and keeps serving every item already authored in it.
  { id: "0159", name: "L0159", description: "Match and Memory card games", routingHint: "Matching games, where a player pairs related terms, and memory (concentration) card games, where a player flips hidden cards to find pairs. Both are driven by a list of two-sided fact pairs, with LaTeX math support. For a FLASHCARD deck — cards a learner flips and rates one at a time — use L0181, not this.", keywords: ["matching game", "memory game", "pairs", "concentration"], domains: ["assessments"], hidden: true },
  // { id: "0160", name: "L0160", description: "Learnosity QTI Importer", domains: [] },
  // { id: "0161", name: "L0161", description: "Expression translators", domains: [] },
  // { id: "0162", name: "L0162", description: "Walking routes", domains: [] },
  // { id: "0163", name: "L0163", description: "Code editors", domains: [] },
  // { id: "0164", name: "L0164", description: "Code generators", domains: [] },
  // Deprecated 2026-08-26 in favour of L0179, which compiles to the same form from a cleaner
  // surface. Still registered, still routable, and still the composition target for L0158/L0176 —
  // deprecation steers new work without stranding the items or the embeddings that exist. The
  // steer lives in the TEXT, since `status` is only a label and filters nothing (see L0158).
  { id: "0166", name: "L0166", description: "Spreadsheets (legacy; prefer L0179)", routingHint: "Deprecated in favor of L0179 — prefer L0179 for all new spreadsheet content; it emits the same compiled form and rejects several mistakes this dialect accepts silently. Interactive spreadsheet authoring with tabular cell data, cell-level formatting, formulas (SUM, AVERAGE, ROUND, IF), parameterized values, and optional assessment validation.", domains: ["assessments", "sheets"], status: "Deprecated" },
  // Deprecated 2026-09-23 in favour of L0183, a rebuild on L0000 with a new surface (typed
  // `node`/`edge` chains, a tray derived from the answer key, scored responses). NOT
  // source-compatible, so L0169 stays registered and keeps serving every item already
  // authored in it; deprecation only stops it being OFFERED (see listLanguages). The steer
  // lives in the TEXT, since `status` is only a label.
  { id: "0169", name: "L0169", description: "Concept webs (legacy; prefer L0183)", routingHint: "Deprecated in favor of L0183 — prefer L0183 for all new concept web content. Interactive concept web diagrams with central anchor, radial connections, custom edges, drag-and-drop concepts and relation labels, and node styling.", keywords: ["concept map", "mind map", "graphic organizer"], domains: ["assessments", "diagrams"], status: "Deprecated" },
  // Deprecated 2026-10-04 in favour of L0185, a rebuild on L0000 (guarded fetching, right-to-left
  // steps, output is the data itself). Stays registered so existing items keep compiling.
  { id: "0170", name: "L0170", description: "Fetch & transform data (legacy; prefer L0185)", routingHint: "Deprecated in favor of L0185 — prefer L0185 for all new data content. The go-to provider for data acquisition and transformation. Fetches JSON/CSV from external/public web URLs (or accepts inline data) and transforms it (dplyr/jq-style): navigate nested data, filter/select/mutate/group/sort/take(top-N)/join/flatten/unique. Authors a standalone transformed dataset; it produces data, it does not render it.", domains: [], status: "Deprecated" },
  { id: "0171", name: "L0171", description: "Venn diagrams", routingHint: "Venn diagrams with named sets, intersections, elements, configurable overlap, and styling.", keywords: ["set diagram", "overlap diagram"], domains: ["diagrams"], status: "Beta", hidden: true },
  // Deprecated 2026-10-07 in favour of L0186, a rebuild on L0000 (typed members and attribute
  // chains, pages, connector checks, and an SVG preview that stands in for the board). NOT
  // source-compatible, so L0172 stays registered for the items already authored in it.
  { id: "0172", name: "L0172", description: "FigJam content (legacy; prefer L0186)", routingHint: "Deprecated in favor of L0186 — prefer L0186 for all new FigJam board content. FigJam board content authoring.", domains: [], status: "Deprecated", hidden: true },
  // Deprecated 2026-09-30 in favour of L0184, a rebuild on L0000 (multiple charts per program,
  // datasets by column name, and seven more plot kinds). NOT source-compatible, so L0173 stays
  // registered and keeps serving every item already authored in it; deprecation only stops it
  // being OFFERED (see listLanguages). The steer lives in the TEXT, since `status` is only a label.
  { id: "0173", name: "L0173", description: "Charts (legacy; prefer L0184)", routingHint: "Deprecated in favor of L0184 — prefer L0184 for all new chart content. Apache ECharts visualizations (bar, line, pie/donut/nightingale rose, scatter). Supports multi-series and dual-axis compositions. Plots the data values given in the request, inline — it does not fetch data, so the values must be supplied with the request.", keywords: ["graph", "plot", "visualization"], domains: [], status: "Deprecated" },
  { id: "0174", name: "L0174", description: "Web forms", routingHint: "Single-page web forms — ordered fields (text, email, number, tel, url, textarea, select, radio, checkbox, date), per-field validation (min/max, length, pattern, required), light/dark theming, and a submit affordance with thank-you/redirect. Submissions deliver to a bound webhook.", domains: [], status: "Beta", hidden: true },
  { id: "0175", name: "L0175", description: "Grade 5 ELA assessments (SBAC Claim 1, Reasoning & Evidence): Target 4 literary texts and Target 11 informational texts", routingHint: "Composes 5th-grade English Language Arts assessment items (Smarter Balanced · Grade 5 · Claim 1 · Reasoning & Evidence) as EBSR, Hot Text, or Short Text. Supports two learning targets, selected by a top-level `target`: Target 4 (c1-t4) over LITERARY passages — character, setting, event, point of view, theme, narrator's feelings, character relationships (RL standards); and Target 11 (c1-t11) over INFORMATIONAL passages — relationships/interactions between ideas, the author's use of information and evidence, point of view, purpose, the author's opinion (RI standards). Authors, inline, candidate inference claims and evidence sources for a single passage (literary or informational).", domains: ["assessments"], status: "Beta" },
  { id: "0176", name: "L0176", description: "Learnosity assessment items — Learnosity-shaped JSON for a Learnosity Item Bank, Items API, or Learnosity-integrated LMS. Use ONLY when the user names Learnosity; not a general quiz language.", routingHint: "Do NOT use for generic quizzes, tests, or practice items that don't name Learnosity. Learnosity assessment items from natural language — MCQ, cloze/fill-in-the-blank, short/long text, choice matrix, ordering, classification, NGN/NCLEX bowtie, token-highlight (hot text), math fill-in, and custom items that embed another Graffiticode dialect (e.g. L0179 spreadsheets) as a `custom` question. Emits valid Learnosity item JSON.", domains: ["learnosity"], gatedBy: ["learnosity"], composesWith: ["0179", "0183"] },
  { id: "0177", name: "L0177", description: "Learnosity Author API integration — recipes for embedding/configuring an item/activity authoring UX. The UX view of a Learnosity Item bank; for programmatic access to the same data, see L0178.", routingHint: "Pick on this axis: L0177 is \"I want a UX of the data\" (a person authoring in a browser); L0178 is \"I want the data\" (a program reading or writing the bank server-to-server). Same Item bank, two views. Developer integration oracle for the Learnosity Author API. The client describes an authoring-experience integration design — embed the item editor (item_edit), item browser (item_list), activity editor (activity_edit), or activity list (activity_list), configured with allowed widget types, editor permissions, item bank, locked mode. L0177 validates the design, flags holes (missing serving domain, author user id, item reference) as steering warnings, and via get_spec returns a host-language-neutral recipe: goal, preconditions, procedure, gotchas, and verification steps. Does NOT author item content (that is L0176, which composes the payload), and does NOT do programmatic item-bank access — extraction, bulk load, or any server-to-server read/write is L0178. Does NOT emit runnable code.", keywords: ["author api", "item bank", "authoring integration"], domains: ["learnosity", "integration"], gatedBy: ["learnosity"], status: "Beta" },
  { id: "0178", name: "L0178", description: "Learnosity Data API cookbook — the DATA plane: recipes for reading and writing a Learnosity Item bank and its assessment results, server-to-server. Use ONLY when the user names Learnosity.", routingHint: "Pick on this axis: L0178 is \"I want the data\" (a program reading or writing server-to-server); a UX over that same data is a different dialect — authoring is L0177, rendered reports are unbuilt. Developer cookbook for the Learnosity Data API, the data plane for the Learnosity dialects. The client describes a data job — which operation, what the request carries, and how far it reads — and L0178 validates it, flags holes as steering warnings, and via get_spec returns a host-language-neutral recipe: goal, preconditions, procedure, a dedicated paging section, gotchas, and verification steps. EARLY: 9 of 57 operations are modelled — reading Items from an Item bank (itembank/items get), WRITING Items to it (itembank/items set), setting and updating Item tags (itembank/items/tags set and update), reading session responses (sessions/responses get), submitting sessions from a template or as failed submissions (sessions set, two operations branched on data_format), polling the async job channel (jobs get), and building an offline package (itembank/offlinepackage get, which is asynchronous). Duplicates, deletes, and the remaining sessions and reports endpoints are NOT built — do not route those here; say no dialect covers them yet. The two session submissions are modelled from documentation only and not yet exercised against a live consumer; everything else is verified. On writes it carries two hazards the reference never states: set REPLACES rather than merging, so anything omitted from the payload is cleared and the response echoes nothing to warn you; and the VERB does not predict which — the same tags endpoint replaces under set and merges under update, documented identically. Its focus is the truncated read: a short result set returns HTTP 200 with a well-formed body, and meta.records counts the page rather than the total, so a paged job must declare whether it reads one page or to exhaustion. There is no universal paging loop — on itembank/* the cursor disappears at exhaustion, while on sessions/* it is always present and an empty page is the end signal, so each family's rule is a bug in the other. Does NOT author item content (that is L0176, which composes the payload this dialect transports — L0176 composes, L0178 moves, L0177 renders). Does NOT cover any UX over the data: the authoring experience is L0177 and a rendered report is an unbuilt dialect, so if the ask is something a person looks at rather than data a program consumes, say no dialect covers it. Naming hazard: the Data API's reports/datasets endpoints are in scope here and are NOT the Reports API. Does NOT call any Learnosity API, and does NOT emit runnable code.", keywords: ["data api", "item bank", "reporting", "analytics"], domains: ["learnosity", "integration"], gatedBy: ["learnosity"], status: "Beta" },
  // L0179 supersedes L0166 (deprecated above): same compiled output, an attribute-list surface
  // instead of chained attributes (docs/language-authoring-style.md), and compile errors where
  // L0166 silently drops a value — misplaced attributes, wrong argument types, a sheet with no
  // cells. Routable since 2026-08-26; L0166 stays registered for the items already authored in it.
  //
  // The one live composition edge in the platform: L0176 embeds a spreadsheet as a `custom`
  // question that loads the language's own scorer.js and question.js, and l0179 serves that
  // asset triple (verified live: it registers
  // `LearnosityAmd.define([],function(){return{Scorer:...}})` exactly as l0166 does).
  //
  // L0176 permitted `["0166", "0179"]` and L0158 the same, so that items already authored
  // against L0166 kept composing. Both were narrowed on 2026-09-09 — L0176 to `["0179"]`,
  // L0158 to atomic — when composition became reactive: the fence now only has to say what
  // a NEW binding may name, because an item that already carries `data use "0166"` is
  // grandfathered from its own source at edit time (extractLangIds in language-router.ts).
  // So the deprecated upstream and the deprecated host both keep working without either
  // being advertised to a generator that would otherwise author fresh content against them.
  //
  // eval 2026-08-25 (l0179/docs/eval-2026-08-25.md, two sweeps of 144 runs): all four variants
  // compile 100% on both, so no MODEL_PRIORITY line — the fast models are within noise of each
  // other. The controlled sweep (L0166's own cases run against L0179, near-identical retrieval)
  // found the style neither helps nor hurts generation rate; what it buys is correctness a
  // compile-rate sweep cannot see.
  { id: "0179", name: "L0179", description: "Spreadsheets", routingHint: "Interactive spreadsheet authoring with tabular cell data, cell-level formatting, formulas (SUM, AVERAGE, ROUND, IF), parameterized values, and optional assessment validation with per-cell points. Supersedes L0166 — prefer this for all new spreadsheet content.", keywords: ["invoice", "budget", "ledger", "gradebook", "timesheet", "expenses", "totals"], domains: ["assessments", "sheets"] },
  // The ungated general assessment language. Until this entry existed the catalog had none:
  // L0176 authors the item types generically but is gatedBy learnosity, and L0175 is
  // Grade-5-ELA-only, so a plain "make me a five-question quiz" had nowhere to route and the
  // routing eval recorded 9 no-calls across 9 runs — correct behaviour against a catalog with
  // no match, not a routing bug. L0180 is the match.
  //
  // Deliberately NOT gatedBy anything: being reachable from a generic quiz request is the
  // whole point, and it is where L0176's `when_to_use` has always been steering generic asks.
  //
  // COVERAGE IS NINE INTERACTIONS, plus a wrapper. Choice — single-select, multi-select and
  // true/false, with per-option points, weighted answers, penalized distractors, exact-set
  // ("all or nothing") scoring, and a rationale per wrong answer. Hottext — clicking a sentence
  // or a word inside the passage itself, including "click any three of these". Text-entry — fill in the
  // blank; each blank recognizes a list of answers, each with its own assess, so a typed
  // mistake can be explained back the way a chosen one is. Inline-choice — the same sentence
  // with a dropdown at each hole instead of a blank, for an answer to be recognized rather than
  // recalled; its options are choice's options, with the same assess. Order — put these in the
  // right sequence, scored all or nothing. Match — each item paired with one of a list of targets,
  // one to one. Classification — the same key where several items share a category, which is the
  // one rule that separates the two. Gap-match — a sentence filled from one bank of tokens
  // shared across its gaps, each spent once, which is what makes it a different question from
  // the dropdown cloze. Extended-text —
  // a written response COLLECTED but never auto-scored: it ships its rubric and comes back
  // pending, for a person to mark. The `item` wrapper adds a reading passage and several parts
  // scored together, so EBSR-style two-part evidence items ARE in scope. Hotspot and sliders are
  // NOT built — hotspot because the language has no media at all, sliders because the same item
  // is already a numeric text-entry. The routingHint says so, because a model that routes one
  // here gets a compile error rather than an approximation.
  { id: "0180", name: "L0180", description: "Quizzes and assessment items", routingHint: "The general-purpose assessment language: use it for a quiz, quizzes, tests, exams, practice questions, comprehension checks and self-checks whenever no particular vendor or platform is named. Authors a single assessment item that renders and scores in a browser with no assessment platform behind it — multiple choice, multi-select (\"select all that apply\") and true/false, with per-option points, weighted answers, partial credit, penalized distractors, shuffled options, and unscored polls. Compiles the presentation and the answer key as separate halves, so a graded delivery can withhold the key and score server-side. Also authors multi-part items over a reading passage — a stimulus with numbered paragraphs and several questions scored together, either summed or conjunctively (every part right or the item earns nothing), which is the EBSR two-part evidence shape. Multi-select can score per-option for partial credit or as an exact set, where every correct option and nothing else earns the point. Also authors hot text, where the candidate clicks inside the passage itself rather than picking from a list — a sentence that supports an inference, any three of several that fit, or a single word in a vocabulary item, with the passage rendered once and its sentences clickable. Also authors written responses: extended-text collects a constructed response and ships the rubric it will be marked against, but nothing scores prose — the result comes back pending for a person to settle, which is what a short-text or explain-your-answer item needs. Also authors fill-in-the-blank: text-entry puts one or more blanks in a sentence, and each blank recognizes a list of answers, every one carrying its own score: alternate spellings, partial credit for a near-miss, a penalty, and a rationale that explains an anticipated wrong answer back to the student once they type it. Capitals are ignored unless asked otherwise, per blank. A blank is worth its best correct answer and the item is the sum of its blanks, so several blanks give partial credit. A blank may also be numeric: the typed answer is compared as a NUMBER, so 0.5, 0.50, .5, 1/2 and 5e-1 all count as the same answer, with an optional tolerance for a rounded or measured one. A blank can also require the FORM the answer is written in — decimal, fraction or scientific notation — for a question that asks the student to express an answer a particular way, and a right value written another way is reported as such rather than simply marked wrong. Also authors dropdown cloze: inline-choice puts a menu at each hole in the sentence rather than a blank, for an answer that should be recognized rather than recalled — each option carries its own score, penalty and rationale exactly as a multiple-choice option does, and a two-hole sentence is worth two points. Also authors sequencing: order asks the candidate to put elements in the right order — the stages of a process, the events of a story, numbers by size — scored all or nothing, so one pair swapped earns zero. Also authors matching: match pairs each item with one of a list of targets, one target to one item, with any target nobody names left as a distractor — scored per pairing, so a four-item match gives partial credit. Also authors classification: the same pairing where several items share a category, which is what tells sorting apart from matching — sort these animals into mammals, reptiles and birds. Also authors word-bank cloze: gap-match fills a sentence's gaps from one bank of tokens shared across all of them, each token spent once, so the last gap is partly answered by elimination — use it when the words come from a shared bank, and inline-choice when each hole has its own menu and an answer may repeat. EARLY: choice, hot text, fill-in-the-blank, dropdown cloze, word-bank cloze, sequencing, matching, classification and written responses ONLY. Hotspot and sliders are not built yet, and neither is symbolic matching — a numeric blank understands whole numbers, decimals, simple fractions and scientific notation, but not expressions like 1/2 + 1/3, units like 5 cm, algebraic equivalence, or whether a fraction is in lowest terms — do not route those here; say no dialect covers them yet rather than substituting a choice item. If the user names Learnosity, that is L0176, not this.", keywords: ["quiz", "test", "exam", "practice questions", "worksheet"], domains: ["assessments"], status: "Beta" },
  // L0181 supersedes L0159's flashcards mode: same study loop (flip, rate, re-run the
  // stack that did not stick), rebuilt on L0000, with next/previous that work and math
  // confined to what the author delimited. L0159 keeps match and memory; its routingHint
  // below no longer claims flashcards, so the two do not compete for the same request.
  { id: "0181", name: "L0181", description: "Flashcard study decks", routingHint: "Flashcard study decks: two-sided cards a learner flips one at a time and rates \"I got this\" or \"I need more practice\", which sorts the deck into stacks so a second pass can be only the cards that did not stick. Route here for \"flashcards\", \"a deck of cards to study\", \"cards with the term on the front and the definition on the back\", vocabulary drills, formula drills and picture identification. A card side may be prose, LaTeX math wrapped in $...$, or an image URL, so it suits language vocabulary, historical dates, algebra identities and flags equally. Flashcards ONLY: matching games and memory (concentration) card games are L0159. It is not a scored assessment — a rating is the learner's own judgement, not a grade; use L0180 for quizzes and answer keys. No spaced repetition scheduling, and the deck is literal in the program rather than fetched from a data source.", keywords: ["study deck", "vocabulary", "revision cards"], domains: ["assessments"], status: "Beta" },

  // L0182 is the first survey language, and it has TWO neighbours it gets confused with.
  //
  // The first is L0180: both present something and collect a response, and the line is that a
  // survey response is never right or wrong. The second is newer and sharper — L0182 is a survey
  // RECORD, not a survey you can send round. There are no screens, no steps and no player: the
  // response is written as code, by a person editing the program or by an agent, and the view
  // only displays it. A request for a fillable form is the most likely mis-route now, and no
  // dialect covers it, so the hint says "not built yet" rather than letting this one absorb it.
  //
  // Both disclaimers are phrased with the keywords the MCP server's limitSentences() greps for
  // (`do NOT`, `does NOT`, `not built yet`, `never`) — a negative clause without one never
  // reaches the server instructions, and L0180 absorbs the request.
  //
  // NO `composesWith` here, deliberately, and it is not an oversight to correct. L0182 reads its
  // own dataset: `ideas fetch "<url>"` is a word in the language, evaluated at compile time. It
  // has no `data use` form and its schema.json forbids the key, so declaring an edge to L0170
  // would make the planner build a pipeline and then fail the head for omitting a binding it
  // cannot author.
  //
  // An earlier version of this comment said the set was "inlined at CODE GENERATION". Nothing in
  // the console does that — composition here is exclusively a live `data use` binding — so the
  // capability moved into the language instead. Do not add a composition edge to make it work.
  //
  // `domains: ["surveys"]` introduces that domain; L0182 is currently its only member.
  { id: "0182", name: "L0182", description: "Surveys — ranked choice and rating scales (Likert, NPS, stars, semantic differentials)", routingHint: "Taking a survey the language server holds and recording one response to it. Route here when someone is answering, filling in, rating or taking a survey, in either of its two styles. Ranked choice: a set of options someone chooses between — which issues matter most, what the team should fix first, which features to build — recorded as the options chosen in priority order plus at most one write-in of their own that was not in the set. Rating: a list of statements or questions each answered on a scale — Likert agreement grids, frequency, importance, satisfaction and likelihood questions, NPS (0–10 likelihood to recommend), star ratings and semantic differentials between two opposite words — with a 'not applicable' or 'prefer not to say' opt-out where the scale offers one and a free-text comment where the survey asks for one. The program names a survey by its id (civic-priorities, team-retro, city-budget, product-features, school, course-feedback, customer-satisfaction, app-usability, workplace-pulse) and the compiler reads what the survey asks from the back end when it compiles. Surveys are NOT authored here: a program does NOT write the options, the items, the scales, the wording or the bounds, so a request to create a new survey from a list of questions is not built yet — say so rather than substituting this one. It does NOT implement a survey-taking flow — there are no screens, steps, navigation or submission, and nothing walks a participant through anything. The response is written as code, by a person editing the program or by an AI agent, and the rendered view only displays the survey with the answer marked on it. Do NOT route a fillable form, a live survey to send round, or anything a respondent is meant to complete in a browser: that is not built yet, in this or any dialect. It does NOT aggregate across respondents — no group ranking, average rating, NPS score, tally or live result — and it never analyses responses: significance testing, clustering and sentiment analysis are out of scope. This is NOT an assessment language and does NOT score anyone: a survey response is never right or wrong, and there is no answer key, no points and no marking. Do NOT route a quiz, test, exam, practice question, comprehension check or any question with a correct answer here — that is L0180, even when it uses a rating scale. Demographics, free-text questionnaires with fixed open questions, contact or sign-up forms and branching questionnaire logic are not built yet, so do not route those here. Ranking or rating anything other than a line of text is not built yet, and nothing here enforces one response per person.", domains: ["surveys"], status: "Beta" },
  // L0183 supersedes L0169 (deprecated above): concept webs rebuilt on L0000. A hub, nodes on a
  // ring, labelled lines; any node or line can be a blank filled from a tray built from the
  // answer key, and a wrong answer in the tray can cost points. Its output is learnosity-cqt's
  // cell-scoring shape and it serves question.js / scorer.js, so L0176 embeds it as
  // `custom [lang "0183" …]` — hence "0183" in L0176's composesWith. Its keywords are
  // L0169's, so "concept map" requests route here.
  { id: "0183", name: "L0183", description: "Concept webs", routingHint: "Concept webs, concept maps and mind maps laid out as a central hub with related ideas on a circle around it and labelled lines between them — as a study diagram, or as an assessment where the learner drags answers from a tray onto blank nodes and blank line labels, scored with partial credit (a decoy in the tray can cost points). Does NOT do flowcharts, timelines, trees or Venn diagrams (Venn is L0171). For a Learnosity item, L0176 embeds an L0183 web.", keywords: ["concept map", "mind map", "graphic organizer"], domains: ["assessments", "diagrams"], status: "Beta" },
  // L0184 charts, successor to L0173 (2026-09-30): built on L0000, one `charts` collection of
  // one or more charts shown as tabs, data inline or in datasets referred to by column name.
  { id: "0184", name: "L0184", description: "Charts", routingHint: "Charts drawn with Apache ECharts: bar (grouped, stacked, horizontal), line (over categories, numbers or dates; smooth, stepped, filled), pie, donut and rose, scatter, histogram (binned from raw values), box plot (quartiles and outliers by category), candlestick, heatmap, funnel, gauge (one to four) and radar charts. Several charts can share one table of data and show as tabs. Plots data given in the request, or data at a public https URL (JSON or CSV), which L0185 fetches and summarizes for it. Reference and trend lines, annotations, network charts (sankey, tree, treemap) and maps are not built yet. Spreadsheets are L0179.", keywords: ["chart", "graph", "plot", "visualization", "histogram", "heatmap", "gauge"], domains: [], status: "Beta",
    // Charts of data at a URL (2026-10-04): a dataset's `rows data use "0185"` binds an L0185
    // program that fetches and shapes the data. L0184's instructions.md teaches when to bind.
    composesWith: ["0185"] },
  // L0185 fetch and shape data, successor to L0170 (2026-10-03): built on L0000, right-to-left
  // steps over a guarded public https GET or inline rows; the output is the transformed data
  // itself. Promoted 2026-10-04 (117-example corpus; holdout eval 100% final compile).
  { id: "0185", name: "L0185", description: "Fetch & shape data", routingHint: "Fetches JSON or CSV from a public https URL (GET only) or takes data written inline, and reshapes it: filter, pick, rename, compute fields, group and summarize, sort, limit, distinct, flatten nested data, join two data sets, format numbers. Its output is the transformed data itself, usually a list of records. Sources that need a login or API key are not built yet. Charts are L0184; spreadsheets are L0179.", keywords: ["data", "fetch", "csv", "json", "transform", "aggregate", "summarize", "api"], domains: [], status: "Beta" },
  // L0186 FigJam boards, successor to L0172 (2026-10-07): built on L0000. Unlike L0172 it is
  // visible: its SVG preview finishes the board in a chat, and `save-to-figjam "<link>"` hands it
  // to the Graffiticode FigJam plugin to draw into a FigJam file.
  { id: "0186", name: "L0186", description: "FigJam boards", routingHint: "FigJam whiteboards: sticky notes, text, shapes with text (flowchart, engineering and decorative shapes), sections, reaction stamps and connectors (labelled, elbowed, straight or curved, dashed, with arrowheads, fanning out to many nodes), on one or more pages, laid out by coordinates. Retros, kanban boards, brainstorms, flowcharts and system diagrams. Previewed as a picture of the board; given a FigJam link, the Graffiticode FigJam plugin draws it into that file. Concept maps that learners complete are L0183; charts are L0184; Figma design files and other whiteboards are not built.", keywords: ["figjam", "whiteboard", "sticky notes", "flowchart", "retro", "kanban", "brainstorm", "diagram"], domains: [], status: "Beta" },
] as Language[])
  // A sponsored language's status is always "Sponsored", whatever its entry says.
  .map(l => l.sponsor ? { ...l, status: "Sponsored" } : l);

export function findLanguageById(id: string): Language | undefined {
  const normalized = id.replace(/^L/i, "").padStart(4, "0");
  return LANGUAGES.find(l => l.id === normalized);
}

export function selectLanguages(domain?: string): Language[] {
  if (!domain) return LANGUAGES;
  const d = domain.toLowerCase();
  return LANGUAGES.filter(lang => lang.domains.includes(d));
}

/**
 * The catalog listing.
 *
 * `enrich` fans out to every candidate language server for scope.json and
 * language-info.json. It is OFF by default, and the default is the whole point:
 * that fan-out is three HTTP fetches per language — ~57 across the catalog —
 * so a listing's latency is the latency of the SLOWEST language server, and a
 * cold one cost 57-75s in production. (These go through fetchText/assetUrlFor,
 * which unlike getLanguageAsset adds no cache-buster, so some are CDN hits; the
 * request count is the problem, not a guaranteed origin round-trip each time.)
 *
 * Three facts make the unenriched default correct rather than merely cheaper:
 *   - The GraphQL `Language` type exposes only id/name/description/routingHint/
 *     domains, so every external caller (the MCP server included) has ALWAYS had
 *     the enriched fields dropped from its response. The work was already invisible.
 *   - The search block below runs AFTER enrichment, so even a one-result search
 *     paid the full fan-out.
 *   - listLanguages reads only `envelope.description` from the doc fetch, while
 *     getLanguageServerDoc also pulls the whole usage-guide.md (3-18KB each) —
 *     fetched and discarded on every listing.
 *
 * Pass `enrich: true` only where the richer scope text actually changes a decision
 * and the latency is affordable: language-router.ts builds the planner prompt from
 * it, on the create path, which already runs 60-110s. Single-language detail does
 * NOT come through here at all — getLanguageInfo() in pages/api/languages.ts does
 * its own fetch for one language, which is where remote docs belong.
 */
export async function listLanguages({ search, domain, enrich = false }: { search?: string; domain?: string; enrich?: boolean }): Promise<Language[]> {
  // `hidden` is applied here rather than in selectLanguages() so the console's own
  // picker keeps showing these while the catalog stops offering them. See the field.
  //
  // Deprecated languages are dropped on the same terms, and for the same reason the
  // `hidden` note gives: this withholds them from DISCOVERY, it does not retire them.
  // Languages are deprecated but never retired, so content already in the wild keeps
  // working — findLanguageById() still answers, `language(id)` still resolves, and an
  // existing L0166 item still renders and still updates. What stops is being OFFERED:
  // a language whose own routingHint says "prefer L0179" has no business appearing as
  // a candidate for a new request, in list_languages or in the planner's catalog
  // (language-router.ts builds that from this same function).
  let results = selectLanguages(domain)
    .filter(lang => !lang.hidden)
    .filter(lang => lang.status !== "Deprecated");

  // Enrich each entry from the lang server in parallel:
  //   - scope.json → summary / inScope / outOfScope (routing-only descriptor)
  //   - language-info.json → longDescription
  // Both fetchers cache with a TTL; repeated calls are in-memory.
  if (enrich) results = await Promise.all(
    results.map(async (lang) => {
      const [scope, doc] = await Promise.all([
        getLanguageScope(lang.id),
        getLanguageServerDoc(lang.id),
      ]);
      const enriched: Language = { ...lang };
      if (scope) {
        enriched.summary = scope.summary;
        enriched.inScope = scope.in_scope;
        enriched.outOfScope = scope.out_of_scope;
      }
      if (doc.envelope?.description) {
        enriched.longDescription = doc.envelope.description;
      }
      return enriched;
    })
  );

  if (search) {
    const searchLower = search.toLowerCase();
    const domainLower = (domain || "").toLowerCase();
    const tokens = searchTokens(search);

    const scored = results
      .filter(lang => {
        // A vendor-gated language answers a search only if the search names its gate
        // (or the caller already scoped to the gate's domain, which is itself the ask).
        // Its item-type text is generic by nature and would otherwise match any
        // un-branded question search. Deliberately still tested against the RAW
        // phrase: naming the vendor anywhere in the query is the gate, and
        // tokenizing must not widen what counts as naming it.
        const gates = lang.gatedBy || [];
        return !(gates.length > 0 &&
          !gates.includes(domainLower) &&
          !gates.some(g => searchLower.includes(g)));
      })
      .map(lang => ({ lang, score: scoreLanguage(lang, tokens) + (namesBrandOf(search, lang) ? BRAND_SCORE : 0) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    // Ranked, and capped. Uncapped OR-matching hands back most of the catalog for
    // a query with one common word, which reads as "everything fits" and invites
    // the nearest-match failure eval-routing.ts exists to catch. A caller that
    // wants the whole catalog omits `search` — which is what agents already do
    // when a search disappoints them.
    results = scored.slice(0, SEARCH_LIMIT).map(({ lang }) => lang);
  }

  return results;
}

/** Outranks any token score: naming a brand says which language, not what kind of thing. */
const BRAND_SCORE = 100;

/** A language's brand terms, gate terms included. */
export function brandTerms(lang: Language): string[] {
  return [...new Set([...(lang.brands || []), ...(lang.gatedBy || [])])];
}

/** Whole-word, case-insensitive, and loose about the gap: "Item Bank", "item-bank", "ItemBank". */
function namesBrandOf(text: string, lang: Language): boolean {
  return brandTerms(lang).some(term => {
    const words = term.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`\\b${words.join("[\\s-]*")}\\b`, "i").test(text);
  });
}

/**
 * Ids of the offerable languages whose brand the text names — the same set listLanguages
 * offers (no internal, hidden or deprecated dialect). Pass the ASK, not pasted source
 * material: a get_spec'd Learnosity item converted to flashcards names Learnosity below the
 * blank line, and that is content, not intent.
 */
export function brandedLanguageIds(text: string): string[] {
  return LANGUAGES
    .filter(l => !l.internal && !l.hidden && l.status !== "Deprecated")
    .filter(l => namesBrandOf(text, l))
    .map(l => l.id);
}

/** Ranked-search result ceiling. See the cap note in listLanguages(). */
const SEARCH_LIMIT = 8;

/**
 * Words that describe nearly every language here, or nothing at all.
 *
 * "interactive" is in this list because it appears in most routing hints — as a
 * query token it selects the catalog rather than narrowing it.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "to", "in", "on", "with", "from", "by", "or",
  "my", "our", "their", "this", "that", "these", "those", "it", "its",
  "make", "create", "build", "generate", "author", "want", "need", "please",
  "interactive", "activity", "activities", "app", "thing", "something", "content",
  // Auxiliaries and bare verbs, which carry no routing signal and DO match: every
  // routingHint that warns "Do NOT route X here" contains the word "do", so
  // `hasWord` scored it. "do my laundry" returned four languages on the strength of
  // that one word — an out-of-catalog request answered as though four things fit.
  "do", "does", "did", "doing", "can", "will", "would", "should", "is", "are", "be",
  "get", "give", "show", "help", "use", "using", "set", "up", "me", "you", "your",
]);

/**
 * Split a query into matchable terms.
 *
 * The old matcher tested the whole phrase as one substring, so any multi-word
 * query — which is what agents overwhelmingly send — matched nothing unless it
 * appeared verbatim. A fit eval over 28 prompts sent 36 distinct searches that
 * returned zero; 17 were multi-word, including "bar chart" against a charts
 * language whose description says "bar". Zero results is the worst possible
 * answer: the agent concludes the capability doesn't exist and stops.
 */
export function searchTokens(search: string): string[] {
  return [
    ...new Set(
      search
        .toLowerCase()
        .split(/[^a-z0-9+]+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

/** Whole-word match, so "form" stops matching inside "transform". */
function hasWord(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Plurals are the same ask: "forms" must reach a language that says "form".
  return new RegExp(`\\b${escaped}(s|es)?\\b`, "i").test(haystack);
}

/**
 * How well a language answers a query: one point per distinct query term it
 * matches, doubled for a term in its name or one-line description, since those
 * are what the language IS rather than what it happens to mention.
 *
 * ANY term scoring is deliberate. Requiring every term would reproduce the
 * failure this replaces — a user's phrasing carries words no catalog entry uses
 * ("students", "shade", "6th grade"), and one unmatched word should not erase a
 * language that answers the rest.
 */
/**
 * The parts of a routing description that say what a language DOES.
 *
 * Routing prose is written to steer, so it names the things a language is NOT for
 * as often as the things it is: "Does NOT author content: assessments, quizzes,
 * spreadsheets, charts, maps, diagrams, boards, flashcards and surveys belong to
 * the dialects that extend it" (L0000), "Do NOT route a quiz, test, exam ... here"
 * (L0182). Scored whole, those sentences make a language match precisely the
 * queries its author wrote them to deflect — L0000 came back FIRST for "flashcards"
 * and L0182 answered "quiz".
 *
 * So a sentence that disclaims is dropped before scoring. Sentence-level rather
 * than clause-level because that is the unit these disclaimers are written in, and
 * a positive sentence that happens to contain "not" only loses its bonus — the
 * language still matches on its name, description and keywords, which carry no
 * negations at all.
 */
export function positiveSentences(text: string): string {
  return text
    // Split on sentence ENDERS only. A colon is not one: "Does NOT author content:
    // assessments, quizzes, ... flashcards and surveys belong to the dialects that
    // extend it" splits there into a negative head and a tail that reads as a
    // positive list, which is how L0000 kept answering "flashcards" after the first
    // version of this filter.
    .split(/(?<=[.;!?])\s+/)
    .filter((sentence) => !/\b(not|never|n't|rather than|instead of)\b/i.test(sentence))
    .join(" ");
}

function scoreLanguage(lang: Language, tokens: string[]): number {
  if (!tokens.length) return 1; // punctuation-only query: don't filter anything out
  const primary = `${lang.name} ${lang.description}`;
  const secondary = [
    // Steering prose, minus the sentences that steer AWAY — see positiveSentences.
    ...[lang.longDescription, lang.routingHint, lang.summary]
      .filter((t): t is string => Boolean(t))
      .map(positiveSentences),
    ...(lang.inScope || []),
    // Keywords are positive by construction: they are what the output is CALLED.
    ...(lang.keywords || []),
  ]
    .filter(Boolean)
    .join(" ");
  let score = 0;
  for (const t of tokens) {
    if (hasWord(primary, t)) score += 2;
    else if (hasWord(secondary, t)) score += 1;
  }
  return score;
}

/**
 * Language ids inside the anonymous free-plan scope, or an empty array when the
 * allowlist is inert (nothing marked) — see `freePlan` on the Language type.
 */
export function freePlanLanguageIds(): string[] {
  return LANGUAGES.filter(l => l.freePlan).map(l => l.id);
}

/**
 * Whether a language may be created on the anonymous free plan.
 *
 * Permissive while the allowlist is empty, so the gate can ship before anyone
 * has decided which languages belong in it. Once ANY language is marked, this
 * becomes a strict allowlist.
 */
export function isLanguageInFreePlanScope(lang: string | undefined | null): boolean {
  const allowed = freePlanLanguageIds();
  if (allowed.length === 0) return true;
  if (!lang) return false;
  // Callers pass either "0166" or "L0166".
  const id = String(lang).replace(/^L/i, "");
  return allowed.includes(id);
}

/**
 * Language ids whose items are currently sponsored — see `sponsor` on the
 * Language type. Empty when no sponsorship is running, which is the default.
 */
export function sponsoredLanguageIds(): string[] {
  return LANGUAGES.filter(l => l.sponsor).map(l => l.id);
}

/**
 * Whether items in this language are sponsored (free to the customer).
 *
 * Note the polarity is the opposite of isLanguageInFreePlanScope: an empty set
 * means nothing is sponsored, never "everything is". A permissive default here
 * would zero out every bill.
 */
export function isLanguageSponsored(lang: string | undefined | null): boolean {
  return languageSponsor(lang) !== null;
}

/**
 * Who is paying for items in this language, or null when nobody is.
 *
 * Customer-facing text, so it is a display name and not an id.
 */
export function languageSponsor(lang: string | undefined | null): string | null {
  if (!lang) return null;
  // Callers pass either "0166" or "L0166".
  const id = String(lang).replace(/^L/i, "");
  return LANGUAGES.find(l => l.id === id)?.sponsor ?? null;
}

/** The account a sponsored language's items are debited from, or null when we absorb them. */
export function languageSponsorUid(lang: string | undefined | null): string | null {
  if (!lang) return null;
  const id = String(lang).replace(/^L/i, "");
  return LANGUAGES.find(l => l.id === id)?.sponsorUid ?? null;
}
