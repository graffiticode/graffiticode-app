Awesome—here’s a tight, actionable **To-Do list for your first 100 L0166 training examples**, mapped to your spec. It uses the Phase-1 mix we aligned on:

* **70 Full Programs (FP01–FP70)** – compilable, single-intent each
* **20 Fragments (FR01–FR20)** – atomic idioms for retrieval
* **5 Spec Chunks (SPEC01–SPEC05)** – short rule docs for RAG grounding
* **5 Negatives (ERR01–ERR05)** – structured error cases

Use these as slots/checklist items; fill in titles/instructions and vary letters/values (A/C/D, 100/150/200/500) to increase lexical diversity.

---

## Full Programs (70)

### A. Column styling & layout (width / align) — 18

* [x] **FP01**: Set column `"A"` `width 100`
* [x] **FP02**: Set column `"A"` `width 200`
* [x] **FP03**: Set column `"C"` `width 150`
* [x] **FP04**: Set column `"D"` `width 500`
* [x] **FP05**: Set column `"A"` `align "left"`
* [x] **FP06**: Set column `"A"` `align "center"`
* [x] **FP07**: Set column `"A"` `align "right"`
* [ ] **FP08**: Set column `"B"` `align "justify"` (valid per spec)
* [x] **FP09**: Columns block with two: `"A"` width 100 align "right"; `"B"` width 150 align "left"
* [x] **FP10**: Columns block with three: A 150 left; B 200 center; C 100 right
* [x] **FP11**: Update `"A"` width and `"B"` align in the same program
* [x] **FP12**: Set only `"B"` `width` with no `align`
* [x] **FP13**: Set only `"C"` `align` with no `width`
* [x] **FP14**: Wide layout: A 500 center
* [x] **FP15**: Narrow layout: C 80 right
* [x] **FP16**: Mixed: A width 200 align "left"
* [ ] **FP17**: Mixed: B width 300 align "justify"
* [x] **FP18**: Columns with trailing empty `{}` blocks (canonical form)

### B. Cell text & basic cells block — 10

* **FP19**: Single cell `"A1"` `text "Hello"`
* **FP20**: Two cells: `"A1"` "Hello", `"B1"` "World"
* **FP21**: Row of labels: A1..D1 texts (4 cells)
* **FP22**: Column of labels: A1..A4 texts (4 cells)
* **FP23**: Cell with text templating style `"{{A1}}"` literal in text
* **FP24**: Mixed numeric string `"100"` in `"B2"`
* **FP25**: Empty cell object for placeholder (valid empty attrs)
* **FP26**: Cells block with trailing commas (per your example style)
* **FP27**: Cells block with minimal braces `{}` after cells
* **FP28**: Cells referencing params placeholders in text (see params section)

### C. Assessment basics (assess / method / expected) — 14

* **FP29**: `"A1"` with `text "A1"` and `assess [method "value" expected "A1"]`
* **FP30**: `"A1"` `assess` value "10" vs `text "A1"` (as in spec snippet)
* **FP31**: `"B2"` `assess` with method "value" expected "42"
* **FP32**: Two assessed cells `"A1","A2"` with matching expected `"A1","A2"`
* **FP33**: Three assessed cells with different expected strings
* **FP34**: Assessment only on one of multiple cells
* **FP35**: Use `assess` array with both `method` & `expected` in order (method first)
* **FP36**: `assess` array with order (expected then method) — still valid
* **FP37**: Cells with `attrs.assess` object form (as in Program Example)
* **FP38**: Combine assessed cells with align on columns
* **FP39**: Combine assessed cells with width on columns
* **FP40**: Only `method "value"` (no expected) on one cell, others plain
* **FP41**: A1 assessed; B1 plain; show mixed rows
* **FP42**: Two assessed cells with different methods (if future methods exist; else keep "value")

### D. Rows block (sorting/ordering, per Program Example) — 8

* **FP43**: `rows { "*": { assess: { index: "B", order: "actual" } } }` minimal
* **FP44**: Same but `order: "expected"`
* **FP45**: Same but `order: "asc"`
* **FP46**: Same but `order: "desc"`
* **FP47**: Rows with wildcard `"*"` plus a specific row override (if supported)
* **FP48**: Rows with only index "A" (no order)
* **FP49**: Rows with only order "actual" (default index "B")
* **FP50**: Rows combined with columns and cells (balanced 2×2 grid)

### E. Columns block (multi-col configs) — 6

* **FP51**: Columns object syntax exactly as in Program Example (A/B with width/align)
* **FP52**: Columns A/B/C with varied alignments
* **FP53**: Columns A/B with only widths
* **FP54**: Columns A/B with only aligns
* **FP55**: Columns with large width values (e.g., 600)
* **FP56**: Columns with minimum reasonable width (e.g., 60)

### F. Params-driven examples — 8

