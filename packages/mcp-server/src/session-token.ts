import { SignJWT } from "jose";
import { deriveSessionNamespace } from "./claim-token.js";

/**
 * Mints the signed free-plan session token presented as X-Free-Plan-Session.
 *
 * Why this exists: the console cannot distinguish a session id we generated from
 * one a caller invented, because a raw uuid in that header is self-asserted.
 * That is what makes per-session limits bypassable — mint a fresh uuid, get a
 * fresh everything. A signed token can only come from us, so the console can
 * refuse anything else (FREE_PLAN_REQUIRE_SIGNED_SESSION), which in turn makes
 * the MCP `initialize` endpoint the single door into free-plan access and
 * therefore the single place worth rate-limiting at the edge.
 *
 * Contract — must match console/src/lib/free-plan-session-token.ts:
 * - Algorithm: HS256
 * - Secret:    FREE_PLAN_NAMESPACE_SALT (UTF-8 bytes)
 * - Audience:  "graffiticode-session"
 * - Expiry:    48h (matches the console's free-plan item TTL)
 * - Payload:   { sessionNamespace, sessionUuid }
 *
 * This is the ONLY signing contract still duplicated across the two repos.
 * Claim tokens used to be minted here too and no longer are — the console owns
 * those, because only it knows a call's effective workspace. This one has to
 * live here: the very first request of a session needs a signed token, and by
 * definition there has been no console round trip yet to supply one. After that
 * first call the console's returned workspace handle takes over.
 */

const AUDIENCE = "graffiticode-session";
const EXPIRES_IN = "48h";

const salt = process.env.FREE_PLAN_NAMESPACE_SALT || "";
const secret = salt ? new TextEncoder().encode(salt) : null;

if (!salt) {
  console.warn(
    "[session-token] FREE_PLAN_NAMESPACE_SALT is not set; free-plan sessions will present a raw " +
      "uuid. That still works while the console accepts unsigned sessions, and stops working once " +
      "FREE_PLAN_REQUIRE_SIGNED_SESSION is enabled there."
  );
}

/**
 * Returns a signed token for the session, or null when the salt is unconfigured
 * so the caller can fall back to the raw uuid rather than failing the session
 * outright. That degradation is deliberate for local development; in production
 * the console's require-signed switch is what closes the door.
 */
export async function mintSessionToken(sessionUuid: string): Promise<string | null> {
  if (!secret) return null;
  return await new SignJWT({
    sessionNamespace: deriveSessionNamespace(sessionUuid),
    sessionUuid,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(secret);
}
