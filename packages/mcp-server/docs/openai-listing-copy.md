# OpenAI / ChatGPT listing copy — canonical source

The publisher portal is **not** the source of truth. Every public field of the ChatGPT
directory listing is recorded here, per version, so the live listing can be reproduced,
diffed, and reviewed without logging in.

Companion to `openai-submission.md` (the operational runbook). Required by Phase 2 of
`artcompiler/marketing/graffiticode-agent-capability-messaging-action-plan.md`.

**Rule:** change the portal and this file in the same sitting. A field that exists only in
the portal is a field nobody can review.

**Machine copy:** `graffiticode-skills/plugin.meta.json` is what `npm run package` generates
`plugin.json` from — the same fields, minus the rationale. It and this file are a matched
pair: **change both in the same sitting**, the same discipline the rule above imposes on the
portal. The build prints that file's SHA-256 on every run, so drift is provable rather than
argued.

---

## v2 draft as it stands in the portal — read back 2026-09-16

The v2 submission was rejected and **its draft is still editable**, so this is what will be
resubmitted unless it is changed. Read back from the portal by Jeff; corrections to the record
below are from that reading, not from our proposals.

**What matches the record:** the description, verbatim, both paragraphs. Category `Productivity`.

**What did not, and could not have:** the field is **Subtitle**, capped at **30 characters**
(the portal's own examples are verb-led: "Find flights and hotels", "Create docs and
slideshows", "Find local hiking trails"). This file recorded a 41-character tagline with a
35-character fallback — **both over the cap, so neither was ever enterable**. The draft holds:

```
Assessments, diagrams and more
```
(exactly 30). A real subtitle was written at the portal and this file kept a proposal that would
have been rejected on paste. That is the drift this file exists to prevent; the cap is now
recorded so it cannot recur.

**Still unknown: what the LIVE v1.0.0 listing says.** This read-back is the rejected v2 draft,
not the published version. Whether any v2 copy reached the live listing through post-approval
editing is unanswered.

---

## DECIDED for 2.1.0 — 2026-09-18

**Subtitle: unchanged.** `Assessments, diagrams and more` (30/30) stays, because it is what the
portal draft already holds. The case for `Quizzes, spreadsheets, charts` below is a
search-term argument rather than a correctness one, and a resubmission carrying a rejection
history does not need to also change a field the portal has already accepted. Revisit it as its
own change once 2.1.0 is approved, where a listing edit can be judged on its own.

**Description: changed** to the three-paragraph text below (865 chars). That gap — L0177 and
L0178 invisible on the listing — is the reason to touch the copy at all.

**Starter prompt 1: changed**, see the table below; it now asks for the currency formatting the
old record wrongly assumed.

The machine copy is `graffiticode-skills/plugin.meta.json`; both shipped in the 2.1.0 artifact
recorded in `openai-submission.md` §2.

---

## Proposed for the resubmission — drafted 2026-09-16, NOT yet pasted

Rationale first, because the fields are short and the reasons are not.

### Subtitle (29 / 30)

```
Quizzes, spreadsheets, charts
```

The live draft's `Assessments, diagrams and more` spends its 30 characters on the two words a
searcher is least likely to type. "Assessments" is the institutional word for a quiz; nobody
looking for one searches it. "Quizzes" and "spreadsheets" are the highest-value terms we have,
and in list view the subtitle is the whole pitch. The audit that produced v2 found the listing
matched 0 of 8 realistic searches, and this field is the most concentrated place to fix that.

Deliberately NOT verb-led, though the portal's examples are: "Create quizzes, sheets, charts"
also fits (30), but spends four characters on the verb and forces "sheets" in place of
"spreadsheets". Whether the index matches whole words is the open question — the full word is
the safer bet, and the description carries the verb framing anyway.

### Description (865 chars, up from ~581)

> Graffiticode is a platform of specialized agents, each purpose-built for one kind of task and
> each producing a real, editable artifact rather than text in a chat window.
>
> Today's agents create interactive quizzes and assessment items — multiple choice,
> fill-in-the-blank, hot text, sequencing and matching — plus flashcard decks, spreadsheets
> and budgets, charts, and concept maps. Describe what you want in plain English;
> the matching agent validates your request against a formal task language and returns a
> structured result you can refine, re-render, and keep.
>
> For teams working in Learnosity, Graffiticode also authors Learnosity-compatible assessment
> items and writes integration recipes for the Author API and the Data API — embedding an item
> authoring UX, or reading and writing an item bank server to server. New agents are added to
> the catalog over time.

This closes the v2 gap: **both job families are now in the listing.** L0177 and L0178 were
invisible, and they are the surface most relevant to a Learnosity partnership. The integration
paragraph is deliberately last and explicitly conditioned ("For teams working in Learnosity"),
so the consumer framing that v2 was rebuilt around survives — v1's mistake was addressing
developers in the FIRST line, not mentioning developers at all.

Item types in paragraph two are named because they are what someone searches for, and each one
is shipped: choice, fill-in-the-blank, hot text, sequencing and matching are all in L0180's
current coverage. The description cap is unknown; if the portal rejects 877, cut the item-type
list in paragraph two first — it is the most redundant with the catalog itself.

### Vocabulary the action plan asks for, and what it gets

Included: `author api`, `data api`, `item bank`, `concept map`.

**Cut 2026-09-17: `worksheets`.** It carried two incompatible senses — a printable practice
page, and a tab in a workbook — and the second made it redundant with "spreadsheets and
budgets" three words later. Nothing backs the first: `list_languages(search: "worksheet")`
against production matches **L0180** (the assessment language) on a fuzzy match only; L0180's
own description and `when_to_use` never use the word, and neither does any skill. The ambiguity
costs more in the index than in the prose — it pulls in spreadsheet-intent searchers and lands
them on a quiz authoring language. `worksheet` stays in the re-audit search list, where its job
is to tell us whether the index reaches us through the rest of the copy.

**Excluded on purpose: `matching game` and `memory game`.** L0159 is the match-and-memory-game
language and it is `hidden` in the catalog — withheld from discovery, so nothing can route to
it. Advertising a memory game we cannot produce is a misleading claim on a page whose own
guidance forbids them, and it is a reviewer test case that fails. L0180 authors *matching items*
(pair these terms, sort these into categories), which paragraph two claims and which is a
different thing from a concentration game. If L0159 is unhidden, add both words then.

`mind map` stays a catalog search keyword rather than a listing claim: a concept web is
reasonably called a concept map, while a mind map is a looser artifact we do not really make.

### Starter prompts

Unchanged and re-verified 2026-09-15 (see the re-verification section above); they are separate
fields and a description edit does not affect them. **One decision is still open on prompt 1:**
its recorded output claimed `$#,##0.00` currency formatting, which was L0166's behaviour. L0179
emits raw numbers. Either accept the unformatted invoice or ask for formatting in the prompt and
re-verify — do not resubmit with the stale expectation in the record.

---

## v2 — submitted 2026-08-18, **REJECTED 2026-08-30**

> ⚠️ **Fields below are AS PROPOSED, not yet read back from the portal.** They were drafted
> and tested on 2026-08-18 and submitted the same day. Confirm against the live listing and
> correct any drift, then delete this warning.
>
> ⛔ **v2.0.0 was rejected on 2026-08-30** — "one or more test cases did not produce correct
> results." The copy was not the stated reason; the test cases were. See §10 of
> `openai-submission.md` for the findings and their status. **v2.0.0's version-level changes
> never shipped** — the approved version is still v1.0.0. Which copy users actually see is
> UNCONFIRMED: category and listing text were editable post-approval without a review cycle, so
> some v2 copy may be live on top of the v1.0.0 version. Read the portal back and record the
> answer here; that is the one question this file exists to answer and currently cannot.

**Category:** `Productivity` *(was: Developer Tools)*

**Name:** `Graffiticode`

**Tagline** (41 chars):

```
Quizzes, spreadsheets, diagrams, and more
```

Shorter fallback if the field tightens (35): `Quizzes, sheets, diagrams, and more`

**Description:**

> Graffiticode is a platform of specialized agents, each purpose-built for one kind of task
> and each producing a real, editable artifact rather than text in a chat window.
>
> Today's agents create interactive quizzes and assessments, worksheets, flashcards,
> spreadsheets and budgets, charts, and concept diagrams — including Learnosity-compatible
> assessment items. Describe what you want in plain English; the matching agent validates
> your request against a formal task language and returns a structured result you can
> refine, re-render, and keep. New agents are added to the catalog over time.

**Starter prompts** (portal limit: **128 characters each**):

| # | Prompt | Chars | Language | Verified output |
|---|---|---|---|---|
| 1 | `Create an invoice with line items, quantity, unit price, a line total per row, and a grand total, formatted as currency.` | 120 | **L0179** | per-row `=B2*C2`, `=SUM(D2:D4)` grand total, and `format "$0.00"` on the money columns — re-verified against production 2026-09-17 |
| 2 | `Create a concept web explaining how rain forms.` | 47 | L0169 | 5 assessed nodes + populated 6-concept drag tray |
| 3 | `Create a Learnosity water cycle assessment: one multiple-choice and one fill-in-the-blank, answers marked.` | 106 | L0176 | MCQ with correct option marked + `clozetext` with `{{response}}`, signed payload |

Every prompt above was executed against production before submission — see the
"Prompt verification" section. **The prompt TEXT is unchanged and still correct; what went
stale was the language behind prompt 1** — see the re-verification immediately below.

### Re-verification — 2026-09-15

Re-run against production (`mcp.graffiticode.org`) because L0166 was deprecated on 2026-08-26,
eight days after v2 was submitted, and has since left the catalog entirely. **All three prompts
pass.** Both halves were checked, because a storefront prompt can fail at either:

**Routing** — `npm run eval:routing -- --only starter`, 3 runs per prompt, all 3/3:

| # | Routes to | Discovery calls |
|---|---|---|
| 1 | L0179 | 0, 0, 0 |
| 2 | L0169 | 0, 0, 0 |
| 3 | L0176 | 1, 1, 1 |

The three prompts are now permanent cases in `scripts/eval-routing.ts`, tagged `starter`. They
are the only cases in that file whose exact wording is chosen outside this repo, and a
deprecation is exactly what breaks them silently — so re-run `--only starter` before any
resubmission and whenever a language they touch changes. Caveat: the eval drives
`claude-opus-4-8` against our real agent-facing surface, not ChatGPT's model. It measures our
instructions and catalog, which is the half we control; it is a proxy for the reviewer's client,
not a substitute.

**Generation** — created and inspected via `create_item` → `get_item`:

| # | Language | create→ready | Result |
|---|---|---|---|
| 1 | L0179 | 13.0s | `=B2*C2` per row, `=SUM(D2:D4)` grand total, bold header + total row, right-aligned numeric columns |
| 2 | L0169 | 9.7s | anchor + 5 connections, all `assess`ed, node text EMPTY, 6-concept tray populated — a real drag task, not a pre-filled diagram |
| 3 | L0176 | 7.4s | `mcq` with correct option marked (`score 1`, value `"0"`), `clozetext` with `{{response}}` and expected `"condensation"`, signed Learnosity request payload |

**One recorded expectation was wrong and is now corrected:** prompt 1's v2 record claimed
`$#,##0.00` currency formatting. L0179 produces none — the cells carry raw numbers. The v2
record described L0166's output and was never re-checked after the supersession. Either accept
the unformatted invoice, or change the prompt to ask for currency formatting and re-verify.

**A routing risk worth knowing:** `list_languages(search: "invoice")` returns **nothing**. The
prompt routes correctly because the catalog is inlined in `SERVER_INSTRUCTIONS` and a model
reads "invoice" as a spreadsheet job — not because search finds it. A client that searches
first sees an empty catalog. Same shape as the generic-quiz gap; the keyword index lives in the
console.

### Why these changed from v1

Driven by `artcompiler/marketing/graffiticode-chatgpt-listing-audit.md`: the v1 listing
matched **0 of 8** realistic user searches and 1 of 1 brand-name searches. Category and
copy were the two levers; category affects browse, description text is what plausibly
feeds search.

- **Category** — Developer Tools is an engineer's aisle; the example prompts were always
  end-user content. Productivity was chosen over Education & Research deliberately:
  Graffiticode is a horizontal platform of micro-agents and today's education skew is an
  artifact of which languages shipped first, not an identity. Filing under education would
  have required re-filing the moment a finance or ops language lands.
- **Tagline** — "Verified task execution" names no output. In list view it is the entire
  pitch.
- **Description** — the phrase "helps developers expose their services" is a faithful
  rendering of the positioning in `graffiticode-description-evolution.md`, and correct for
  the audience it was written for. It is wrong for a consumer storefront. The
  capability-boundary story survives in "validates your request against a formal task
  language"; only the audience marker was removed. The developer-facing rendering belongs
  on the site and README.
- **Starter prompt 2** — the v1 photosynthesis prompt returned an inert diagram with every
  answer pre-filled and an empty drag-and-drop tray. See "L0169 prompt mode" below.
- **Starter prompt 1** — replaced the budget spreadsheet, which is the same job done less
  well; keeping both would have spent two of three slots on spreadsheets.

### Known gaps in v2 — candidates for v3

Phase 2 of the messaging action plan asks for **both job families** in the listing. v2
ships only one.

- **L0177 (Learnosity Author API) and L0178 (Data API) are invisible.** The copy is
  entirely about interactive artifacts and never mentions integration recipes. Two of the
  seven flagship capabilities have no listing presence — and they are the surface most
  relevant to a Learnosity partnership conversation.
- **Indexed vocabulary the action plan calls for and v2 omits:** `author api`, `data api`,
  `item bank`, `matching game`, `memory game`, `concept map`, `mind map`.
- **The action plan's preferred tagline** was
  `Flashcards, sheets, charts, and Learnosity work for your agent.` v2 diverges. Reconcile
  deliberately rather than by accident.
- **NGN bow-tie is not represented.** L0176 generates a valid bow-tie with correct
  index-based validation (verified 2026-08-18). It is the strongest single proof of
  Learnosity spec depth and is better used as a direct partner artifact than a storefront
  prompt — the clinical stimulus reads as alienating to a general browser, and the natural
  prompt is 166 chars, over the limit.

---

## v1 — approved 2026-08-14 (version 1.0.0)

Superseded by v2. Recorded for diffing.

**Category:** `Developer Tools`

**Tagline:** `Verified task execution`

**Description:**

> Graffiticode lets AI agents perform verified, task-specific operations instead of making
> unrestricted API calls. By using formal task languages to validate inputs, enforce
> capabilities, and produce structured artifacts, Graffiticode helps developers expose
> their services to AI agents with greater control, reliability, and predictable results.

**Starter prompts:**

1. `Create a polished bar chart showing monthly sales with sample data.` (67)
2. `Create a clear concept web explaining how photosynthesis works.` (63)
3. `Build a monthly budget spreadsheet with categories and a totals row` (67)

**Skills bundled:** `render`, `assessments`, `learnosity` — all three surface as chips on
the listing; only `learnosity` is independently searchable in the Skills directory, under
the legacy identity `questioncompiler-learnosity`.

---

## Prompt verification

Starter prompts are executed against production before submission. An untested prompt in a
storefront is a demo that fails in front of the person deciding whether to install.

v2 run, 2026-08-18 (authenticated account, so free-plan funnel metrics are unaffected):

| Prompt | Item | Result |
|---|---|---|
| Invoice (shipped) | `eawxo1XIb0dCxXLqgGDu` | formulas + currency formatting ✅ |
| Team expense report | `5ViMce0zc06Lc8eCFvff` | SUM + AVERAGE, **no currency formatting** — rejected |
| Rain concept web (shipped) | `J5x6SRClf2mIiERyqtUe` | interactive assessment, drag tray populated ✅ |
| Photosynthesis (v1) | `p736IAxqwAbjbcRiQUtR` | good content, **empty drag tray** — inert |
| States of matter | `iiHsSBF21RhD0LrZZs6M` | 3 bare nodes, no edges — trivial |
| Marketing channels | `ggpD826tGyjlfoChc3Hk` | 6 bare nodes, no edges — flat list |
| Plant needs/produces | `1Ph3HGpHgSHSgKGyNAnR` | 6 bare nodes, topic degraded to "Concept Web" |
| Learnosity, 148-char | `iSkS3Iqlr9MWlqOR0QEq` | MCQ + cloze ✅ but over the 128 limit |
| Learnosity, 106-char (shipped) | `RzTVYeFkMwZet6UDKQ20` | MCQ + cloze ✅ |
| NGN bow-tie | `t2Xb3Kq1YxOTnx4c48V7` | valid 3-column bow-tie, `[[1,2],[4],[7,10]]` ✅ |

One difference between the two Learnosity variants: the 148-char version set
`case_sensitive: false` on the cloze and the shipped 106-char version does not. Learnosity's
default for that field is unconfirmed.

### L0169 prompt mode

Non-obvious and worth preserving. L0169 has two output modes and the **prompt's framing**
selects between them:

- A **staged process** ("explaining how rain forms") produces a real assessment — node text
  emptied, `assess`/`expected` set per node, and the `concepts` drag tray populated.
- A **state description** ("explaining how photosynthesis works") produces a finished
  diagram with every answer already placed, `concepts: []` and `relations: []` — nothing to
  interact with.
- Asking for something "simple", or to "show" a set of things, produces a flat hub-and-spoke
  with no labeled edges at all — clean but uninformative.

The lever is the verb and whether the topic has stages, not the topic's difficulty.

---

## Re-audit protocol

Per Phase 2 step 6: re-run the discoverability audit **after the directory reports indexing
is complete**, not immediately after publish. Test both Plugins and Skills with at least:

`graffiticode`, `flashcards`, `spreadsheet`, `worksheet`, `concept map`, `chart`,
`assessment`, `learnosity`, `author api`, `data api`

**The `learnosity` query is the load-bearing one.** It returned a hard empty in Plugins on
2026-08-17 while the listing carried a skill of that name — zero competition, unambiguous
read. v2 puts "Learnosity" in the description and a starter prompt. If it starts matching,
description text feeds the index and copy is the lever for everything else. If it still
returns empty, the index reads only name and tagline, and the real constraint is the
product name — a materially more expensive conversation, worth reaching early.

Record results in `artcompiler/marketing/graffiticode-chatgpt-listing-audit.md`.
