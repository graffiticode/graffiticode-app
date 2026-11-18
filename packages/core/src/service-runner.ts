// Service-job runner for generation steps (execution observation plan, W6 and
// W7; A2A design §6; installations plan, P4). Every step is a write-free
// generation until execution is ready, so a job's external outcome is always
// `not_requested`. A job runs under its pinned definition (service-jobs.ts).
//
// A withdrawn capability (capabilities.ts, the operator's switch) starts no
// new step: a job whose step hasn't reserved its generation ends failed
// (capability-withdrawn). A step already reserved still settles.
//
// Starting a step reserves one generation under the step's persisted backend
// key, through generation's own idempotency claim (idempotency.ts), and then
// records the reservation on the step. A retry of the same step reads the
// recorded generation back and never reserves another. The claim lasts 24
// hours; the step's record lasts as long as the job, so the claim only covers
// the window between reserving and recording.
//
// Observing a job reads the generations it refers to and records the state
// their settled evidence implies. It never starts, retries or advances a
// generation (plan rule 7): it only writes down what has already happened.
import { createHash } from "crypto";
import { withdrawnCapabilities } from "./capabilities.js";
import { CLAIM_TAKEOVER_MS, claimIdempotencyKey, completeIdempotencyKey, IDEMPOTENCY_TTL_MS, idempotencyRef, releaseIdempotencyKey, type IdempotencyClaim } from "./idempotency.js";
import { db } from "./db.js";
import { jobRef, type GenerationJobDoc, type JobPrincipal } from "./generation-jobs.js";
import { ConflictError, NotFoundError } from "./errors.js";
import type { Principal } from "./auth.js";
import { deriveJobState, isTerminalJobState } from "./service-job-state.js";
import { validateCompletion } from "./service-completion.js";
import {
  applyTransition, bindStepGeneration, readServiceJob, recordStep, serviceJobRef, transitionServiceJob,
  type GenerationRef, type ServiceJobDoc, type TransitionChange,
} from "./service-jobs.js";

// The idempotency scope for step keys. Step keys embed the job id, so they
// can't collide with a caller's REST keys or another job's.
const STEP_KEY_SCOPE = "service-job-step";

// The account boundary a job belongs to, and the principal that may read it.
export function jobPrincipalOf(auth: Principal): { principal: JobPrincipal; scope: string } {
  return auth.freePlan
    ? { principal: { kind: "freePlan", sessionNamespace: auth.sessionNamespace ?? null, sessionUuid: auth.sessionUuid ?? null }, scope: `ws:${auth.sessionNamespace}` }
    : { principal: { kind: "user", uid: auth.uid }, scope: `uid:${auth.uid}` };
}

// A stable digest of a request's inputs: the same key with a different digest
// is a conflict, never a replay.
export function digestInput(input: unknown): string {
  const canon = (v: any): any =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canon(v[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canon(input))).digest("hex");
}

const ignoreEnded = (err: any) => {
  if (err?.reason === "job_terminal" || err?.reason === "job_revision_stale") return;
  throw err;
};

// A step's reservation, as its claim records it. The claim is the durable
// record: a claim that reserved a generation stays bound to it, keyed by the
// step's persisted backend key, for as long as the job can run. A claim taken
// moments ago may still reserve (a request in progress); one older than the
// takeover window, or revoked, reserved nothing.
export type Recovery = { kind: "reserved"; generation: GenerationRef } | { kind: "in_progress" } | { kind: "none" };

const stepClaimRef = (backendKey: string) => idempotencyRef(STEP_KEY_SCOPE, backendKey);

function claimEvidence(jobId: string, stepId: string, d: any, now: number): Recovery {
  if (!d || d.fingerprint !== `${jobId}:${stepId}` || d.state === "revoked") return { kind: "none" };
  const op = (d.state === "bound" ? d.op : d.state === "completed" ? d.response?.body : null) as GenerationRef | null;
  if (op?.generationId && op.itemId) return { kind: "reserved", generation: { itemId: op.itemId, generationId: op.generationId } };
  if (d.state === "claimed" && now - Number(d.claimedAt) < CLAIM_TAKEOVER_MS) return { kind: "in_progress" };
  return { kind: "none" };
}

// Attaches a recovered reservation to its step. Completing the claim is
// best-effort: a bound claim already records the generation.
async function attach(jobId: string, stepId: string, backendKey: string, generation: GenerationRef, now: number) {
  const d = (await stepClaimRef(backendKey).get()).data();
  if (d?.state === "bound") {
    await completeIdempotencyKey({ ref: stepClaimRef(backendKey), claimToken: d.claimToken }, { status: 200, headers: {}, body: generation }).catch(() => {});
  }
  await bindStepGeneration(jobId, stepId, generation, { now });
  await transitionServiceJob(jobId, j => (j.status.state === "accepted" ? { status: { state: "working" } } : null), { now }).catch(ignoreEnded);
}

