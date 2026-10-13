// Caller identity for REST API routes.
//
// The /api/payments/* routes used to take `userId` from the query string and
// trust it, which made a uid a bearer credential: anyone holding one could read
// another account's plan, invoices and card details, and — through the POST
// routes — cancel their subscription or change their plan against the card on
// file. This is the shared replacement.
//
// Same contract as the GraphQL endpoint's authenticate() (src/pages/api/index.ts):
// a Firebase ID token first, falling back to an api key, so both credentials
// work everywhere. Modelled on the existing route-level pattern in
// src/pages/api/linked-emails/check.ts.
import type { NextApiRequest } from "next";
import { client } from "./auth";
import { getCredentialsForApiKey } from "./api-credentials";

/**
 * Resolve the calling user from the Authorization header.
 *
 * Returns null rather than throwing so callers can answer 401 without a
 * try/catch at every site. Never reads `userId` from the request — a route that
 * accepted one alongside the token would just be re-opening the hole.
 */
export async function requireUser(
  req: NextApiRequest,
): Promise<{ uid: string } | null> {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  // In-repo callers send the raw token (see use-linked-emails.ts), but accept a
  // "Bearer " prefix too — it costs nothing and is what most clients send.
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  try {
    const { uid } = await client.verifyToken(token);
    return { uid };
  } catch {
    // Not an ID token — try it as an api key.
  }

  try {
    const { uid } = await getCredentialsForApiKey(token);
    return { uid };
  } catch {
    return null;
  }
}
