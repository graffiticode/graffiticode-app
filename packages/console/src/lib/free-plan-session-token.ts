import { SignJWT, jwtVerify } from "jose";

/**
 * Signed free-plan session ("workspace") tokens.
 *
 * These carry a sessionNamespace that the console has ALREADY decided, rather
 * than a raw uuid the console hashes on arrival. That distinction is the whole
 * point, and it buys two things:
 *
 * 1. Continuity. An MCP "session" is an in-memory transport binding that dies on
 *    restart, on a scale-out, and (for ChatGPT) after every single tool call.
 *    Handing the client back a signed namespace lets its later calls rejoin the
 *    workspace its earlier items live in, instead of scattering one item per
 *    namespace and stranding all but the last at claim time.
 *
 * 2. Attestation. A raw uuid in X-Free-Plan-Session is self-asserted — any
 *    caller can mint one, which is what makes per-session quota bypassable. A
 *    signed token can only come from us. Stage 3 flips
 *    FREE_PLAN_REQUIRE_SIGNED_SESSION and stops accepting the raw form.
 *
 * Contract (mirrors claim-token.ts, different audience so the two can never be
 * substituted for one another):
 * - Algorithm: HS256
 * - Secret:    FREE_PLAN_NAMESPACE_SALT (UTF-8 bytes)
 * - Audience:  "graffiticode-session"
 * - Expiry:    48h, matching FREE_PLAN_ITEM_TTL_MS — a workspace token should
 *              never outlive the items it addresses.
 *
 * Capability note: holding one of these is equivalent to holding the workspace —
 * it can create items in it, list it, and claim it. That is the same capability
 * level as the claim token already embedded in the shareable view_url, so it is
 * not a new class of exposure, but it must never be put anywhere a claim token
 * wouldn't go.
 */

export type SessionTokenPayload = {
  sessionNamespace: string;
  sessionUuid: string;
};

const AUDIENCE = "graffiticode-session";
const EXPIRES_IN = "48h";

function getSecret(): Uint8Array {
  const salt = process.env.FREE_PLAN_NAMESPACE_SALT;
  if (!salt) {
    throw new Error("FREE_PLAN_NAMESPACE_SALT is not configured");
  }
  return new TextEncoder().encode(salt);
}

export function isSessionTokenConfigured(): boolean {
  return !!process.env.FREE_PLAN_NAMESPACE_SALT;
}

export async function mintSessionToken(payload: SessionTokenPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  const sessionNamespace = payload.sessionNamespace;
  const sessionUuid = payload.sessionUuid;
  if (typeof sessionNamespace !== "string" || !sessionNamespace) {
    throw new Error("Session token missing sessionNamespace");
  }
  if (typeof sessionUuid !== "string" || !sessionUuid) {
    throw new Error("Session token missing sessionUuid");
  }
  return { sessionNamespace, sessionUuid };
}

/**
 * A JWT has three dot-separated base64url segments; a session uuid has none.
 * Used to decide which form arrived in the header without paying for a failed
 * signature verification on every legacy request.
 */
export function looksLikeSessionToken(value: string): boolean {
  return value.split(".").length === 3;
}
