// Service jobs (A2A design §6; execution observation plan, W6 and D-1).
//
// A service job tracks responsibility for a requested outcome. A2A tasks and
// MCP job handles are its protocol representations. The job coordinates
// generation and backend executions; it stores references to them and never
// mirrors their state.
//
// service-jobs/{jobId}
//   envelope   fixed when the job is created
//   status     state, revision, last event sequence, outcome, cancel request
//   steps      stepId -> { backendKey, kind, owned, ref }; a step's key is
//              derived once and persisted, never derived again
// service-jobs/{jobId}/events/{seq}
//   a monotonic per-job sequence, committed with the transition that made it
// service-job-keys/{sha256(scope:key)}
//   the client's idempotency key, bound to its job in the job's own creating
//   transaction. It never expires while the job is live; once the job ends it
//   is kept for the service's retry window (plan D-1). Generation's 24-hour
//   claims (idempotency.ts) are not reused: a long job must not be duplicated
//   by a retry on day two.
import { createHash, randomUUID } from "crypto";
import type admin from "firebase-admin";
import { db } from "./db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import type { JobPrincipal } from "./generation-jobs.js";
import type { ExecutionRef, ExternalOutcome } from "./service-outcomes.js";
import { isTerminalJobState, type CompletionVerdict, type JobState } from "./service-job-state.js";
import { serviceDefinition, skillAvailable, type DeliverableKind, type DeliveryState, type SkillContext } from "./service-registry.js";

export const SERVICE_JOB_ENVELOPE_VERSION = 1;

export type ServiceJobEnvelope = {
  envelopeVersion: number;
  serviceId: string;
  serviceVersion: number;
  skillId: string;
  principal: JobPrincipal;
  // The account boundary the idempotency key is scoped to ("uid:..." or "ws:...").
  scope: string;
  intent: string;
  deliverable: { kind: DeliverableKind; requestedState: DeliveryState };
  connectionId: string | null;
  // Correlation only: grants no access and doesn't deduplicate (A2A design §6.1).
  contextId: string | null;
  inputDigest: string;
  createdAt: number;
  deadlineAt: number;
  retryWindowMs: number;
};

export type ServiceJobStep = {
  stepId: string;
  kind: "generation" | "command" | "adopted";
  // Derived once when the step is created, then always read back (plan D-5).
  backendKey: string;
  // Submitted by this job, or adopted from another execution (an observer).
  owned: boolean;
  ref: ExecutionRef | null;
  createdAt: number;
};

export type ServiceJobStatus = {
  state: JobState;
  revision: number;
  // The sequence number of the last event committed.
  seq: number;
  updatedAt: number;
  externalOutcome: ExternalOutcome;
  verdict: CompletionVerdict | null;
  detached: { refs: ExecutionRef[] } | null;
  cancelRequested: boolean;
  terminalAt: number | null;
};

export type ServiceJobDoc = {
  jobId: string;
  envelope: ServiceJobEnvelope;
  status: ServiceJobStatus;
  steps: Record<string, ServiceJobStep>;
  keyId: string | null;
};

export type ServiceJobEvent = { seq: number; type: string; at: number; data: Record<string, unknown> };

export const serviceJobRef = (jobId: string) => db().doc(`service-jobs/${jobId}`);
const eventsCol = (jobId: string) => serviceJobRef(jobId).collection("events");
// Zero-padded so document ids sort in sequence order.
const eventRef = (jobId: string, seq: number) => eventsCol(jobId).doc(String(seq).padStart(12, "0"));

export const serviceJobKeyId = (scope: string, key: string) => createHash("sha256").update(`${scope}:${key}`).digest("hex");
const keyRef = (keyId: string) => db().doc(`service-job-keys/${keyId}`);

const millis = (v: any): number | null => (v == null ? null : (v.toMillis?.() ?? Number(v)));
// Live while its job is (expiresAt null), or until its retry window ends.
const keyLive = (d: any, now: number) => !!d && (d.expiresAt == null || millis(d.expiresAt)! > now);

function writeEvent(tx: admin.firestore.Transaction, jobId: string, seq: number, type: string, data: Record<string, unknown>, now: number) {
  tx.create(eventRef(jobId, seq), { seq, type, at: now, data } satisfies ServiceJobEvent);
}

export type CreateServiceJob = {
  serviceId: string;
  skillId: string;
  principal: JobPrincipal;
  scope: string;
  intent: string;
  deliverable: { kind: DeliverableKind; requestedState: DeliveryState };
  connectionId?: string | null;
  contextId?: string | null;
  // A digest of everything the request asked for. The same key with a
  // different digest is a conflict, never a replay.
  inputDigest: string;
  idempotencyKey?: string | null;
  skillContext?: SkillContext;
  now?: number;
  jobId?: string;
};

export type CreateResult = { kind: "created" | "existing"; job: ServiceJobDoc };

