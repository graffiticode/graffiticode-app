// Daily generation-pipeline liveness ping. Invoked by Cloud Scheduler once a day:
//
//   gcloud scheduler jobs create http corpus-ping \
//     --schedule="15 6 * * *" --time-zone="America/Los_Angeles" \
//     --uri="https://console.graffiticode.org/api/internal/corpus-ping" \
//     --http-method=POST \
//     --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>" \
//     --attempt-deadline=1800s
//
// Auth reuses the INTERNAL_JOB_SECRET shared header that /api/internal/funnel-digest and
// /api/generate-job already validate, rather than adding a third scheme for one more job.
//
// WHY IT FITS IN A REQUEST, unlike the weekly corpus sweep. Eleven generations at a
// concurrency of four run in ~3-6 minutes, inside Cloud Scheduler's 30-minute attempt
// deadline. The weekly sweep is 200+ generations (hours) and needs the Cloud Tasks
// fan-out; this deliberately does not.
//
// NOT RETRY-SAFE BY ACCIDENT, so don't add retries. Every attempt spends real generation
// money. A transient failure is the signal, not something to paper over — Cloud Scheduler
// should be configured with no retry, and a red ping followed by a green one tomorrow is
// a perfectly good outcome.
//
// GET with ?dry=1 runs the ping and returns the result WITHOUT sending an SMS or writing
// the run log — the dev loop. `?langs=0175,0176` narrows the set, which is how to
// exercise one language without paying for eleven.
import type { NextApiRequest, NextApiResponse } from "next";
import {
  PING_LANGUAGES,
  formatPingSms,
  recordPingRun,
  runPing,
  shouldSend,
} from "../../../lib/corpus-ping";
import { sendSms } from "../../../lib/alert-sms";

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

  // Explicit subset, for the dev loop and for re-checking one language after a fix.
  // Unknown ids are rejected rather than silently pinged: a typo that returns
  // "no-corpus" looks identical to a real missing corpus.
  const requested = typeof req.query.langs === "string"
    ? String(req.query.langs).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (requested) {
    const unknown = requested.filter((l) => !PING_LANGUAGES.includes(l));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `not in the ping set: ${unknown.join(", ")}`, pingSet: PING_LANGUAGES });
    }
  }

  try {
    const now = new Date();
    const run = await runPing(requested ?? PING_LANGUAGES, now);
    const message = formatPingSms(run);

    if (dry) {
      return res.status(200).json({ dry: true, message, willSend: shouldSend(run, now), ...run });
    }

    // Record before alerting: the run log is what makes a silent day diagnosable, so it
    // must survive a Twilio outage. sendSms never throws (see alert-sms.ts), but an
    // ordering that depended on that would be fragile.
    await recordPingRun(run);

    const sent = shouldSend(run, now) ? await sendSms(message) : { sent: false, reason: "green_and_not_weekly" };

    // 200 even when languages failed: the JOB succeeded — it checked and reported. A
    // non-2xx here would make Cloud Scheduler retry a run that already spent its money
    // and already told us the answer.
    return res.status(200).json({ message, sms: sent, ...run });
  } catch (err: any) {
    console.error("[corpus-ping] run failed:", err?.message || err);
    // The ping itself broke — distinct from a language failing, and worth a 500 so the
    // scheduler's own failure metric catches it.
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
