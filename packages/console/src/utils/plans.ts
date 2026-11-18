// UI-facing plan catalog, built from the plan terms in the installation's
// public configuration (/api/config: billing.plans), which the server takes
// from core's plans-config — do not hardcode allowances or prices here. Use it
// through usePlanDisplay().
import { useMemo } from 'react';
import type { PlanId as ConfigPlanId, BillingInterval as ConfigBillingInterval } from '@graffiticode-app/core/lib/plans-config';
import type { PublicPlan } from '@graffiticode-app/core/profile/public-config';
import { usePublicConfig } from '../lib/public-config';

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

/** Always at least 2 decimals ($0.10, not $0.1); a 3rd only when significant ($0.025). */
export const perItem = (n: number) => `$${n.toFixed(3).replace(/0$/, '')}`;

export type PlanSummary = { name: string; monthlyUnits: number; price: { monthly: number; annual: number } };


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

export type PlanDisplay = {
  plans: Plan[];
  planDetails: Record<PlanId, PlanSummary>;
  isUpgrade: (from: PlanId, to: PlanId) => boolean;
  isDowngrade: (from: PlanId, to: PlanId) => boolean;
  getButtonLabel: (opts: ButtonLabelOpts) => string;
  // The spend cap prefilled at enrollment, in USD, or null (core's
  // defaultOverageCapUsd, from these terms).
  defaultOverageCapUsd: (id: PlanId) => number | null;
};

const fmt = (n: number) => n.toLocaleString('en-US');

export function planDisplay(terms: Record<PlanId, PublicPlan>): PlanDisplay {
  const rate = (id: PlanId) => {
    const r = terms[id].overageRatePerItem;
    return r == null ? '' : perItem(r);
  };
  const tierOf = (id: PlanId) => (terms[id] ?? terms.demo).tier;
  const isUpgrade = (from: PlanId, to: PlanId) => tierOf(to) > tierOf(from);
  const isDowngrade = (from: PlanId, to: PlanId) => tierOf(to) < tierOf(from);
  const defaultOverageCapUsd = (id: PlanId) => {
    const plan = terms[id] ?? terms.demo;
    if (plan.overageRatePerItem == null) return null;
    if (plan.defaultCapUsd != null) return plan.defaultCapUsd;
    return !plan.hardCap && plan.basePriceMonthly > 0 ? plan.basePriceMonthly : null;
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
  const plans: Plan[] = [
    {
      id: 'demo',
      name: terms.demo.displayName,
      // Keep the word "free" in the note even though the plan is now named Bronze
      // — it's the zero-price signal that makes the tier convert. Only the plan
      // NAME moved; what you pay to start did not.
      monthlyPrice: terms.demo.basePriceMonthly,
      annualPrice: terms.demo.basePriceAnnual,
      listPrice: 10,
      monthlyUnits: terms.demo.includedItems,
      additionalItem: terms.demo.overageRatePerItem,
      note: `The on-ramp — the first ${fmt(terms.demo.includedItems)} items each month are free, with no credit card. A card is required only to create additional items, along with a monthly spend cap; move to ${terms.pro.displayName} when volume makes the flat rate cheaper.`,
      cta: 'Current Plan',
      isFree: true,
    },
    {
      id: 'pro',
      name: terms.pro.displayName,
      monthlyPrice: terms.pro.basePriceMonthly,
      annualPrice: terms.pro.basePriceAnnual,
      monthlyUnits: terms.pro.includedItems,
      additionalItem: terms.pro.overageRatePerItem,
      note: `Flat ${rate('pro')}/item with a $${fmt(terms.pro.basePriceMonthly)} monthly minimum.`,
      cta: `Choose ${terms.pro.displayName}`,
    },
    {
      id: 'teams',
      name: terms.teams.displayName,
      monthlyPrice: terms.teams.basePriceMonthly,
      annualPrice: terms.teams.basePriceAnnual,
      monthlyUnits: terms.teams.includedItems,
      additionalItem: terms.teams.overageRatePerItem,
      // ~5,000 is the Silver/Gold crossover — derived from the two rates and
      // minimums, not a field in plans-config. The pricing page states the same.
      note: `Cheaper than ${terms.pro.displayName} above ~5,000 items/mo — ${rate('teams')}/item.`,
      cta: `Choose ${terms.teams.displayName}`,
    },
    {
      id: 'platinum',
      name: terms.platinum.displayName,
      monthlyPrice: terms.platinum.basePriceMonthly,
      annualPrice: terms.platinum.basePriceAnnual,
      monthlyUnits: terms.platinum.includedItems,
      additionalItem: terms.platinum.overageRatePerItem,
      // "includes custom language development" is a public commitment, not a
      // blurb — PRICING.languageService on the pricing page states the same terms.
      // Don't soften it or add a turnaround figure marketing doesn't also promise.
      note: `The partner engagement — our lowest per-item rate at ${rate('platinum')}, and it includes custom language development with no additional fee.`,
      cta: `Choose ${terms.platinum.displayName}`,
    },
  ];

  // Starter is discontinued and no longer offered (removed from `plans` above), but its
  // definition is retained so legacy/straggler subscribers and historical data still
  // resolve via `planDetails`, `PLAN_TIER`, and the `PlanId` type.
  const starterPlan: Plan = {
    id: 'starter',
    name: terms.starter.displayName,
    monthlyPrice: terms.starter.basePriceMonthly,
    annualPrice: terms.starter.basePriceAnnual,
    monthlyUnits: terms.starter.includedItems,
    additionalItem: terms.starter.overageRatePerItem,
    note: 'Discontinued — retained so legacy subscribers still resolve.',
    cta: 'Get Started',
  };

  const getButtonLabel = (opts: ButtonLabelOpts): string => {
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
  };

  const planDetails: Record<PlanId, PlanSummary> =
    Object.fromEntries(
      [...plans, starterPlan].map(p => [p.id, { name: p.name, monthlyUnits: p.monthlyUnits, price: { monthly: p.monthlyPrice, annual: p.annualPrice } }])
    ) as Record<PlanId, PlanSummary>;

  return { plans, planDetails, isUpgrade, isDowngrade, getButtonLabel, defaultOverageCapUsd };
}

// The plan display for the installation this page loaded.
export function usePlanDisplay(): PlanDisplay {
  const config = usePublicConfig();
  return useMemo(() => planDisplay(config.billing.plans as Record<PlanId, PublicPlan>), [config]);
}
