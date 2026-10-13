import crypto from "crypto";

/**
 * Session-namespace derivation for telemetry.
 *
 * Claim tokens are NO LONGER minted here — the console mints them, because only
 * the console knows which workspace a call actually resolved to. This file kept
 * a hand-mirrored copy of the console's HS256 signing parameters; that copy is
 * gone, and with it the risk of the two drifting apart.
 *
 * What remains is the hash used to label events. It must match the console's
 * `deriveSessionNamespace` so the funnel report can join MCP events to console
 * items on `sessionNamespace`.
 */

const salt = process.env.FREE_PLAN_NAMESPACE_SALT || "";

if (!salt) {
  console.warn(
    "[claim-token] FREE_PLAN_NAMESPACE_SALT is not set; free-plan event sessions will not " +
      "join to console items. Set the env var (mounted from Secret Manager in production)."
  );
}

export function deriveSessionNamespace(sessionUuid: string): string {
  return crypto.createHash("sha256").update(`${salt}:${sessionUuid}`).digest("hex");
}

/**
 * The namespace to label an event with, given whatever we're currently
 * presenting as the free-plan session id.
 *
 * That value is a raw transport uuid at first and a signed workspace token after
 * the console hands one back. Hashing the token would produce a value unrelated
 * to the workspace it names, silently breaking the funnel report's join — so
 * read the namespace out of the token instead. Signature verification is
 * deliberately skipped: this is telemetry labelling, not an authorization
 * decision, and the token has already been accepted by the console on the round
 * trip that produced it.
 */
export function namespaceForSession(sessionId: string): string {
  const parts = sessionId.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (typeof payload?.sessionNamespace === "string" && payload.sessionNamespace) {
        return payload.sessionNamespace;
      }
    } catch {
      // Not a token we can read — fall through and hash it like a uuid.
    }
  }
  return deriveSessionNamespace(sessionId);
}