// A step's reservation, recovered and attached; or that it is still in
// progress; or that there is none. Throws when it can't tell (a read or write
// failed): the caller must then leave the job as it is, never end it.
export async function recoverStepGeneration(jobId: string, stepId: string, { now = Date.now() }: { now?: number } = {}): Promise<Recovery> {
  const job = await readServiceJob(jobId);
  const step = job?.steps?.[stepId];
  if (!job || !step) return { kind: "none" };
  if (step.generation) return { kind: "reserved", generation: step.generation };
  const r = claimEvidence(jobId, stepId, (await stepClaimRef(step.backendKey).get()).data(), now);
  if (r.kind === "reserved") await attach(jobId, stepId, step.backendKey, r.generation, now);
  return r;
}

export type EndResult = { kind: "ended"; job: ServiceJobDoc } | { kind: "reserved"; generation: GenerationRef } | { kind: "in_progress" };

// Ends a job that holds no reservation (a refusal, a withdrawal), in one
// transaction with revoking its steps' authority to reserve: each step's claim
// becomes a tombstone, so a request still holding an abandoned claim can't
// reserve afterwards (generation binds only a live claim with its own token).
// A step whose claim shows a reservation is recovered instead, and one whose
// claim is fresh is in progress: neither job is ended. Throws if it can't
// commit, leaving the job as it was.
export async function endUnreserved(jobId: string, change: TransitionChange, { now = Date.now() }: { now?: number } = {}): Promise<EndResult> {
  const result = await db().runTransaction(async (tx): Promise<EndResult | { kind: "attach"; stepId: string; backendKey: string; generation: GenerationRef }> => {
    const job = (await tx.get(serviceJobRef(jobId))).data() as ServiceJobDoc | undefined;
    if (!job) throw new NotFoundError("Job not found.");
    if (isTerminalJobState(job.status.state)) return { kind: "ended", job };
    const steps = Object.values(job.steps ?? {});
    const attached = steps.find(s => s.generation);
    if (attached) return { kind: "reserved", generation: attached.generation! };
    const claims = await Promise.all(steps.map(s => tx.get(stepClaimRef(s.backendKey))));
    for (let i = 0; i < steps.length; i++) {
      const r = claimEvidence(jobId, steps[i].stepId, claims[i].data(), now);
      if (r.kind === "reserved") return { kind: "attach", stepId: steps[i].stepId, backendKey: steps[i].backendKey, generation: r.generation };
      if (r.kind === "in_progress") return r;
    }
    const keepUntil = new Date(Math.max(now, job.envelope.deadlineAt) + job.envelope.retryWindowMs + IDEMPOTENCY_TTL_MS);
    steps.forEach(s => tx.set(stepClaimRef(s.backendKey), { fingerprint: `${jobId}:${s.stepId}`, state: "revoked", revokedAt: now, expiresAt: keepUntil }));
    return { kind: "ended", job: applyTransition(tx, job, change, now) };
  });
  if (result.kind === "attach") {
    await attach(jobId, result.stepId, result.backendKey, result.generation, now);
    return { kind: "reserved", generation: result.generation };
  }
  return result;
}

const recoveryUnavailable = (err: unknown) =>
  new ConflictError("recovery_unavailable", `This job's step couldn't be checked for a reservation; retry shortly. (${(err as Error)?.message ?? err})`);

// Starts (or resumes) a generation step. `start` reserves the generation with
// the claim it is given (core startGeneration's `idempotency` argument).
export async function startGenerationStep(
  jobId: string,
  stepId: string,
  start: (claim: IdempotencyClaim) => Promise<unknown>,
  // `recover`: a test seam (a recovery that fails, as a storage outage would).
  { now = Date.now(), recover = recoverStepGeneration }: { now?: number; recover?: typeof recoverStepGeneration } = {},
  withdrawn: ReadonlySet<string> = withdrawnCapabilities(),
): Promise<GenerationRef> {
  const step = await recordStep(jobId, { stepId, kind: "generation", owned: true }, { now });
  if (step.generation) return step.generation;
  // Reserved before, by a request that failed after reserving: recover it.
  const before = await recover(jobId, stepId, { now }).catch(err => { throw recoveryUnavailable(err); });
  if (before.kind === "reserved") return before.generation;
  if (before.kind === "in_progress") throw new ConflictError("step_in_flight", "This job's step is being started by another request. Retry shortly.");
  try {
    return await reserveStep(jobId, stepId, step, start, withdrawn, now);
  } catch (err) {
    // A failure after the reservation committed leaves it bound to the step's
    // claim: recover it rather than report a failure for work that exists.
    let after: Recovery;
    try {
      after = await recover(jobId, stepId, { now });
    } catch (e) {
      throw recoveryUnavailable(e);
    }
    if (after.kind === "reserved") return after.generation;
    if (after.kind === "in_progress") throw new ConflictError("step_in_flight", "This job's step is being started by another request. Retry shortly.");
    throw err;
  }
}

