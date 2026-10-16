---
name: assessments
description: Author interactive assessment items in Graffiticode — scored quizzes and test questions (multiple choice, fill-in-the-blank, cloze, hot text, matching, sequencing, classification, written responses), items built to a named subject/grade/standard, flashcard study decks, spreadsheet problems, and concept webs. Use whenever the user wants to build a quiz, test, exam, homework problem, study deck, or practice item. For requests that specifically target Learnosity (by name, or by referring to Learnosity's Item Bank, Items API, Author API, Data API, or LMS integration), prefer the `learnosity` skill instead — it is the narrower, Learnosity-focused sibling.
---

# Assessments

The `assessments` skill is the assessment authoring surface of Graffiticode — everything a learner is asked to *do* and, usually, be scored on. Several languages serve this domain, and the full set is discovered at runtime; the catalog is dynamic and this skill deliberately does not enumerate it. What stays stable is the set of **jobs** the domain contains, how to tell which one you are in, and the contract for driving each. Your job is to identify the job, let discovery name the language, and produce a rendered item — never to write code yourself.

## Prerequisite

The Graffiticode MCP connector must be installed and connected. If `list_languages` is unavailable, tell the user to connect it before proceeding.

## The jobs in this domain — decide which one you're in first

The domain serves several jobs with different deliverables, and a backend asked for another job's work will either refuse it or do it badly. Decide the job first; discovery then names the language.

| The user wants… | The job | What comes back |
|---|---|---|
| A question that is **answered and scored** — options, blanks, a passage to click in, things to order, match or sort, a written response against a rubric | **A scored item** | An item that renders and scores in the browser, with the presentation and the answer key compiled as separate halves so a graded delivery can withhold the key |
| An item built **to a named subject, grade, or standard** — a grade-level ELA reading/evidence item, a state or consortium standard | **A standards-specific item** | An item shaped to that standard's conventions, authored by the specialist for it |
| Something to **study from**, not be graded on — two-sided cards flipped one at a time and self-rated | **A study aid** | A deck the learner works through and sorts by what did not stick — no score, no answer key |
| A **computational or tabular** interaction — cells, formulas, values the learner fills in, optionally worth points per cell | **A spreadsheet problem** | An interactive sheet, optionally validated with per-cell scoring |
| To show **how ideas relate** — a central anchor with radial connections, labelled relations, concepts dragged into place | **A structural item** | An interactive concept web |

## Fast-path patterns

**The more specific the user's request, the faster you can hand it off.** Two patterns minimize your thinking time:

### Pass-through: user provides content

When the user supplies questions, answers, or study material, pass it directly:

- "Make flashcards: 犬=dog, 猫=cat, 鳥=bird" → `create_item` immediately
- "Quiz: Q1 Capital of France? A) London B) Paris C) Berlin, correct B" → `create_item` immediately
- "Matching: pair these terms with definitions: [list]" → `create_item` immediately

Your job is routing, not content generation.

### Clarify: user is vague

When the user names a topic but not the content, **ask rather than invent**:

- "Make a quiz on the water cycle" → Ask: "How many questions? What aspects — evaporation, condensation, precipitation?"
- "Create flashcards for Spanish vocab" → Ask: "Which words or phrases?"
- "Build a 5-question test" → Ask: "On what topic? What question types?"

Inventing quiz questions takes time and may miss what the user actually needs to assess.

### When to invent

Invent only when explicitly delegated:

- "Surprise me with a quiz on mitosis"
- "Generate 10 practice problems on fractions"
- "Create sample flashcards for a demo"

## How to tell which job you're in

Ask these in order. They discriminate reliably even as the catalog changes underneath them.

**Is it scored, and who judges?** A system checking against an answer key is a scored item. A rubric a *person* settles afterwards is still a scored item — the written-response shape ships the rubric and returns a result pending human marking. But if the only judge is **the learner themselves**, rating their own recall, that is a study aid and not an assessment at all.

**Did the user name a subject, grade, or standard?** Then **specificity wins**: route to the specialist whose `description` names that subject and grade, *even though its items use ordinary multiple-choice / short-text / cloze question types*. The question type is not the discriminator; the named standard is. Because you match on description, a subject specialist added later wins here automatically with no edit to this skill.

**What does the learner manipulate?** Options in a list, or a blank or a menu inside a sentence → a scored item. The passage itself, clicked in place → a scored item. Cells and formulas → a spreadsheet problem. Nodes and labelled edges → a structural item. Cards they flip → a study aid.

**Did the user name a vendor or platform?** Then you are in the wrong skill — go to `learnosity` if they named Learnosity. If they named a platform nothing here targets, say so; do not substitute.

**Is there a right answer at all?** If nobody is being scored and no answer is correct — an opinion, a preference, a ranking of ideas, a poll of what matters most — it is not an assessment. It belongs to a different domain entirely. Say so and route out rather than dressing it up as an unscored quiz item.

## Discovery: match the job to a language by what it says about itself

**1. List the domain.** Call `list_languages(domain: "assessments")`. Read each language's `description` and `when_to_use` and pick by **job**, not by position in the list or by a remembered ID. The returned set is the source of truth — if a capability is not in it, it is not available, whatever you remember.

**2. Read the language info.** Call `get_language_info(language)` on the top candidate. Its `authoring_guide`, `supported_item_types`, `example_prompts`, and `not_for` are the authoritative, current statement of what that language can do — more current than this skill. For deeper reference, read the `user_guide_resource` URI via `ReadResource`.

**Route on what a language says it is NOT for.** Every language states its own negative clauses, and they are the most reliable discriminator you have: they survive renumbering, deprecation and new domain members in a way positive matching does not. A language that says it is not a scored assessment will not score anyone, however well the request otherwise fits. If two languages serve the same job and one says it **supersedes** the other, take the successor.

**A shape a language says it has not built yet is unbuilt, not unsupported.** The general assessment language names its own gaps explicitly — the interaction types it does not yet do, and the kinds of answer it cannot judge. When the user's request lands in one of those gaps, the correct answer is *"no dialect covers that yet"*. Never substitute the nearest shape that does exist; an item that asks the wrong question is worse than no item, because it looks finished.

**No nearest-match substitution, and no vendor by inference.** A generic quiz, test or exam — with no vendor named — has a home here: the general-purpose assessment language is exactly that, and you should use it rather than stopping to ask. But when nothing fits, do **not** quietly pick the closest thing. In particular, a vendor-specific language (e.g. a Learnosity language, which emits Learnosity-shaped JSON for a Learnosity Item Bank / Items API / LMS) is **never** the answer to a generic request, however well its question types match. Instead:

1. Tell the user plainly what Graffiticode *does* have for their request — name the closest specialists and what each produces.
2. Ask how they want to proceed — e.g. fit the request to a specialist, or, **if and only if they actually use Learnosity**, author it as a Learnosity item.

Never infer Learnosity (or any vendor) from the question type alone. "Multiple-choice," "cloze," and "short text" are shapes every assessment platform has; they say nothing about the target platform. Only the user naming the platform does.

## Authoring the item

**1. Create the item.**

Call `create_item(language, description)` with a natural-language description. The `description` is a prompt to a language-specific AI, not Graffiticode source — write it as you would explain the item to a colleague.

A good description is specific about:
- **Subject and scope** — topic, grade band, difficulty
- **Quantity and structure** — number of items, layout, sections
- **Assessment rules** — scoring, rubric, answer key expectations, hints
- **Theme / styling** — color, tone, any accessibility needs

Bad: "Make a quiz about fractions."
Good: "Create a 5-item multiple-choice quiz on adding fractions with unlike denominators. Grade 5 level. Each item has four choices with one correct answer and three plausible distractors that reflect common computational errors. Include an answer key and a one-sentence explanation per item."

**2. Iterate with `update_item`.**

`update_item(item_id, modification)` preserves conversation history, so incremental edits compose naturally: "make the distractors harder," "add a hint on question 3," "switch to a dark theme," "change the topic from fractions to decimals." Prefer iteration over recreation — history is lost on a fresh create.

## Composite requests (content + a host/format)

Some requests are really **two parts of one whole**: a piece of *content* plus a *host or output
format* it should live in — e.g. "an ELA Grade 5 item **for Learnosity**", "a spreadsheet
question **in a Learnosity item**", "turn this passage into a Learnosity EBSR". Do **not** try to
one-shot these with a single `create_item` in the host language — the host will then author the
inner content itself, generically, instead of the right specialist authoring it.

Treat every such request uniformly as a **round-trip**: author the inner part, carry it across
with `get_spec`, then create the host item from that spec.

1. **Author the inner content in its own specialist.** Describe just the content (e.g. "a Grade 5
   ELA, Claim 1 Target 11 reasoning-and-evidence item about <topic>") and `create_item` it — the
   server routes it to the right specialist dialect. `get_item` to confirm it's ready.
2. **`get_spec(inner_item_id)`** — returns a complete, platform-neutral English description of the
   authored content (passage, stems, options, answer keys, rationales — everything).
3. **Create the host item from the spec.** `create_item(host_language, <that spec> + your intent
   framing)` — e.g. "Create a Learnosity EBSR from the following content: <spec>".

You never decide *how* the two parts combine — whether the host **embeds** the inner item as a
live widget or **re-authors** it natively is the generator's call. Your job is only to ask for the
two parts of the whole. Never paste an item's `src`/`data` or its id across languages — `get_spec`
is the only correct bridge.

## Output

Items render as interactive widgets inline in claude.ai. The tool response carries the widget metadata automatically. **The widget is the rendering. Your reply is a one-line summary, nothing more.**

Prefer the response's own summary fields for that one-sentence confirmation:

- **On first creation** (`create_item`): echo `description` ("what the code does") — e.g., *"Made a 5-item MCQ on photosynthesis with four distractors each."*
- **On edits** (`update_item`): echo `change_summary` ("what changed this turn") — e.g., *"Switched to dark theme and hardened the distractors on Q3."*

Don't re-parse `data` to describe what changed; the backend already wrote the summary for you. If a field is `null` (rare — typically only when the code generator failed), fall back to a brief summary drawn from the user's own request.

**Do not preview or simulate the item in chat.** No sample layouts, no mock multiple-choice blocks, no ASCII/Markdown renderings of the stem and options, no printed answer keys, no "here's what it looks like" sections. The widget renders the item — your one-liner is in addition to, not a substitute for, the widget. If the user asks "what does it look like?" or "show me the questions," point them at the widget; do not reproduce the content in prose or formatted text.

## Saving the item (free plan)

Each `create_item` / `update_item` response carries a **`view_url`** (the item's page on `app.graffiticode.org`); surface it so the user can open or share the rendered item. When the call was made **without credentials (free plan)**, the response also includes a **`claim_url`** and a **`claim_message`**, and the `view_url` carries the claim token — so when the user opens it, the render-host footer offers a one-click **"Claim it in Graffiticode →"** link for that item (the primary way to save it). Surface the `view_url` and, in chat, the `claim_message` (the same `/claim` destination by a manual route). Free-plan items are session-scoped and expire after 48 hours unless claimed. Only surface the URLs the server returned; if `claim_url` is absent the call was authenticated and the item already persists.

## Guardrails

- **Never write Graffiticode DSL directly.** The backend generates code from natural-language descriptions. If you catch yourself composing Graffiticode source, stop and use `create_item`/`update_item` instead.
- **Never hardcode language IDs in your reasoning.** Call `list_languages(domain: "assessments")` every session; memorized IDs go stale, and a capability you remember may no longer be served.
- **Do not invent languages.** If no returned language matches, say so — don't guess an ID.
- **Prefer domain-scoped discovery.** When the user is clearly in an assessment context, scope `list_languages` by `domain: "assessments"` rather than searching the whole catalog — it's faster and reduces wrong-language picks.
- **Never pick a Learnosity language unless the user named Learnosity.** A `learnosity`-domain language is off the table unless the user named Learnosity, an Item Bank, the Items API, or a Learnosity-integrated LMS. Question type (MCQ, cloze, short-text, ordering, choice-matrix) is **never** the discriminator — every platform has those. When the user *has* named Learnosity, the `learnosity` skill (if installed) is the better fit; it is tighter and scoped to that domain.
- **No silent fallback.** A generic quiz has a home — the general-purpose assessment language. But if nothing in the `assessments` set matches the request, say so and ask (see the routing section); never settle for the nearest-looking language, and never substitute a shape the language says it has not built.
- **An opinion is not an assessment.** A survey, poll, or idea-ranking request has no answer key and scores nobody — a response there is never right or wrong. That is a different domain. Route out and say so, rather than authoring it as an unscored quiz item.
- **Respect the conversation.** On follow-up edits, call `update_item` on the existing `item_id`; don't start over unless the user explicitly asks for a new item.
