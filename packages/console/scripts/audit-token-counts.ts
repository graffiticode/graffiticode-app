#!/usr/bin/env node

// Do our recorded token counts match what the providers metered?
//
//   npx tsx scripts/audit-token-counts.ts --from 2026-08-12 --to 2026-08-18
//
// This is the counterweight to cost-per-item.ts. That report prices OUR OWN
// recorded tokens and calls no provider API, which is what makes it fast and
// sliceable by item/language/stage — but it means nothing checks whether those
// counts are COMPLETE. A call path that never reaches recordTokenUsage simply
// makes the report smaller, and it still looks entirely plausible.
//
// So this script compares token COUNTS, not dollars, against the provider's own
// metering. Reading it:
//
//   near parity      instrumentation is capturing everything
//   materially LOW   some call path is not wired to recordTokenUsage
//   materially HIGH  double counting (e.g. accumulating streaming chunks twice)
//   model on one side only    an entire path unrecorded, or a model we price
//                             under a name the provider does not use
//
// The headline compares our telemetry against ORG-WIDE metering, then breaks the
// provider side down BY API KEY — because which key the drift sits on is usually
// the whole answer. Our telemetry only sees calls made through the app, so a key
// driven by local scripts and evals appears as metered-but-unrecorded, which is
// not the same finding as instrumentation missing inside the app.
//
// Scoping to a single key instead would reintroduce the mistake that made the old
// "recorded vs provider" line read 175.7%: comparing all-environment telemetry
// against one key's usage. Take the whole org, then attribute.
//
// Requires: ANTHROPIC_ADMIN_KEY, GRAFFITICODE_APP_CREDENTIALS.
// Optional: OPENAI_ADMIN_KEY (needs the api.usage.read scope; without it the
// OpenAI half is skipped and says so, and the Anthropic half still runs).

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { usdCostFromReport } from '../src/lib/model-pricing';

// Load .env.local
try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* not required when the env is already populated */ }

// This audit pairs provider APIs with PROD Firestore. A leftover emulator host
// would silently compare live provider totals against an empty local database.
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'graffiticode-app' });
const db = admin.firestore();

const ANTHROPIC_ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY;
const OPENAI_KEY = process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY;

const USAGE = `
Compare our recorded token counts against what the providers metered.

  npx tsx scripts/audit-token-counts.ts [options]

  --from YYYY-MM-DD   Window start (default: 7 settled UTC days back)
  --to YYYY-MM-DD     Window end, exclusive (default: last midnight UTC)
  --as-of YYYY-MM-DD  Rate card for the dollar-weighted summary (default: today)
  --json              Emit JSON to stdout (progress goes to stderr)
  --help, -h          Show this

Both sides are org-wide; see the header comment for why. Provider usage reports
lag by hours, so the window defaults to settled days — a window reaching into
today always reads as if we over-counted.

Env: ANTHROPIC_ADMIN_KEY, GRAFFITICODE_APP_CREDENTIALS.
     OPENAI_ADMIN_KEY optional (needs the api.usage.read scope).
`.trim();

// ---------------------------------------------------------------- args

interface Opts { from?: string; to?: string; asOf: Date; json: boolean }

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  const opts: Opts = { asOf: new Date(), json: false };
  const date = (raw: string, flag: string): Date => {
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      console.error(`Error: ${flag} must be YYYY-MM-DD (got "${raw}")`);
      process.exit(1);
    }
    return d;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from' && args[i + 1]) { opts.from = args[++i]; }
    else if (a === '--to' && args[i + 1]) { opts.to = args[++i]; }
    else if (a === '--as-of' && args[i + 1]) { opts.asOf = date(args[++i], '--as-of'); }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return opts;
}

/** Midnight UTC today — the boundary past which provider reporting is unsettled. */
function lastMidnightUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function resolveWindow(opts: Opts): { start: Date; end: Date; reachesToday: boolean } {
  const midnight = lastMidnightUtc();
  const end = opts.to ? new Date(`${opts.to}T00:00:00Z`) : midnight;
  const start = opts.from
    ? new Date(`${opts.from}T00:00:00Z`)
    : new Date(end.getTime() - 7 * 86_400_000);
  return { start, end, reachesToday: end > midnight };
}

