# Plan: `spec/user-guide.md` + `spec/language-info.json` for Each Language

**Audience:** whoever authors the spec files in a Graffiticode language repo (`../l0153`, `../l0166`, `../l0169`, etc.).
**Goal:** define the two files every language ships in `packages/api/spec/` and the build rule that wires them together. Once this template is settled, applying it to any individual language is a content task, not a design task.
**Model:** `../l0158/packages/api/spec/{user-guide.md,language-info.json}` + `tools/build-language-info.js`, landed in commit `6294f97c`.

The rest of `packages/api/spec/` (`spec.md`, `instructions.md`, `examples.md`, `template.gc`) is pre-existing language machinery and is not in scope for this plan.

---

## 1. Why these two files

The MCP server's `get_language_info(language)` handler returns an envelope — `description`, `authoring_guide`, `supported_item_types`, `example_prompts`, `user_guide_resource` URI — that comes from the language's own repo, not from console-level metadata. Agents use that envelope to compose a `create_item` prompt without guessing at the language's scope or vocabulary.

- `language-info.json` is the envelope the MCP server forwards to the agent.
- `user-guide.md` is the long-form reference the MCP server exposes as an MCP resource; agents fetch it via `ReadResource` when the envelope isn't enough.

The `authoring_guide` field in the envelope is the *inline summary* that shows up on every `get_language_info` call. It must not drift from the full guide — so it is not authored in the JSON. The build script extracts it from the `## Overview` section of `user-guide.md` and injects it on the way to `dist/`. One source, zero drift.

---

## 2. `spec/user-guide.md` — authoritative agent-facing guide

Canonical, hand-authored, UTF-8 markdown. Starts with the SPDX license header and the language's name as H1.

### 2.1 Required sections (in order)

| Heading | Purpose | Length target |
|---|---|---|
| `## Overview` | Inline summary. **Extracted by `build-language-info.js` and injected as `authoring_guide` in the envelope.** State what the language authors, what the input is (natural-language description), what the output is (a specific JSON / artifact shape), what's in scope, what's out of scope. Prose — no tables, no code blocks — because it ships inline through the MCP envelope. | 150–400 words |
| `## Vocabulary Cues` | Short glossary of the technical terms the translator understands. For each term, one bullet: "**Term** — what to say; what it does." Helps an agent pick words the language actually listens to. | 8–15 bullets |
| `## Example Prompts` | 4–8 natural-language prompts that each produce a specific output shape. Bulleted, each bullet ending with `→ <type_key>`. The same set of prompts populates `example_prompts` in the JSON envelope — keep them in sync. | 4–8 bullets |
| `## Out of Scope` | Bulleted list of adjacent concerns that belong elsewhere (delivery, host-app embedding, analytics, lower-level raw artifact patches, etc.). Each bullet names the thing and points at where it belongs. | 4–8 bullets |

Add further sections whenever language-specific information helps an agent compose a good request — a table of the discrete output shapes the language emits, a metadata surface, shared-stimulus conventions, rendering modes, whatever is load-bearing for *this* language. Keep each section short and concrete; only the required sections above are universal.

### 2.2 `## Overview` rules (the extracted section)

The build script reads the body between `## Overview` and the next `## ` heading and writes it as `authoring_guide`. Therefore:

- No code blocks, images, or tables in `## Overview`. They survive extraction but render poorly in JSON.
- No `#`/`##` subheadings inside `## Overview`. The extractor stops at the next `##`.
- Minimum 100 characters after trim. Shorter is a build failure.
- Prefer 2–3 short paragraphs. Describe the input, the output, the scope boundary, and any cross-cutting feature (like metadata) that an agent needs to know before writing the first request.

---

## 3. `spec/language-info.json` — machine-readable envelope

Hand-authored JSON. One object. No comments. Preserve the exact field order below so diffs across languages stay comparable.

### 3.1 Shape

```json
{
  "id": "0158",
  "description": "<one-paragraph author surface description; 1–3 sentences>",
  "supported_item_types": [ "<type_key>", "..." ],
  "example_prompts": [
    {
      "prompt": "<natural-language request verbatim>",
      "produces": "<type_key from supported_item_types>",
      "notes": "<one sentence explaining why this prompt is well-formed — what it names explicitly that the backend would otherwise have to guess>"
    }
  ]
}
```

### 3.2 Field rules

- **`id`** — the numeric portion only (`"0158"`), no leading `L`. The MCP server re-adds the prefix when it returns the envelope.
- **`description`** — the sentence a reviewer reads first. Name the author surface (what gets produced), not the implementation. Avoid the word "Graffiticode" — it's redundant inside a Graffiticode language's own spec.
- **`supported_item_types`** — flat array of type keys. Order by frequency of use, not alphabetically. Every string here must appear as a row in the `## Item Types` table of `user-guide.md` and as a `produces` value on at least one example prompt (ideally). Type keys are stable identifiers; do not rename once published.
- **`example_prompts`** — 4–8 entries. Each one:
  - `prompt` — verbatim what an agent should send to `create_item`. Write it the way Cowork / Claude Desktop would actually phrase it, not the way an internal test fixture would.
  - `produces` — one type key from `supported_item_types`. Lets a UI show both sides of the translation.
  - `notes` — one sentence explaining what this prompt does *explicitly* that a naive prompt would force the backend to guess. This is the most important field for agents reading the envelope — it teaches the prompting discipline without a ReadResource hop.
