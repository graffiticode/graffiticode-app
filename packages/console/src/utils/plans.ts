// UI-facing plan catalog. Values are derived from the single source of truth in
// src/lib/plans-config.ts — do not hardcode allowances/prices here.
import { PLANS, type PlanId as ConfigPlanId, type BillingInterval as ConfigBillingInterval, isUpgrade as configIsUpgrade, isDowngrade as configIsDowngrade } from '../lib/plans-config';

export type PlanId = ConfigPlanId;
export type BillingInterval = ConfigBillingInterval;

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  /**
   * Struck-through list price shown before the real one, in USD. PRESENTATION
   * ONLY — an anchor with no counterpart in plans-config or Stripe. Nothing ever
   * bills at this figure. Mirrors `listPrice` on the public pricing page.
   */
  listPrice?: number;
  /** Items included per month (base fee bucket). */
  monthlyUnits: number;
  /** Per-item price above the included bucket, or null when overage isn't offered. */
  additionalItem: number | null;
  /** The paragraph under the divider. One sentence or two, not a feature list. */
  note: string;
  cta: string;
  isFree?: boolean;
  // Non-self-serve plan: custom pricing, sold via "Contact Sales" rather than Stripe checkout.
  contactSales?: boolean;
  // Price text shown in place of a dollar amount for contactSales plans (e.g. "Custom").
  priceLabel?: string;
  // Where the Contact Sales CTA points (mailto: or URL).
  contactHref?: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');
/** Always at least 2 decimals ($0.10, not $0.1); a 3rd only when significant ($0.025). */
export const perItem = (n: number) => `$${n.toFixed(3).replace(/0$/, '')}`;
const rate = (id: PlanId) => {
  const r = PLANS[id].overageRatePerItem;
  return r == null ? '' : perItem(r);
};

// Card copy mirrors the AGENT audience of the public pricing page
// (www/data/contract.ts → PRICING.plans + PRICING.audiences.agent), which is the
// same reader: someone driving the product through an agent, deciding which tier
// to be on. Keep the two in step — a customer who compares the marketing page
// with their billing page and finds different promises has found a bug.
//
// The framing that page settles on, and that these cards carry:
//   - every tier is a FLAT per-item rate with a monthly minimum, so the included
//     bucket costs the same per item as anything above it — no overage penalty;
//   - Bronze's included 25 need no card at all. A card (with a spend cap,
//     $10 by default) buys ADDITIONAL items, nothing else;
//   - you move up a tier exactly when it lowers your per-item cost.
export const plans: Plan[] = [
  {
    id: 'demo',
    name: PLANS.demo.displayName,
    // Keep the word "free" in the note even though the plan is now named Bronze
    // — it's the zero-price signal that makes the tier convert. Only the plan
    // NAME moved; what you pay to start did not.
    monthlyPrice: PLANS.demo.basePriceMonthly,
    annualPrice: PLANS.demo.basePriceAnnual,
    listPrice: 10,
    monthlyUnits: PLANS.demo.includedItems,
    additionalItem: PLANS.demo.overageRatePerItem,
    note: `The on-ramp — the first ${fmt(PLANS.demo.includedItems)} items each month are free, with no credit card. A card is required only to create additional items, along with a monthly spend cap; move to ${PLANS.pro.displayName} when volume makes the flat rate cheaper.`,
    cta: 'Current Plan',
    isFree: true,
  },
  {
    id: 'pro',
    name: PLANS.pro.displayName,
    monthlyPrice: PLANS.pro.basePriceMonthly,
    annualPrice: PLANS.pro.basePriceAnnual,
    monthlyUnits: PLANS.pro.includedItems,
    additionalItem: PLANS.pro.overageRatePerItem,
    note: `Flat ${rate('pro')}/item with a $${fmt(PLANS.pro.basePriceMonthly)} monthly minimum.`,
    cta: 'Choose Silver',
  },
  {
    id: 'teams',
    name: PLANS.teams.displayName,
    monthlyPrice: PLANS.teams.basePriceMonthly,
    annualPrice: PLANS.teams.basePriceAnnual,
    monthlyUnits: PLANS.teams.includedItems,
    additionalItem: PLANS.teams.overageRatePerItem,
    // ~5,000 is the Silver/Gold crossover — derived from the two rates and
    // minimums, not a field in plans-config. The pricing page states the same.
    note: `Cheaper than ${PLANS.pro.displayName} above ~5,000 items/mo — ${rate('teams')}/item.`,
    cta: 'Choose Gold',
  },
  {
    id: 'platinum',
    name: PLANS.platinum.displayName,
    monthlyPrice: PLANS.platinum.basePriceMonthly,
    annualPrice: PLANS.platinum.basePriceAnnual,
    monthlyUnits: PLANS.platinum.includedItems,
    additionalItem: PLANS.platinum.overageRatePerItem,
    // "includes custom language development" is a public commitment, not a
    // blurb — PRICING.languageService on the pricing page states the same terms.
    // Don't soften it or add a turnaround figure marketing doesn't also promise.
    note: `The partner engagement — our lowest per-item rate at ${rate('platinum')}, and it includes custom language development with no additional fee.`,
    cta: 'Choose Platinum',
  },
];

