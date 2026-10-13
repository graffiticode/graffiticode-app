# Proposal: Make L0158's Authoring Surface Visible Through the MCP

**Audience:** maintainers of `graffiticode-mcp-server` and the console-side language metadata for L0158.
**Goal:** ensure that any MCP client (Cowork, Claude Desktop, ChatGPT Apps, etc.) can see — directly from the MCP surface — that L0158 takes declarative English and emits Learnosity-compatible items, and knows enough to compose good requests without a second hop to an external usage guide.
**Motivation:** the Learnosity partner-program pitch. When a reviewer inspects `get_language_info("L0158")`, the response should read like an authoring tool for Learnosity, not a React widget library.

---

## 1. What's already good

Two pieces of the current server correctly establish the declarative-English contract:

**`SERVER_INSTRUCTIONS`** (`src/tools.ts:62–68`) is sent to every client at connection time and says, verbatim:

> All requests to `create_item` and `update_item` must be natural language descriptions of what to create or change. A language-specific AI backend handles all code generation. Do not attempt to generate Graffiticode DSL code directly.

**`createItemTool.description`** (`src/tools.ts:74–78`) reinforces it:

> Create interactive content in any Graffiticode language. Describe what you want in natural language — a language-specific AI generates the result.

Between those two, a well-behaved agent knows it should send English, not DSL. That part is fine.

---

## 2. Where the gap is

The problem is visible when a client actually calls `get_language_info("L0158")`. The handler at `src/tools.ts:490–521` returns a response shaped like this:

```
{
  id, name, description, category,
  usage_guide_url,
  spec_url,
  react_usage: { npm_package, peer_dependencies, usage, example, vite_config, troubleshooting }
}
```

Three issues, in order of importance.

### 2.1 `react_usage` does not belong in the MCP at all

`getReactUsage()` (`src/tools.ts:238–306`) fabricates a universal React integration block — peer dependencies, a multi-line Form-state snippet, a Vite config, a troubleshooting table — and stamps it onto every language's response. For data-category languages like L0158, this block is roughly 80% of the response by length.

**It should be removed entirely, not demoted.** The MCP server's job is to help an agent *author* content; it is not a host-app integration guide. React embedding is a downstream concern for a developer wiring a host application, not for the agent composing a natural-language request. Leaving `react_usage` in the response:

- Wastes context on every `get_language_info` call.
- Misleads a reviewer skimming the MCP surface into thinking this is a React widget library rather than an authoring tool — exactly the wrong first impression for the Learnosity partner-program pitch.
- Couples the MCP to one specific host runtime (React + Vite) when the authored items are runtime-agnostic JSON that Learnosity itself renders.
- Encourages agents to spend tokens on integration advice they can't act on.
- Creates drift risk: the React snippet is hand-written in `getReactUsage()` and has to be maintained separately from the actual `@graffiticode/l0158` package README.

React usage belongs on the language's public docs site (`https://l0158.graffiticode.org/`) or in the `@graffiticode/l0158` npm README. Not in the MCP response.

**Concrete change:**

- Delete `getReactUsage()` and all references to it.
- Remove the `react_usage` field from the `get_language_info` response shape.
- Remove the `hint: "Call get_language_info() for React component usage and embedding instructions."` lines at `src/tools.ts:422` and `src/tools.ts:462` — they advertise exactly the field we're removing. Replace with no hint, or a hint focused on authoring iteration (e.g. *"Use `update_item` with a natural-language modification to iterate."*).

### 2.2 The `examples` field is dropped on the floor

`LanguageInfo` in `src/api.ts:298–310` declares an `examples: string[]` field that the backend GraphQL query selects:

```typescript
export interface LanguageInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  examples: string[];          // ← queried from backend
  reactComponent: { ... };
  specUrl: string;
}
```

But `handleGetLanguageInfo` (`src/tools.ts:512–520`) never includes `examples` in what it returns to the client. Any per-language examples authored on the console side never reach the agent. Almost certainly unintentional and cheap to fix.

### 2.3 All authoring detail lives one hop away

What a Cowork agent actually needs to know to write a good `create_item` prompt for L0158:

- Which Learnosity item types are in scope (MCQ, cloze, short-text, math, drag-drop, hotspot, …)
- What vocabulary the translator understands (stem, distractor, rubric, scoring, shared stimulus, …)
- What's out of scope or partially supported
- Two or three example prompts that map to concrete item types

All of that currently lives at `https://l0158.graffiticode.org/usage-guide.html`. The MCP returns a URL but no inline content. An agent won't fetch it unless explicitly told to, and a human reviewer sees a URL, not substance.

---

## 3. Proposed changes, smallest to largest

### 3.1 Short term (handler-only, no schema change) — ship this week

