# Plan: Language instructions.md Updates for Out-of-Scope Detection

## Context

Out-of-scope detection depends on the model knowing what each dialect CAN do. This knowledge comes from the dialect-specific `instructions.md` served at `https://api.graffiticode.org/L{id}/instructions.md`. Currently, only **L0166** and **L0169** have dialect-specific instructions. All other languages fall back to the generic core Graffiticode instructions, which describe syntax but not domain capabilities. Without dialect-specific instructions, the model cannot reliably judge what's in or out of scope.

## Current State

| Language | instructions.md | Status |
|----------|----------------|--------|
| L0166 (Spreadsheets) | Dialect-specific: describes spreadsheet functions, cells, formulas, formatting, validation | **Ready** |
| L0169 (Concept webs) | Dialect-specific: describes anchor/connections/edges/concepts/relations | **Ready** |
| L0159 (Flashcards/Match/Memory) | Generic core only | **Needs dialect instructions** |
| L0170 (Data transformations) | Generic core only | **Needs dialect instructions** |
| L0158 (Learnosity integrations) | Generic core only | **Needs dialect instructions** |
| L0161 (Expression translators) | Generic core only | **Needs dialect instructions** |
| L0151 (Spreadsheet questions) | Generic core only | **Needs dialect instructions** |
| L0152 (Interactive maps) | Generic core only | **Needs dialect instructions** |
| L0153 (Area model questions) | Generic core only | **Needs dialect instructions** |
| L0154 (Magic square questions) | Generic core only | **Needs dialect instructions** |
| L0156 (Short text scorers) | Generic core only | **Needs dialect instructions** |
| L0157 (Geoboard manipulatives) | Generic core only | **Needs dialect instructions** |
| L0137 (Data transformers) | Generic core only | **Needs dialect instructions** |
| L0002 (Simple programs) | Generic core only | Low priority — general purpose |
| L0011 (Property editors) | Generic core only | Low priority — general purpose |
| L0163 (Code editors) | Generic core only | Low priority |
| L0155 (Stoplight questions) | 404 Not Found | **Needs instructions.md created** |
| L0160 (Learnosity QTI) | 404 Not Found | **Needs instructions.md created** |
| L0162 (Walking routes) | 404 Not Found | **Needs instructions.md created** |
| L0164 (Code generators) | 404 Not Found | **Needs instructions.md created** |

## What Each instructions.md Needs

Each dialect instructions.md should follow this pattern (modeled on L0166 and L0169):

1. **Opening line** — One sentence stating what this dialect does:
   > `This dialect is used for generating [domain description].`
   This is the single most important line for out-of-scope detection. It tells the model the dialect's purpose so it can judge whether a request fits.

2. **Domain-specific response requirements** — What the output should always look like:
   > `Whatever the user request is, the response should always be a complete [thing] with [required elements].`

3. **Program structure** — A template showing the dialect's skeleton code with its specific functions.

4. **Available functions** — Complete list of dialect-specific functions with arity, description, and usage. This is critical — the model uses this list to determine what's achievable.

5. **Example patterns** — 1-2 complete working programs showing typical usage.

## Specific Content Needed Per Dialect

**L0159 (Flashcards, Match and Memory card games)**
- Opening: "This dialect is used for generating flashcard decks and interactive card games (match, memory)."
- Functions: `flashcards`, `match`, `memory`, `facts`, `title`, `instructions`, `fact`, `term`, `definition`, `image`
- Key capability: Card-based learning activities with text and LaTeX math support

**L0170 (Data transformations)**
- Opening: "This dialect is used for building data transformation pipelines that fetch, filter, and reshape data."
- Functions: `fetch`, `get`, `filter`, `select`, `mutate`, `group`, `sort`, `summarize`, `join`, `pivot`
- Key capability: ETL-style data pipelines, URL fetching, JSON transformation

**L0158 (Learnosity integrations)**
- Opening: "This dialect is used for generating Learnosity assessment items."
- Functions: `items`, `questions`, `mcq`, `shorttext`, `clozetext`, `set-var`, etc.
- Key capability: Learnosity API item construction
- Note: Must always start with `set-var "lrn-id"`

**L0161 (Expression translators)**
- Opening: "This dialect is used for building math expression translation and equivalence rules."
- Functions: `words`, `rules`, `types`, `tests`, `translate`, `equiv`
- Key capability: Defining how mathematical expressions translate between notations

**L0151 (Spreadsheet questions)**
- Opening: "This dialect is used for generating interactive spreadsheet-based questions."
- Functions: `table`, `params`, `cells`, `rows`, `columns`
- Note: Similar to L0166 but focused on question/assessment framing

**L0152 (Interactive map questions)**
- Opening: "This dialect is used for generating interactive map-based geography questions."
- Functions: `map`, `projection`, `rotate`, `center`, `problem`

**L0153 (Area model questions)**
- Opening: "This dialect is used for generating area model multiplication questions."
- Functions: `areaModel`, `rows`, `cols`, `expression`, `problemStatement`

**L0154 (Magic square questions)**
- Opening: "This dialect is used for generating magic square puzzle questions."
- Functions: `magicSquare`, `problemStatement`, `expression`, `initializeGrid`

**L0156 (Short text scorers)**
- Opening: "This dialect is used for configuring AI-powered short text scoring rubrics."
- Functions: `model`, `rubric`, `passage`, `prompt`, `score`

**L0157 (Geoboard manipulatives)**
- Opening: "This dialect is used for generating interactive geoboard geometry activities."
- Functions: `geoboard` and related geometry functions

**L0137 (Data transformers)**
- Opening: "This dialect is used for building data processing pipelines with fetch, sort, and encode operations."
- Functions: `fetch`, `sort`, `encode`, `shape`, `flatten`, `query`

## Priority Order

1. **High priority** (most likely to receive out-of-scope requests via MCP): L0159, L0170, L0158
2. **Medium priority** (used in education content): L0151, L0152, L0153, L0154, L0161
3. **Lower priority**: L0156, L0157, L0137, L0155, L0160, L0162, L0163, L0164

## Important: Positive Scope Only

Per the design principles, each instructions.md describes ONLY what the dialect CAN do. Do NOT add "this dialect cannot do X" or cross-references to other languages. The out-of-scope detection instruction in the system prompt handles the rejection; the language router (Haiku call) handles suggesting alternatives. The instructions.md just needs to clearly define the positive scope so the model can make the judgment.

## Where instructions.md Files Live

Each language has its own repo at `graffiticode/l{id}`. The instructions file is at:
```
packages/api/spec/instructions.md
```
It gets served by the language server at `api.graffiticode.org/L{id}/instructions.md` after deploy.
