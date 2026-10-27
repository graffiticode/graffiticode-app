// Render -> outcome correlation check (P1 #2, part C; lib/render-outcomes.ts).
// Invoked by Cloud Scheduler every 15 minutes:
//
//   gcloud scheduler jobs create http render-outcomes \
//     --schedule="*/15 * * * *" --time-zone="UTC" \
//     --uri="https://console.graffiticode.org/api/internal/render-outcomes" \
//     --http-method=POST \
//     --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>" \
//     --attempt-deadline=120s
//
// Auth reuses the INTERNAL_JOB_SECRET header, like corpus-ping and funnel-digest.
//
// Every run logs one line, `{"ev":"render_outcome_check", …}`, whatever it finds:
// Cloud Monitoring alerts by email on `alert: true` and on the line going
// missing (the check stopped). An alert also goes out by SMS from here.
//
// ?dry=1 (with the secret) runs the check and returns the result WITHOUT
// logging the line or sending an SMS; `&at=<ISO time>` checks the window
// ending 15 minutes before that time instead of now.
import type { NextApiRequest, NextApiResponse } from "next";
import { formatAlert, runCheck } from "../../../lib/render-outcomes";
import { sendSms } from "@graffiticode-app/core/lib/alert-sms";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const dry = req.query.dry === "1";

  if (!dry && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // The secret even for a dry run: each run queries Cloud Logging, and the
  // result lists render ids.
  const secret = process.env.INTERNAL_JOB_SECRET || "";
  if (!secret || req.headers["x-internal-job-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // A dry run may look at a past window (?at=<ISO time>), to check the join
    // against renders whose outcome is known.
    const at = dry && typeof req.query.at === "string" ? new Date(req.query.at) : null;
    const now = at && !Number.isNaN(at.getTime()) ? at : new Date();
    const result = await runCheck(now);
    const { unconfirmedRenders, ...counts } = result;
    const summary = { ...counts, unconfirmedRids: unconfirmedRenders.map((r) => r.rid) };

    if (dry) {
      return res.status(200).json({ dry: true, ...summary, message: result.alert ? formatAlert(result, new Date(result.from), new Date(result.to)) : null });
    }

    // The line first: it is what the email and missing-run alerts read, so it
    // must not depend on Twilio. sendSms never throws (alert-sms.ts).
    console.log(JSON.stringify({ ev: "render_outcome_check", ...summary }));
    const sms = result.alert ? await sendSms(formatAlert(result, new Date(result.from), new Date(result.to))) : { sent: false, reason: "no_alert" };
    return res.status(200).json({ ...summary, sms });
  } catch (err: any) {
    // A failed check is not a passed one: no line is logged, so the missing-run
    // alert notices if this keeps happening.
    console.error(`[render-outcomes] check failed: ${err?.message || String(err)}`);
    return res.status(500).json({ error: "check failed" });
  }
}
