// Generation protocol v2 (app tier Phase 3.5): Firestore owns every job.
//
// generation-jobs/{generationId} holds an `envelope`, fixed at reservation and
// enough to run the job with the producer gone, and a `dispatch` record that
// changes only in transactions. The item carries a pointer, `generation:
// {id, state}`, written in the same transactions; its outward
// `generationStatus` stays generating | ready | failed.
//
// Cloud Tasks is only a wake-up ({v: 2, generationId}); nothing is concluded
// from its responses. The worker claims a short lease, renews it, and commits
// completion or failure in one transaction fenced on that lease and the job's
// absolute deadline. Recovery (redispatching due jobs, failing exhausted ones)
// is the sweeper's (R1c), from the job document alone.
//
// The completion transaction also commits what used to follow the item write
// as separate, lossy steps: the version record, billing accounting, the
// canonical funnel events (funnel-events/{eid}), and effect intents
// (effects/{id}) for the work that must reach other systems — connection
// writes, Stripe meter events, sponsor alerts, the workspace's first outcome.
// R1c processes the intents.
import { randomUUID } from "crypto";
import admin from "firebase-admin";
import { db } from "./db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { assertNoActiveGeneration, type GenerationPointer } from "./generation-protocol.js";
import { actAsToken, ActAsError, signGrant } from "./act-as.js";
import { resolveAuth, type Principal } from "./auth.js";
import { dispatchGenerationTask } from "./lib/generation-queue.js";
import { generateCodeForRequest } from "./lib/code-generation/generate-for-request.js";
import { getTask } from "./tasks.js";
import { FREE_PLAN_ITEM_TTL_MS } from "./lib/free-plan-context.js";
import { buildEventPayload, actor } from "./lib/funnel-events.js";
import { dailyDocRef } from "./lib/free-plan-quota.js";
import { isConnectableLang, programSavesToItemBank } from "./lib/connectable.js";
import { resolveCurrentConnection, saveWriteKey } from "./lib/current-connection.js";
import { buildVersionDoc, versionPath, type VersionSource } from "./versions.js";
import { accountFirstCompletion, billingRefs } from "./billing.js";
import { newItemDoc } from "./items.js";

export const JOB_DEADLINE_MS = 45 * 60_000;
export const LEASE_MS = 3 * 60_000;
export const RENEW_EVERY_MS = 60_000;
// The sweeper leaves a running job alone this long after its lease expires.
export const DISPATCH_GRACE_MS = 30_000;
// The generation grant outlives the job's deadline by a margin.
export const GENERATION_GRANT_MS = 60 * 60_000;
// An effect's grant covers its whole retry window (a week-long outage).
export const EFFECT_GRANT_MS = 7 * 24 * 60 * 60_000;
// currentSrc travels in the envelope up to this size; beyond it the worker
// re-reads the source from baseTaskId.
const MAX_INLINE_SRC = 200_000;
// A legacy (v1) job queued but not yet claimed has no lease; its "generating"
// status is trusted for as long as MCP's stale guard would.
const LEGACY_STALE_MS = 16 * 60_000;

export const jobRef = (generationId: string) => db().doc(`generation-jobs/${generationId}`);

export type JobPrincipal =
  | { kind: "user"; uid: string }
  | { kind: "freePlan"; sessionNamespace: string | null; sessionUuid: string | null };

export type JobFailure = { code: string; retryable: boolean; message: string };

export type JobDispatch = {
  state: GenerationPointer["state"];
  attempt: number;
  leaseOwner: string | null;
  leaseExpires: number;
  dispatchCount: number;
  nextDispatchAt: number;
  lastDispatchError: string | null;
  completedAt?: number;
  failure?: JobFailure;
};