export async function createServiceJob(req: CreateServiceJob): Promise<CreateResult> {
  const now = req.now ?? Date.now();
  const def = serviceDefinition(req.serviceId);
  if (!def) throw new NotFoundError(`Unknown service: ${req.serviceId}`);
  const skill = def.skills.find(s => s.skillId === req.skillId);
  if (!skill || !skillAvailable(def, req.skillId, req.skillContext)) {
    throw new ConflictError("skill_unavailable", `Skill ${req.skillId} is not available for ${req.serviceId}.`);
  }
  if (skill.deliverableKind !== req.deliverable.kind || !skill.deliveryStates.includes(req.deliverable.requestedState)) {
    throw new ConflictError("deliverable_unsupported", `Skill ${req.skillId} does not deliver ${req.deliverable.kind}/${req.deliverable.requestedState}.`);
  }

  const jobId = req.jobId ?? randomUUID();
  const keyId = req.idempotencyKey ? serviceJobKeyId(req.scope, req.idempotencyKey) : null;

  return db().runTransaction(async (tx) => {
    if (keyId) {
      const k = (await tx.get(keyRef(keyId))).data();
      if (keyLive(k, now)) {
        if (k.fingerprint !== req.inputDigest) {
          throw new ConflictError("idempotency_key_mismatch", "This idempotency key was used with a different request.");
        }
        const existing = (await tx.get(serviceJobRef(k.jobId))).data() as ServiceJobDoc | undefined;
        if (existing) return { kind: "existing", job: existing } as CreateResult;
        // A binding whose job is missing can't be replayed; refuse rather than
        // guess. (Jobs are never deleted while their key is live.)
        throw new ConflictError("idempotency_key_orphaned", "This idempotency key refers to a job that no longer exists.");
      }
    }
    const envelope: ServiceJobEnvelope = {
      envelopeVersion: SERVICE_JOB_ENVELOPE_VERSION,
      serviceId: def.serviceId,
      serviceVersion: def.version,
      skillId: req.skillId,
      principal: req.principal,
      scope: req.scope,
      intent: req.intent,
      deliverable: req.deliverable,
      connectionId: req.connectionId ?? null,
      contextId: req.contextId ?? null,
      inputDigest: req.inputDigest,
      createdAt: now,
      deadlineAt: now + def.limits.deadlineMs,
      retryWindowMs: def.limits.retryWindowMs,
    };
    const job: ServiceJobDoc = {
      jobId,
      envelope,
      status: {
        state: "accepted", revision: 1, seq: 1, updatedAt: now,
        externalOutcome: "not_requested", verdict: null, detached: null,
        cancelRequested: false, terminalAt: null,
      },
      steps: {},
      keyId,
    };
    tx.create(serviceJobRef(jobId), job);
    writeEvent(tx, jobId, 1, "created", { serviceId: envelope.serviceId, skillId: envelope.skillId, deliverable: envelope.deliverable }, now);
    if (keyId) tx.set(keyRef(keyId), { fingerprint: req.inputDigest, jobId, createdAt: now, expiresAt: null });
    return { kind: "created", job } as CreateResult;
  });
}

export async function readServiceJob(jobId: string): Promise<ServiceJobDoc | null> {
  return ((await serviceJobRef(jobId).get()).data() as ServiceJobDoc) ?? null;
}

const samePrincipal = (a: JobPrincipal, b: JobPrincipal) =>
  a.kind === "user" && b.kind === "user" ? a.uid === b.uid
    : a.kind === "freePlan" && b.kind === "freePlan" ? a.sessionNamespace === b.sessionNamespace && a.sessionUuid === b.sessionUuid
      : false;

// Reads, continuation and cancel need the same ownership as submission. A job
// id is an identifier, not a grant: a stranger's job reads as not found.
export async function serviceJobFor(jobId: string, principal: JobPrincipal): Promise<ServiceJobDoc> {
  const job = await readServiceJob(jobId);
  if (!job || !samePrincipal(job.envelope.principal, principal)) throw new NotFoundError("Job not found.");
  return job;
}

export async function readServiceJobEvents(jobId: string, { after = 0, limit = 100 } = {}): Promise<ServiceJobEvent[]> {
  const snap = await eventsCol(jobId).where("seq", ">", after).orderBy("seq").limit(limit).get();
  return snap.docs.map(d => d.data() as ServiceJobEvent);
}

export type TransitionChange = {
  status?: Partial<Pick<ServiceJobStatus, "state" | "externalOutcome" | "verdict" | "detached" | "cancelRequested">>;
  events?: { type: string; data?: Record<string, unknown> }[];
};

