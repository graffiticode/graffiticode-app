// Moved from pages/api/index.ts (startCodeGeneration) — Phase 1: untangle
// inside the console. Since 2026-10-17 it reserves generation protocol v2 jobs
// only (generation-jobs.ts); the v1 producer and worker are retired.

import { FreePlanError } from "./lib/free-plan-context.js";
import { hashUid, langKey } from "./lib/funnel-events.js";
import { isInternalRequest } from "./lib/funnel-exclusions.js";
import { registerFirstCreateAttempt, resolveFirstOutcome } from "./lib/workspace-registry.js";
import { resolveAuth } from "./auth.js";
import { adoptWorkspaceFromSibling } from "./claims.js";
import { reserveGeneration } from "./generation-jobs.js";
import { assertItemCreateAllowed } from "./access.js";
import type { Operation } from "./operations.js";

// startCodeGeneration: reserve a v2 job (with the item shell, for a create) and
// wake the console's worker. Serves create_item and update_item.
// `trusted` carries what only an in-process caller may set: the restricted MCP
// operation (core/operations.ts). It is a separate argument, never read from
// `args`, because GraphQL and REST hand their request input straight to `args`.
export async function startGeneration(ctx: any, args: any, trusted: { operation?: Operation | null } = {}) {
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
  try {
    // The create gate, as createItem runs it; a revision has no gate here.
    if (!itemId) await assertItemCreateAllowed(auth, lang);
    const reserved = await reserveGeneration({
      auth, itemId, lang, name, client, prompt, modification, currentSrc, currentData,
      ...(baseTaskId !== undefined ? { baseTaskId } : {}),
      sessionNamespace: ctx.sessionNamespace, sessionUuid: ctx.sessionUuid, workspaceKey, idempotency,
      operation: trusted.operation ?? null,
    });
    return {
      itemId: reserved.itemId,
      status: "generating",
      workspaceNamespace: auth.freePlan ? (auth.sessionNamespace ?? null) : null,
    };
  } catch (err) {
    if (itemId) throw err;
    // The synchronous half of firstOutcome: a refused create (the quota gate,
    // say) is still the workspace's first attempt, and leaves no item row.
    await resolveFirstOutcome(workspaceKey, err instanceof FreePlanError ? "wall" : "error");
    // createItem's wording, which callers have always seen.
    const wrapped = new Error(`Failed to create item: ${(err as Error).message}`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
}
