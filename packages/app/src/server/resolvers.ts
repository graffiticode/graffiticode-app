import { getFirestore } from "./db";
import { getApiTask } from "./api";
import type { Auth } from "@graffiticode/auth-react/server";

export type ResolvedItem = {
  id: string;
  name?: string;
  taskId?: string;
  lang?: string;
  isPublic: boolean;
  ownerUid?: string;
  code?: any;
};

// Find an item by its id across all owners. Item docs live under
// users/{ownerUid}/items/{id} and store an `id` field equal to their doc id, so
// a collectionGroup query resolves any item without knowing the owner — and
// without requiring the viewer to be signed in or to own it. (Needs admin
// credentials AND an explicit COLLECTION_GROUP single-field index on `items.id`:
// collection-group queries are NOT covered by Firestore's automatic single-field
// indexes, so without it this query throws FAILED_PRECONDITION and every bare
// item id fails to resolve. The index is declared in firestore.indexes.json.)
export async function findItemById(id: string): Promise<ResolvedItem | null> {
  const db = getFirestore();
  const snap = await db.collectionGroup("items").where("id", "==", id).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data() as any;
  const ownerUid = doc.ref.parent.parent?.id;
  return {
    id,
    name: data.name,
    taskId: data.taskId,
    lang: data.lang,
    isPublic: !!data.isPublic,
    ownerUid,
    code: data.code,
  };
}

export type FormTarget = { taskId: string; itemId?: string; ownerUid?: string };

// Graffiticode form/task ids are base64(JSON {"taskIds":[...]}). Item ids are
// bare Firestore doc ids. Detect the form id by syntax so we only do a DB
// lookup for what's actually an item id.
function looksLikeFormId(id: string): boolean {
  try {
    const json = Buffer.from(id, "base64").toString("utf-8");
    const obj = JSON.parse(json);
    return !!obj && Array.isArray(obj.taskIds);
  } catch {
    return false;
  }
}

// The "+" task-chain separator can survive the /form/{id} URL round-trip as the
// percent-encoded "%2B" (a raw "+" in a path comes back encoded). Decode it so
// the segments parse and the head splits — base64url segments contain no other
// percent sequences, so this only canonicalizes the separator.
function normalizeChainId(id: string): string {
  if (!id.includes("%")) return id;
  try {
    return decodeURIComponent(id);
  } catch {
    return id.replace(/%2[Bb]/g, "+");
  }
}

// Resolve a /form/{id} path segment to a renderable task id. A base64 form id
// is passed straight through; a bare item id is resolved via the console DB —
// first directly under the signed-in user's account (their own items), then by
// cross-user lookup for shared/public items.
export async function resolveFormTarget({
  auth,
  id,
}: {
  auth: Auth | null;
  id: string;
}): Promise<FormTarget> {
  id = normalizeChainId(id);
  if (looksLikeFormId(id)) {
    return { taskId: id };
  }

  if (auth) {
    try {
      const db = getFirestore();
      const doc = await db.doc(`users/${auth.uid}/items/${id}`).get();
      if (doc.exists) {
        const data = doc.data() as any;
        if (data?.taskId) {
          return { taskId: data.taskId, itemId: id, ownerUid: auth.uid };
        }
      }
    } catch (err) {
      console.error("resolveFormTarget(): direct item lookup failed", id, err);
    }
  }

  try {
    const item = await findItemById(id);
    if (item?.taskId) {
      return { taskId: item.taskId, itemId: id, ownerUid: item.ownerUid };
    }
  } catch (err) {
    console.error("resolveFormTarget(): collectionGroup item lookup failed", id, err);
  }

  return { taskId: id };
}

export type OwnerInfo = { uid?: string; email?: string };

export type AccessResult =
  | { allowed: true; task: any }
  | { allowed: false; reason: "locked" | "not-found"; owner?: OwnerInfo; detail?: string };

// Access is delegated to the api store: fetching the task with the viewer's
// credentials succeeds when the task is public, the viewer is the owner, or the
// viewer's uid is in the task acls; otherwise the api returns 401/403, which we
// surface as "locked" so the route can render a request-access view instead of
// a broken iframe.
export async function evaluateAccess({
  viewerAuth,
  taskId,
}: {
  viewerAuth: Auth | null;
  taskId: string;
}): Promise<AccessResult> {
  try {
    const task = await getApiTask({ auth: viewerAuth ?? undefined, id: taskId });
    console.log("[evaluateAccess] allowed", { taskId, authed: !!viewerAuth });
    return { allowed: true, task };
  } catch (err: any) {
    const code = err?.statusCode ?? err?.status;
    const detail = `status=${code ?? "?"} ${err?.message ?? ""}`.trim();
    console.error("[evaluateAccess] denied", { taskId, authed: !!viewerAuth, detail });
    // 401/403 mean the task exists but the viewer lacks access (locked). The
    // api returns 400 for ids that don't resolve, which we treat as not-found
    // alongside 404. Anything else fails closed to locked.
    if (code === 401 || code === 403) {
      return { allowed: false, reason: "locked", owner: extractOwner(err?.responseBody), detail };
    }
    if (code === 400 || code === 404) {
      return { allowed: false, reason: "not-found", detail };
    }
    return { allowed: false, reason: "locked", detail };
  }
}

function extractOwner(body: any): OwnerInfo | undefined {
  if (!body || typeof body !== "object") return undefined;
  const owner = body.owner ?? body.data?.owner;
  if (!owner) return undefined;
  return { uid: owner.uid ?? owner.id, email: owner.email };
}