// One transition: a status change and its events, committed together, with
// the revision and event sequence advanced. A terminal job never changes. When
// the job becomes terminal, its idempotency binding starts its retry window.
export async function transitionServiceJob(jobId: string, change: (job: ServiceJobDoc) => TransitionChange | null, { expectedRevision, now = Date.now() }: { expectedRevision?: number; now?: number } = {}): Promise<ServiceJobDoc> {
  return db().runTransaction(async (tx) => {
    const job = (await tx.get(serviceJobRef(jobId))).data() as ServiceJobDoc | undefined;
    if (!job) throw new NotFoundError("Job not found.");
    if (isTerminalJobState(job.status.state)) throw new ConflictError("job_terminal", "This job has ended; follow-up work is a new job.");
    if (expectedRevision != null && job.status.revision !== expectedRevision) {
      throw new ConflictError("job_revision_stale", "The job changed since it was read.");
    }
    const c = change(job);
    if (!c) return job;
    const status: ServiceJobStatus = { ...job.status, ...c.status, revision: job.status.revision + 1, updatedAt: now };
    const events = [...(c.events ?? [])];
    if (c.status?.state && c.status.state !== job.status.state) {
      events.push({ type: "state_changed", data: { from: job.status.state, to: c.status.state, externalOutcome: status.externalOutcome, ...(status.detached ? { detached: status.detached } : {}) } });
    }
    let seq = job.status.seq;
    for (const e of events) writeEvent(tx, jobId, ++seq, e.type, e.data ?? {}, now);
    status.seq = seq;
    if (isTerminalJobState(status.state)) {
      status.terminalAt = now;
      if (job.keyId) tx.update(keyRef(job.keyId), { expiresAt: new Date(now + job.envelope.retryWindowMs) });
    }
    tx.update(serviceJobRef(jobId), { status });
    return { ...job, status };
  });
}

// A step's backend key: derived from the job and step, never from an attempt
// or a clock. Save steps will use the shared save head instead (plan D-5, M1b).
export const stepBackendKey = (jobId: string, stepId: string) => `svcjob:${jobId}:${stepId}`;

// Records a step once. A second call returns the step as first recorded,
// with the same backend key: retries never mint a new one.
export async function recordStep(jobId: string, step: { stepId: string; kind: ServiceJobStep["kind"]; owned: boolean; ref?: ExecutionRef | null; backendKey?: string }, { now = Date.now() } = {}): Promise<ServiceJobStep> {
  return db().runTransaction(async (tx) => {
    const job = (await tx.get(serviceJobRef(jobId))).data() as ServiceJobDoc | undefined;
    if (!job) throw new NotFoundError("Job not found.");
    const existing = job.steps?.[step.stepId];
    if (existing) return existing;
    if (isTerminalJobState(job.status.state)) throw new ConflictError("job_terminal", "This job has ended; follow-up work is a new job.");
    const recorded: ServiceJobStep = {
      stepId: step.stepId,
      kind: step.kind,
      backendKey: step.backendKey ?? stepBackendKey(jobId, step.stepId),
      owned: step.owned,
      ref: step.ref ?? null,
      createdAt: now,
    };
    const seq = job.status.seq + 1;
    writeEvent(tx, jobId, seq, "step_recorded", { stepId: recorded.stepId, kind: recorded.kind, owned: recorded.owned, ref: recorded.ref }, now);
    tx.update(serviceJobRef(jobId), {
      [`steps.${step.stepId}`]: recorded,
      "status.seq": seq,
      "status.revision": job.status.revision + 1,
      "status.updatedAt": now,
    });
    return recorded;
  });
}

// Attaches the execution reference a step's submission or adoption produced.
// The reference is set once; a different one later is a conflict.
export async function bindStepExecution(jobId: string, stepId: string, ref: ExecutionRef, { now = Date.now() } = {}): Promise<ServiceJobStep> {
  return db().runTransaction(async (tx) => {
    const job = (await tx.get(serviceJobRef(jobId))).data() as ServiceJobDoc | undefined;
    const step = job?.steps?.[stepId];
    if (!job || !step) throw new NotFoundError("Step not found.");
    if (step.ref) {
      if (JSON.stringify(step.ref) !== JSON.stringify(ref)) throw new ConflictError("step_execution_bound", "This step is already bound to a different execution.");
      return step;
    }
    const seq = job.status.seq + 1;
    writeEvent(tx, jobId, seq, "step_bound", { stepId, ref }, now);
    tx.update(serviceJobRef(jobId), {
      [`steps.${stepId}.ref`]: ref,
      "status.seq": seq,
      "status.revision": job.status.revision + 1,
      "status.updatedAt": now,
    });
    return { ...step, ref };
  });
}

// Records the caller's cancel request. What it means depends on the job's
// executions: a stop for ones it owns, a detach for ones it adopted (A2A
// design §6.3-6.4); deriveJobState decides.
export async function requestServiceJobCancel(jobId: string, { now = Date.now() } = {}): Promise<ServiceJobDoc> {
  return transitionServiceJob(jobId, job => (job.status.cancelRequested ? null : {
    status: { cancelRequested: true },
    events: [{ type: "cancel_requested" }],
  }), { now });
}
