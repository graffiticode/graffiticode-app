# Item-Based Pricing

The console bills tenants per **successful item created per month** — a create request that returns a
compiled, valid artifact. Iteration (revisions), reads, and compiles are **free**. This replaced the
older compile-unit metering.

## Tiers

Single source of truth: **`src/lib/plans-config.ts`** (`PLANS`). Never hardcode allowances, rates, or
price-id mappings elsewhere — import from here. Internal plan ids are stable; only display names/numbers
changed (`starter` is retained but discontinued).

| Display | Internal id | Base $/mo (advance) | Included items/mo | Overage (arrears) |
|---|---|---:|---:|---:|
| Bronze | `demo` | $0 | 25 | $0.40 / item — **requires enrollment**, see below |
| Silver | `pro` | $100 | 500 | $0.20 / item |
| Gold | `teams` | $1,000 | 10,000 | $0.10 / item |
| Platinum | `platinum` | $10,000 | 200,000 | $0.05 / item |

Bronze was called "Free" until pay-as-you-go landed; the internal id stays `demo` (it is written into
every `users/{uid}.subscription.plan` doc and the `PlanId` union). Its overage rate is deliberately the
*highest* — pay-as-you-go is the bridge past the wall, not a cheaper substitute for a subscription.

## Bronze is two states

| State | Signal | Behavior |
|---|---|---|
| Unenrolled | no `subscription.stripeSubscriptionId` | hard cap at `includedItems` |
| Pay-as-you-go | active `demo` subscription | 25 free, then $0.40/item up to the customer's cap |

**We capture payment details at exactly two moments, never earlier:** when the customer hits the 25-item
wall, and when they set a spend cap (`POST /api/payments/overage-limit` answers **402
`requiresPaymentMethod`** for an unenrolled tier rather than storing a number it could not enforce).

Enrollment is a hosted Stripe Checkout in `mode: 'subscription'` carrying the **$0/mo base price + the
graduated metered price**; `payment_method_collection: 'always'` is what makes Stripe collect a card on a
$0 total. Enrollment is **never uncapped** — a $0-base account with an uncapped card is how a trial user gets a
four-figure surprise. The cap defaults to **$10 (25 items)** (`defaultCapUsd` on the plan, read through
`defaultOverageCapUsd()`); the Usage tab pre-fills it, and the server applies it when a client sends none.
It rides on `subscription_data.metadata.overageLimitUsd` so an abandoned Checkout leaves nothing behind.
"Remove cap" on an enrolled Bronze account resets to the default rather than to unlimited. With no card,
the 25-item wall stands until the customer adds one.

Read the state with `payAsYouGoEnabled(subscription)` / `isHardCappedFor(plan, subscription)`
(`plans-config.ts`), never bare `isHardCapped(plan)` — that one can't see the enrollment and answers
"capped" for every Bronze account. That is the safe direction, which is why it still exists.

### First-period anchoring (do not remove)

Stripe stamps `current_period_start` at the moment of enrollment. The gate counts usage from
`currentPeriodStart`, so storing that verbatim would hide every item the customer already created this
month — a user enrolling at item 25 on the 20th would receive 25 fresh included items, free, and again
every month they re-enrolled. So:

- Checkout sets `subscription_data.billing_cycle_anchor_config = { day_of_month: 1 }`, making Stripe's own
  periods calendar-aligned from period 2 onward;
- the `customer.subscription.created` handler writes the **calendar-month start** as
  `subscription.currentPeriodStart` for the **first** period only.

From the first renewal the stored and Stripe periods agree and the special case stops applying.

## Billing model

Flat base billed **in advance** (on signup + each renewal) + **Stripe metered overage** billed in
**arrears** on the next invoice — one clean monthly invoice. E.g. Silver + 600 items → renewal invoice
`$100 base + 100 × $0.20 = $120`.

**The metered price MUST be tiered (graduated):** tier 1 = `0…includedItems` at $0 (covered by the base),
tier 2 = the per-item rate above it. We report **one meter event per item** and Stripe applies the tiers.
A *flat* metered price would bill every item (Silver 600 → $220, not $120). `setup-item-pricing.ts`
creates them tiered; don't change that.

## How metering works

- **Count:** `recordBillableItem()` in `src/pages/api/resolvers.ts` fires **once per distinct item** at
  its first successful compile — from `createItem` success and from `updateItem`'s no-taskId→first-taskId
  transition (async console/MCP creates whose artifact the worker fills in). Idempotent via a `billed`
  flag on the item doc (Firestore transaction).
