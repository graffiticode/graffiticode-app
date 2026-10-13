# Refactor `code-generation-service.ts`

## Context

`src/lib/code-generation-service.ts` is **1972 lines** and has absorbed **70 commits
in six months** — every routing, telemetry, pricing, and free-plan change lands in
it. One function, `generateCode` (1100–1972, **873 lines**), carries 12 distinct
concerns. There are **no unit tests and no test runner** in the repo, so the only
gates are `npm run lint` and `npm run typecheck` (both verified green at baseline).

Mapping the file surfaced three things worth acting on beyond the size problem —
all confirmed by reading the code and the production logs, not inferred:

- **B1 — `description` / `changeSummary` have been null in production since
  2026-04-23** (commit `c514ea1`). Line 1613 strips the output to its code block,
  then line 1861 looks for `<DESCRIPTION>` / `<CHANGE_SUMMARY>` tags that only ever
  appear *after* that block. The comment on line 1859 states the intent the code
  contradicts. These are live GraphQL fields (`src/pages/api/index.ts:171`),
  consumed at `resolvers.ts:1185`/`:1277`.
- **B2 — post-processing runs twice.** `processGeneratedCode` runs at 1613 (or
  1834) and again at 1864 on its own output, applying `\\`→`\` and `\n`→newline
  twice and reformatting through the parser twice.
- **DSPy is enabled in production and 404s on every request.** Not a refactor
  item — see "Flagged separately", it needs its own decision.

The goal: split the file into `src/lib/code-generation/`, turn `generateCode` into
an explicit staged pipeline, break both import cycles, and delete accumulated dead
code — changing behavior **only** where a defect is explicitly called out.

---

## Production reality (verified, and it changes the plan)

`ENABLE_DSPY_SERVICE=true` on the deployed `console` service *and* in `.env` /
`cloudrun-env-vars.yaml`. But every call to `POST {DSPY_SERVICE_URL}/compile-prompt-spec`
returns **404** in 8–30ms (Cloud Logging, continuous through 2026-08-20), so
`compilePromptSpec` returns null and generation silently falls back to the legacy
prompt path.

Consequences that drive decisions below:
1. **The legacy path produces 100% of production programs.** So B1 affects *every*
   production generation.
2. Every generation pays a wasted HTTP round-trip to a dead service on the hot path.
3. The DSPy repair path's lost `cache_control` (see step 6) cannot fire in prod
   today, so fixing it is safe but currently inert.

**The markdown fallback in `getRelevantExamples` is also dead in production** — two
independent reasons: `*-training-examples.md` is gitignored (so it never enters the
build context), and `output: "standalone"` means the runtime image copies only
`public`, `.next/standalone`, and `.next/static` — never `training/`. It can only
fire locally, which is why it is *isolated and documented* rather than deleted
(the eval harness runs locally and may still hit it).

---

## Target layout

New directory `src/lib/code-generation/`, with `src/lib/code-generation-service.ts`
kept **permanently** as a logic-free re-export shim. The shim is not transitional:
six `scripts/*.ts` import it, and `tsconfig.json` has `"exclude": [..., "scripts/**/*"]`,
so a broken import there is invisible to both gates.

Follows the repo's only directory precedent, `src/utils/storage/` (thin `index.ts`
+ implementation siblings). `src/lib/` is otherwise entirely flat today.

