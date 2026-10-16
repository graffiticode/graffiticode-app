---
name: learnosity
description: Learnosity work in Graffiticode, three jobs. (1) AUTHOR ITEM CONTENT — Learnosity assessment items (MCQ, cloze, short text, choice matrix, and other question types) for an Item Bank or Learnosity-integrated LMS. (2) PLAN AN AUTHORING-UX INTEGRATION — embedding and configuring the Learnosity item editor, item browser, or activity editor in your app. (3) PLAN A DATA JOB — server-to-server reads and writes of an Item Bank and its assessment results — items, tags, session responses, offline packages. Jobs 2 and 3 return a host-neutral recipe. PRECONDITION - use ONLY when the user has actually named Learnosity (or a Learnosity Item Bank, Items API, Author API, Data API, or Learnosity-integrated LMS). Learnosity is one vendor's format, not a general quiz format - question type is never the reason to come here. Assessment work that does not name Learnosity goes to the `assessments` skill.
---

# Learnosity

Learnosity work via Graffiticode. This skill is the narrow, Learnosity-focused sibling of `assessments`.

**Check the precondition first.** Learnosity is one vendor. Use this skill only when the user named Learnosity — by name, or via a Learnosity Item Bank, the Items API, the Author API, the Data API, or a Learnosity-integrated LMS. If they described an assessment without naming Learnosity ("a 5-question quiz on the water cycle"), you are in the wrong skill: go to `assessments`. Never infer Learnosity from the question type.

You don't need to know Learnosity's internal taxonomy (question types, scoring models, item references, activity wiring, API signing). The Graffiticode backend encodes all of that — your job is to pass a clear natural-language description and let the backend produce the output.

## Three jobs live in this domain — decide which one you're in first

The domain serves three different jobs with three different deliverables. Picking the wrong one wastes the turn, because each backend explicitly refuses the others' work.

| The user wants… | The job | What comes back |
|---|---|---|
| A question, item, passage, or activity **authored** — stems, options, answer keys, scoring | **Item content** | Learnosity item JSON, rendered as a widget, saveable to their Item Bank |
| To know **how to embed or configure the Learnosity authoring experience** in their own app — the item editor, item browser, activity editor, activity list; signing, permissions, allowed widget types, locked mode | **Authoring-UX integration** | A host-language-neutral **recipe**: goal, preconditions, procedure, gotchas, verification steps |
| To **read or write an Item Bank and its assessment results from their own server** — pulling items, writing items, setting or updating tags, reading session responses, submitting sessions, polling the async job channel, building an offline package | **Data job** | The same host-language-neutral **recipe**, plus a dedicated **paging** section |

The tell is the verb, and then the audience. *"Write me a Learnosity cloze item on photosynthesis"* is content — someone is authoring a question. Once the verb is *embed*, *configure*, *extract*, *sync*, *bulk-load*, or *submit*, the user is a developer building a system, and a second tell separates the two integration jobs: **is the deliverable something a person looks at and works in, or data a program consumes?** *"How do I embed the Learnosity item editor in my LMS for author u123, restricted to MCQ and cloze?"* wants a UX of the data — authoring-UX integration. *"How does our nightly job pull every item in the bank and push updated tags back?"* wants the data itself, server-to-server — a data job. Same Item Bank, two views.

They compose but they run separately. Someone building an authoring experience usually wants seed items in it; someone bulk-loading a bank needs the item JSON composed before anything can move it. Content composes the payload, the data job moves it, the authoring integration renders it — three jobs, three languages, one at a time. Never ask either integration backend to write item content, the content backend to explain an API, or the authoring-UX backend to plan a server-to-server read.

## Prerequisite

The Graffiticode MCP connector must be installed and connected. If `list_languages` is unavailable, tell the user to connect it before proceeding.

## Discovery: match the job to a language by what the language says about itself

**1. List the domain.**

Call `list_languages(domain: "learnosity")`. Read each language's `description` and `when_to_use` and pick by **job**, not by position in the list or by a remembered ID:

- **Item content** → the language that authors assessment items. If two author item content and one is marked **Deprecated**, choose the other — the deprecated one is retained only for existing items.
- **Authoring-UX integration** → the language whose `when_to_use` frames itself as *a UX of the data* — a person authoring in a browser — and describes embedding an item editor, item browser, activity editor, or activity list.
- **Data job** → the language whose `when_to_use` frames itself as *the data itself* — a program reading or writing the bank server-to-server — and describes operations, request payloads, and paging.

