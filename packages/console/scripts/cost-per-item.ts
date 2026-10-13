#!/usr/bin/env node

// What would it cost to produce one item at today's prices?
//
//   npx tsx scripts/cost-per-item.ts --period week
//
// Cost is OUR recorded token counts priced with MODEL_RATES — never what a
// provider billed. The question is forward-looking: the same tokens, on the
// same models, at the `--as-of` rate card (today by default), because rates
// move on their own and the decision this informs is whether the current
// per-item rates are profitable. What we were billed historically answers a
// different question and is deliberately absent.
//
// Every `ai_generation` doc in the window is priced and divided by the items
// created in it, so numerator and denominator come from the SAME population.
// An earlier version took the numerator from one API key's provider-reported
// spend and the denominator from all items; that mismatch reported cost per
// item as $0.0632 and then $0.1950 when the defensible figure was $0.0503.
//
// The same mismatch reappeared on the `env` axis: generations were filtered to
// prod while items were not, so a window with 2,165 local training generations
// divided prod-only spend by all-env items and read 7x too cheap. Both sides now
// take the SAME `--env`, and the default is `all` — a training run is a real
// generation producing a real item, and its cost is as good a measure as
// production's. Scope with --env prod only for windows that postdate the marker;
// the run refuses to print a blended figure when the two sides cannot be scoped
// alike.
//
// The same like-for-like rule is why the internal harnesses are excluded. The
// daily corpus ping and weekly sweep call the generator with a synthetic
// per-language `itemId` and create no item, so their spend is a numerator with
// no denominator: counting it made cost/item rise every time a language joined
// the ping set. Worse, the id is CONSTANT per language, so grouping by itemId
// booked a whole window of harness runs as one gigantic item — L0175 reported
// $1.62/item for the week of 2026-09-03 off a $3.38 "item" that was 25 daily
// pings, against a real item that cost $0.04. Harness rows now leave the
// population in fetchPerItem and are reported on their own line; --include-harness
// folds them back for a fully-loaded "what did the generator cost us" figure.
//
// Consequently this script calls NO provider API and needs no admin keys.
// Nothing here checks whether our token counts are COMPLETE — that is a
// separate measurement audit against the provider's metered totals, designed
// under "Known follow-ups" in docs/item-based-pricing.md.
//
// Requires: GRAFFITICODE_APP_CREDENTIALS.

import admin from 'firebase-admin';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { estimateUsdCost, usdCostFromReport } from '../src/lib/model-pricing';
import { PLANS, type PlanId } from '../src/lib/plans-config';
import { harnessKindOf } from '../src/lib/harness-item-ids';

// Load .env.local
const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {}

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

// ---------------------------------------------------------------- args

type Period = 'day' | 'week' | 'month';
const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };

const USAGE = `
Average AI cost to produce one item, for a period.

  npx tsx scripts/cost-per-item.ts [options]

  --period day|week|month   Window ending now, UTC-aligned (default: week)
  --from YYYY-MM-DD         Explicit window start (overrides --period)
  --to YYYY-MM-DD           Explicit window end, inclusive
  --env prod|local|all      Which environment's generations AND items to count
                            (default: all — training and local runs are real
                            generations producing real items, so their cost is
                            as good a measure as production's). Both sides take
                            this filter, so the ratio stays like-for-like.
                            Records written before the marker existed carry no
                            env and are counted under prod — the run says how
                            many, and suppresses the blended figure when the
                            generation side can be scoped but the item side
                            cannot.
  --exclude-trial           Divide by paid items only, not free-plan trial items
  --per-item                Also show the per-item cost distribution
                            (mean/median/p90). Only sees generations recorded
                            after per-item attribution shipped.
  --include-harness         Fold the internal generation harnesses — the daily
                            corpus ping and the weekly corpus sweep — back into
                            the ratio. They are EXCLUDED by default: both pass a
                            synthetic per-language itemId and create no item, so
                            their spend has no denominator, and grouping by
                            itemId turns a whole window of them into one giant
                            fake item. Use this only for a fully-loaded "what did
                            the generator cost us" figure, never for pricing.
  --lang <id>               Restrict to a language (0176, L0176 and 176 all work);
                            repeatable, so --lang 0158 --lang 0176 pools a family.
                            Both the cost and the item count are narrowed to it,
                            so cost per item stays a like-for-like ratio.
  --outcome all|success|failed
                            Which generations to price (default: all — a failed
                            generation spent real tokens, so excluding it
                            understates what producing an item costs, on the
                            same reasoning that keeps unattributed generations
                            in). Records written before failure recording
                            shipped carry no outcome field and are counted as
                            successes, so "success" does not silently empty
                            every older window.
  --min-items <n>           Drop any language with fewer than n items created in
                            the window (default: 10; 0 disables). A language with
                            a handful of items has an average one item wide, and
                            it moves the blended figure out of all proportion to
                            the traffic it represents. Dropped from BOTH sides,
                            and the run always lists what it dropped.
  --exclude-lang <id>       The inverse: drop a language from BOTH sides, to ask
                            what the blended figure looks like without an
                            outlier dialect. Repeatable. Unlike --lang this
                            keeps the blended figure, since the remainder is
                            still a whole population divided by its own cost.
  --as-of YYYY-MM-DD        Price the SAME tokens on the SAME models at this
                            date's rate card (default: today). Rates move on
                            their own — intro pricing expires, list prices fall —
                            so this asks "are these prices profitable against
                            today's costs", holding usage constant. It is not
                            what we were billed.
  --by-lang                 Average item cost broken down by language. Implies
                            --per-item, since it reads the per-item attribution.
  --output <file.html>      Also write an HTML report (open it in a browser)
  --json                    Emit JSON to stdout (progress goes to stderr)
  --help, -h                Show this

Cost is our own recorded tokens priced with MODEL_RATES; no provider API is
called. Records written before per-item attribution shipped carry no tokens and
are excluded — the script says how many it skipped.

Env: GRAFFITICODE_APP_CREDENTIALS.
`.trim();

interface Opts {
  period: Period;
  from?: string;
  to?: string;
  excludeTrial: boolean;
  perItem: boolean;
  langs: string[];
  excludeLangs: string[];
  minItems: number;
  outcome: 'all' | 'success' | 'failed';
  output?: string;
  json: boolean;
  /**
   * Rate card to price with. The report answers "what would these same tokens,
   * on these same models, cost at this date's prices" — a forward-looking
   * pricing question, not an accounting one. Defaults to today.
   */
  asOf: Date;
  byLang: boolean;
  env: 'prod' | 'local' | 'all';
  /** Fold the internal harnesses' spend back into the ratio (see --include-harness). */
  includeHarness: boolean;
}

/**
 * When failure recording shipped. Before this instant a generation that failed
 * wrote no usage row at all — it threw ~350 lines before the recorder — so every
 * window ending earlier prices SUCCESSES ONLY, whatever --outcome says. The run
 * warns rather than letting a window that straddles this look like a cost jump.
 */
const FAILURE_RECORDING_SINCE = Date.parse('2026-09-03T01:04:00Z');

/** Records store a bare 4-digit id ("0176"); accept the L-prefixed and unpadded forms too. */
function normalizeLang(raw: string): string {
  const digits = String(raw).trim().replace(/^L/i, '');
  return /^\d+$/.test(digits) ? digits.padStart(4, '0') : digits;
}