* **FP57**: `params` with 4 rows of labels (A1..A4), used in `cells` via `"{{A1}}"` etc.
* **FP58**: `params` numeric ranges (e.g., `B1: "1485000..1585000:200000"`) with cells showing raw param text
* **FP59**: `params` for animals list into two cells (B1,B2)
* **FP60**: Use `params` for A1/A2 text and assessed expected from `params`
* **FP61**: `params` + `rows` sorting by B (actual)
* **FP62**: `params` + `columns` widths + aligns + 2×2 cells
* **FP63**: `params` populated labels + mixed align/width columns
* **FP64**: `params` with different step strings and mixed cell placements

### G. Mini assessments (end-to-end) — 6

* **FP65**: 2×2 assessment like Program Example (A1/A2 assessed to themselves; B1/B2 plain)
* **FP66**: Gradebook mini: names in A, scores in B; assess B cells to expected literal
* **FP67**: Balance sheet mini: Assets/Liabilities; computed expected literals (no formulas yet)
* **FP68**: Yes/No short answer: A column questions, B answers; assess B to expected from params
* **FP69**: Ordering task: multiple rows sorted by B (actual) with columns set
* **FP70**: Mixed assessment + layout: widths, aligns, assessed A1/A2, plain B1/B2, params

---

## Fragments (20) — atomic idioms (no scaffold)

* **FR01**: `column "A" width 100 {}`
* **FR02**: `column "C" width 150 {}`
* **FR03**: `column "D" width 500 {}`
* **FR04**: `column "A" align "left" {}`
* **FR05**: `column "B" align "right" {}`
* **FR06**: `column "C" align "center" {}`
* **FR07**: `column "D" align "justify" {}`
* **FR08**: `columns [ column "A" width 100 align "right" {}, column "B" width 150 align "left" {} ] {}`
* **FR09**: `cell "A1" text "Hello" {}`
* **FR10**: `cell "B1" text "World" {}`
* **FR11**: `cells [ cell "A1" text "Hello" {}, cell "B1" text "World" {} ] {}`
* **FR12**: `assess [ method "value" expected "10" ] {}`
* **FR13**: `cell "A1" text "A1" assess [ method "value" expected "A1" ] {}`
* **FR14**: `rows { "*": { assess: { index: "B", order: "actual" } } } {}`
* **FR15**: `rows { "*": { assess: { index: "B", order: "asc" } } } {}`
* **FR16**: `params { A1: "Fees earned" }`
* **FR17**: `params { B1: "100..200: 50" }`
* **FR18**: `column "A" width 200 align "center" {}`
* **FR19**: `cell "A2" text "{{A2}}" {}`
* **FR20**: `cell "B2" text "{{B2}}" {}`

*(Ensure fragment syntax matches your canonical brace/quote style.)*

---

## Spec Chunks (5) — short docs for RAG

* **SPEC01 — width**
  *“Column width sets how wide a spreadsheet column is (pixels). Syntax: column <COL> width <N>. Examples: column "A" width 200 {}, column "C" width 500 {}. Width must be a positive integer.”*
* **SPEC02 — align**
  *“Column align controls text alignment: "left", "right", "center", "justify". Example: column "A" align "center" {}. Other values are invalid.”*
* **SPEC03 — cell text**
  *“Cell text sets the display string for a cell. Syntax: cell "<A1>" text "<STRING>" {}. Example: cell "A1" text "Hello" {}.”*
* **SPEC04 — assess / method / expected**
  *“Assessment uses an array: assess [ method "value" expected "<STRING>" ]. Example: cell "A1" text "A1" assess [ method "value" expected "A1" ] {}.”*
* **SPEC05 — rows ordering**
  *“Rows can specify sorting for assessment via a wildcard rule: rows { "*": { assess: { index: "<COL>", order: "actual" | "expected" | "asc" | "desc" } } }.”*

*(Store as `embedding_text` plain text; payload can be a short summary.)*

---

## Negatives / Errors (5) — structured error outputs

* **ERR01**: Invalid column name in `column`: `column "0" width 200 {}` → `error { message: "Invalid column: 0. Use A–Z." }`
* **ERR02**: Invalid `width` value: `width -50` → `error { message: "Invalid width: -50. Must be positive integer." }`
* **ERR03**: Invalid `align` value: `align "middle"` → `error { message: "Invalid align: middle. Allowed: left, right, center, justify." }`
* **ERR04**: Malformed `assess` array (missing expected): `assess [ method "value" ]` → error message
* **ERR05**: Bad cell address: `cell "AA0" text "Oops" {}` → `error { message: "Invalid cell address: AA0." }`

*(Keep one consistent error schema.)*

---

## Notes for building the set

* **Scaffold** every full program with your standard header/footer (title, instruction, `{ v: 1 }..`).
* **Vary** column letters/values across items to widen lexical coverage.
* **Extract fragments** automatically from the full programs (pipeline you’re building).
* **Index**: put fragments + spec chunks as primary retrieval items; keep at least 1 full program per topic as a structural anchor.
* **Tag** metadata (`topic`, `prop`, `label`, `dialect`) so you can filter/rerank.

If you want, I can turn this checklist into a **CSV/JSONL skeleton** with IDs and placeholder fields (prompt/code/metadata) so you can start filling and running it through your compiler.