// ---------------------------------------------------------------- tokens

/**
 * Disjoint token classes: `input` NEVER includes cached tokens. Our records use
 * this convention, and so does Anthropic's usage report. OpenAI's `input_tokens`
 * does NOT — it is inclusive — which is why the OpenAI reader below takes
 * `input_uncached_tokens` instead. Mixing the two conventions inflates one side
 * by the cache volume, which is the overwhelming majority of all tokens.
 */
interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

const empty = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const add = (into: Tokens, t: Partial<Tokens>) => {
  into.input += t.input ?? 0;
  into.output += t.output ?? 0;
  into.cacheRead += t.cacheRead ?? 0;
  into.cacheWrite += t.cacheWrite ?? 0;
};

const total = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** Same normalisation `rateFor` applies in model-pricing.ts, so both sides group alike. */
const normalizeModel = (m: string): string => String(m || 'unknown').replace(/-\d{8}$/, '');

/** Price a side with our own rate card, so the dollar line compares like with like. */
const priceOf = (t: Tokens, model: string, asOf: Date): number =>
  usdCostFromReport(
    { uncachedInput: t.input, cacheWrite5m: t.cacheWrite, cacheRead: t.cacheRead, output: t.output },
    model,
    asOf,
  );

type ByModel = Record<string, Tokens>;

// ---------------------------------------------------------------- ours

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

interface OurSide {
  byModel: Record<'anthropic' | 'openai', ByModel>;
  calls: Record<'anthropic' | 'openai', number>;
  byEnv: Record<string, number>;
  /** Records carrying no token counts at all — pre-refactor docs, excluded from the comparison. */
  tokenless: number;
}

async function fetchOurs(start: Date, end: Date): Promise<OurSide> {
  const snap = await db.collection('usage')
    .where('type', '==', 'ai_generation')
    .select('createdAt', 'model', 'provider', 'tokens', 'env')
    .get();

  const out: OurSide = {
    byModel: { anthropic: {}, openai: {} },
    calls: { anthropic: 0, openai: 0 },
    byEnv: {},
    tokenless: 0,
  };

  for (const doc of snap.docs) {
    const d = doc.data();
    const ms = toMillis(d.createdAt);
    if (ms < start.getTime() || ms >= end.getTime()) continue;

    const t = (d.tokens ?? {}) as any;
    const tokens: Tokens = {
      input: Number(t.input ?? 0),
      output: Number(t.output ?? 0),
      cacheRead: Number(t.cacheRead ?? 0),
      cacheWrite: Number(t.cacheCreation ?? 0),
    };
    // A record from before the token-usage refactor has no counts to compare.
    // Counting it would drag our side toward zero and read as missing
    // instrumentation, which is the opposite of what it means.
    if (total(tokens) === 0) { out.tokenless++; continue; }

    const provider: 'anthropic' | 'openai' =
      d.provider === 'openai' || /^(gpt|o\d)/.test(String(d.model ?? '')) ? 'openai' : 'anthropic';
    const model = normalizeModel(String(d.model ?? ''));

    add((out.byModel[provider][model] ??= empty()), tokens);
    out.calls[provider]++;
    const env = String(d.env ?? 'unmarked');
    out.byEnv[env] = (out.byEnv[env] ?? 0) + total(tokens);
  }

  return out;
}

// ---------------------------------------------------------------- anthropic

async function anthropicFetch(url: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': ANTHROPIC_ADMIN_KEY! },
    });
    if (resp.status === 429) {
      const wait = (attempt + 1) * 15;
      console.error(`  rate limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!resp.ok) throw new Error(`Anthropic API error (${resp.status}): ${await resp.text()}`);
    return await resp.json();
  }
  throw new Error('Anthropic API failed after 3 retries');
}

/** id -> human name, so the per-key table reads as "graffiticode-console-dev". */
async function anthropicKeyNames(): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  let afterId: string | undefined;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (afterId) params.set('after_id', afterId);
    const data = await anthropicFetch(`https://api.anthropic.com/v1/organizations/api_keys?${params}`);
    for (const k of data.data || []) names[k.id] = k.name || k.id;
    afterId = data.has_more ? data.last_id : undefined;
  } while (afterId);
  return names;
}