export type JobEnvelope = {
  envelopeVersion: 2;
  uid: string;
  itemId: string;
  itemPath: string;
  lang: string;
  prompt: string;
  modification: string;
  // The item's taskId the prompt was prepared against (null for a create).
  baseTaskId: string | null;
  // Inline when small; otherwise re-read from baseTaskId.
  currentSrc: string | null;
  currentData: string | null;
  client: string | null;
  principal: JobPrincipal;
  // The free-plan workspace after adoption (null for a user).
  effectiveWorkspace: string | null;
  // The funnel workspace key the first-outcome registry uses.
  workspaceKey: string | null;
  createdAt: number;
  deadlineAt: number;
  // User jobs: the act-as grant for this job (never a token).
  actAsGrant: string | null;
};

export type GenerationJobDoc = { envelope: JobEnvelope; dispatch: JobDispatch };

const isTerminal = (state: string) => state === "completed" || state === "failed";

// Help-history entry shape shared with the MCP server's parseHelp /
// buildContextualPrompt — keep in lockstep so subsequent updates parse it.
export function appendHelpEntry(helpJson: string, modification: string, taskId: string, at = new Date()): string {
  let history: unknown[] = [];
  try {
    const parsed = JSON.parse(helpJson || "[]");
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    history = [];
  }
  history.push({
    user: modification,
    help: { text: modification },
    type: "user",
    timestamp: at.toISOString(),
    taskId,
  });
  return JSON.stringify(history);
}

/** Job payloads carry the data model as JSON text; bad JSON means no context, never a failure. */
export function parseCurrentData(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[generate-job] currentData was not parseable JSON; generating without it");
    return null;
  }
}

// --- reservation ------------------------------------------------------------

// A legacy (v1) job still owns the item: it marked the item generating and
// either holds a live lease or hasn't been claimed yet.
function legacyJobActive(item: any, now: number) {
  if (item?.generation || item?.generationStatus !== "generating") return false;
  if (item.generationLeaseOwner) return Number(item.generationLeaseExpires) > now;
  return Number(item.generationStartedAt) > 0 && now - Number(item.generationStartedAt) < LEGACY_STALE_MS;
}

function pointerFields(generationId: string, state: GenerationPointer["state"], deadlineAt: number, now: number) {
  return {
    generation: { id: generationId, state },
    generationStatus: "generating",
    generationError: null,
    generationStartedAt: now,
    generationChars: 0,
    // Present while a v2 job runs: MCP reports such an item failed only from
    // durable state, never from its 16-minute stale guard.
    generationDeadlineAt: deadlineAt,
  };
}

/**
 * Reserves a v2 generation: one transaction writes the job, the item pointer
 * and — for a create — the item shell. Nothing is persisted before it, so a
 * crash leaves either nothing or a complete job the sweeper can dispatch.
 * Gates (item budget, free-plan quota) and preparation run before; the caller
 * has resolved and, for a create, adopted the workspace.
 */
