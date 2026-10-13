// Weekly corpus health sweep. Invoked by Cloud Scheduler once a week:
//
//   gcloud scheduler jobs create http corpus-sweep \
//     --schedule="30 6 * * 1" --time-zone="America/Los_Angeles" \
//     --uri="https://console.graffiticode.org/api/internal/corpus-sweep" \
//     --http-method=POST \
//     --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>" \
//     --attempt-deadline=1800s --max-retry-attempts=0
//
// Samples 10 prompts per language by rotation (~110 generations, ~8 min at concurrency 4) and
// compares each against the corpus entry it came from. Fits a request, so no Cloud Tasks.
//
// THE ALARM IS THE PRODUCT HERE. Full sweeps are manual by design, so this SMS is the only thing
// between a regression and nobody noticing — it always sends when anything is off, names every
// affected language, and carries the exact `npm run corpus-sweep` command to escalate. It is
// deliberately sensitive: at one sample per prompt a machine cannot separate a real change from
// sampling noise, so it reports and a person judges.
//
// No retry, for the same reason as the ping: every attempt spends generation money, and a
// transient failure is a signal rather than something to paper over.
//
// GET with ?dry=1 runs it without sending or recording; ?langs= narrows the set.
import type { NextApiRequest, NextApiResponse } from "next";
import {
  SWEEP_LANGUAGES,
  formatSweepSms,
  recordSweepRun,
  runSweep,
  sweepRunId,
} from "../../../lib/corpus-sweep";
import { sendSms } from "../../../lib/alert-sms";
import { sweepReportUrl } from "../../../lib/report-link";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const dry = req.query.dry === "1";

  if (!dry) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const secret = process.env.INTERNAL_JOB_SECRET || "";
    if (!secret || req.headers["x-internal-job-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const requested = typeof req.query.langs === "string"
    ? String(req.query.langs).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (requested) {
    const unknown = requested.filter((l) => !SWEEP_LANGUAGES.includes(l));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `not in the sweep set: ${unknown.join(", ")}`, sweepSet: SWEEP_LANGUAGES });
    }
  }

  try {
    const now = new Date();
    const run = await runSweep({ langs: requested ?? SWEEP_LANGUAGES, mode: "sample", now });
    const url = sweepReportUrl(sweepRunId(run), now);
    const message = formatSweepSms(run, url);

    if (dry) return res.status(200).json({ dry: true, message, url, ...run });

    // Record before alerting: the run log is what makes a silent week diagnosable, so it must
    // survive a Twilio outage.
    await recordSweepRun(run);

    // Always send. A weekly all-clear is one text a week, and it is what stops a dead scheduler
    // from being indistinguishable from a healthy corpus.
    const sent = await sendSms(message);

    // 200 even when languages failed: the JOB succeeded — it swept and reported. A non-2xx would
    // make the scheduler retry a run that already spent its money and already has the answer.
    return res.status(200).json({ message, url, sms: sent, ...run });
  } catch (err: any) {
    console.error("[corpus-sweep] run failed:", err?.message || err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