async function fetchAnthropic(
  start: Date, end: Date,
): Promise<{ byModel: ByModel; byKey: ByModel; reportedThrough: Date | null; webSearches: number }> {
  const byModel: ByModel = {};
  const byKey: ByModel = {};
  let reportedThrough: Date | null = null;
  let webSearches = 0;
  let page: string | undefined;

  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      ending_at: end.toISOString(),
      bucket_width: '1d',
      limit: '31', // max for 1d buckets; the default of 7 would silently truncate
    });
    // No api_key_ids[] filter — we take the whole org and split it by key
    // ourselves, because WHICH key the drift sits on is the finding. Grouping by
    // both dimensions in one pass keeps it to a single set of requests.
    params.append('group_by[]', 'model');
    params.append('group_by[]', 'api_key_id');
    if (page) params.set('page', page);
    const report = await anthropicFetch(
      `https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`,
    );

    for (const bucket of report.data || []) {
      const bucketEnd = new Date(bucket.ending_at);
      if (!reportedThrough || bucketEnd > reportedThrough) reportedThrough = bucketEnd;
      for (const r of bucket.results || []) {
        const t: Tokens = {
          input: r.uncached_input_tokens || 0,
          output: r.output_tokens || 0,
          cacheRead: r.cache_read_input_tokens || 0,
          // We store one cacheCreation; Anthropic splits it by TTL. Sum before comparing.
          cacheWrite: (r.cache_creation?.ephemeral_5m_input_tokens || 0)
            + (r.cache_creation?.ephemeral_1h_input_tokens || 0),
        };
        add((byModel[normalizeModel(r.model)] ??= empty()), t);
        add((byKey[r.api_key_id || '(none)'] ??= empty()), t);
        webSearches += r.server_tool_use?.web_search_requests || 0;
      }
    }
    page = report.has_more ? report.next_page : undefined;
  } while (page);

  // No request count: usage_report/messages returns token classes only, with no
  // num_requests field. Reporting a zero here would read as "we made no calls".
  return { byModel, byKey, reportedThrough, webSearches };
}

// ---------------------------------------------------------------- openai

async function fetchOpenAi(
  start: Date, end: Date,
): Promise<{ byModel: ByModel; calls: number } | { skipped: string }> {
  if (!OPENAI_KEY) {
    return { skipped: 'no OPENAI_ADMIN_KEY or OPENAI_API_KEY set' };
  }
  const byModel: ByModel = {};
  let calls = 0;
  let page: string | undefined;

  do {
    const params = new URLSearchParams({
      start_time: String(Math.floor(start.getTime() / 1000)),
      end_time: String(Math.floor(end.getTime() / 1000)),
      bucket_width: '1d',
      'group_by[]': 'model', // without this every row returns model: null
      limit: '31',
    });
    if (page) params.set('page', page);
    const resp = await fetch(
      `https://api.openai.com/v1/organization/usage/completions?${params}`,
      { headers: { Authorization: `Bearer ${OPENAI_KEY}` } },
    );
    if (resp.status === 401 || resp.status === 403) {
      // Report the provider's own words: it names the missing scope, which is
      // the actionable part. A project key without api.usage.read lands here.
      let message = `HTTP ${resp.status}`;
      try {
        const body: any = await resp.json();
        message = typeof body?.error === 'string' ? body.error : (body?.error?.message ?? message);
      } catch { /* keep the status */ }
      return { skipped: message };
    }
    if (!resp.ok) throw new Error(`OpenAI API error (${resp.status}): ${await resp.text()}`);
    const data: any = await resp.json();

    for (const bucket of data.data || []) {
      for (const r of bucket.results || []) {
        add((byModel[normalizeModel(r.model)] ??= empty()), {
          // input_tokens is INCLUSIVE of cache here, unlike Anthropic and unlike
          // our records. input_uncached_tokens is the disjoint figure.
          input: r.input_uncached_tokens || 0,
          output: r.output_tokens || 0,
          cacheRead: r.input_cached_tokens || 0,
          cacheWrite: r.input_cache_write_tokens || 0,
        });
        calls += r.num_model_requests || 0;
      }
    }
    page = data.has_more ? data.next_page : undefined;
  } while (page);

  return { byModel, calls };
}

