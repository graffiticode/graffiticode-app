// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import admin from "firebase-admin";
import { getApiTask } from "./lib/api.js";
import { generateCodeForRequest } from "./lib/code-generation/generate-for-request.js";
import { postTask } from "./lib/task-api.js";
import { backfillTokenUsageItemId } from "./lib/token-usage-service.js";
import { FREE_PLAN_ITEM_TTL_MS } from "./lib/free-plan-context.js";
import { adoptWorkspace } from "./lib/workspace-adoption.js";
import { emitEvent, actor } from "./lib/funnel-events.js";
import { buildItemExpiredError } from "./lib/free-plan-quota.js";
import { createPublication, deletePublication, PublicationError } from "./lib/publications.js";
import { isConnectableLang } from "./lib/connectable.js";
import { resolveCurrentConnection } from "./lib/current-connection.js";
import { db } from "./db.js";
import { assertItemCreateAllowed, isExpiredForFreePlan, isItemVisibleToFreePlan } from "./access.js";
import { recordBillableItem } from "./billing.js";
import { freePlanClaimTokenFor, freePlanItemFields, freePlanTokens } from "./claims.js";
import type { AuthArg } from "./types.js";
import { defaultVersionSource, normalizeVersionSource, recordVersion } from "./versions.js";
import type { VersionSource } from "./versions.js";
import { itemConnectionFields, writeThroughCurrentConnection } from "./writes.js";
import { ConflictError, requireFullAccount } from "./errors.js";
import { assertNoActiveGeneration, legacyMayComplete, LegacyJobRefused } from "./generation-protocol.js";

