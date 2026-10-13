#!/usr/bin/env node
/**
 * Funnel report for an arbitrary period — the same aggregation the hourly SMS
 * digest and the /r/<token> page use, driven from the command line.
 *
 * Shares src/lib/funnel-digest.ts (fetch + aggregate) and
 * src/lib/funnel-report-html.ts (render) rather than reimplementing either, so
 * a fix to the counting rules shows up here too. Distinct from
 * scripts/mcp-funnel-report.ts, which joins Cloud Logging against Firestore for
 * the conversion tail; this one is purely the event stream, over any window.
 *
 * Usage:
 *   npx tsx scripts/funnel-report.ts [--period hour|day|week|month]
 *                                    [--from ISO] [--to ISO]
 *                                    [--days N] [--output FILE] [--json] [--quiet]
 *
 * Examples:
 *   npx tsx scripts/funnel-report.ts --period day && open funnel-report.html
 *   npx tsx scripts/funnel-report.ts --from 2026-07-27T00:00:00Z --to 2026-07-28T00:00:00Z
 *   npx tsx scripts/funnel-report.ts --period week --days 14
 *
 * Requires: `gcloud auth login` (or ADC) with logging.read on graffiticode-app,
 * and GRAFFITICODE_APP_CREDENTIALS for the Firestore handle the shared module
 * opens at import time (this script never reads or writes digest state).
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// --- env, before importing anything that touches firebase-admin -------------
const envPath = resolve(process.cwd(), ".env.local");
try {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {
  // .env.local is optional; gcloud ADC may be enough
}
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
}

type Period = "hour" | "day" | "week" | "month";
const PERIOD_MS: Record<Period, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  let period: Period = "day";
  let from = "";
  let to = "";
  let days = 7;
  let output = "funnel-report.html";
  let json = false;
  let quiet = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--period" && a[i + 1]) period = a[++i] as Period;
    else if (a[i] === "--from" && a[i + 1]) from = a[++i];
    else if (a[i] === "--to" && a[i + 1]) to = a[++i];
    else if (a[i] === "--days" && a[i + 1]) days = parseInt(a[++i], 10);
    else if (a[i] === "--output" && a[i + 1]) output = a[++i];
    else if (a[i] === "--json") json = true;
    else if (a[i] === "--quiet") quiet = true;
    else if (a[i] === "--help" || a[i] === "-h") {
      console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 26).join("\n"));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a[i]}`);
      process.exit(1);
    }
  }
  if (!PERIOD_MS[period]) {
    console.error(`--period must be one of: ${Object.keys(PERIOD_MS).join(", ")}`);
    process.exit(1);
  }
  if (!Number.isFinite(days) || days < 1 || days > 60) {
    console.error("--days must be between 1 and 60");
    process.exit(1);
  }
  return { period, from, to, days, output, json, quiet };
}

async function main() {
  const opts = parseArgs(process.argv);

  // Imported after the env shuffle above: the shared module opens a Firestore
  // handle at import time and needs GOOGLE_APPLICATION_CREDENTIALS set first.
  const { fetchEvents, aggregateSplit, rollupOf, formatDigest, formatSms, ptDate } = await import(
    "../src/lib/funnel-digest"
  );
  const { renderReport } = await import("../src/lib/funnel-report-html");
  type DayPoint = import("../src/lib/funnel-report-html").DayPoint;

  const to = opts.to ? new Date(opts.to) : new Date(Date.now() - 60_000);
  const from = opts.from ? new Date(opts.from) : new Date(to.getTime() - PERIOD_MS[opts.period]);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    console.error("Invalid --from/--to range");
    process.exit(1);
  }

  // The trend needs whole PT days; the window may be shorter or start mid-day.
  // Fetch the union ONCE and bucket in memory — the report route issues a query
  // per day because it caches them, but a script has no cache and no reason to
  // pay N round trips.
  const todayStart = ptMidnight(to);
  const trendStart = new Date(todayStart.getTime() - (opts.days - 1) * 86_400_000);
  const fetchFrom = new Date(Math.min(trendStart.getTime(), from.getTime()));

  if (!opts.quiet) {
    console.error(`Reading events ${fetchFrom.toISOString()} → ${to.toISOString()} …`);
  }
  const { events, truncated } = await fetchEvents(fetchFrom, to);
  if (!opts.quiet) console.error(`${events.length} events${truncated ? " (READ CAPPED)" : ""}`);

  const inRange = (e: { t?: string }, lo: Date, hi: Date) => {
    const t = e.t ? Date.parse(e.t) : NaN;
    return Number.isFinite(t) && t >= lo.getTime() && t < hi.getTime();
  };
  // Novelty is meaningless for an ad-hoc window and must never touch the
  // persisted `seen` doc — that belongs to the SMS. Always a throwaway set.
  const fresh = () => ({ clientKinds: new Set<string>(), geos: new Set<string>() });

  const windowEvents = events.filter((e) => inRange(e, from, to));
  const split = aggregateSplit(windowEvents, { from, to, truncated }, fresh());
  // Every client looks new against a throwaway set, so the flags would mark all
  // of them — noise here, and a claim the report can't back up. Novelty is only
  // meaningful against the SMS's persisted history.
  split.all.workspaces.newClientKinds = [];
  split.all.workspaces.newGeos = [];

  const series: DayPoint[] = [];
  let todaySplit = split;
  for (let i = 0; i < opts.days; i++) {
    const dFrom = new Date(trendStart.getTime() + i * 86_400_000);
    const dTo = new Date(Math.min(dFrom.getTime() + 86_400_000, to.getTime()));
    if (dFrom >= to) break;
    const dg = aggregateSplit(
      events.filter((e) => inRange(e, dFrom, dTo)),
      { from: dFrom, to: dTo, truncated: false },
      fresh(),
    );
    if (i === opts.days - 1) todaySplit = dg;
    series.push({
      date: ptDate(dFrom),
      ...rollupOf(dg),
      // Tool calls with no workspaces means that day predates the instrumentation.
      instrumented: !(dg.all.context.toolCalls > 0 && dg.all.workspaces.total === 0),
    });
  }

  writeFileSync(
    opts.output,
    renderReport({ window: split, today: todaySplit, series, generatedAt: new Date() }),
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          from,
          to,
          events: windowEvents.length,
          digest: split.all,
          anon: split.anon,
          authed: split.authed,
        },
        null,
        2,
      ),
    );
  } else if (!opts.quiet) {
    console.log("— anonymous —");
    console.log(formatDigest(split.anon));
    console.log("\n— signed in —");
    console.log(formatDigest(split.authed));
    // The SMS carries the anonymous side only; print what would actually go out.
    console.log("\n— SMS form —");
    console.log(formatSms(split.anon));
  }
  if (!opts.quiet) console.error(`\nWrote ${opts.output}`);
}

/** Midnight PT for the day containing `at`, as a UTC instant. */
function ptMidnight(at: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(at.getTime() - elapsed);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
