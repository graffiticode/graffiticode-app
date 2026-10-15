// Stripe API-shape helpers that smooth over version differences.
//
// In 2025-03-31.basil+ (and the 2026 dahlia default the installed SDK targets),
// `current_period_start`/`current_period_end` moved off the Subscription onto
// its items. Read the top-level field when present (older payloads) or fall back
// to the first subscription item. Returns unix seconds, or undefined.

export function subscriptionPeriod(sub: any): { start?: number; end?: number } {
  const item = sub?.items?.data?.[0];
  return {
    start: sub?.current_period_start ?? item?.current_period_start,
    end: sub?.current_period_end ?? item?.current_period_end,
  };
}

export function subscriptionPeriodEnd(sub: any): number | undefined {
  return subscriptionPeriod(sub).end;
}

export function subscriptionPeriodStart(sub: any): number | undefined {
  return subscriptionPeriod(sub).start;
}
