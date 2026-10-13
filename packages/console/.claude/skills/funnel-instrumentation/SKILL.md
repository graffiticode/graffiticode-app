---
name: funnel-instrumentation
description: Funnel event emission, the wall_hit taxonomy, and the hourly SMS digest / report page / CLI that share one aggregation path. Read before adding a lifecycle event, a new limit/wall, or touching funnel-digest, funnel-events, or scripts/funnel-report.
---

# Funnel events, walls, and the hourly digest

**The privacy contract is repeated in `CLAUDE.md` and is non-negotiable** — never log prompts, item source, or free text (only lengths); never log raw session uuids, tokens, emails, or wallet addresses; never log the client IP.

## Emission

One structured JSON line per lifecycle event to stdout → Cloud Logging via `emitEvent` (`src/lib/funnel-events.ts`), the console-side twin of `graffiticode-mcp-server/src/events.ts`, sharing its schema and privacy contract. The `session` field is the join key across all three emitters (console, mcp-service, app.graffiticode.org) — `sessionNamespace` for free-plan, `sha256(uid)` for authenticated — so "how many distinct actors" stays answerable with no identifier leaving the process.

## Wall taxonomy

A **`wall_hit`** is a request refused by a limit — the headline signal for "demand we turned away", rendered in the digest as `⛔ N walls — <breakdown by kind>`. Eight kinds:

| `wall` | Raised by | Meaning |
|---|---|---|
| `item_limit` | `buildMonthlyQuotaError` | Free-plan monthly budget spent |
| `daily_pace` | `buildDailyPaceError` | Free-plan derived daily allowance spent |
| `revision_limit` | `buildRevisionLimitError` | Item hit its revision cap |
| `language_scope` | `buildScopeError` | Language outside trial scope (carries `lang`) |
| `item_expired` | `buildItemExpiredError` | Free-plan item aged past its 48h TTL |
| `plan_item_limit` | `checkItemCreateAllowed` → `assertItemCreateAllowed` | Hard-capped plan spent its included items |
| `overage_cap` | same | Customer's own overage spend cap reached |
| `non_english_request` | GUARDRAIL 0 in `generate-for-request.ts` | Prompt not written in English (only when `NON_ENGLISH_GATE=enforce`) |

`non_english_request` is the one wall with a **separate reporting event**, and the reason generalizes: `wall_hit` carries no `app`, so `isMcpOrigin` drops it from all three surfaces (see below). It also fires only in enforce mode, which would report zero during the shadow window that exists to measure it. So the demand signal is the headline event **`non_english_request`** — emitted in both modes, carrying `blocked`, `script`/`plang`, and an `app` stamp — and the `wall_hit` exists only to keep the refusal taxonomy complete. Any future wall that needs to show up in a report has the same two problems to solve.

**Emission point differs by path, deliberately.** The five free-plan walls are emitted **inside the `FreePlanError` builders** in `free-plan-quota.ts`, because every builder is called directly inside a `throw` — the one choke point that can't drift as call sites move. The cost is that a builder has no auth context, so those walls are counted **by kind but not attributed to a session**; the digest only reports counts, so that's sufficient. The two paid walls are emitted at the gate in `resolvers.ts` instead, where `auth` *is* in scope, so they carry `session` and `lang`. When adding a free-plan limit, emit from the builder, not the call site — and note `assertItemCreateAllowed` skips its own emit on the free-plan branch precisely because `buildMonthlyQuotaError` already fired.

## Aggregation — three surfaces, ONE path

Events are aggregated hourly by `src/lib/funnel-digest.ts` and out-of-band by `scripts/mcp-funnel-report.ts` (HTML). Three surfaces share ONE aggregation path (`funnel-digest.ts`), so counting rules can't drift:

- an **hourly SMS** (Cloud Scheduler `2 8-20 * * *` PT → `src/pages/api/internal/funnel-digest.ts` → Twilio via `src/lib/alert-sms.ts`),
- a **report page** (`/r/<token>` → rewritten to `src/pages/api/r/[token].ts`; an API route, NOT a page, because `_app.tsx` wraps everything except form/editor in `AuthWrapper` and the signed link must open with no sign-in — token is an HMAC over the window + expiry, `src/lib/report-link.ts`),
- a **CLI** (`npx tsx scripts/funnel-report.ts --period day|hour|week|month`).

**Scope: MCP activity only, minus our own accounts** (2026-08-04). `fetchEvents` applies two filters at the shared reader, so all three surfaces inherit them and none can drift:

