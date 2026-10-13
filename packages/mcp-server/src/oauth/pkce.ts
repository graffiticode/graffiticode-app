/**
 * PKCE (Proof Key for Code Exchange) utilities
 * RFC 7636 - https://tools.ietf.org/html/rfc7636
 */

import { createHash } from "crypto";

/**
 * Base64url encode a buffer (RFC 4648 Section 5)
 */
function base64urlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate the code challenge from a code verifier using S256 method
 */
export function generateCodeChallenge(codeVerifier: string): string {
  const hash = createHash("sha256").update(codeVerifier).digest();
  return base64urlEncode(hash);
}

/**
 * Verify that a code verifier matches a code challenge
 *
 * @param codeVerifier - The code verifier from the token request
 * @param codeChallenge - The code challenge from the authorization request
 * @param method - The code challenge method (only "S256" supported)
 * @returns true if the verifier matches the challenge
 */
export function verifyPKCE(
  codeVerifier: string,
  codeChallenge: string,
  method: string
): boolean {
  // Only S256 is supported per OAuth 2.1
  if (method !== "S256") {
    return false;
  }

  // Validate code verifier format (43-128 characters, unreserved characters only)
  // RFC 7636 Section 4.1
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) {
    return false;
  }

  const computedChallenge = generateCodeChallenge(codeVerifier);
  return computedChallenge === codeChallenge;
}

/**
 * Generate a random string suitable for use as state or code verifier
 */
export function generateRandomString(length: number = 64): string {
  const bytes = Buffer.alloc(Math.ceil(length * 0.75));
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes).slice(0, length);
}
