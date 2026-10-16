// Cloud Tasks worker for async code generation (generation protocol v2): the
// task carries only {v: 2, generationId}; the job itself — request, principal,
// deadline, act-as grant — is in Firestore, and runJobV2 claims, runs and
// commits it (core/generation-jobs.ts).
//
// Protocol v1 tasks (the whole request in the payload) were retired on
// 2026-10-17, after the queue had drained. One arriving now is acknowledged
// with 200 and dropped: nothing in it can be acted on safely, and a non-2xx
// would only make Cloud Tasks retry it.
import type { NextApiRequest, NextApiResponse } from "next";
import { runJobV2 } from "@graffiticode-app/core/generation-jobs";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const secret = process.env.INTERNAL_JOB_SECRET || "";
  if (!secret || req.headers["x-internal-job-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.body?.v !== 2) {
    console.warn("[generate-job] retired v1 task dropped", req.body?.itemId ?? null);
    return res.status(200).json({ status: "refused", reason: "protocol_v1_retired" });
  }
  const generationId = req.body.generationId;
  if (typeof generationId !== "string" || !generationId) {
    return res.status(400).json({ error: "Missing generationId" });
  }
  const r = await runJobV2(generationId);
  return res.status(r.status).json(r.body);
}