async function reserveStep(
  jobId: string,
  stepId: string,
  step: { backendKey: string },
  start: (claim: IdempotencyClaim) => Promise<unknown>,
  withdrawn: ReadonlySet<string>,
  now: number,
): Promise<GenerationRef> {
  const job = await readServiceJob(jobId);
  if (!job || isTerminalJobState(job.status.state)) throw new ConflictError("job_terminal", "This job has ended; follow-up work is a new job.");
  const capabilityId = job.envelope.definition.capability.id;
  if (withdrawn.has(capabilityId)) {
    const ended = await failWithdrawn(jobId, capabilityId, now);
    if (ended.kind === "reserved") return ended.generation;
    if (ended.kind === "in_progress") throw new ConflictError("step_in_flight", "This job's step is being started by another request. Retry shortly.");
    throw new ConflictError("capability_withdrawn", `This job's capability (${capabilityId}) has been withdrawn; it starts no new work.`);
  }

  // The claim is the reservation's recovery record until the step records it:
  // it lasts as long as the job can (its deadline and retry window), never
  // less than generation's own claims.
  const ttlMs = Math.max(IDEMPOTENCY_TTL_MS, job.envelope.deadlineAt + job.envelope.retryWindowMs - now);
  const claimed = await claimIdempotencyKey({ scope: STEP_KEY_SCOPE, key: step.backendKey, fingerprint: `${jobId}:${stepId}`, now, ttlMs });
  let generation: GenerationRef;
  switch (claimed.kind) {
    case "replay":
      generation = claimed.response.body as GenerationRef;
      break;
    case "bound":
      generation = claimed.op;
      await completeIdempotencyKey(claimed.claim, { status: 200, headers: {}, body: generation });
      break;
    case "in_flight":
      throw new ConflictError("step_in_flight", "This job's step is being started by another request. Retry shortly.");
    case "mismatch":
      throw new ConflictError("step_key_mismatch", "This step's key is bound to a different request.");
    case "revoked":
      throw new ConflictError("job_terminal", "This job ended without starting its step; follow-up work is a new job.");
    case "claimed": {
      try {
        await start(claimed);
      } catch (err) {
        await releaseIdempotencyKey(claimed).catch(() => {});
        throw err;
      }
      const bound = (await claimed.ref.get()).data();
      if (bound?.state !== "bound" || !bound.op) {
        throw new ConflictError("step_not_reserved", "The generation for this step was not reserved.");
      }
      generation = bound.op;
      await completeIdempotencyKey(claimed, { status: 200, headers: {}, body: generation });
    }
  }
  await bindStepGeneration(jobId, stepId, { itemId: generation.itemId, generationId: generation.generationId }, { now });
  await transitionServiceJob(jobId, j => (j.status.state === "accepted" ? { status: { state: "working" } } : null), { now }).catch(ignoreEnded);
  return generation;
}

// A withdrawn capability: the job ends failed, if it holds no reservation.
function failWithdrawn(jobId: string, capabilityId: string, now: number) {
  return endUnreserved(jobId, {
    status: { state: "failed", externalOutcome: "not_requested", verdict: { met: false, findings: [`capability-withdrawn: ${capabilityId}`] } },
    events: [{ type: "capability_withdrawn", data: { capability: capabilityId } }],
  }, { now });
}

// The request was refused before anything was reserved: a quota, access or
// validation refusal. The job ends rejected with the refusal's own reason,
// unless a reservation turns up (recovered instead) or a request is still
// reserving (left as it is). Throws if it can't tell; the job stays open.
export function rejectServiceJob(jobId: string, refusal: { reason: string; message: string }, { now = Date.now() } = {}): Promise<EndResult> {
  return endUnreserved(jobId, {
    status: { state: "rejected", externalOutcome: "not_requested" },
    events: [{ type: "refused", data: refusal }],
  }, { now });
}

export type GenerationEvidence = {
  state: string;
  taskId?: string;
  failure?: { code: string; retryable: boolean; message: string };
};

export async function readGenerationEvidence(generationId: string): Promise<GenerationEvidence | null> {
  const d = (await jobRef(generationId).get()).data() as (GenerationJobDoc & { dispatch: { result?: { taskId?: string } } }) | undefined;
  if (!d) return null;
  return { state: d.dispatch.state, taskId: d.dispatch.result?.taskId, failure: d.dispatch.failure };
}