export async function reserveGeneration({
  auth, itemId, lang, name, client, prompt, modification, currentSrc, currentData, baseTaskId,
  sessionNamespace, sessionUuid, workspaceKey, now = Date.now(),
}: {
  auth: Principal;
  itemId?: string | null;
  lang: string;
  name?: string;
  client?: string;
  prompt: string;
  modification: string;
  currentSrc?: string | null;
  currentData?: string | null;
  // When given, the revision is refused if the item has moved on since.
  baseTaskId?: string | null;
  sessionNamespace?: string | null;
  sessionUuid?: string | null;
  workspaceKey?: string | null;
  now?: number;
}): Promise<{ itemId: string; generationId: string }> {
  const generationId = randomUUID();
  const deadlineAt = now + JOB_DEADLINE_MS;
  const principal: JobPrincipal = auth.freePlan
    ? { kind: "freePlan", sessionNamespace: auth.sessionNamespace ?? sessionNamespace ?? null, sessionUuid: sessionUuid ?? null }
    : { kind: "user", uid: auth.uid };
  // Signed before anything is written: a producer without the secret fails
  // here rather than leaving a job its worker can never run.
  const actAsGrant = principal.kind === "user"
    ? signGrant({ purpose: "generation", uid: auth.uid, subject: generationId, notAfter: now + GENERATION_GRANT_MS })
    : null;
  const itemRef = itemId
    ? db().doc(`users/${auth.uid}/items/${itemId}`)
    : db().collection(`users/${auth.uid}/items`).doc();
  const id = itemRef.id;

  const envelope = (base: string | null): JobEnvelope => ({
    envelopeVersion: 2,
    uid: auth.uid,
    itemId: id,
    itemPath: itemRef.path,
    lang,
    prompt,
    modification,
    baseTaskId: base,
    currentSrc: typeof currentSrc === "string" && currentSrc.length <= MAX_INLINE_SRC ? currentSrc : null,
    currentData: currentData ?? null,
    client: client ?? null,
    principal,
    effectiveWorkspace: auth.freePlan ? (auth.sessionNamespace ?? sessionNamespace ?? null) : null,
    workspaceKey: workspaceKey ?? null,
    createdAt: now,
    deadlineAt,
    actAsGrant,
  });
  const dispatch: JobDispatch = {
    state: "reserved",
    attempt: 0,
    leaseOwner: null,
    leaseExpires: 0,
    dispatchCount: 0,
    nextDispatchAt: now,
    lastDispatchError: null,
  };

  await db().runTransaction(async (tx) => {
    if (!itemId) {
      tx.set(itemRef, { ...newItemDoc({ auth, id, lang, name, client, timestamp: now }), ...pointerFields(generationId, "reserved", deadlineAt, now) });
      tx.set(jobRef(generationId), { envelope: envelope(null), dispatch });
      return;
    }
    const snap = await tx.get(itemRef);
    if (!snap.exists) throw new NotFoundError(`Item not found: ${itemId}`);
    const item = snap.data();
    assertNoActiveGeneration(item);
    if (legacyJobActive(item, now)) {
      throw new ConflictError("generation_in_progress", "This item is still generating. Wait for it to finish (get_item / render_item), then try again.");
    }
    const current = item.taskId ?? null;
    if (baseTaskId !== undefined && (baseTaskId ?? null) !== current) {
      throw new ConflictError("item_changed", "This item changed since the revision was prepared. Read it again (get_item), then retry.");
    }
    tx.update(itemRef, pointerFields(generationId, "reserved", deadlineAt, now));
    tx.set(jobRef(generationId), { envelope: envelope(current), dispatch });
  });

  await wakeJob(generationId, 0);
  return { itemId: id, generationId };
}

// Best effort: whatever happens, the outcome only lands in lastDispatchError.
// The job is durable and the sweeper redispatches it if this never arrives.
export async function wakeJob(generationId: string, dispatchCount: number) {
  try {
    await dispatchGenerationTask({ v: 2, generationId }, `gen-${generationId}-${dispatchCount}`);
  } catch (err: any) {
    // 409: this slot's task already exists, which is what we wanted.
    if (err?.status === 409) return;
    console.warn("[generation-jobs] wake-up failed", generationId, dispatchCount, err?.message ?? err);
    await jobRef(generationId)
      .update({ "dispatch.lastDispatchError": String(err?.message ?? err).slice(0, 500) })
      .catch(() => {});
  }
}

// --- the worker ---------------------------------------------------------------

class LeaseLost extends Error {
  constructor() {
    super("lease lost");
    this.name = "LeaseLost";
  }
}

function failureFields(failure: JobFailure) {
  return {
    generationStatus: "failed",
    generationError: failure.message,
    generationStartedAt: null,
    generationChars: null,
    generationDeadlineAt: null,
    "generation.state": "failed",
  };
}

function recordEffect(tx: admin.firestore.Transaction, id: string, fields: {
  kind: string; sourceId: string; uid: string; itemId: string; payload: Record<string, unknown>; now: number;
}) {
  tx.set(db().doc(`effects/${id}`), {
    kind: fields.kind,
    sourceId: fields.sourceId,
    uid: fields.uid,
    itemId: fields.itemId,
    payload: fields.payload,
    state: "pending",
    attempts: 0,
    nextAttemptAt: fields.now,
    leaseOwner: null,
    leaseExpires: 0,
    lastError: null,
    createdAt: fields.now,
  });
}

