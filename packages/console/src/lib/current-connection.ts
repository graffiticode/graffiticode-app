// The current connection: which connection a user's saves write through, per
// (language, backend), system-wide rather than per item. Explicit choices live
// on the user doc as `currentConnections: { "<lang>:<backend>": connectionId }`;
// with no (still valid) choice, a sole candidate is used automatically.
import admin from "firebase-admin";
import { createHash } from "crypto";
import { getFirestore } from "../utils/db";
import {
  listConnections,
  listSharedConnections,
  policyEnabled,
  type Connection,
  type Permission,
} from "./policy-client";
import { CONNECTABLE_LANGS, backendForLang, normalizeLang } from "./connectable";

type Auth = { uid: string; token: string; freePlan?: boolean };

export type CandidateConnection = Connection & {
  shared: boolean;
  permissions: Permission[] | null;
  expiresAt: string | null;
};

export type CurrentConnection = {
  lang: string;
  backend: string;
  connectionId: string | null;
  // The resolved connection is the user's stored choice (not a sole-candidate default).
  explicit: boolean;
  candidates: CandidateConnection[];
};

const db = getFirestore();

// Per request: the auth object is built fresh for every request, so keying on it
// makes an item list do one pair of policy calls and one user-doc read, not one
// per item. A failure is memoized too, for the same reason.
const listings = new WeakMap<object, Promise<CandidateConnection[]>>();
const choices = new WeakMap<object, Promise<Record<string, string>>>();

function connectionsFor(auth: Auth): Promise<CandidateConnection[]> {
  let listing = listings.get(auth);
  if (!listing) {
    listing = policyEnabled()
      ? Promise.all([listConnections(auth.token), listSharedConnections(auth.token)]).then(([owned, shared]) => [
        ...owned.map(c => ({ ...c, ownerPermissions: c.ownerPermissions ?? null, shared: false, permissions: null, expiresAt: null })),
        ...shared.map(c => ({ ...c, shared: true })),
      ])
      // Connections are off here (no POLICY_URL): nothing to write through.
      : Promise.resolve([]);
    listings.set(auth, listing);
  }
  return listing;
}

function choicesFor(auth: Auth): Promise<Record<string, string>> {
  let read = choices.get(auth);
  if (!read) {
    read = db.doc(`users/${auth.uid}`).get().then(doc => doc.data()?.currentConnections || {});
    choices.set(auth, read);
  }
  return read;
}

const choiceKey = (lang: string, backend: string) => `${lang}:${backend}`;

// Active connections for the backend; a shared one only if its grant covers
// this language and has not ended; an owned one only if the owner hasn't
// excluded this language from their own use (null: everything). Never a
// system connection: it signs previews only, and policy refuses it for writes
// (system-connection).
const coversLang = (permissions: Permission[], lang: string) => permissions.some(p => normalizeLang(p.lang) === lang);
function candidatesFor(all: CandidateConnection[], lang: string, backend: string, now = Date.now()) {
  return all.filter(c =>
    c.status === "active" &&
    c.system !== true &&
    c.backend === backend &&
    (c.shared
      ? coversLang(c.permissions || [], lang) && !(c.expiresAt && Date.parse(c.expiresAt) <= now)
      : !c.ownerPermissions || coversLang(c.ownerPermissions, lang)));
}

// Null for free-plan callers and languages that cannot use a connection.
// Throws when policy cannot be reached; callers that only display decide how
// to degrade (currentConnectionId).
export async function resolveCurrentConnection({ auth, lang }: { auth: Auth; lang: unknown }): Promise<CurrentConnection | null> {
  const backend = backendForLang(lang);
  if (auth.freePlan || !backend) return null;
  const key = normalizeLang(lang);
  const [all, chosen] = await Promise.all([connectionsFor(auth), choicesFor(auth)]);
  const candidates = candidatesFor(all, key, backend);
  const choice = chosen[choiceKey(key, backend)];
  const explicit = Boolean(choice && candidates.some(c => c.connectionId === choice));
  const connectionId = explicit ? choice : candidates.length === 1 ? candidates[0].connectionId : null;
  return { lang: key, backend, connectionId, explicit, candidates };
}

// For views: the item's current connection, or null when there is none or it
// cannot be determined right now.
export async function currentConnectionId({ auth, lang }: { auth: Auth; lang: unknown }): Promise<string | null> {
  try {
    return (await resolveCurrentConnection({ auth, lang }))?.connectionId ?? null;
  } catch (err) {
    console.error("currentConnectionId(): could not resolve", normalizeLang(lang), (err as Error)?.message);
    return null;
  }
}

export async function listCurrentConnections({ auth }: { auth: Auth }): Promise<CurrentConnection[]> {
  if (auth.freePlan) return [];
  const resolved = await Promise.all(Object.keys(CONNECTABLE_LANGS).map(lang => resolveCurrentConnection({ auth, lang })));
  return resolved.filter((c): c is CurrentConnection => c !== null);
}

// Stores (or with null, clears) the explicit choice for a language. The choice
// must be one of the language's candidates. Existing publications are untouched.
export async function setCurrentConnection({ auth, lang, connectionId }: { auth: Auth; lang: string; connectionId: string | null }) {
  if (auth.freePlan) {
    throw new Error("Connections require a full account.");
  }
  const backend = backendForLang(lang);
  if (!backend) {
    throw new Error(`L${normalizeLang(lang)} does not use connections.`);
  }
  const key = normalizeLang(lang);
  if (connectionId) {
    const candidates = candidatesFor(await connectionsFor(auth), key, backend);
    if (!candidates.some(c => c.connectionId === connectionId)) {
      throw new Error(`That connection is not one of your active ${backend} connections for L${key}.`);
    }
  }
  await db.doc(`users/${auth.uid}`).set({
    currentConnections: { [choiceKey(key, backend)]: connectionId || admin.firestore.FieldValue.delete() },
  }, { merge: true });
  choices.delete(auth);
  return listCurrentConnections({ auth });
}

// The api's idempotency key for writing one program version of one item through
// one connection. Deterministic, so a re-save or a retry never writes twice.
// Hashed because taskIds can contain `+`, which the api's key rule rejects.
export const saveWriteKey = ({ itemId, taskId, connectionId }: { itemId: string; taskId: string; connectionId: string }) =>
  `save:${createHash("sha256").update(`${itemId}|${taskId}|${connectionId}`).digest("hex")}`;
