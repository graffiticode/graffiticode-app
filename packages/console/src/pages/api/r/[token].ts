// Funnel report page, opened from the hourly SMS link.
//
// An API route rather than a page under src/pages/: _app.tsx wraps every route
// except form/editor in AuthWrapper, and this has to open with no sign-in from a
// phone. next.config.mjs rewrites /r/:token here so the SMS URL stays short.
//
// The token is the capability — it carries an HMAC-signed window and expiry (see
// src/lib/report-link.ts). The report is rendered LIVE on each load, not
// snapshotted at send time, so re-opening an hour-old link shows the same window
// with any late-arriving events included.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  aggregateSplit,
  fetchEvents,
  ptDate,
  readDayCache,
  rollupOf,
  writeDayCache,
  type SplitDigest,
  type DayRollup,
} from "../../../lib/funnel-digest";
import { renderInvalid, renderReport, type DayPoint } from "../../../lib/funnel-report-html";
import { verifyReportToken } from "../../../lib/report-link";

/**
 * Aggregate a window into its anonymous / signed-in split, with novelty
 * disabled — the page must not consume ⚑new flags.
 */
async function digestFor(from: Date, to: Date): Promise<SplitDigest> {
  const { events, truncated } = await fetchEvents(from, to);
  // A throwaway `seen` set: passing the persisted one would mark client kinds as
  // announced just because somebody loaded a report, and the next real SMS would
  // silently drop its ⚑new flag.
  return aggregateSplit(
    events,
    { from, to, truncated },
    { clientKinds: new Set(), geos: new Set() },
  );
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
  const hour = get("hour") % 24;
  const elapsedMs = (hour * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(at.getTime() - elapsedMs);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const send = (status: number, html: string) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Never cached or indexed: the URL is a bearer credential.
    res.setHeader("Cache-Control", "private, no-store");
    // nosnippet/noimageindex ask link-preview fetchers not to render a card for
    // this URL. Messaging clients build that card themselves from what they
    // fetch, so this is a request, not a guarantee — but it's the only
    // server-side lever there is.
    res.setHeader("X-Robots-Tag", "noindex, nofollow, nosnippet, noimageindex, noarchive");
    res.status(status).send(html);
  };

  const token = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  const win = token ? verifyReportToken(token) : null;
  if (!win) return send(404, renderInvalid());

  try {
    const now = new Date();
    const todayStart = ptMidnight(now);

    const days: Array<{ date: string; from: Date; to: Date }> = [];
    for (let i = 6; i >= 0; i--) {
      const from = new Date(todayStart.getTime() - i * 86_400_000);
      const to = new Date(Math.min(from.getTime() + 86_400_000, now.getTime()));
      days.push({ date: ptDate(from), from, to });
    }
    const todayKey = days[days.length - 1].date;

    // Completed days come from cache; only today and the SMS window hit Cloud
    // Logging. Querying all seven every time was most of this page's render.
    const cached = await Promise.all(
      days.map((d) => (d.date === todayKey ? null : readDayCache(d.date).catch(() => null))),
    );

    const [windowDigest, todayDigest, ...backfilled] = await Promise.all([
      digestFor(win.from, win.to),
      digestFor(days[days.length - 1].from, days[days.length - 1].to),
      ...days.map((d, i) =>
        d.date === todayKey || cached[i] ? Promise.resolve(null) : digestFor(d.from, d.to),
      ),
    ]);

    const series: DayPoint[] = days.map((d, i) => {
      let roll: DayRollup;
      if (d.date === todayKey) {
        roll = rollupOf(todayDigest);
      } else if (cached[i]) {
        roll = cached[i] as DayRollup;
      } else {
        const dg = backfilled[i];
        roll = dg
          ? rollupOf(dg)
          : {
              toolCalls: 0,
              workspaces: 0,
              items: 0,
              anonToolCalls: 0,
              anonWorkspaces: 0,
              anonItems: 0,
            };
        // Fill the cache for next time. Fire-and-forget: a page must not fail
        // because a cache write did.
        void writeDayCache(d.date, roll).catch(() => {});
      }
      return {
        date: d.date,
        ...roll,
        // A tool call always emits mcp_session_started, so tool calls with zero
        // workspaces means that day predates the instrumentation rather than
        // being a day where nobody was active. Rendering it as "0" reads as a real
        // measurement; the page shows "–" instead. Self-clearing as the window
        // rolls past the deploy.
        instrumented: !(roll.toolCalls > 0 && roll.workspaces === 0),
      };
    });

    return send(
      200,
      renderReport({ window: windowDigest, today: todayDigest, series, generatedAt: now }),
    );
  } catch (err) {
    console.error("[funnel-report] render failed", err);
    return send(500, renderInvalid());
  }
}