export type ObservedJob = {
  job: ServiceJobDoc;
  // The deliverable as far as it exists: the item, and its revision once generated.
  itemId: string | null;
  taskId: string | null;
};

const settled = (e: GenerationEvidence | null) => e?.state === "completed" || e?.state === "failed";

// Reads the job's generations and records what their settled evidence implies.
export async function observeServiceJob(
  jobId: string,
  { now = Date.now(), readGeneration = readGenerationEvidence, withdrawn = withdrawnCapabilities() }: { now?: number; readGeneration?: typeof readGenerationEvidence; withdrawn?: ReadonlySet<string> } = {},
): Promise<ObservedJob | null> {
  let job = await readServiceJob(jobId);
  if (!job) return null;
  const steps = Object.values(job.steps ?? {}).filter(s => s.kind === "generation").sort((a, b) => a.createdAt - b.createdAt);
  // Withdrawn, with no step in flight: nothing will ever settle, so it ends.
  // A step that reserved its generation but didn't record it is in flight:
  // recover it first.
  const capabilityId = job.envelope.definition?.capability.id;
  if (!isTerminalJobState(job.status.state) && capabilityId && withdrawn.has(capabilityId) && !steps.some(s => s.generation)) {
    const ended = await failWithdrawn(jobId, capabilityId, now);
    if (ended.kind === "ended") return { job: ended.job, itemId: null, taskId: null };
    // A request is still reserving: leave the job as it is.
    if (ended.kind === "in_progress") return { job, itemId: null, taskId: null };
    // A reservation turned up and is now attached: observe it like any other.
    return observeServiceJob(jobId, { now, readGeneration, withdrawn });
  }
  const evidence = await Promise.all(steps.map(s => (s.generation ? readGeneration(s.generation.generationId) : Promise.resolve(null))));
  const last = steps.length ? steps.length - 1 : -1;
  const itemId = last >= 0 ? steps[last].generation?.itemId ?? null : null;
  const taskId = last >= 0 ? evidence[last]?.taskId ?? null : null;
  if (isTerminalJobState(job.status.state)) return { job, itemId, taskId };

  const allSettled = steps.length > 0 && evidence.every(settled);
  let verdict: { met: boolean; findings: string[] } | undefined;
  if (allSettled) {
    const failed = evidence.filter(e => e!.state === "failed");
    verdict = failed.length
      ? { met: false, findings: failed.map(e => `generation failed: ${e!.failure?.code ?? "unknown"}${e!.failure?.message ? ` (${e!.failure.message})` : ""}`) }
      : validateCompletion({
        deliverableKind: job.envelope.deliverable.kind,
        requestedState: job.envelope.deliverable.requestedState,
        taskId: taskId ?? undefined,
        itemId: itemId ?? undefined,
        checks: [],
        // Planning languages produce recipes; they have no provider operation to perform.
        statesNoLiveOperation: job.envelope.deliverable.kind === "data_plan" ? true : undefined,
        externalOutcome: "not_requested",
      });
  }
  const derived = deriveJobState({
    phase: steps.length ? "preparing" : "accepted",
    executions: [],
    effects: [],
    effectsRequested: false,
    verdict,
    deadlinePassed: now > job.envelope.deadlineAt,
    cancelRequested: job.status.cancelRequested,
  });
  if (derived.state === job.status.state) return { job, itemId, taskId };

  const terminal = isTerminalJobState(derived.state);
  const change: TransitionChange = {
    status: { state: derived.state, externalOutcome: derived.externalOutcome, ...(terminal && verdict ? { verdict } : {}) },
    events: terminal && allSettled ? [{ type: "settled", data: { itemId, taskId } }] : [],
  };
  // Ending a job (canceled, past its deadline) while a step hasn't recorded
  // its generation goes through the fence: the step's claim is checked and
  // revoked in the same commit, so no request still holding it can reserve
  // after the job ends (endUnreserved).
  if (terminal && steps.some(s => !s.generation)) {
    const ended = await endUnreserved(jobId, change, { now });
    if (ended.kind === "ended") return { job: ended.job, itemId, taskId };
    // A request is still reserving: the job ends once that settles.
    if (ended.kind === "in_progress") return { job, itemId, taskId };
    // A reservation turned up and is now attached: observe the job under it.
    return observeServiceJob(jobId, { now, readGeneration, withdrawn });
  }
  const updated = await transitionServiceJob(jobId, () => change, { expectedRevision: job.status.revision, now })
    .catch(async err => { ignoreEnded(err); return (await readServiceJob(jobId))!; });
  return { job: updated, itemId, taskId };
}
