#!/usr/bin/env node
/**
 * MCP funnel report — manually-run, no dashboards.
 *
 * Joins two data sources to render the agent-engagement funnel:
 *   A. Cloud Logging — structured events the MCP server emits (one JSON line per
 *      connect / tool call). See graffiticode-mcp-server/src/events.ts.
 *      Read via `gcloud logging read 'jsonPayload.ev=("mcp_connect" OR "mcp_tool")'`.
 *   B. Firestore (graffiticode-app) — the conversion tail: free-plan items,
 *      claimed items (claimedFrom), and paid subscriptions.
 *
 * Join key: the MCP event `session` is sha256(salt + ":" + sessionUuid) — the
 * same `sessionNamespace` the console stamps on items. Claimed items carry the
 * raw `claimedFrom` uuid, which we re-hash here to match.
 *
 * Usage:
 *   npx tsx scripts/mcp-funnel-report.ts [--period all|month|week|day]
 *                                        [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                        [--freshness 7d] [--output mcp-funnel.html]
 *   (--freshness Nd sets how far back the LOG half reads; logs are fetched in
 *    3-day slices because Cloud Logging 500s on wider scans.)
 *
 * Auth — one login covers both halves:
 *   gcloud auth login                          (Cloud Logging, via the shell-out)
 *   gcloud auth application-default login      (Firestore, via ADC)
 * Set GRAFFITICODE_APP_CREDENTIALS to a service-account key path only if you
 * need to override ADC; it is no longer required.
 *
 * Requires in .env.local:
 *   FREE_PLAN_NAMESPACE_SALT      — to derive namespaces from claimedFrom
 */

import admin from 'firebase-admin';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  agentOmtmMetric,
  currentWeek,
  partnerOmtmMetric,
  totalCreatingWorkspaces,
  weeklyNewCreatingWorkspaces,
  type Metric,
  type WeeklyNewCreatingWorkspaces,
} from '../src/lib/omtm';
import { OMTM_CLOCK_START } from '../src/lib/workspace-week';
import { classifyClient } from '../src/lib/funnel-clients';

// --- Load .env.local (same pattern as user-report.ts) -----------------------
const envPath = resolve(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {}

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

const PROJECT = 'graffiticode-app';

// An explicit key wins; otherwise fall through to Application Default
// Credentials, which `gcloud auth application-default login` provides.
//
// This used to hard-exit without the env var, which meant the report was
// unrunnable on a machine that was already authenticated to the project for the
// `gcloud logging read` half it shells out to — the two halves demanded
// different credentials for the same data. Preferring ADC also avoids putting a
// long-lived service-account key on disk just to read a report.
if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT,
});
const db = admin.firestore();

// --- args -------------------------------------------------------------------
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let period = 'week';
  let output = 'mcp-funnel.html';
  let freshness = '';
  let from = '';
  let to = '';
  let slowMs = 60000; // errors slower than this are flagged as likely timeouts
  // The OMTM window is an ISO week and is deliberately INDEPENDENT of --period:
  // the weekly metric must not silently change shape because someone asked for a
  // day's engagement numbers.
  let week = currentWeek();
  let partnerSessions: number | undefined;
  let partnerLog = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' && args[i + 1]) { period = args[++i]; }
    else if (args[i] === '--output' && args[i + 1]) { output = args[++i]; }
    else if (args[i] === '--freshness' && args[i + 1]) { freshness = args[++i]; }
    else if (args[i] === '--from' && args[i + 1]) { from = args[++i]; }
    else if (args[i] === '--to' && args[i + 1]) { to = args[++i]; }
    else if (args[i] === '--slow-ms' && args[i + 1]) { slowMs = parseInt(args[++i], 10); }
    else if (args[i] === '--week' && args[i + 1]) { week = args[++i]; }
    else if (args[i] === '--partner-sessions' && args[i + 1]) { partnerSessions = parseInt(args[++i], 10); }
    else if (args[i] === '--partner-log' && args[i + 1]) { partnerLog = args[++i]; }
  }
  if (!/^\d{4}-W\d{2}$/.test(week)) {
    console.error('Error: --week must be an ISO week, e.g. "2026-W32"');
    process.exit(1);
  }
  if (!['all', 'month', 'week', 'day'].includes(period)) {
    console.error('Error: --period must be "all", "month", "week", or "day"');
    process.exit(1);
  }
  if (!Number.isFinite(slowMs) || slowMs <= 0) {
    console.error('Error: --slow-ms must be a positive number of milliseconds');
    process.exit(1);
  }
  return { period, output, freshness, from, to, slowMs, week, partnerSessions, partnerLog };
}

function windowBounds(opts: { period: string; from: string; to: string }) {
  const end = opts.to ? new Date(opts.to + 'T23:59:59Z') : new Date();
  if (opts.from) return { start: new Date(opts.from + 'T00:00:00Z'), end };
  const today = new Date(new Date().toISOString().split('T')[0] + 'T00:00:00Z');
  if (opts.period === 'all') return { start: null as Date | null, end };
  if (opts.period === 'day') return { start: today, end };
  if (opts.period === 'week') return { start: new Date(today.getTime() - 7 * 864e5), end };
  return { start: new Date(today.getTime() - 30 * 864e5), end }; // month
}

// How far back to read logs. Reads are sliced by explicit `timestamp` bounds
// (see readLogChunked), so this is a real start DATE, not a gcloud --freshness
// duration. `--freshness Nd` is still accepted — it now shifts this start —
// because it is the documented escape hatch for widening or trimming the log
// half independently of the Firestore window.
//
// Cloud Logging retention is ~30 days, so an `all`-time window still floors here.
function deriveLogStart(opts: { freshness: string; start: Date | null }, end: Date): Date {
  const m = opts.freshness.match(/^(\d+)\s*d$/i);
  if (m) return new Date(end.getTime() - parseInt(m[1], 10) * 864e5);
  if (opts.freshness) {
    console.warn(`WARN: --freshness "${opts.freshness}" not understood (expected e.g. "7d") — ignoring.`);
  }
  if (opts.start) return opts.start;
  return new Date(end.getTime() - 30 * 864e5);
}

function toMillis(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  if (v.seconds != null) return v.seconds * 1000;
  return null;
}

function deriveSessionNamespace(uuid: string): string {
  const salt = process.env.FREE_PLAN_NAMESPACE_SALT || '';
  return crypto.createHash('sha256').update(`${salt}:${uuid}`).digest('hex');
}

// `help` is the conversation log — one entry per user turn. It is persisted as
// a JSON *string* (not an array), so parse before counting. The first turn is
// the create; length > 1 means the user came back and revised → iterated.
function helpLen(h: any): number {
  if (Array.isArray(h)) return h.length;
  if (typeof h === 'string') {
    try { const p = JSON.parse(h); return Array.isArray(p) ? p.length : 0; } catch { return 0; }
  }
  return 0;
}

function inWindow(ms: number | null, start: Date | null, end: Date): boolean {
  if (ms == null) return false;
  if (start && ms < start.getTime()) return false;
  return ms <= end.getTime();
}

function pct(n: number, d: number): string {
  if (!d) return '—';
  return ((n / d) * 100).toFixed(1) + '%';
}

// listed→called is a conversion only when the SAME session did both. It is
// computed from `listedAndCalled` for that reason: `toolSessions / listed`
// divides two populations that, for every client we actually have, barely
// intersect — and the failure is silent in one direction.
//
//   - ChatGPT/Codex mints a fresh transport per tool call, so its tool sessions
//     never emit `mcp_listed`. The naive ratio came out at 508.7%, which is at
//     least obviously wrong.
//   - Claude surfaces list at connector startup and (overwhelmingly) never
//     call. Blend the two and Claude's listings become the denominator for
//     OpenAI's calls: on 2026-08-30 that printed "187 → 11 (5.9%)" for a window
//     in which no session anywhere did both. 5.9% is not obviously wrong, and
//     it reads as "94% of people who saw the catalogue bounced" — a much worse
//     story than the one in the data.
//
// So: `n/a ‡` when listers and callers are disjoint (the ratio has no
// same-session meaning), `n/a †` when the client demonstrably does not list
// once per session, and a real percentage otherwise. A 0.0% is meaningful and
// is NOT suppressed — a segment that listed 178 times and never called is the
// single most informative cell in the table.
function listedConv(g: { listed: number; toolSessions: number; listedAndCalled: number }): string {
  if (!g.listed) return g.toolSessions ? 'n/a †' : '—';
  if (g.toolSessions > g.listed) return 'n/a †';
  if (g.toolSessions && !g.listedAndCalled) return 'n/a ‡';
  return pct(g.listedAndCalled, g.listed);
}

const READ_TOOLS = new Set(['list_languages', 'get_language_info', 'get_item']);

// --- Client classification --------------------------------------------------
// Session counts are NOT comparable across clients, and the two distortions run
// in OPPOSITE directions, so a single blended number is worse than no number:
//
//   - Claude surfaces open a transport and call tools/list at connector
//     STARTUP, whether or not the user ever invokes us. "Connected" fills up
//     with installed-base handshakes. (2026-08-13→20: 1666 Claude sessions
//     listed tools; 2 ever called one, and both were an authenticated dev key.)
//   - ChatGPT/Codex mints a NEW transport per tool call. One continuous
//     24-minute conversation on 2026-08-14 logged 58 calls across 58 distinct
//     sessions, so its "sessions" overcounts real conversations ~9x.
//
// Everything downstream segments by these buckets. `bucketOf` is keyed on the
// self-declared clientInfo.name, which is the only client identity we have.
type ClientBucket = 'claude' | 'claude_ua' | 'openai' | 'other' | 'internal' | 'scanner' | 'crawl' | 'unknown';

const BUCKET_LABEL: Record<ClientBucket, string> = {
  claude: 'Claude family',
  claude_ua: 'Anthropic/ClaudeAI UA',
  openai: 'OpenAI family',
  other: 'Other named',
  internal: 'Internal (our own testing)',
  scanner: 'Scanner / validator',
  crawl: 'Automated catalog crawl',
  unknown: 'Unknown',
};

// Order matters only for display; `unknown` last.
const BUCKET_ORDER: ClientBucket[] = ['claude', 'claude_ua', 'openai', 'other', 'internal', 'scanner', 'crawl', 'unknown'];

/**
 * Not a prospect: crawlers, probes, and our own tools. These are shown as rows
 * but never counted anywhere a rate is quoted.
 */