**Remove `react_usage` from the MCP response** (see §2.1). Delete `getReactUsage()` in `src/tools.ts:238–306` and the two `hint` references that advertise it (`src/tools.ts:422`, `src/tools.ts:462`).

**Expose `examples` that the backend already returns.** Update `handleGetLanguageInfo` in `src/tools.ts` so the returned object includes `examples: info.examples ?? []`. Then populate the `examples` field for L0158 on the console side with 3–5 representative natural-language prompts (see §4 for draft content).

**Target response shape after these two changes:**

```
{
  id, name, description, category,
  examples,                 // ← new, authoring-facing
  usage_guide_url,
  spec_url
}
```

Note the absence of `react_usage`. Every field that remains is directly useful to an agent composing an authoring request or to a reviewer evaluating the authoring surface.

**Expand L0158's `description`** on the console side from `"Learnosity integrations"` to something that names the author surface. Draft: *"Authors Learnosity-compatible assessment items from natural language. Supports MCQ, cloze/fill-blank, short-text, math, and [list]. Describe stem, answer, distractors, scoring, and tags — L0158 emits a valid Learnosity item JSON."*

### 3.2 Medium term (schema additions) — next sprint

Add two optional fields to the `LanguageInfo` GraphQL type and surface them through `get_language_info`:

- **`authoring_guide: String`** — a short paragraph (200–400 words) describing scope, vocabulary, and non-goals. Inline, not a URL.
- **`supported_item_types: [String!]`** — a flat list of item-type keys the language can emit. For L0158 that might be `["mcq", "cloze", "short_text", "math_formula", "drag_drop", "hotspot", "passage_with_items", ...]`. Lets an agent or a UI enumerate without parsing prose.

The existing `examples` field is a fine start but mixes purposes (demo strings vs. prompt examples). Consider tightening it to `example_requests: [ExampleRequest!]` where each entry is `{ prompt: String!, produces: String }`, so a client can show both sides of the translation.

### 3.3 `SERVER_INSTRUCTIONS` tweak

Add one sentence to the instructions in `src/tools.ts:62–68`:

> `get_language_info` returns inline `examples` and (when available) an `authoring_guide` — read these before composing a `create_item` request so the description matches what the language can actually produce.

Tells the agent to actually consume the new fields.

---

## 4. Draft content for L0158 (paste-ready)

These are suggested values for the fields above, written to be returned *inline* through the MCP so a Cowork agent sees them without a second fetch.

### `description` (replaces "Learnosity integrations")

> Authors Learnosity-compatible assessment items from natural language. Supports multiple-choice, cloze/fill-in-the-blank, short-text, math, drag-and-drop, hotspot, and grouped passage items. Describe the item in plain English — stem, correct answer, distractors, scoring, standards tags — and L0158 emits valid Learnosity item JSON.

### `authoring_guide`

> L0158 is an authoring language for Learnosity assessment items. Input is a natural-language description of a single item (or a small group sharing a stimulus). Output is a Learnosity-shaped item with a stem, interaction(s), validation, scoring, and optional metadata tags.
>
> When composing a request, name the item type explicitly if you know it ("multiple choice", "cloze", "short response"), and include the stem text, the correct answer, any distractors, the scoring model (exact match, partial credit, rubric), and standards or difficulty tags. If the item shares a passage or image with others, describe the shared stimulus once and let L0158 handle the grouping.
>
> In scope: item authoring, item-level metadata, item-level accessibility hints (alt text, reading level), variant generation. Out of scope: activity-level assembly, delivery configuration, learner-side analytics — those belong in Learnosity Items/Activities APIs after export. Host-app embedding is also out of scope for this language surface; see the L0158 docs site for host-app integration.

### `supported_item_types` (illustrative — confirm against actual L0158 capability)

```
["mcq_single", "mcq_multi", "cloze_dropdown", "cloze_text",
 "short_text", "long_text_essay", "math_formula",
 "drag_and_drop", "hotspot", "passage_with_items"]
```

### `example_requests`

```json
[
  {
    "prompt": "Create a 4-option MCQ on the function of mitochondria. One correct answer. Distractors should match common misconceptions. Tag with NGSS MS-LS1-2. Difficulty: medium.",
    "produces": "mcq_single"
  },
  {
    "prompt": "Write a cloze item with three dropdowns about the stages of mitosis in order: prophase, metaphase, anaphase. Show the stem above a sentence with blanks.",
    "produces": "cloze_dropdown"
  },
  {
    "prompt": "Short-text item asking students to define 'allele' in one sentence. Use a rubric with 2 points: 1 for naming it as a gene variant, 1 for mentioning it occurs at a locus.",
    "produces": "short_text"
  },
  {
    "prompt": "Given this passage about photosynthesis, write three related MCQs sharing the passage as a stimulus. Each should target a different depth-of-knowledge level.",
    "produces": "passage_with_items"
  }
]
```

