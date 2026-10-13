import { client } from "../auth-client";
import { getCredentialsForApiKey } from "./api-credentials";

export type Auth = { uid: string; token: string };

// Normalizes any inbound credential into { uid, idToken }, where idToken is a
// Firebase ID token api.graffiticode.org will accept. A Firebase ID token /
// signed JWT verifies directly via the auth service; anything else is treated
// as a raw api key and exchanged.
export async function authenticate(token: string): Promise<{ uid: string; idToken: string }> {
  try {
    const { uid } = await client.verifyToken(token);
    return { uid, idToken: token };
  } catch (err: any) {
    console.warn("[authenticate] verifyToken failed, falling back to api-key exchange:", err?.message);
    const { uid, idToken } = await getCredentialsForApiKey(token);
    return { uid, idToken };
  }
}