**Both integration languages say they do not author item content, so that clause no longer separates them.** It still earns its keep in one direction — it tells you reliably that you have left the content job — but on its own it now matches two languages, and picking the first match is a coin flip. The axis that does separate them is the one the languages state about themselves: **a UX of the data versus the data.** Ask what the deliverable is for. A person clicking through an editor is the UX view. A nightly sync, an extraction, a bulk load, a submission — anything the caller's own code fetches or sends — is the data view. Question types and item types discriminate nothing here.

**A rendered report for a human is neither, and no language covers it.** It is a UX, but not the authoring UX; it is built from the data, but it is not data a program consumes. Say plainly that no dialect covers it rather than stretching the data-job recipe (which returns records, not a report) or the authoring recipe over it. The vendor's Data API does have reports and datasets endpoints that belong to the data job — those are server-to-server reads and are not the Reports API, whatever the shared word suggests.

**Honor the negative clauses.** Each language states what it is *not* for. A language that says it does not author content will not author content, however well the request seems to fit otherwise — and vice versa. If the returned set contains nothing for the user's job, say so and ask; do not force the nearest match.

The domain grows — item-bank sync arrived as the third job, and activity assemblers, delivery and rendered reporting surfaces are all plausible next members. Because you match on self-description rather than ID, a new member routes correctly with no change to this skill.

**2. Read the language info.**

Call `get_language_info(language)`. Its `authoring_guide`, `supported_item_types`, `example_prompts`, and `not_for` are the authoritative, current statement of what that language can do — more current than this skill. When a capability boundary matters ("can it also do item-bank CRUD? delivery? reports?"), read it there rather than trusting a paragraph written earlier. For deeper reference, read the `user_guide_resource` URI via `ReadResource`.

## Authoring item content

**Create the item.**

Call `create_item(language, description)` with a natural-language description. Write it the way you'd brief a content author — no Learnosity JSON, no Graffiticode DSL, no widget-type slugs. A good description is specific about:

- **Subject and scope** — topic, grade band, cognitive level (DOK, Bloom), difficulty
- **Quantity and structure** — how many items, how they're grouped, any activity structure
- **Question shape** — "a multiple-choice item with four options and one correct answer," "a short-text item with two acceptable answers," "a cloze item with three blanks"
- **Scoring intent** — exact match vs partial credit, per-blank scoring, rubric expectations
- **Metadata / taxonomy** — standards alignment, tags, difficulty labels if the user mentions them
- **Theme / accessibility** — any specific visual or a11y requirements

Bad: "Make a Learnosity MCQ about fractions."
Good: "Author a Learnosity multiple-choice item on adding fractions with unlike denominators for Grade 5. Four options, one correct answer, three distractors that reflect common errors (not finding a common denominator, adding numerators and denominators separately, forgetting to simplify). Exact-match scoring, one point. Tag the item with standard CCSS.MATH.CONTENT.5.NF.A.1."

**Iterate with `update_item`.**

`update_item(item_id, modification)` preserves conversation history. Incremental Learnosity-specific edits compose naturally: "add a second distractor matching the common error of …," "switch to partial-match scoring," "change the stimulus image," "add a hint," "tag with an additional standard."

**Do not call `get_item` before `update_item` for edits or saves.** `update_item` already reads the current state internally; an explicit `get_item` first is redundant and slower. Only call `get_item` when the user explicitly asks to inspect the item's current content or when you need to cite the item ID back to them.

## Planning an authoring-UX integration

Here the backend is an **oracle, not a renderer**. You describe an integration *design*; it validates the design, tells you what's missing, and — once the design is complete — hands back a recipe a developer implements in their own stack. There is no meaningful widget, and the recipe, not the item, is the deliverable.

**Describe the design, not the code.**

`create_item(language, description)` where the description states which authoring experience to embed (item editor, item browser, activity editor, activity list) and how it is configured: the serving domain, the author/user identity, the item or activity reference, which question/widget types authors may use, editor permissions (e.g. authors may not delete widgets), which item bank, locked or read-only mode.

Good: *"How do I embed the Learnosity item editor in our LMS at lms.acme.edu for author u123, restricted to MCQ and cloze questions, with widget deletion disabled?"*