/**
 * The single language filter, applied identically to generations and to items —
 * cost per item is only meaningful when both sides cover the same population,
 * so an include or exclude that reached only one of them would reintroduce the
 * mismatch documented at the top of this file.
 */
function langKept(raw: unknown, langs: string[], excludeLangs: string[]): boolean {
  const lang = normalizeLang(String(raw ?? ''));
  if (langs.length > 0 && !langs.includes(lang)) return false;
  if (excludeLangs.includes(lang)) return false;
  return true;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  const opts: Opts = {
    period: 'week',
    excludeTrial: false,
    perItem: false,
    langs: [],
    excludeLangs: [],
    minItems: 10,
    outcome: 'all',
    json: false,
    asOf: new Date(),
    byLang: false,
    // The corpus ping and sweep produce NO item, so their spend has no
    // denominator to divide by. Default is to keep them out of the ratio and
    // report them separately.
    includeHarness: false,
    // `all`, not `prod`: the numerator and denominator are both scoped by this,
    // and excluding training runs would throw away real generations that
    // produced real items.
    env: 'all',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--period' && args[i + 1]) { opts.period = args[++i] as Period; }
    else if (a === '--from' && args[i + 1]) { opts.from = args[++i]; }
    else if (a === '--to' && args[i + 1]) { opts.to = args[++i]; }
    else if (a === '--exclude-trial') { opts.excludeTrial = true; }
    else if (a === '--per-item') { opts.perItem = true; }
    else if (a === '--include-harness') { opts.includeHarness = true; }
    else if (a === '--lang' && args[i + 1]) { opts.langs.push(normalizeLang(args[++i])); }
    else if (a === '--exclude-lang' && args[i + 1]) { opts.excludeLangs.push(normalizeLang(args[++i])); }
    else if (a === '--outcome' && args[i + 1]) {
      const v = args[++i];
      if (v !== 'all' && v !== 'success' && v !== 'failed') {
        console.error(`Error: --outcome must be all, success or failed (got "${v}")`);
        process.exit(1);
      }
      opts.outcome = v;
    }
    else if (a === '--min-items' && args[i + 1]) {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        console.error(`Error: --min-items must be a non-negative integer (got "${raw}")`);
        process.exit(1);
      }
      opts.minItems = n;
    }
    else if (a === '--output' && args[i + 1]) { opts.output = args[++i]; }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--by-lang') { opts.byLang = true; opts.perItem = true; }
    else if (a === '--env' && args[i + 1]) {
      const v = args[++i];
      if (v !== 'prod' && v !== 'local' && v !== 'all') {
        console.error(`Error: --env must be prod, local or all (got "${v}")`);
        process.exit(1);
      }
      opts.env = v;
    }
    else if (a === '--as-of' && args[i + 1]) {
      const raw = args[++i];
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        console.error(`Error: --as-of must be YYYY-MM-DD (got "${raw}")`);
        process.exit(1);
      }
      opts.asOf = d;
    }
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!opts.from && !['day', 'week', 'month'].includes(opts.period)) {
    console.error('Error: --period must be "day", "week", or "month"');
    process.exit(1);
  }
  const contradictory = opts.excludeLangs.filter(l => opts.langs.includes(l));
  if (contradictory.length > 0) {
    console.error(`Error: ${contradictory.join(', ')} passed to both --lang and --exclude-lang (empty result)`);
    process.exit(1);
  }
  // Provider spend can't be split by language, so a language scope is only
  // answerable from the attributed records. An EXCLUSION needs no such promotion:
  // it leaves a whole population behind, which the aggregate path counts fine.
  if (opts.langs.length > 0) {
    opts.perItem = true;
    // An explicit --lang IS the scope the caller asked for. Thresholding it away
    // would answer with an empty report instead of the small language they named.
    opts.minItems = 0;
  }
  return opts;
}

/**
 * One window, used verbatim for all three queries. The Anthropic 1d bucket
 * snaps to UTC midnight, so the item count has to use the identical UTC
 * instants or the ratio compares different periods.
 */
function resolveWindow(opts: Opts): { start: Date; end: Date } {
  const now = new Date();
  const utcMidnight = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z');

  const end = opts.to
    ? new Date(new Date(opts.to + 'T00:00:00Z').getTime() + 86_400_000) // --to is inclusive
    : now;
  const start = opts.from
    ? new Date(opts.from + 'T00:00:00Z')
    : new Date(utcMidnight.getTime() - (PERIOD_DAYS[opts.period] - 1) * 86_400_000);

  if (!(start < end)) {
    console.error('Error: --from must be before --to');
    process.exit(1);
  }
  return { start, end };
}

// ---------------------------------------------------------------- firestore

function toMillis(v: any): number {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'string') return new Date(v).getTime();
  return 0;
}

interface ItemCounts {
  /** Items created in the window, per normalized language id ('' = unrecorded). */
  byLang: Record<string, number>;
  /** day -> lang -> count, so the daily series can be folded after exclusions. */
  byDayLang: Record<string, Record<string, number>>;
  unmarked: number;
}

/**
 * Items created in the window.
 *
 * The `type` filter is load-bearing beyond selecting the right event: the
 * `usage` collection also holds per-uid counter docs (`usage/{uid}`, carrying
 * `currentMonthTotal` and no `type` field), which an unfiltered scan picks up.
 * The date is filtered in JS to avoid needing a (type, createdAt) composite
 * index — the established convention in these scripts.
 */
async function countItems(
  start: Date, end: Date, langs: string[] = [], env: 'prod' | 'local' | 'all' = 'all',
): Promise<ItemCounts> {
  const snap = await db.collection('usage')
    .where('type', '==', 'item_created')
    .select('createdAt', 'lang', 'env')
    .get();

  let unmarked = 0;
  const byLang: Record<string, number> = {};
  const byDayLang: Record<string, Record<string, number>> = {};
  for (const doc of snap.docs) {
    const d = doc.data();
    // Only the INCLUDE filter runs here. Exclusions are applied by the caller,
    // because the thin-language threshold is derived from these very counts and
    // so cannot be known during the scan.
    if (!langKept(d.lang, langs, [])) continue;
    const ms = toMillis(d.createdAt);
    if (ms < start.getTime() || ms >= end.getTime()) continue;
    // Same convention as the generation side: no `env` means the record predates
    // the marker, counted under prod so history stays readable, and surfaced so
    // the dilution is visible. `recordBillableItem` stamps it going forward.
    //
    // `unmarked` counts every pre-marker doc in the window, whether the filter
    // keeps it or not: it answers "can this side be scoped by env at all", which
    // is what the like-for-like guard needs. Counting only the KEPT ones missed
    // the --env local mirror of the bug (all pre-marker items dropped from the
    // denominator while local generations stayed in the numerator).
    const recordEnv: string | null = d.env ?? null;
    if (recordEnv === null) unmarked++;
    if (env !== 'all' && (env === 'prod' ? recordEnv === 'local' : recordEnv !== 'local')) continue;
    const lang = normalizeLang(String(d.lang ?? ''));
    byLang[lang] = (byLang[lang] || 0) + 1;
    const day = new Date(ms).toISOString().split('T')[0];
    (byDayLang[day] ??= {})[lang] = (byDayLang[day]?.[lang] || 0) + 1;
  }
  return { byLang, byDayLang, unmarked };
}

/**
 * Collapse the per-language item tallies once the excluded set is known.
 * Exclusion has to happen here rather than in the scan so that the threshold
 * can be computed from the unfiltered counts.
 */