| Module | Absorbs (current lines) | Key exports |
|---|---|---|
| `constants.ts` | 74, 100–102 | `VERIFY_ITEM_ID`, `DEFAULT_MAX_TOKENS` |
| `types.ts` | 1082–1098, 1113–1131 | `GenerateCodeOptions`, `GenerateCodeParams`, `VerificationResult` |
| `firestore.ts` | 118–129 (verbatim) | `getFirestoreDb` |
| `graffiticode-primer.ts` | 453–524 | `DIALECT_PROMPT_STATIC_TAIL` |
| `property-update.ts` | regex/phrase scan of 1400–1479 | `isPropertyUpdateRequest(text): boolean` |
| `dialect-assets.ts` | 78–92, 390–448 | `readDialectAssets`, `readDialectInstructions`, `readDialectGenerationPolicy` |
| `retrieval.ts` | 136–382, 1221–1290 | `extractSearchQuery`, `getRelevantExamples`, `resolveExamples` |
| `postprocess.ts` | 997–1071 | `extractSummaryTags`, `processGeneratedCode` |
| `verification.ts` | 711–857 | `verifyCode`, `verificationSucceeded` |
| `repair-prompt.ts` | 864–928 | `parseGraffiticodeErrors`, `buildErrorFeedback` |
| `routing.ts` | 1170–1204, 1455–1479 | `resolveInitialRoute`, `downgradeForPropertyUpdate` |
| `free-plan-gate.ts` | 75–77, 1136–1166 | `assertFreePlanPromptAllowed` |
| `usage-reporting.ts` | 1523–1561, 1866–1901 | `logGenerationUsage`, `recordGenerationUsage` |
| `judging.ts` | 1932–1958 | `maybeJudgeAsync` (fire-and-forget) |
| `out-of-scope.ts` | 1584–1610 | `buildOutOfScopeResult` |
| `system-prompt.ts` | 538–566 | `getSystemPromptForDialect` |
| `prompt-builder.ts` | 576–703 | `createCodeGenerationPrompt` |
| `prompt-strategy.ts` | 1297–1400 | `buildGenerationPrompt`, `tryDSPyPrompt` |
| `repair-loop.ts` | 1613–1857 | `runVerifyRepairLoop` |
| `generate-code.ts` | remainder of 1100–1972 (~180 lines) | `generateCode` |
| `index.ts` | — | explicit named barrel |

`index.ts` uses **explicit named re-exports, not `export *`** — a wildcard would leak
every internal symbol and make future renames externally observable.

Public surface that must not change: `generateCode`, `getRelevantExamples`,
`extractSearchQuery`, `readDialectInstructions`, `VERIFY_ITEM_ID`,
`DEFAULT_MAX_TOKENS`, plus the `CLAUDE_MODELS` / `modelRejectsTemperature`
pass-throughs (which stay re-exported straight from `./llm-models`).

---

## Breaking the two import cycles

**Cycle B — `language-router` ⇄ code generation.** Three edges in
(`CLAUDE_MODELS`, `extractSearchQuery`, `generateCode`), one edge out
(`findBestLanguages`, used at exactly one cold call site, the OUT_OF_SCOPE branch).

Two edges vanish structurally: `CLAUDE_MODELS` never belonged here (pure
pass-through — import it from `./llm-models`), and `extractSearchQuery` moves to
`code-generation/retrieval.ts`, which reaches nothing router-adjacent. Break the
last edge with a lazy `await import("../language-router")` **inside
`out-of-scope.ts` only**.

Rejected: passing `findBestLanguages` as a DI param (would force all 8 callers to
supply it, silently dropping OUT_OF_SCOPE suggestions for the 7 that don't — a
behavior change disguised as a refactor); a self-registration registry (works in
the resolver path but not in `scripts/model-eval.ts`, making behavior
environment-dependent in exactly the harness used to measure quality).

`tsc` does type-check `await import()`, and `language-router` is already in the
server bundle via `resolvers.ts`, so residual risk is low — but it is a cold path,
so **manually force one OUT_OF_SCOPE generation** as the acceptance test.

