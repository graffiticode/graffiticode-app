import { createClient } from "@graffiticode/auth/client";

// Server-side: a client for this server's configured auth host, read at call
// time. (The browser's client is configured from /api/config instead; the
// server's SSO helpers move with the authentication boundary, plan P5.)
const serverClient = () => createClient(process.env.GRAFFITICODE_AUTH_URL || process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org");
import { getCredentialsForApiKey } from "./api-credentials";

export type Auth = { uid: string; token: string };

// Normalizes any inbound credential into { uid, idToken }, where idToken is a
// Firebase ID token api.graffiticode.org will accept. A Firebase ID token /
// signed JWT verifies directly via the auth service; anything else is treated
// as a raw api key and exchanged.
export async function authenticate(token: string): Promise<{ uid: string; idToken: string }> {
  try {
    const { uid } = await serverClient().verifyToken(token);
    return { uid, idToken: token };
  } catch (err: any) {
    console.warn("[authenticate] verifyToken failed, falling back to api-key exchange:", err?.message);
    const { uid, idToken } = await getCredentialsForApiKey(token);
    return { uid, idToken };
  }
}
