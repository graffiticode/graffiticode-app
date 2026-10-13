// Hourly funnel digest job. Invoked by Cloud Scheduler at :02 past each hour
// from 8am to 8pm PT:
//
//   gcloud scheduler jobs create http funnel-digest \
//     --schedule="2 8-20 * * *" --time-zone="America/Los_Angeles" \
//     --uri="https://console.graffiticode.org/api/internal/funnel-digest" \
//     --http-method=POST \
//     --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>"
//
// Auth reuses the INTERNAL_JOB_SECRET shared header that /api/generate-job
// already validates, rather than adding a second scheme for one more job.
//
// Every firing sends one SMS, quiet hour or not, and the text reports the
// ANONYMOUS segment only — see the send-policy note in src/lib/funnel-digest.ts.
//
// The text itself is a WRITTEN READ of the window (src/lib/funnel-narrator.ts),
// not a counter dump: the counters are all still computed and still rendered by
// /r/<token>, but the thing that buzzes your phone says what happened. If the
// narration is unavailable for any reason the deterministic formatSms() text
// goes out instead, so the "every firing sends" guarantee is unconditional —
// silence still means the job is broken and nothing else.
//
// GET with ?dry=1 renders a window without sending or advancing the cursor —
// the dev loop for the narrator, and it returns the brief the model was given
// alongside both candidate messages. Accepts &from=<iso>&to=<iso> to replay any
// historical window, and &narrate=0 to skip the API call entirely.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  aggregateSplit,
  fetchEvents,
  formatDigest,
  formatSms,
  readSeen,
  readState,
  recentOf,
  resolveWindow,
  writeSeen,
  writeState,
} from "../../../lib/funnel-digest";
import { formatNarratedSms, narrate, pushRecent } from "../../../lib/funnel-narrator";
import { sendSms } from "../../../lib/alert-sms";
import { reportUrl } from "../../../lib/report-link";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const dry = req.query.dry === "1";

  if (!dry) {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const secret = process.env.INTERNAL_JOB_SECRET || "";
    if (!secret || req.headers["x-internal-job-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const now = new Date();
    const state = await readState();
    const replay =
      dry && typeof req.query.from === "string" && typeof req.query.to === "string";
    const window = replay
      ? { from: new Date(String(req.query.from)), to: new Date(String(req.query.to)) }
      : resolveWindow(state, now);

    const { events, truncated } = await fetchEvents(window.from, window.to);
    const seen = await readSeen();
    const split = aggregateSplit(events, { ...window, truncated }, seen);
    const url = reportUrl(window.from, window.to, now);

    // The text reports strangers only; the linked page carries both sides.
    const fallback = formatSms(split.anon, url);
    const narration =
      req.query.narrate === "0" ? null : await narrate(split, { recent: state.recent });
    const message = narration
      ? formatNarratedSms(narration.text, split.anon, url)
      : fallback;

    if (dry) {
      return res.status(200).json({
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        events: events.length,
        message,
        narrated: !!narration,
        // What the model was actually shown, so a bad read can be diagnosed as
        // a bad brief rather than guessed at.
        brief: narration?.brief,
        smsFallback: fallback,
        url,
        // The long form is no longer sent, but it stays the readable summary for
        // eyeballing a window from the terminal — both sides, since the SMS now
        // shows only one of them.
        detail: formatDigest(split.anon),
        detailAuthed: formatDigest(split.authed),
        digest: { ...split.anon, from: undefined, to: undefined },
        digestAuthed: { ...split.authed, from: undefined, to: undefined },
      });
    }

    // Every run sends — see the send-policy note in funnel-digest.ts.
    const result = await sendSms(message);

    // Advance the cursor whether or not the SMS went out — the window WAS
    // reported on, and replaying it would double-count. A send failure is
    // visible in the logs.
    //
    // `recent` advances on the same terms and for the same reason: it is the
    // record of which windows were reported, so the next narration compares
    // against every window since it last spoke, not since it last succeeded.
    await writeState({
      cursor: window.to.toISOString(),
      recent: pushRecent(state.recent, recentOf(split.anon)),
      ...(result.sent ? { lastSentAt: now.toISOString() } : {}),
    });
    // Novelty is one-way: once a client kind or country has been announced it
    // must never be announced again, even if this run's SMS failed.
    await writeSeen(seen);

    console.log(
      JSON.stringify({
        ev: "funnel_digest",
        t: now.toISOString(),
        events: events.length,
        sent: result.sent,
        reason: result.reason,
        narrated: !!narration,
        truncated,
      }),
    );

    return res.status(200).json({ ok: true, events: events.length, narrated: !!narration, ...result });
  } catch (err: any) {
    console.error("[funnel-digest] failed", err);
    // 500 lets Cloud Scheduler retry. The cursor is untouched on this path, so a
    // retry covers the same window rather than skipping it.
    return res.status(500).json({ error: "digest_failed", details: String(err?.message ?? err) });
  }
}
