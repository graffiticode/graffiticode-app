// The generation outbox (app tier Phase 3.5). Work that must reach another
// system after a content change is recorded as an intent, in the same
// transaction as the change, at effects/{id}; this module carries it out.
//
// Each intent has a fixed `payload`, so it never re-reads an item a later
// generation may have changed. Processing is a leased claim: one processor at a
// time acts on an effect, its outcome is recorded only while it still holds the
// lease, and a processor that dies leaves an `in_flight` effect the sweeper
// takes over once the lease expires. Transient failures go back to `pending`
// with backoff; definite ones end the effect.
//
// Terminal states: done, superseded (a newer version was committed first),
// failed (definite), abandoned (past its grant or retry window), and, for
// billing only, uncertain (an operator has to check Stripe).
//
// Kinds:
//   connection_write  today's save write-through, by the same rules and with
//                     the same idempotency key on every rerun (Broker dedupes)
//   stripe_meter      the meter event captured at completion
//   sponsor_alert     the sponsor's limit warning
//   first_outcome     the workspace registry's first-create outcome
import { randomUUID } from "crypto";
import type admin from "firebase-admin";
import { db } from "./db.js";
import { actAsToken, ActAsError, signGrant } from "./act-as.js";
import type { Principal } from "./auth.js";
import { isConnectableLang, programSavesToItemBank } from "./lib/connectable.js";
import { resolveCurrentConnection, saveWriteKey } from "./lib/current-connection.js";
import { applyLastWrite, buildLastWrite, sendWrite, type LastWrite } from "./writes.js";
import { meterDecision, sendMeterEvent, MeterSendError } from "./lib/item-metering.js";
import { maybeAlertSponsorLimit } from "./lib/sponsor-alerts.js";
import { resolveFirstOutcome } from "./lib/workspace-registry.js";

export const EFFECT_LEASE_MS = 3 * 60_000;
// Due time of a terminal effect or job: never, so due-time queries skip it.
export const NEVER = 8_640_000_000_000_000;
// Effects without a grant of their own give up after a week, like those with one.
export const EFFECT_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Stripe dedupes a meter event's identifier for about 24 hours; past this, a
// resend could be counted twice, so the effect stops for an operator.
export const STRIPE_REPLAY_WINDOW_MS = 20 * 60 * 60_000;

const BACKOFF_MIN = [1, 2, 4, 8, 16, 32];
export const effectBackoffMs = (attempts: number) => (BACKOFF_MIN[attempts - 1] ?? 60) * 60_000;

export type EffectState = "pending" | "in_flight" | "done" | "superseded" | "failed" | "abandoned" | "uncertain";

export type EffectDoc = {
  kind: "connection_write" | "stripe_meter" | "sponsor_alert" | "first_outcome";
  sourceId: string;
  uid: string;
  itemId: string;
  payload: any;
  state: EffectState;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpires: number;
  lastError: string | null;
  createdAt: number;
  firstSentAt?: number;
};

const effectRef = (id: string) => db().doc(`effects/${id}`);
const isTerminal = (state: EffectState) => !(state === "pending" || state === "in_flight");

