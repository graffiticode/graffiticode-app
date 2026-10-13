# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## User Preferences

- Prefer concise versions
- Use concise commit comments
- Don't automatically commit changes

## Quick Reference

```bash
npm run dev           # Local development server
npm run lint          # ESLint (gate)
npm run typecheck     # TypeScript check (gate)
npm run lint:fix      # Auto-fix lint issues
npm run refresh       # Pull local .tgz from sibling l0002/l0011 repos
```

Node ≥18.17.0 required.

## Commands

There is no unit-test runner (no `npm test`); `test:streaming` is a manual `tsx` script. The real gate is: `npm run lint` and `npm run typecheck` must pass.

**Any change to the code generator also runs the corpus ping** — `llm-generation-service.ts`, `code-generation-service.ts`, `code-generation/`, `model-priority.ts`, `llm-models.ts`, dialect instructions, **and env-var changes to the console service**.

```bash
curl 'https://console.graffiticode.org/api/internal/corpus-ping?dry=1'             # the whole set, ~50s
curl 'https://console.graffiticode.org/api/internal/corpus-ping?dry=1&langs=0176'  # while iterating
```

`?dry=1` sends no SMS, writes no run log, skips auth. It costs one real generation per **turn** per language in `PING_LANGUAGES` (`src/lib/corpus-ping.ts`) — 12 languages as of 2026-09-30 (0184 replaced 0173, which is deprecated), and that list moves, so read it rather than trusting a number written here. Narrow with `&langs=` while iterating, but run the full set before calling it done.

**A corpus example can be a conversation, and the ping replays it as one.** Turns come from the corpus doc's `messages` field — never from splitting `prompt` on blank lines, which would invent turns inside a passage-bearing L0175 request — and each later turn is an edit carrying the previous turn's source AND its compiled data model, under the same `itemId` (L0182 writes that id as `session-id`, and the session is what brings back the version this taker was shown). Every turn compiles, not just the last. Why it matters: 44 of L0182's 50 rows are two-turn (take a survey, then answer it), and replaying the joined text as a single create produced only the taking — which compiles, so the ping stayed green while the answering half, where every failure lives, was never exercised.

Why lint+typecheck isn't sufficient: 2026-09-01, `CODEGEN_EFFORT=low` was set with `gcloud run services update`. `output_config.effort` is Claude 5 / Opus 4.6–4.8 only, L0176 is the one language pinned to `anthropic+fast` (→ Haiku 4.5), and every L0176 generation 400'd for 27 hours. It was in no file, so there was no diff and nothing to typecheck. A config change is a code change, and `model-priority.ts` gives languages different models — a global knob can be fine on 10 of 11 and fatal on the 11th.

Ping, not sweep: the ping is the daily liveness check above. `npm run corpus-sweep` is weekly, ~110 generations, and compares output *shape* — for changes that could move quality (retuning a model, tier, or prompt).