function recordEvent(tx: admin.firestore.Transaction, sourceId: string, ev: any, fields: Record<string, unknown>, now: number) {
  const payload = buildEventPayload(ev, fields as any, new Date(now).toISOString());
  tx.set(db().doc(`funnel-events/${sourceId}:${ev}`), { ...payload, at: now });
}

// Fails a non-terminal job in `tx` (the caller has read job and item).
function failInTx(tx: admin.firestore.Transaction, generationId: string, job: GenerationJobDoc, item: any, failure: JobFailure, now: number, auth?: Principal | null) {
  const env = job.envelope;
  tx.update(jobRef(generationId), {
    "dispatch.state": "failed",
    "dispatch.failure": failure,
    "dispatch.completedAt": now,
    "dispatch.leaseOwner": null,
    "dispatch.leaseExpires": 0,
  });
  if (item && item.generation?.id === generationId) {
    tx.update(db().doc(env.itemPath), failureFields(failure));
  }
  const who = auth ?? { uid: env.uid, freePlan: env.principal.kind === "freePlan", sessionNamespace: env.effectiveWorkspace ?? undefined };
  recordEvent(tx, generationId, "item_generation_failed", {
    ...actor(who as any), lang: env.lang, app: env.client ?? "console", err: failure.message, code: failure.code,
  }, now);
  if (env.workspaceKey) {
    recordEffect(tx, `${generationId}:first_outcome`, {
      kind: "first_outcome", sourceId: generationId, uid: env.uid, itemId: env.itemId,
      payload: { workspaceKey: env.workspaceKey, outcome: "generation_failed" }, now,
    });
  }
}

type Claim =
  | { kind: "missing" | "terminal" | "busy" | "expired" }
  | { kind: "claimed"; job: GenerationJobDoc };

export async function claimJob(generationId: string, owner: string, now = Date.now()): Promise<Claim> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(jobRef(generationId));
    if (!snap.exists) return { kind: "missing" } as Claim;
    const job = snap.data() as GenerationJobDoc;
    const itemSnap = await tx.get(db().doc(job.envelope.itemPath));
    const item = itemSnap.exists ? itemSnap.data() : null;
    const d = job.dispatch;
    if (isTerminal(d.state)) return { kind: "terminal" } as Claim;
    if (now >= job.envelope.deadlineAt) {
      failInTx(tx, generationId, job, item, {
        code: "deadline_exceeded", retryable: true, message: "Generation did not finish in time. Try again.",
      }, now);
      return { kind: "expired" } as Claim;
    }
    if (d.state === "running" && d.leaseExpires > now) return { kind: "busy" } as Claim;
    const leaseExpires = Math.min(now + LEASE_MS, job.envelope.deadlineAt);
    tx.update(jobRef(generationId), {
      "dispatch.state": "running",
      "dispatch.attempt": (d.attempt || 0) + 1,
      "dispatch.leaseOwner": owner,
      "dispatch.leaseExpires": leaseExpires,
      // A live job is never due for the sweeper.
      "dispatch.nextDispatchAt": leaseExpires + DISPATCH_GRACE_MS,
    });
    if (item?.generation?.id === generationId) {
      tx.update(db().doc(job.envelope.itemPath), { "generation.state": "running" });
    }
    return {
      kind: "claimed",
      job: { ...job, dispatch: { ...d, state: "running", leaseOwner: owner, leaseExpires } },
    } as Claim;
  });
}

// Extends the lease, or at the deadline fails the job instead. Returns false
// when the lease is no longer ours (taken over, or the job ended).
export async function renewLease(generationId: string, owner: string, now = Date.now()): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(jobRef(generationId));
    if (!snap.exists) return false;
    const job = snap.data() as GenerationJobDoc;
    const itemSnap = await tx.get(db().doc(job.envelope.itemPath));
    const d = job.dispatch;
    if (d.state !== "running" || d.leaseOwner !== owner) return false;
    if (now >= job.envelope.deadlineAt) {
      failInTx(tx, generationId, job, itemSnap.exists ? itemSnap.data() : null, {
        code: "deadline_exceeded", retryable: true, message: "Generation did not finish in time. Try again.",
      }, now);
      return false;
    }
    const leaseExpires = Math.min(now + LEASE_MS, job.envelope.deadlineAt);
    tx.update(jobRef(generationId), {
      "dispatch.leaseExpires": leaseExpires,
      "dispatch.nextDispatchAt": leaseExpires + DISPATCH_GRACE_MS,
    });
    return true;
  });
}