// A grant's expiry, read from its payload (the auth service verifies it).
export function grantNotAfter(grant: unknown): number | null {
  if (typeof grant !== "string") return null;
  try {
    const n = JSON.parse(Buffer.from(grant.split(".")[0], "base64url").toString("utf8"))?.n;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const expiryOf = (e: EffectDoc) =>
  (e.kind === "connection_write" ? grantNotAfter(e.payload?.effectGrant) : null) ?? e.createdAt + EFFECT_RETENTION_MS;

// Claims a due effect: pending and due, or in flight with an expired lease.
export async function claimEffect(id: string, owner: string, now = Date.now()): Promise<EffectDoc | null> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(effectRef(id));
    if (!snap.exists) return null;
    const e = snap.data() as EffectDoc;
    const due = (e.state === "pending" && e.nextAttemptAt <= now) || (e.state === "in_flight" && e.leaseExpires < now);
    if (!due) return null;
    const leaseExpires = now + EFFECT_LEASE_MS;
    const update: Record<string, unknown> = {
      state: "in_flight",
      attempts: (e.attempts || 0) + 1,
      leaseOwner: owner,
      leaseExpires,
      // Due again only if this processor dies: the sweeper takes it over then.
      nextAttemptAt: leaseExpires,
    };
    // Billing: the first send's time, persisted before the send.
    if (e.kind === "stripe_meter" && !e.firstSentAt) update.firstSentAt = now;
    tx.update(effectRef(id), update);
    return { ...e, ...update, firstSentAt: e.firstSentAt } as EffectDoc;
  });
}

// Records a terminal outcome, only while still holding the lease.
async function finish(id: string, owner: string, state: EffectState, extra: Record<string, unknown> = {}) {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(effectRef(id));
    const e = snap.data() as EffectDoc | undefined;
    if (!e || e.state !== "in_flight" || e.leaseOwner !== owner) return false;
    tx.update(effectRef(id), { state, leaseOwner: null, leaseExpires: 0, nextAttemptAt: NEVER, ...extra });
    return true;
  });
}

// A transient failure: back to pending with backoff, or abandoned past expiry.
async function retryLater(id: string, owner: string, e: EffectDoc, error: string, now = Date.now()) {
  const next = now + effectBackoffMs(e.attempts);
  if (next >= expiryOf(e)) {
    await abandon(id, owner, e, error);
    return "abandoned" as const;
  }
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(effectRef(id));
    const cur = snap.data() as EffectDoc | undefined;
    if (!cur || cur.state !== "in_flight" || cur.leaseOwner !== owner) return;
    tx.update(effectRef(id), { state: "pending", leaseOwner: null, leaseExpires: 0, nextAttemptAt: next, lastError: error.slice(0, 1000) });
  });
  return "pending" as const;
}

const NOT_SENT = "This save was not sent to the item bank: it could not be completed in time. Save again, or Recompile, to send it.";

async function abandon(id: string, owner: string, e: EffectDoc, error: string) {
  console.error("[effects] abandoned", id, e.kind, error);
  if (e.kind === "connection_write") {
    // The user sees it, and can save again or recompile.
    await recordWriteOutcome(id, owner, e, buildLastWrite({
      taskId: e.payload.taskId, connectionId: e.payload.connectionId ?? null, message: NOT_SENT,
    }), "abandoned", { lastError: error.slice(0, 1000) });
    return;
  }
  await finish(id, owner, "abandoned", { lastError: error.slice(0, 1000) });
}

