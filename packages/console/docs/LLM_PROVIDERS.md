# Code Generation Providers

Code generation runs on Anthropic Messages or OpenAI Responses behind the same
internal quality tiers:

| Tier | Anthropic | OpenAI |
| --- | --- | --- |
| `quality` | `claude-opus-5` | `gpt-5.6-sol` |
| `balanced` | `claude-sonnet-5` | `gpt-5.6-terra` |
| `fast` | `claude-haiku-4-5-20251001` | `gpt-5.6-luna` |

## Who decides

**The platform, statically. Not the caller.** Which model family serves a request
comes from an ordered per-language list in `src/lib/model-priority.ts`, set from
offline evaluation (`scripts/model-eval.ts`). The first family in the list whose
provider is available serves the request; on an availability failure the next is
tried. A language absent from the table has not been evaluated and uses
`DEFAULT_MODEL_PRIORITY` (Anthropic).

This is the same contract as head routing and composition — see
`docs/language-routing-and-composition.md`. There is deliberately **no
`provider`, `tier`, or `model` field on `CodeGenerationOptions`**, so neither an
end user nor a client agent (including MCP) can select or influence the model.
Prompt text asking for a provider is just prompt text; it cannot move cost or
routing.

Precedence, none of it client-reachable:

1. An internal/eval `model` pin — in-process TS callers only (`generateCode()`
   from the eval harness). A pin selects exactly one family and disables
   failover, so an eval measures one variable.
2. An operator env override — for canary and incident response.
3. The language's priority list, else the default.

Tier is orthogonal and also internal: it picks the model *within* whichever
family was chosen. A language's `gc:tier=` directive and the small-edit fast
downgrade both act here, and neither changes the family — an OpenAI-first
language downgrades to `gpt-5.6-luna`, not to Haiku.

## Setting a language's ordering

One line per language in `src/lib/model-priority.ts`, each citing the eval run
behind it:

```ts
export const MODEL_PRIORITY: Record<string, LlmProvider[]> = {
  "0166": ["anthropic", "openai"],  // eval 2026-07-30: finalRate .94 vs .81
};
```

Ships inert — with the table empty every language resolves to Anthropic, so
deploying the provider layer changes no behavior. Adding a line is a reviewable
data change, not a release. Do not add one before `--calibrate` shows the judge
agrees with human labels for that dialect.

## Per-mode tiers, including `get_spec`

The object form of an entry sets the tier per mode: `create`, `update`, `repair`,
`propertyUpdate`, and `spec`. Defaults are unchanged (`repair` balanced,
`propertyUpdate` and `spec` fast, create/update from the dialect's `gc:tier=`),
so an entry naming none of them behaves as before.

`spec` is the odd one: it governs `get_spec` (item → English), the inverse
direction, which calls Anthropic directly — so it takes a **tier only**, and the
family ordering does not apply to it. It lives here anyway because otherwise
there is no single place to read what model runs where; before this it resolved
`SPEC_MODEL || claude-haiku-…` inside `spec-generation-service.ts`, invisible
from the table. `SPEC_MODEL` still overrides everything, as the no-deploy hatch.

```ts
// Tier opinion without a family claim — `order` is optional.
"0177": { spec: "balanced" },  // get_spec IS the product here; the recipe is not
                               // a verbalize task and assertCoverage can't see it
```

## Runtime configuration

Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` belong in `.env.local` or the
deployment secret store. Note the dev/prod Anthropic key split described in
`CLAUDE.md`: local runs must spend the dev key, or per-item cost reporting for
production is wrong.

```env
# Force one family everywhere ("auto" = defer to the language). Incident switch.
CODEGEN_PROVIDER=auto
# Reorder a language's list to try this family first. Never removes a family, so
# an override cannot cost a language its failover.
CODEGEN_PRIMARY_PROVIDER=anthropic
# Set false to attempt only the first family in the list.
CODEGEN_FALLBACK_ENABLED=true
# Ordering for languages with no MODEL_PRIORITY entry. Default: anthropic.
# Set "anthropic,openai" to give unevaluated languages a blind fallback.
CODEGEN_DEFAULT_PRIORITY=anthropic
CODEGEN_PROVIDER_TIMEOUT_MS=180000
CODEGEN_CIRCUIT_FAILURE_THRESHOLD=2
CODEGEN_CIRCUIT_COOLDOWN_MS=30000
```

## Failover

A missing credential, timeout, network failure, provider authentication or
model-access error, rate limit, or server error restarts the **whole** generation
on the next family in the list — output from two providers is never spliced.
Invalid requests, context-limit errors, cancellations, and refusals do not fail
over; compile errors belong to the repair loop, not here.

At most **one** cross-family restart per logical call, however long the list is:
a request that has already burned a full generation on a dead provider should
surface that rather than walk the list while the caller waits. Families whose
circuit breaker is open are skipped up front, except that the last remaining
family is always attempted so an all-open list still produces a real error.

Repairs and continuations stay pinned to the family that produced the initial
program — a repair is a continuation of that output, not a fresh task.

**Unevaluated languages have no failover** under the default single-entry
ordering. That is deliberate (never silently run on an unmeasured provider) but
it means an Anthropic outage fails them; `CODEGEN_DEFAULT_PRIORITY` is the lever
if you want to trade that differently, and it needs no deploy.

## Per-language tier directives

Languages set their own tier in `instructions.md`; directives are stripped before
prompting:

```html
<!-- gc:tier=quality -->
```

The legacy `<!-- gc:model=opus -->` remains supported and maps to the `quality`
tier on whichever family is selected. `gc:provider=` is **no longer honored** —
family choice lives in `model-priority.ts` so there is one source of truth. A
stale `gc:provider=` in a dialect's instructions is ignored but still stripped,
so it never reaches the LLM.

## What is not migrated

`language-router.ts` pins Anthropic Haiku for the scope gate, re-routing, and
plan-lite classification. Those calls always spend on Anthropic regardless of a
language's priority list, so during an Anthropic outage generation can succeed on
OpenAI while the scope gate fails open — requests then land in whatever language
the client asked for. Accepted trade for now; mis-routing is the failure the
per-language contract exists to prevent, so revisit before claiming outage parity.

Cross-family failover also pays a cold prompt cache on every retry (caches are
per provider and per model).
