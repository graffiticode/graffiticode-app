# Judge calibration labels

Hand-labeled ground truth for calibrating the LLM-as-judge (`src/lib/judge-service.ts`) before its
scores are trusted. An LLM judge is only as good as its agreement with humans — run calibration and
record the number before wiring any inline gate/selector or believing aggregate judge numbers.

## Format

`data/model-eval/labels/<lang>.json` — a JSON array of labeled candidates:

```json
[
  {
    "id": "invoice-tax-discount",
    "code": "<the generated Graffiticode program to judge>",
    "overall": 4,
    "correctness": 4,
    "instructionFollowing": 5,
    "idiomaticity": 4
  }
]
```

- `id` matches a case in `data/model-eval/<lang>.json` (the prompt/intent is pulled from there;
  or set `prompt` on the label to override).
- `code` is the candidate program a human scored (paste a real generation, e.g. from a
  `model-eval.json` run's `runs[].code`).
- `overall` is the human 1–5 score used for agreement. The per-dimension scores are optional.
- Rows with `overall: null` or no `code` are skipped — fine as templates.

Aim for ~10 labeled candidates to start (the existing eval sets are 0166: 6 cases, 0158: 4 cases —
label one generation each, or a mix of good and bad ones to spread the score range).

## Scoring anchors (be discriminating)

Compile/render is **saturated** (~100%) — it is table stakes, not quality. So "it works" earns a
**2, not a free 3**; otherwise the usable scale collapses to 3–5 and every candidate starts
"above average" — the exact generosity the judge already shows. Anchor `overall` to **intent
satisfaction and correctness**, not to whether it runs. Correctness dominates: a clean sheet that
computes the wrong tax is a 2, never a 4.

For dialects with a convergence loop (`--converge`), the compiler's own warnings are already
resolved before you ever see the candidate, so *warning-free* is likewise table stakes — it is part
of reaching a 3, not evidence of a 4.

> **Canonical source:** the tables below are a copy for reading convenience. The anchors live in
> `src/lib/judge-service.ts` (`overallAnchors(lang)`), which is what the judge scores against and
> what `gen-label-worksheet.ts` renders. Edit them there — `--calibrate` compares judge to human, so
> a drifted copy would show up as judge error rather than as the scale mismatch it actually is.

### The backbone (1–3) — identical in every dialect

| overall | meaning |
|---|---|
| **1** | Doesn't work — no render, a stub that authored nothing, or the wrong artifact entirely. |
| **2** | Works but **wrong or incomplete** — misses the core ask, a requirement is absent, or the central logic/key is wrong. |
| **3** | **Correct and complete** — every stated requirement met. Nothing a compiler could object to. |

**3 is the default for anything that compiles clean.** It is the ceiling of what the objective
columns can verify and the floor of what is worth shipping. Getting to 3 is not an achievement worth
a 4.

### The soft band (4–5) — per dialect

Above correct-and-complete, every dialect asks the same two questions: **4 — will it still be right
when the request changes slightly?** and **5 — would you hand it to someone learning this dialect?**
The evidence differs, so each dialect names its own. Two examples (see `DIALECT_ANCHORS`):

- **0166 (spreadsheets):** 4 = derived cells are formulas, not literals (a typed-in `30` where
  `=SUM(A1:A2)` belongs is a **3**), layout usable, formulas extend to new rows. 5 = idiomatic and
  minimal, usable as a reference example.
- **0175 (ELA items):** 4 = defensible as an assessment item — distinct plausible misconceptions per
  distractor, key requires the passage, no giveaway, catalog stem. 5 = exemplar — a pool deeper
  than the item consumes (count the targeted distractors and non-supporting sources in the source;
  `review.alternativeClaims` is NOT this — it counts other supported claims and reads 0 on a
  well-formed item),
  Part B discriminates alone, options matched in register.

**How to award 4 and 5** is dialect-independent and lives in `SOFT_BAND_DISCIPLINE`
(`src/lib/judge-service.ts`), rendered into every worksheet and into the judge prompt. In short: 4 is
judgment where the request was silent; 5 is headroom, not the absence of faults; presence of
something the request asked for is 3, not 4; a 4 must be pointable at a specific authored thing; and
a band the compiler could check is not a band — convergence already forced it to 3. Read the rules
in the worksheet rather than copying them here, so there is no drift to keep in sync.

**A dialect with few soft qualities SHOULD cluster at 3.** That is a finding — model choice barely
matters there — not a gap to fill. Inventing a 4/5 distinction to keep ρ computable measures the
rubric instead of the model, and a dialect whose outputs all sit at 3 doesn't need a calibrated
judge, because there is nothing for the judge to discriminate.

Two rules of thumb:
- **1 doesn't work · 2 wrong/incomplete · 3 correct and complete · 4–5 soft qualities.**
- **Label stricter than the judge, and spread the range.** The human labels are the antidote to a
  generous judge — if you also anchor high, calibration can't detect the inflation (low MAE / stable
  ρ hide it). Compare the candidates *within* a case before assigning absolute scores: comparative
  judgment is more reliable on close items and preserves the rank variance ρ needs.

### Anchor versions

Each dialect's anchors carry a `version`, and `pull-eval-labels` stamps it onto every row it scores
as `anchorVersion`. **Bump it whenever a band's meaning changes** — `--calibrate` skips rows scored
under a stale version and says so, rather than comparing a judge on today's anchors to a human on
yesterday's and reporting the difference as judge error. Version 2 (2026-08-09) introduced the
shared backbone and per-dialect soft band; the 0166 and 0176 scores from version 1 were cleared and
need rescoring.

## Run

```bash
npx tsx scripts/model-eval.ts --lang 0166 0158 --calibrate
```

Reports `exact` (rounded-overall match), `within±1`, `MAE`, and Spearman `ρ` of judge-vs-human on
`overall`. Treat these as the trust gate — a judge that disagrees with humans is not a usable metric.
See `*.example.json` here for a starting template.