// One fenced transaction: the item's lastWrite by applyLastWrite's rules, and
// the effect's terminal state. If the lease was taken over, nothing is written;
// the new holder resends with the same key and Broker replays the outcome.
async function recordWriteOutcome(id: string, owner: string, e: EffectDoc, lastWrite: LastWrite, state: EffectState = "done", extra: Record<string, unknown> = {}) {
  const itemRef = db().doc(`users/${e.uid}/items/${e.payload.itemId}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(effectRef(id));
    const cur = snap.data() as EffectDoc | undefined;
    if (!cur || cur.state !== "in_flight" || cur.leaseOwner !== owner) return null;
    const item = await tx.get(itemRef);
    const prev = item.data()?.lastWrite as LastWrite | undefined;
    const stored = applyLastWrite(prev, lastWrite);
    if (item.exists && stored !== prev) tx.update(itemRef, { lastWrite: stored });
    tx.update(effectRef(id), { state, leaseOwner: null, leaseExpires: 0, nextAttemptAt: NEVER, ...extra });
    return stored;
  });
}

type Ctx = { now: number; token?: string };

async function connectionWrite(id: string, owner: string, e: EffectDoc, ctx: Ctx): Promise<EffectState | "pending"> {
  const p = e.payload;
  const item = (await db().doc(`users/${e.uid}/items/${p.itemId}`).get()).data();
  // A newer version was committed first: its own effect writes the current content.
  if (!item || item.taskId !== p.taskId) {
    await finish(id, owner, "superseded");
    return "superseded";
  }
  if (p.lookupError) {
    await recordWriteOutcome(id, owner, e, buildLastWrite({ taskId: p.taskId, connectionId: null, message: p.lookupError }));
    return "done";
  }
  if (!p.connectionId) {
    if (p.savesToItemBank) {
      await recordWriteOutcome(id, owner, e, buildLastWrite({ taskId: p.taskId, connectionId: null, message: "no-connection", status: "skipped" }));
    } else {
      await finish(id, owner, "done");
    }
    return "done";
  }
  let token = ctx.token;
  if (!token) {
    try {
      token = await actAsToken({ purpose: "effect", uid: e.uid, subject: `${e.sourceId}:connection_write:${p.taskId}`, grant: p.effectGrant });
    } catch (err) {
      if (err instanceof ActAsError && err.definite) {
        await abandon(id, owner, e, err.message);
        return "abandoned";
      }
      return retryLater(id, owner, e, String((err as Error)?.message ?? err), ctx.now);
    }
  }
  const message = await sendWrite({ token, taskId: p.taskId, connectionId: p.connectionId, idempotencyKey: p.idempotencyKey });
  if (message !== null) console.error("[effects] connection write failed for item", p.itemId, message);
  await recordWriteOutcome(id, owner, e, buildLastWrite({
    taskId: p.taskId, connectionId: p.connectionId, message, idempotencyKey: p.idempotencyKey,
  }));
  return "done";
}

async function stripeMeter(id: string, owner: string, e: EffectDoc, ctx: Ctx): Promise<EffectState | "pending"> {
  const p = e.payload;
  // Past Stripe's dedupe window a resend could double-meter: stop for an
  // operator (scripts/billing-uncertain.ts), whatever the effect's history.
  if (e.firstSentAt && ctx.now - e.firstSentAt > STRIPE_REPLAY_WINDOW_MS) {
    console.error("[effects] billing uncertain", id, p.identifier);
    await finish(id, owner, "uncertain", { lastError: "replay window passed; check Stripe before resending" });
    return "uncertain";
  }
  const decision = meterDecision(p);
  if (decision.send === false) {
    await finish(id, owner, "done", { skipped: decision.reason });
    return "done";
  }
  try {
    await sendMeterEvent({
      eventName: decision.eventName,
      stripeCustomerId: p.stripeCustomerId,
      identifier: p.identifier,
      timestamp: Math.floor(Number(p.timestamp) / 1000),
    });
  } catch (err) {
    if (err instanceof MeterSendError && err.definite) {
      console.error("[effects] billing delivery refused", id, err.message);
      await finish(id, owner, "failed", { lastError: err.message.slice(0, 1000) });
      return "failed";
    }
    return retryLater(id, owner, e, String((err as Error)?.message ?? err), ctx.now);
  }
  await finish(id, owner, "done");
  return "done";
}

async function sponsorAlert(id: string, owner: string, e: EffectDoc): Promise<EffectState> {
  const p = e.payload;
  const sponsor = await db().collection("users").doc(p.sponsorUid).get();
  await maybeAlertSponsorLimit({
    sponsorUid: p.sponsorUid,
    sponsorData: sponsor.exists ? sponsor.data() : {},
    sponsorName: p.sponsorName ?? null,
    periodStart: new Date(p.periodStart),
    now: new Date(p.now),
  });
  await finish(id, owner, "done");
  return "done";
}

async function firstOutcome(id: string, owner: string, e: EffectDoc): Promise<EffectState> {
  await resolveFirstOutcome(e.payload.workspaceKey, e.payload.outcome);
  await finish(id, owner, "done");
  return "done";
}

/**
 * Claims and carries out one effect if it is due. `token`, when the caller
 * already acts as the effect's user (the worker, an editor save), saves an
 * act-as exchange. Returns the state it left the effect in, or null when it
 * wasn't due.
 */
export async function processEffect(id: string, { token, now = Date.now() }: { token?: string; now?: number } = {}): Promise<EffectState | null> {
  const owner = randomUUID();
  const e = await claimEffect(id, owner, now);
  if (!e) return null;
  const ctx = { now, token };
  try {
    if (now >= expiryOf(e)) {
      await abandon(id, owner, e, "past its retry window");
      return "abandoned";
    }
    switch (e.kind) {
      case "connection_write": return await connectionWrite(id, owner, e, ctx);
      case "stripe_meter": return await stripeMeter(id, owner, e, ctx);
      case "sponsor_alert": return await sponsorAlert(id, owner, e);
      case "first_outcome": return await firstOutcome(id, owner, e);
      default:
        await finish(id, owner, "failed", { lastError: `unknown effect kind ${(e as any).kind}` });
        return "failed";
    }
  } catch (err) {
    console.error("[effects] processing failed", id, e.kind, err);
    return retryLater(id, owner, e, String((err as Error)?.message ?? err), now);
  }
}

// Carries out the effects one source (a generation, an editor save) recorded,
// right after it commits. Best effort: the sweeper covers anything left.
export async function processEffectsFor(sourceId: string, opts: { token?: string } = {}) {
  try {
    const snap = await db().collection("effects").where("sourceId", "==", sourceId).get();
    for (const doc of snap.docs) {
      if (isTerminal((doc.data() as EffectDoc).state)) continue;
      await processEffect(doc.id, opts);
    }
  } catch (err) {
    console.error("[effects] processing after commit failed", sourceId, err);
  }
}

// Records an intent in `tx`, the transaction that commits the change it follows.
export function recordEffect(tx: { set(ref: admin.firestore.DocumentReference, data: any): unknown }, id: string, fields: {
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


// --- connection writes ----------------------------------------------------

export type ConnectionIntent = {
  connectionId: string | null;
  lookupError: string | null;
  savesToItemBank: boolean;
} | null;

// Resolved just before the completion commits (it needs Policy, which can't
// be called inside a transaction); recorded in the effect's fixed payload.
export async function connectionIntent(auth: Principal, lang: string, code: unknown): Promise<ConnectionIntent> {
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


// An effect grant lasts the effect's whole retry window (a week-long outage).
export const EFFECT_GRANT_MS = 7 * 24 * 60 * 60_000;

// Records the connection write that follows a new version, in the transaction
// (or batch) that commits it. The connection and idempotency key are fixed
// here, so every rerun sends exactly this write.
export function recordConnectionWrite(tx: { set(ref: admin.firestore.DocumentReference, data: any): unknown }, {
  sourceId, uid, itemId, taskId, lang, connection, now,
}: { sourceId: string; uid: string; itemId: string; taskId: string; lang: string; connection: ConnectionIntent; now: number }) {
  if (!connection || !(connection.connectionId || connection.lookupError || connection.savesToItemBank)) return;
  const kind = "connection_write";
  recordEffect(tx, `${sourceId}:${kind}`, {
    kind, sourceId, uid, itemId, now,
    payload: {
      itemId,
      taskId,
      lang,
      connectionId: connection.connectionId,
      idempotencyKey: connection.connectionId ? saveWriteKey({ itemId, taskId, connectionId: connection.connectionId }) : null,
      lookupError: connection.lookupError,
      savesToItemBank: connection.savesToItemBank,
      effectGrant: signGrant({ purpose: "effect", uid, subject: `${sourceId}:${kind}:${taskId}`, notAfter: now + EFFECT_GRANT_MS }),
    },
  });
}
