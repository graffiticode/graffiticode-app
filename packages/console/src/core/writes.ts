// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { randomUUID } from "crypto";
import { compileThroughConnection, recompileTask } from "../lib/task-api";
import { createPublication, deletePublication, PublicationError } from "../lib/publications";
import { isConnectableLang, programSavesToItemBank } from "../lib/connectable";
import { resolveCurrentConnection, currentConnectionId, saveWriteKey } from "../lib/current-connection";
import { reconcileSave } from "../lib/policy-client";
import { describeReconcile, itemWriteFields, reconcileTarget } from "../lib/write-errors";
import { db } from "./db";
import { getItem } from "./items";
import type { AuthArg } from "./types";
import { requireFullAccount } from "./errors";

export type LastWrite = {
  taskId: string;
  connectionId: string | null;
  // skipped: the program saves to the item bank, but there was no current
  // connection to write through (message "no-connection").
  status: "ok" | "failed" | "skipped";
  message?: string;
  at: number;
  // The idempotency key this attempt used (capability W5): reconciliation
  // checks exactly this save, never one found by deriving a key again.
  idempotencyKey?: string;
  // The latest check of an uncertain or partial save against the item bank.
  reconcile?: { verdict: "applied" | "unresolved" | "too-early"; text: string; at: number };
  // Set when a check confirmed the save, which turned it into a success.
  confirmed?: boolean;
};

// A stored message is display text, not a log: keep the item doc small.
export const LAST_WRITE_MESSAGE_LIMIT = 1000;

// Keep each error's reason code (FAIL-01) beside its message, so
// lib/write-errors.ts can explain refusals whose wording doesn't name it.
export const errorMessages = (errors: unknown[]) =>
  errors.map((e: any) => {
    if (typeof e === "string") return e;
    const message = e?.message ?? JSON.stringify(e);
    return typeof e?.code === "string" && e.code && !message.includes(e.code) ? `${message} (${e.code})` : message;
  }).join("; ");

/**
 * Every save writes. A new program version of a connectable item runs through
 * the user's current connection (lib/current-connection.ts), which is what
 * executes its protected calls — its item-bank saves included — and stores the
 * result views show. Called only when a taskId is new or changed, after it has
 * landed, and awaited (Cloud Run throttles background work).
 *
 * Never fails the save: the outcome is recorded on the item as `lastWrite`, and
 * retryItemWrite repeats it. The idempotency key is derived from (item, task,
 * connection), so a re-save of the same program or a retry after a lost
 * response never writes twice. `fresh` (recompileItem) uses a new key instead:
 * the owner asked to run it again, so it writes again.
 *
 * Returns null when nothing is written: free plan, a language without
 * connections, no current connection, or a system account. With no current
 * connection, a save whose program asks to write to the item bank (`code`, the
 * version's parsed program, contains save-to-itembank) records a `skipped`
 * lastWrite instead, so the editor says the item bank was not written; other
 * programs only preview, as before, and record nothing. The system accounts
 * are the shared trial account (FREE_PLAN_UID: bronze/free items; also caught
 * by the freePlan flag) and the eval account (EVAL_UID: sweeps and evals).
 * Their items must never reach an external service, even if one of them holds
 * a connection.
 */
export async function writeThroughCurrentConnection({ auth, itemId, lang, taskId, fresh = false, code }: {
  auth: AuthArg;
  itemId: string;
  lang: string;
  taskId: string;
  fresh?: boolean;
  // The saved version's parsed program; only saves pass it (see above).
  code?: unknown;
}): Promise<LastWrite | null> {
  if (auth.freePlan || !taskId || !isConnectableLang(lang)) return null;
  const systemUids = [process.env.FREE_PLAN_UID, process.env.EVAL_UID].filter(Boolean);
  if (systemUids.includes(auth.uid)) return null;
  let connectionId: string | null;
  try {
    connectionId = (await resolveCurrentConnection({ auth, lang }))?.connectionId ?? null;
  } catch (err) {
    return recordLastWrite({ auth, itemId, taskId, connectionId: null, message: `Could not look up your connections: ${err?.message ?? err}` });
  }
  if (!connectionId) {
    return programSavesToItemBank(code)
      ? recordLastWrite({ auth, itemId, taskId, connectionId: null, message: "no-connection", status: "skipped" })
      : null;
  }
  const idempotencyKey = fresh ? `recompile:${randomUUID()}` : saveWriteKey({ itemId, taskId, connectionId });
  // One save arrives as two simultaneous updateItem calls. The second would
  // reach the broker while the first is in flight and come back "uncertain";
  // instead it waits for the first and reports its outcome. (Per process;
  // recordLastWrite covers a duplicate that lands on another instance.)
  const pending = inFlightWrites.get(idempotencyKey);
  if (pending) return pending;
  const write = performWrite({ auth, itemId, taskId, connectionId, idempotencyKey })
    .finally(() => inFlightWrites.delete(idempotencyKey));
  inFlightWrites.set(idempotencyKey, write);
  return write;
}