**Cycle A — `code-generation-service` ⇄ `pages/api/resolvers`. DONE (2026-08-21),
ahead of this series.** Pulled forward because the request-level orchestrator had to
move out of `resolvers.ts` to fix L0176+L0166 task chaining: scripts could only
import the per-stage generator, so everything they produced was silently atomic.
Landed as `src/lib/task-api.ts` (`parseCode`, `postTask`, `getData`,
`buildParseCallbacks`) plus `src/lib/user-credentials.ts` (`getSecretsForUser`,
`getPublicValuesForUser`, the two doc refs, `StoredVar`) — the credential loaders
were not in the original list but the orchestrator needs them. `resolvers.ts`
re-exports all of it. The orchestrator itself is
`src/lib/code-generation/generate-for-request.ts` (`generateCodeForRequest`), which
must NOT be re-exported from `code-generation-service.ts` or a
`code-generation/index.ts` barrel — `language-router` imports the former and the
orchestrator imports `language-router`, so either re-export rebuilds the cycle.
**Step 9 below is therefore a no-op.** Original text follows.

Extract
`parseCode`, `postTask`, `getData`, and their helper `buildParseCallbacks` into a
new `src/lib/task-api.ts`; have `resolvers.ts` import and re-export them so its
own 6 call sites and all external importers keep working with zero edits. Verified:
none of these four functions touch `db`, `taskDao`, or `templateCache`.

Risk, stated precisely: today `code-generation-service.ts:16` → `resolvers.ts` →
`utils/db` → `admin.initializeApp()` at module load. Removing that edge changes
*when* init runs. It stays safe because `code-generation-service.ts` also directly
imports `free-plan-throttle`, `free-plan-quota`, and `token-usage-service`, each of
which calls `getFirestore()` at module scope — so init still happens during the same
module's evaluation, and still strictly after `scripts/eval-env.ts` (which every
affected script imports on line 1). **This step goes last and alone.**

---

## Commit sequence

Each commit independently passes `npm run lint` + `npm run typecheck`. Risk ascends.

1. **Dead code, in place.** Delete 7 unused imports (`postApiCompile`,
   `generateEmbedding`, `createEmbeddingText`, `vectorSearch`,
   `shouldFallbackToLegacy`, `convertLegacyPromptToRendered`,
   `formatPromptSpecForLog`), `detectLanguage` (109–112, never called), and the
   never-read `languageAssetsCache.templates` field. Also delete the stale Emacs
   autosaves (`src/lib/#code-generation-service.ts#`, `#claude-stream-service.ts#`,
   `#auth.js#`, `languages.ts~`, `utils.js~`) — untracked and gitignored, so
   nothing to commit, but a stale copy of the file being refactored is an active
   grep hazard. Leave the unreachable `else` at 1840–1843 for step 6, where its
   ~160-line dedent comes free.

2. **Typed prompt payload.** Add to `llm-generation-service.ts` (next to the
   existing `SystemBlock` / `SystemPrompt = string | SystemBlock[]`):
   ```ts
   export interface ChatMessage { role: "user" | "assistant"; content: string }
   export interface GenerationPrompt { system: SystemPrompt; messages: ChatMessage[] }
   ```
   Name it `GenerationPrompt`, **not** `RenderedPrompt` — `prompt-renderer.ts:32`
   already exports a `RenderedPrompt` with a different shape (`systemPrompt: string`).

   Replace `generateCodeWithContinuation`'s `formattedPrompt?: string` param
   outright (only two call sites exist, both inside `generateCode`) and **delete its
   `JSON.parse`/catch fallback at 847–861** — the failure mode becomes
   unrepresentable. Keep the `prompt`-only branch at 862–875 verbatim.

   `createCodeGenerationPrompt` returns the object instead of
   `JSON.stringify(..., null, 2)`. This removes **all four** JSON round-trips (702,
   1397, 1628, 1849) and makes `createErrorFixPrompt` (936–984) **provably dead** —
   it was only reachable when `JSON.parse` of a string this same process produced
   via `JSON.stringify` failed. Delete it, along with its ~35-line duplicate
   Graffiticode syntax primer that could silently drift from the real one.

   One metric changes: the `promptBytes` log measured JSON syntax + 2-space indent,
   ~20–30% above the real payload. Sum block/message lengths instead and **rename
   the field to `promptChars`** so nobody compares across the change.