// ---------------------------------------------------------------- report

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(4)}`;

/** Drift of ours against theirs. null when there is nothing to divide by. */
function drift(ours: number, theirs: number): number | null {
  if (theirs === 0) return ours === 0 ? 0 : null;
  return ((ours - theirs) / theirs) * 100;
}

const driftLabel = (d: number | null): string =>
  d === null ? 'n/a' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;

function reportProvider(
  label: string, ours: ByModel, theirs: ByModel, ourCalls: number, theirCalls: number | null, asOf: Date,
): void {
  const ourTotal = empty();
  const theirTotal = empty();
  for (const t of Object.values(ours)) add(ourTotal, t);
  for (const t of Object.values(theirs)) add(theirTotal, t);

  console.log(`\n=== ${label} ===`);
  console.log(`  ${'class'.padEnd(12)}${'ours'.padStart(14)}${'metered'.padStart(14)}${'drift'.padStart(10)}`);
  for (const k of ['input', 'cacheWrite', 'cacheRead', 'output'] as const) {
    console.log(
      `  ${k.padEnd(12)}${num(ourTotal[k]).padStart(14)}${num(theirTotal[k]).padStart(14)}` +
      `${driftLabel(drift(ourTotal[k], theirTotal[k])).padStart(10)}`,
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(12)}${num(total(ourTotal)).padStart(14)}${num(total(theirTotal)).padStart(14)}` +
    `${driftLabel(drift(total(ourTotal), total(theirTotal))).padStart(10)}`,
  );
  // Anthropic's usage report carries token classes only — no request count — so
  // there is nothing to compare against. Printing a zero would read as "they say
  // we made no calls", which is a different and alarming claim.
  console.log(
    `  ${'calls'.padEnd(12)}${num(ourCalls).padStart(14)}` +
    (theirCalls === null
      ? `${'not reported'.padStart(14)}${'—'.padStart(10)}`
      : `${num(theirCalls).padStart(14)}${driftLabel(drift(ourCalls, theirCalls)).padStart(10)}`),
  );

  const models = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]
    .sort((a, b) => total(theirs[b] ?? empty()) - total(theirs[a] ?? empty()));
  if (models.length > 0) {
    console.log(`\n  by model${' '.repeat(14)}${'ours'.padStart(14)}${'metered'.padStart(14)}${'drift'.padStart(10)}`);
    for (const m of models) {
      const o = ours[m] ?? empty();
      const t = theirs[m] ?? empty();
      const only = !ours[m] ? '  <-- not recorded by us' : !theirs[m] ? '  <-- not metered by them' : '';
      console.log(
        `  ${m.padEnd(22)}${num(total(o)).padStart(14)}${num(total(t)).padStart(14)}` +
        `${driftLabel(drift(total(o), total(t))).padStart(10)}${only}`,
      );
    }
  }

  let ourUsd = 0;
  let theirUsd = 0;
  for (const [m, t] of Object.entries(ours)) ourUsd += priceOf(t, m, asOf);
  for (const [m, t] of Object.entries(theirs)) theirUsd += priceOf(t, m, asOf);
  console.log(
    `\n  priced at the ${asOf.toISOString().split('T')[0]} rate card: ` +
    `ours ${usd(ourUsd)} · metered ${usd(theirUsd)} · ${driftLabel(drift(ourUsd, theirUsd))}`,
  );
}