Neither one licenses a **`MODEL_PRIORITY` change**. That comes from `npm run eval` (`scripts/model-eval.ts`), which varies one axis — today the model, with `options.model` pinned and one RAG retrieval shared by every variant — and reports first-pass compile, drift, warnings, agreement, latency and cost. Two rules it enforces that are easy to skip by hand: eval cases **must not be in the RAG corpus** (`npm run eval:holdout`; the gate fails the run before any spend, `--allow-leak` downgrades it to a warning), and a cross-family ordering needs `--panel` — one judge per family, reporting self-preference — before a `MODEL_PRIORITY` line is committed, because a single Claude judge ranking Claude against GPT is grading its own family. For a dialect whose compile rate is already saturated, `--converge N` is the metric that separates variants (the item reached after feeding the compiler's warnings back, and what that iteration cost). Case + label helpers: `eval:cases`, `eval:label-*`, `eval:calibrate`.

**Eval commands:**
```bash
npm run eval              # Full model evaluation (requires --panel for cross-family)
npm run eval:holdout      # Check cases aren't in RAG corpus (run first!)
npm run eval:calibrate    # Calibrate judge
npm run eval:cases        # Generate eval cases from MCP sessions
npm run eval:judge-smoke  # Quick judge sanity check before big runs
```

## Deploy

**Deploys are always manual.** GitHub is never used to deploy: no workflow or push trigger ships anything, so pushing to `main` deploys nothing. Run the commands below by hand, after the lint/typecheck gate. (GitHub checks that only validate are fine: `.github/workflows/npm-ci.yaml` runs lint on push.)

```bash
npm run gcp:build     # Cloud Build → gcr.io/graffiticode-app/console:<sha> → deploy `console` (us-central1)
npm run gcp:restart   # redeploy :latest, no rebuild
npm run gcp:logs      # last 100 requests;  gcp:logs:tail for live
```

Most of the service's environment is set **out-of-band on the Cloud Run service**, not in `cloudbuild.yaml`: ANTHROPIC/OPENAI, Stripe, DSPY, OTEL, and the Secret Manager mounts (`INTERNAL_JOB_SECRET`, `FREE_PLAN_*`). So any `gcloud run deploy/update` must use **`--update-env-vars` (additive)** — `--set-env-vars` wipes everything not listed and takes the generator down. The same asymmetry is why an env-var change is a code change (see the `CODEGEN_EFFORT` story above): it has no diff, so the corpus ping is the only thing that catches it.

## Architecture

Next.js 15 + React 18 app with GraphQL API, Claude AI code generation, and Firestore.

**Code generation flow:**
Request → **scope-gate head routing** → **permission-governed composition** → per-stage code gen (RAG vector search → Claude streaming → Graffiticode API verification → error correction) → post-parse binding repair.

**Server-authoritative routing & composition** (see `docs/language-routing-and-composition.md` for the full per-language contract). The platform — not the client — decides which language a request lands in and how (if at all) it composes; a client's chosen `language` is a hint. Two independent server decisions in the `generateCode` resolver (`src/pages/api/resolvers.ts`):
- **Head routing** — `classifyAndRoute` (`src/lib/language-router.ts`, cheap Haiku) validates a fresh request against the target language's `scope.json` (`in_scope`/`out_of_scope`) and **re-routes to the correct language** if the client picked wrong (e.g. an ELA request sent to the spreadsheet dialect → re-routed to the ELA dialect). Fresh creates only (never relabels an edit); fail-open + logged (`[routing] … scope-gate …`/`preflight.reroute`). Flag: `SCOPE_GATE_ENABLED` (default on).
- **Composition** — **reactive, and opted into by a language's own `instructions.md`.** Nothing decides to compose before generation: the head generates atomically, and if the program it wrote emits `data use "<lang>"`, that binding *is* the request to compose. `composesWith` on the `LANGUAGES` entry (`src/lib/languages.ts`) is the hard fence — a **permission, not a trigger** (`composesWithFor`/`fenceComposition`); an unpermitted binding is refused. Live edges: `L0176:["0179","0183"]` (a Learnosity item embeds a spreadsheet or concept-web widget), `L0184:["0185"]` (a chart's dataset reads data L0185 fetched from a URL) and `L0000:["0000"]` (internal self-composition test of the `data use` path); every other language is atomic. Each upstream is generated with the already-written head in its prompt (`downstreamContext`, `<DOWNSTREAM_CONSUMER>`), so the fields it produces are the ones the head reads. Bindings already present in an item's source are grandfathered at edit time, so withdrawing an edge never strands live content. If an upstream fails, the head is regenerated ONCE standalone with a directive to author inline — the user never sees an upstream's `OUT_OF_SCOPE:` refusal for a language they didn't name. Flag: `COMPOSITION_ENABLED`.

  The pre-flight LLM planner (`planSequence`/`planComposition`/the L0010 planning-RAG corpus) was deleted 2026-09-09. It ran on every fresh create whose head declared an edge and guessed from catalog blurbs before any code existed; a request to L0173 for a bar chart came back as "L0170 is a data-transformation dialect … it has no charting capabilities". L0010 stays registered and keeps compiling — it is simply never called. See `docs/language-routing-and-composition.md` §4 for the permission/trigger split.

