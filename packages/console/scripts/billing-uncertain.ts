#!/usr/bin/env node
/**
 * Billing deliveries that stopped and need a person (generation protocol v2).
 *
 * A Stripe meter event is sent from the outbox (core/effects.ts) with the
 * identifier `${itemId}__${taskId}`. Stripe dedupes that identifier for about
 * 24 hours, so once 20 hours have passed since the first send, a resend could
 * be counted twice: the outbox stops such an event as `uncertain`. Stripe
 * refusing an event outright leaves it `failed`. Either way nothing is lost —
 * the item's usage row and counters were committed with the item — but the
 * invoice may be short until an operator decides.
 *
 * For each one, look up the customer's meter event summaries in the Stripe
 * dashboard around `completed` (the event's timestamp), then:
 *
 *   npm run billing-uncertain                       # list
 *   npm run billing-uncertain -- --done <id>        # it arrived, or shouldn't bill
 *   npm run billing-uncertain -- --resend <id>      # it didn't; send it again
 */
import { execFileSync } from "child_process";
import { listBillingAttention, resolveBillingEffect } from "@graffiticode-app/core/effects";

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "-");

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const done = flag("--done");
  const resend = flag("--resend");
  if (done || resend) {
    const by = execFileSync("gcloud", ["config", "get", "account"], { encoding: "utf8" }).trim() || "unknown";
    const r = await resolveBillingEffect((done ?? resend)!, done ? "done" : "resend", by);
    console.log(`${done ?? resend}: ${r.previousState} -> ${done ? "done" : "pending (will resend)"} by ${by}`);
    return;
  }
  const rows = await listBillingAttention();
  if (!rows.length) {
    console.log("No billing deliveries need attention.");
    return;
  }
  for (const r of rows) {
    console.log([
      r.id, r.state, `payer=${r.payer}`, `uid=${r.uid}`, `item=${r.itemId}`, `customer=${r.stripeCustomerId ?? "-"}`,
      `identifier=${r.identifier}`, `completed=${iso(r.completedAt)}`, `firstSent=${iso(r.firstSentAt)}`,
      `attempts=${r.attempts}`, r.lastError ? `error=${r.lastError}` : "",
    ].filter(Boolean).join("  "));
  }
  process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(2); });