async function main() {
  const opts = parseArgs(process.argv);
  const { start, end, reachesToday } = resolveWindow(opts);

  if (!ANTHROPIC_ADMIN_KEY) throw new Error('ANTHROPIC_ADMIN_KEY not set');

  console.error(`Window: ${start.toISOString()} → ${end.toISOString()}`);
  console.error('Reading our token usage...');
  const ours = await fetchOurs(start, end);
  console.error('Fetching Anthropic metered usage (org-wide)...');
  const anthropic = await fetchAnthropic(start, end);
  console.error('Fetching OpenAI metered usage (org-wide)...');
  const openai = await fetchOpenAi(start, end);

  console.log(`\nToken-count audit — ${start.toISOString().split('T')[0]} → ${end.toISOString().split('T')[0]} (UTC)`);
  console.log('Ours = recorded ai_generation tokens · Metered = the provider\'s own report, org-wide.');

  reportProvider(
    'Anthropic', ours.byModel.anthropic, anthropic.byModel,
    ours.calls.anthropic, null, opts.asOf,
  );

  // Which key the drift sits on IS the finding: our telemetry only covers calls
  // made through the app, so a key used by local scripts and evals shows up here
  // as metered-but-unrecorded rather than as a hole in the instrumentation.
  const keyNames = await anthropicKeyNames();
  const keyRows = Object.entries(anthropic.byKey).sort((a, b) => total(b[1]) - total(a[1]));
  if (keyRows.length > 0) {
    const ourAnthropic = empty();
    for (const t of Object.values(ours.byModel.anthropic)) add(ourAnthropic, t);
    console.log(`\n  metered by API key${' '.repeat(11)}${'tokens'.padStart(14)}${'vs ours'.padStart(10)}`);
    for (const [id, t] of keyRows) {
      console.log(
        `  ${(keyNames[id] ?? id).padEnd(28)}${num(total(t)).padStart(14)}` +
        `${driftLabel(drift(total(ourAnthropic), total(t))).padStart(10)}`,
      );
    }
    console.log(`  ${'(ours, for comparison)'.padEnd(28)}${num(total(ourAnthropic)).padStart(14)}`);
  }

  if ('skipped' in openai) {
    console.log(`\n=== OpenAI ===`);
    console.log(`  skipped — ${openai.skipped}`);
    console.log(`  Set OPENAI_ADMIN_KEY to an org key carrying the api.usage.read scope.`);
    console.log(`  Our OpenAI records are NOT verified by this run.`);
  } else {
    reportProvider(
      'OpenAI', ours.byModel.openai, openai.byModel,
      ours.calls.openai, openai.calls, opts.asOf,
    );
  }

  const envSplit = Object.entries(ours.byEnv).sort((a, b) => b[1] - a[1]);
  console.log(`\nOur side by env: ${envSplit.map(([e, n]) => `${e} ${num(n)}`).join(' · ') || '(none)'}`);
  if (ours.tokenless > 0) {
    console.log(`Excluded ${num(ours.tokenless)} record(s) carrying no token counts (pre-refactor docs).`);
  }
  if (anthropic.webSearches > 0) {
    console.log(`Anthropic also metered ${num(anthropic.webSearches)} web-search request(s) — not tokens, not compared.`);
  }

  if (reachesToday) {
    console.log(
      `\nWARNING: the window reaches past the last settled UTC day. Provider usage reports lag by ` +
      `hours, so our side counts records they have not reported yet — which always reads as ` +
      `over-counting. Re-run with --to at yesterday for a verdict.`,
    );
  }
  if (anthropic.reportedThrough && anthropic.reportedThrough < end) {
    console.log(
      `\nNOTE: Anthropic's report only reaches ${anthropic.reportedThrough.toISOString()}, ` +
      `short of the window end.`,
    );
  }

  if (opts.json) {
    console.log(JSON.stringify({
      window: { start: start.toISOString(), end: end.toISOString() },
      asOf: opts.asOf.toISOString(),
      ours: { byModel: ours.byModel, calls: ours.calls, byEnv: ours.byEnv, tokenless: ours.tokenless },
      anthropic: { byModel: anthropic.byModel, byKey: anthropic.byKey, webSearches: anthropic.webSearches },
      openai,
    }, null, 2));
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
