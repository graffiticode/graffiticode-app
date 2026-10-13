import { SignJWT, jwtVerify } from "jose";

/**
 * Claim-token contract.
 *
 * - Algorithm: HS256
 * - Secret: FREE_PLAN_NAMESPACE_SALT (UTF-8 bytes)
 * - Audience: "graffiticode-claim"
 * - Expiry: 24h from issuance
 * - Payload claims:
 *     sessionNamespace: string  // sha256(salt + ":" + sessionUuid), already derived
 *     sessionUuid:      string  // raw MCP trial session uuid (provenance only)
 *
 * Minted HERE, not in the MCP server. It used to be minted there from the
 * transport session uuid, which was wrong for any client whose transport session
 * isn't where its items live: a stateless client revising an item created in an
 * earlier session got a token addressing its *current* namespace, which holds
 * nothing, so claiming transferred zero items. Only the console knows the
 * effective (post-adoption) workspace, so only the console can mint this.
 *
 * Minting here also retires the hand-mirrored copy of these signing parameters
 * that the MCP repo was maintaining by comment.
 */

export type ClaimTokenPayload = {
  sessionNamespace: string;
  sessionUuid: string;
};

const AUDIENCE = "graffiticode-claim";
const EXPIRES_IN = "24h";

function getSecret(): Uint8Array {
  const salt = process.env.FREE_PLAN_NAMESPACE_SALT;
  if (!salt) {
    throw new Error("FREE_PLAN_NAMESPACE_SALT is not configured");
  }
  return new TextEncoder().encode(salt);
}

export async function mintClaimToken(payload: ClaimTokenPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(getSecret());
}

export async function verifyClaimToken(token: string): Promise<ClaimTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  const sessionNamespace = payload.sessionNamespace;
  const sessionUuid = payload.sessionUuid;
  if (typeof sessionNamespace !== "string" || !sessionNamespace) {
    throw new Error("Claim token missing sessionNamespace");
  }
  if (typeof sessionUuid !== "string" || !sessionUuid) {
    throw new Error("Claim token missing sessionUuid");
  }
  return { sessionNamespace, sessionUuid };
}
