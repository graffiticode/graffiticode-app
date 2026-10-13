// Reading Stripe invoice lines.
//
// Extracted because the obvious way to do this is wrong in a way that fails
// silently: an InvoiceLineItem in SDK v22 has NO `price` property — it moved to
// `pricing.price_details.price` — so `line.price.recurring.usage_type` yields
// undefined for every line, and a predicate built on it is dead code that looks
// fine. scripts/reconcile-item-metering.ts shipped with exactly that bug.
import type Stripe from "stripe";

type LineKind = "base" | "metered" | "other";

/** Resolve a line's price id, whether Stripe expanded the price or not. */
export function linePriceId(line: any): string | undefined {
  const p = line?.pricing?.price_details?.price;
  if (!p) return undefined;
  return typeof p === "string" ? p : p.id;
}

/**
 * Classify an invoice line.
 *
 * Reads `usage_type` off the resolved Price. Note the line itself has NO `price`
 * property in Stripe SDK v22 — it moved to `pricing.price_details.price` — so
 * the obvious `line.price.recurring.usage_type` silently yields undefined.
 *
 * The fallback is not just for missing prices: it is a second opinion expressed
 * purely in billing semantics, independent of env-configured price ids. A line
 * whose period STARTS at the invoice date was billed in advance (base); one
 * whose period ENDS there was billed in arrears (metered).
 */
export function classifyLine(
  line: any,
  priceOf: (id: string) => Stripe.Price | undefined,
): LineKind {
  const isProration = line?.parent?.subscription_item_details?.proration === true;
  if (isProration) return "other";

  const id = linePriceId(line);
  const price = id ? priceOf(id) : undefined;
  const usageType = price?.recurring?.usage_type;
  if (usageType === "metered") return "metered";
  if (usageType === "licensed") return "base";

  const created = line?.__invoiceCreated as number | undefined;
  const period = line?.period;
  if (created && period) {
    const HOUR = 3600;
    if (Math.abs(period.start - created) < HOUR) return "base";
    if (Math.abs(period.end - created) < HOUR) return "metered";
  }
  return "other";
}
