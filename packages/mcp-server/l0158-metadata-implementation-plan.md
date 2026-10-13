# Implementation Plan: Add a `metadata` Attribute to L0158

**Audience:** Claude Code, working in the L0158 language repo.
**Goal:** add a `metadata` attribute to the L0158 DSL surface so authors can attach Learnosity-compatible item metadata (standards tags, difficulty, DOK, author notes) through natural-language requests like *"Tag with NGSS MS-LS1-2, difficulty medium, DOK 2."*
**Why:** the partner-program demo for Learnosity hinges on items being searchable in the Learnosity Author Site immediately after authoring. Today L0158 silently drops tagging instructions because the DSL has no surface for them.

This plan is written for an implementer who has access to the L0158 language repo and to the Graffiticode backend that hosts L0158's natural-language translator. The MCP server (`graffiticode-mcp-server`) and the console-side language-info plumbing have already been updated in a separate change and should not be touched here.

---

## 1. Investigate first — do not edit until §1 is complete

Before modifying anything, build a map of the L0158 codebase. The plan below assumes a typical Graffiticode language layout; verify each assumption against the actual repo.

Map these concretely (write down file paths in the PR description):

1. **Grammar / parser** — where the DSL surface is defined. Likely a `.ohm`, `.peg`, or hand-written parser file. Find where `mcq`, `options`, and `valid-response` are recognized; that's where `metadata` will be added.
2. **Compiler** — where the parsed DSL is transformed into the Learnosity item JSON. Find the function that emits the item shape (the one whose output flows back through the Graffiticode backend to become the Learnosity item stored in the publisher's item bank).
3. **Backend translator prompt / few-shot examples** — where the natural-language → DSL prompt template lives. This may be in the L0158 repo or in a shared prompts repo on the Graffiticode backend. Find the few-shot examples that teach the translator the DSL surface; new examples will be added there.
4. **`spec/user-guide.md` and `spec/language-info.json`** — already in the L0158 repo per the prior change. Confirm location.
5. **Existing tests** — if any test fixture covers the existing `mcq` shape, note it; the new `metadata` block needs a parallel fixture.
6. **Compiler output target** — confirm whether the compiler produces a Learnosity Items API "Activity" wrapper (with item references) plus a separate item store-write, or whether item content is emitted inline. From an earlier MCP smoke test, `data` returned to the agent is the Activity wrapper; the actual item lives in Learnosity's item bank, written by the Graffiticode backend at compile time. The metadata change must reach *that* write, not just the wrapper.

Stop and re-scope if any of the following are true:
- The L0158 grammar isn't in this repo (it lives upstream in `@graffiticode/parser` or similar).
- Item compilation happens in a separate service the L0158 repo doesn't own.
- The translator's few-shot examples are managed by a separate team.

In those cases, document the boundary and open follow-up tickets — don't push a partial change.

---

## 2. Target DSL syntax — two metadata blocks, not one

Learnosity has two metadata surfaces and they serve different purposes. Both must be expressible in L0158.

- **Item-level metadata** is what the Learnosity Author Site indexes for search and filtering. Standards tags (NGSS, Common Core, custom taxonomies), difficulty, DOK, and item-level status all belong here. Tags placed on a question instead of an item are invisible to Author Site search.
- **Question-level metadata** travels with the individual interaction if it's reused in a different item. The headline field for the Learnosity demo is `distractor_rationale_response_level` — per-option explanations of why each distractor is wrong, surfaced by the player on incorrect answers and shown in the Author Site review pane. Question-level `acknowledgements` and per-question author notes also live here.

Add a `metadata` block on the `item` constructor *and* a separate `metadata` block on each question constructor (`mcq`, `shorttext`, `clozedropdown`, etc.). The existing L0158 surface already nests `mcq` inside `item questions [...]` so both attachment points fit cleanly into the current grammar.

```
item
  metadata [
    tags [ "NGSS:MS-LS1-2" "topic:cellular-respiration" ]
    difficulty "medium"
    dok 2
    notes "Variant A of the organelle misconception set"
  ]
  questions [
    mcq stimulus "What is the primary function of the mitochondria in a cell?"
      options [
        "To produce energy (ATP) through cellular respiration"
        "To control what enters and exits the cell"
        "To build proteins using genetic instructions"
        "To store and protect the cell's DNA"
      ]
      valid-response [ 0 ]
      metadata [
        distractor-rationale [
          "Correct — ATP production via cellular respiration."
          "That's the role of the cell membrane."
          "That's the role of ribosomes."
          "That's the role of the nucleus."
        ]
        notes "Targets the three most common organelle confusions."
      ]
      {}
  ]
  {}
```

### Item-level fields

| DSL field | Type | Required | Notes |
|---|---|---|---|
| `tags` | list of `"key:value"` strings | no | Each string splits on the first `:` into a Learnosity tag type and value. Multiple tags with the same type accumulate. Empty list is valid. |
| `difficulty` | string (`"easy"`/`"medium"`/`"hard"`) or integer | no | Implementer's call which form to canonicalize on; pick one and document. |
| `dok` | integer `1`–`4` | no | Webb's Depth of Knowledge level. Conventionally stored as a tag at item level so the Author Site can filter on it. |
| `notes` | string | no | Free-form author note. Maps to the item's user-metadata note field. |

### Question-level fields

| DSL field | Type | Required | Notes |
|---|---|---|---|
| `distractor-rationale` | list of strings (one per option) or single string | no | List form maps to `metadata.distractor_rationale_response_level` (per-option). Single-string form maps to `metadata.distractor_rationale` (whole-question). The list length should equal the number of options; mismatch is a compiler warning, not a hard error. |
| `acknowledgements` | string | no | Attribution. Maps to `metadata.acknowledgements`. |
| `notes` | string | no | Question-level author note. Maps to `metadata.note` on the question, distinct from the item-level note. |

Decisions to make explicitly (write them in the PR):

- **Tag format**: `"key:value"` strings are simplest for the LLM to emit. The colon-split rule needs to be documented and tested. If tags can contain colons (e.g., `"Common Core:Math:6.NS.A.1"`), switch to a structured form like `tags [ { type "NGSS" value "MS-LS1-2" } ]` or split-on-first-colon-only. Pick one before merging.
- **Difficulty canonical form**: prose strings are friendlier for natural-language prompts; numeric is friendlier for downstream filtering. Either is fine; pick one.
- **Single vs. multiple distractor-rationale forms**: the spec above accepts both list and string. If keeping both adds parser complexity, drop the single-string form — the list form is what publishers actually want for review-mode display.

---

## 3. Mapping to the Learnosity schema — split by level

The compiler must place each field at the right level of the Learnosity item shape. Item-level fields go on the item; question-level fields go on each question. Putting tags on a question or distractor rationale on the item is technically valid JSON but functionally wrong — the Author Site won't find them in the right place.

Verify all field paths against the Learnosity Items / Authoring API docs before wiring; this is the most likely source of incorrect-but-plausible field names.

### Item-level mapping (on the item record written to the item bank)

| L0158 DSL | Learnosity field (verify) | Notes |
|---|---|---|
| `metadata.tags [...]` | `tags` (object keyed by tag type) on the item | `"NGSS:MS-LS1-2"` becomes `{"NGSS": ["MS-LS1-2"]}`. Multiple tags with the same type accumulate into the array. |
| `metadata.difficulty` | item `metadata.difficulty` (or top-level depending on schema version) | Confirm where the Learnosity Author Site expects difficulty for filtering. |
| `metadata.dok` | item `tags["DOK"]` (preferred) or `metadata.dok` | DOK is conventionally stored as a tag at item level so it shows up in the Author Site's tag filters. |
| `metadata.notes` | item `metadata.note` or `user_metadata.note` | Free-form author note. |

### Question-level mapping (on each question within `questions[...]`)

| L0158 DSL | Learnosity field (verify) | Notes |
|---|---|---|
| `metadata.distractor-rationale` (list form) | question `metadata.distractor_rationale_response_level` (array of strings, one per option) | The Learnosity player surfaces these on incorrect answers; the Author Site shows them in the review pane. |
| `metadata.distractor-rationale` (string form) | question `metadata.distractor_rationale` | Whole-question rationale, used when per-option detail isn't needed. |
| `metadata.acknowledgements` | question `metadata.acknowledgements` | Attribution. |
| `metadata.notes` | question `metadata.note` | Distinct from the item-level note. |

**Critical:** the Learnosity metadata schema has multiple variants (Items API vs. Authoring API; different field names depending on consumer version). Pick the variant that matches what the Graffiticode backend writes today and stay consistent across both levels.

If a DSL field has no clean Learnosity equivalent, prefer placing it under `user_metadata` (a free-form object that exists at both item and question level) rather than inventing top-level fields — that keeps Graffiticode-authored items valid for any Learnosity consumer.

---

## 4. Ordered implementation steps

Run the L0158 build/test suite (whatever exists) after each step. If the build fails, fix before moving on.

1. **Grammar.** Add `metadata [ ... ]` as an optional, position-independent attribute on **two** constructors per §2: on `item` (item-level fields) and on each question constructor (`mcq`, `shorttext`, `clozedropdown`, etc., for question-level fields). Update the parser tests if any.

2. **AST/IR.** If L0158 has an intermediate representation between parser and compiler, add a `metadata` node at both levels and propagate them independently. Default each to empty (not null) so downstream code doesn't need null-checks.

3. **Compiler.** In the function that emits the Learnosity item JSON, read both metadata nodes and populate the corresponding fields per §3's split mapping table. Item-level fields go on the item record; question-level fields go on the matching question. Preserve existing behavior when both metadata blocks are absent — the resulting item must be byte-identical to today's output for items that don't use the new attribute.

4. **Backend write.** If the compiler write to Learnosity's item bank is a separate step from JSON emission, ensure the metadata fields are included in the write payload. This is the most likely place for a regression — adding metadata to the JSON object but forgetting to include it in the API call to Learnosity.

5. **Translator examples.** Add 2–3 few-shot examples to the L0158 backend translator that show natural-language requests producing DSL with a `metadata` block. At minimum:
   - One MCQ with full metadata (tags, difficulty, DOK, notes) — uses every field.
   - One short-text with only tags — exercises the partial-metadata case.
   - One MCQ with no metadata at all — preserves the existing path so the translator doesn't start adding metadata blocks unprompted.

6. **Round-trip preservation.** Verify that the translator preserves an existing `metadata` block when the user asks for an unrelated change ("change the stem to be shorter"). The contextual prompt in `handleUpdateItem` (in the MCP server) already passes `currentSrc` and the `help` history to the backend, so the translator sees the existing metadata. Add one few-shot example showing a stem-only edit that leaves the metadata block intact — this teaches the translator not to touch metadata it wasn't asked about.

7. **`spec/user-guide.md`.** Add a "Metadata" section documenting the DSL surface, the Learnosity field mapping, and the tag-format convention.

8. **`spec/language-info.json`.** Update `description` to mention metadata explicitly. Add at least one entry to `example_prompts` that exercises metadata, with a `notes` field explaining the value:
   ```json
   {
     "prompt": "Create a 4-option MCQ on the function of mitochondria. Distractors should match common misconceptions. Tag with NGSS MS-LS1-2, difficulty medium, DOK 2.",
     "produces": "mcq",
     "notes": "Names the standard, difficulty, and DOK in one breath — the item is searchable in the Learnosity Author Site from the moment it's written."
   }
   ```

---

## 5. Acceptance criteria (verifiable, not eyeballed)

All five must pass.

1. **Parser.** A DSL fragment with a `metadata` block parses successfully. A DSL fragment without one continues to parse identically to today.

2. **Compiler — level correctness.** A fixture using both metadata blocks compiles to a Learnosity item where:
   - **On the item:** `tags["NGSS"]` contains `"MS-LS1-2"`, `metadata.difficulty` (or whichever field §3 settled on) equals `"medium"`, DOK appears at its mapped path, and item notes land at the item-level note field.
   - **On the question:** `metadata.distractor_rationale_response_level` is an array of four strings matching the DSL list, and the question-level note (if present) lands at the question's note field, distinct from the item's.
   - **No leakage between levels:** item-level fields do not appear on the question, and question-level fields do not appear on the item.
   - All pre-existing fields (stem, options, valid-response) are byte-identical to today's output for the same prompt minus the metadata.

3. **Backend write.** After compiling and writing to the item bank, opening the item in the Learnosity Author Site (or fetching it via the Items API) shows the item-level tags, difficulty, and DOK in the search/filter facets, and the per-option distractor rationales in the question's review pane.

4. **Translator.** Sending the prompt *"Create a 4-option MCQ on the function of mitochondria. Distractors should match common misconceptions, and add a one-line rationale for each. Tag with NGSS MS-LS1-2, difficulty medium, DOK 2."* through the MCP `create_item("L0158", ...)` produces DSL containing a populated item-level `metadata` block (tags, difficulty, DOK) **and** a populated question-level `metadata` block (distractor-rationale list with four entries). This is an expansion of the earlier smoke test; it currently produces DSL with no metadata at either level.

5. **Round-trip.** After step 4, calling `update_item(item_id, "Make the stem shorter and clearer.")` produces DSL where the stem changed but **both** `metadata` blocks are unchanged. Confirm by diffing the `src` field returned from `get_item` before and after.

---

## 6. Don't touch

- `graffiticode-mcp-server` — already updated; no MCP-side changes required for this feature. The MCP passes `src` and `help` through transparently.
- The console-side language-info plumbing — already updated to surface `examples`, `authoring_guide`, `supported_item_types`, and `example_prompts`. Updating `spec/language-info.json` in the L0158 repo will propagate through that plumbing on its own.
- Other Graffiticode languages (L0153, L0154, L0159, L0166, L0169, L0171, L0172). They share infrastructure but each has its own DSL surface; metadata for them is a separate ticket.
- Learnosity's own systems. The metadata write goes through whatever item-bank API the Graffiticode backend already uses; this change adds fields to an existing payload, not new endpoints or auth.
- Existing items already in publishers' item banks. The migration is forward-only — old items stay valid with no metadata. Don't backfill.

---

## 7. Known unknowns

- **Learnosity item metadata schema variant.** The exact field paths in §3 must be verified against the Items API version the Graffiticode backend writes to. If the schema has changed between Learnosity API versions, pick the version currently in use and stay consistent.
- **Where the translator's few-shot examples live.** May be in the L0158 repo, may be in a shared prompts service. The investigation in §1.3 should resolve this; if it doesn't, stop and ask.
- **Tag format collisions.** If tag values can themselves contain colons (e.g., `"Common Core:Math:6.NS.A.1"`), the `"key:value"` split in §2 needs a more careful rule (split on first colon only) or the DSL needs the structured form. Test with at least one colon-bearing tag value before merging.
- **Difficulty conventions per publisher.** Some publishers use `"easy"/"medium"/"hard"`, some use `1`–`5`, some use `Beginning/Developing/Proficient/Advanced`. The DSL accepts a string, but the *canonical* mapping is a publisher policy. Document in `user-guide.md` that `difficulty` is opaque to L0158 — whatever the prompt says ends up in the item.
- **DOK as tag vs. metadata field.** Confirm with whoever owns the publisher's Learnosity setup which form their Author Site filters expect; emit the form that's actually searchable.

---

## 8. Commit guidance

Make this a multi-commit branch (the change is too large for a single commit) with this rough sequence:

```
feat(l0158): add metadata block to DSL grammar
feat(l0158): compile metadata to Learnosity item fields
feat(l0158): translator examples for metadata authoring
docs(l0158): document metadata surface in user-guide and language-info
```

Each commit should leave the build green and the existing test suite passing. Do not push. Do not amend prior commits. Open the PR as draft until the §5 acceptance criteria all pass; only then mark it ready for review.

---

## 9. Local verification recipe

After the four commits land on the branch:

```bash
# 1. Build / parser tests (paths depend on §1 investigation)
# 2. Compile the fixture in §5.2 and inspect the JSON output
# 3. Round-trip via MCP — requires the Graffiticode backend running locally
#    or against staging:

# (in a separate terminal, with GC_API_KEY_SECRET set)
node graffiticode-mcp-server/dist/index.js

# Then send through your MCP client of choice:
# create_item("L0158", "Create a 4-option MCQ on the function of
#   mitochondria. Distractors should match common misconceptions.
#   Tag with NGSS MS-LS1-2, difficulty medium, DOK 2.")

# Confirm the returned `src` contains a `metadata` block with
# the expected fields. Then:

# update_item(<item_id>, "Make the stem shorter and clearer.")

# Confirm `src` shows the stem changed and the metadata block
# unchanged.

# 4. Open the item in the Learnosity Author Site
#    (URL pattern depends on the consumer key in use) and confirm
#    the tags/difficulty/DOK appear where Learnosity expects them.
```

If any of §5's five criteria fail, do not merge. The translator example coverage in §4.5 is the most common cause of partial regressions — if criterion 4 or 5 fails, add another few-shot example covering the failing case before re-testing.

---

## 10. Demo implication

Two beats unlock once this lands.

**Item-level tagging, for the search-and-filter visual.** Priya asks Cowork *"For each of these 10 items, tag them to the right NGSS standard from the chapter blueprint and set difficulty based on the cognitive demand."* Cowork composes the prompts, L0158 emits item-level metadata, the items land in Learnosity's item bank already searchable. The visual is the Learnosity Author Site filter dropping items into the right NGSS bucket *without anyone exporting or re-tagging* — distinguishing Graffiticode from "AI item generator" tools that produce untagged JSON.

**Per-option distractor rationale, for the pedagogical-quality visual.** This is the more powerful beat. The mitochondria-MCQ smoke test already produces distractors that are pedagogically sharp (each maps to a named organelle misconception). With question-level `distractor-rationale`, Priya can ask *"add a one-line rationale to each distractor explaining the misconception"* and the Author Site review pane shows the *teaching intent* alongside the item. The argument lands without narration: this isn't an LLM generating items, it's an authoring layer that captures editorial reasoning the way a content editor would. That's the moment that converts Learnosity management from "interesting tool" to "we should partner."