---

## 5. Demo implication

The Ridgeline Learning demo for Learnosity benefits directly from §3.1. During the "Priya ingests the chapter" beat, the on-screen narrative can show Cowork calling `get_language_info("L0158")` and — in a single response — getting a crisp authoring contract, example prompts, and item-type scope. That visible round-trip is the moment that lands the partner-program argument: *this isn't a raw LLM guessing at Learnosity JSON; it's a typed, documented authoring layer.*

Without §3.1 that moment is weak — the reviewer sees a React widget integration block and a URL. With it, the moment sells the pitch on its own.

---

## 6. Minimum viable set for the demo

If time is tight:

- §3.1 handler changes: **remove** `react_usage`, **surface** `examples`, and drop the two `hint` lines that advertise `react_usage`.
- §4 content populated on the console side for L0158.
- §3.3 one-line update to `SERVER_INSTRUCTIONS`.

Everything else (schema additions, tightened `example_requests` type) can follow after the demo lands.

---

## 7. Implementation Plan (for Claude Code)

This appendix is for Claude Code implementing §3.1 and §3.3. The human-facing §2–§6 above explain the rationale; this section tells CC exactly what to change and how to verify.

### 7.1 Scope boundary — read first

**In scope for this change:**
- `src/tools.ts` — handler, tool descriptions, `SERVER_INSTRUCTIONS`.
- Nothing else in this repo.

**Out of scope — do not touch:**
- `src/api.ts` — leave `LanguageInfo`, the GraphQL query, and all other exports alone. In particular, **keep the `examples: string[]` field on `LanguageInfo` and keep it selected in the `getLanguageInfo` GraphQL query.** We need that field populated to surface it.
- `src/widget/` — unrelated to this change.
- `src/server.ts`, `src/index.ts`, `src/auth.ts` — unrelated.
- Tool names (`create_item`, `update_item`, `get_item`, `list_languages`, `get_language_info`) and their `inputSchema` — removing or renaming them breaks existing clients.
- The console-side language metadata at `console.graffiticode.org` — not in this repo. §4 draft content is for a separate ticket.
- Anything on `api.graffiticode.org` — not in this repo.

If you find yourself editing `src/api.ts`, `src/widget/`, `src/server.ts`, or the GraphQL schema, stop and re-read this boundary.

### 7.2 Ordered steps (build stays green at each step)

Run `npm run build` after each step. If the build fails, fix before moving on.

