import type { Auth } from "@graffiticode/auth-react/server";
import { authenticate } from "@graffiticode-app/core/auth";
import { ensureInstallation } from "@graffiticode-app/core/profile/runtime";

// Resolves the inbound Authorization header (Firebase ID token or api key) into
// an { uid, token } pair, where token is a Firebase ID token usable downstream
// against the API. Verified against the installation's auth host (core's
// config), not the build's. Returns null when no credential is present.
export async function authFromRequest(req: Request): Promise<Auth | null> {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  try {
    ensureInstallation();
    const { uid, idToken } = await authenticate(header);
    return { uid, token: idToken };
  } catch (err) {
    console.error("authFromRequest(): authentication failed", err);
    return null;
  }
}
