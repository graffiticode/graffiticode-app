#!/usr/bin/env node
// Recompute every account's overage spend cap after a per-item rate change.
//
// The cap is stored twice on users/{uid}.subscription:
//   overageLimitUsd    what the customer actually agreed to (the dollar ceiling)
//   overageLimitItems  what the gate enforces, = floor(usd / plan rate)
//
// Only the dollars are a promise; the item count is a derivation. So a rate
// change silently moves the ceiling: after rates doubled, a $20 cap stored as
// 200 items at $0.10 buys $40 of overage at $0.20. quick-subscribe recomputes
// this on a PLAN change (see overageDollarsToItems), and the webhook writes both
// fields at enrollment — but nothing recomputes when the RATE moves underneath a
// plan the customer never left. That is what this script is for.
//
// Direction of the fix is always the same: honor overageLimitUsd, re-derive
// overageLimitItems at the current rate from plans-config.
//
// Two shapes get special handling:
//   - items but no usd (a cap set before the dollar field existed). There is no
//     stored dollar intent to honor, so these are REPORTED and skipped. Pass
//     --previous-rates to reconstruct the intent: implied usd = items x old
//     rate, which is then re-derived at the new rate and the usd backfilled.
//   - a cap that now resolves to ZERO items (usd < one item at the new rate).
//     Arithmetically right, but it turns a spend cap into a hard block, so it is
//     reported and skipped unless --allow-zero.
//
// Never touched: overageLimitItems === 0 with no positive usd. That is the
// anonymous free-plan/trial account's deliberate hard cap (see
// free-plan-quota.ts), not a customer's spend cap.
//
// Usage:
//   npx tsx scripts/recompute-overage-caps.ts                                   # dry-run
//   npx tsx scripts/recompute-overage-caps.ts --apply
//   npx tsx scripts/recompute-overage-caps.ts --uid <uid> --apply
//   npx tsx scripts/recompute-overage-caps.ts --allow-zero --apply
//   npx tsx scripts/recompute-overage-caps.ts --previous-rates demo=0.2,pro=0.1,teams=0.05,platinum=0.025 --apply
//
// Runs against prod Firestore (graffiticode-app); the emulator env is stripped.

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PLANS, DEFAULT_PLAN, getPlan, overageRateFor, overageDollarsToItems, type PlanId } from '../src/lib/plans-config';

try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

// Deferred so importing this module (to reuse capVerdict) neither demands
// credentials nor opens a connection to prod.
function connect(): admin.firestore.Firestore {
  if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
    console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
    process.exit(1);
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
  }
  return admin.firestore();
}

const APPLY = process.argv.includes('--apply');
const ALLOW_ZERO = process.argv.includes('--allow-zero');

const flagValue = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};
const ONLY_UID = flagValue('--uid');

// --previous-rates demo=0.2,pro=0.1 → the rates in force when the stored item
// counts were written. Used ONLY to reconstruct a missing overageLimitUsd.
const PREVIOUS_RATES: Partial<Record<PlanId, number>> = {};
const previousRatesArg = flagValue('--previous-rates');
if (process.argv.includes('--previous-rates') && !previousRatesArg) {
  console.error('--previous-rates requires a value, e.g. --previous-rates demo=0.2,pro=0.1');
  process.exit(1);
}
if (previousRatesArg) {
  for (const pair of previousRatesArg.split(',')) {
    const [id, raw] = pair.split('=').map(s => s?.trim());
    const rate = Number(raw);
    if (!id || !(id in PLANS)) {
      console.error(`--previous-rates: unknown plan id "${id}". Known: ${Object.keys(PLANS).join(', ')}`);
      process.exit(1);
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      console.error(`--previous-rates: "${pair}" is not a positive rate`);
      process.exit(1);
    }
    PREVIOUS_RATES[id as PlanId] = rate;
  }
}

// Dollars are money: compare and print at cent precision so a float artifact
// (200 * 0.1 = 20.000000000000004) never reads as a discrepancy.
const usdRound = (n: number) => Math.round(n * 100) / 100;
const usdFmt = (n: number) => `$${usdRound(n).toFixed(2)}`;

/** What the script decided about one account, before any write happens. */
export type CapVerdict =
  | { kind: 'uncapped' }
  | { kind: 'trial-hard-cap' }
  | { kind: 'no-rate' }
  | { kind: 'no-usd'; items: number }
  | { kind: 'correct'; items: number }
  | { kind: 'zero'; usd: number; items: number | null; recomputed: 0; backfillUsd: boolean }
  | { kind: 'fix'; usd: number; items: number | null; recomputed: number; backfillUsd: boolean };

/**
 * The whole decision for one subscription, as a pure function — Firestore reads
 * and writes stay in main(). Split out so the branch table (trial hard cap,
 * missing dollars, zero-result cap, already-correct) can be exercised without a
 * live database.
 */