export async function createItem({
  auth,
  lang,
  name,
  taskId,
  mark,
  help,
  isPublic,
  client,
  upstreamLangs,
  deferGeneration,
  source,
  label,
}: {
  auth: AuthArg;
  lang: string;
  name?: string;
  taskId?: string;
  mark?: number;
  help?: string;
  isPublic?: boolean;
  client?: string;
  upstreamLangs?: string[];
  // Provenance for the version record written on taskId change. Best-effort:
  // defaults to the client tag when the caller doesn't know.
  source?: VersionSource;
  label?: string;
  // When true, create a fast "shell" item with no task and
  // generationStatus="generating" — the caller (startCodeGeneration) runs the
  // real generation asynchronously and fills in the taskId later. Skips the
  // synchronous template generateCode below.
  deferGeneration?: boolean;
}) {
  try {
    // Gate item creation against the account's item budget BEFORE spending any
    // generation compute. Free tiers hard-cap; paid tiers block only past a
    // customer-set overage cap.
    //
    // Anonymous free-plan callers run the SAME gate: the trial account is a real
    // account with a real subscription, and auth.uid already resolves to it, so
    // its plan allowance is the trial's monthly budget. Move that account
    // between tiers and the cap follows with no code change. It carries an
    // overageLimitItems of 0, which turns the paid-tier branch into a hard cap.
    await assertItemCreateAllowed(auth, lang);

    // Generate a unique ID for the item
    const itemRef = db().collection(`users/${auth.uid}/items`).doc();
    const id = itemRef.id;
    // If no name provided, use "unnamed"
    if (!name) {
      name = "unnamed";
    }
    // If no taskId provided, create a minimal template task
    let generatedHelp = help || "[]";
    let generatedRid: string | undefined;
    if (!taskId && !deferGeneration) {
      const result = await generateCodeForRequest({
        auth,
        prompt: "Create a minimal starting template",
        language: lang,
        options: {},
        currentSrc: null,
        itemId: id,
      });
      generatedRid = result.rid;
      taskId = result.taskId;
      if (!taskId) {
        // If generation returned errors (e.g., out-of-scope), surface them to the user
        if (result.errors && result.errors.length > 0) {
          throw new Error(result.errors[0].message);
        }
        throw new Error("Failed to generate template task");
      }
    }
    // Persist the parsed AST on the item doc so that getItem/getItems can
    // lazily re-post the task under the current uid if the taskId is ever null
    // (shareItem and the trial-claim flow both rely on this).
    let code: any = null;
    if (taskId) {
      try {
        const apiTask = await getApiTask({ id: taskId, auth });
        const taskData = apiTask?.[0] || apiTask;
        code = taskData?.code ?? null;
      } catch (err) {
        console.error("createItem(): failed to fetch code for item", id, err);
      }
    }

    const timestamp = Date.now();
    const item: Record<string, any> = {
      id,
      name,
      lang,
      mark: mark || 1, // Default to mark 1 if not provided
      help: generatedHelp,
      isPublic: isPublic || false,
      client: client || 'console', // Default to 'console' if not provided
      upstreamLangs: Array.isArray(upstreamLangs) ? upstreamLangs : [],
      created: timestamp,
      updated: timestamp,
    };
    if (taskId) {
      item.taskId = taskId;
    }
    if (deferGeneration) {
      item.generationStatus = "generating";
      item.generationStartedAt = timestamp;
    }
    if (code !== null) {
      item.code = code;
    }
    if (auth.freePlan) {
      Object.assign(item, freePlanItemFields(auth, timestamp));
    }
    // Use merge: true so the tokenUsage that was accumulated during generation is preserved
    await itemRef.set(item, { merge: true });

    // Backfill token usage docs that were written with itemId: null (deferred generation).
    // On the generation path, all docs have itemId set, so this is a no-op; it covers
    // other paths and provides safety against async late arrivals (e.g., judgeCode).
    if (generatedRid) {
      await backfillTokenUsageItemId({ auth, rid: generatedRid, itemId: id });
    }

    if (taskId) {
      const resolvedSource = normalizeVersionSource(source) ?? defaultVersionSource(item.client);
      await recordVersion({
        auth,
        itemId: id,
        taskId,
        lang,
        upstreamLangs: item.upstreamLangs,
        name,
        mark: item.mark,
        client: item.client,
        source: resolvedSource,
        label,
        createdAt: timestamp,
      });
      // First successful compile of a distinct item — count it for billing.
      await recordBillableItem({
        auth,
        itemId: id,
        taskId,
        lang,
        client: item.client,
        source: resolvedSource,
      });
      const lastWrite = await writeThroughCurrentConnection({ auth, itemId: id, lang, taskId, code });
      if (lastWrite) item.lastWrite = lastWrite;
    }
    return {
      ...item,
      created: String(timestamp),
      updated: String(timestamp),
      ...(await itemConnectionFields(auth, item)),
      ...(await freePlanTokens(auth)),
    };
  } catch (error) {
    console.error("createItem()", "ERROR", error);
    // Message and type are unchanged — callers and MCP error rendering both read
    // `.message`. `cause` is attached so a caller can still tell a quota refusal
    // from a genuine failure, which the workspace registry needs to record the
    // first attempt's outcome as "wall" rather than "error".
    const wrapped = new Error(`Failed to create item: ${error.message}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

export async function updateItem({
  auth,
  id,
  name,
  taskId,
  mark,
  help,
  isPublic,
  client,
  upstreamLangs,
  lang,
  source,
  label,
  onRenderable,
  taskCode,
  legacyLeaseOwner,
}: {
  auth: AuthArg;
  id: string;
  name?: string;
  taskId?: string;
  mark?: number;
  help?: string;
  isPublic?: boolean;
  client?: string;
  upstreamLangs?: string[];
  // Server/worker-internal: the corrected head language when the pre-flight scope gate
  // re-routed away from the client's pick. NOT a client-facing relabel.
  lang?: string;
  // Provenance for the version record written when taskId changes.
  source?: VersionSource;
  label?: string;
  /**
   * Called the moment the item is RENDERABLE — immediately after the taskId write
   * lands, before the re-read and the version/billing records.
   *
   * It exists for the generation worker. Measured on L0000 "multiply 10 and 21"
   * (console 07ecc7b): of the 773ms between `item_generation_timing` and the item
   * reading "ready", 308ms was bookkeeping and 24ms was a re-read — work no viewer
   * waits on, all of it landing BEFORE the status flip. The item was fully
   * renderable a third of a second before anyone could see it.
   *
   * Deliberately NOT "move the writes off the request". They still run, still
   * awaited, still before the worker returns 200 — so nothing becomes lossier and
   * the billing row cannot be dropped by a process that dies in a new window. Only
   * the announcement moves.
   *
   * Throwing here would abandon those writes, so it is caught and logged: a failed
   * status flip must not cost the version and billing records.
   */
  onRenderable?: () => Promise<void>;
  /**
   * The task's AST, when the caller already has it.
   *
   * Supplying it skips the `GET /task` round trip below, which exists only to read
   * this same value back so getItem/getItems can lazily re-post the task under a
   * new owner. The generation worker posted it moments earlier, so fetching it
   * again cost 229-369ms of the time before an item reads "ready" — 66% of what
   * remained after the announcement move.
   *
   * Verified byte-identical through post -> fetch on 2026-09-05, 7/7 across seven
   * dialects at 282 to 103,424 chars. Omitted by every other caller, which keeps
   * the fetch.
   */
  taskCode?: unknown;
  /**
   * Set by the v1 generation worker: the lease it claimed. Its write lands only
   * if it still holds that lease and the item has never had a v2 job (Phase 3.5).
   */
  legacyLeaseOwner?: string;
}) {
  // Step timings for the one caller that waits on them: the generation worker,
  // whose whole post-generation path is round trips (see generate-job.ts). Logged
  // only when the taskId actually changes, which is the create/update path.
  const tUpdateItem = Date.now();
  let tApiTask = 0;
  let apiTaskMs = 0;
  let readMs = 0;
  let writeMs = 0;
  let rereadMs = 0;
  let versionMs = 0;
  try {
    const itemRef = db().doc(`users/${auth.uid}/items/${id}`);
    const tRead = Date.now();
    const itemDoc = await itemRef.get();
    readMs = Date.now() - tRead;
    if (!itemDoc.exists) {
      throw new Error("Item not found");
    }
    const itemData = itemDoc.data();
    // By-id update: the item id is the capability, so a stateless client can refine an
    // item it created under a now-expired MCP session. Listing stays session-gated.
    if (!isItemVisibleToFreePlan(itemData, auth, { byId: true })) {
      if (isExpiredForFreePlan(itemData, auth)) throw buildItemExpiredError();
      throw new Error("Item not found");
    }
    // This is a mutation on an existing item, so the item's workspace wins over
    // whatever ephemeral session the request arrived on.
    adoptWorkspace(auth, itemData);
    // A content change may not write around a running v2 generation (checked
    // again in the write's transaction below).
    if (taskId !== undefined && taskId !== itemData.taskId) assertNoActiveGeneration(itemData);
    if (auth.freePlan && isPublic) {
      throw new Error("Free plan items cannot be made public.");
    }
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (taskId !== undefined) {
      updates.taskId = taskId;
      // Refresh the persisted AST so the lazy-repost in getItem/getItems can
      // recreate the task under a new owner (claim, share). createItem already
      // does this; updateItem must too whenever taskId changes.
      if (taskId !== itemData.taskId) {
        try {
          if (taskCode !== undefined && taskCode !== null) {
            // Already in hand — see the taskCode parameter.
            updates.code = taskCode;
          } else {
            tApiTask = Date.now();
            const apiTask = await getApiTask({ id: taskId, auth });
            apiTaskMs = Date.now() - tApiTask;
            const taskData = apiTask?.[0] || apiTask;
            const code = taskData?.code;
            if (code !== undefined && code !== null) {
              updates.code = code;
            }
          }
        } catch (err) {
          console.error("updateItem(): failed to refresh code for item", id, err);
        }
      }
    }
    if (mark !== undefined) updates.mark = mark;
    if (client !== undefined) updates.client = client;
    if (lang !== undefined) updates.lang = lang;
    if (help !== undefined) updates.help = help;
    if (upstreamLangs !== undefined && Array.isArray(upstreamLangs)) {
      updates.upstreamLangs = upstreamLangs;
    }
    if (isPublic !== undefined) {
      // An item written through a connection is shared by a publication, not
      // by its task alone: viewers see the publisher's stored result, signed
      // under the publication's authority. It is made through the current
      // connection and keeps that connection (publicationConnectionId) when the
      // current one later changes. Making it private withdraws it.
      const publishLang = lang ?? itemData.lang;
      if (isPublic && !itemData.publicationId && !auth.freePlan && isConnectableLang(publishLang)) {
        const itemTaskId = taskId || itemData.taskId;
        let publishVia: string | null;
        try {
          publishVia = (await resolveCurrentConnection({ auth, lang: publishLang }))?.connectionId ?? null;
        } catch (err) {
          throw new Error(`Cannot publish this item: could not look up your connections (${err?.message ?? err})`);
        }
        if (publishVia) {
          // The gateway publishes only a version with a stored result through
          // that connection. Write it first: a no-op when this version already
          // went through (same idempotency key), and needed when the program
          // changes in this same call or predates saves that write.
          await writeThroughCurrentConnection({ auth, itemId: id, lang: publishLang, taskId: itemTaskId });
          try {
            updates.publicationId = await createPublication({
              authToken: auth.token, taskId: itemTaskId, connectionId: publishVia,
            });
            // The version it shows. It stays put when the program changes; the
            // owner republishes deliberately (republishItem).
            updates.publishedTaskId = itemTaskId;
            updates.publicationConnectionId = publishVia;
          } catch (err) {
            if (err instanceof PublicationError) {
              throw new Error(`Cannot publish this item: ${err.message}`);
            }
            throw err;
          }
        }
      } else if (!isPublic && itemData.publicationId) {
        try {
          await deletePublication({ authToken: auth.token, publicationId: itemData.publicationId });
        } catch (err) {
          // Already gone (unpublished elsewhere, or its connection deleted) is
          // the outcome we want; anything else keeps the item public.
          if (!(err instanceof PublicationError && err.status === 403 && /publication-not-found/.test(err.message))) {
            throw err;
          }
        }
        updates.publicationId = admin.firestore.FieldValue.delete();
        updates.publishedTaskId = admin.firestore.FieldValue.delete();
        updates.publicationConnectionId = admin.firestore.FieldValue.delete();
      }
      if (isPublic) {
        // Make every task segment public BEFORE marking the item public, so a
        // failure leaves the item private (no local/API drift). A composition's
        // taskId is `head+up1+up2…`; getApiTask returns one entry per segment.
        // Re-posting each segment's {lang, code} with isPublic flips acls.public
        // on the existing task (postTask deletes Authorization but keeps the
        // persistent storage-type header). Each segment has its own lang.
        const itemTaskId = taskId || itemData.taskId;
        if (itemTaskId) {
          const apiTask = await getApiTask({ id: itemTaskId, auth });
          const segments = Array.isArray(apiTask) ? apiTask : [apiTask];
          await Promise.all(segments.map(({ lang, code }) =>
            postTask({ auth, task: { lang, code }, ephemeral: false, isPublic: true })
          ));
        }
      }
      updates.isPublic = isPublic;
    }
    // Only bump the `updated` timestamp when the taskId actually changes —
    // that's the canonical "content changed" signal. Metadata edits (mark,
    // name, isPublic, etc.) and selection-driven no-op writes shouldn't
    // make an item look freshly modified.
    const taskIdChanged = taskId !== undefined && taskId !== itemData.taskId;
    if (taskIdChanged) {
      updates.updated = Date.now();
    }
    if (auth.freePlan) {
      const ttlBase = updates.updated || itemData.updated || Date.now();
      updates.expiresAt = ttlBase + FREE_PLAN_ITEM_TTL_MS;
    }
    const tWrite = Date.now();
    if (taskIdChanged || legacyLeaseOwner) {
      // Content changes commit only if no v2 job owns the item; a v1 worker's
      // only while it holds its lease on a pointer-free item.
      await db().runTransaction(async (tx) => {
        const fresh = (await tx.get(itemRef)).data();
        if (legacyLeaseOwner && !legacyMayComplete(fresh, legacyLeaseOwner)) throw new LegacyJobRefused();
        assertNoActiveGeneration(fresh);
        tx.update(itemRef, updates);
      });
    } else {
      await itemRef.update(updates);
    }
    writeMs = Date.now() - tWrite;
    // The item now has its taskId: renderable. Announce before the bookkeeping.
    let renderableMs = 0;
    if (onRenderable && taskId !== undefined) {
      const tHook = Date.now();
      try {
        await onRenderable();
      } catch (err) {
        console.error("updateItem(): onRenderable failed for item", id, err);
      }
      renderableMs = Date.now() - tHook;
    }
    // A new program version writes through the current connection. After the
    // announcement, so renderability never waits on the external write; before
    // the re-read, so the returned item carries its lastWrite.
    let writeThroughMs = 0;
    if (taskIdChanged) {
      const tWriteThrough = Date.now();
      // updates.code is this version's program (absent when it could not be
      // fetched: then no skip is recorded rather than one judged on stale code).
      await writeThroughCurrentConnection({ auth, itemId: id, lang: updates.lang ?? itemData.lang, taskId, code: updates.code });
      writeThroughMs = Date.now() - tWriteThrough;
    }
    // Re-reads the document that was just written, to build the return value.
    // The generation worker discards that return value entirely.
    const tReread = Date.now();
    const updatedDoc = await itemRef.get();
    rereadMs = Date.now() - tReread;
    const data = updatedDoc.data();
    // A changed taskId IS a new version — the one signal every producer (chat,
    // direct editor edit, generation worker, MCP) funnels through.
    if (taskIdChanged) {
      versionMs = Date.now();
      const resolvedSource = normalizeVersionSource(source) ?? defaultVersionSource(data.client);
      await recordVersion({
        auth,
        itemId: id,
        taskId,
        lang: data.lang,
        upstreamLangs: data.upstreamLangs,
        name: data.name,
        mark: data.mark,
        client: data.client,
        source: resolvedSource,
        label,
        createdAt: updates.updated,
      });
      // Bill only the no-taskId -> first-taskId transition (the async console/MCP
      // create landing its first artifact). Later taskId -> taskId changes are
      // revisions and must not be counted; recordBillableItem's `billed` guard is
      // a second line of defense.
      if (!itemData.taskId) {
        await recordBillableItem({
          auth,
          itemId: id,
          taskId,
          lang: data.lang,
          client: data.client,
          source: resolvedSource,
        });
      } else {
        // A real taskId -> taskId change: the content actually moved. Not
        // billable, but it is the edit signal the digest reports as depth.
        emitEvent("item_updated", {
          ...actor(auth),
          lang: data.lang,
          app: data.client ?? "console",
          source: resolvedSource,
        });
        if (auth.freePlan) {
          // This is a revision against the trial budget. Counting the successful
          // change rather than the attempt means a generation that failed to
          // compile doesn't burn one of only a handful of revisions — runaway
          // retries are bounded by the burst limiter instead.
          await itemRef.update({
            trialRevisions: admin.firestore.FieldValue.increment(1),
          });
        }
      }
    }
    if (taskIdChanged) {
      console.log(
        `[updateItem] id=${id} read=${readMs} apiTask=${apiTaskMs} write=${writeMs} ` +
          `reread=${rereadMs} onRenderable=${renderableMs} writeThrough=${writeThroughMs} ` +
          `bookkeeping=${versionMs ? Date.now() - versionMs : 0} ` +
          `total=${Date.now() - tUpdateItem}`,
      );
    }
    const tTokens = Date.now();
    const tokens = await freePlanTokens(auth);
    if (taskIdChanged && Date.now() - tTokens > 50) {
      console.log(`[updateItem] id=${id} freePlanTokens=${Date.now() - tTokens}`);
    }
    return {
      id,
      ...data,
      created: String(data.created),
      updated: String(data.updated),
      ...(await itemConnectionFields(auth, data)),
      ...tokens,
    };
  } catch (error) {
    console.error("updateItem()", "ERROR", error);
    // Conflicts keep their type so each transport can report them as such.
    if (error instanceof ConflictError) throw error;
    throw new Error(`Failed to update item: ${error.message}`);
  }
}

// How many items the user has in each language, all clients, not counting
// mark 5 (the Tools view hides it). Aggregate counts only: no item document is
// read or returned, so one request for every language costs a few reads, where
// listing each language's items to count them tied up the server on every
// Tools page load. Unlike getItems, it also counts items with no task yet.
export async function countItems({ auth, langs }: { auth: AuthArg; langs: string[] }) {
  const count = async query => (await query.count().get()).data().count;
  return Promise.all(langs.map(async lang => {
    let query = db().collection(`users/${auth.uid}/items`).where("lang", "==", lang);
    if (auth.freePlan) {
      query = query.where("sessionNamespace", "==", auth.sessionNamespace);
    }
    const [all, hidden] = await Promise.all([count(query), count(query.where("mark", "==", 5))]);
    return { lang, count: all - hidden };
  }));
}

// The names of the user's items in a language (optionally one mark), all
// clients. Reads only the name field: for callers that need names alone, such
// as the Tools view's approved-thumbnail set, getItems' full items (transcripts,
// legacy reads, connection lookups) are wasted work.
export async function getItemNames({ auth, lang, mark }: { auth: AuthArg; lang: string; mark?: number | null }) {
  let query = db().collection(`users/${auth.uid}/items`).where("lang", "==", lang);
  if (mark !== undefined && mark !== null) {
    query = query.where("mark", "==", mark);
  }
  if (auth.freePlan) {
    query = query.where("sessionNamespace", "==", auth.sessionNamespace);
  }
  const snap = await query.select("name").get();
  return snap.docs.map(doc => doc.get("name")).filter(name => typeof name === "string" && name !== "");
}

export async function getItems({ auth, lang, mark, client }) {
  try {
    // Build the base query (lang + optional mark + free-plan). Client filtering
    // happens in memory below so items without a client/app field are treated
    // as 'console' (the default).
    let baseQuery = db()
      .collection(`users/${auth.uid}/items`)
      .where("lang", "==", lang);
    if (mark !== undefined && mark !== null) {
      baseQuery = baseQuery.where("mark", "==", mark);
    }
    if (auth.freePlan) {
      baseQuery = baseQuery.where("sessionNamespace", "==", auth.sessionNamespace);
    }
    // Filtering rules:
    //   client undefined/'all' → no client filter, fetch all.
    //   client === 'console'   → fetch all and memory-filter, since missing
    //                            client field implicitly means console.
    //   client === <other>     → pure server-side `where("client", "==", X)`.
    let docs;
    if (!client || client === 'all') {
      const snap = await baseQuery.get();
      docs = snap.docs;
    } else if (client === 'console') {
      const snap = await baseQuery.get();
      docs = snap.docs.filter(d => (d.data().client ?? 'console') === 'console');
    } else {
      const snap = await baseQuery.where("client", "==", client).get();
      docs = snap.docs;
    }
    // Get the user's sharedItems data to add to items (skip on free plan — shared
    // items are not supported there).
    const sharedItemsData = auth.freePlan
      ? {}
      : (await db().doc(`users/${auth.uid}`).get()).data()?.sharedItems || {};

    const now = Date.now();

    // Process items in parallel and fetch legacy data if needed. Each doc may make
    // its own postTask HTTP call and/or legacy-help read; running them concurrently
    // avoids an N-item network waterfall. Order is restored by the sort below.
    const settled = await Promise.all(docs.map(async (doc) => {
      const data = doc.data();
      // Listing path — stays session-gated (no byId): a session must not enumerate
      // another session's items. `now` moves to the 4th arg after the new `opts`.
      if (!isItemVisibleToFreePlan(data, auth, {}, now)) return null;
      let help = data.help;
      let taskId = data.taskId;

      // If item doesn't have a taskId (e.g., shared item), post the task to create one
      if (!taskId && data.code) {
        try {
          const taskData = await postTask({
            auth,
            task: {
              lang: data.lang,
              code: data.code,
            },
            ephemeral: false,
            isPublic: false,
          });

          if (taskData && taskData.id) {
            taskId = taskData.id;
            // Update the item with the new taskId
            await doc.ref.update({ taskId });
            // This repost is where a shared/claimed item's v1 comes into
            // existence — the copy sites deliberately leave taskId null, and the
            // original's taskId isn't in this uid's ACL, so it can't be recorded
            // there. Idempotent, so re-running on a later read is harmless.
            await recordVersion({
              auth,
              itemId: doc.id,
              taskId,
              lang: data.lang,
              upstreamLangs: data.upstreamLangs,
              name: data.name,
              mark: data.mark,
              client: data.client,
              source: data.claimedFrom ? "claim" : "share",
            });
          }
        } catch (error) {
          console.error(
            "getItems()",
            "Failed to create task for item",
            doc.id,
            error,
          );
        }
      }

      // For backward compatibility: fetch help from legacy taskIds collection
      if (!help && taskId) {
        try {
          const taskDoc = await db()
            .doc(`users/${auth.uid}/taskIds/${taskId}`)
            .get();
          if (taskDoc.exists) {
            const taskData = taskDoc.data();
            help = taskData.help || "[]";
          }
        } catch (error) {
          console.log(
            "getItems()",
            "Failed to fetch legacy task data for item",
            doc.id,
            error,
          );
        }
      }

      // Get the sharedWith list for this item
      const sharedWith = sharedItemsData[doc.id]?.sharedWith || [];

      // Skip items without a valid taskId
      if (!taskId) {
        console.log("getItems()", "Skipping item with null taskId", doc.id);
        return null;
      }

      const item = {
        id: doc.id,
        name: data.name,
        taskId,
        lang: data.lang,
        mark: data.mark || 1, // Default to mark 1 if not set
        help: help || "[]",
        isPublic: data.isPublic || false,
        created: String(data.created),
        updated: data.updated ? String(data.updated) : String(data.created),
        sharedWith: sharedWith,
        sharedFrom: data.sharedFrom || null, // Include sharedFrom field if present
        client: data.client ?? 'console',
        upstreamLangs: Array.isArray(data.upstreamLangs) ? data.upstreamLangs : [],
        generationStatus: data.generationStatus ?? null,
        generationError: data.generationError ?? null,
        generationStartedAt: data.generationStartedAt ? String(data.generationStartedAt) : null,
        generationChars: typeof data.generationChars === "number" ? data.generationChars : null,
        publicationId: data.publicationId ?? null,
        publishedTaskId: data.publishedTaskId ?? null,
        // Resolved once per request for the whole list (lib/current-connection.ts).
        ...(await itemConnectionFields(auth, data)),
      };

      const timestamp = data.updated || data.created || 0;
      return { ...item, _sortKey: timestamp };
    }));

    const items = settled.filter(Boolean);
    items.sort((a, b) => b._sortKey - a._sortKey);
    return items.map(({ _sortKey, ...item }) => item);
  } catch (error) {
    console.error("getItems()", "ERROR", error);
    throw new Error(`Failed to get items: ${error.message}`);
  }
}

export async function getItemClientTags({ auth, lang }) {
  try {
    let query = db()
      .collection(`users/${auth.uid}/items`)
      .where("lang", "==", lang);
    if (auth.freePlan) {
      query = query.where("sessionNamespace", "==", auth.sessionNamespace);
    }
    const snapshot = await query.select("client", "expiresAt").get();
    const now = Date.now();
    const tags = new Set<string>();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (auth.freePlan && typeof data.expiresAt === "number" && data.expiresAt <= now) continue;
      // Items with no client field are considered 'console'.
      tags.add(data.client ?? 'console');
    }
    return Array.from(tags).sort();
  } catch (error) {
    console.error("getItemClientTags()", "ERROR", error);
    return [];
  }
}

// `includeSpec` is server-internal and defaults off on purpose: /api/item dumps this return
// value straight to JSON (`res.status(200).json(item)`), so unconditionally projecting the
// cached spec would bloat that response for every caller. Only getSpec asks for it.
export async function getItem({ auth, id, includeSpec = false }: {
  auth: AuthArg;
  id: string;
  includeSpec?: boolean;
}) {
  try {
    const itemRef = db().doc(`users/${auth.uid}/items/${id}`);
    const itemDoc = await itemRef.get();

    if (!itemDoc.exists) {
      return null;
    }

    const data = itemDoc.data();
    // By-id read: the item id is the capability (mirrors the public form page), so a
    // stateless MCP client can retrieve an item it created under a prior session.
    if (!isItemVisibleToFreePlan(data, auth, { byId: true })) {
      if (isExpiredForFreePlan(data, auth)) throw buildItemExpiredError();
      return null;
    }
    let help = data.help;
    let taskId = data.taskId;

    // If the item has no taskId (e.g., copied via shareItem or claim flow),
    // post the task under the current uid to bind it. Mirrors the guard in
    // getItems().
    if (!taskId && data.code) {
      try {
        const taskData = await postTask({
          auth,
          task: { lang: data.lang, code: data.code },
          ephemeral: false,
          isPublic: false,
        });
        if (taskData?.id) {
          taskId = taskData.id;
          await itemRef.update({ taskId });
          // Mirrors getItems(): the repost is where a shared/claimed item's
          // first version record is born.
          await recordVersion({
            auth,
            itemId: id,
            taskId,
            lang: data.lang,
            upstreamLangs: data.upstreamLangs,
            name: data.name,
            mark: data.mark,
            client: data.client,
            source: data.claimedFrom ? "claim" : "share",
          });
        }
      } catch (error) {
        console.error("getItem(): failed to create task for item", id, error);
      }
    }

    // For backward compatibility: fetch help from legacy taskIds collection
    if (!help && taskId) {
      try {
        const taskDoc = await db().doc(`users/${auth.uid}/taskIds/${taskId}`).get();
        if (taskDoc.exists) {
          const taskData = taskDoc.data();
          help = taskData.help || "[]";
        }
      } catch (error) {
        console.log("getItem()", "Failed to fetch legacy task data", error);
      }
    }

    return {
      id: id,
      name: data.name,
      taskId: taskId,
      lang: data.lang,
      mark: data.mark || 1,
      help: help || "[]",
      isPublic: data.isPublic || false,
      created: String(data.created),
      updated: data.updated ? String(data.updated) : String(data.created),
      client: data.client ?? 'console',
      upstreamLangs: Array.isArray(data.upstreamLangs) ? data.upstreamLangs : [],
      // Absent status ⇒ legacy/synchronous item, treated as ready by clients.
      generationStatus: data.generationStatus ?? null,
      generationError: data.generationError ?? null,
      generationStartedAt: data.generationStartedAt ? String(data.generationStartedAt) : null,
      // The SINGLE-item resolver, which is the one the MCP polls. Adding this field
      // to the list resolver alone left the counter reading null for every
      // render_item call while Firestore held 12,512 — the write worked and the
      // read looked broken. Two shaping sites, both need the field.
      generationChars: typeof data.generationChars === "number" ? data.generationChars : null,
      publicationId: data.publicationId ?? null,
      publishedTaskId: data.publishedTaskId ?? null,
      ...(await itemConnectionFields(auth, data)),
      // Claim token only — a read must be able to offer "save this item" for the
      // workspace the item actually lives in (this retrieval path is where the
      // claim link is surfaced, after the agent polls a create to "ready"), but
      // it must NOT hand back a workspace handle: seeing an item is not joining
      // its workspace. Minted from the ITEM's namespace, not the reader's, which
      // is the whole fix — the reader's ephemeral namespace holds nothing.
      ...(await freePlanClaimTokenFor(auth, data.sessionNamespace)),
      ...(includeSpec ? { spec: data.spec ?? null } : {}),
    };
  } catch (error) {
    console.error("getItem()", "ERROR", error);
    throw new Error(`Failed to get item: ${error.message}`);
  }
}

export async function shareItem({ auth, itemId, targetUserId }) {
  requireFullAccount(auth, "sharing");
  try {
    // Validate that the source item exists and belongs to the current user
    const itemRef = db().doc(`users/${auth.uid}/items/${itemId}`);
    const itemDoc = await itemRef.get();

    if (!itemDoc.exists) {
      return {
        success: false,
        message: "Item not found",
        newItemId: null,
      };
    }

    // Validate that the target user exists
    const targetUserRef = db().doc(`users/${targetUserId}`);
    const targetUserDoc = await targetUserRef.get();

    if (!targetUserDoc.exists) {
      return {
        success: false,
        message: "Target user not found",
        newItemId: null,
      };
    }

    const itemData = itemDoc.data();

    // Create a new item in the target user's collection with "(from <uid>)" suffix
    const targetItemRef = db().collection(`users/${targetUserId}/items`).doc();
    const newItemId = targetItemRef.id;
    const timestamp = Date.now();

    // Add a note to the help transcript about where the item was shared from
    let updatedHelp = itemData.help || "[]";
    try {
      const helpArray = JSON.parse(updatedHelp);
      // Add a note at the end of the help transcript (since display is reversed)
      helpArray.push({
        role: "system",
        content: `Shared by ${auth.uid}`,
        timestamp: timestamp,
        taskId: itemData.taskId // Include the original task ID for clickability
      });
      updatedHelp = JSON.stringify(helpArray);
    } catch (error) {
      // If help is not valid JSON, create a new array with the note
      updatedHelp = JSON.stringify([{
        role: "system",
        content: `Shared by ${auth.uid}`,
        timestamp: timestamp,
        taskId: itemData.taskId // Include the original task ID for clickability
      }]);
    }

    const sharedItem = {
      ...itemData,
      id: newItemId,
      taskId: null, // Clear the task ID - it will be created when the user loads the item
      name: itemData.name,
      help: updatedHelp,
      sharedFrom: auth.uid, // Track who shared this item
      created: timestamp,
      updated: timestamp,
      // Don't copy the isPublic flag - let the recipient decide
      isPublic: false,
    };

    await targetItemRef.set(sharedItem);

    // Update the sender's user document to track shared items
    const senderUserRef = db().doc(`users/${auth.uid}`);
    const senderUserDoc = await senderUserRef.get();

    const sharedItems = senderUserDoc.data()?.sharedItems || {};

    // Initialize the item's share record if it doesn't exist
    if (!sharedItems[itemId]) {
      sharedItems[itemId] = {
        sharedWith: [],
        sharedAt: {},
      };
    }

    // Add the target user if not already shared with
    if (!sharedItems[itemId].sharedWith.includes(targetUserId)) {
      sharedItems[itemId].sharedWith.push(targetUserId);
    }

    // Record when it was shared
    sharedItems[itemId].sharedAt[targetUserId] = timestamp;

    // Update the sender's user document
    await senderUserRef.update({
      sharedItems: sharedItems,
    });

    return {
      success: true,
      message: `Item shared successfully with ${targetUserId}`,
      newItemId: newItemId,
    };
  } catch (error) {
    console.error("shareItem()", "ERROR", error);
    return {
      success: false,
      message: `Failed to share item: ${error.message}`,
      newItemId: null,
    };
  }
}
