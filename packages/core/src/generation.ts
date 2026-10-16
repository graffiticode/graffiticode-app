// Moved from pages/api/index.ts (startCodeGeneration) and pages/api/generate-job.ts
// (the worker body) — Phase 1: untangle inside the console.

import { randomUUID } from "crypto";
import { generateCodeForRequest } from "./lib/code-generation/generate-for-request.js";
import { enqueueGenerationJob } from "./lib/generation-queue.js";
import type { GenerationJob } from "./lib/generation-queue.js";
import { FreePlanError } from "./lib/free-plan-context.js";
import { emitEvent, actor, hashUid, langKey } from "./lib/funnel-events.js";
import { isInternalRequest } from "./lib/funnel-exclusions.js";
import { registerFirstCreateAttempt, resolveFirstOutcome } from "./lib/workspace-registry.js";
import { principalFromReplay, resolveAuth, type Principal } from "./auth.js";
import { adoptWorkspaceFromSibling } from "./claims.js";
import { createItem, getItem, updateItem } from "./items.js";
import { claimGeneration, releaseGeneration, setItemGenerationStatus } from "./generation-lease.js";
import { effectiveProtocol, LegacyJobRefused } from "./generation-protocol.js";
import { appendHelpEntry, parseCurrentData, reserveGeneration } from "./generation-jobs.js";
import { assertItemCreateAllowed } from "./access.js";