- **Excluded:** revisions (taskId→taskId) and share/claim copies (`source ∈ {claim,share}` or
  `sharedFrom`/`claimedFrom`).
- **Anonymous free-plan (MCP trial) items are COUNTED but never INVOICED.** They resolve under the
  shared trial uid and flow through the `billed` transaction, the `usage` record and the
  `currentMonthTotal` increment — which is exactly what makes the trial account's own plan allowance
  serve as the trial's monthly budget — then return **before** the Stripe meter report. The account
  carries `overageLimitItems: 0`, so `checkItemCreateAllowed`'s paid-tier branch becomes a hard cap at
  its included items, and it can never accrue billable overage.
  See `docs/free-plan-attested-sessions.md` and `free-plan-quota.ts`.
- **Effects:** writes a `usage` record `{type:'item_created', units:1}`, increments
  `usage/{uid}.currentMonthTotal`, and (metered tiers only) reports a Stripe meter event via
  `src/lib/item-metering.ts` (event name `item_created`, `value:1`, idempotency key `itemId__taskId`).
  `reportItemUsage` re-checks enrollment itself: a Bronze user who opens Checkout and abandons it still
  gets a `stripeCustomerId`, so the customer-id check alone would meter them.
- **Free records:** `logCompile` and the generation token meter now write `units:0` (kept for cost
  telemetry). **The gate and usage endpoint sum only `type==='item_created'` records** — otherwise
  lingering pre-migration compile-unit records would inflate item counts.

### Non-billable items: `units: 0` + `nonBillableReason`

Two kinds of item are real but never invoiced, and both ride the same `units: 0` primitive — which
keeps them out of `checkItemCreateAllowed`'s sum and, via the `if (!billable)` short-circuit, out of
the Stripe meter. They are told apart by `nonBillableReason`, because they are shown very differently:

| `nonBillableReason` | What it is | Customer sees it? |
|---|---|---|
| `'local-script'` | `currentEnv() === 'local'` — a tsx script (corpus generation, evals). Writes to **prod** Firestore but carries `.env.local`'s **test** Stripe key, so its meter events can never reach the live customer. | **No.** Ours, not theirs. |
| `'sponsored'` | The item's language carries `sponsor: "<name>"` in `src/lib/languages.ts` (which also sets its `status` to `"Sponsored"`). Also stamps `sponsorId: 'lang:0000'`. | **Yes** — listed on the Usage tab by sponsor and language, with counts (no bar: there is no limit to fill toward). |

Order matters in `recordBillableItem`: a local run in a sponsored language is **both**, and `local`
wins. Labelling it `sponsored` would put a training run on the customer's usage page.

**Sponsorship is keyed on LANGUAGE, never on `client`.** The server decides an item's language (the
scope gate re-routes a mis-labelled request), so a caller cannot elect into it. `client` flows
straight from `item.client` / `data.client` in the create/update payloads — keying free items on it
would be a billing bypass. Same reason `scripts/backfill-nonbillable-usage.ts` may only trust
`client` below a pinned date ceiling, while `env: 'local'` (server-stamped) it trusts at any date.

The sponsor's display name is resolved from config at read time (`languageSponsor()`), not stored on
the row, so renaming a sponsor needs no migration. **Currently sponsored: L0000, by Artcompiler Inc.**
Marking a language does NOT change items already created in it — sponsorship applies to new items only.

A sponsored create also **bypasses the item wall** (`assertItemCreateAllowed` in `resolvers.ts`): a
Bronze account at its cap or a metered account at its overage cap can still create sponsored items,
since they cost nothing. Free-plan (anonymous trial) callers keep their gate — sponsored trial items
still count toward daily pace.

**The sponsor pays when it has an account.** A language with `sponsorUid` debits each sponsored item
(trial items included) from that account via `debitSponsor()` in `resolvers.ts`: a `units: 1`
`item_created` row under the sponsor's uid (with `sponsoredFor: <creator uid>`), the sponsor's
`currentMonthTotal`, and a meter event on the sponsor's Stripe customer. It is **not** gated on the
sponsor's cap — past the allowance it bills as the sponsor's overage — but the sponsor's own creates
see that volume in `checkItemCreateAllowed`. An unenrolled Bronze sponsor is counted but never metered,
so a sponsor needs a metered plan to be invoiced. Without `sponsorUid` we absorb the cost.

