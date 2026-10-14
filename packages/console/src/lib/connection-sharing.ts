// Identity for sharing a connection. The owner names a person by exact email
// or exact account ID; nothing searches or lists accounts (AT-02: no account
// enumeration). An email is always shared as a hash, pending until someone
// signs in with that email verified and claims it, so the owner sees the same
// result whether or not an account has that email. Emails are never logged
// (and never put in a URL). An account ID is shared directly, once it is
// confirmed to exist: IDs are not secret, and a typo should fail rather than
// wait forever.
import { createHash } from "crypto";

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org";
const INTERNAL_API_KEY = process.env.AUTH_SERVICE_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || "";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const emailHash = (email: string) => createHash("sha256").update(normalizeEmail(email)).digest("hex");

export const isEmail = (email: unknown): email is string =>
  typeof email === "string" && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

// An account ID is the account's 40-hex address, written with or without 0x.
// Stored (and granted) lowercase, without the prefix.
export const normalizeAccountId = (id: string) => id.trim().replace(/^0x/i, "").toLowerCase();
export const isAccountId = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{40}$/.test(normalizeAccountId(id));

// Whether an account with this ID exists. Throws when the auth service cannot
// answer, so a share by ID fails visibly instead of granting to nobody.
export async function accountExists(accountId: string): Promise<boolean> {
  if (!INTERNAL_API_KEY) throw new Error("Account lookup is not configured on this server.");
  const res = await fetch(
    `${AUTH_SERVICE_URL.replace(/\/$/, "")}/authenticate/ethereum/internal/exists/${normalizeAccountId(accountId)}`,
    { headers: { "X-Internal-API-Key": INTERNAL_API_KEY } },
  );
  if (!res.ok) throw new Error("Could not look up that account right now. Try again.");
  const body = await res.json();
  return body?.status === "success" && body.data?.exists === true;
}

// A short, recognizable label for an account ID in the owner's share list.
export const accountLabel = (accountId: string) => {
  const id = normalizeAccountId(accountId);
  return `account ${id.slice(0, 6)}…${id.slice(-4)}`;
};

// Hashes of the signed-in user's own verified emails, for claiming pending
// shares. Empty when the auth service cannot be reached.
export async function verifiedEmailHashes(userToken: string): Promise<string[]> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL.replace(/\/$/, "")}/linked-emails`, { headers: { Authorization: userToken } });
    if (!res.ok) return [];
    const body = await res.json();
    const emails: any[] = body?.data?.emails || [];
    return [...new Set(emails.filter(e => e?.verifiedAt && typeof e.email === "string").map(e => emailHash(e.email)))].slice(0, 20);
  } catch {
    return [];
  }
}

// The pending share for an email: always by hash, never resolved to an
// account here. The owner's own verified emails are refused, which tells them
// only about themselves.
export function emailShare(email: string, ownerEmailHashes: string[]) {
  const recipientEmailHash = emailHash(email);
  if (ownerEmailHashes.includes(recipientEmailHash)) throw new Error("You already own this connection.");
  return { recipientEmailHash, recipientLabel: normalizeEmail(email) };
}