**Cross-language content (`get_spec` round-trip):** moving an item's content into another language is a client-orchestrated round-trip — author the content in its specialist dialect → `get_spec(item_id)` (platform-neutral English spec, `src/lib/spec-generation-service.ts`) → `create_item(host_language, spec + intent)`. The server then decides **embed** (inner lang ∈ host's `composesWith` → live widget `+`-chain) vs **native reformat** (host re-authors from the spec). The agent never wires pipelines or names upstreams; `create_item` stays referentially transparent. Agent guidance lives in `graffiticode-skills/assessments/SKILL.md` ("two parts of the whole").

**Per-language Opus opt-in:** code generation defaults to Sonnet (`CLAUDE_MODELS.DEFAULT`), with Haiku for small property-only edits. A language whose generation is more subtle can opt its **initial** generation into Opus by placing `<!-- gc:model=opus -->` anywhere in its `instructions.md` (served by its l0NNN service). The directive is parsed + stripped during the instructions fetch in `src/lib/code-generation-service.ts` (`dialectOptsIntoOpus`), so it never reaches the LLM. Only the initial generation uses Opus; the error-correction/fix pass and all non-opted languages stay on the current Sonnet/Haiku scheme. An explicit caller `options.model` still overrides everything.

**`get_spec` model (`spec` mode):** spec generation is the inverse direction and has its own tier, read from the same `MODEL_PRIORITY` table (`src/lib/model-priority.ts`) as code-gen routing — `{ spec: <tier> }` on a language's entry, defaulting to **fast/Haiku**. Tier only: spec-gen calls the Anthropic Messages API directly, so family orderings don't reach it. Raise it for a dialect whose spec-directive asks for something other than verbalize-the-content (L0177's recipe: `{ spec: "balanced" }`), since `assertCoverage` only checks that source strings survive and cannot see a wrong recipe. `SPEC_MODEL` overrides everything as the no-deploy hatch.

**Async generation (Cloud Tasks → `/api/generate-job`):** the MCP-facing `startCodeGeneration` mutation enqueues a job (`src/lib/generation-queue.ts`) and returns immediately; Cloud Tasks holds the worker request open for the full 60-110s generation and clients poll `get_item` for `generationStatus`. Three couplings that are invisible from any single file:
- The worker URL must be the service's **own Cloud Run origin**, never the Cloudflare-proxied `console.graffiticode.org` — the proxy cuts the connection at ~100s and returns 524, which Cloud Tasks reads as a failed attempt and re-dispatches, so every slow generation ran up to `maxAttempts` **concurrent** full LLM runs (observed 2026-08-28). Dispatch deadline and Cloud Run timeout are both 900s.
- The MCP server's worker-died guard (`GENERATION_STALE_MS` in `graffiticode-mcp-server/src/tools.ts`) must stay **above** that 900s ceiling, or it reports a still-running generation as failed. Move the two together.
- The payload is versioned (`GENERATION_JOB_VERSION`): a task already queued was serialized by the previous revision, so renaming or removing a field silently loses it in flight — bump and branch in the worker. Adding an optional field is backward compatible and must **not** bump (a bump 400s every in-flight job). No model-selection fields travel in the payload, so a queued task can never pin an unreviewed model.

**Authentication:** Ethereum wallet sign-in (SIWE) is primary; email magic-link via Privy derives an embedded wallet that signs the same SIWE nonce, so **the wallet must be reused, never re-created** (a fresh one changes the uid). Google OAuth is account-linking only, never a sign-in method. Server-side `authenticate()` accepts a Firebase ID token OR an api key, but **api.graffiticode.org accepts only Firebase ID tokens** — convert via `getCredentialsForApiKey` before forwarding. Details: skill `auth-and-signin`.

**Free-plan tier (no-signin via MCP):** anonymous MCP sessions authenticated by `X-Free-Plan-Session`, metered in **items** (not dollars or compiles), items tagged `freePlan`/`sessionNamespace`/`expiresAt` (48h TTL). `sessionNamespace` means **workspace**, not "the session that created this" — a mutation on an existing item adopts its workspace. Browser console UI always requires real sign-in. Language scope (`freePlan?` in `src/lib/languages.ts`) ships inert. Details: skill `free-plan-and-claim`; runbook `docs/free-plan-attested-sessions.md`.

**Trial-claim flow (`/claim?token=<jwt>`) and the connect step:** the **console** — not the MCP server — mints the claim JWT, because only the console knows the effective (post-adoption) workspace. `claimFreePlanSession(token)` copies the namespace's items into the signed-in user's collection; claiming **copies rather than moves**, so `/claim` must then walk the user through connecting their agent or it keeps editing the anonymous originals. Details: skill `free-plan-and-claim`.

**Funnel events + walls (`src/lib/funnel-events.ts`):** one structured JSON line per lifecycle event to stdout → Cloud Logging; console-side twin of `graffiticode-mcp-server/src/events.ts`. `session` is the join key across all emitters. A **`wall_hit`** is a request refused by a limit (eight kinds) — free-plan walls emit from inside the `FreePlanError` builders, paid walls from the gate in `resolvers.ts`. Aggregated by ONE path (`src/lib/funnel-digest.ts`) feeding three surfaces: hourly SMS, signed `/r/<token>` report page, and `scripts/funnel-report.ts`. Details: skill `funnel-instrumentation`.

**English-only requests (`NON_ENGLISH_GATE`):** the generation stack is English end to end, and a non-English prompt degrades it *silently* — retrieval's keyword half is substring matching over an all-English corpus, so a Cyrillic query zeroes 30% of the ranking signal and empty retrieval is not an error. GUARDRAIL 0 in `generate-for-request.ts` classifies the request (`src/lib/prompt-language.ts`, deterministic, no LLM) and refuses it with an actionable message. It runs on **creates and updates** (unlike the `!currentSrc`-gated scope gate) and is fed `extractSearchQuery(prompt)` so it judges the latest turn — the same text RAG embeds. Only the **instruction** must be English; non-English **content** inside an item is supported and deliberately still passes. `shadow` (default) measures without refusing, `enforce` refuses, `off` disables. Demand is reported as the `non_english_request` funnel event, not the wall — skill `funnel-instrumentation`.

**Privacy contract (applies to every emitter, no exceptions):** never log prompts, item source, or free text (only lengths); never log raw session uuids, tokens, emails, or wallet addresses; never log the client IP.

**Item `app` tag:** items are tagged with the source surface (`'console'`, `'mcp'`, `'front'`) at write time. The `/items` page filters by this tag — switch via the App selector chip in the header. MCP-created items default to `app: 'mcp'` and are invisible in the default Console view; switch to MCP to see them.

**Item version history (`users/{uid}/versions`):** every content state of an item is recorded as a flat, append-only, **pointer-only** doc `{itemId}__{taskId}` via `recordVersion()`; writes are create-if-absent, never set/merge (merging would overwrite a version's original `createdAt`/`source`). Read via the `taskVersions` query, which backs `/tasks`. History does **not** cross accounts: share/claim start at v1. Details: skill `item-version-history`.

**`/api/compile` proxy:** browser-side compile (`src/utils/swr/fetchers.ts compile()`) goes through a Next.js API route proxy at `src/pages/api/compile.ts` rather than calling api.graffiticode.org directly. The proxy handles api-key → ID-token exchange so the browser never needs to hold a Firebase ID token for downstream calls (and free-plan callers don't need to expose FREE_PLAN_API_KEY).

**Item-based pricing & metering:** billing meters **successful items created per month** — iteration, reads, and compiles are free. `src/lib/plans-config.ts` (`PLANS`) is the single source of truth for tiers, allowances, overage rates, and Stripe price-id mappings; **never hardcode any of them** (that duplication was already removed once). Counting happens in `recordBillableItem()`, gating in `checkItemCreateAllowed()`. **Bronze (`demo`, ex-"Free") is a two-state tier:** hard-capped at 25 items until the customer enrolls in pay-as-you-go, then metered at $0.40/item up to a spend cap ($10 / 25 items by default; on Bronze it can be changed but never removed). Payment details are captured at exactly two moments — the 25-item wall and setting a cap — never at signup. Branch on `isHardCappedFor(plan, subscription)`, never bare `isHardCapped(plan)`. Details: skill `item-pricing`; full reference `docs/item-based-pricing.md`.

## Documentation

| Topic | File |
|-------|------|
| Language routing & composition | `docs/language-routing-and-composition.md` |
| Item-based pricing | `docs/item-based-pricing.md` |
| Free-plan sessions | `docs/free-plan-attested-sessions.md` |
| Secret encryption (retired) | `docs/secret-encryption.md` |
| RAG setup | `docs/RAG_SETUP.md` |
| LLM providers | `docs/LLM_PROVIDERS.md` |
| Streaming API | `docs/STREAMING_API.md` |
| Language authoring (new dialects) | `docs/language-style-typed-chains.md` |
| Language authoring (attribute-list dialects) | `docs/language-authoring-style.md` |

## Code Style

- PascalCase for components (`NewAPIKeyDialog.tsx`), camelCase for functions/variables
- Page files lowercase (`items.tsx`)

## Scripts

Admin scripts in `scripts/` use **two separate projects**: graffiticode (API data), through the operator's application-default credentials (`gcloud auth application-default login`; no key file, and `GRAFFITICODE_CREDENTIALS` is no longer read), and graffiticode-app (console data), through `GRAFFITICODE_APP_CREDENTIALS`. Catalog, flags, and per-script operational caveats: skill `admin-scripts`.

**Secrets & credentials:** stored account credentials and `get-val-private` encryption are **retired** (capability spec SECRET-01). Parse supplies only `itemId`; `get-val-private` bakes `""`; the console holds no `GRAFFITICODE_SECRET_KEY`. External APIs go through a connection. Do not reintroduce credentials into parse callbacks, task ASTs or compiler config. History: `docs/secret-encryption.md`.

**Eval account (`EVAL_UID` / `EVAL_API_KEY`):** **all** eval-related content lives under this dedicated account — corpus items, the RAG corpus (`training_examples` vector collection), model evals, sweeps, and provenance backfills. The account is defined in `.env.local` as `EVAL_UID=2c9d72e315fbafb128011bc32739666c7e6e7eb9`.

**RAG corpus pipeline:** corpus items → `generate-embeddings-from-examples.ts` → `training_examples` (with embeddings).

**All corpus and eval scripts must use the eval account.** Those that take `GC_API_KEY_SECRET` must be run with `GC_API_KEY_SECRET=$EVAL_API_KEY`:
- `create-items-from-prompts.ts` — creates corpus items from `examples.md`
- `backfill-corpus-provenance.ts` — adds provenance to existing corpus
- `corpus-sweep.ts` — weekly quality check

The rest pick the eval account themselves: `generate-embeddings-from-examples.ts` (builds `training_examples` from `mark=1` corpus items; defaults to `EVAL_UID`) and `model-eval.ts` (reads `EVAL_API_KEY`).

**RAG corpus filtering:** only items with `mark=1` are included in the RAG corpus.

Corpus items live in `users/{EVAL_UID}/items`; personal accounts should never hold corpus or eval data.

## Local Development

1. Configure `.env.local` with API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, Firebase config, etc.)
2. `npm run dev`
3. Run Graffiticode API/auth servers separately (see graffiticode/graffiticode repo) — they run on `localhost:3100` and `localhost:4100`

**Local queue bypass:** `GENERATION_QUEUE_LOCAL=1` fires the async generation worker directly (no Cloud Tasks).

**Language package refresh:** `npm run refresh` copies `.tgz` files from sibling `../l0002` and `../l0011` directories — use when iterating on language packages locally.

**Anthropic key split — dev vs prod.** Two org API keys: `graffiticode-console` is **production only** (plain env var on the `console` Cloud Run service — do NOT put it in `.env.local`), and `graffiticode-console-dev` is what `.env.local`'s `ANTHROPIC_API_KEY` holds, so `npm run dev` spends there. Anything measuring **production** spend must read `ANTHROPIC_CONSOLE_KEY_IDS` rather than resolving `ANTHROPIC_API_KEY`. Details and traps: skill `admin-scripts`.
