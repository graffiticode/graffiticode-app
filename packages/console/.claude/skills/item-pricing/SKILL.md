---
name: item-pricing
description: Item-based pricing and metering — plan tiers, where items are counted vs gated, Stripe v22 specifics, and provisioning/migration scripts. Read before touching billing, plans-config, usage-service, item-metering, or Stripe code.
---

# Item-based pricing & metering

Full reference: `docs/item-based-pricing.md`.

Billing meters **successful items created per month** (a create request that returns a compiled, valid artifact) — iteration, reads, and compiles are free. The single source of truth is `src/lib/plans-config.ts` (`PLANS`): tiers are Bronze (`demo`, $0, 25 items, then $0.40/item **once enrolled in pay-as-you-go**), Silver (`pro`, $100, 500, $0.20/item over), Gold (`teams`, $1,000, 10,000, $0.10), Platinum (`platinum`, $10,000, 200,000, $0.05). Internal plan ids are kept stable; only display names/numbers changed (Bronze was displayed as "Free" before pay-as-you-go; `starter` is discontinued). **Everything imports allowances/rates/price-id mappings from `plans-config.ts`** — never hardcode them (this replaced ~6 duplicated maps). Billing model = flat base billed **in advance** + **Stripe metered overage** billed in arrears on the next invoice (one clean monthly invoice).

## Counting

`recordBillableItem()` in `resolvers.ts` fires once per distinct item at its first successful compile — from `createItem` success and from `updateItem`'s no-taskId→first-taskId transition (async console/MCP creates whose artifact the worker fills in). Idempotent via a `billed` flag on the item doc (transaction). Excludes revisions (taskId→taskId) and share/claim copies. **Anonymous free-plan items are COUNTED but never INVOICED** — they run the `usage` write and `currentMonthTotal` increment (which is what makes the trial account's own plan allowance serve as the trial's budget) and then return *before* the Stripe meter report. It writes a `type:'item_created'` usage record (`units:1`), increments `usage/{uid}.currentMonthTotal`, and reports a Stripe meter event (`src/lib/item-metering.ts`, event `item_created`) for paid tiers. `logCompile` and the generation token meter now write `units:0` (kept for cost telemetry, never billed).

## Gating

`checkItemCreateAllowed()` (`src/lib/usage-service.ts`, renamed from `checkCompileAllowed`) runs at `createItem`/`startCodeGeneration` entry (not inside `generateCode` — edits are free). Hard-capped = hard block at included; metered = allowed up to an optional customer **overage spend cap** (`subscription.overageLimitItems`, set in dollars via `POST /api/payments/overage-limit`, enforced by us so Stripe never bills past it), else unlimited. A **new** paid subscription defaults its cap to the monthly base fee (`defaultOverageCapFor`, written by the `subscription.created` webhook and `quick-subscribe`'s create branch) only when the account has never had a cap — `null` means an explicit "no cap". Bronze enrollment defaults to the plan's `defaultCapUsd` ($10) when the client sends none.

**Bronze is two states, and which one you're in is not a plan id.** Unenrolled (no `subscription.stripeSubscriptionId`) = hard-capped at 25; enrolled in pay-as-you-go (active `demo` subscription = a card on file) = metered at $0.40/item up to a spend cap that defaults to $10 (25 items) and can't be removed — "Remove cap" resets it to the default. Branch on `isHardCappedFor(plan, subscription)` / `payAsYouGoEnabled(subscription)`, never bare `isHardCapped(plan)` — that one can't see enrollment and answers "capped" for every Bronze account (the safe direction, which is why it still exists). We capture payment details at exactly two moments: the 25-item wall, and setting a spend cap (which 402s with `requiresPaymentMethod` when unenrolled). Enrollment is hosted Checkout with a $0 base price + graduated metered price; `payment_method_collection: 'always'` is the only reason Stripe collects a card on a $0 total. **First-period anchoring** in the `customer.subscription.created` handler stops a mid-month enrollment from resetting the usage counter and granting 25 free items — see `docs/item-based-pricing.md`.

**Downgrades apply immediately and keep the old allowance until period end** (`preservedAllocation`/`preservedUntil`, read through `effectiveIncludedItems`, which can only raise the allowance). No proration, no refund, no carry-over. Paid→paid goes through `quick-subscribe.ts`; paid→Bronze is an immediate cancel in `cancel-subscription.ts`, which also un-enrolls pay-as-you-go. Details: `docs/item-based-pricing.md` § Downgrades.

## Stripe

Upgraded to SDK **v22** (`apiVersion` centralized as `STRIPE_API_VERSION`; `current_period_*` moved onto subscription items — use `src/lib/stripe-helpers.ts`). Paid subscriptions carry the flat base price **plus** a metered price line item (`create-checkout-session.ts`). The prepaid-overage subsystem (block purchase, auto top-up, `overageUnits`) was **removed**.

## Provisioning / migration scripts

`npx tsx scripts/setup-item-pricing.ts [--dry-run]` (creates the Billing Meter, metered prices, and Platinum base prices; prints env vars) and `scripts/migrate-to-item-pricing.ts [--apply]` (attaches metered price to existing paid subs; straggler `starter`→Silver). New env vars: `STRIPE_PLATINUM_MONTHLY_PRICE_ID`, `STRIPE_PLATINUM_ANNUAL_PRICE_ID`, `STRIPE_PRO_METER_PRICE_ID`, `STRIPE_TEAMS_METER_PRICE_ID`, `STRIPE_PLATINUM_METER_PRICE_ID`. (`scripts/revenue-vs-cost.ts` predates item pricing — its revenue figures need rework.)
