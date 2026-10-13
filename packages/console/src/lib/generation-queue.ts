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

import { getAccessToken } from "./gcp-token";

const PROJECT =
  process.env.GENERATION_QUEUE_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "graffiticode-app";
const LOCATION = process.env.GENERATION_QUEUE_LOCATION || "us-central1";
const QUEUE = process.env.GENERATION_QUEUE_NAME || "generation-jobs";
const SECRET = process.env.INTERNAL_JOB_SECRET || "";
const CONSOLE_URL = process.env.CONSOLE_URL || "https://console.graffiticode.org";
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
//
// The MCP server's own worker-died guard (GENERATION_STALE_MS in
// graffiticode-mcp-server/src/tools.ts) MUST stay above this 900s ceiling, or it
// reports a still-running generation to the agent as failed. Move the two together.
const WORKER_URL = process.env.GENERATION_JOB_URL || `${CONSOLE_URL}/api/generate-job`;
// Fire the worker directly (un-awaited fetch) instead of via Cloud Tasks. Set
// for local dev, where the dev server stays running and there's no queue.
const LOCAL = process.env.GENERATION_QUEUE_LOCAL === "1";

// Worker auth: how the worker re-derives credentials to act as the caller.
// Free-plan re-derives fresh creds (idTokens are short-lived, dispatch can lag),
// so we carry the session rather than a baked idToken.
export type AuthReplay =
  | { kind: "bearer"; token: string }
  | { kind: "freePlan"; sessionNamespace?: string; sessionUuid?: string };

/**
 * Payload schema version. A task already in the Cloud Tasks queue was serialized
 * by whatever revision enqueued it, so a rename or removal here is a silent field
 * loss for anything in flight. Bump this when the shape changes and have the
 * worker branch on it rather than trusting field presence.
 *
 * v1: itemId/lang/prompt/modification/currentSrc/authReplay (+ optional client,
 * currentData — see those fields). NOTE there are no
 * model-selection fields: the family and tier come from the language's static
 * priority list at generation time, so nothing about model choice travels in the
 * payload and an in-flight task can never pin an unreviewed model.
 */
export const GENERATION_JOB_VERSION = 1;

export interface GenerationJob {
  v?: number;
  itemId: string;
  lang: string;
  prompt: string;
  modification: string;
  currentSrc?: string | null;
  /**
   * What `currentSrc` COMPILES TO, when the caller has it — serialized JSON.
   *
   * Optional, and deliberately NOT a version bump, for the same reason `client`
   * is not: adding a field is backward compatible, while bumping 400s every job
   * already queued. A job that predates this simply generates without the data
   * model, exactly as every job did before.
   *
   * Why a caller sends it: some dialects keep the values an edit acts on outside
   * the program. L0182 names a survey whose ideas the compiler fetches, so an
   * agent asking to record three of them by name had nothing anchoring those
   * strings — measured 2026-09-11 across 12 answers, 7 failed to compile against
   * invented or mis-slotted text and 3 more silently recorded a short answer.
   */
  currentData?: string | null;
  authReplay: AuthReplay;
  /**
   * Source surface ("console" | "mcp" | "front"), carried solely so a terminal
   * failure can be attributed to it — the funnel report is MCP-only and drops
   * anything it can't qualify (see isMcpOrigin in funnel-digest.ts).
   *
   * Optional, and deliberately NOT a GENERATION_JOB_VERSION bump: adding a field
   * is backward compatible, whereas bumping would 400 every job already in the
   * queue at deploy time. A v1 job that predates this lands as "console", which
   * under-counts MCP failures for one deploy's worth of in-flight work rather
   * than inventing any.
   */
  client?: string;
}

export async function enqueueGenerationJob(job: GenerationJob): Promise<void> {
  if (!SECRET) {
    throw new Error("INTERNAL_JOB_SECRET is not configured — cannot enqueue generation job");
  }
  const body = JSON.stringify({ v: GENERATION_JOB_VERSION, ...job });

  if (LOCAL) {
    // Local dev: invoke the worker without awaiting completion. The dev server
    // keeps running, so the request finishes in the background.
    void fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Job-Secret": SECRET },
      body,
    }).catch((err) => console.error("[generation-queue] local dispatch failed", err));
    return;
  }

  const token = await getAccessToken();
  const url = `https://cloudtasks.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/queues/${QUEUE}/tasks`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: {
        httpRequest: {
          url: WORKER_URL,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Job-Secret": SECRET },
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
    throw new Error(`Cloud Tasks createTask failed: ${res.status} ${text}`);
  }
}