// Starter is discontinued and no longer offered (removed from `plans` above), but its
// definition is retained so legacy/straggler subscribers and historical data still
// resolve via `planDetails`, `PLAN_TIER`, and the `PlanId` type.
const starterPlan: Plan = {
  id: 'starter',
  name: PLANS.starter.displayName,
  monthlyPrice: PLANS.starter.basePriceMonthly,
  annualPrice: PLANS.starter.basePriceAnnual,
  monthlyUnits: PLANS.starter.includedItems,
  additionalItem: PLANS.starter.overageRatePerItem,
  note: 'Discontinued — retained so legacy subscribers still resolve.',
  cta: 'Get Started',
};

export function isUpgrade(from: PlanId, to: PlanId): boolean {
  return configIsUpgrade(from, to);
}

export function isDowngrade(from: PlanId, to: PlanId): boolean {
  return configIsDowngrade(from, to);
}

export interface ButtonLabelOpts {
  planId: PlanId;
  planName: string;
  planCta: string;
  isFree: boolean;
  isCurrentPlan: boolean;
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  isSameBillingInterval: boolean;
  isChangingBilling: boolean;
  pendingCancel: boolean;
  processing: boolean;
  currentUserPlan: PlanId;
  billingInterval: BillingInterval;
}

export function getButtonLabel(opts: ButtonLabelOpts): string {
  if (opts.processing) return 'Processing...';
  if (opts.isFree && opts.isCurrentPlan) return 'Current Plan';
  if (opts.isFree && opts.hasActiveSubscription) return `Downgrade to ${opts.planName}`;
  if (opts.cancelAtPeriodEnd && opts.isCurrentPlan) return 'Canceling at Period End';
  if (opts.isCurrentPlan && opts.isSameBillingInterval && !opts.isFree) {
    return opts.pendingCancel ? 'Confirm Cancel' : 'Cancel Plan';
  }
  if (opts.isChangingBilling) {
    return `Change to ${opts.billingInterval === 'annual' ? 'Annual' : 'Monthly'}`;
  }
  if (isUpgrade(opts.currentUserPlan, opts.planId)) return `Upgrade to ${opts.planName}`;
  if (isDowngrade(opts.currentUserPlan, opts.planId)) return `Downgrade to ${opts.planName}`;
  return opts.planCta;
}

export const planDetails: Record<PlanId, { name: string; monthlyUnits: number; price: { monthly: number; annual: number } }> =
  Object.fromEntries(
    [...plans, starterPlan].map(p => [p.id, { name: p.name, monthlyUnits: p.monthlyUnits, price: { monthly: p.monthlyPrice, annual: p.annualPrice } }])
  ) as Record<PlanId, { name: string; monthlyUnits: number; price: { monthly: number; annual: number } }>;