3. **`UsageAccumulator`.** One `add(usage, model, provider)` replaces both the
   six-field initializer (1635–1650) and the hand-summing per repair (1804–1809),
   plus both `estimateUsdCost` + `recordSpend` sites. Cost must be computed
   **per call**, not once at the end — repairs can run a different provider/model
   (`modelForProvider(providerUsed, repairTier)`), so one-shot pricing would misprice
   every repaired generation. Encode the invariants: `total_tokens` adds only
   prompt+completion — never `reasoning_tokens` (a subset of completion) and never
   the cache fields, matching today exactly, since `estimatedUnits` and the
   `total_tokens > 0` guard both depend on it. Free-plan spend becomes an
   `onSpend` constructor hook so the two sites cannot drift.

4. **Move the leaves and pure modules** into `src/lib/code-generation/`:
   `constants`, `types`, `firestore`, `graffiticode-primer`, `property-update`,
   `dialect-assets`, `retrieval`, `postprocess`, `repair-prompt`, `system-prompt`,
   `prompt-builder`, `verification`. Mechanical moves.

5. **Support modules + cycle B.** `routing`, `free-plan-gate`, `usage-reporting`,
   `judging`, `out-of-scope`. Removes the static `findBestLanguages` import.
   *Manual test: force one OUT_OF_SCOPE generation.*

6. **Stage `generateCode`** into `prompt-strategy.ts`, `repair-loop.ts`, and a
   ~180-line `generate-code.ts` orchestrator. Includes the single DSPy seam
   (`tryDSPyPrompt` returning `null` on miss, serving both generation and repair,
   and normalizing repair's system prompt to `SystemBlock[]` with `cache_control` —
   a real fix, currently inert in prod), **B2**, the `rid`→`requestId` unification
   (typing `requestId` as non-nullable makes it unrepresentable rather than merely
   fixed), and removal of the unreachable `else`.

7. **`index.ts` + shim**, then re-point `language-router.ts`,
   `spec-generation-service.ts`, and `resolvers.ts` off the shim. Shim then serves
   `scripts/` only.

8. **B1 — summary tags.** Own commit: user-visible, and it starts writing real
   descriptions. Extract from raw output (`gen.raw`), and inside the repair loop
   merge rather than replace — keep the prior non-null value when a repair yields
   null, because repair prompts never request the tags and `lastRawOutput` is
   assigned even when a fix has no code block. Without the merge, every repaired
   generation would regress to null.

9. ~~**Cycle A** — `src/lib/task-api.ts`, alone and last.~~ **Done 2026-08-21** — see
   "Breaking the two import cycles" above.

---

## Traps — preserve verbatim, do not "clean up" mid-move

- **`FreePlanError` must stay outside the `try`.** Gating currently throws before
  `try {`. If it moves inside, the catch rewrites it to a generic
  `Error("Failed to generate code for ...")`, destroying the 400 status and the
  structured payload (`signup_url`, `limit`, `length`) the MCP tool result depends
  on verbatim. Do both: keep the call before the `try`, *and* add
  `if (error instanceof FreePlanError) throw error;` as the catch's first line.
  This is the single most dangerous move in the refactor.
- **The OUT_OF_SCOPE early return keeps its distinct shape** — `errors: [...]`,
  `code: null`, no `description`/`verification`/`providerAttempts`, two-field
  `usage`. Routing it through a shared finalizer would silently normalize what
  `language-router` and the resolvers see.
- **Three route values, three meanings.** `plannedRoute` (pre-heuristic, what
  `startRequest` deliberately records) → property-update override → what actually
  ran (from `streamResult`). Make them three immutable values; conflating them
  silently changes what every RAG report means.
- **`contextPack` / `retrievedChunks` must be returned, not recomputed** — the
  repair loop captures them, and by repair time `currentCode` has become
  `generatedCode`, so recomputing builds a different pack.