**Sponsors get a loud warning near and at their limits.** Since nothing stops sponsored items,
`maybeAlertSponsorLimit()` (`src/lib/sponsor-alerts.ts`) runs after each debit and fires **once per stage
per billing period**: 80% and 100% of included items, then 80% and 100% of the spend cap (metered sponsors
with a cap only). Each fire emails the operator (`ALERT_EMAIL_TO`) and the sponsor account's owner
(`users/{uid}.email`, else the Stripe customer's email) through SendGrid (`src/lib/alert-email.ts`), texts
the operator through `alert-sms.ts`, and logs `[sponsor-alert] <stage>` with a hashed uid. Dedupe state:
`sponsor-alerts/{uid}__{periodStart}`. Unconfigured email or SMS logs the message instead of sending.

Sponsorship is **uncapped**: while the flag is set every item in that language is free, and ending a
sponsorship is a flag flip after which items bill normally with no wall and no notice. `sponsorId` is
namespaced so a per-user or global cap — or a `client:acme` partner sponsorship — can be added later
and evaluated against rows that already exist.

## Gating + overage spend cap

- `checkItemCreateAllowed()` (`src/lib/usage-service.ts`) runs at **item creation** entry (`createItem` /
  `startCodeGeneration`), not inside `generateCode` — editing an existing item is free.
- Hard-capped (Bronze, unenrolled) = **hard block** at `includedItems`, wall `plan_item_limit`. Metered
  (paid, or Bronze enrolled) = allowed up to the customer cap `subscription.overageLimitItems`, else
  unlimited (overage bills in arrears), wall `overage_cap`. No new wall kind was added.
- **Default cap = the monthly base fee** for a **new** paid subscription (Silver $100, Gold $1,000,
  Platinum $10,000), so a bill can't more than double without the customer choosing it. Written by
  `defaultOverageCapFor()` from both the `customer.subscription.created` webhook (Checkout) and
  `quick-subscribe`'s create branch. Applied only when neither cap field has ever been set — `null` is an
  explicit "no cap" and `overageLimitItems: 0` a deliberate hard cap. Plan changes on an existing
  subscription and accounts subscribed before 2026-09-15 are not touched. Bronze enrollment defaults to
  $10 (25 items) and can't be made uncapped — see "Bronze is two states". Plan cards tell a new subscriber
  their starting cap.
- The cap is set in **dollars** via `POST /api/payments/overage-limit` (stored as items using the tier
  rate) and enforced by us, so Stripe never bills past it. A plan change **recomputes
  `overageLimitItems` from `overageLimitUsd`** at the new rate (`quick-subscribe.ts`) — carrying the item
  count across would silently move the dollar ceiling the customer agreed to. UI: the spend-cap control in
  `components/payments/UsageMonitor.tsx`.
- **Per-account included-items grant** (`subscription.includedItemsOverride` +
  `includedItemsOverridePlan`, set by `scripts/set-included-items.ts`): e.g. Silver at 1,000 instead of 500.
  `effectiveIncludedItems()` adds the extra, so gate, usage page and billing page follow. Stripe's graduated
  meter price still frees only the plan's bucket, so `reportItemUsage()` withholds the period's items
  `planIncluded+1 … override` from the meter (`grantCoversItem()`). Inert once the account changes plan, or
  after `includedItemsOverrideUntil` (`--this-cycle` sets it to the current period end).
  `reconcile-item-metering.ts` will show those withheld items as unreported.

## Downgrades

A downgrade takes effect **immediately**, with **no proration and no refund**, and the customer keeps
the old plan's included items until the end of the period they already paid for. Nothing carries past
period end: unused items are gone. Upgrades are the opposite (prorated, charged now, no grace window).

The grace window is two fields on `users/{uid}.subscription`, always written together:
`preservedAllocation` (the old bucket) and `preservedUntil` (the old period end). The gate reads them
through `effectiveIncludedItems()` (`plans-config.ts`), which returns `max(plan's included,
preservedAllocation)` until `preservedUntil` — it can only **raise** the allowance, never cap it. The
usage counter is **not** reset, so items already created this period still count against the window.

| Move | Path | Stripe | Preserved allocation |
|---|---|---|---|
| Paid → lower paid (e.g. Gold → Silver) | `quick-subscribe.ts` | base price swapped now, `proration_behavior: 'none'`, `billing_cycle_anchor: 'unchanged'` | old plan's `includedItems`, **×12 if the old interval was annual** |
| Paid → Bronze (pricing-page Bronze button → `cancelToDemo`) | `cancel-subscription.ts`, `immediately: true` | subscription cancelled now | old plan's `includedItems` (monthly — no ×12) |
| Cancel at period end | `cancel-subscription.ts`, `immediately: false` | `cancel_at_period_end: true` | none needed — plan is unchanged until `customer.subscription.deleted` resets it to `demo` |

Paid → Bronze also sets `plan: 'demo'`, clears `interval`, and **clears `stripeSubscriptionId`** — which
is what `payAsYouGoEnabled()` keys off, so the account is **hard-capped** from its next create. The old
plan's overage no longer applies and Bronze pay-as-you-go needs re-enrollment. Cancelling an *enrolled*
Bronze account goes the same way and drops it back to the 25-item cap.

**Example.** Silver with 400 of 500 used, downgrading to Bronze mid-period: 100 more creates until the
Silver period end, then a hard block; from period end the allowance is 25.

The old plan is resolved from the **live Stripe price**, falling back to the cached `subscription.plan`,
and never to `DEFAULT_PLAN` (that once wrote a 25-item cap onto a cancelled Gold customer). If neither
resolves, `quick-subscribe` refuses the change (500) and `cancel-subscription` cancels but withholds the
grace window and logs an error — restore it with `scripts/set-preserved-allocation.ts`.

A downgrade also recomputes the spend cap (`overageLimitItems` from `overageLimitUsd`) at the new rate —
see Gating below.

Open questions:
- The Bronze path doesn't apply the annual ×12 that `quick-subscribe` does, so annual Silver → Bronze
  preserves one month's bucket.
- `stripe.subscriptions.cancel()` is called without `invoice_now`, so overage metered on the cancelled
  subscription before an immediate cancel may never be invoiced. Unverified against Stripe.

## Stripe integration

- **SDK is v22**; `apiVersion` is centralized as `STRIPE_API_VERSION` in `plans-config.ts`. `new Stripe()`
  sites must use it. `current_period_start/end` live on subscription **items** now — read them via
  `src/lib/stripe-helpers.ts` (`subscriptionPeriod`/`subscriptionPeriodEnd`/`subscriptionPeriodStart`).
- Paid subscriptions carry **two line items**: the flat base price + the metered overage price. Code that
  changes plans must swap the base and keep the metered aligned — see `splitItems`/`buildUpdateItems` in
  `payments/quick-subscribe.ts`.
- `priceIdToPlan()` maps a **base** price id → plan (metered prices don't map). It's env-driven, so it only
  recognizes the price ids configured in the running environment.
- The **prepaid overage subsystem is gone** (no `overageUnits`, auto top-up, or block purchase).

### Webhooks

`src/pages/api/webhooks/stripe.ts` handles `customer.subscription.*`, `checkout.session.completed`,
`invoice.paid`, etc. Checkout-created subscriptions get their `subscription.plan` written **by the
webhook** (not the endpoint), so a broken webhook silently leaves paid subs at `demo` (and the gate reads
`subscription.plan`). The `STRIPE_WEBHOOK_SECRET` on the service **must match the live endpoint's signing
secret** or every event fails signature verification. `subscription.deleted` only resets to Free when the
customer has no *other* active/trialing sub (guards against out-of-order cancel-old + create-new).

## Env vars

Base + metered price ids per paid tier, resolved by `plans-config.ts`:
`STRIPE_PRO_MONTHLY_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`, `STRIPE_PRO_METER_PRICE_ID`, and the
`STRIPE_TEAMS_*` / `STRIPE_PLATINUM_*` equivalents; plus `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (build-time). In prod these are env vars on the `console` Cloud Run
service (graffiticode-app).

Sponsor alerts: `SENDGRID_API_KEY`, `ALERT_EMAIL_FROM` (a SendGrid-verified sender) and `ALERT_EMAIL_TO`
(operator addresses, comma-separated); SMS reuses `TWILIO_*` and `ALERT_SMS_TO`.

## Operational scripts

```bash
# One-time: zero out historical script-created item rows (dry run by default).
npx tsx scripts/backfill-nonbillable-usage.ts [--apply] [--uid <uid>] [--verbose]

# Firestore item counts vs what Stripe was actually told, per closed cycle.
npx tsx scripts/reconcile-item-metering.ts --cycle last|current [--uid <uid>] [--quiet]

# Provision Stripe (meter + tiered prices + Platinum base). Idempotent. Run in TEST first, then live.
STRIPE_SECRET_KEY=sk_... npx tsx scripts/setup-item-pricing.ts [--dry-run]

# End-to-end invoice proof via a Stripe test clock (creates a sub, reports usage, advances a cycle).
set -a; . ./.env.local; set +a
npx tsx scripts/verify-item-invoice.ts --plan pro --items 600      # expect $120

# Cutover: zero every account's usage counter + resync subscription.units to item allowances.
# Runs against prod Firestore — unset FIRESTORE_EMULATOR_HOST.
env -u FIRESTORE_EMULATOR_HOST npx tsx scripts/reset-and-migrate-tiers.ts [--apply]

# Re-derive Firestore subscription from live Stripe (needs the live price-id env vars set so
# priceIdToPlan matches live subs).
npx tsx scripts/reconcile-subscriptions.ts [--apply]

# After a RATE change: re-derive every customer's spend cap (overageLimitItems) from the
# dollars they agreed to (overageLimitUsd) at the new rate. Nothing else does this — a plan
# change recomputes it, a rate change under a plan they never left does not.
npx tsx scripts/recompute-overage-caps.ts [--apply] [--uid <uid>] [--allow-zero]
  [--previous-rates demo=0.2,pro=0.1,teams=0.05,platinum=0.025]

# Bump one account's included items above its plan (scoped to its current plan; free in Stripe too).
npx tsx scripts/set-included-items.ts --uid <uid> --items 1000 [--this-cycle] [--apply]
npx tsx scripts/set-included-items.ts --uid <uid> --clear [--apply]
```

Notes / gotchas:
- Updating Cloud Run env with `--no-traffic` **pins** traffic to the current revision; a later deploy
  won't serve until `gcloud run services update-traffic console --to-latest`.
- Existing subscribers on *legacy* base prices become unrecognized once env flips to the new price ids
  (`priceIdToPlan` → unknown → `demo`); prefer cancel + re-subscribe over in-place migration.

## Known follow-ups

- 3DS/SCA: `invoice.payment_intent` is cast-to-`any` in `quick-subscribe` (removed from the v22 Invoice
  type) — validate the confirmation flow with an SCA test card.
- `scripts/revenue-vs-cost.ts` predates item pricing; its revenue figures need reworking.
- **Token-count audit — `scripts/audit-token-counts.ts`, built.** `cost-per-item.ts` prices our *own*
  recorded tokens and calls no provider API, so nothing there checks whether those counts are
  **complete**. This script does only that: it sums our `ai_generation` tokens by model for a window,
  fetches what Anthropic and OpenAI actually metered, and compares token counts — not dollars.

  Run it on a settled window (`--to` at yesterday or earlier); provider usage reports lag by hours, and
  a window reaching into today always reads as if we over-counted.

  ```bash
  npx tsx scripts/audit-token-counts.ts --from 2026-08-12 --to 2026-08-19
  ```

  Two alignment details it exists to get right, both of which silently produce enormous phantom drift:
  OpenAI's `input_tokens` is **inclusive** of cache while Anthropic's `uncached_input_tokens` and our
  own `input` are **exclusive** (use `input_uncached_tokens`); and Anthropic splits cache creation by
  TTL where we store one figure.

  It compares against org-wide metering and then **breaks the provider side down by API key**, because
  which key the drift sits on is usually the whole answer — our telemetry only sees calls made through
  the app, so a key driven by local scripts and evals shows up as metered-but-unrecorded rather than as
  a hole in the instrumentation. Scoping to one key instead is what made the old `recorded vs provider`
  line read 175.7%.

  **First run, week of 2026-08-12 — instrumentation is sound.** Our telemetry came to 7,308,020 tokens
  against the deployed key's 7,309,068: **0.014% apart**. OpenAI matched exactly, to the token, on all
  four classes and the request count. The apparent -41.8% against org-wide is entirely
  `graffiticode-console-dev` (5.2M tokens), which is local tooling that bypasses `recordTokenUsage` —
  expected, not a defect. This also retired an earlier suspicion that OpenAI input recording was broken:
  it was the inclusive/exclusive mismatch above, not our data.