// startCodeGeneration: reserve (create the shell, or mark an existing item
// generating) and enqueue the worker job. Serves create_item and update_item.
export async function startGeneration(ctx: any, args: any) {
  const {
    itemId,
    siblingOf,
    lang,
    name,
    client,
    clientKind,
    geoCountry,
    prompt,
    modification,
    currentSrc,
    currentData,
    // The item's taskId the revision was prepared against (core reviseItem).
    // v2 refuses the revision if the item has moved on since.
    baseTaskId,
    // REST Idempotency-Key claim (core/idempotency.ts), bound in the reservation.
    idempotency,
  } = args;

  // Re-read before every reservation: once the v2 floor is set, nothing here
  // produces v1 work again (generation-protocol.ts).
  const protocol = (await effectiveProtocol()).effective;

  // The agent OMTM counts a workspace's FIRST create attempt, any outcome.
  // Gated on `!itemId` because this resolver serves update_item too, and a
  // revision is not a new workspace.
  //
  // Free-plan registers BEFORE resolveAuth: the namespace is already on ctx,
  // so an attempt whose credential exchange fails still lands a row.
  //
  // The hints arrive either way — a GraphQL arg (explicit, per call) or a
  // header (per connection). Whichever the caller sends.
  //
  // geoCountry MUST be forwarded: MCP→console is a server-to-server fetch
  // from Cloud Run, so there is no edge in front of this request to read it
  // from. Reading our own headers here would record our egress region.
  const hints = {
    lang: langKey(lang),
    clientKind: clientKind ?? ctx.clientKind,
    geoCountry: geoCountry ?? ctx.geoCountry,
  };
  //
  // Also gated on `!siblingOf`: a sibling create JOINS an existing workspace,
  // so it is by definition not a new one. Without this, a transport-per-call
  // client registers one "new creating workspace" per ITEM and the agent OMTM
  // reports create volume as user growth.
  if (!itemId && !siblingOf && ctx.freePlan && ctx.sessionNamespace) {
    await registerFirstCreateAttempt({
      key: ctx.sessionNamespace,
      auth: "free",
      ...hints,
      internal: isInternalRequest({
        internalHeader: ctx.internalHeader,
        sessionNamespace: ctx.sessionNamespace,
      }),
    });
  }

  const auth = await resolveAuth(ctx);

  // Adopt BEFORE createItem: freePlanItemFields(auth) stamps the new item with
  // auth.sessionNamespace, so the rebind has to land first or the item is
  // written into the very workspace we are trying to escape.
  if (!itemId) {
    await adoptWorkspaceFromSibling(auth, siblingOf);
  }

  // Authenticated has to wait for the uid. Keyed on sha256(uid) so a token
  // rotation doesn't invent a second workspace.
  //
  // Free-plan reads the ADOPTED namespace, not the header's: resolveFirstOutcome
  // has to land on the row this create actually belongs to.
  let workspaceKey = ctx.freePlan
    ? (auth.sessionNamespace ?? ctx.sessionNamespace)
    : undefined;
  if (!ctx.freePlan && auth.uid) {
    workspaceKey = hashUid(auth.uid);
    if (!itemId) {
      await registerFirstCreateAttempt({
        key: workspaceKey,
        auth: "firebase",
        ...hints,
        internal: isInternalRequest({
          internalHeader: ctx.internalHeader,
          uidHash: workspaceKey,
        }),
      });
    }
  }
  if (protocol >= 2) {
    try {
      // The create gate, as createItem runs it; a revision has no gate here.
      if (!itemId) await assertItemCreateAllowed(auth, lang);
      const reserved = await reserveGeneration({
        auth, itemId, lang, name, client, prompt, modification, currentSrc, currentData,
        ...(baseTaskId !== undefined ? { baseTaskId } : {}),
        sessionNamespace: ctx.sessionNamespace, sessionUuid: ctx.sessionUuid, workspaceKey, idempotency,
      });
      return {
        itemId: reserved.itemId,
        status: "generating",
        workspaceNamespace: auth.freePlan ? (auth.sessionNamespace ?? null) : null,
      };
    } catch (err) {
      if (itemId) throw err;
      // As in v1 below: a refused create is still the workspace's first attempt.
      await resolveFirstOutcome(workspaceKey, err instanceof FreePlanError ? "wall" : "error");
      // createItem's wording, so callers see the same error either way.
      const wrapped = new Error(`Failed to create item: ${(err as Error).message}`);
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }

  // Credential the worker replays to act as this caller. For free-plan we
  // re-derive fresh credentials in the worker (idTokens are short-lived and
  // dispatch can lag), so carry the session, not a baked idToken.
  //
  // Carries the ADOPTED namespace: the item has just been written into the
  // sibling's workspace, so a worker replaying the pre-adoption one would act
  // as a different workspace than the item it is generating for.
  const authReplay = ctx.freePlan
    ? {
        kind: "freePlan" as const,
        sessionNamespace: auth.sessionNamespace ?? ctx.sessionNamespace,
        sessionUuid: ctx.sessionUuid,
      }
    : { kind: "bearer" as const, token: ctx.token };

  let id = itemId;
  if (!id) {
    try {
      const shell = await createItem({ auth, lang, name, client, deferGeneration: true }) as unknown as { id: string };
      id = shell.id;
    } catch (err) {
      // The synchronous half of firstOutcome. A refusal at the quota gate is
      // still an attempt the OMTM counts, and it is the case that otherwise
      // leaves no Firestore row at all — assertItemCreateAllowed throws
      // before the item shell is written.
      const cause = (err as { cause?: unknown })?.cause;
      await resolveFirstOutcome(
        workspaceKey,
        cause instanceof FreePlanError ? "wall" : "error",
      );
      throw err;
    }
  } else {
    await setItemGenerationStatus({ auth, id, status: "generating" });
  }

  await enqueueGenerationJob({
    itemId: id,
    lang,
    prompt,
    modification,
    currentSrc,
    // Serialized JSON, passed through untouched: the worker hands it to
    // generateCodeForRequest, which parses and renders it as <CURRENT_DATA>.
    // Kept as a string end to end so the queue payload stays one flat shape.
    currentData,
    authReplay,
    client,
  });

  return {
    itemId: id,
    status: "generating",
    workspaceNamespace: auth.freePlan ? (auth.sessionNamespace ?? null) : null,
  };
}

// The generation worker's work for one job: act as the caller, claim the item,
// generate, and record the outcome. Returns the HTTP status and body the
// worker endpoint answers with (2xx = handled; 5xx = let Cloud Tasks retry).
export async function runJob(job: GenerationJob): Promise<{ status: number; body: unknown }> {
  const {
    itemId,
    lang,
    prompt,
    modification,
    currentSrc,
    currentData,
    authReplay,
    client,
  } = job;

  let auth: Principal;
  try {
    auth = await principalFromReplay(authReplay);
  } catch (err) {
    // Auth could not be reconstructed — return 5xx so Cloud Tasks retries
    // (capped by the queue's maxAttempts) in case it was a transient blip.
    console.error("[generate-job] auth reconstruction failed", itemId, err);
    return { status: 500, body: { error: "auth_failed" } };
  }

  // The workspace this generation belongs to, as the same key actor() stamps on
  // events so the registry and the event stream agree. resolveFirstOutcome only
  // moves a row out of "pending", so calling it on every generation is safe:
  // all but the workspace's first attempt no-op.
  const workspaceKey = (actor(auth) as { session?: string }).session;

  // Claim the item before doing any work. A Cloud Tasks re-dispatch that lands
  // while the first attempt is still generating must NOT generate again — see
  // claimGeneration in resolvers.ts. The owner is per-ATTEMPT, not per-task,
  // because retries of one task carry the same task name and are exactly what
  // we are deduplicating.
  const attemptId = randomUUID();
  const claim = await claimGeneration({ auth, id: itemId, owner: attemptId });
  if (claim === "missing") {
    // Nothing to generate into; retrying will not conjure the item.
    console.error("[generate-job] item missing", itemId);
    return { status: 200, body: { status: "missing" } };
  }
  if (claim === "v2") {
    // A v2 job owns this item now; a legacy job must not write to it.
    console.warn("[generate-job] v1 job refused: item has a v2 job", itemId);
    return { status: 200, body: { status: "refused" } };
  }
  if (claim === "busy") {
    // Another attempt holds the lease and is still running. 2xx so the queue
    // stops retrying: if that attempt dies, the item stays "generating" and the
    // MCP staleness guard reports it — the same contract as exhausted retries.
    console.warn("[generate-job] duplicate dispatch ignored", itemId);
    return { status: 200, body: { status: "duplicate" } };
  }

  try {
    const result = await generateCodeForRequest({
      auth,
      prompt,
      language: lang,
      options: {},
      currentSrc: currentSrc ?? null,
      // The compiled record the enqueuer had, as serialized JSON. Parsed here
      // rather than in the prompt builder so a malformed payload costs the
      // CONTEXT and not the generation — it decorates the prompt, and a job that
      // predates the field (or a caller that sends none) simply has none.
      currentData: parseCurrentData(currentData),
      itemId,
      // Already on the job payload (see generation-queue.ts); passed down so the
      // language gate's funnel event can be qualified as MCP activity.
      client,
    });

    if (result.errors?.length || !result.taskId) {
      const message = result.errors?.map((e: any) => e.message).join("\n") || "No taskId returned";
      await setItemGenerationStatus({ auth, id: itemId, status: "failed", error: message });
      // Only the terminal failure is reported. The catch below returns 5xx so
      // Cloud Tasks retries, and emitting there would count one failure once per
      // attempt.
      // `app` mirrors the item_created/item_updated convention in resolvers.ts —
      // it is what lets the MCP-only report keep this event (isMcpOrigin).
      // `code` lets the report tell a correct out-of-scope refusal from a broken
      // generation without matching on prose (isOutOfScopeRefusal in funnel-digest.ts).
      const code = result.errors?.find((e: any) => e.code)?.code;
      emitEvent("item_generation_failed", { ...actor(auth), lang, app: client ?? "console", err: message, code });
      await resolveFirstOutcome(workspaceKey, "generation_failed");
      await releaseGeneration({ auth, id: itemId, owner: attemptId });
      // Handled outcome — 2xx so the queue does NOT retry.
      return { status: 200, body: { status: "failed", error: message } };
    }

    // Persist the new task + appended help, then mark ready. updateItem handles
    // the code-refresh + (free-plan) expiry bump on taskId change.
    // Everything from here to setItemGenerationStatus is time the MCP poll cannot
    // see: `item_generation_timing` has already been emitted, but the item does not
    // read "ready" until the status write below lands. Profiling the L0000
    // "multiply 10 and 21" case put that gap at 1,267-1,865ms across three runs —
    // larger than the code-generating model call itself (1,784ms), and entirely
    // round trips: ~8 serial Firestore/API calls at ~160ms warm apiece, several of
    // them re-reading a document another step just read or wrote.
    //
    // Timed per step rather than in aggregate because the aggregate is what we
    // already had, and it cannot say which call to remove.
    const tPost = Date.now();
    const existing = await getItem({ auth, id: itemId });
    const tGetItem = Date.now() - tPost;
    const updatedHelp = appendHelpEntry(existing?.help ?? "[]", modification, result.taskId);
    // If the pre-flight scope gate re-routed away from the client's pick, persist the corrected
    // language (and any composition upstreams) so MCP get_item reflects what was actually built.
    const rerouted = result.language && result.language !== lang;
    // The status flip rides INSIDE updateItem, fired the moment the taskId write
    // lands — see its onRenderable parameter. It used to run after updateItem
    // returned, which put a re-read and the version/billing writes (24ms + 308ms
    // measured) between "the item is renderable" and "anyone can see it". Those
    // writes still happen, still awaited, still before this handler returns 200.
    let statusMs = 0;
    let toReadyMs = 0;
    const tUpdate = Date.now();
    await updateItem({
      auth,
      id: itemId,
      taskId: result.taskId,
      // The AST the generator just posted, so updateItem need not fetch it back.
      taskCode: (result as any).taskCode,
      legacyLeaseOwner: attemptId,
      help: updatedHelp,
      source: "generation-job",
      label: modification,
      ...(rerouted ? { lang: result.language } : {}),
      ...(Array.isArray(result.upstreamLangs) ? { upstreamLangs: result.upstreamLangs } : {}),
      onRenderable: async () => {
        const tStatus = Date.now();
        await setItemGenerationStatus({ auth, id: itemId, status: "ready" });
        statusMs = Date.now() - tStatus;
        toReadyMs = Date.now() - tPost;
      },
    });
    const updateMs = Date.now() - tUpdate;
    // The item is visible as ready HERE. Everything after this line is bookkeeping
    // the caller never waits on, so it is deliberately outside the number below.
    console.log(
      `[generate-job] post rid=${result.rid ?? "-"} lang=L${lang} ` +
        `getItem=${tGetItem} updateItem=${updateMs} status=${statusMs} ` +
        // toReady is the number that matters: the item is VISIBLE here. The
        // trailing bookkeeping is in updateItem's total, deliberately not in this.
        `toReady=${toReadyMs} workerTotal=${Date.now() - tPost}`,
    );
    await resolveFirstOutcome(workspaceKey, "ok");
    await releaseGeneration({ auth, id: itemId, owner: attemptId });

    return { status: 200, body: { status: "ready", taskId: result.taskId } };
  } catch (err: any) {
    if (err instanceof LegacyJobRefused) {
      // The item gained a v2 job, or our lease was taken, while we generated:
      // our result is dropped and nothing was written. Handled, so 2xx.
      console.warn("[generate-job] v1 completion refused", itemId);
      await releaseGeneration({ auth, id: itemId, owner: attemptId });
      return { status: 200, body: { status: "refused" } };
    }
    // Unexpected error: leave the item "generating" and return 5xx so Cloud
    // Tasks retries (capped by the queue's maxAttempts). If every attempt fails
    // the item stays "generating" and the MCP staleness guard reports it failed
    // — avoids flapping the status to "failed" between retries.
    console.error("[generate-job] generation failed", itemId, err);
    // Release so the Cloud Tasks retry can claim it: this attempt is genuinely
    // over, and a retry is the point of returning 5xx here.
    await releaseGeneration({ auth, id: itemId, owner: attemptId });
    return { status: 500, body: { error: "generation_error" } };
  }
}