export const inFlightWrites = new Map<string, Promise<LastWrite>>();

export async function performWrite({ auth, itemId, taskId, connectionId, idempotencyKey }: {
  auth: AuthArg;
  itemId: string;
  taskId: string;
  connectionId: string;
  idempotencyKey: string;
}): Promise<LastWrite> {
  let message: string | null = null;
  try {
    const resp = await compileThroughConnection({ authToken: auth.token, id: taskId, connectionId, idempotencyKey });
    const errors = [
      ...(Array.isArray(resp?.data?.errors) ? resp.data.errors : []),
      ...(Array.isArray(resp?.errors) ? resp.errors : []),
    ];
    if (resp?.status !== "success" && errors.length === 0) {
      errors.push(resp?.error ?? `compile ${resp?.status ?? "failed"}`);
    }
    if (errors.length) message = errorMessages(errors);
  } catch (err) {
    message = `Write failed: ${err?.message ?? err}`;
  }
  return recordLastWrite({ auth, itemId, taskId, connectionId, message, idempotencyKey });
}

// Stores the outcome on the item. A failure never replaces a success for the
// same version through the same connection: the write happened, and a
// duplicate that raced it (reported "uncertain" by the broker) says nothing new.
// Nor does a skip replace a success for the same version. Any later outcome
// (a retry, a new version) replaces a failure or a skip.
export async function recordLastWrite({ auth, itemId, taskId, connectionId, message, status, idempotencyKey }: {
  auth: AuthArg;
  itemId: string;
  taskId: string;
  connectionId: string | null;
  message: string | null;
  status?: "skipped";
  idempotencyKey?: string;
}): Promise<LastWrite> {
  const lastWrite: LastWrite = {
    taskId,
    connectionId,
    status: status ?? (message === null ? "ok" : "failed"),
    ...(message === null ? {} : { message: message.slice(0, LAST_WRITE_MESSAGE_LIMIT) }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    at: Date.now(),
  };
  if (lastWrite.status === "failed") {
    console.error("writeThroughCurrentConnection(): write failed for item", itemId, message);
  }
  const itemRef = db.doc(`users/${auth.uid}/items/${itemId}`);
  try {
    // A targeted write, not updateItem: recording the outcome is not a content change.
    return await db.runTransaction(async tx => {
      const prev = (await tx.get(itemRef)).data()?.lastWrite;
      if (lastWrite.status !== "ok" && prev?.status === "ok" && prev.taskId === taskId &&
          (lastWrite.status === "skipped" || prev.connectionId === connectionId)) {
        return prev as LastWrite;
      }
      tx.update(itemRef, { lastWrite });
      return lastWrite;
    });
  } catch (err) {
    console.error("writeThroughCurrentConnection(): failed to record the outcome for item", itemId, err);
    return lastWrite;
  }
}

// A publication keeps the connection it was made through. Items published
// before that was recorded were published through their (legacy, per-item)
// connectionId.
export const publicationConnectionOf = (data: any): string | null =>
  data?.publicationId ? (data.publicationConnectionId ?? data.connectionId ?? null) : null;

// Connection fields every Item shape carries. `connectionId` is the CURRENT
// connection for the item's language — what saves write through and what the
// preview shows — not anything stored on the item.
export async function itemConnectionFields(auth: AuthArg, data: any) {
  const lastWrite = data?.lastWrite;
  return {
    connectionId: isConnectableLang(data?.lang) ? await currentConnectionId({ auth, lang: data.lang }) : null,
    publicationConnectionId: publicationConnectionOf(data),
    lastWrite: itemWriteFields(lastWrite),
  };
}

// Repeats the write of the item's current version through the current
// connection — after a failed save write, or to write it through a connection
// chosen since. Same key derivation as the save, so a retry after a lost
// response never repeats the write.
export async function retryItemWrite({ auth, id }: { auth: AuthArg; id: string }) {
  requireFullAccount(auth, "connections");
  const itemDoc = await db.doc(`users/${auth.uid}/items/${id}`).get();
  if (!itemDoc.exists) {
    throw new Error("Item not found");
  }
  const itemData = itemDoc.data();
  if (!itemData.taskId) {
    throw new Error("This item has no saved version to write yet.");
  }
  if (!isConnectableLang(itemData.lang)) {
    throw new Error("This item's language does not use connections.");
  }
  const lastWrite = await writeThroughCurrentConnection({ auth, itemId: id, lang: itemData.lang, taskId: itemData.taskId });
  if (!lastWrite) {
    throw new Error("There is no current connection to write through. Choose one in Settings.");
  }
  return getItem({ auth, id });
}

// Checks an uncertain or partial save against the item bank (capability W5,
// WRITE-02), by the idempotency key that exact attempt used. A confirmed save
// becomes a success; anything else records what the check found, and the
// failure stands. Nothing is written to the item bank.
export async function reconcileItemWrite({ auth, id }: { auth: AuthArg; id: string }) {
  requireFullAccount(auth, "connections");
  const itemRef = db.doc(`users/${auth.uid}/items/${id}`);
  const itemDoc = await itemRef.get();
  if (!itemDoc.exists) {
    throw new Error("Item not found");
  }
  const write = itemDoc.data()?.lastWrite as LastWrite | undefined;
  const target = reconcileTarget(write);
  if (!target) {
    throw new Error("This save can't be checked: only an uncertain or partial save made since checks began can be.");
  }
  const summary = describeReconcile(await reconcileSave(auth.token, target));
  await db.runTransaction(async tx => {
    const now = (await tx.get(itemRef)).data()?.lastWrite as LastWrite | undefined;
    // A newer save since the check started: it decides, not this check.
    if (!now || now.idempotencyKey !== target.idempotencyKey || now.taskId !== write.taskId) return;
    const reconcile = { verdict: summary.verdict, text: summary.text, at: Date.now() };
    const { message: _failure, ...rest } = now;
    tx.update(itemRef, {
      lastWrite: summary.verdict === "applied"
        ? { ...rest, status: "ok", confirmed: true, reconcile }
        : { ...now, reconcile },
    });
  });
  return getItem({ auth, id });
}

// Compiles an item's current version again instead of using the cached
// result, for any language. An item that writes through a connection runs
// through it again with a fresh idempotency key, so its protected calls (item-bank
// saves included) repeat; stable references make that an update, not a copy.
// Anything else recompiles with the api's refresh. Either way the stored result
// is replaced, and the caller reloads the preview.
export async function recompileItem({ auth, id }: { auth: AuthArg; id: string }) {
  requireFullAccount(auth, "connections");
  const itemDoc = await db.doc(`users/${auth.uid}/items/${id}`).get();
  if (!itemDoc.exists) {
    throw new Error("Item not found");
  }
  const itemData = itemDoc.data();
  if (!itemData.taskId) {
    throw new Error("This item has no saved version to recompile yet.");
  }
  const lastWrite = await writeThroughCurrentConnection({
    auth, itemId: id, lang: itemData.lang, taskId: itemData.taskId, fresh: true,
  });
  if (lastWrite?.status === "failed") {
    throw new Error(`Recompile through the connection failed: ${lastWrite.message ?? "unknown error"}`);
  }
  if (!lastWrite) {
    const resp = await recompileTask({ authToken: auth.token, id: itemData.taskId });
    const errors = [
      ...(Array.isArray(resp?.data?.errors) ? resp.data.errors : []),
      ...(Array.isArray(resp?.errors) ? resp.errors : []),
    ];
    if (resp?.status !== "success" && errors.length === 0) {
      errors.push(resp?.error ?? `recompile ${resp?.status ?? "failed"}`);
    }
    if (errors.length) {
      throw new Error(`Recompile failed: ${errorMessages(errors).slice(0, LAST_WRITE_MESSAGE_LIMIT)}`);
    }
  }
  return getItem({ auth, id });
}

// Moves a published item's publication to its current version, through the
// CURRENT connection. The new publication is created first (the gateway
// requires a stored result for that version through that connection, which
// the save wrote), then the old one is deleted, so the item is never
// unpublished in between.
export async function republishItem({ auth, id }: { auth: AuthArg; id: string }) {
  requireFullAccount(auth, "connections");
  const itemRef = db.doc(`users/${auth.uid}/items/${id}`);
  const itemDoc = await itemRef.get();
  if (!itemDoc.exists) {
    throw new Error("Item not found");
  }
  const itemData = itemDoc.data();
  if (!itemData.publicationId) {
    throw new Error("This item is not published through a connection.");
  }
  const connectionId = (await resolveCurrentConnection({ auth, lang: itemData.lang }))?.connectionId ?? null;
  if (!connectionId) {
    throw new Error("There is no current connection to republish through. Choose one in Settings.");
  }
  if (itemData.publishedTaskId === itemData.taskId && publicationConnectionOf(itemData) === connectionId) {
    return getItem({ auth, id });
  }
  // Ensure the version has a stored result through this connection; a no-op
  // when its save already wrote (same idempotency key).
  await writeThroughCurrentConnection({ auth, itemId: id, lang: itemData.lang, taskId: itemData.taskId });
  let publicationId;
  try {
    publicationId = await createPublication({
      authToken: auth.token, taskId: itemData.taskId, connectionId,
    });
  } catch (err) {
    if (err instanceof PublicationError && err.status === 409) {
      throw new Error("The current version has not been written through the current connection. Retry the write, then republish.");
    }
    if (err instanceof PublicationError) {
      throw new Error(`Cannot republish this item: ${err.message}`);
    }
    throw err;
  }
  try {
    await deletePublication({ authToken: auth.token, publicationId: itemData.publicationId });
  } catch (err) {
    if (!(err instanceof PublicationError && err.status === 403 && /publication-not-found/.test(err.message))) {
      // The new publication stands either way; the old one is withdrawn later.
      console.error("republishItem(): failed to delete the previous publication", id, err);
    }
  }
  await itemRef.update({ publicationId, publishedTaskId: itemData.taskId, publicationConnectionId: connectionId });
  return getItem({ auth, id });
}