// Reads the job and item in `tx` and checks this worker may still write.
async function fenced(tx: admin.firestore.Transaction, generationId: string, owner: string, now: number) {
  const snap = await tx.get(jobRef(generationId));
  if (!snap.exists) throw new LeaseLost();
  const job = snap.data() as GenerationJobDoc;
  const itemRef = db().doc(job.envelope.itemPath);
  const itemSnap = await tx.get(itemRef);
  const d = job.dispatch;
  if (d.state !== "running" || d.leaseOwner !== owner || now >= job.envelope.deadlineAt) throw new LeaseLost();
  const item = itemSnap.exists ? itemSnap.data() : null;
  if (!item || item.generation?.id !== generationId) throw new LeaseLost();
  return { job, item, itemRef };
}

export async function failJob(generationId: string, owner: string, failure: JobFailure, auth?: Principal | null, now = Date.now()) {
  await db().runTransaction(async (tx) => {
    const { job, item } = await fenced(tx, generationId, owner, now);
    failInTx(tx, generationId, job, item, failure, now, auth);
  });
}

// Gives up this attempt without deciding the job: the lease is released so the
// sweeper redispatches it (with backoff) rather than waiting for expiry.
async function releaseAttempt(generationId: string, owner: string, reason: string) {
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(generationId));
      const d = snap.data()?.dispatch as JobDispatch | undefined;
      if (!d || d.state !== "running" || d.leaseOwner !== owner) return;
      tx.update(jobRef(generationId), {
        "dispatch.leaseOwner": null,
        "dispatch.leaseExpires": 0,
        "dispatch.nextDispatchAt": Date.now(),
        "dispatch.lastDispatchError": reason.slice(0, 500),
      });
    });
  } catch (err) {
    console.error("[generation-jobs] release failed", generationId, err);
  }
}

// The principal the job runs as, rebuilt from the envelope — never a stored token.
async function principalFor(generationId: string, env: JobEnvelope): Promise<Principal> {
  if (env.principal.kind === "freePlan") {
    const auth = await resolveAuth({
      freePlan: true,
      sessionNamespace: env.effectiveWorkspace ?? env.principal.sessionNamespace ?? undefined,
      sessionUuid: env.principal.sessionUuid ?? undefined,
    });
    if (auth.uid !== env.uid) throw new ActAsError(403, "free-plan account changed since the job was reserved");
    return auth;
  }
  const token = await actAsToken({ purpose: "generation", uid: env.uid, subject: generationId, grant: env.actAsGrant ?? "" });
  return { uid: env.uid, token };
}

type ConnectionIntent = {
  connectionId: string | null;
  lookupError: string | null;
  savesToItemBank: boolean;
} | null;

// Resolved just before the completion commits (it needs Policy, which can't
// be called inside a transaction); recorded in the effect's fixed payload.
async function connectionIntent(auth: Principal, lang: string, code: unknown): Promise<ConnectionIntent> {
  if (auth.freePlan || !isConnectableLang(lang)) return null;
  const systemUids = [process.env.FREE_PLAN_UID, process.env.EVAL_UID].filter(Boolean);
  if (systemUids.includes(auth.uid)) return null;
  try {
    const connectionId = (await resolveCurrentConnection({ auth, lang }))?.connectionId ?? null;
    return { connectionId, lookupError: null, savesToItemBank: programSavesToItemBank(code) };
  } catch (err: any) {
    return { connectionId: null, lookupError: `Could not look up your connections: ${err?.message ?? err}`, savesToItemBank: programSavesToItemBank(code) };
  }
}

type Generated = { taskId: string; taskCode?: unknown; language?: string; upstreamLangs?: string[] };

