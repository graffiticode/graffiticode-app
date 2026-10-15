// Generation protocol v2's recovery (core/sweeper.ts): redispatches due jobs,
// fails expired or exhausted ones, and carries out due outbox effects. Cloud
// Scheduler calls it every minute:
//
//   gcloud scheduler jobs create http sweep-generations \
//     --project=graffiticode-app --location=us-central1 --schedule="* * * * *" \
//     --uri=https://console-<hash>-uc.a.run.app/api/internal/sweep-generations \
//     --http-method=POST \
//     --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>" \
//     --attempt-deadline=60s
//
// The service's own origin, not console.graffiticode.org, for the reason the
// generation queue gives (generation-queue.ts: Cloudflare cuts long requests).
// Idle until v2 jobs exist: both queries come back empty.
import type { NextApiRequest, NextApiResponse } from "next";
import { sweep } from "@graffiticode-app/core/sweeper";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const secret = process.env.INTERNAL_JOB_SECRET || "";
  if (!secret || req.headers["x-internal-job-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await sweep();
    if (Object.keys(result.jobs).length || Object.keys(result.effects).length) {
      console.log(JSON.stringify({ ev: "generation_sweep", ...result }));
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error("[sweep-generations] failed", err);
    return res.status(500).json({ error: "sweep_failed" });
  }
}
