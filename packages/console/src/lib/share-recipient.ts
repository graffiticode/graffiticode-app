// Who a share goes to, as the owner typed it: an exact email or an exact
// account ID. There is no account search (AT-02: no account enumeration), so
// nothing here asks the server whether an account exists.
export type ShareRecipient = { kind: "email"; email: string } | { kind: "account"; accountId: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ACCOUNT_ID = /^(0x)?[0-9a-f]{40}$/i;

export function parseRecipient(text: string): ShareRecipient | null {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length <= 254 && EMAIL.test(t)) return { kind: "email", email: t.toLowerCase() };
  if (ACCOUNT_ID.test(t)) return { kind: "account", accountId: t.replace(/^0x/i, "").toLowerCase() };
  return null;
}

// The short form an owner sees for an account ID: first six and last four.
export const shortId = (accountId: string) => `${accountId.slice(0, 6)}…${accountId.slice(-4)}`;
