// Item authority for Graffiticode's Policy service (graffiticode repo,
// docs/c5-l0013-commands-plan.md decision 3): who owns one console item, and
// whether it is public, decided by this console's own item store. Policy asks
// it before an L0013 capture of the item is admitted, reserved, minted or
// executed: a private item may be captured only by its owner, a public one
// also under the dated public-capture exception.
//
//   POST /api/internal/item-authority { itemId }
//     { exists: false }
//     { exists: true, ownerUid, isPublic, taskId, lang }
//     { ambiguous: true }      the id is held under two owners
//
// Only Policy's own service account may ask: its Google ID token, issued for
// this route's audience, in `Authorization: Bearer`. The route says nothing
// else to anyone, and never more than these fields.
//
// Items live at users/{ownerUid}/items/{id} with an `id` field equal to the
// doc id, so a collection-group query on `id` finds an item without knowing
// its owner (the COLLECTION_GROUP index on items.id, firestore.indexes.json).

export const ITEM_AUTHORITY_PATH = "/api/internal/item-authority";
export const DEFAULT_AUDIENCE = `https://console.graffiticode.org${ITEM_AUTHORITY_PATH}`;
export const DEFAULT_CALLERS = ["policy-run@graffiticode.iam.gserviceaccount.com"];
// An item id as Policy's scopes name one.
export const ITEM_ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

// `consistent`: the doc's own id is the item's (absent: true).
export type ItemRecord = { ownerUid: string | null; isPublic: boolean; taskId: string | null; lang: string | null; consistent?: boolean };
export type ItemAnswer =
  | { exists: false }
  | { ambiguous: true }
  | { exists: true; ownerUid: string; isPublic: boolean; taskId: string | null; lang: string | null };

export class CallerRefused extends Error {}

// The callers allowed, from ITEM_AUTHORITY_CALLERS (comma-separated service
// account emails), or Policy's own account.
export const parseCallers = (value: string | undefined): string[] => {
  const list = (value ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_CALLERS;
};

// The verified caller's email, or CallerRefused. `verifyIdToken` checks the
// signature, expiry and audience (google-auth-library's OAuth2Client) and
// returns the token's payload.
export const verifyCaller = async ({ authorization, audience, callers, verifyIdToken }: {
  authorization: string | undefined;
  audience: string;
  callers: string[];
  verifyIdToken: (args: { idToken: string; audience: string }) => Promise<{ iss?: string; email?: string; email_verified?: boolean; aud?: unknown } | undefined>;
}): Promise<string> => {
  const match = /^Bearer\s+(\S+)$/.exec(authorization ?? "");
  if (!match) throw new CallerRefused("no bearer token");
  let payload;
  try {
    payload = await verifyIdToken({ idToken: match[1], audience });
  } catch {
    throw new CallerRefused("token did not verify");
  }
  if (!payload || !GOOGLE_ISSUERS.has(payload.iss ?? "") || payload.email_verified !== true || payload.aud !== audience) {
    throw new CallerRefused("not a verified Google service account token for this route");
  }
  if (typeof payload.email !== "string" || !callers.includes(payload.email)) throw new CallerRefused("caller not allowed");
  return payload.email;
};

// The answer for one item, from the records `findItems` returns for its id
// (at most two are needed to tell one owner from several). Only exactly one
// consistent record is an answer: any record whose own id differs from the
// item's, or a second record, makes ownership ambiguous, since what lies past
// the query's limit is unknown.
export const itemAuthorityAnswer = async ({ itemId, findItems }: {
  itemId: string;
  findItems: (itemId: string) => Promise<ItemRecord[]>;
}): Promise<ItemAnswer> => {
  const found = await findItems(itemId);
  if (found.length === 0) return { exists: false };
  if (found.some(r => r.consistent === false)) return { ambiguous: true };
  const owners = new Set(found.map(r => r.ownerUid));
  if (found.length > 1 || owners.size > 1) return { ambiguous: true };
  const [item] = found;
  // An item with no owner in its path can't be authorized: as unknown.
  if (!item.ownerUid) return { exists: false };
  return { exists: true, ownerUid: item.ownerUid, isPublic: item.isPublic === true, taskId: item.taskId ?? null, lang: item.lang ?? null };
};

// The console's store: the items docs whose `id` field is the item's, under
// any owner, at most two, each marked whether its own doc id agrees. None is
// dropped: a disagreeing doc is evidence the id isn't uniquely held.
export const firestoreItems = (db: any) => async (itemId: string): Promise<ItemRecord[]> => {
  const snap = await db.collectionGroup("items").where("id", "==", itemId).limit(2).get();
  return snap.docs.map((d: any) => {
    const data = d.data() ?? {};
    return {
      ownerUid: d.ref.parent?.parent?.id ?? null,
      isPublic: data.isPublic === true,
      taskId: typeof data.taskId === "string" ? data.taskId : null,
      lang: typeof data.lang === "string" ? data.lang : null,
      consistent: d.id === itemId,
    };
  });
};
