// Accounts as sharing names them. Sharing takes an exact email or account ID;
// there is no search over accounts (AT-02: no account enumeration). The owner
// sees a recipient only by profile name or short ID, never an email or any
// other profile field.
import { getFirestore } from "@graffiticode-app/core/utils/db/index";
import { normalizeAccountId } from "./connection-sharing";

// The form of a profile name kept as users/{uid}.nameLower wherever `name` is
// written: trimmed, lowercased, runs of whitespace collapsed to one space.
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

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
