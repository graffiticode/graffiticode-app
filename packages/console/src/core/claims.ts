// Moved from pages/api/resolvers.ts (Phase 1: untangle inside the console).
import { randomUUID } from "crypto";
import { getFirestore } from "../utils/db";
import { getApiTask } from "../lib/api";
import { FREE_PLAN_ITEM_TTL_MS } from "../lib/free-plan-context";
import { adoptSiblingWorkspace } from "../lib/workspace-adoption";
import { mintSessionToken, isSessionTokenConfigured } from "../lib/free-plan-session-token";
import { mintClaimToken } from "../lib/claim-token";
import { db } from "./db";
import type { AuthArg } from "./types";

/**
 * Look up a sibling item and adopt its workspace.
 *
 * The decision rules live in lib/workspace-adoption.ts so they can be asserted
 * without a database (this module opens Firestore at import time). Only the
 * lookup is here.
 *
 * Best-effort by design: an unknown, expired, or unreadable id leaves the caller
 * in their own workspace rather than failing the create. The id arrives as a hint
 * from a model, and a stale hint must never cost the user their item.
 */
export async function adoptWorkspaceFromSibling(
  auth: AuthArg,
  siblingId?: string,
): Promise<void> {
  if (!auth.freePlan || !siblingId) return;
  try {
    const doc = await db.doc(`users/${auth.uid}/items/${siblingId}`).get();
    if (!doc.exists) return;
    adoptSiblingWorkspace(auth, doc.data());
  } catch (err) {
    console.error("adoptWorkspaceFromSibling()", "ERROR", err);
  }
}

/**
 * Free-plan-only response fields: a signed workspace token the client sends back
 * so its next call stays in this workspace, and a claim token addressing this
 * workspace's items. Both derive from the EFFECTIVE namespace, i.e. after any
 * adoption above.
 *
 * Best-effort — a missing salt degrades to no tokens (the item still returns)
 * rather than failing the whole mutation, matching how the MCP server has always
 * treated an unconfigured salt.
 */
export async function freePlanTokens(
  auth: AuthArg,
): Promise<{ workspace?: string; claimToken?: string }> {
  if (!auth.freePlan || !auth.sessionNamespace || !isSessionTokenConfigured()) return {};
  const payload = {
    sessionNamespace: auth.sessionNamespace,
    sessionUuid: auth.sessionUuid || auth.sessionNamespace,
  };
  try {
    const [workspace, claimToken] = await Promise.all([
      mintSessionToken(payload),
      mintClaimToken(payload),
    ]);
    return { workspace, claimToken };
  } catch (err) {
    console.error("freePlanTokens()", "ERROR", err);
    return {};
  }
}

/**
 * Claim token for a specific workspace, without granting the workspace itself.
 * Used on read paths, where the reader may legitimately need to save an item it
 * can see but must not be enrolled into that item's workspace.
 */
export async function freePlanClaimTokenFor(
  auth: AuthArg,
  namespace: unknown,
): Promise<{ claimToken?: string }> {
  if (!auth.freePlan || typeof namespace !== "string" || !namespace) return {};
  if (!isSessionTokenConfigured()) return {};
  try {
    const claimToken = await mintClaimToken({
      sessionNamespace: namespace,
      sessionUuid: auth.sessionUuid || namespace,
    });
    return { claimToken };
  } catch (err) {
    console.error("freePlanClaimTokenFor()", "ERROR", err);
    return {};
  }
}

export function freePlanItemFields(auth: AuthArg, now = Date.now()) {
  return {
    freePlan: true,
    sessionNamespace: auth.sessionNamespace,
    expiresAt: now + FREE_PLAN_ITEM_TTL_MS,
  };
}

// Structured claim funnel event → Cloud Logging. Claims run in the console (not
// the MCP server), so failures never reach the mcp_tool stream and Firestore only
// records successes — this is the only signal the funnel report has for the
// anonymous→account (north-star #1) step. Best-effort; never breaks a claim.
/**
 * The claim link was OPENED — the step between "agent surfaced a claim link" and
 * "items transferred", which until now left no trace at all. Firestore only ever
 * recorded successful claims, so a link that was clicked and abandoned (or never
 * clicked) was indistinguishable from one that was never issued, and the middle
 * of the anonymous→account funnel could not be measured.
 *
 * `src` attributes the click to where the link was surfaced: "chat" (the
 * claim_url an agent prints) vs "footer" (the render-host's Claim button on
 * view_url). Those two convert very differently and the copy for each is tuned
 * separately, so a blended rate is not actionable.
 */
/**
 * The pre-sign-in claim funnel: three stages, one shape.
 *
 *   claim_view             the claim link was opened
 *   claim_auth_shown       the sign-in dialog was put in front of them
 *   claim_email_submitted  they entered an address and asked for a code
 *
 * All three fire before an account exists, so none can ride the authenticated
 * GraphQL path, and together they are the only view we have of WHERE a claim is
 * abandoned. That distinction is the point: a drop between view and auth_shown
 * is a page that failed to render something; a drop between auth_shown and
 * email_submitted is the ask itself being declined, which is a copy and
 * positioning problem and not a bug. Before these existed the two were
 * indistinguishable — establishing which one had happened meant cross-checking
 * the auth service's request log in a different GCP project, and only because
 * someone thought to look.
 *
 * `claim_email_submitted` NEVER carries the address. What the funnel needs to
 * know is that someone got that far; the address itself is the user's, is not
 * needed to answer the question, and would turn a counter into personal data.
 * The attempt is recorded even when the send subsequently fails, so a repeated
 * submission in one visit reads as a delivery problem rather than vanishing.
 */
export type ClaimStage = "view" | "auth_shown" | "email_submitted";