export async function completeJob(generationId: string, owner: string, auth: Principal, result: Generated, connection: ConnectionIntent, now = Date.now()) {
  const source: VersionSource = "generation-job";
  await db().runTransaction(async (tx) => {
    const { job, item, itemRef } = await fenced(tx, generationId, owner, now);
    const env = job.envelope;
    const lang = result.language && result.language !== env.lang ? result.language : (item.lang ?? env.lang);
    const upstreamLangs = Array.isArray(result.upstreamLangs) ? result.upstreamLangs : (item.upstreamLangs ?? []);
    const taskIdChanged = result.taskId !== item.taskId;
    const firstTaskId = !item.taskId;
    const billing = taskIdChanged && firstTaskId && !item.billed && !item.sharedFrom && !item.claimedFrom;

    // All reads before any write.
    const versionRef = db().doc(versionPath(env.uid, env.itemId, result.taskId));
    const versionSnap = taskIdChanged ? await tx.get(versionRef) : null;
    const refs = billing ? billingRefs({ uid: env.uid, lang }) : null;
    let reads: any = null;
    let trial: any = null;
    if (refs) {
      reads = {
        user: await tx.get(refs.user),
        usage: await tx.get(refs.usage),
        sponsorUser: refs.sponsorUser ? await tx.get(refs.sponsorUser) : null,
        sponsorUsage: refs.sponsorUsage ? await tx.get(refs.sponsorUsage) : null,
      };
      if (auth.freePlan && refs.env !== "local") {
        const ref = dailyDocRef(new Date(now));
        trial = { ref, snap: await tx.get(ref) };
      }
    }

    const updates: Record<string, any> = {
      help: appendHelpEntry(item.help ?? "[]", env.modification, result.taskId, new Date(now)),
      generationStatus: "ready",
      generationError: null,
      generationStartedAt: null,
      generationChars: null,
      generationDeadlineAt: null,
      "generation.state": "completed",
    };
    if (taskIdChanged) {
      updates.taskId = result.taskId;
      updates.updated = now;
      if (result.taskCode !== undefined && result.taskCode !== null) updates.code = result.taskCode;
    }
    if (lang !== item.lang) updates.lang = lang;
    if (Array.isArray(result.upstreamLangs)) updates.upstreamLangs = upstreamLangs;
    if (auth.freePlan) updates.expiresAt = (updates.updated || item.updated || now) + FREE_PLAN_ITEM_TTL_MS;

    if (taskIdChanged) {
      if (versionSnap?.exists) {
        tx.update(versionRef, { lastSeenAt: now });
      } else {
        tx.create(versionRef, buildVersionDoc({
          auth, itemId: env.itemId, taskId: result.taskId, lang, upstreamLangs, name: item.name,
          mark: item.mark, client: item.client, source, label: env.modification, createdAt: now,
        }));
      }
      if (billing && refs) {
        updates.billed = true;
        updates.billedTaskId = result.taskId;
        updates.billedAt = now;
        const accounted = accountFirstCompletion(tx, {
          auth, itemId: env.itemId, taskId: result.taskId, lang, client: item.client, source,
          now: new Date(now), refs, reads, trial,
        });
        for (const e of accounted.events) recordEvent(tx, generationId, e.ev, e.fields, now);
        for (const e of accounted.effects) {
          recordEffect(tx, e.id, { kind: e.kind, sourceId: generationId, uid: env.uid, itemId: env.itemId, payload: e.payload, now });
        }
      } else if (!firstTaskId) {
        // A real revision: the edit signal, and one of the trial's revisions.
        recordEvent(tx, generationId, "item_updated", {
          ...actor(auth), lang, app: item.client ?? "console", source,
        }, now);
        if (auth.freePlan) updates.trialRevisions = admin.firestore.FieldValue.increment(1);
      }
      if (connection && (connection.connectionId || connection.lookupError || connection.savesToItemBank)) {
        const kind = "connection_write";
        recordEffect(tx, `${generationId}:${kind}`, {
          kind, sourceId: generationId, uid: env.uid, itemId: env.itemId, now,
          payload: {
            itemId: env.itemId,
            taskId: result.taskId,
            lang,
            connectionId: connection.connectionId,
            idempotencyKey: connection.connectionId
              ? saveWriteKey({ itemId: env.itemId, taskId: result.taskId, connectionId: connection.connectionId })
              : null,
            lookupError: connection.lookupError,
            savesToItemBank: connection.savesToItemBank,
            effectGrant: signGrant({
              purpose: "effect", uid: env.uid, subject: `${generationId}:${kind}:${result.taskId}`, notAfter: now + EFFECT_GRANT_MS,
            }),
          },
        });
      }
    }
    if (env.workspaceKey) {
      recordEffect(tx, `${generationId}:first_outcome`, {
        kind: "first_outcome", sourceId: generationId, uid: env.uid, itemId: env.itemId,
        payload: { workspaceKey: env.workspaceKey, outcome: "ok" }, now,
      });
    }
    tx.update(itemRef, updates);
    tx.update(jobRef(generationId), {
      "dispatch.state": "completed",
      "dispatch.completedAt": now,
      "dispatch.leaseOwner": null,
      "dispatch.leaseExpires": 0,
      "dispatch.result": { taskId: result.taskId },
    });
  });
}

