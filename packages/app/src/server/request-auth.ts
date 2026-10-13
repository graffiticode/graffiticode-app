import { authenticate, type Auth } from "@graffiticode/auth-react/server";

// Resolves the inbound Authorization header (Firebase ID token or api key) into
// an { uid, token } pair, where token is a Firebase ID token usable downstream
// against api.graffiticode.org. Returns null when no credential is present.
export async function authFromRequest(req: Request): Promise<Auth | null> {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  try {
    const { uid, idToken } = await authenticate(header);
    return { uid, token: idToken };
  } catch (err) {
    console.error("authFromRequest(): authentication failed", err);
    return null;
  }
}