export function capVerdict(
  sub: { plan?: string | null; overageLimitItems?: unknown; overageLimitUsd?: unknown },
  previousRates: Partial<Record<PlanId, number>> = {},
): CapVerdict {
  const items = sub.overageLimitItems;
  const usdStored = sub.overageLimitUsd;
  const hasItems = typeof items === 'number';
  const hasUsd = typeof usdStored === 'number' && usdStored > 0;

  // null/absent on both = uncapped (unlimited overage). Nothing to recompute —
  // and writing a number here would invent a ceiling the customer never set.
  if (!hasItems && !hasUsd) return { kind: 'uncapped' };

  // The trial account's deliberate hard cap: 0 items, no dollar cap behind it.
  if (hasItems && items === 0 && !hasUsd) return { kind: 'trial-hard-cap' };

  const plan = (sub.plan || DEFAULT_PLAN) as PlanId;
  if (overageRateFor(plan) == null) return { kind: 'no-rate' };

  // Honor the stored dollars; failing that, reconstruct them from the item count
  // at the rate that was in force when it was written.
  let usd: number;
  let backfillUsd = false;
  if (hasUsd) {
    usd = usdStored as number;
  } else {
    const previousRate = previousRates[plan];
    if (!previousRate) return { kind: 'no-usd', items: items as number };
    usd = usdRound((items as number) * previousRate);
    backfillUsd = true;
  }

  const recomputed = overageDollarsToItems(plan, usd);
  if (recomputed == null) return { kind: 'no-rate' };
  if (recomputed === items && !backfillUsd) return { kind: 'correct', items: recomputed };

  const shared = { usd, items: hasItems ? (items as number) : null, backfillUsd };
  return recomputed === 0
    ? { kind: 'zero', ...shared, recomputed: 0 }
    : { kind: 'fix', ...shared, recomputed };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);
  console.log('Current rates: ' + (Object.keys(PLANS) as PlanId[])
    .map(id => `${id}=${overageRateFor(id) ?? 'none'}`).join(' '));
  if (previousRatesArg) console.log(`Previous rates (for docs missing usd): ${previousRatesArg}`);
  console.log('');

  const db = connect();
  const docs = ONLY_UID
    ? [await db.collection('users').doc(ONLY_UID).get()].filter(d => d.exists)
    : (await db.collection('users').get()).docs;

  let correct = 0, updated = 0, noUsd = 0, zeroed = 0, noRate = 0, skippedTrial = 0;

  for (const doc of docs) {
    const sub = (doc.data() as any)?.subscription;
    if (!sub) continue;

    const verdict = capVerdict(sub, PREVIOUS_RATES);
    const plan = (sub.plan || DEFAULT_PLAN) as PlanId;
    const planLabel = getPlan(plan).displayName;
    const rate = overageRateFor(plan);

    switch (verdict.kind) {
      case 'uncapped':
        continue;
      case 'trial-hard-cap':
        skippedTrial++;
        console.log(`  SKIP    ${doc.id}: overageLimitItems 0 with no usd — deliberate hard cap, left alone`);
        continue;
      case 'no-rate':
        noRate++;
        console.log(`  NORATE  ${doc.id}: ${planLabel} has no usable overage rate (contact-sales); cap left as-is`);
        continue;
      case 'no-usd':
        noUsd++;
        console.log(
          `  NOUSD   ${doc.id}: ${planLabel} has ${verdict.items} items but no overageLimitUsd — ` +
          `no stored dollar intent${previousRatesArg ? ` and no previous rate given for ${plan}` : ''}; ` +
          'skipped (pass --previous-rates to reconstruct)',
        );
        continue;
      case 'correct':
        correct++;
        continue;
    }

    const before = verdict.items === null ? 'absent' : `${verdict.items}`;
    const impliedBefore = verdict.items === null ? 'n/a' : usdFmt(verdict.items * (rate as number));
    const detail =
      `${planLabel} cap ${usdFmt(verdict.usd)}${verdict.backfillUsd ? ' (reconstructed)' : ''}: ` +
      `${before} -> ${verdict.recomputed} items @ ${rate}/item` +
      (verdict.items === null ? '' : ` (was worth ${impliedBefore} at the current rate)`);

    if (verdict.kind === 'zero' && !ALLOW_ZERO) {
      zeroed++;
      console.log(`  ZERO    ${doc.id}: ${detail} — a 0-item cap hard-blocks creation; skipped (pass --allow-zero)`);
      continue;
    }

    console.log(`  ${verdict.kind === 'zero' ? 'ZERO*  ' : 'FIX    '} ${doc.id}: ${detail}`);
    if (APPLY) {
      const update: Record<string, unknown> = { 'subscription.overageLimitItems': verdict.recomputed };
      if (verdict.backfillUsd) update['subscription.overageLimitUsd'] = verdict.usd;
      await doc.ref.update(update);
    }
    updated++;
  }

  console.log(
    `\nDone. ${APPLY ? 'updated' : 'would update'}=${updated} already-correct=${correct} ` +
    `no-usd=${noUsd} zero-result=${zeroed} no-rate=${noRate} trial-hard-caps=${skippedTrial}`,
  );
  if (updated && !APPLY) console.log('Re-run with --apply to write them.');
  if (noUsd) console.log('no-usd docs need --previous-rates <plan>=<rate>,... to reconstruct the dollar intent.');
  if (zeroed) console.log('zero-result docs would be hard-blocked by their own cap; contact those customers or pass --allow-zero.');
}

// Only when run as a script — importing it (for capVerdict) must not touch Firestore.
if (process.argv[1] && resolve(process.argv[1]).endsWith('recompute-overage-caps.ts')) {
  main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