**Expect holes, not failure.**

The backend flags missing required properties — no serving domain, no author user id, no item reference — as **steering warnings** rather than guessing at them. That is the design working, not an error. Read the warnings, ask the user for the missing values, and `update_item` to fill them in over a turn or two.

**Never fill a hole with a plausible guess.** A serving domain, author id, or item reference is a fact about the user's deployment; invent one and you produce a recipe that looks right and silently doesn't work. Ask.

**`get_spec(item_id)` is the payoff.**

Once the design is complete, `get_spec` returns the recipe — goal, preconditions, procedure, gotchas, and verification steps — deliberately neutral about host language so it can be implemented in Node, PHP, Ruby, or .NET. **Relay it to the user.** This is the one job in this skill where reproducing the content in chat is correct: the recipe *is* the answer, not a preview of a widget.

**The recipe is not runnable code, on purpose.** The backend will not emit an implementation. If the user wants one, *you* write it, in their stack, working from the recipe — don't ask the backend for code, and don't skip the recipe to improvise an integration from memory of Learnosity's docs. The recipe's verification steps are the check that what you built actually works.

### Implementing the recipe: it states its own confidence, and you must not upgrade it

Some of what the recipe describes is verified against the live Learnosity API; some is documented-but-unconfirmed, and the recipe says which. That distinction is the most valuable thing in it and the easiest thing to lose when you summarize.

**A vendor API can fail open, so a clean render proves nothing.** The Author API silently ignores `config` keys it does not recognize: the editor still initializes, the ready callback still fires, and the page looks exactly as intended — while enforcing nothing. "It rendered and there were no errors" is evidence the page loaded, not evidence your configuration took effect. Never infer success from the absence of failure.

**There are two kinds of hole, and they have opposite remedies.** A *design hole* is a missing fact about the user's deployment — serving domain, author id, item reference. Ask them; never guess. A *knowledge hole* is a gap in what is known about the vendor's API itself — for example, which `config` key actually restricts the question types an author may add. You cannot ask the user that, and you must not answer it from recalled Learnosity documentation. Because the API fails open, a plausible-but-wrong config path is *worse* than an acknowledged unknown: it silently does nothing and looks like it worked. Relay the unknown exactly as the recipe states it.

**Confirm config-driven behavior differentially, or not at all.** To show a `config` key did something, run the integration twice — once with the key, once with it omitted — and compare. If the behavior is identical both ways, the key changed nothing, whatever the editor looks like. A single observation of the behavior you wanted is not a confirmation; under fail-open semantics it is equally consistent with the key being ignored. The recipe's verification steps will tell you which checks need a control run.

**Report the uncertainty you were given.** If the recipe says a restriction is *intended* but its binding is unconfirmed, say so to the user. Telling them "the editor is restricted to multiple choice and cloze" because the page rendered cleanly is exactly how a silent non-restriction reaches production.

**Check the scope before promising.** This surface covers the authoring experience; other Learnosity surfaces (learner delivery via the Items API, the Reports API) may or may not be covered as the language grows. `get_language_info`'s `supported_item_types` and `not_for` are the current truth — read them rather than trusting this sentence, and if the user's surface isn't covered, say so plainly instead of stretching the nearest recipe over it.

## Planning a data job — reading and writing the bank from your own server

Same posture as the authoring-UX job: the backend is an **oracle, not a renderer**, the recipe is the deliverable, and holes come back as steering warnings you fill by asking the user, never by guessing. What differs is what makes a design *complete*, and what goes wrong when it isn't.

**Describe the job, not the request.** `create_item(language, description)` where the description states **which operation** — reading items out of a bank, writing items into it, setting or updating tags, reading session responses, submitting sessions, polling the async job channel, building an offline package — **what the request carries** (which bank, which references, which filters, which fields, what payload), and **how far it reads**.

**A data-job design is not complete until it declares its paging policy: one page, or to exhaustion.** That is a required part of the design, not a refinement of it, and it is the hole you must never leave to the backend's judgement. State it in the description.

Good: *"From our nightly sync, read every item in the bank tagged Grade 5 — all pages, to exhaustion — then update the difficulty tag on each, merging with the tags already there rather than replacing them."*