/**
 * The v2 worker for one wake-up. Always answers 2xx: recovery is the sweeper's,
 * from the job document, never Cloud Tasks' retries.
 */
export async function runJobV2(generationId: string): Promise<{ status: number; body: unknown }> {
  const owner = randomUUID();
  const claim = await claimJob(generationId, owner);
  if (claim.kind !== "claimed") return { status: 200, body: { status: claim.kind } };
  const env = claim.job.envelope;

  let lost = false;
  const heartbeat = setInterval(() => {
    renewLease(generationId, owner).then(ok => { if (!ok) lost = true; }).catch(err => {
      console.error("[generation-jobs] renewal failed", generationId, err);
    });
  }, RENEW_EVERY_MS);
  const holding = () => { if (lost) throw new LeaseLost(); };

  let auth: Principal | null = null;
  try {
    try {
      auth = await principalFor(generationId, env);
    } catch (err) {
      if (err instanceof ActAsError && err.definite) {
        await failJob(generationId, owner, { code: "credentials_refused", retryable: true, message: "This generation's authorization was refused. Try again." });
        return { status: 200, body: { status: "failed" } };
      }
      throw err;
    }
    holding();
    let currentSrc = env.currentSrc;
    if (currentSrc == null && env.baseTaskId) currentSrc = (await getTask({ auth, id: env.baseTaskId }))?.src ?? null;
    holding();
    const result: any = await generateCodeForRequest({
      auth,
      prompt: env.prompt,
      language: env.lang,
      options: {},
      currentSrc: currentSrc ?? null,
      currentData: parseCurrentData(env.currentData),
      itemId: env.itemId,
      client: env.client ?? undefined,
    });
    holding();
    if (result.errors?.length || !result.taskId) {
      const message = result.errors?.map((e: any) => e.message).join("\n") || "No taskId returned";
      const code = result.errors?.find((e: any) => e.code)?.code ?? "generation_failed";
      await failJob(generationId, owner, { code, retryable: false, message }, auth);
      return { status: 200, body: { status: "failed", error: message } };
    }
    const lang = result.language && result.language !== env.lang ? result.language : env.lang;
    const connection = await connectionIntent(auth, lang, result.taskCode);
    holding();
    await completeJob(generationId, owner, auth, result, connection);
    return { status: 200, body: { status: "ready", taskId: result.taskId } };
  } catch (err: any) {
    if (err instanceof LeaseLost) {
      // Taken over, failed at its deadline, or ended elsewhere: write nothing.
      console.warn("[generation-jobs] lease lost; result dropped", generationId);
      return { status: 200, body: { status: "lost" } };
    }
    console.error("[generation-jobs] attempt failed", generationId, err);
    await releaseAttempt(generationId, owner, String(err?.message ?? err));
    return { status: 200, body: { status: "retrying" } };
  } finally {
    clearInterval(heartbeat);
  }
}