const isProbeSegment = (g: { bucket: ClientBucket }): boolean =>
  g.bucket === 'crawl' || g.bucket === 'scanner' || g.bucket === 'internal';

/**
 * Whether a segment belongs in the blended listed→called rate.
 *
 * `claude_ua` is DISPLAYED like a real client — it keeps its row and its own
 * per-family rate, because that row is the evidence for what it is — but it is
 * held OUT of the aggregate. Over 2026-07-31→08-30 it carried 3085 of 6454
 * catalogue loads and one tool session, so leaving it in makes the blended rate
 * a statement about a UA-shaped client that is very likely directory
 * infrastructure, not about whether people find the tools useful. Same reason
 * `log.listedSessions` already holds catalogue crawls out.
 *
 * Both exclusions are DISCLOSED in the output rather than silent: the volume
 * held out is printed next to the rate, so nothing disappears.
 *
 * These two predicates are defined once because the HTML and terminal halves
 * each built the set inline and would drift — the same duplication that made
 * scanner names wrong in the digest until 2026-08-26.
 */
const countsTowardAggregate = (g: { bucket: ClientBucket }): boolean =>
  !isProbeSegment(g) && g.bucket !== 'claude_ua';

/**
 * Catalogue crawls: many sessions that connect, list, and never ask for
 * anything, arriving back to back from one client and one country.
 *
 * Detected by BEHAVIOUR, not by name, because the name is the problem. On
 * 2026-08-24 a job began fetching the tool catalogue from GB reporting itself
 * as `claude-ai` — the same clientInfo Claude.ai's own connector sends — in
 * bursts of ~40 sessions at ~2s intervals, every ~16 minutes. Filtering on the
 * name would have deleted the real Claude.ai segment along with it, and the
 * next crawler would pick a different name anyway.
 *
 * The "connect, list, never call" shape ALONE cannot be the test: that
 * describes most legitimate traffic too — it is exactly the 4% listed→called
 * conversion this report exists to measure. The cadence is what separates a
 * population of people who each opened one conversation from one machine
 * working through a list.
 */
const CRAWL_MAX_GAP_MS = 10_000;  // consecutive sessions closer than this are one run
const CRAWL_MIN_RUN = 10;         // …and a run this long is not a population of humans

// Crawler / probe / internal names now live in ONE place: classifyClient() in
// src/lib/funnel-digest.ts, which the hourly SMS, the /r/<token> page and
// scripts/funnel-report.ts all read. They were duplicated here as loose
// substrings until 2026-08-26, and the digest's not knowing them is how
// `adoption-verify`'s 40 tool calls were reported as anonymous demand.
//
// The reason it matters here specifically: scanners call tools with junk item
// ids on purpose, so counting them tanks the reliability guardrail. In the
// 2026-08-13→20 week, 20 of 24 non-ok outcomes were ONE scanner
// (`alpic-beacon-ai-review`) probing get_item/get_spec/render_item/
// get_language_info with 5 bad ids each, which alone moved overall tool success
// from ~99% to the 92.7% the report printed.
//
// Adding a newly-seen scanner means editing funnel-digest.ts, not this file.

/**
 * `Anthropic/ClaudeAI` and bare `Anthropic` — User-Agent-SHAPED names, kept apart
 * from the Claude clients proper.
 *
 * Every real Claude host sends a lowercase hyphenated clientInfo.name
 * (`claude-ai`, `claude-code`). These two are capitalised and slash-separated,
 * i.e. the shape of a User-Agent header rather than an MCP client identity, and
 * they behave nothing like the hosts they were being counted with. Over
 * 2026-07-31→08-30 this bucket was 4036 of the 7391 sessions in the old combined
 * `claude` row — over half the denominator — on 3085 catalogue loads, and
 * produced exactly ONE tool-calling session in the whole window. It connects in
 * 43 of 43 hours with no diurnal curve at all, lists `tools` and `resources`
 * once each, and stops. Splitting it leaves `claude` at 3103 listed / 2 tool
 * sessions, both of which are an authenticated dev key.
 *
 * Folding that into "Claude family" is what made the Claude-side conversion look
 * catastrophic: it is a denominator of installed base and (most likely) directory
 * infrastructure checking on a listed server, not of people who wanted something.
 *
 * It gets its OWN ROW rather than the scanner bin, deliberately — see the same
 * argument in src/lib/funnel-clients.ts. Binning it would delete the evidence
 * either way, and the row plus the listed/tool columns let a reader settle what
 * it is. It keeps a full row and its own per-family rate, and is held out of the
 * blended "All families" rate only — see `countsTowardAggregate`. The held-out
 * volume is printed beside the rate, so the exclusion is disclosed, not silent.
 */
const ANTHROPIC_UA = /^anthropic(\/|$)/i;

function bucketOf(kind: string | undefined): ClientBucket {
  if (!kind) return 'unknown';
  const cls = classifyClient(kind);
  if (cls === 'internal') return 'internal';
  if (cls === 'crawler') return 'scanner';
  const k = kind.toLowerCase();
  if (ANTHROPIC_UA.test(kind)) return 'claude_ua';
  if (k.includes('claude') || k.includes('anthropic')) return 'claude';
  if (k.includes('openai') || k.includes('codex')) return 'openai';
  return 'other';
}

// --- Chunked log reads ------------------------------------------------------
// Cloud Logging returns HTTP 500 INTERNAL — consistently ~9s in — on any scan
// wider than roughly a week, REGARDLESS of how selective the filter is. Pinning
// `resource.labels.service_name` was tried and does not help; the constraint is
// query duration, not breadth. A `--freshness 30d` read therefore always failed,
// which is how a 30-day run came to report "0 sessions, 0 artifact views, 0
// claims" — three dead queries reading exactly like three empty funnels.
//
// Slicing the window into explicit `timestamp` ranges keeps each query short
// enough to finish, and localises a failure to one slice instead of the report.
const LOG_CHUNK_DAYS = 3;

