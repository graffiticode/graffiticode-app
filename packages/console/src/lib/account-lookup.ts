// Finding an account to share with (a connection or an item). The owner types
// part of a profile name, a linked email or an account ID, and every account
// with an identifier containing that text is offered (up to MAX_MATCHES). A
// match carries the account ID and a display name — never an email or any
// other profile field; emails are matched on the auth service and only uids
// come back. The query itself is never logged, only counts.
import { getFirestore } from "../utils/db";
import { accountForEmail, accountsForEmailFragment, isEmail, normalizeAccountId } from "./connection-sharing";

// The form of a profile name that lookups match on: trimmed, lowercased, runs
// of whitespace collapsed to one space. Stored as users/{uid}.nameLower
// wherever `name` is written.
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export const MIN_QUERY_LENGTH = 2;
export const MAX_MATCHES = 10;
// Hex fragments shorter than this would match almost every account ID, so ID
// matching starts at four characters.
const MIN_ID_FRAGMENT = 4;

export type MatchedBy = "email" | "name" | "id";

export type AccountMatch = {
  accountId: string;
  name: string;
  shortId: string;
  matchedBy: MatchedBy;
};

// A short, recognizable form of an account ID: first six and last four.
export const shortAccountId = (accountId: string) => {
  const id = normalizeAccountId(accountId);
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
};

// The one account no one shares with: the shared trial account. (The eval
// account is a real, shareable account.)
const unshareableUids = () => new Set([process.env.FREE_PLAN_UID].filter(Boolean) as string[]);
export const isSystemAccount = (uid: string) => unshareableUids().has(uid);

// The account's profile name, if it has one.
export async function profileName(uid: string): Promise<string | null> {
  const doc = await getFirestore().collection("users").doc(uid).get();
  const name = doc.exists ? doc.data()?.name : null;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

// How well an identifier matches: exact, then prefix, then anywhere inside.
const EXACT = 0;
const PREFIX = 1;
const SUBSTRING = 2;
const rankOf = (value: string, fragment: string): number | null =>
  value === fragment ? EXACT : value.startsWith(fragment) ? PREFIX : value.includes(fragment) ? SUBSTRING : null;
// At equal rank, a name match reads best, then an email, then an ID.
const KIND_ORDER: Record<MatchedBy, number> = { name: 0, email: 1, id: 2 };

type Candidate = { uid: string; name: string | null; rank: number; matchedBy: MatchedBy };

export async function findAccounts(callerUid: string, rawQuery: string): Promise<AccountMatch[]> {
  const query = typeof rawQuery === "string" ? normalizeName(rawQuery) : "";
  if (query.length < MIN_QUERY_LENGTH) return [];
  const idFragment = normalizeAccountId(query);
  const matchIds = /^[0-9a-f]+$/.test(idFragment) && idFragment.length >= MIN_ID_FRAGMENT;
  const excluded = unshareableUids();
  excluded.add(callerUid);

  const candidates = new Map<string, Candidate>();
  const offer = (uid: string, name: string | null, rank: number, matchedBy: MatchedBy) => {
    if (!uid || excluded.has(uid)) return;
    const prev = candidates.get(uid);
    const better = !prev || rank < prev.rank || (rank === prev.rank && KIND_ORDER[matchedBy] < KIND_ORDER[prev.matchedBy]);
    candidates.set(uid, {
      uid,
      name: name ?? prev?.name ?? null,
      rank: better ? rank : prev.rank,
      matchedBy: better ? matchedBy : prev.matchedBy,
    });
  };

  // Emails are matched on the auth service; an exact email also resolves
  // through the exact lookup so it ranks first.
  const [emailUids, exactEmailUid, usersSnap] = await Promise.all([
    accountsForEmailFragment(query),
    isEmail(query) ? accountForEmail(query) : Promise.resolve(null),
    // Every profile's name, filtered here. The users collection is small; at
    // scale this needs a search index (e.g. name n-grams) instead of a scan.
    getFirestore().collection("users").select("name", "nameLower").get(),
  ]);

  const names = new Map<string, string | null>();
  for (const doc of usersSnap.docs) {
    const data = doc.data() || {};
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
    names.set(doc.id, name);
    const nameLower = typeof data.nameLower === "string" ? data.nameLower : name ? normalizeName(name) : "";
    const nameRank = nameLower ? rankOf(nameLower, query) : null;
    if (nameRank !== null) offer(doc.id, name, nameRank, "name");
    if (matchIds) {
      const idRank = rankOf(doc.id.toLowerCase(), idFragment);
      if (idRank !== null) offer(doc.id, name, idRank, "id");
    }
  }
  // A uid found by email with no users doc is still a real account (auth holds
  // the link); it is listed under its short ID.
  for (const uid of emailUids) offer(uid, names.get(uid) ?? null, SUBSTRING, "email");
  if (exactEmailUid) offer(exactEmailUid, names.get(exactEmailUid) ?? null, EXACT, "email");

  const ranked = [...candidates.values()]
    .map(c => ({ ...c, label: c.name || shortAccountId(c.uid) }))
    .sort((a, b) =>
      a.rank - b.rank ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      a.uid.localeCompare(b.uid))
    .slice(0, MAX_MATCHES);

  console.log(`[findAccounts] users=${usersSnap.size} emailUids=${emailUids.length} candidates=${candidates.size} matches=${ranked.length}`);
  return ranked.map(c => ({ accountId: c.uid, name: c.label, shortId: shortAccountId(c.uid), matchedBy: c.matchedBy }));
}
