#!/usr/bin/env node

// Manual check for the derived trial daily pace (npx tsx scripts/check-trial-pace.ts).
// Pure arithmetic, no Firestore — the subtlest new logic in the item-based trial
// quota, and the repo has no unit-test runner.

import { dailyItemAllowance } from "../src/lib/free-plan-quota";

const periodEnd = new Date(Date.UTC(2026, 6, 31)); // Jul 31
const day1 = new Date(Date.UTC(2026, 6, 2));       // Jul 2  -> 30 days left incl today
const day2 = new Date(Date.UTC(2026, 6, 3));       // Jul 3  -> 29 days left

const cases: [string, number, number, Date, number][] = [
  ["day 1, nothing used",        1000, 0,    day1, 34],
  ["day 2, 10 used",             1000, 10,   day2, 35],
  ["day 2, heavy day 1 (100)",   1000, 100,  day2, 32],
  ["budget exhausted",           1000, 1000, day2, 0],
  ["final day keeps remainder",  1000, 995,  periodEnd, 5],
  ["small remainder not stranded", 1000, 995, day2, 1],
];

let bad = 0;
for (const [label, included, used, now, want] of cases) {
  const got = dailyItemAllowance({ includedItems: included, currentPeriodTotal: used, periodEnd, now });
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(30)} want ${want}, got ${got}`);
}

// No subscription period at all -> must still pace off calendar month end.
const noPeriod = dailyItemAllowance({ includedItems: 1000, currentPeriodTotal: 0, periodEnd: undefined, now: day1 });
console.log(`${noPeriod === 34 ? "ok  " : "FAIL"}  ${"no periodEnd (calendar fallback)".padEnd(30)} want 34, got ${noPeriod}`);
if (noPeriod !== 34) bad++;

// A stale (past) periodEnd must fall back to calendar pacing, not hand the
// whole month to one day and then keep doing it every day after.
const stale = dailyItemAllowance({ includedItems: 1000, currentPeriodTotal: 0, periodEnd: new Date(Date.UTC(2026, 5, 1)), now: day1 });
console.log(`${stale === 34 ? "ok  " : "FAIL"}  ${"stale periodEnd".padEnd(30)} want 34, got ${stale}`);
if (stale !== 34) bad++;

console.log(bad ? `\n${bad} failure(s)` : "\nall ok");
process.exit(bad ? 1 : 0);
