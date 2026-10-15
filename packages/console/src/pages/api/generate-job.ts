// Cloud Tasks worker for async code generation. Enqueued by the
// startCodeGeneration mutation (see src/lib/generation-queue.ts). Runs the same
// generateCode service the synchronous mutation uses, then persists the result
// and flips the item's generationStatus so clients polling get_item see it.
//
// Cloud Tasks holds this request open for the full 60-110s generation (CPU
// allocated throughout) — the console already sustains requests this long via
// the synchronous /api path, so no special runtime config is needed.
import type { NextApiRequest, NextApiResponse } from "next";
import { GENERATION_JOB_VERSION } from "@graffiticode-app/core/lib/generation-queue";
import type { GenerationJob } from "@graffiticode-app/core/lib/generation-queue";
import { runJob } from "@graffiticode-app/core/generation";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const secret = process.env.INTERNAL_JOB_SECRET || "";
  if (!secret || req.headers["x-internal-job-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const job = req.body as GenerationJob;
  const { v, itemId, lang, prompt, authReplay } = job || {};
  if (!itemId || !lang || !prompt || !authReplay) {
    return res.status(400).json({ error: "Missing required job fields" });
  }
  // Tasks enqueued before versioning carry no `v`; treat them as v1 since the
  // required fields above are identical. A version we don't recognize is from a
  // NEWER revision, so fail loudly rather than guessing at its shape — 400 keeps
  // Cloud Tasks from retrying a payload this revision will never understand.
  if (v !== undefined && v !== GENERATION_JOB_VERSION) {
    console.error("[generate-job] unsupported payload version", v, itemId);
    return res.status(400).json({ error: "unsupported_job_version", v });
  }

  const r = await runJob(job);
  return res.status(r.status).json(r.body);
}
