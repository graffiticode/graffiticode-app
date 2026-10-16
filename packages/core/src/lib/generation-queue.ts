// Enqueues async code-generation jobs onto a Cloud Tasks queue that calls the
// /api/generate-job worker. Cloud Tasks holds that HTTP request open while the
// 60-110s generation runs (CPU allocated the whole time, with retries), so the
// MCP-facing startCodeGeneration mutation can return immediately and clients
// poll get_item for completion. See src/pages/api/generate-job.ts.
//
// We call the Cloud Tasks REST API directly (fetch + metadata-server token)
// rather than @google-cloud/tasks: the SDK loads JSON/proto config files at
// runtime that Next.js standalone output-tracing doesn't bundle, which 500s the
// route. REST has no such footprint.

import { getAccessToken } from "./gcp-token.js";
import { coreConfig } from "../config.js";

const PROJECT = () => coreConfig().generationQueue.project;
const LOCATION = () => coreConfig().generationQueue.location;
const QUEUE = () => coreConfig().generationQueue.name;
const SECRET = () => coreConfig().generationQueue.secret;
// Where Cloud Tasks dispatches the worker. This MUST be the service's own
// origin, not the public hostname: console.graffiticode.org is proxied by
// Cloudflare, which cuts an origin connection at ~100s and returns 524 to the
// caller while the origin keeps running. Cloud Tasks reads that 524 as a failed
// attempt and re-dispatches, so every generation slower than ~100s ran up to
// maxAttempts times CONCURRENTLY, each doing a full LLM run, and the attempt
// that eventually answered had its response thrown away by the proxy. Observed
// 2026-08-28: three dispatches per job, a uniform 125s apart. Going direct puts
// the task's own dispatchDeadline and Cloud Run's request timeout back in charge
// of when an attempt is considered failed. Both are 900s since e7b9dd0 — this
// line said 300s until 2026-09-01, which is what led an analysis to conclude
// generations were being killed at a 300s wall that no longer exists.
const WORKER_URL = () => coreConfig().generationQueue.workerUrl;
// Fire the worker directly (un-awaited fetch) instead of via Cloud Tasks. Set
// for local dev, where the dev server stays running and there's no queue.
const LOCAL = () => coreConfig().generationQueue.local;

/**
 * v2 payload: only the job id. Everything else is in generation-jobs/{id},
 * which the worker reads (app tier Phase 3.5). The task is only a wake-up.
 */
export type GenerationJobV2 = { v: 2; generationId: string };

// Posts one worker task. `taskName` (v2: gen-<generationId>-<dispatchCount>)
// lets Cloud Tasks refuse a duplicate of the same dispatch slot.
export async function dispatchGenerationTask(payload: Record<string, unknown>, taskName?: string): Promise<void> {
  if (!SECRET()) {
    throw new Error("INTERNAL_JOB_SECRET is not configured — cannot enqueue generation job");
  }
  const body = JSON.stringify(payload);

  if (LOCAL()) {
    // Local dev: invoke the worker without awaiting completion. The dev server
    // keeps running, so the request finishes in the background.
    void fetch(WORKER_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Job-Secret": SECRET() },
      body,
    }).catch((err) => console.error("[generation-queue] local dispatch failed", err));
    return;
  }

  const token = await getAccessToken();
  const url = `https://cloudtasks.googleapis.com/v2/projects/${PROJECT()}/locations/${LOCATION()}/queues/${QUEUE()}/tasks`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: {
        ...(taskName ? { name: `projects/${PROJECT()}/locations/${LOCATION()}/queues/${QUEUE()}/tasks/${taskName}` } : {}),
        httpRequest: {
          url: WORKER_URL(),
          httpMethod: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Job-Secret": SECRET() },
          body: Buffer.from(body).toString("base64"),
        },
        // Must be >= the worker's own Cloud Run request timeout, or Cloud Tasks
        // gives up and re-dispatches while the first attempt is still generating
        // — the duplicate-generation failure this queue already had once, from the
        // other direction (Cloudflare cutting at 100s). Raised to 900s with the
        // service on 2026-08-31: an L0179 sheet was observed taking 6m22s and
        // producing 39,694 output tokens across continuation chunks, so 300s was
        // killing the worker a minute and a half before the model finished.
        // Cloud Tasks permits up to 30 minutes for HTTP targets.
        dispatchDeadline: "900s",
        // NOTE: retry limits are QUEUE config, not task config — there is no
        // per-task maxAttempts to set here, and Cloud Tasks defaults to 100.
        // The deployed queue is set to 2, which is what keeps a failing job from
        // re-running this whole fan-out (router + planner + up to 4 stages x 5
        // repair attempts) a hundred times. It is not expressed in this repo, so
        // verify it rather than assuming, and re-apply after any queue recreate:
        //   gcloud tasks queues describe generation-jobs --location=us-central1 \
        //     --project=graffiticode-app --format='yaml(retryConfig)'
        //   gcloud tasks queues update generation-jobs --location=us-central1 \
        //     --project=graffiticode-app --max-attempts=2
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Cloud Tasks createTask failed: ${res.status} ${text}`), { status: res.status });
  }
}