- **`verifyCode` runs only when `accessToken` is truthy**; with no token
  `verification` stays null and `compilationSucceeded` defaults true. The stage
  must no-op, not throw or synthesize. Keep threading `isFreePlan` as `isPublic` —
  that is what lets the MCP widget iframe render the task.
- **`verifyCode` returns 6 structurally different shapes.** Type it permissively;
  `strict: false` / `strictNullChecks: false` means the current code depends on that
  looseness, and narrowing it cascades typecheck errors.
- **Don't modernize `getFirestoreDb`** to `utils/db`'s `getFirestore()` — the lazy
  `try { admin.firestore() } catch { initializeApp() }` shape is load-bearing
  repo-wide (`omtm.ts`, `workspace-adoption.ts`, `workspace-week.ts`,
  `scripts/eval-holdout.ts:22` all document avoiding it).
- **`no-trailing-spaces` is an eslint `error`** — copy-pasting the 72-line primer
  between files is the likeliest way to trip lint.
- **`totalCostUsd` is accumulated but never returned** in the result; don't "fix"
  that while moving.
- Keep the documented quirk that a DSPy repair turn is never appended to
  `conversationMessages`.

---

## Flagged separately — not part of this refactor

- **DSPy 404s on every production generation.** `ENABLE_DSPY_SERVICE=true` but
  `POST /compile-prompt-spec` 404s, so every request wastes a round-trip and
  silently falls back. Either fix the URL/route or set the flag to `false`. Worth
  deciding before or alongside this work — it contradicts the note in memory that
  DSPy is "disabled".
- **Out-of-scope generations leak telemetry.** The early return never calls
  `completeRequest` and never calls `recordTokenUsage`, so those generations burn
  real tokens invisible to token telemetry and leave the RAG record open.
- **Per-attempt unit gating.** `estimatedUnits` is computed once from the initial
  generation, so `MAX_UNITS_FOR_FIXES=50` gates the whole loop rather than each
  attempt — contrary to the stated intent. Strictly cost-reducing, but it changes
  which runs get repaired. Measure it.
- **Unify the two Graffiticode syntax primers.** Step 2 deletes the repair copy
  with `createErrorFixPrompt`; if any variant survives, merging texts is a *prompt*
  change and therefore an output change — gate on `npm run eval`, never fold into a
  refactor commit.

---

## Verification

No test runner exists (`npm run test:streaming` points at a file that isn't there),
so verification is the two gates plus real generations.

**Every commit:** `npm run lint && npm run typecheck` — both green at baseline.

**After step 2** (prompt payload): run one real generation end-to-end via
`npx tsx scripts/run-codegen.ts`; confirm `promptChars` appears and the program
compiles.

**After step 5** (cycle B): deliberately provoke OUT_OF_SCOPE — ask an item in a
narrow dialect for something wildly off-dialect — and confirm the suggestion list
still comes back rather than a crash from the lazy import.

**After step 6** (B2): generate for a dialect whose output contains backslashes or
escape sequences and diff the source against a pre-change generation. Bytes *should*
change (`\\` now survives instead of collapsing to `\`) — confirm the change is the
intended one and the program still compiles.

**After step 8** (B1): confirm `description` and `changeSummary` come back non-null
through the GraphQL response, and eyeball a few for length — nothing truncates them
today because nothing produces them.

**After step 9** (cycle A): run `npx tsx scripts/check-0176-answers.ts` — it
imports the shim and exercises the real pipeline, so it confirms the
`scripts/eval-env.ts` module-load-order contract still holds. `scripts/**` is
excluded from tsconfig, so this is the *only* thing that catches script breakage.

**Before merging the whole series:** `npm run eval` (or `npm run eval:holdout`)
against a language with a `MODEL_PRIORITY` entry, and compare pass rate to a
pre-refactor run. Since none of steps 1–7 or 9 should change model input, a
divergence there means an accidental prompt change.
