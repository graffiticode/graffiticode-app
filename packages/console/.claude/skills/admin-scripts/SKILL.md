---
name: admin-scripts
description: Catalog of scripts/ admin tools (credentials, cost-per-item, token-count audit, embeddings, secret propagation) and the Anthropic dev-vs-prod API key split. Read before running or modifying anything in scripts/, or when measuring AI cost.
---

# Admin scripts

Admin scripts in `scripts/` use two separate projects. The graffiticode project uses your own application-default credentials, never a service-account key file (the one it used is being retired):

```bash
gcloud auth application-default login                          # graffiticode project
# Add to ~/.zshrc
export GRAFFITICODE_APP_CREDENTIALS=~/graffiticode-app-key.json # graffiticode-app project
```

**graffiticode project** (API data):
- `npx tsx scripts/clear-compile.ts <taskId>` - Delete a compile record

**graffiticode-app project** (console data):
- `npx tsx scripts/get-app-names.ts` - List app names from items
- `npx tsx scripts/cost-per-item.ts [--period day|week|month] [--from/--to] [--by-lang] [--lang <id>] [--output f.html] [--json]` - **What producing one item costs at today's prices.** Prices *our own* recorded tokens (`ai_generation` usage docs, cache tokens included) with `MODEL_RATES` at the `--as-of` rate card (default today) — a forward-looking pricing question, not what we were billed. **Calls no provider API and needs no admin keys**, so there is no usage-report lag: a window covering today is fine. Only `GRAFFITICODE_APP_CREDENTIALS` is required. `--help` is authoritative for flags. Things to know:
  - **Like-for-like is the whole design.** Numerator and denominator come from the same population, and every filter (`--env`, `--lang`, `--exclude-lang`, `--min-items`) narrows both sides. An earlier version divided one API key's provider spend by all items and misreported cost/item by up to 4x.
  - **Harness spend is excluded by default.** The corpus ping and sweep create no item but use a constant synthetic per-language `itemId`, so counting them booked a week of pings as one giant "item". They're reported on their own line; `--include-harness` folds them back for a fully-loaded figure, never for pricing.
  - `--env prod|local|all` (default `all` — training runs are real generations producing real items). `--outcome all|success|failed` (default `all`; failures only recorded since 2026-09-03). `--min-items <n>` (default 10) drops thin languages from both sides and lists them. `--exclude-trial` divides by paid items only.
  - `--by-lang` (implies `--per-item`) breaks cost/item down by language; `--lang <id>` (repeatable; `0176`/`L0176`/`176`) scopes to a language or family. Per-item attribution joins on `itemId` (edits) and `generatedTaskId` (fresh creates, where generation precedes the item). The free-plan trial tally has no language dimension, so the paid/trial split over-counts trial under any language filter.
  - Output ends with a margin table per plan from `PLANS`.
- `npx tsx scripts/audit-token-counts.ts [--from/--to] [--as-of] [--json]` - **Are our recorded token counts complete?** The counterweight to `cost-per-item.ts`: compares token *counts* against the providers' org-wide metering, broken down by API key. Near parity = instrumentation is complete; materially low = a call path doesn't reach `recordTokenUsage`; materially high = double counting. A key driven by local scripts/evals shows as metered-but-unrecorded, which is not an app instrumentation gap. Needs `ANTHROPIC_ADMIN_KEY`; `OPENAI_ADMIN_KEY` optional (`api.usage.read` scope). Provider reports lag by hours, so the window defaults to 7 settled days and `--to` is **exclusive** (unlike `cost-per-item.ts`).
- `npx tsx scripts/generate-embeddings-from-examples.ts --lang <id>` - Build the RAG corpus (`training_examples`) from the eval account's `mark=1` items; writes a log to `training/l<id>-embeddings.json`. Upserts only — it does not delete docs for items that are no longer marked.
- `npx tsx scripts/upgrade-basis-and-deploy.ts` - Upgrade @graffiticode/basis in all language repos and deploy
  - `--lang 0158 0166` - Only upgrade specific languages
  - `--no-force` - Skip deploy if basis is already up to date
  - `--verbose` - Stream build output to terminal
- `./scripts/set-free-plan-secrets.sh` - Push `FREE_PLAN_API_KEY` and `FREE_PLAN_NAMESPACE_SALT` from `.env.local` into Secret Manager and remount on the `console` Cloud Run service. Re-running rotates (creates a new secret version) and rolls a new revision. Rotating the salt invalidates active free-plan namespaces.

## Anthropic key split — dev vs prod (set up 2026-07-28)

Two org API keys:
- **`graffiticode-console`** (`apikey_01HXtW4…`) — **production only.** Carried as a plain env var on the `console` Cloud Run service. Do NOT put it in `.env.local`.
- **`graffiticode-console-dev`** (`apikey_01N4UM…`) — local dev. This is what `.env.local`'s `ANTHROPIC_API_KEY` holds, so `npm run dev` spends here.

`.env.local` previously held the *production* key, so every local generation billed against production. Anything that must measure **production** provider spend reads `ANTHROPIC_CONSOLE_KEY_IDS=graffiticode-console` from `.env.local` rather than resolving `ANTHROPIC_API_KEY` (which now names the dev key) — today that is `fetch-daily-usage.ts`. (`cost-per-item.ts` no longer reads provider spend at all; `audit-token-counts.ts` takes the whole org and attributes per key.) Two traps worth knowing: a shell-exported `ANTHROPIC_API_KEY` **shadows `.env.local`** in every script using the guarded env loader (`if (!(key in process.env))`) — `fetch-daily-usage.ts` uses an overwriting loader and does not — and the Admin API has **no create-key endpoint**, so minting a key is Console-only (rename/disable are scriptable via `POST /v1/organizations/api_keys/{id}`).

## Deploy config

`cloudrun-env-vars.yaml` is **dead** — nothing references it and its `ANTHROPIC_API_KEY` is a stale third key (`l0156-claude-key`). Deploys set env vars via `--update-env-vars` in `cloudbuild.yaml` and otherwise leave the service's existing vars alone. Don't revive that file without reconciling it against the live service.