export const CLAIM_STAGE_EVENTS: Record<ClaimStage, string> = {
  view: "claim_view",
  auth_shown: "claim_auth_shown",
  email_submitted: "claim_email_submitted",
};

export function logClaimStage(fields: { stage: ClaimStage; session: string; src: string }) {
  try {
    console.log(JSON.stringify({
      ev: CLAIM_STAGE_EVENTS[fields.stage],
      t: new Date().toISOString(),
      session: fields.session,
      src: fields.src,
    }));
  } catch {
    // ignore
  }
}

/**
 * `claim_id` and `items` are what make a claim joinable to the rest of an item's
 * life. The MCP stream logs an item id at create and on every update; without the
 * ids here, a claim could only be matched to a session, so "this specific item was
 * made, revised twice, then claimed" was not a question the logs could answer.
 *
 * `items` carries the SOURCE (free-plan) ids — the ones the MCP server logged —
 * paired with the new ids in the account, since a claim copies rather than moves.
 * Capped: a claim of hundreds of items is a report, not an event.
 */
export const CLAIM_ITEMS_LOGGED_MAX = 50;

export function logClaimEvent(fields: {
  outcome: "ok" | "error";
  transferred?: number;
  session: string;
  err?: string;
  claimId?: string;
  items?: { from: string; to: string }[];
}) {
  try {
    console.log(JSON.stringify({
      ev: "claim",
      t: new Date().toISOString(),
      outcome: fields.outcome,
      session: fields.session,
      claim_id: fields.claimId,
      transferred: fields.transferred,
      items: fields.items?.slice(0, CLAIM_ITEMS_LOGGED_MAX),
      items_truncated:
        fields.items && fields.items.length > CLAIM_ITEMS_LOGGED_MAX ? fields.items.length : undefined,
      err: fields.err ? fields.err.slice(0, 300) : undefined,
    }));
  } catch {
    // ignore
  }
}

export async function claimFreePlanSession({
  auth,
  trialAuth,
  sessionNamespace,
  sessionUuid,
}: {
  auth: AuthArg;
  trialAuth: AuthArg;
  sessionNamespace: string;
  sessionUuid: string;
}) {
  const db = getFirestore();
  const now = Date.now();
  // One id for this whole claim, stamped on every doc it creates and logged with
  // it. Without it a claimed item can be traced back to a session but not to the
  // single act that moved it, and a session that claims four times (which the
  // logs show happening) collapses into one indistinguishable blur. Declared
  // outside the try so a failed claim is still identifiable in the logs.
  const claimId = randomUUID();

  try {
  const snapshot = await db
    .collection(`users/${trialAuth.uid}/items`)
    .where("freePlan", "==", true)
    .where("sessionNamespace", "==", sessionNamespace)
    .get();

  let transferred = 0;
  const items: { id: string; lang: string; created: number }[] = [];
  const claimedPairs: { from: string; to: string }[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (typeof data.expiresAt === "number" && data.expiresAt <= now) continue;

    // The lazy repost in getItem/getItems needs an accurate AST. The taskId on
    // the doc is authoritative (api.graffiticode.org owns the canonical task),
    // so prefer fetching code fresh through trial auth over trusting the
    // Firestore-stored copy, which can drift if updateItem misses a write.
    let code: any = data.code ?? null;
    if (data.taskId) {
      try {
        const apiTask = await getApiTask({ id: data.taskId, auth: trialAuth });
        const taskData = apiTask?.[0] || apiTask;
        if (taskData?.code !== undefined && taskData?.code !== null) {
          code = taskData.code;
        }
      } catch (err) {
        console.error("claimFreePlanSession(): failed to fetch task code", doc.id, err);
      }
    }

    const targetRef = db.collection(`users/${auth.uid}/items`).doc();
    const newId = targetRef.id;
    const timestamp = Date.now();

    const claimedItem: Record<string, any> = {
      ...data,
      id: newId,
      taskId: null, // triggers lazy repost in getItem/getItems under the new uid
      claimedFrom: sessionUuid,
      // The workspace this item actually came from — recorded explicitly rather
      // than left to be re-derived by hashing `claimedFrom`. Since workspace
      // adoption, the claim token's sessionUuid is whichever session happened to
      // present the token, which is not necessarily the session whose hash
      // equals the workspace the items live in. Re-hashing the uuid therefore
      // yields the wrong namespace and the funnel report loses the join back to
      // the originating session's events.
      claimedFromNamespace: sessionNamespace,
      // The claim that produced this doc — the same id logged on the claim event,
      // so an item in the console can be walked back to its MCP lifecycle.
      claimId,
      // Surface claimed items in the default /items view (which filters to
      // client=='console'). Provenance is preserved in `claimedFrom`.
      client: "console",
      created: timestamp,
      updated: timestamp,
    };
    delete claimedItem.freePlan;
    delete claimedItem.sessionNamespace;
    delete claimedItem.expiresAt;
    delete claimedItem.app; // legacy field; new items use `client` only
    if (code !== null) {
      claimedItem.code = code;
    } else {
      delete claimedItem.code;
    }

    await targetRef.set(claimedItem);
    transferred += 1;
    claimedPairs.push({ from: doc.id, to: newId });
    items.push({ id: newId, lang: String(data.lang || ""), created: timestamp });
  }

  items.sort((a, b) => b.created - a.created);
  logClaimEvent({ outcome: "ok", transferred, session: sessionNamespace, claimId, items: claimedPairs });
  return {
    transferred,
    sessionNamespace,
    items: items.map(({ id, lang }) => ({ id, lang })),
  };
  } catch (err: any) {
    logClaimEvent({ outcome: "error", session: sessionNamespace, claimId, err: String(err?.message ?? err) });
    throw err;
  }
}
