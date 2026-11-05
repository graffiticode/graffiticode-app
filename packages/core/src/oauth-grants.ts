// One-time grants that carry an OAuth consent from the console to the MCP
// server's token endpoint.
//
// The consent page used to hand the MCP server a Google ID token, which only
// worked for Google-linked accounts (most accounts sign in by email or wallet)
// and put a live credential in the browser's hands on its way through. Now the
// console mints the user's Firebase session server-side (from the auth
// service's SSO refresh token in the HttpOnly gc_sso cookie), stores it here
// behind a random code, and gives the browser only that code. The MCP server
// redeems the code once, server-to-server through this module, when the client
// exchanges its authorization code.
//
// A grant is bound to the MCP server's internal OAuth `state` for the
// authorization it answers, expires with the authorization code (10 minutes),
// and is deleted on its first redemption whatever the outcome. Only a hash of
// the code is stored, so reading the collection does not yield usable codes.
import { createHash, randomBytes } from "crypto";
import admin from "firebase-admin";
import { db } from "./db.js";

export const OAUTH_GRANT_TTL_MS = 10 * 60_000;
const COLLECTION = "oauth-grants";

const docId = (code: string) => createHash("sha256").update(code).digest("hex");

export type OAuthGrant = { uid: string; firebaseCustomToken: string };

export type OAuthGrantFailure = "unknown" | "expired" | "state_mismatch";

export class OAuthGrantError extends Error {
  constructor(readonly reason: OAuthGrantFailure) {
    super(`OAuth grant refused: ${reason}`);
    this.name = "OAuthGrantError";
  }
}

/**
 * The `uid` claim of a Firebase custom token. The caller got the token straight
 * from the auth service, so this reads the claim without verifying the
 * signature; it exists to check the token names the account that consented.
 */
export function customTokenUid(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.uid === "string" && payload.uid ? payload.uid : null;
  } catch {
    return null;
  }
}

export async function createOAuthGrant(
  { state, uid, firebaseCustomToken }: { state: string; uid: string; firebaseCustomToken: string },
  now = Date.now(),
): Promise<string> {
  if (!state || !uid || !firebaseCustomToken) throw new Error("an OAuth grant needs state, uid and a custom token");
  const code = randomBytes(32).toString("base64url");
  await db().doc(`${COLLECTION}/${docId(code)}`).create({
    state,
    uid,
    firebaseCustomToken,
    createdAt: now,
    expiresAt: now + OAUTH_GRANT_TTL_MS,
    // For a Firestore TTL policy on this collection, which only sweeps grants
    // nobody redeemed; redemption deletes the rest.
    expireAt: admin.firestore.Timestamp.fromMillis(now + OAUTH_GRANT_TTL_MS),
  });
  return code;
}

/**
 * Redeem a grant for the authorization it was minted for. Single use: the grant
 * is deleted in the same transaction that reads it, including when it is
 * refused, so a code that fails once can never be tried again.
 */
export async function redeemOAuthGrant(
  { code, state }: { code: string; state: string },
  now = Date.now(),
): Promise<OAuthGrant> {
  if (!code || !state) throw new OAuthGrantError("unknown");
  const ref = db().doc(`${COLLECTION}/${docId(code)}`);
  // Decide inside the transaction, throw outside it: throwing inside would roll
  // back the delete.
  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { reason: "unknown" as const };
    tx.delete(ref);
    const grant = snap.data() as { state?: string; uid?: string; firebaseCustomToken?: string; expiresAt?: number };
    if (typeof grant.expiresAt !== "number" || now > grant.expiresAt) return { reason: "expired" as const };
    if (grant.state !== state) return { reason: "state_mismatch" as const };
    if (!grant.uid || !grant.firebaseCustomToken) return { reason: "unknown" as const };
    return { grant: { uid: grant.uid, firebaseCustomToken: grant.firebaseCustomToken } };
  });
  if ("reason" in outcome) throw new OAuthGrantError(outcome.reason);
  return outcome.grant;
}