- `isMcpOrigin(e)` — an **allowlist**: the five `mcp_*` events, plus `claim`/`claim_view` (the trial claim flow exists only to convert an MCP workspace, so it's MCP activity whoever logs it), plus `item_created`/`item_updated`/`item_generation_failed` **qualified by `app === "mcp"`** (each stamps `app` from the mutation's `client` arg). An allowlist, not a denylist, because a denylist silently re-admits console traffic the next time an emitter is added — which is the exact bug this fixes. Everything else drops, including `artifact_view` (that's app.graffiticode.org, not MCP).
- `isExcludedAccount(e)` — dev/QA accounts by their `session` value, stored as **sha256(uid) hashes, never uids** (most uids here are wallet addresses; the privacy contract applies to source too). Seeded with Jeff's account and the eval harness (`EVAL_UID`). Extend without a deploy via `FUNNEL_EXCLUDE_SESSIONS` (comma-separated hashes). Can't mute a real trial: free-plan sessions are uuids and cannot collide with a hex digest.

**What that cost, deliberately:** `wall_hit`, `signup`, `plan_changed`, `checkout_started`, `api_key_created`, `overage_limit_raised` and `free_plan_budget` carry no `app` field, so they drop. The SMS's ⛔ and $ lines can no longer fire and ★ narrows to claims only. Every SMS line is `> 0`-guarded so they omit rather than print a false zero; the report page's walls/signups tiles were **removed** for the same reason — "walls 0" claims nothing was refused, which is a stronger and different statement than "not measured here".

**Bringing an excluded event back** — stamp `app` at its emitter, then add it to `SURFACE_QUALIFIED_EVENTS`. `non_english_request` did this on 2026-08-28: `generateCodeForRequest` took a new optional `client` param so the gate's event could be attributed, which was one more hop on a field `GenerationJob` already carried — **no `GENERATION_JOB_VERSION` bump**. `item_generation_failed` did it on 2026-08-05 and is the fuller worked example: it is emitted from the *queued worker* (`generate-job.ts`), not the resolver, so `client` had to be threaded onto `GenerationJob` and through `enqueueGenerationJob`. That field is **optional and did NOT bump `GENERATION_JOB_VERSION`** — adding a field is backward compatible, while a bump would 400 every job already in the queue at deploy. In-flight v1 jobs land as `"console"`, under-counting MCP failures for one deploy's worth of work rather than inventing any. Historical events stay dropped: `app` cannot be inferred retroactively. (`genFailures` is a different number — it reads `mcp_tool`'s `outcome`, was never affected, and counts *attempts* where `items.failed` counts terminal failures.)

`DAY_CACHE_VERSION` was bumped 2 → 3: cached `funnel-daily` days counted console authoring, and leaving them would draw a trend whose old bars mean something different from its new ones.

**Send policy: every firing sends**, activity or not — the schedule IS the policy, so a quiet hour reports "0 anon calls" and silence means the job is broken (this replaced an activity gate + once-a-day floor, which existed only to make silence readable).

**Anonymous vs signed-in** (`isAuthenticated`/`aggregateSplit` in `funnel-digest.ts`): the **SMS carries the anonymous segment only** — mixing our own console work into it made a busy afternoon of self-editing read as demand — while the report page renders both segments plus the split in "Today so far" and the 7-day trend (bar = total tool calls, solid fill = anon share). An event is authenticated iff `auth === "firebase"` or `authed === true` (artifact_view from app.graffiticode.org speaks the latter); everything unmarked (claim, claim_view) counts anonymous, so `anon + authed == total` exactly and no third bucket exists.

State: `alert-state/digest` (cursor), `alert-state/seen` (novelty), `funnel-daily/{date}` (cached completed days, `v`-stamped — a shape change invalidates rather than back-fills zeros). GCP REST is called directly with a metadata-server token (`src/lib/gcp-token.ts`) for the reason on `generation-queue.ts` — no `@google-cloud/*` SDKs.

## Four rules that keep getting re-learned

1. Emit at *our* state change, not the upstream trigger (`plan_changed` fires at the `users/{uid}` plan write, collapsing one upgrade's four Stripe webhooks into one event — never add per-webhook emitters).
2. Attribute from every event carrying the field, not just the "start" event (`mcp_session_started` fires once per session, so client attribution must also read `mcp_tool`).
3. Allowlist rather than infer (language "attempts" count `create_item`/`update_item` only — `get_language_info` also takes a `language` arg).
4. Novelty is only meaningful against persisted state (the report page and CLI aggregate with a throwaway `seen` set so they can't consume the SMS's flags, and therefore must not render novelty).