function foldItemCounts(
  counts: ItemCounts, excluded: Set<string>,
): { total: number; byDay: Record<string, number>; unmarked: number } {
  let total = 0;
  const byDay: Record<string, number> = {};
  for (const [lang, n] of Object.entries(counts.byLang)) {
    if (excluded.has(lang)) continue;
    total += n;
  }
  for (const [day, langs] of Object.entries(counts.byDayLang)) {
    let n = 0;
    for (const [lang, c] of Object.entries(langs)) if (!excluded.has(lang)) n += c;
    if (n > 0) byDay[day] = n;
  }
  return { total, byDay, unmarked: counts.unmarked };
}

/**
 * Free-plan trial items in the window, from the per-UTC-day counters that
 * `recordTrialItem` maintains. Trial items are also written as `item_created`
 * under the shared trial uid, so this is the subset — not an addition.
 */
async function countTrialItems(start: Date, end: Date): Promise<{ total: number; byDay: Record<string, number> }> {
  const refs: FirebaseFirestore.DocumentReference[] = [];
  const days: string[] = [];
  for (let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
       d < end.getTime();
       d += 86_400_000) {
    const day = new Date(d);
    const iso = day.toISOString().split('T')[0];
    days.push(iso);
    refs.push(db.collection('free-plan-state').doc(`items-${iso.replace(/-/g, '')}`));
  }
  if (refs.length === 0) return { total: 0, byDay: {} };

  const snaps = await db.getAll(...refs);
  let total = 0;
  const byDay: Record<string, number> = {};
  snaps.forEach((s, i) => {
    const n = Number(s.data()?.count);
    if (!Number.isFinite(n) || n === 0) return;
    total += n;
    byDay[days[i]] = n;
  });
  return { total, byDay };
}

// ------------------------------------------------------- per-item attribution

interface GenRecord {
  userId: string;
  itemId: string | null;
  taskId: string | null;
  usd: number;
  lang: string | null;
  model: string | null;
  provider: 'anthropic' | 'openai';
  day: string;
  tokens: TokenTotals;
  instrumented: boolean;
}

/** Our own record shape — not the provider's. Cache is split two ways, not by TTL. */
interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

const emptyTokens = (): TokenTotals => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

/** Every token the call touched, cache included — cache reads usually dominate. */
const sumTokens = (t: TokenTotals): number => t.input + t.output + t.cacheCreation + t.cacheRead;

const addTokens = (into: TokenTotals, t: TokenTotals) => {
  into.input += t.input;
  into.output += t.output;
  into.cacheCreation += t.cacheCreation;
  into.cacheRead += t.cacheRead;
};

interface LangCost { lang: string; items: number; usd: number; tokens: number; }

/**
 * Average item cost per language, ascending by language id. Attributed items
 * only — a
 * generation that never became an item has no language to charge it to. Shared
 * by the text and HTML views so the two cannot drift apart.
 */
function costByLang(byItem: PerItem['byItem']): LangCost[] {
  const acc = new Map<string, { items: number; usd: number; tokens: number }>();
  for (const v of byItem.values()) {
    // A stored `lang` is not guaranteed to be a language id — one record in prod
    // holds a bare newline, which is truthy, survives normalizeLang unchanged
    // (it fails the /^\d+$/ test and passes through), and would render as a
    // blank "L" row. Anything that is not four digits after normalising joins
    // the (unrecorded) bucket rather than inventing a language.
    const normalized = v.lang ? normalizeLang(String(v.lang)) : '';
    const key = /^\d{4}$/.test(normalized) ? `L${normalized}` : '(unrecorded)';
    const e = acc.get(key) ?? { items: 0, usd: 0, tokens: 0 };
    e.items++; e.usd += v.usd; e.tokens += v.tokens;
    acc.set(key, e);
  }
  return [...acc.entries()]
    .map(([lang, e]) => ({ lang, ...e }))
    .sort((a, b) => a.lang.localeCompare(b.lang));
}

interface PerItem {
  records: number;
  instrumented: number;
  attributedCost: number;
  unattributedCost: number;
  unattributedRecords: number;
  byItem: Map<string, { usd: number; gens: number; tokens: number; lang: string | null }>;
  /** Everything below is the window total, attributed or not — the headline's numerator. */
  costByModel: Record<string, number>;
  costByProvider: { anthropic: number; openai: number };
  tokens: TokenTotals;
  byDay: Record<string, { anthropic: number; openai: number; tokens: number }>;
  /** Counted records that predate the env marker (meaningful under --env prod). */
  unmarked: number;
  /** Generations excluded by the --env filter. Drives the like-for-like guard. */
  envDropped: number;
  /** Failed generations in the window, before any --outcome filter. */
  failedSeen: number;
  /** Generations excluded by the --outcome filter. */
  outcomeDropped: number;
  /** Priced spend of the FAILED generations that were kept. */
  failedUsd: number;
  /**
   * The internal harnesses, held apart from every total above. Real spend that
   * produces no item, so it belongs in neither half of a per-item ratio — but it
   * is never silently dropped: the run prints it.
   */
  harness: HarnessSpend;
}

/** Corpus ping / sweep spend, excluded from the ratio unless --include-harness. */
interface HarnessSpend {
  records: number;
  usd: number;
  tokens: TokenTotals;
  /** Per harness, so a run can tell a daily ping's cost from a weekly sweep's. */
  byKind: Record<string, { records: number; usd: number }>;
  /** Per language, ascending — this is where the fake per-item averages came from. */
  byLang: Record<string, { records: number; usd: number }>;
}

const emptyHarness = (): HarnessSpend => ({
  records: 0, usd: 0, tokens: emptyTokens(), byKind: {}, byLang: {},
});

/**
 * Cost per individual item, from the `ai_generation` usage records.
 *
 * This is the attributable view, and it only sees generations recorded after
 * per-item attribution shipped — earlier records carry `cost.total: 0` and no
 * task id, so they're counted as `legacy` rather than silently priced at zero.
 *
 * Resolution is two-step because a fresh create generates *before* its item
 * exists: use `itemId` when the record has one (an edit), otherwise map
 * `generatedTaskId` through `users/{uid}/versions`, which stores both.
 */
