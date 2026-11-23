// The drain for duplicate-card reconciliation work (billing-reconcile-queue.ts):
// runs every customer whose work is due. That covers webhook-triggered runs
// that were busy or failed, and the periodic revisits of customers whose
// earlier reconciliation writes are still pending or watched, so recovery
// never depends on another webhook arriving. Cloud Scheduler calls it every
// five minutes:
//
//   gcloud scheduler jobs create http billing-reconcile \
//     --project=graffiticode-app --location=us-central1 --schedule="*/5 * * * *" \
//     --uri=https://console-<hash>-uc.a.run.app/api/internal/billing-reconcile \
//     --http-method=POST \
//     --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>" \
//     --attempt-deadline=300s
//
// The due query needs a single-field index on stripe_reconcile_work.dueAt
// (Firestore creates single-field indexes by default).
// STRIPE_PM_RECONCILE governs the mode here as in the webhook; with `off`
// it does nothing and leaves the work queued.
import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@graffiticode-app/core/lib/plans-config";
import { getFirestore } from "@graffiticode-app/core/utils/db/index";
import { withInstallation } from "../../../lib/with-installation";
import { firestoreCustomerLock } from "../../../lib/billing-customer-lock";
import { reconcileModeFromEnv } from "../../../lib/billing-payment-methods";
import { firestoreReconcileQueue, processDueWork } from "../../../lib/billing-reconcile-queue";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const secret = process.env.INTERNAL_JOB_SECRET || "";
  if (!secret || req.headers["x-internal-job-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const mode = reconcileModeFromEnv(process.env.STRIPE_PM_RECONCILE);
  if (mode === "off" || !stripe) return res.status(200).json({ mode, ran: 0 });
  try {
    const db = getFirestore();
    const results = await processDueWork(stripe, firestoreCustomerLock(db as any), firestoreReconcileQueue(db as any), mode);
    const again = results.filter((r) => r.outcome.kind === "again");
    if (results.length) {
      console.log(JSON.stringify({ ev: "pm_reconcile_drain", mode, ran: results.length, again: again.length }));
    }
    return res.status(200).json({ mode, ran: results.length, again: again.length });
  } catch (err) {
    console.error("[billing-reconcile] drain failed", err);
    return res.status(500).json({ error: "drain_failed" });
  }
}

export default withInstallation(handler);