**The failure this job exists to prevent is the truncated read.** A short result set comes back HTTP 200, with a well-formed body, and a records count that counts *the page*, not the total. Nothing about it looks wrong. A job that never declared its paging policy quietly processes the first page of the bank forever, and the user finds out months later from missing data rather than from an error. Every other hazard here announces itself; this one doesn't. That is why the declaration is mandatory.

**There is no universal paging loop, and one family's rule is a bug in the other.** The item-bank family and the sessions family terminate on opposite signals. The recipe states which rule applies to the operation you asked for — implement that one, as written, for that operation. Do not carry it across to the other family, and do not fold both into a "generic" pager; a loop that waits for the wrong end signal either stops early or never stops.

**Writes replace by default, and the verb does not predict it.** The same endpoint can replace under one verb and merge under another, documented identically — so the name of the call tells you nothing about which you are getting. Under replace semantics, anything omitted from the payload is cleared, and the response echoes nothing back to warn you: a partial payload returns a clean success and is a silent deletion. A write job must **say which semantics it intends**, and you take the answer from the recipe, never from the verb.

**It is documentation-only. It never calls Learnosity and holds no credentials.** The caller's own code signs and sends every request with the caller's own consumer key. Don't ask this backend to run the job, fetch a real record, or confirm what the live bank returned — it cannot, and a reply that reads as though it did is a recipe you have misread.

**An operation the language doesn't model is unbuilt, not unsupported — and must not be guessed at.** Coverage of the vendor's data surface is early and partial on purpose. If the user's operation isn't among the ones the language says it models, the answer is "no dialect covers that yet," not the nearest modelled operation bent to fit. Read `get_language_info`'s `supported_item_types` and `not_for` for the current list rather than trusting any enumeration written here, and never extrapolate from a covered operation to its obvious-looking sibling — that a read is modelled says nothing about whether the matching delete is.

**The confidence rule above applies here unchanged.** Some operations are modelled from the vendor's documentation only and have never been exercised against a live consumer, and the recipe says which. Relay that exactly as given; do not upgrade it because the call looks routine. A documented-but-unexercised **write** is the sharpest form of this — under replace semantics the destructive version of the call returns the same clean success as the safe one, so there is no observation you can make afterwards that distinguishes them.

## Side-effectful operations (saving item content to the item bank)

Saving to the Learnosity item bank is done via `update_item` with a natural-language instruction — no dedicated save tool exists and none is needed:

```
update_item(item_id, "save this item to the Learnosity item bank")
```

The language backend interprets the save intent and writes to Learnosity's Item Bank. Confirm the save by inspecting the `data.itemBank` field in the `update_item` response:

- **Success:** `data.itemBank = { saved: true, references: ["graffiticode-…"] | ["artcompiler-…"], savedAt: "2026-…" }`. Echo the reference(s) back to the user so they can locate the item in Learnosity's Author Site (e.g., "Saved to the Learnosity item bank with reference `graffiticode-abc123`.").
- **Failure:** the `update_item` call returns `errors` (the language backend's `dataApi` throws on non-2xx from Learnosity, which surfaces as a generation error). Relay the error message; do not assume the save succeeded.
- **No `itemBank` field present:** the user's instruction was interpreted as a content edit rather than a save. If they clearly asked to save, re-issue with a more explicit instruction ("save this item to the Learnosity item bank as a draft") and check `data.itemBank` again.

**Do not invent out-of-system save paths.** If the save feedback is ambiguous, ask the user to verify in the Learnosity Author Site rather than suggesting alternatives like "post directly to the Learnosity Items API with consumer key/secret," "use computer use to navigate the Author UI," or "import JSON manually." Those are outside this skill's scope and usually wrong — the save has almost certainly happened if `update_item` returned without errors.

## Output

**These rules govern item content. They are inverted for integration planning** — there the recipe from `get_spec` is the deliverable and you reproduce it in full; there is no widget standing in for it.

Items render as interactive widgets inline in claude.ai. **The widget is the rendering. Your reply is a one-line summary, nothing more.**

Prefer the response's own summary fields for that one-sentence confirmation:

- **On first creation** (`create_item`): echo `description`.
- **On edits** (`update_item`): echo `change_summary` — e.g., *"Added a second distractor on Q2 and switched to partial-match scoring."*
- **On saves to the item bank**: combine `change_summary` (often *"Saved; no content changes"*) with the reference from `data.itemBank.references` — e.g., *"Saved to the Learnosity item bank with reference `graffiticode-abc123`."*

Don't re-parse `data.questions` to describe what changed; the backend wrote the summary for you.

**Do not preview or simulate the item in chat.** No mock MCQ / cloze / shortText layouts, no option lists, no printed answer keys, no Learnosity JSON dumps, no "here's what the item looks like" sections in prose or Markdown. The widget renders the item — your one-liner accompanies the widget, it does not substitute for it. If the user asks "what does it look like?" or "show me the questions," point them to the rendered widget; don't reproduce the content as text.

## Saving the Graffiticode item itself (free plan)

Distinct from saving to the **Learnosity** item bank (above): the Graffiticode item also has a **`view_url`** in every response — surface it so the user can open the rendered item. If the call was made **without Graffiticode credentials (free plan)**, the response also includes a **`claim_url`** / **`claim_message`**, and the `view_url` carries the claim token so its footer offers a one-click **"Claim it in Graffiticode →"** link; free-plan Graffiticode items expire after 48 hours unless claimed. (Saving to the Learnosity item bank is a separate, account-backed operation — see above.) Only surface the URLs the server returned.

## Guardrails

- **Pick the job before the language.** Authoring item content, planning an authoring-UX integration, and planning a data job are three jobs with three deliverables, and each backend refuses the others' work. Decide which one the user is in — content, a UX of the data, or the data itself — then match a language to it by `description`/`when_to_use`.
- **Never hand-write Learnosity JSON or Graffiticode DSL.** The backend produces both from your natural-language description.
- **Never hardcode a language ID in your reasoning.** Always call `list_languages(domain: "learnosity")` at session start — the domain may add members over time.
- **Never invent an integration fact.** A serving domain, author user id, or item reference is the user's deployment detail. When the backend flags it as a hole, ask — a guessed value yields a recipe that fails silently.
- **Don't write the integration from memory.** When an integration recipe is available, it is the source of truth; recalled Learnosity API knowledge is not. Get the recipe, then implement from it.
- **Never close a knowledge hole from memory.** When the recipe marks a vendor config binding *unconfirmed*, relay it as unconfirmed. Filling that gap with a remembered Learnosity config path yields an integration that fails open — it looks configured and enforces nothing, and the user ships it believing otherwise.
- **Never report a config-driven restriction as working on the strength of a clean render.** A fired ready callback means the page loaded, not that your config took effect. Confirm it differentially — run with the key and without it, and compare — or tell the user it is unverified.
- **Stay in the Learnosity lane.** If the user asks for something outside Learnosity (flashcards, spreadsheets, concept webs), suggest the broader `assessments` skill rather than forcing a Learnosity fit.
- **Iterate, don't recreate.** On follow-up edits, call `update_item` on the existing `item_id`; fresh creates lose conversation history.
- **Don't improvise out-of-band save paths.** Saves go through `update_item`; ambiguous results get verified by the user in the Learnosity UI, not by inventing API-direct or computer-use workarounds.
- **Never plan a paged read without declaring how far it goes.** One page or to exhaustion is part of the design, not a detail. A read that stops early returns HTTP 200 with a well-formed body and a count of the page, so nothing downstream will ever tell the user data is missing.
- **Never reuse a paging loop across endpoint families.** The item-bank and sessions families end on opposite signals. Implement the rule the recipe gives for the operation you asked about, and write a separate loop for a different family rather than generalizing.
- **Never send a partial write payload without confirming the semantics.** Replace is the default and the verb does not predict it. Under replace, every field you omit is cleared and the response says nothing — get the semantics from the recipe and state them to the user before they run it against a real bank.
- **Never ask a documentation-only backend to touch the vendor.** It does not call Learnosity and holds no credentials; the user's own code signs and sends. Don't ask it to execute, verify live, or hand over keys, and don't present its recipe as something already run.
- **An unmodelled operation is unbuilt, not unsupported.** If the data-job vocabulary doesn't cover the operation, say no dialect covers it yet. Routing it to the nearest modelled operation produces a confident recipe for the wrong call.
- **A rendered report for a human is not a data job.** Same Item Bank, but the data plane returns records, not a report. Say no dialect covers it rather than dressing up a paged read as reporting.