async function fetchPerItem(
  start: Date, end: Date, asOf: Date, langs: string[] = [], env: 'prod' | 'local' | 'all' = 'all',
  excludeLangs: string[] = [], outcome: 'all' | 'success' | 'failed' = 'all',
  includeHarness = false,
): Promise<PerItem> {
  const snap = await db.collection('usage')
    .where('type', '==', 'ai_generation')
    .select('createdAt', 'userId', 'itemId', 'generatedTaskId', 'cost', 'lang', 'model', 'tokens', 'provider', 'env', 'outcome')
    .get();

  const records: GenRecord[] = [];
  const harness = emptyHarness();
  let unmarked = 0;
  let envDropped = 0;
  let failedSeen = 0;
  let outcomeDropped = 0;
  let failedUsd = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!langKept(d.lang, langs, excludeLangs)) continue;
    const ms = toMillis(d.createdAt);
    if (ms < start.getTime() || ms >= end.getTime()) continue;

    // The corpus ping and sweep pass a synthetic, CONSTANT-per-language itemId
    // and create nothing (src/lib/harness-item-ids.ts). They belong in NEITHER
    // half of a per-item ratio: the spend is real, but no item comes of it, so
    // dividing it by items charges customer items for infrastructure and makes
    // cost/item climb every time a language joins the ping set.
    //
    // Leaving them in did worse than inflate the blended figure. Grouping by
    // itemId collapsed a whole window of harness runs into ONE item, so the
    // per-item distribution and the --by-lang table reported those sums as
    // single items: in the week of 2026-09-03, L0175 read $1.62/item on the
    // strength of a $3.38 "item" that was 25 daily pings, while the one real
    // item it produced cost $0.04. Fleet-wide the two harnesses were 64% of
    // that window's spend across 51% of its generations.
    //
    // Detected on the raw `itemId`, not the resolved one: a harness always
    // passes its id outright, so this never depends on the versions join below.
    const harnessKind = includeHarness ? null : harnessKindOf(d.itemId);

    // No `env` means the record predates the marker. Counting those under prod
    // keeps history readable — dropping them would silently empty every window
    // older than this change — but the count is surfaced so the dilution is
    // visible. Counted AFTER the window filter, or it tallies the whole
    // collection and reports more pre-marker records than generations.
    //
    // Harness rows obey this filter (so --env local shows no ping spend) but do
    // not move the counters, which describe the population being reported.
    const recordEnv: string | null = d.env ?? null;
    if (env !== 'all') {
      if (env === 'prod' ? recordEnv === 'local' : recordEnv !== 'local') {
        if (!harnessKind) envDropped++;
        continue;
      }
      if (recordEnv === null && !harnessKind) unmarked++;
    }

    // The frozen figure is kept only to detect legacy records; the cost this
    // report divides is the SAME tokens on the SAME model re-priced at `asOf`.
    const frozen = Number(d.cost?.usd ?? d.cost?.total ?? 0);
    const t = (d.tokens ?? {}) as any;
    const provider = d.provider ?? (/^(gpt|o\d)/.test(String(d.model ?? '')) ? 'openai' : 'anthropic');
    const tokens: TokenTotals = {
      input: Number(t.input ?? 0),
      output: Number(t.output ?? 0),
      cacheCreation: Number(t.cacheCreation ?? 0),
      cacheRead: Number(t.cacheRead ?? 0),
    };
    const usd = estimateUsdCost({
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationInputTokens: tokens.cacheCreation,
      cacheReadInputTokens: tokens.cacheRead,
    }, d.model, asOf, provider);

    // Harness spend leaves here, BEFORE the outcome counters: a failed ping is
    // still harness spend, and letting it raise `failedSeen` would report a
    // failure count the cost total does not cover. Never dropped silently —
    // main() prints the whole of it.
    if (harnessKind) {
      const safeUsd = Number.isFinite(usd) ? usd : 0;
      harness.records++;
      harness.usd += safeUsd;
      addTokens(harness.tokens, tokens);
      const k = (harness.byKind[harnessKind] ??= { records: 0, usd: 0 });
      k.records++; k.usd += safeUsd;
      const norm = normalizeLang(String(d.lang ?? ''));
      const langKey = /^\d{4}$/.test(norm) ? `L${norm}` : '(unrecorded)';
      const l = (harness.byLang[langKey] ??= { records: 0, usd: 0 });
      l.records++; l.usd += safeUsd;
      continue;
    }

    // A record with no `outcome` predates failure recording. It is counted as a
    // SUCCESS rather than dropped: those rows are the entire history, and
    // filtering them out on equality would empty every older window.
    const recordOutcome: string = d.outcome === 'failed' ? 'failed' : 'success';
    if (recordOutcome === 'failed') failedSeen++;
    if (outcome !== 'all' && recordOutcome !== outcome) { outcomeDropped++; continue; }
    if (recordOutcome === 'failed') failedUsd += Number.isFinite(usd) ? usd : 0;
    records.push({
      userId: String(d.userId || ''),
      itemId: d.itemId ?? null,
      taskId: d.generatedTaskId ?? null,
      usd: Number.isFinite(usd) ? usd : 0,
      lang: d.lang ?? null,
      model: d.model ?? null,
      provider,
      day: new Date(ms).toISOString().slice(0, 10),
      tokens,
      // A record is instrumented if it has a priced cost (legacy pre-refactor docs)
      // OR it carries the new token-usage shape (stage + tokens from the refactor).
      // Legacy docs carry cost.total, new docs carry stage.
      instrumented: frozen > 0 || Boolean(d.stage) || (d.tokens?.total ?? 0) > 0,
    });
  }

  // taskId -> itemId, per user. Fetched per-user rather than as a collection
  // group query so it needs no extra composite index; the user count in a
  // reporting window is small.
  const uids = Array.from(new Set(records.filter(r => !r.itemId && r.taskId).map(r => r.userId)));
  const taskToItem = new Map<string, string>();
  await Promise.all(uids.map(async uid => {
    if (!uid) return;
    const vs = await db.collection(`users/${uid}/versions`).select('itemId', 'taskId').get();
    for (const v of vs.docs) {
      const { itemId, taskId } = v.data();
      if (itemId && taskId) taskToItem.set(`${uid}:${taskId}`, itemId);
    }
  }));

  const out: PerItem = {
    records: records.length,
    instrumented: records.filter(r => r.instrumented).length,
    attributedCost: 0,
    unattributedCost: 0,
    unattributedRecords: 0,
    byItem: new Map(),
    costByModel: {},
    costByProvider: { anthropic: 0, openai: 0 },
    tokens: emptyTokens(),
    byDay: {},
    unmarked,
    envDropped,
    failedSeen,
    outcomeDropped,
    failedUsd,
    harness,
  };

  for (const r of records) {
    if (!r.instrumented) continue;

    // Resolve the item BEFORE touching any total, because whether this record
    // belongs in the totals at all depends on what it resolves to.
    const itemId = r.itemId ?? (r.taskId ? taskToItem.get(`${r.userId}:${r.taskId}`) : undefined);

    // Window totals: every instrumented record that survived the filter above,
    // whether or not it resolves to an item, so the headline's numerator and
    // denominator come from one population.
    const model = r.model ?? '(unrecorded)';
    out.costByModel[model] = (out.costByModel[model] ?? 0) + r.usd;
    out.costByProvider[r.provider] += r.usd;
    addTokens(out.tokens, r.tokens);
    const day = (out.byDay[r.day] ??= { anthropic: 0, openai: 0, tokens: 0 });
    day[r.provider] += r.usd;
    day.tokens += sumTokens(r.tokens);

    if (!itemId) {
      // A generation that never became an item: it failed, or the item was
      // created outside the window. Real spend, deliberately not divided away.
      out.unattributedCost += r.usd;
      out.unattributedRecords++;
      continue;
    }
    out.attributedCost += r.usd;
    const cur = out.byItem.get(itemId) ?? { usd: 0, gens: 0, tokens: 0, lang: r.lang };
    cur.usd += r.usd;
    cur.gens++;
    cur.tokens += sumTokens(r.tokens);
    out.byItem.set(itemId, cur);
  }

  return out;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------------------------------------------------------------- html

const esc = (s: string) => s.replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

interface DayRow {
  day: string;
  items: number;
  trial: number;
  anthropic: number;
  openai: number;
  tokens: number;
}