- **No `authoring_guide` field.** The build script rejects the envelope if it is present — that field is injected from `user-guide.md`'s `## Overview` section. Authoring it manually defeats the zero-drift guarantee.

### 3.3 Example-prompt coverage

- At least one prompt per "headline" item type. A `supported_item_types` value that never appears as a `produces` is a hint the type isn't first-class and should be reconsidered.
- At least one prompt exercises any optional feature that needs a specific phrasing (metadata tags, shared stimulus, rubric scoring, equivalence math matching). These are the prompts agents copy when they need to discover a feature exists.
- The last prompt in the list is a reasonable catch-all to demonstrate the full surface — a moderately complex request exercising several features at once.

---

## 4. `tools/build-language-info.js` — the bridge

Already authored in `../l0158/packages/api/tools/build-language-info.js`. Copy it verbatim into every language repo; it has no per-language behavior.

### 4.1 What it does

1. Read `spec/user-guide.md`. Extract the body under `## Overview` up to the next `## `. Trim.
2. Fail if `## Overview` is missing, or if its trimmed body is shorter than 100 characters.
3. Read `spec/language-info.json`. Fail if it contains a top-level `authoring_guide` field.
4. Write `dist/language-info.json` as `{ ...envelope, authoring_guide: <extracted Overview> }`, pretty-printed, trailing newline.
5. Write `dist/user-guide.md` as a byte-for-byte copy of `spec/user-guide.md`.
6. Log one line with character counts.

### 4.2 Build wiring (`package.json`)

```json
"build-language-info": "node tools/build-language-info.js"
```

Chain it into the top-level `build-static` script alongside `build-lexicon`, `build-spec`, and `build-instructions`:

```json
"build-static": "npm run -w packages/api build-lexicon; npm run -w packages/api build-spec; npm run -w packages/api build-instructions; npm run -w packages/api build-language-info"
```

Express already serves `dist/` statically, so `/language-info.json` and `/user-guide.md` come online with no route changes. The MCP server reads them through the existing console plumbing.

---

## 5. What the MCP server consumes

For each language, once these two files are built and deployed:

| MCP envelope field (client-facing) | Source |
|---|---|
| `id` | `spec/language-info.json` → `id` (MCP re-prefixes with `L`) |
| `description` | `spec/language-info.json` → `description` |
| `supported_item_types` | `spec/language-info.json` → `supported_item_types` |
| `example_prompts` | `spec/language-info.json` → `example_prompts` |
| `authoring_guide` | `spec/user-guide.md` → `## Overview` (via build script) |
| `user_guide_resource` URI → body | `spec/user-guide.md` (full file) |

Nothing else in the envelope needs per-language authoring. `name`, `category`, `spec_url`, `usage_guide_url` come from the console's own language record.

---

## 6. Per-language authoring checklist

When applying this template to a specific language, the work is entirely content:

1. Read the language's existing `spec/spec.md`, `spec/instructions.md`, and `spec/examples.md` to learn what the language actually emits. These already exist for every language and are the ground truth.
2. Enumerate the discrete output shapes (item types / artifact types) and their natural-language cues. This populates `## Item Types` in the guide and `supported_item_types` in the envelope.
3. Draft `## Overview` last, after the other sections exist — the summary is easier to write once the details are on paper. Keep it inline-friendly (prose only, 150–400 words).
4. Draft 4–8 example prompts. For each, write the `notes` field first (what makes this prompt well-formed?) — it forces you to pick prompts that actually teach the prompting discipline.
5. Copy `build-language-info.js` verbatim from `../l0158/packages/api/tools/`. Wire it into `package.json` per §4.2.
6. Run `npm run build-language-info` and resolve any validation failures (missing Overview, too-short Overview, manually-authored `authoring_guide`). Iterate on content until the build passes.
7. Verify by calling `get_language_info("L<id>")` against a dev MCP server — every envelope field should be populated, and `ReadResource` on the `user_guide_resource` URI should return the full markdown.

---

## 7. Out of scope for this plan

- `spec/spec.md`, `spec/instructions.md`, `spec/examples.md`, `spec/template.gc` — existing language machinery; not touched.
- Console-side language metadata (`name`, `category`, `spec_url`). Lives in the console, not in spec/.
- The MCP server itself. It already consumes these fields; no code change is required to pick up a new language's files.
- Translator few-shot example updates. Those are authored in `spec/examples.md` (or wherever the backend translator sources them) and are a separate change per language.
- Cross-language consistency enforcement (identical section headings, identical JSON key order). Aim for it by convention; don't build tooling for it yet.