function readLogSlice(filter: string): any[] | null {
  try {
    const raw = execFileSync('gcloud', [
      'logging', 'read', filter,
      '--project', PROJECT,
      '--format', 'json',
      '--limit', '50000',
    ], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readLogChunked(baseFilter: string, start: Date, end: Date, label: string): any[] {
  const out: any[] = [];
  const step = LOG_CHUNK_DAYS * 864e5;
  let slices = 0, failed = 0;
  for (let t = start.getTime(); t < end.getTime(); t += step) {
    const a = new Date(t);
    const b = new Date(Math.min(t + step, end.getTime()));
    const range = (x: Date, y: Date) =>
      `${baseFilter} AND timestamp>="${x.toISOString()}" AND timestamp<"${y.toISOString()}"`;
    slices++;
    let res = readLogSlice(range(a, b));
    if (res === null) {
      // Halve once: a slice straddling a traffic spike can still be too heavy.
      const mid = new Date((a.getTime() + b.getTime()) / 2);
      const l = readLogSlice(range(a, mid));
      const r = readLogSlice(range(mid, b));
      if (l === null || r === null) { failed++; continue; }
      res = [...l, ...r];
    }
    out.push(...res);
  }
  if (failed) {
    // Loud and specific. The whole point of chunking is that a partial failure
    // must never masquerade as a zero.
    console.warn(`WARN: ${failed}/${slices} log slice(s) failed for ${label} — that stage is UNDER-COUNTED, not empty.`);
  }
  return out;
}

// --- A. Cloud Logging events ------------------------------------------------
interface McpEvent {
  ev: 'mcp_connect' | 'mcp_listed' | 'mcp_resource' | 'mcp_tool';
  t: string;
  auth: string;
  session: string;
  tool?: string;
  outcome?: string;
  lang?: string;
  desc_len?: number;
  ms?: number;
  // Truncated backend error (200 chars, server-side). On a scope rejection this
  // is the backend's own English summary of what the user asked for.
  err?: string;
  client_kind?: string; // MCP clientInfo.name (e.g. "claude-ai"); on tool events
  geo_country?: string; // ISO-3166 alpha-2, coarse (no IP); on connect + tool
  geo_region?: string;
  // list_languages only. The search STRING is never logged — see the privacy
  // contract in the MCP server's src/events.ts — so `search_len` is all we get
  // of what was asked, and `results` is what the catalogue gave back.
  search_len?: number;
  domain?: string;
  results?: number;
}

function fetchEvents(start: Date, end: Date): McpEvent[] {
  // `mcp_listed` and `mcp_resource` are included alongside connect/tool: they
  // are the stages between "a transport opened" and "someone asked for
  // something". Without them a directory validator that loaded the catalogue
  // and a user who actually worked are the same event — and the listed→called
  // drop-off is the sharpest signal in this report.
  const filter =
    'resource.labels.service_name="mcp-service" AND ' +
    'jsonPayload.ev=("mcp_connect" OR "mcp_listed" OR "mcp_resource" OR "mcp_tool")';
  return readLogChunked(filter, start, end, 'MCP events')
    .map((e) => e.jsonPayload as McpEvent)
    .filter((p) => p && (p.ev === 'mcp_connect' || p.ev === 'mcp_listed'
      || p.ev === 'mcp_resource' || p.ev === 'mcp_tool'));
}

interface SlowError {
  tool: string;
  ms: number;
  t: string;
  session: string;
  lang?: string;
}

/**
 * A request the catalogue accepted and the backend then refused as out of
 * scope — someone asked for something Graffiticode does not do, and only found
 * out after describing it in full.
 *
 * Named for the shape that produces it: a keyword search matches ONE language,
 * the agent reads that as the answer rather than as a near miss, and settles.
 * Observed 2026-08-23 — a user wanting staff scheduling and payroll validation
 * searched "spreadsheet", got L0166 alone, and spent ~2.9k chars of description
 * across a create and an update before the rejection landed.
 *
 * Deliberately NOT the same signal as `catalogEmpty`. A zero-result search is
 * the agent asking for the missing capability by name, which is the easy case;
 * this is the agent translating the need into a term that DOES match first, so
 * the miss never appears as a miss.
 */
interface ScopeRejection {
  t: string;
  tool: string;
  lang?: string;
  clientKind?: string;
  session: string;
  err: string;
  /** The narrow search that preceded it, when one can be attributed. */
  search?: { t: string; searchLen: number; results: number; sameSession: boolean };
  /**
   * How many rejection events this one unmet request produced. One refusal is
   * replayed by every retrieval of the failed item — the 2026-08-23 case fired
   * three times (an update and two render_items) for a single user asking for a
   * single thing. Counting events would treat one person as three data points,
   * which is exactly backwards for a demand signal.
   */
  repeats: number;
}

/** A search matching at most this many languages reads to an agent as "the answer". */
const NARROW_RESULTS = 2;

/** How far back to look for the search that led to a rejection. */
const SCOPE_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * Backend refusals that mean "no language covers this", as opposed to a
 * malformed request or a cap. Matched on the message because the console does
 * not give this class its own code; both wordings below are live in the logs.
 */
const SCOPE_REJECTION = /doesn't fit any available graffiticode language|out of scope:/i;

interface SegmentStats {
  bucket: ClientBucket;
  label: string;
  sessions: number;       // distinct `session` values — see the unit caveat below
  listed: number;         // sessions that issued a tools/list-family request
  resource: number;       // sessions that read a graffiticode:// resource
  toolSessions: number;   // sessions that called ANY tool
  // Sessions that listed AND called — the only honest numerator for a
  // listed→called rate. Kept separate from `toolSessions` because for the two
  // clients that matter these are near-disjoint sets, not nested ones.
  listedAndCalled: number;
  createSessions: number;
  updateSessions: number;
  calls: number;
  ok: number;
  nonOk: number;
  freePlanSessions: number;
}

interface LogStats {
  connects: number;
  distinctSessions: number;
  // Reached tools/list — the real top of the funnel. EXCLUDES catalogue crawls:
  // the listed→called rate is the question this report exists to answer, and a
  // machine that lists 3,600 times a day and never calls anything drives it to
  // zero while saying nothing about whether people find the tools useful.
  listedSessions: number;
  crawlSessions: number;     // …how many were held out, so the volume stays visible
  resourceSessions: number;  // read one of our own resources
  browseCalls: number;
  createCalls: number;
  updateCalls: number;
  // Catalog discovery shape (list_languages). `search` itself is never logged —
  // only its length, the allowlisted domain, and the result count — so these are
  // the whole picture of what agents ask the catalog for and what it gives back.
  catalogCalls: number;
  catalogSearches: number;
  catalogEmpty: number;        // a non-empty search that matched NOTHING
  catalogDomains: Record<string, number>;
  catalogNarrow: number;       // a search matching 1-NARROW_RESULTS languages
  scopeRejections: ScopeRejection[];
  scopeAfterNarrow: number;    // …of those, ones a narrow search precedes
  sessionsWithCreate: number;
  firstTrySuccess: number;
  toolTotal: number;
  toolOk: number;
  toolGenFailed: number;
  toolError: number;
  // Same counters with NON-USER traffic removed — automated scanners and our
  // own MCP Inspector sessions. Scanners probe tools with junk ids by design
  // and Inspector only ever exercises happy paths, so a blended rate measures
  // those two harnesses rather than the service.
  userToolTotal: number;
  userToolOk: number;
  userSessionsWithCreate: number;
  userFirstTrySuccess: number;
  nonUserCalls: number;
  nonUserSessions: number;
  slowMs: number;            // threshold used
  slowErrors: number;        // errors with ms >= slowMs (likely timeouts)
  maxErrorMs: number;        // slowest error seen (0 if none)
  slowErrorSamples: SlowError[];
  langCounts: Record<string, number>;
  segments: SegmentStats[];
  // Distinct sessions attributed to each agent kind / country. Attributed
  // per session (one session = many events) from the first event that carries
  // the field; "unknown" buckets sessions with no value yet.
  clientKindSessions: Record<string, number>;
  geoCountrySessions: Record<string, number>;
}

function summarizeEvents(events: McpEvent[], start: Date | null, end: Date, slowMs: number): LogStats {
  const inWin = events.filter((e) => inWindow(toMillis(e.t), start, end));

  // Pass 1 — session identity. Attribute per SESSION, not per event: one
  // session emits many events and only some carry client_kind/geo.
  const sessionKind: Record<string, string> = {};
  const sessionCountry: Record<string, string> = {};
  const sessionAuth: Record<string, string> = {};
  const sessions = new Set<string>();
  for (const e of inWin) {
    if (!e.session) continue;
    sessions.add(e.session);
    if (e.client_kind && !sessionKind[e.session]) sessionKind[e.session] = e.client_kind;
    if (e.geo_country && !sessionCountry[e.session]) sessionCountry[e.session] = e.geo_country;
    if (e.auth && !sessionAuth[e.session]) sessionAuth[e.session] = e.auth;
  }
  // Pass 1b — find catalogue crawls. Needs each session's start time and
  // whether it ever asked for anything, so it runs after the identity pass and
  // before the counting pass that consumes the bucket.
  const sessionStart: Record<string, number> = {};
  const sessionAsked = new Set<string>();
  for (const e of inWin) {
    if (!e.session) continue;
    const at = toMillis(e.t) ?? 0;
    if (!(e.session in sessionStart) || at < sessionStart[e.session]) sessionStart[e.session] = at;
    if (e.ev === 'mcp_tool' || e.ev === 'mcp_resource') sessionAsked.add(e.session);
  }
  const crawlSessions = new Set<string>();
  {
    // Group the never-asked sessions by who and where, then look for runs of
    // back-to-back arrivals. One country is part of the signature: a real
    // population spread across timezones does not arrive 2s apart all night.
    const byOrigin = new Map<string, string[]>();
    for (const sess of sessions) {
      if (sessionAsked.has(sess)) continue;
      const key = `${sessionKind[sess] ?? '?'}|${sessionCountry[sess] ?? '?'}`;
      (byOrigin.get(key) ?? byOrigin.set(key, []).get(key)!).push(sess);
    }
    for (const group of byOrigin.values()) {
      group.sort((a, b) => sessionStart[a] - sessionStart[b]);
      let run: string[] = [];
      const flush = () => {
        if (run.length >= CRAWL_MIN_RUN) for (const x of run) crawlSessions.add(x);
        run = [];
      };
      for (const sess of group) {
        if (run.length && sessionStart[sess] - sessionStart[run[run.length - 1]] > CRAWL_MAX_GAP_MS) flush();
        run.push(sess);
      }
      flush();
    }
  }

  const bucketOfSession = (s: string): ClientBucket =>
    crawlSessions.has(s) ? 'crawl' : bucketOf(sessionKind[s]);
  // "Not a user": automated probes and our own test harness. Both call tools
  // for reasons unrelated to demand, and both distort the reliability guardrail
  // — scanners by failing on purpose, Inspector by succeeding on purpose.
  const isNonUser = (s: string): boolean => {
    const b = bucketOfSession(s);
    return b === 'scanner' || b === 'internal' || b === 'crawl';
  };

  // Pass 2 — stages and counts.
  const seg = new Map<ClientBucket, SegmentStats>();
  const segOf = (b: ClientBucket): SegmentStats => {
    let x = seg.get(b);
    if (!x) {
      x = {
        bucket: b, label: BUCKET_LABEL[b], sessions: 0, listed: 0, resource: 0,
        toolSessions: 0, listedAndCalled: 0, createSessions: 0, updateSessions: 0,
        calls: 0, ok: 0, nonOk: 0, freePlanSessions: 0,
      };
      seg.set(b, x);
    }
    return x;
  };
  const stageSessions: Record<string, Set<string>> = {
    listed: new Set(), resource: new Set(), tool: new Set(),
    create: new Set(), update: new Set(),
  };

  const firstCreateBySession: Record<string, McpEvent> = {};
  const langCounts: Record<string, number> = {};
  let connects = 0, browseCalls = 0, createCalls = 0, updateCalls = 0;
  let catalogCalls = 0, catalogSearches = 0, catalogEmpty = 0;
  const catalogDomains: Record<string, number> = {};
  let toolTotal = 0, toolOk = 0, toolGenFailed = 0, toolError = 0;
  let userToolTotal = 0, userToolOk = 0, nonUserCalls = 0;
  let slowErrors = 0, maxErrorMs = 0;
  const slowErrorSamples: SlowError[] = [];
  let catalogNarrow = 0;
  const scopeRejections: ScopeRejection[] = [];
  // Recent narrow searches, newest last, for attributing a rejection to the
  // search that led to it. Keyed by client kind because the stateless hosts
  // (ChatGPT mints a fresh MCP session PER CALL) put the search and the create
  // in different sessions — a session-keyed join would attribute nothing at all
  // for exactly the clients this signal comes from.
  const recentNarrow: { t: number; searchLen: number; results: number; session: string; clientKind?: string }[] = [];
  // The language a caller was last steered into. A render_item that reports the
  // refusal carries no `lang` of its own — the language was chosen back at the
  // create, which for a stateless host is a different session entirely — so the
  // "routed to" column has to be recovered the same way the search is.
  const recentLang: { t: number; lang: string; session: string; clientKind?: string }[] = [];

  // Chronological: attribution looks BACKWARD from a rejection, so the searches
  // have to have been seen already. gcloud returns newest-first.
  const chron = [...inWin].sort((a, b) => (toMillis(a.t) ?? 0) - (toMillis(b.t) ?? 0));

  for (const e of chron) {
    const nonUser = e.session ? isNonUser(e.session) : false;
    if (e.ev === 'mcp_connect') { connects++; continue; }
    if (e.ev === 'mcp_listed') { if (e.session) stageSessions.listed.add(e.session); continue; }
    if (e.ev === 'mcp_resource') { if (e.session) stageSessions.resource.add(e.session); continue; }
    // mcp_tool
    toolTotal++;
    if (nonUser) nonUserCalls++; else userToolTotal++;
    if (e.outcome === 'ok') { toolOk++; if (!nonUser) userToolOk++; }
    else if (e.outcome === 'generation_failed') toolGenFailed++;
    else if (e.outcome === 'error') {
      toolError++;
      const ms = typeof e.ms === 'number' ? e.ms : 0;
      if (ms > maxErrorMs) maxErrorMs = ms;
      // A slow error is almost always an upstream timeout, not a validation
      // failure (cap/short-input errors return in 1-5s before any model call).
      if (ms >= slowMs) {
        slowErrors++;
        slowErrorSamples.push({ tool: e.tool ?? '?', ms, t: e.t, session: e.session, lang: e.lang });
      }
    }
    if (e.session) stageSessions.tool.add(e.session);
    if (e.outcome === 'generation_failed' && e.err && SCOPE_REJECTION.test(e.err) && !nonUser) {
      const at = toMillis(e.t) ?? 0;
      // Prefer the same session (session-stable hosts give a real join); fall
      // back to the most recent narrow search from the same client kind inside
      // the lookback. The fallback is a CORRELATION, not a causal link — it is
      // flagged as such in the output so nobody reads it as a traced path.
      const candidates = recentNarrow.filter((n) => at - n.t >= 0 && at - n.t <= SCOPE_LOOKBACK_MS);
      const hit =
        candidates.filter((n) => n.session === e.session).pop() ??
        candidates.filter((n) => n.clientKind && n.clientKind === e.client_kind).pop();
      const langPool = recentLang.filter((n) => at - n.t >= 0 && at - n.t <= SCOPE_LOOKBACK_MS);
      const langHit =
        langPool.filter((n) => n.session === e.session).pop() ??
        langPool.filter((n) => n.clientKind && n.clientKind === e.client_kind).pop();
      scopeRejections.push({
        repeats: 1,
        t: e.t,
        tool: e.tool ?? '?',
        lang: e.lang ?? langHit?.lang,
        clientKind: e.client_kind,
        session: e.session,
        err: e.err,
        search: hit
          ? { t: new Date(hit.t).toISOString(), searchLen: hit.searchLen, results: hit.results, sameSession: hit.session === e.session }
          : undefined,
      });
    }
    if (e.tool && READ_TOOLS.has(e.tool)) browseCalls++;
    // Catalogue shape counts real callers only — same rule as the tool-success
    // rates above. Scanners search for junk by design and our own probes search
    // for known-missing terms to test the instrumentation; both land as
    // zero-result searches and would otherwise BE the discovery signal.
    if (e.tool === 'list_languages' && !nonUser) {
      catalogCalls++;
      if (e.domain) catalogDomains[e.domain] = (catalogDomains[e.domain] || 0) + 1;
      if (typeof e.search_len === 'number' && e.search_len > 0) {
        catalogSearches++;
        // results is absent on the error path and on pre-instrumentation events;
        // only an explicit 0 counts as "asked for something we don't have".
        if (e.results === 0) catalogEmpty++;
        if (typeof e.results === 'number' && e.results > 0 && e.results <= NARROW_RESULTS) {
          catalogNarrow++;
          recentNarrow.push({
            t: toMillis(e.t) ?? 0,
            searchLen: e.search_len,
            results: e.results,
            session: e.session,
            clientKind: e.client_kind,
          });
        }
      }
    }
    if (e.lang && (e.tool === 'create_item' || e.tool === 'update_item')) {
      recentLang.push({ t: toMillis(e.t) ?? 0, lang: e.lang, session: e.session, clientKind: e.client_kind });
    }
    if (e.tool === 'create_item') {
      createCalls++;
      if (e.session) stageSessions.create.add(e.session);
      const prev = firstCreateBySession[e.session];
      if (!prev || toMillis(e.t)! < toMillis(prev.t)!) firstCreateBySession[e.session] = e;
    }
    if (e.tool === 'update_item') {
      updateCalls++;
      if (e.session) stageSessions.update.add(e.session);
    }
    if (e.lang) langCounts[e.lang] = (langCounts[e.lang] || 0) + 1;
  }

  // Roll every session into its segment.
  for (const sess of sessions) {
    const x = segOf(bucketOfSession(sess));
    x.sessions++;
    if (sessionAuth[sess] === 'freePlan') x.freePlanSessions++;
    if (stageSessions.listed.has(sess)) x.listed++;
    if (stageSessions.resource.has(sess)) x.resource++;
    if (stageSessions.tool.has(sess)) x.toolSessions++;
    if (stageSessions.listed.has(sess) && stageSessions.tool.has(sess)) x.listedAndCalled++;
    if (stageSessions.create.has(sess)) x.createSessions++;
    if (stageSessions.update.has(sess)) x.updateSessions++;
  }
  for (const e of inWin) {
    if (e.ev !== 'mcp_tool' || !e.session) continue;
    const x = segOf(bucketOfSession(e.session));
    x.calls++;
    if (e.outcome === 'ok') x.ok++; else x.nonOk++;
  }

  const createSessions = Object.values(firstCreateBySession);
  const firstTrySuccess = createSessions.filter((e) => e.outcome === 'ok').length;
  const userCreateSessions = createSessions.filter((e) => !isNonUser(e.session));
  const userFirstTrySuccess = userCreateSessions.filter((e) => e.outcome === 'ok').length;
  slowErrorSamples.sort((a, b) => b.ms - a.ms);

  // Collapse repeats of one refusal into one request. The message is the
  // backend's own summary of what was asked for, so identical text is the same
  // ask; keep the EARLIEST event, which is the one carrying the search that led
  // to it.
  const byAsk = new Map<string, ScopeRejection>();
  for (const r of scopeRejections) {
    // Keyed on the refusal text ALONE. `lang` is recovered from a nearby create
    // and `search` from a nearby search, so both are absent on whichever repeat
    // falls outside the lookback — keying on either splits one person's single
    // request into two rows and doubles the demand count.
    //
    // 400 chars, tracking the server's 500-char cap. The refusal opens with 87
    // characters of fixed preamble ("This request doesn't fit any available
    // Graffiticode language. This request describes a "), so a short key spends
    // most of itself on boilerplate — at the previous 160 only 73 characters
    // actually distinguished one ask from another, and two unrelated requests
    // in the same area would have merged into one row and understated demand.
    const key = r.err.slice(0, 400);
    const prev = byAsk.get(key);
    if (!prev) { byAsk.set(key, r); continue; }
    prev.repeats++;
    // Keep whatever attribution any repeat managed to recover.
    prev.lang ??= r.lang;
    prev.search ??= r.search;
    if ((toMillis(r.t) ?? 0) < (toMillis(prev.t) ?? 0)) {
      prev.t = r.t; prev.tool = r.tool; prev.session = r.session;
    }
  }
  const asks = [...byAsk.values()].sort((a, b) => (toMillis(b.t) ?? 0) - (toMillis(a.t) ?? 0));

  // Tally distinct sessions per kind/country; bucket the rest as "unknown".
  const clientKindSessions: Record<string, number> = {};
  const geoCountrySessions: Record<string, number> = {};
  for (const sess of sessions) {
    const k = sessionKind[sess] || 'unknown';
    clientKindSessions[k] = (clientKindSessions[k] || 0) + 1;
    const c = sessionCountry[sess] || 'unknown';
    geoCountrySessions[c] = (geoCountrySessions[c] || 0) + 1;
  }

  const segments = BUCKET_ORDER.map((b) => seg.get(b)).filter(Boolean) as SegmentStats[];
  const nonUserSessions = (seg.get('scanner')?.sessions ?? 0) + (seg.get('internal')?.sessions ?? 0);

  return {
    connects,
    distinctSessions: sessions.size,
    listedSessions: [...stageSessions.listed].filter((x) => !crawlSessions.has(x)).length,
    crawlSessions: crawlSessions.size,
    resourceSessions: stageSessions.resource.size,
    browseCalls,
    createCalls,
    updateCalls,
    catalogCalls,
    catalogSearches,
    catalogEmpty,
    catalogDomains,
    catalogNarrow,
    scopeRejections: asks,
    scopeAfterNarrow: asks.filter((r) => r.search).length,
    sessionsWithCreate: createSessions.length,
    firstTrySuccess,
    toolTotal,
    toolOk,
    toolGenFailed,
    toolError,
    userToolTotal,
    userToolOk,
    userSessionsWithCreate: userCreateSessions.length,
    userFirstTrySuccess,
    nonUserCalls,
    nonUserSessions,
    slowMs,
    slowErrors,
    maxErrorMs,
    slowErrorSamples,
    langCounts,
    segments,
    clientKindSessions,
    geoCountrySessions,
  };
}

// --- A2. Claim events (console-side; anon→account) --------------------------
// Claims run in the console resolver, not the MCP server, so failures never
// reach the mcp_tool stream and Firestore only records successes. This reads
// the structured `claim` events emitted by claimFreePlanSession.
interface ClaimEvent {
  ev: 'claim';
  t: string;
  outcome: 'ok' | 'error';
  session: string;
  transferred?: number;
  err?: string;
}

function fetchClaimEvents(start: Date, end: Date): ClaimEvent[] {
  return readLogChunked(
    'resource.labels.service_name="console" AND jsonPayload.ev="claim"',
    start, end, 'claim events',
  ).map((e) => e.jsonPayload as ClaimEvent).filter((p) => p && p.ev === 'claim');
}

interface ClaimStats {
  attempts: number;
  ok: number;
  errors: number;
  transferred: number;
  errorSamples: { t: string; session: string; err?: string }[];
}

function summarizeClaims(events: ClaimEvent[], start: Date | null, end: Date): ClaimStats {
  const inWin = events.filter((e) => inWindow(toMillis(e.t), start, end));
  let attempts = 0, ok = 0, errors = 0, transferred = 0;
  const errorSamples: ClaimStats['errorSamples'] = [];
  for (const e of inWin) {
    attempts++;
    if (e.outcome === 'ok') {
      ok++;
      transferred += typeof e.transferred === 'number' ? e.transferred : 0;
    } else if (e.outcome === 'error') {
      errors++;
      errorSamples.push({ t: e.t, session: e.session, err: e.err });
    }
  }
  errorSamples.sort((a, b) => (toMillis(b.t) ?? 0) - (toMillis(a.t) ?? 0));
  return { attempts, ok, errors, transferred, errorSamples };
}

// --- A3. Artifact-view events (app render host; P5-09) ----------------------
// app.graffiticode.org/form/<id> emits one `artifact_view` per page load (the
// resolve route). The app has no salt and the console doesn't forward the
// session, so the event carries the item id; we join it to a session via the
// free-plan items' doc id → sessionNamespace map below. The render-host page
// polls resolve ~every 8s, so raw views over-count — we dedup by session.
interface ArtifactViewEvent {
  ev: 'artifact_view';
  t: string;
  item: string;
  authed: boolean;
  allowed: boolean;
}

function fetchArtifactViewEvents(start: Date, end: Date): ArtifactViewEvent[] {
  return readLogChunked(
    'resource.labels.service_name="app" AND jsonPayload.ev="artifact_view"',
    start, end, 'artifact_view events',
  ).map((e) => e.jsonPayload as ArtifactViewEvent).filter((p) => p && p.ev === 'artifact_view');
}

interface ArtifactViewStats {
  viewEvents: number;            // raw allowed views in window (pre-dedup)
  distinctItemsViewed: number;   // distinct free-plan items whose page was opened
  viewedSessions: number;        // distinct free-plan sessions with a viewed item
  viewedAndClaimed: number;      // of those sessions, how many went on to claim
}

function summarizeArtifactViews(
  events: ArtifactViewEvent[],
  itemToNamespace: Map<string, string>,
  claimedNamespaces: Set<string>,
  start: Date | null,
  end: Date,
): ArtifactViewStats {
  const inWin = events.filter((e) => e.allowed && inWindow(toMillis(e.t), start, end));
  const viewedItems = new Set<string>();
  const viewedSessions = new Set<string>();
  for (const e of inWin) {
    // Join the item to a free-plan session. Items not in the map are either
    // authed/already-claimed (out of the north-star funnel) or TTL-expired —
    // both intentionally excluded from the conversion view.
    const ns = itemToNamespace.get(e.item);
    if (!ns) continue;
    viewedItems.add(e.item);
    viewedSessions.add(ns);
  }
  const viewedAndClaimed = [...viewedSessions].filter((ns) => claimedNamespaces.has(ns)).length;
  return {
    viewEvents: inWin.length,
    distinctItemsViewed: viewedItems.size,
    viewedSessions: viewedSessions.size,
    viewedAndClaimed,
  };
}

// --- B. Firestore conversion tail -------------------------------------------
interface FsStats {
  freePlanSessions: number;    // distinct namespaces among free-plan items
  freePlanItems: number;
  iteratedItems: number;
  anonSessions: number;        // distinct anon namespaces ever seen (free-plan ∪ claimed)
  claimedSessions: number;     // distinct namespaces with a claimed item
  accounts: number;            // distinct owner uids of claimed items
  paidGlobal: number;          // all users on a paid plan
  paidFromClaim: number;       // claimed-account owners on a paid plan
  spendUsd: number;
  claimedNamespaces: Set<string>;
  itemToNamespace: Map<string, string>;  // free-plan item doc id → sessionNamespace (artifact-view join)
}

async function fetchFirestore(start: Date | null, end: Date): Promise<FsStats> {
  // Free-plan items (one Firestore account, namespaced per session); filter window client-side.
  const freeSnap = await db.collectionGroup('items').where('freePlan', '==', true).get();
  let freePlanItems = 0, iteratedItems = 0;
  const freePlanSessionSet = new Set<string>();
  const itemToNamespace = new Map<string, string>();
  freeSnap.forEach((doc) => {
    const d = doc.data();
    // The artifact-view join uses the item doc id, which view_url embeds. Map it
    // regardless of the window so a view of an item created just before the
    // window still resolves to its session.
    if (typeof d.sessionNamespace === 'string') itemToNamespace.set(doc.id, d.sessionNamespace);
    const created = toMillis(d.created);
    if (!inWindow(created, start, end)) return;
    freePlanItems++;
    if (typeof d.sessionNamespace === 'string') freePlanSessionSet.add(d.sessionNamespace);
    if (helpLen(d.help) > 1) iteratedItems++;
  });

  // Claimed items → sessions + accounts.
  const claimSnap = await db.collectionGroup('items').where('claimedFrom', '!=', null).get();
  const claimedNamespaces = new Set<string>();
  const accountUids = new Set<string>();
  claimSnap.forEach((doc) => {
    const d = doc.data();
    const claimedAt = toMillis(d.updated) ?? toMillis(d.created);
    if (!inWindow(claimedAt, start, end)) return;
    // Prefer the namespace the claim resolver actually queried. Re-hashing
    // `claimedFrom` is only correct when the claiming session was the one that
    // created the items; with workspace adoption it often isn't, so the hash
    // resolves to a namespace holding nothing and the join silently drops the
    // claim. Fall back to the hash for items claimed before the field existed.
    if (typeof d.claimedFromNamespace === 'string') {
      claimedNamespaces.add(d.claimedFromNamespace);
    } else if (typeof d.claimedFrom === 'string') {
      claimedNamespaces.add(deriveSessionNamespace(d.claimedFrom));
    }
    const ownerUid = doc.ref.parent.parent?.id;
    if (ownerUid) accountUids.add(ownerUid);
  });

  // Paid users.
  const paidSnap = await db.collection('users').where('subscription.status', '==', 'active').get();
  let paidGlobal = 0;
  const paidUids = new Set<string>();
  paidSnap.forEach((doc) => {
    const plan = doc.data()?.subscription?.plan;
    if (plan && plan !== 'demo') { paidGlobal++; paidUids.add(doc.id); }
  });
  const paidFromClaim = [...accountUids].filter((uid) => paidUids.has(uid)).length;

  // Free-plan spend over the window's UTC days.
  let spendUsd = 0;
  const dayStart = start ?? new Date(Date.now() - 30 * 864e5);
  for (let t = dayStart.getTime(); t <= end.getTime(); t += 864e5) {
    const day = new Date(t);
    const key = `spend-${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`;
    const snap = await db.collection('free-plan-state').doc(key).get();
    if (snap.exists) { const usd = Number(snap.data()?.usd); if (Number.isFinite(usd)) spendUsd += usd; }
  }

  // Claimed sessions left the free-plan pool, so union both for the true
  // "distinct anonymous sessions ever seen" denominator.
  const anonSessions = new Set([...freePlanSessionSet, ...claimedNamespaces]).size;

  return {
    freePlanSessions: freePlanSessionSet.size,
    freePlanItems,
    iteratedItems,
    anonSessions,
    claimedSessions: claimedNamespaces.size,
    accounts: accountUids.size,
    paidGlobal,
    paidFromClaim,
    spendUsd,
    claimedNamespaces,
    itemToNamespace,
  };
}

// --- HTML -------------------------------------------------------------------
function card(label: string, value: string, sub = ''): string {
  return `<div class="card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function funnelRow(stage: string, count: number | string, conv: string, note = ''): string {
  return `<tr><td>${stage}</td><td class="num">${count}</td><td class="num">${conv}</td><td class="note">${note}</td></tr>`;
}

// One row per OMTM. A table with a fixed two-row body, deliberately not cards:
// adding a third OMTM has to be a visible structural edit, not one more div.
function omtmRow(funnel: string, m: Metric): string {
  return `<tr><td>${funnel}</td><td><b>${m.name}</b></td><td class="num" style="font-size:1.2rem;font-weight:600;">${m.value}</td>` +
    `<td>${m.owner}</td><td class="note">${m.window}</td><td class="note">${m.source}</td></tr>`;
}

function gateRow(gate: string, target: string, actual: string, passed: boolean, evidence: string): string {
  const status = actual === '—' ? '<span class="note">not measured</span>' : passed ? '✅ met' : '◐ open';
  return `<tr><td>${gate}</td><td class="num">${target}</td><td class="num">${actual}</td><td>${status}</td><td class="note">${evidence}</td></tr>`;
}

function generateHtml(data: {
  periodLabel: string;
  freshness: string;
  log: LogStats;
  fs: FsStats;
  claims: ClaimStats;
  av: ArtifactViewStats;
  omtm: WeeklyNewCreatingWorkspaces;
  agentMetric: Metric;
  partnerMetric: Metric;
  cumulativeWorkspaces: number;
}): string {
  const now = new Date().toISOString();
  const { log, fs, claims, av } = data;

  const claimConversion = pct(fs.accounts, fs.anonSessions);
  const firstAttemptSuccess = pct(log.userFirstTrySuccess, log.userSessionsWithCreate);
  const overallSuccess = pct(log.userToolOk, log.userToolTotal);
  const toolSessionsTotal = log.segments.reduce((a, g) => a + g.toolSessions, 0);
  // "Calls per session" is meaningless blended: ChatGPT mints a session per
  // call (pinning it near 1.0) while Claude contributes thousands of zero-call
  // startup handshakes. Depth is now expressed as listed→called instead, which
  // is a real behavioural step rather than an artifact of transport policy.
  // Aggregate the SAME-SESSION rate, and only over segments that represent
  // people: crawl/scanner/internal are held out here for the reason
  // `log.listedSessions` already holds crawls out — a machine that lists
  // thousands of times and never calls drives the rate to zero while saying
  // nothing about whether people find the tools useful.
  const realSegments = log.segments.filter(countsTowardAggregate);
  const heldOut = log.segments.filter((g) => g.bucket === 'claude_ua');
  const heldOutSessions = heldOut.reduce((a, g) => a + g.sessions, 0);
  const heldOutListed = heldOut.reduce((a, g) => a + g.listed, 0);
  const agg = realSegments.reduce((a, g) => ({
    listed: a.listed + g.listed,
    toolSessions: a.toolSessions + g.toolSessions,
    listedAndCalled: a.listedAndCalled + g.listedAndCalled,
  }), { listed: 0, toolSessions: 0, listedAndCalled: 0 });
  const listedToCalled = listedConv(agg);
  // Tool sessions the rate above CANNOT see, because they never listed. This is
  // not a rounding detail: it is most of OpenAI's traffic, and quoting the rate
  // without it is how the blended number used to imply a bounce that never
  // happened.
  const unlistedToolSessions = agg.toolSessions - agg.listedAndCalled;
  const costPerAccount = fs.accounts ? `$${(fs.spendUsd / fs.accounts).toFixed(3)}` : '—';

  const langRows = Object.entries(log.langCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, n]) => `<tr><td>${lang}</td><td class="num">${n}</td></tr>`)
    .join('\n') || '<tr><td colspan="2" class="note">no language activity in window</td></tr>';

  // Distinct-session breakdowns by agent kind and country. "unknown" buckets
  // sessions with no value (connect-only sessions lack client_kind; pre-deploy
  // events lack both) — expected during the instrumentation fill-in window.
  const breakdownRows = (counts: Record<string, number>, emptyLabel: string) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<tr><td>${k}</td><td class="num">${n}</td><td class="num">${pct(n, log.distinctSessions)}</td></tr>`)
      .join('\n') || `<tr><td colspan="3" class="note">${emptyLabel}</td></tr>`;
  const kindRows = breakdownRows(log.clientKindSessions, 'no client-kind data in window (deploy pending?)');
  const geoRows = breakdownRows(log.geoCountrySessions, 'no geo data in window (deploy pending?)');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MCP Funnel Report</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f8fafc; color:#1e293b; padding:24px; max-width:1000px; margin:0 auto; }
  h1 { font-size:1.5rem; margin-bottom:4px; }
  h2 { font-size:1.1rem; margin:28px 0 12px; }
  .subtitle { color:#64748b; font-size:.875rem; margin-bottom:24px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin-bottom:8px; }
  .card { background:#fff; border-radius:8px; padding:16px; box-shadow:0 1px 3px rgba(0,0,0,.1); }
  .card.north { border-left:4px solid #6366f1; }
  .card .label { font-size:.7rem; color:#64748b; text-transform:uppercase; letter-spacing:.05em; }
  .card .value { font-size:1.6rem; font-weight:600; margin-top:4px; }
  .card .sub { font-size:.72rem; color:#94a3b8; margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.1); font-size:.85rem; }
  th,td { padding:9px 12px; text-align:left; border-bottom:1px solid #e2e8f0; }
  th { background:#f1f5f9; font-weight:600; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; color:#475569; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.note { color:#94a3b8; font-size:.78rem; }
  .banner { background:#fffbeb; border:1px solid #fde68a; color:#92400e; padding:10px 14px; border-radius:8px; font-size:.8rem; margin-bottom:20px; }
  .banner-red { background:#fef2f2; border-color:#fecaca; color:#991b1b; }
</style></head><body>
<h1>MCP Funnel Report</h1>
<p class="subtitle">Period: ${data.periodLabel} · logs read: ${data.freshness} · generated ${now}</p>

<div class="banner">
  <b>Two views, two sources, two time-coverages.</b> The <b>Engagement</b> table is the live MCP
  event stream (Cloud Logging) and only covers traffic <b>since the instrumented server deployed</b>.
  The <b>Items &amp; conversion</b> table is Firestore state and includes <b>historical</b> items
  that predate instrumentation. So the two tables won't reconcile yet — that's expected during the
  fill-in window, not a bug. Guardrail ratios are computed within whichever source has the data.
  <br><br>
  The <b>OMTM</b> comes from neither: it reads the Firestore <b>workspaces</b> registry, which is
  durable and has no retention ceiling. It will not reconcile with the log-derived session counts —
  different source, window and exclusions. Do not "fix" that by moving the OMTM back onto logs;
  Cloud Logging retains ~30 days, which is exactly what makes "new" uncomputable there.
</div>

${data.omtm.isClockStartWeek ? `<div class="banner banner-red">
  <b>Week 1 — not trend data.</b> The workspace registry started on ${OMTM_CLOCK_START} and no backfill
  was performed (decided 2026-08-07). Every workspace that already existed reads as new this week.
  Label it as such and discard it from trend lines.
</div>` : ''}

<h2>1 · Current OMTMs</h2>
<p class="subtitle" style="margin:-4px 0 12px;">
  Exactly two — one per funnel. A diagnostic or platform-health measure is never a third
  (contract §3). Definitions: graffiticode-funnel-and-omtm-contract.md §4.
</p>
<table>
  <thead><tr><th>Funnel</th><th>OMTM</th><th class="num">Value</th><th>Owner</th><th>Window</th><th>Source</th></tr></thead>
  <tbody>
    ${omtmRow('Agent', data.agentMetric)}
    ${omtmRow('Service partner', data.partnerMetric)}
  </tbody>
</table>
<p class="note" style="margin-top:8px;font-size:.78rem;">
  Agent formula: ${data.agentMetric.formula}.<br>
  ${data.agentMetric.note ?? ''}
  ${data.omtm.authedDiagnostic ? `<br><b>${data.omtm.authedDiagnostic}</b> authenticated workspace(s) excluded from the published number (diagnostic only).` : ''}
  ${data.omtm.internalExcluded ? `<br><b>${data.omtm.internalExcluded}</b> row(s) suppressed as internal traffic.` : ''}
</p>

<h2>2 · Empathy milestone progress</h2>
<table>
  <thead><tr><th>Gate</th><th class="num">Target</th><th class="num">Actual</th><th>Status</th><th>Evidence</th></tr></thead>
  <tbody>
    ${gateRow('Qualified external first-create attempts', '≥ 30', String(data.cumulativeWorkspaces), data.cumulativeWorkspaces >= 30, 'workspaces registry (auto)')}
    ${gateRow('Genuine, in-scope artifact jobs', '≥ 70%', '—', false, 'manual — prompt audit, Agent Empathy memo')}
    ${gateRow('Descriptions reveal repeatable job patterns', 'qualitative', '—', false, 'manual — Agent Empathy memo')}
    ${gateRow('Provider interviews completed', '12', '—', false, 'manual — partner interview log')}
    ${gateRow('Name the problem unprompted', '≥ 9 of 12', '—', false, 'manual — partner interview log')}
    ${gateRow('Buying/partnering seriously on the table', '≥ 6 of 12', '—', false, 'manual — partner interview log')}
    ${gateRow('Request a product-specific working session', '≥ 5 of 12', '—', false, 'manual — the partner OMTM line in the sand')}
  </tbody>
</table>

<h2>3 · Platform guardrails &amp; diagnostics</h2>
<p class="subtitle" style="margin:-4px 0 12px;">
  Evidence supporting both funnels. Never a third funnel, never a competing OMTM (contract §3).
</p>
<div class="cards">
  ${card('First-attempt success', firstAttemptSuccess, `${log.firstTrySuccess} ok / ${log.sessionsWithCreate} first creates — guardrail`)}
  ${card('Claim conversion', claimConversion, `${fs.accounts} accounts / ${fs.anonSessions} anon sessions — diagnostic`)}
  ${card('Tool success (users)', overallSuccess, `${log.userToolOk}/${log.userToolTotal} calls — ${log.nonUserCalls} non-user call(s) excluded`)}
  ${card('Listed → called a tool', listedToCalled, `${agg.listedAndCalled} of ${agg.listed} sessions did both` +
    (unlistedToolSessions ? ` — ${unlistedToolSessions} tool session(s) never listed and are not in this rate` : '') +
    (heldOutListed ? `; excludes ${heldOutListed} Anthropic/ClaudeAI UA listing(s)` : ''))}
  ${card('Free-plan spend', `$${fs.spendUsd.toFixed(2)}`, costPerAccount + ' / account')}
  ${card('Paid (from claim)', `${fs.paidFromClaim}`, `${fs.paidGlobal} paid overall`)}
</div>
<p class="note" style="margin-top:8px;font-size:.78rem;">
  <b>First-attempt success</b> is a reliability guardrail, not demand: counting only successful creates
  would let a regression here read as a demand collapse, which is why the OMTM counts attempts
  (contract §4). <b>Claim conversion</b> is downstream of activation, which is the artifact being
  <i>opened</i> — a create nobody looked at is not activation (contract §2).
</p>

<h2>Engagement by client <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(MCP event logs, since instrumentation deployed)</span></h2>
<div class="banner banner-red">
  <b>Do not add these session columns up.</b> A "session" is one MCP transport, and
  clients mint transports on incompatible policies, so the number means something
  different in each row — in opposite directions:
  <ul style="margin:6px 0 0 18px;">
    <li><b>Claude surfaces</b> open a transport and call <code>tools/list</code> at connector
        <i>startup</i>, whether or not the user ever invokes us. Their session count is an
        installed-base &times; sessions figure, not intent.</li>
    <li><b>ChatGPT / Codex</b> opens a <i>new transport per tool call</i> — one continuous
        24-minute conversation was observed as 58 calls across 58 sessions — so its session
        count overstates real conversations by roughly an order of magnitude.</li>
    <li><b>Free-plan</b> sessions are keyed per transport; <b>authenticated</b> sessions are keyed
        by API-key hash and so collapse a whole week of work into one row.</li>
  </ul>
  The behavioural step that <i>is</i> comparable is <b>listed &rarr; called a tool</b> &mdash; but only
  counted <i>within one session</i>, which is how the column below is computed. Not every client
  loads the catalogue once per session (ChatGPT/Codex mostly never lists at all), so a rate blended
  across clients divides one client's calls by another's listings and invents a drop-off. Read the
  column per row; the &dagger;/&Dagger; footnotes say when even that has no meaning.
</div>
<table>
  <thead><tr><th>Client</th><th class="num">Sessions</th><th class="num">Listed</th><th class="num">Read resource</th><th class="num">Called a tool</th><th class="num">Listed <i>and</i> called</th><th class="num">Listed→called</th><th class="num">Created</th><th class="num">Updated</th><th class="num">Calls</th><th class="num">Free-plan</th></tr></thead>
  <tbody>
    ${log.segments.map((g) => `<tr><td>${g.label}</td><td class="num">${g.sessions}</td><td class="num">${g.listed}</td><td class="num">${g.resource}</td><td class="num">${g.toolSessions}</td><td class="num">${g.listedAndCalled}</td><td class="num">${listedConv(g)}</td><td class="num">${g.createSessions}</td><td class="num">${g.updateSessions}</td><td class="num">${g.calls}</td><td class="num">${g.freePlanSessions}</td></tr>`).join('\n    ') || '<tr><td colspan="11" class="note">no events in window</td></tr>'}
  </tbody>
</table>
<p class="note" style="margin-top:8px;"><b>Listed</b> = the session issued a <code>tools/list</code>-family request (<code>mcp_listed</code>). <b>Read resource</b> = it read a <code>graffiticode://</code> resource (<code>mcp_resource</code>). Both stages sit between "a transport opened" and "someone asked for something" — without them a directory validator that loaded the catalogue and a user who actually worked are indistinguishable.<br>
<b>Listed&rarr;called</b> counts only sessions that did <i>both</i>, so it is a real per-client conversion and never divides one client's listings by another's calls.<br>
<b>† n/a</b> = this client had more tool-calling sessions than listing sessions, so it does not call <code>tools/list</code> once per session and the ratio is not a conversion. ChatGPT/Codex is the standing example: a new transport per tool call means most of its tool sessions never list at all.<br>
<b>‡ n/a</b> = this client both listed and called, but never in the same session, so there is no conversion to measure &mdash; the two counts describe different transports.<br>
<b>Anthropic/ClaudeAI UA</b> is a UA-shaped name (capitalised, slash-separated), not the lowercase hyphenated <code>clientInfo.name</code> every real Claude host sends. It keeps its row and its own rate, but is held out of the blended rate: it carries roughly half of all catalogue loads and almost no calls, so including it would make the blended number a statement about it rather than about people. Probes, scanners and our own tooling are held out for the same reason.</p>

<h2>Engagement — call volume <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(calls, not sessions — safe to total)</span></h2>
<table>
  <thead><tr><th>Stage</th><th class="num">Count</th><th class="num">Conv. from prev</th><th>Note</th></tr></thead>
  <tbody>
    ${funnelRow('Loaded the catalogue (sessions)', log.listedSessions, '—', `mcp_listed — the real top of the funnel${log.crawlSessions ? `; ${log.crawlSessions} automated crawl session(s) excluded` : ''}`)}
    ${funnelRow('Called any tool (sessions)', toolSessionsTotal, listedToCalled + ' of listed (same session)', 'the step that separates intent from installation')}
    ${funnelRow('Browsed (read-route calls)', log.browseCalls, '—', 'list_languages · get_language_info · get_item')}
    ${funnelRow('Catalogue searches', log.catalogSearches, pct(log.catalogSearches, log.catalogCalls) + ' of catalogue calls', `${log.catalogEmpty} matched nothing — a capability asked for and not advertised`)}
    ${funnelRow('Create calls', log.createCalls, pct(log.sessionsWithCreate, toolSessionsTotal) + ' of tool sessions', `${log.sessionsWithCreate} sessions created an item`)}
    ${funnelRow('Update calls (iterate)', log.updateCalls, pct(log.updateCalls, log.createCalls) + ' of creates', 'create → revisit')}
  </tbody>
</table>

<h2>Items &amp; conversion — Firestore <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(includes pre-instrumentation history)</span></h2>
<table>
  <thead><tr><th>Stage</th><th class="num">Count</th><th class="num">Conv. from prev</th><th>Note</th></tr></thead>
  <tbody>
    ${funnelRow('Anonymous sessions', fs.anonSessions, '—', 'distinct namespaces, free-plan ∪ claimed')}
    ${funnelRow('Free-plan items created', fs.freePlanItems, (fs.anonSessions ? (fs.freePlanItems / fs.anonSessions).toFixed(2) : '—') + ' items/session', `${fs.freePlanSessions} sessions still hold free-plan items`)}
    ${funnelRow('Iterated (≥2 turns)', fs.iteratedItems, pct(fs.iteratedItems, fs.freePlanItems) + ' of items', 'help has more than the create turn')}
    ${funnelRow('Artifact viewed (free-plan)', av.viewedSessions, pct(av.viewedSessions, fs.freePlanSessions) + ' of free-plan sessions', `${av.distinctItemsViewed} items · ${av.viewEvents} raw views (P5-09; logs ∩ Firestore)`)}
    ${funnelRow('Claimed', fs.claimedSessions, pct(fs.claimedSessions, fs.anonSessions) + ' of anon sessions', 'distinct claimed namespaces')}
    ${funnelRow('↳ Artifact-view → claim', av.viewedAndClaimed, pct(av.viewedAndClaimed, av.viewedSessions) + ' of viewed sessions', 'viewed free-plan sessions that went on to claim')}
    ${funnelRow('Account created', fs.accounts, pct(fs.accounts, fs.claimedSessions) + ' of claims', 'distinct owner uids')}
    ${funnelRow('Paid', fs.paidFromClaim, pct(fs.paidFromClaim, fs.accounts) + ' of accounts', 'paid plan & active')}
  </tbody>
</table>
<p class="note" style="margin-top:8px;">Artifact-view rows count only free-plan items still in Firestore (TTL 48h) whose <code>artifact_view</code> events resolve to a session; views of already-claimed/authed items and expired free-plan items are excluded by design. A low count can mean little render-host traffic <em>or</em> events not yet flowing (the app deploy that emits <code>artifact_view</code> must be live).</p>

<h2>Claim attempts <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(anon→account — console claimFreePlanSession events)</span></h2>
${claims.attempts ? `<div class="cards">
  ${card('Claim success', pct(claims.ok, claims.attempts), `${claims.ok}/${claims.attempts} attempts`)}
  ${card('Failed claims', `${claims.errors}`, claims.errors ? 'broken claim path — investigate' : 'none')}
  ${card('Items transferred', `${claims.transferred}`, 'across successful claims')}
</div>
${claims.errors ? `<div class="banner" style="background:#fef2f2;border-color:#fecaca;color:#991b1b;">
  <b>${claims.errors} claim(s) FAILED in window</b> — the anonymous→account step is dropping conversions. These never appear in the tool-call stream (claims run console-side). Most recent:
</div>
<table>
  <thead><tr><th>Time (UTC)</th><th>Session</th><th>Error</th></tr></thead>
  <tbody>
    ${claims.errorSamples.slice(0, 20).map((s) => `<tr><td>${s.t.slice(0, 19).replace('T', ' ')}</td><td class="note">${s.session.slice(0, 12)}…</td><td class="note">${(s.err ?? '').replace(/</g, '&lt;').slice(0, 200)}</td></tr>`).join('\n    ')}
  </tbody>
</table>` : ''}` : `<p class="note">No claim events in window. (Requires the console deploy that emits <code>claim</code> events — until then this stays empty even if claims occur.)</p>`}

<h2>Tool-call outcomes</h2>
<p class="note" style="margin:-4px 0 10px;">Shares below are over <b>all</b> ${log.toolTotal} calls including
scanners. The reliability guardrail above deliberately uses the user-only rate
(<b>${overallSuccess}</b>, ${log.userToolOk}/${log.userToolTotal}): automated crawlers call tools with
junk item ids on purpose, so counting them measures the scanner, not the service. In the
2026-08-13→20 week, 20 of 24 non-ok outcomes came from a single beacon and dragged the
blended rate from ~99% to 92.7%.</p>
<table>
  <thead><tr><th>Outcome</th><th class="num">Count</th><th class="num">Share</th><th>Note</th></tr></thead>
  <tbody>
    <tr><td>ok</td><td class="num">${log.toolOk}</td><td class="num">${pct(log.toolOk, log.toolTotal)}</td><td class="note"></td></tr>
    <tr><td>generation_failed</td><td class="num">${log.toolGenFailed}</td><td class="num">${pct(log.toolGenFailed, log.toolTotal)}</td><td class="note">backend rejected (e.g. free-plan cap, invalid input) — fast</td></tr>
    <tr><td>error</td><td class="num">${log.toolError}</td><td class="num">${pct(log.toolError, log.toolTotal)}</td><td class="note">${log.slowErrors} slow (&ge;${(log.slowMs / 1000).toFixed(0)}s) → likely timeouts${log.maxErrorMs ? `; slowest ${(log.maxErrorMs / 1000).toFixed(0)}s` : ''}</td></tr>
  </tbody>
</table>

<h2>Likely timeouts <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(error outcomes ≥ ${(log.slowMs / 1000).toFixed(0)}s — full-sheet regen / upstream timeout, not a validation reject)</span></h2>
${log.slowErrorSamples.length ? `<table>
  <thead><tr><th>Time (UTC)</th><th>Tool</th><th>Lang</th><th class="num">Latency</th><th>Session</th></tr></thead>
  <tbody>
    ${log.slowErrorSamples.slice(0, 30).map((s) => `<tr><td>${s.t.slice(0, 19).replace('T', ' ')}</td><td>${s.tool}</td><td>${s.lang ?? ''}</td><td class="num">${(s.ms / 1000).toFixed(1)}s</td><td class="note">${s.session.slice(0, 12)}…</td></tr>`).join('\n    ')}
  </tbody>
</table>
${log.slowErrors > 30 ? `<p class="note">… and ${log.slowErrors - 30} more.</p>` : ''}` : `<p class="note">None in window. (Adjust the threshold with <code>--slow-ms</code>; default 60000.)</p>`}

<h2>Unmet requests <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(the backend refused as out of scope — what people wanted that Graffiticode does not do)</span></h2>
<p class="note">Each row is one ask, not one event: a refusal is replayed by every retrieval of the failed item, so repeats are collapsed and counted. The text is the backend's own summary of the request. These are <strong>candidate languages</strong> — the demand arrived, described itself, and left.</p>
${log.scopeRejections.length ? `<table>
  <thead><tr><th>Time (UTC)</th><th>Client</th><th>Routed to</th><th class="num">Seen</th><th>What was asked for</th><th>Reached it via</th></tr></thead>
  <tbody>
    ${log.scopeRejections.slice(0, 30).map((r) => `<tr><td>${r.t.slice(0, 16).replace('T', ' ')}</td><td>${r.clientKind ?? '?'}</td><td>${r.lang ?? '?'}</td><td class="num">${r.repeats}</td><td>${r.err.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))}</td><td class="note">${r.search ? `search ${r.search.searchLen}ch → ${r.search.results} match${r.search.results === 1 ? '' : 'es'}${r.search.sameSession ? '' : ' <em>(same client, different session — correlation)</em>'}` : '—'}</td></tr>`).join('\n    ')}
  </tbody>
</table>
<p class="note">${log.scopeAfterNarrow} of ${log.scopeRejections.length} followed a search matching ≤${NARROW_RESULTS} languages. That is the settle-for-the-nearest-match path: one hit reads to an agent as the answer rather than as a near miss, so the user describes the whole thing before the refusal lands. A zero-result search (${log.catalogEmpty} in window) is the easier case — there the agent named the gap directly.</p>` : `<p class="note">None in window.</p>`}

<h2>Language distribution (interest signal)</h2>
<table>
  <thead><tr><th>Language</th><th class="num">Calls</th></tr></thead>
  <tbody>${langRows}</tbody>
</table>

<h2>Agent kind <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(MCP client software, by distinct session)</span></h2>
<table>
  <thead><tr><th>Client kind</th><th class="num">Sessions</th><th class="num">Share</th></tr></thead>
  <tbody>${kindRows}</tbody>
</table>
<p class="note" style="margin-top:8px;"><code>unknown</code> = sessions with no <code>client_kind</code> yet: connect-only sessions (the field rides tool events, not <code>mcp_connect</code>) and any pre-instrumentation traffic.</p>

<h2>Geography <span style="font-weight:400;color:#94a3b8;font-size:.8rem;">(coarse country, by distinct session — no IP collected)</span></h2>
<table>
  <thead><tr><th>Country</th><th class="num">Sessions</th><th class="num">Share</th></tr></thead>
  <tbody>${geoRows}</tbody>
</table>
</body></html>`;
}

// --- main -------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  const { start, end } = windowBounds(opts);
  const logStart = deriveLogStart({ freshness: opts.freshness, start }, end);
  const logRangeLabel = `${logStart.toISOString().split('T')[0]} → ${end.toISOString().split('T')[0]}`;
  const periodLabel = start
    ? `${start.toISOString().split('T')[0]} → ${end.toISOString().split('T')[0]}`
    : `all time → ${end.toISOString().split('T')[0]}`;

  if (!process.env.FREE_PLAN_NAMESPACE_SALT) {
    console.warn('WARN: FREE_PLAN_NAMESPACE_SALT not set — claimed-namespace join key will not match logged sessions.');
  }

  console.log(`Reading MCP events (gcloud logging, ${logRangeLabel}, ${LOG_CHUNK_DAYS}d slices)...`);
  const events = fetchEvents(logStart, end);
  const log = summarizeEvents(events, start, end, opts.slowMs);

  const claims = summarizeClaims(fetchClaimEvents(logStart, end), start, end);

  console.log('Reading Firestore conversion tail...');
  const fs = await fetchFirestore(start, end);

  // Artifact views join the app render-host logs to the Firestore tail, so they
  // need fs (item→namespace map + claimed namespaces) computed first.
  const av = summarizeArtifactViews(
    fetchArtifactViewEvents(logStart, end), fs.itemToNamespace, fs.claimedNamespaces, start, end,
  );

  console.log('Reading workspace registry (OMTM)...');
  const omtm = await weeklyNewCreatingWorkspaces(db, { week: opts.week });
  const cumulativeWorkspaces = await totalCreatingWorkspaces(db);
  const agentMetric = agentOmtmMetric(omtm);
  const partnerMetric = partnerOmtmMetric({
    sessions: opts.partnerSessions,
    logUrl: opts.partnerLog || undefined,
  });

  const html = generateHtml({
    periodLabel, freshness: logRangeLabel, log, fs, claims, av,
    omtm, agentMetric, partnerMetric, cumulativeWorkspaces,
  });
  writeFileSync(opts.output, html);

  // The OMTMs print FIRST and alone. Everything below them is a guardrail or a
  // diagnostic, and the ordering is what keeps that distinction legible.
  console.log(`\n=== OMTM — week ${omtm.week} ===`);
  console.log(`Agent   : ${agentMetric.value}  ${agentMetric.name} (free-plan only)`);
  console.log(`Partner : ${partnerMetric.value}  ${partnerMetric.name} (manual log)`);
  if (omtm.isClockStartWeek) {
    console.log('  ! Week 1 — pre-existing workspaces count as new (no backfill). Not trend data.');
  }
  if (omtm.authedDiagnostic) console.log(`  (${omtm.authedDiagnostic} authenticated workspace(s) excluded — diagnostic only)`);
  if (omtm.internalExcluded) console.log(`  (${omtm.internalExcluded} row(s) suppressed as internal)`);
  console.log(`  Empathy gate: ${cumulativeWorkspaces}/30 cumulative first-create attempts since ${OMTM_CLOCK_START}`);

  // Terminal summary (handy even though the artifact is HTML). Two sources kept
  // visually separate — they cover different time windows during fill-in.
  console.log('\n=== MCP Funnel — ' + periodLabel + ' ===');
  console.log('-- Engagement by client (event logs, since deploy) --');
  // Segmented, and deliberately WITHOUT a blended session total: Claude inflates
  // sessions with connector-startup handshakes it never follows up on, and
  // ChatGPT mints a fresh session per tool call. Summing them measures nothing.
  const hdr = 'client'.padEnd(21) + ['sess', 'listed', 'res', 'tool', 'both', 'l→call', 'create', 'update', 'calls']
    .map((h) => h.padStart(7)).join('');
  console.log('  ' + hdr);
  console.log('  ' + '-'.repeat(hdr.length));
  for (const g of log.segments) {
    console.log('  ' + g.label.padEnd(21) + [g.sessions, g.listed, g.resource, g.toolSessions,
      g.listedAndCalled, listedConv(g), g.createSessions, g.updateSessions, g.calls]
      .map((n) => String(n).padStart(7)).join(''));
  }
  console.log('-- Engagement totals --');
  const toolSessTotal = log.segments.reduce((a, g) => a + g.toolSessions, 0);
  // Per family, because there is no single population to quote. `both` is the
  // numerator: sessions that listed AND called. Dividing the blended tool
  // sessions by the blended listings answers a question nobody asked — for most
  // windows it is OpenAI's calls over Claude's listings.
  // Displayed per-family: everything that is not a probe, INCLUDING claude_ua —
  // its row is the evidence for what it is. Aggregated: a narrower set.
  const shownSegs = log.segments.filter((g) => !isProbeSegment(g));
  const realSegs = log.segments.filter(countsTowardAggregate);
  const aggT = realSegs.reduce((a, g) => ({
    listed: a.listed + g.listed,
    toolSessions: a.toolSessions + g.toolSessions,
    listedAndCalled: a.listedAndCalled + g.listedAndCalled,
  }), { listed: 0, toolSessions: 0, listedAndCalled: 0 });
  console.log('Listed → called a tool (same session, per family):');
  console.log('  († client does not list once per session — its tool sessions mostly never list at all;');
  console.log('   ‡ it listed and it called, but never in the same session, so there is no rate to quote)');
  for (const g of shownSegs) {
    if (!g.listed && !g.toolSessions) continue;
    const excl = countsTowardAggregate(g) ? '' : '  [not in All families]';
    console.log(`  ${g.label.padEnd(21)} ${listedConv(g).padStart(7)}  (${g.listedAndCalled}/${g.listed} listed; ${g.toolSessions} tool session(s))${excl}`);
  }
  const unlisted = aggT.toolSessions - aggT.listedAndCalled;
  console.log(`  ${'All families'.padEnd(21)} ${listedConv(aggT).padStart(7)}  (${aggT.listedAndCalled}/${aggT.listed} listed)` +
    (unlisted ? ` — excludes ${unlisted} tool session(s) that never listed` : ''));
  console.log(`Listed tools (sessions): ${log.listedSessions}   tool sessions: ${toolSessTotal}   (counts, not a ratio)`);
  console.log(`Resource reads (sess)  : ${log.resourceSessions}`);
  const uaSeg = log.segments.find((g) => g.bucket === 'claude_ua');
  if (uaSeg?.sessions) {
    console.log(`Anthropic UA (excl.)   : ${uaSeg.sessions} session(s), ${uaSeg.listed} listed, ${uaSeg.toolSessions} tool session(s) — UA-shaped name, not a Claude host; held out of the rate above`);
  }
  if (log.crawlSessions) {
    console.log(`Catalog crawl (excl.)  : ${log.crawlSessions} session(s) — connect+list in back-to-back runs, never called anything; held out of the rate above`);
  }
  console.log(`Browse (read) calls    : ${log.browseCalls}`);
  const topN = (counts: Record<string, number>) => Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ') || '—';
  const asks = log.scopeRejections;
  console.log(`Unmet requests (scope) : ${asks.length}` +
    `${asks.length ? ` — ${log.scopeAfterNarrow} preceded by a narrow search (\u2264${NARROW_RESULTS} matches)` : ' — none in window'}`);
  for (const r of asks.slice(0, 8)) {
    const via = r.search
      ? `search ${r.search.searchLen}ch\u2192${r.search.results}${r.search.sameSession ? '' : ' (same client, not same session)'}`
      : 'no search attributed';
    console.log(`  ${r.t.slice(5, 16)}  ${(r.clientKind ?? '?').slice(0, 18).padEnd(18)} ${(r.lang ?? '?').padEnd(6)} x${r.repeats}  [${via}]`);
    console.log(`      ${r.err.slice(0, 150)}`);
  }
  if (asks.length > 8) console.log(`  … and ${asks.length - 8} more.`);
  console.log(`Catalog calls / search : ${log.catalogCalls} / ${log.catalogSearches}` +
    `${log.catalogSearches ? ` — ${pct(log.catalogEmpty, log.catalogSearches)} matched NOTHING (${log.catalogEmpty})` : ''}` +
    `${log.catalogNarrow ? `; ${log.catalogNarrow} narrow (\u2264${NARROW_RESULTS})` : ''}` +
    `${Object.keys(log.catalogDomains).length ? `; domains ${topN(log.catalogDomains)}` : ''}`);
  console.log(`Create / update calls  : ${log.createCalls} / ${log.updateCalls}`);
  console.log(`Tool success (users)   : ${pct(log.userToolOk, log.userToolTotal)} (${log.userToolOk}/${log.userToolTotal}) — excl. ${log.nonUserCalls} non-user call(s) (scanners + our own Inspector) from ${log.nonUserSessions} session(s)`);
  console.log(`Tool success (blended) : ${pct(log.toolOk, log.toolTotal)} (${log.toolOk}/${log.toolTotal}) — incl. scanners + internal; not a reliability signal`);
  console.log(`Errors / slow (timeouts): ${log.toolError} / ${log.slowErrors} (≥${(log.slowMs / 1000).toFixed(0)}s${log.maxErrorMs ? `, slowest ${(log.maxErrorMs / 1000).toFixed(0)}s` : ''})`);
  console.log(`Agent kind (sessions)  : ${topN(log.clientKindSessions)}`);
  console.log(`Geo country (sessions) : ${topN(log.geoCountrySessions)}`);
  console.log('-- Items & conversion (Firestore, incl. history) --');
  console.log(`Anon sessions          : ${fs.anonSessions}`);
  console.log(`Free-plan items / iter : ${fs.freePlanItems} / ${fs.iteratedItems}`);
  console.log(`Artifact views (sess)  : ${av.viewedSessions} (${av.distinctItemsViewed} items, ${av.viewEvents} raw)${av.viewEvents ? '' : ' — no artifact_view events (app deploy pending?)'}`);
  console.log(`Artifact-view → claim  : ${pct(av.viewedAndClaimed, av.viewedSessions)} (${av.viewedAndClaimed}/${av.viewedSessions})`);
  console.log(`Claimed → accounts     : ${fs.claimedSessions} → ${fs.accounts}`);
  console.log(`Claim attempts ok/err  : ${claims.ok}/${claims.errors}${claims.attempts ? ` (${pct(claims.ok, claims.attempts)} success, ${claims.transferred} items)` : ' (no claim events — deploy resolver instrumentation)'}`);
  console.log(`Paid (from claim/all)  : ${fs.paidFromClaim} / ${fs.paidGlobal}`);
  console.log(`Free-plan spend        : $${fs.spendUsd.toFixed(2)}`);
  console.log('-- Guardrails & diagnostics (never an OMTM) --');
  console.log(`First-attempt success  : ${pct(log.userFirstTrySuccess, log.userSessionsWithCreate)} (${log.userFirstTrySuccess}/${log.userSessionsWithCreate}) — reliability guardrail, scanners + internal excluded`);
  console.log(`Claim conversion       : ${pct(fs.accounts, fs.anonSessions)} (${fs.accounts}/${fs.anonSessions}) — downstream of activation`);
  console.log(`\nWrote ${opts.output}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