interface HtmlInput {
  start: Date;
  end: Date;
  asOf: Date;
  env: string;
  totalItems: number;
  trialItems: number;
  paidItems: number;
  denominator: number;
  excludeTrial: boolean;
  tokens: TokenTotals;
  costByModel: Record<string, number>;
  costByProvider: { anthropic: number; openai: number };
  totalCost: number;
  rows: DayRow[];
  langRows: LangCost[];
  droppedLangs: { lang: string; items: number }[];
  thinLangRows: LangCost[];
  minItems: number;
  warnings: string[];
  /** The two sides could not be scoped to the same env — no blended figure. */
  blendedBlocked: boolean;
  /** Corpus ping + sweep, held out of every figure above. Zeroed under --include-harness. */
  harness: HarnessSpend;
}

function generateHtml(d: HtmlInput): string {
  const totalCost = d.totalCost;
  const perItem = d.denominator > 0 && !d.blendedBlocked ? totalCost / d.denominator : null;

  // Bars are scaled to the largest value in their own column, so each column
  // reads as a shape rather than being flattened by an unrelated maximum.
  const maxCost = Math.max(...d.rows.map(r => r.anthropic + r.openai), 0.000001);
  const maxItems = Math.max(...d.rows.map(r => r.items), 1);
  const maxPer = Math.max(...d.rows.map(r => (r.items > 0 ? (r.anthropic + r.openai) / r.items : 0)), 0.000001);

  const card = (label: string, value: string, note = '') =>
    `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${
      note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;

  const maxDayTokPer = Math.max(...d.rows.map(r => (r.items > 0 ? r.tokens / r.items : 0)), 1);
  const dayRows = d.rows.map(r => {
    const cost = r.anthropic + r.openai;
    const per = r.items > 0 ? cost / r.items : null;
    const tokPer = r.items > 0 ? r.tokens / r.items : null;
    return `<tr>
      <td class="mono">${esc(r.day)}</td>
      <td class="num">${r.items.toLocaleString()}${r.trial ? ` <span class="dim">(${r.trial} trial)</span>` : ''}
        <span class="bar"><span style="width:${(r.items / maxItems) * 100}%"></span></span></td>
      <td class="num">${per === null ? '<span class="dim">—</span>' : `$${per.toFixed(4)}`}
        <span class="bar"><span style="width:${per === null ? 0 : (per / maxPer) * 100}%"></span></span></td>
      <td class="num">${tokPer === null ? '<span class="dim">—</span>' : Math.round(tokPer).toLocaleString()}
        <span class="bar"><span style="width:${tokPer === null ? 0 : (tokPer / maxDayTokPer) * 100}%"></span></span></td>
    </tr>`;
  }).join('\n');

  const modelRows = Object.entries(d.costByModel)
    .sort((a, b) => b[1] - a[1])
    .map(([model, cost]) => `<tr>
      <td class="mono">${esc(model)}</td>
      <td class="num">$${cost.toFixed(4)}</td>
      <td class="num">${totalCost > 0 ? ((cost / totalCost) * 100).toFixed(1) : '0.0'}%
        <span class="bar"><span style="width:${totalCost > 0 ? (cost / totalCost) * 100 : 0}%"></span></span></td>
    </tr>`).join('\n');

  // Same columns, same order, same bar treatment as the By day table, so the
  // two read as one view sliced two ways. Each bar scales to its own column's
  // maximum.
  const maxLangItems = Math.max(...d.langRows.map(l => l.items), 1);
  const maxLangPer = Math.max(...d.langRows.map(l => l.usd / l.items), 0.000001);
  const maxLangTokPer = Math.max(...d.langRows.map(l => l.tokens / l.items), 1);
  const langRows = d.langRows.map(l => {
    const per = l.usd / l.items;
    const tokPer = l.tokens / l.items;
    return `<tr>
      <td class="mono">${esc(l.lang)}</td>
      <td class="num">${l.items.toLocaleString()}
        <span class="bar"><span style="width:${(l.items / maxLangItems) * 100}%"></span></span></td>
      <td class="num">$${per.toFixed(4)}
        <span class="bar"><span style="width:${(per / maxLangPer) * 100}%"></span></span></td>
      <td class="num">${Math.round(tokPer).toLocaleString()}
        <span class="bar"><span style="width:${(tokPer / maxLangTokPer) * 100}%"></span></span></td>
    </tr>`;
  }).join('\n');

  const tokenRows = ([
    ['Input', d.tokens.input],
    ['Cache write', d.tokens.cacheCreation],
    ['Cache read', d.tokens.cacheRead],
    ['Output', d.tokens.output],
  ] as [string, number][]).map(([label, n]) =>
    `<tr><td>${esc(label)}</td><td class="num">${n.toLocaleString()}</td></tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cost per item — ${esc(d.start.toISOString().split('T')[0])} to ${esc(d.end.toISOString().split('T')[0])}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f8fafc; --fg:#1e293b; --dim:#64748b; --line:#e2e8f0; --panel:#fff; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f172a; --fg:#e2e8f0; --dim:#94a3b8; --line:#1e293b; --panel:#1e293b; --accent:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px; background:var(--bg); color:var(--fg);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 940px; margin: 0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:32px 0 10px; font-weight:600; }
  .sub { color:var(--dim); margin-bottom:24px; font-size:13px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .card .label { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card .value { font-size:24px; font-weight:600; margin-top:4px; }
  .card .note { color:var(--dim); font-size:12px; margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:var(--panel);
    border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th { text-align:left; font-size:12px; color:var(--dim); font-weight:600;
    padding:9px 12px; border-bottom:1px solid var(--line); text-transform:uppercase; letter-spacing:.04em; }
  td { padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .num { text-align:right; white-space:nowrap; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .dim { color:var(--dim); }
  .bar { display:block; height:3px; background:var(--line); border-radius:2px; margin-top:5px; }
  .bar > span { display:block; height:100%; background:var(--accent); border-radius:2px; }
  .warn { background:var(--panel); border:1px solid var(--accent); border-left-width:3px;
    border-radius:6px; padding:11px 14px; margin-bottom:12px; font-size:13px; }
  .scroll { overflow-x:auto; }
  footer { color:var(--dim); font-size:12px; margin-top:32px; line-height:1.7; }
</style></head><body><main>

<h1>Cost per item</h1>
<div class="sub">${esc(d.start.toISOString())} → ${esc(d.end.toISOString())} (UTC) · env ${esc(d.env)} · priced at the ${esc(d.asOf.toISOString().split('T')[0])} rate card</div>

${d.warnings.map(w => `<div class="warn"><strong>Warning:</strong> ${esc(w)}</div>`).join('\n')}

<div class="cards">
  ${card('Cost per item', perItem === null ? '—' : `$${perItem.toFixed(4)}`,
    d.blendedBlocked ? 'withheld — see warning'
      : d.excludeTrial ? 'paid items only' : 'all items incl. trial')}
  ${card('Total AI cost', `$${totalCost.toFixed(2)}`,
    `Anthropic $${d.costByProvider.anthropic.toFixed(2)} · OpenAI $${d.costByProvider.openai.toFixed(2)}`)}
  ${card('Items created', d.totalItems.toLocaleString(), `${d.paidItems} paid · ${d.trialItems} trial`)}
  ${d.harness.records > 0
    ? card('Harness (excluded)', `$${d.harness.usd.toFixed(2)}`,
        `${d.harness.records.toLocaleString()} gen(s) · ${Object.entries(d.harness.byKind)
          .sort((a, b) => b[1].usd - a[1].usd)
          .map(([k, v]) => `${esc(k)} $${v.usd.toFixed(2)}`).join(' · ')} — creates no item`)
    : ''}
</div>

<h2>By day</h2>
<div class="scroll"><table>
  <tr><th>Day</th><th class="num">Items</th><th class="num">Cost / item</th><th class="num">Tokens / item</th></tr>
  ${dayRows || '<tr><td colspan="4" class="dim">No data in this window.</td></tr>'}
</table></div>

<h2>By language</h2>
<div class="sub">Attributed items only — a generation that never became an item has no language to charge it to.</div>
<div class="scroll"><table>
  <tr><th>Language</th><th class="num">Items</th><th class="num">Cost / item</th><th class="num">Tokens / item</th></tr>
  ${langRows || '<tr><td colspan="4" class="dim">No attributed items in this window.</td></tr>'}
</table></div>
${d.droppedLangs.length === 0 ? '' : `<div class="sub" style="margin-top:10px">
  Excluded from this whole report (fewer than ${d.minItems} items created in the window, so the
  average would be a few items wide): ${esc(d.droppedLangs.map(t => `${t.lang} (${t.items})`).join(', '))}.
  Their cost and their items are both dropped, so every figure above is a whole population over its own spend.
</div>`}
${d.thinLangRows.length === 0 ? '' : `<div class="sub" style="margin-top:6px">
  Rows hidden — cleared the ${d.minItems}-item bar on items created, but fewer than ${d.minItems} of their items
  have a generation record joined to them, so the average would still be a few items wide:
  ${esc(d.thinLangRows.map(r => `${r.lang || '(unrecorded)'} (${r.items})`).join(', '))}. Hiding a row changes no total above.
</div>`}

<h2>By model</h2>
<div class="scroll"><table>
  <tr><th>Model</th><th class="num">Cost</th><th class="num">Share</th></tr>
  ${modelRows || '<tr><td colspan="3" class="dim">No Anthropic usage in this window.</td></tr>'}
</table></div>

<h2>Tokens</h2>
<div class="scroll"><table>
  <tr><th>Class</th><th class="num">Tokens</th></tr>
  ${tokenRows}
</table></div>

<footer>
  Cost is read from the provider APIs, not from our own telemetry &mdash; the Firestore
  <code>ai_generation</code> records omit cache tokens entirely and never saw an embedding.
  Cost is <em>our</em> recorded token counts priced with <code>MODEL_RATES</code> &mdash; not what a
  provider billed. It covers every recorded stage (scope-gate routing, composition, spec generation,
  generation, repair, judge) and can be split per language, per item and per stage.
  Nothing here checks whether those counts are <em>complete</em>; that is a separate audit against the
  provider's metered totals.
  <br>Generated ${esc(new Date().toISOString())} by <code>scripts/cost-per-item.ts</code>.
</footer>

</main></body></html>`;
}

// ---------------------------------------------------------------- main

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const num = (n: number) => n.toLocaleString();
const pad = (label: string) => label.padEnd(23);

async function main() {
  const opts = parseArgs(process.argv);
  const { start, end } = resolveWindow(opts);

  console.error(`Window: ${start.toISOString()} → ${end.toISOString()}`);
  console.error(`Rate card: ${opts.asOf.toISOString().split('T')[0]}`);

  // One scan over our own ai_generation records supplies everything: the window
  // total, the per-model and per-provider split, and the per-item attribution.
  // Items are counted FIRST, because the thin-language threshold is derived from
  // the per-language item counts and then applied to the generation side. Doing
  // it the other way round would price languages the denominator has dropped.
  console.error('Counting items...');
  const [itemCounts, trial] = await Promise.all([
    countItems(start, end, opts.langs, opts.env),
    // The trial counter is a per-day tally with no language dimension, so it
    // can't be narrowed. Zeroed under --lang rather than reported as a subset
    // of a different population.
    opts.langs.length > 0
      ? Promise.resolve({ total: 0, byDay: {} as Record<string, number> })
      : countTrialItems(start, end),
  ]);

  // A language with only a handful of items in the window has an average that is
  // one item wide: L0166's two items read $0.99 each and pulled the blended
  // figure up by 60%. Those languages are dropped from BOTH sides — cost and
  // item count — so what remains is still a whole population over its own spend.
  // The unrecorded bucket ('') is never thresholded: it is not a language, and
  // dropping it would silently shrink the denominator by real items.
  const thinLangs = Object.entries(itemCounts.byLang)
    .filter(([lang, n]) => lang !== '' && n < opts.minItems)
    .map(([lang, n]) => ({ lang, items: n }))
    .sort((a, b) => a.lang.localeCompare(b.lang));
  const excluded = new Set([...opts.excludeLangs, ...thinLangs.map(t => t.lang)]);

  const items = foldItemCounts(itemCounts, excluded);

  console.error('Reading token usage...');
  const perItem = await fetchPerItem(start, end, opts.asOf, opts.langs, opts.env, [...excluded], opts.outcome, opts.includeHarness);

  const totalItems = items.total;
  const trialItems = trial.total;

  // Every record we priced, attributed to an item or not. Both halves are real
  // spend, so the headline divides the whole window's cost by the whole window's
  // items rather than silently dropping the unattributed part.
  //
  // The denominator needs no matching harness exclusion: the ping and sweep
  // write no item_created, so `countItems` never saw them. That asymmetry is
  // the whole point — harness spend had a numerator and no denominator.
  const { costByModel, costByProvider, tokens: totals } = perItem;
  const totalCost = perItem.attributedCost + perItem.unattributedCost;
  const paidItems = Math.max(0, totalItems - trialItems);
  const denominator = opts.excludeTrial ? paidItems : totalItems;
  // Two different populations carry the same threshold. The report-wide drop
  // above is measured on items CREATED (the denominator). The by-language table
  // is measured on items ATTRIBUTED — only ~half of created items have a
  // generation record joined to them — so a language can clear the first bar and
  // still show a one-item average here. Both are the thin-average problem, so
  // both are held to `minItems`; hiding a table row changes no total.
  const allLangRows = costByLang(perItem.byItem);
  const langRows = opts.minItems > 0
    ? allLangRows.filter(r => r.items >= opts.minItems)
    : allLangRows;
  const thinLangRows = allLangRows.filter(r => !langRows.includes(r));

  // The one way this can read plausibly but be wrong: records that predate the
  // token-usage refactor carry no tokens, so they price at nothing. Excluding
  // them is right — they cannot be priced — but it must not be silent.
  const warnings: string[] = [];
  // The like-for-like guard. Cost per item is only meaningful when the two sides
  // cover the same population. `--env prod` can scope the generations (they were
  // marked first) while leaving pre-marker items unscoped, which is exactly how
  // this read 7x too cheap: 2,165 local training generations dropped from the
  // numerator, their 873 items kept in the denominator. When that asymmetry is
  // present the blended figure is withheld rather than printed with a caveat —
  // a wrong number with a footnote still gets quoted.
  // The free-plan trial tally is a per-day counter with no language dimension,
  // so it cannot follow an exclusion the way both other sides do. The blended
  // figure is unaffected (it divides by `totalItems`), but the paid/trial SPLIT
  // — and therefore --exclude-trial — would over-count trial items if any of
  // them were in the dropped language.
  if (excluded.size > 0 && trialItems > 0) {
    warnings.push(
      `Trial items (${num(trialItems)}) are counted by a per-day tally with no language dimension, so it ` +
      `cannot follow a language exclusion (${[...excluded].sort().join(', ')}). The blended cost per item ` +
      `is unaffected — it divides by all items — but the paid/trial split shown above, and --exclude-trial, ` +
      `over-count trial items by however many of them were in an excluded language.`,
    );
  }
  // The discontinuity guard. Failed generations were invisible before
  // FAILURE_RECORDING_SINCE, so a window ending earlier prices successes only no
  // matter what --outcome says, and a window that STRADDLES the boundary mixes
  // two different measurements — which would read as a cost jump rather than as
  // instrumentation arriving. Say so instead of letting it be inferred.
  if (start.getTime() < FAILURE_RECORDING_SINCE) {
    const straddles = end.getTime() > FAILURE_RECORDING_SINCE;
    warnings.push(
      straddles
        ? `This window straddles ${new Date(FAILURE_RECORDING_SINCE).toISOString().slice(0, 10)}, when failed generations began being recorded. ` +
          `Spend before that instant counts successes only, so part of this window is measured differently from the rest — ` +
          `a rise against an earlier window may be the instrumentation, not the cost. Use --outcome success to compare like with like.`
        : `Failed generations were not recorded before ${new Date(FAILURE_RECORDING_SINCE).toISOString().slice(0, 10)}, so this window ` +
          `prices successes only whatever --outcome says, and understates true cost per item by the failures it cannot see.`,
    );
  }
  const blendedBlocked = opts.env !== 'all' && perItem.envDropped > 0 && items.unmarked > 0;
  if (blendedBlocked) {
    warnings.push(
      `Cost per item withheld: --env ${opts.env} dropped ${num(perItem.envDropped)} generation(s), but ` +
      `${num(items.unmarked)} of the ${num(totalItems)} item(s) in this window predate the env marker on ` +
      `item_created and cannot be scoped the same way. Dividing one population by another is how this ` +
      `report has been wrong before. Use --env all, or pick a window that postdates the marker.`,
    );
  }
  if (opts.env === 'prod' && perItem.unmarked > 0 && perItem.instrumented > 0
      && perItem.unmarked / perItem.instrumented > 0.5) {
    warnings.push(
      `${perItem.unmarked} of ${perItem.instrumented} counted generation(s) predate the env marker, ` +
      `so --env prod cannot exclude local development from most of this window. Treat the figure as ` +
      `an upper bound until the window falls entirely after the marker shipped.`,
    );
  }
  const legacy = perItem.records - perItem.instrumented;
  if (legacy > 0) {
    warnings.push(
      `${legacy} of ${perItem.records} ai_generation record(s) in this window predate the ` +
      `token-usage refactor: they carry no token counts and are excluded from the total, ` +
      `so cost per item is understated for windows reaching back before it shipped.`,
    );
  }
  if (totalCost === 0 && totalItems > 0) {
    warnings.push(
      `${totalItems} item(s) were created but no token usage was recorded for them. ` +
      `Either the generations happened outside this window, or recordTokenUsage is ` +
      `not firing — check that the deployed revision carries the token-usage layer.`,
    );
  }

  // Per-day series for the HTML view. Built from the union of every day that
  // has either spend or items, so a day with one and not the other still shows.
  const dayKeys = Array.from(new Set([
    ...Object.keys(perItem.byDay),
    ...Object.keys(items.byDay),
  ])).sort();
  const rows: DayRow[] = dayKeys.map(day => ({
    day,
    items: items.byDay[day] || 0,
    trial: trial.byDay[day] || 0,
    anthropic: perItem.byDay[day]?.anthropic ?? 0,
    openai: perItem.byDay[day]?.openai ?? 0,
    tokens: perItem.byDay[day]?.tokens ?? 0,
  }));

  if (opts.output) {
    const html = generateHtml({
      start, end,
      asOf: opts.asOf,
      env: opts.env,
      totalItems, trialItems, paidItems, denominator, excludeTrial: opts.excludeTrial,
      blendedBlocked,
      tokens: totals, costByModel, costByProvider, totalCost,
      harness: perItem.harness,
      rows, langRows, warnings,
      droppedLangs: thinLangs,
      hiddenLangRows: thinLangRows, thinLangRows, minItems: opts.minItems,
    });
    writeFileSync(opts.output, html, 'utf-8');
    console.error(`Wrote ${opts.output}`);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      window: { start: start.toISOString(), end: end.toISOString() },
      daily: rows,
      asOf: opts.asOf.toISOString(),
      env: opts.env,
      unmarkedRecords: perItem.unmarked,
      warnings,
      langs: opts.langs.length > 0 ? opts.langs : null,
      minItems: opts.minItems,
      outcome: opts.outcome,
      failedGenerations: perItem.failedSeen,
      failedUsd: perItem.failedUsd,
      outcomeDropped: perItem.outcomeDropped,
      droppedLangs: thinLangs,
      excludedLangs: [...excluded].sort(),
      items: { total: totalItems, trial: trialItems, paid: paidItems, denominator, unmarked: items.unmarked },
      envDroppedGenerations: perItem.envDropped,
      includeHarness: opts.includeHarness,
      // Null when folded in, so a consumer cannot double-count it against `cost`.
      harness: opts.includeHarness ? null : {
        records: perItem.harness.records,
        usd: perItem.harness.usd,
        tokens: perItem.harness.tokens,
        byKind: perItem.harness.byKind,
        byLang: perItem.harness.byLang,
      },
      blendedBlocked,
      tokens: totals,
      cost: {
        byModel: costByModel,
        byProvider: costByProvider,
        total: totalCost,
      },
      perItem: perItem ? (() => {
        const costs = Array.from(perItem.byItem.values()).map(v => v.usd).sort((a, b) => a - b);
        return {
          records: perItem.records,
          legacyRecords: perItem.records - perItem.instrumented,
          itemsWithCost: costs.length,
          attributedCost: perItem.attributedCost,
          unattributedCost: perItem.unattributedCost,
          unattributedRecords: perItem.unattributedRecords,
          mean: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
          median: costs.length ? quantile(costs, 0.5) : null,
          p90: costs.length ? quantile(costs, 0.9) : null,
          min: costs.length ? costs[0] : null,
          max: costs.length ? costs[costs.length - 1] : null,
        };
      })() : null,
      costPerItem: denominator > 0 && !blendedBlocked ? {
        total: totalCost / denominator,
        anthropic: costByProvider.anthropic / denominator,
        openai: costByProvider.openai / denominator,
      } : null,
    }, null, 2));
    process.exit(0);
  }

  const label = `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`;
  const langLabel = opts.langs.length > 0 ? ` · lang ${opts.langs.join('+')}` : '';
  console.log(`\n=== Cost per item — ${label} (UTC)${langLabel} ===`);
  console.log(`${pad('Items created')}: ${num(totalItems)}`);
  console.log(`${pad('  paid accounts')}: ${num(paidItems)}`);
  console.log(`${pad('  free-plan trial')}: ${num(trialItems)}`);
  if (thinLangs.length > 0) {
    const dropped = thinLangs.map(t => `${t.lang} (${t.items})`).join(', ');
    console.log(`${pad('  excluded (<' + opts.minItems + ' items)')}: ${dropped}`);
  }

  console.log(`\nTokens recorded — env ${opts.env}, priced at the ${opts.asOf.toISOString().split('T')[0]} rate card`);
  console.log(`${pad('  input')}: ${num(totals.input)} tok`);
  console.log(`${pad('  cache write / read')}: ${num(totals.cacheCreation)} / ${num(totals.cacheRead)} tok`);
  console.log(`${pad('  output')}: ${num(totals.output)} tok`);
  console.log(`${pad('  generations')}: ${num(perItem.instrumented)}`);
  if (opts.outcome !== 'all') {
    console.log(`${pad('  outcome filter')}: ${opts.outcome}  (${num(perItem.outcomeDropped)} record(s) excluded)`);
  }
  if (perItem.failedSeen > 0) {
    console.log(`${pad('  failed generations')}: ${num(perItem.failedSeen)}${perItem.failedUsd > 0 ? `  ${usd(perItem.failedUsd)} of the total` : ''}`);
  }
  if (opts.env !== 'all' && perItem.unmarked > 0) {
    console.log(`${pad('  pre-marker records')}: ${num(perItem.unmarked)}  (no env field — counted here, may include local work)`);
  }
  console.log(`${pad('  Anthropic')}: ${usd(costByProvider.anthropic)}`);
  console.log(`${pad('  OpenAI')}: ${usd(costByProvider.openai)}`);
  console.log(`${' '.repeat(25)}--------`);
  console.log(`${pad('Total AI cost')}: ${usd(totalCost)}`);

  // Excluded, but never invisible: this is real money, and a reader comparing
  // against a provider invoice has to be able to find it. Shown right under the
  // total it is NOT part of, with the reason it is not part of it.
  const h = perItem.harness;
  if (h.records > 0) {
    const kinds = Object.entries(h.byKind)
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([k, v]) => `${k} ${num(v.records)} gen(s) ${usd(v.usd)}`)
      .join(', ');
    console.log(`\n${pad('Harness spend (excluded)')}: ${usd(h.usd)} · ${num(h.records)} generation(s)`);
    console.log(`  ${kinds}`);
    console.log(`  Real spend, but the corpus ping and sweep create no item, so it has no`);
    console.log(`  denominator and is kept out of the ratio. --include-harness folds it back in.`);
  } else if (opts.includeHarness) {
    console.log(`${pad('  incl. harness')}: corpus ping + sweep spend is INSIDE the total above (--include-harness)`);
  }

  if (blendedBlocked) {
    console.log(`\n${pad('Cost per item')}: withheld — see WARNING below`);
  } else if (denominator > 0) {
    console.log(`\n${pad('Cost per item')}: ${usd(totalCost / denominator)}${opts.excludeTrial ? '  (paid items only)' : ''}`);
    console.log(`${pad('  Anthropic')}: ${usd(costByProvider.anthropic / denominator)}`);
    console.log(`${pad('  OpenAI')}: ${usd(costByProvider.openai / denominator)}`);
  } else {
    console.log(`\nNo items created in this window — cost per item undefined.`);
  }

  const ranked = Object.entries(costByModel).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0 && totalCost > 0) {
    console.log(`\nBy model`);
    const w = Math.max(...ranked.map(([m]) => m.length));
    for (const [model, cost] of ranked) {
      const share = ((cost / totalCost) * 100).toFixed(1).padStart(5);
      console.log(`  ${model.padEnd(w)}: ${usd(cost).padStart(9)}  (${share}%)`);
    }
  }

  if (perItem) {
    const costs = Array.from(perItem.byItem.values()).map(v => v.usd).sort((a, b) => a - b);
    const gens = Array.from(perItem.byItem.values()).reduce((s, v) => s + v.gens, 0);
    const legacy = perItem.records - perItem.instrumented;

    console.log(`\nPer-item attribution`);
    console.log(`${pad('  generation records')}: ${num(perItem.records)}${
      legacy > 0 ? ` (${num(legacy)} legacy — pre-attribution, no cost recorded)` : ''}`);
    console.log(`${pad('  items with cost')}: ${num(costs.length)} · ${usd(perItem.attributedCost)} attributed`);
    if (perItem.unattributedRecords > 0) {
      console.log(`${pad('  unattributed')}: ${num(perItem.unattributedRecords)} gen(s) · ${usd(perItem.unattributedCost)}` +
        `  (never became an item — failed, or created outside the window)`);
    }

    if (costs.length > 0) {
      const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
      console.log(`${pad('  mean')}: ${usd(mean)}`);
      console.log(`${pad('  median')}: ${usd(quantile(costs, 0.5))}`);
      console.log(`${pad('  p90')}: ${usd(quantile(costs, 0.9))}`);
      console.log(`${pad('  min / max')}: ${usd(costs[0])} / ${usd(costs[costs.length - 1])}`);
      console.log(`${pad('  generations per item')}: ${(gens / costs.length).toFixed(2)}`);
    } else {
      console.log(`  No attributed items yet. Per-item attribution only sees generations`);
      console.log(`  recorded after it shipped — run some generations, then re-run this.`);
    }
  }

  if (opts.byLang) {
    console.log(`\nAverage item cost by language (attributed items only)`);
    console.log(`  ${'lang'.padEnd(14)}${'items'.padStart(7)}${'cost/item'.padStart(11)}${'tokens/item'.padStart(13)}`);
    for (const e of langRows) {
      console.log(`  ${e.lang.padEnd(14)}${String(e.items).padStart(7)}${usd(e.usd / e.items).padStart(11)}${num(Math.round(e.tokens / e.items)).padStart(13)}`);
    }
    if (thinLangRows.length > 0) {
      const hidden = thinLangRows.map(r => `${r.lang || '(unrecorded)'} (${r.items})`).join(', ');
      console.log(`  hidden — under ${opts.minItems} attributed items: ${hidden}`);
    }
    // The same table, for the spend this report refuses to divide. Worth showing
    // next to it: a language whose harness cost dwarfs its real cost is one whose
    // per-item average used to be pure artifact, and is also a real signal that
    // the ping set is carrying a dialect nobody is using.
    const hLangs = Object.entries(perItem.harness.byLang).sort((a, b) => b[1].usd - a[1].usd);
    if (hLangs.length > 0) {
      console.log(`\nHarness spend by language (excluded from the table above)`);
      console.log(`  ${'lang'.padEnd(14)}${'gens'.padStart(7)}${'cost'.padStart(11)}`);
      for (const [lang, v] of hLangs) {
        console.log(`  ${lang.padEnd(14)}${String(v.records).padStart(7)}${usd(v.usd).padStart(11)}`);
      }
    }
  }

  // Are the current prices profitable against this cost? The rates come from
  // plans-config, so the table cannot drift from what customers are billed.
  if (opts.langs.length === 0 && denominator > 0 && !blendedBlocked) {
    const cpi = totalCost / denominator;
    console.log(`\nMargin at ${usd(cpi)}/item (rate card ${opts.asOf.toISOString().split('T')[0]})`);
    console.log(`  ${'plan'.padEnd(12)}${'$/item'.padStart(9)}${'margin'.padStart(10)}${'profit/item'.padStart(13)}`);
    for (const id of ['demo', 'pro', 'teams', 'platinum'] as PlanId[]) {
      const rate = PLANS[id].overageRatePerItem;
      if (rate == null) continue;
      const margin = ((rate - cpi) / rate) * 100;
      console.log(`  ${PLANS[id].displayName.padEnd(12)}${usd(rate).padStart(9)}${(margin.toFixed(1) + '%').padStart(10)}${usd(rate - cpi).padStart(13)}`);
    }
  }

  for (const w of warnings) console.log(`\nWARNING: ${w}`);

  console.log('');
  // Firestore keeps a handle open; exit rather than hang.
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