1. **Remove the two `hint` lines that advertise `react_usage`.**
   - `src/tools.ts:422` (inside `handleUpdateItem`'s return)
   - `src/tools.ts:462` (inside `handleGetItem`'s return)
   - Delete the `hint: "Call get_language_info() for React component usage and embedding instructions.",` line in both places. Do not add a replacement hint.

2. **Remove `react_usage` from the `handleGetLanguageInfo` return.**
   - `src/tools.ts:519` — delete the `react_usage: reactUsage,` line.
   - `src/tools.ts:503` — delete the `const reactUsage = getReactUsage(info.id);` line.

3. **Delete `getReactUsage()` entirely.**
   - `src/tools.ts:238–306` — delete the whole `function getReactUsage(langId: string) { ... }` block.
   - There should be no remaining references. Verify with `grep -n "getReactUsage\|react_usage\|reactUsage" src/tools.ts` — expected output: nothing.

4. **Surface `examples` in the `handleGetLanguageInfo` return.**
   - In the return object in `handleGetLanguageInfo` (around `src/tools.ts:512–520` before step 2's deletion), add: `examples: info.examples ?? [],` — place it after `category` and before `usage_guide_url`. Use the nullish-coalescing form; the backend may return an empty array or `undefined`, and we must not throw on either.

5. **Update `SERVER_INSTRUCTIONS`.**
   - In `src/tools.ts:62–68`, append one sentence to the existing instructions block: *"`get_language_info` returns inline `examples` and (when available) an `authoring_guide` — read these before composing a `create_item` request so the description matches what the language can actually produce."*

### 7.3 Concrete diffs for the three most mistake-prone edits

**Edit A — `handleGetLanguageInfo` return (tools.ts:512–520):**

Before:
```typescript
  const reactUsage = getReactUsage(info.id);

  // Derive usage guide URL from spec URL
  const usageGuideUrl = info.specUrl
    ? info.specUrl.replace(/spec\.html$/, "usage-guide.html")
    : null;

  return {
    id: `L${info.id}`,
    name: info.name,
    description: info.description,
    category: info.category,
    usage_guide_url: usageGuideUrl,
    spec_url: info.specUrl,
    react_usage: reactUsage,
  };
```

After:
```typescript
  // Derive usage guide URL from spec URL
  const usageGuideUrl = info.specUrl
    ? info.specUrl.replace(/spec\.html$/, "usage-guide.html")
    : null;

  return {
    id: `L${info.id}`,
    name: info.name,
    description: info.description,
    category: info.category,
    examples: info.examples ?? [],
    usage_guide_url: usageGuideUrl,
    spec_url: info.specUrl,
  };
```

**Edit B — hint removals (tools.ts:422 and tools.ts:462):**

Delete this exact line in both locations:
```typescript
    hint: "Call get_language_info() for React component usage and embedding instructions.",
```
Do not add a replacement. The surrounding return object remains otherwise unchanged.

**Edit C — `SERVER_INSTRUCTIONS` (tools.ts:62–68):**

Before:
```typescript
export const SERVER_INSTRUCTIONS = `Graffiticode is an open-ended platform of domain-specific tools for creating interactive content — assessments, spreadsheets, flashcards, and more. The catalog of available tools grows over time.

When the user's request doesn't match another available tool, call list_languages() to check if Graffiticode has a language that fits. Use the search parameter to match by keyword. If a match exists, call get_language_info() to learn what the language can create and get its usage guide URL, then call create_item() with a natural language description.

All requests to create_item and update_item must be natural language descriptions of what to create or change. A language-specific AI backend handles all code generation. Do not attempt to generate Graffiticode DSL code directly.

Workflow: list_languages(search) → get_language_info(language) → create_item(language, description) → update_item(item_id, modification) to iterate.`;
```

After (adds one sentence between paragraphs three and four):
```typescript
export const SERVER_INSTRUCTIONS = `Graffiticode is an open-ended platform of domain-specific tools for creating interactive content — assessments, spreadsheets, flashcards, and more. The catalog of available tools grows over time.

When the user's request doesn't match another available tool, call list_languages() to check if Graffiticode has a language that fits. Use the search parameter to match by keyword. If a match exists, call get_language_info() to learn what the language can create and get its usage guide URL, then call create_item() with a natural language description.

All requests to create_item and update_item must be natural language descriptions of what to create or change. A language-specific AI backend handles all code generation. Do not attempt to generate Graffiticode DSL code directly.

get_language_info returns inline examples and (when available) an authoring_guide — read these before composing a create_item request so the description matches what the language can actually produce.

Workflow: list_languages(search) → get_language_info(language) → create_item(language, description) → update_item(item_id, modification) to iterate.`;
```

### 7.4 Acceptance criteria (run these, don't eyeball)

All three must pass.

1. **Shape check on the returned object.** After the edits, the return object literal in `handleGetLanguageInfo` has exactly these top-level keys, in this order: `id`, `name`, `description`, `category`, `examples`, `usage_guide_url`, `spec_url`. No others. Verify by reading the return block.

2. **No residue check.** `grep -nE "react_usage|getReactUsage|reactUsage|reactComponent" src/tools.ts` produces no output. (`reactComponent` is the `LanguageInfo` field name — we don't consume it anymore, and it should not appear in `tools.ts`.)

3. **Build + smoke.** `npm run build` exits 0 with no TypeScript errors. Then, from the MCP side, calling `get_language_info` with `language: "L0158"` returns an object whose keys match criterion 1 and whose `examples` key is present (may be `[]`). A quick way to smoke-test without a live client: read `dist/tools.js` and confirm the compiled return shape matches. Don't worry about exercising the full stdio transport if that's not already wired in dev.

### 7.5 Known unknowns

- **`info.examples` may be empty or missing.** The backend console may not yet be populating `examples` for L0158. That's fine and expected. Use `info.examples ?? []` defensively — an empty array is not a bug and should not throw, log, or warn.
- **`LanguageInfo.examples` type.** It is declared as `string[]` in `src/api.ts:303`. Do not change that declaration in this PR. If the backend eventually returns structured objects, that's a schema migration for a separate ticket (§3.2).

### 7.6 Commit guidance

Make this a single commit with message:

```
chore(mcp): remove react_usage from get_language_info; surface examples
```

Do **not** push. Do **not** amend prior commits. Do **not** include any other changes (stray formatting, unrelated refactors) in this commit.

### 7.7 Local verification recipe

After `npm run build`:

```bash
# There is no test suite in this repo; rely on the checks below.

# 1. Residue check
grep -nE "react_usage|getReactUsage|reactUsage|reactComponent" src/tools.ts
#    expected: no output

# 2. Return shape check (read the compiled file)
grep -nA 10 "handleGetLanguageInfo" dist/tools.js | head -40
#    expected: no react_usage key, examples key present

# 3. (Optional) Boot the server and exercise the tool end-to-end if
#    GC_API_KEY_SECRET is available in the environment.
```

If any of 7.4's three criteria fail, do not commit. Fix and re-verify.
