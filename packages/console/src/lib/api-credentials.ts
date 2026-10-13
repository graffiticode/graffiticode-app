// Exchange a raw Graffiticode api key for a Firebase ID token.
//
// api.graffiticode.org's auth middleware (packages/api/src/auth.js) only
// accepts Firebase ID tokens / signed JWTs via client.verifyToken. So when
// the console forwards a request downstream on behalf of an api-key caller,
// it has to send an ID token, not the raw api key.
//
// Cached per-key in-process for ~55 minutes. Concurrent exchanges for the
// same key are deduped via the inFlight map so the first concurrent miss
// triggers exactly one HTTP round-trip pair.

const AUTH_URL = process.env.NEXT_PUBLIC_GC_AUTH_URL || "https://auth.graffiticode.org";
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "";

export interface ApiKeyCredentials {
  idToken: string;
  uid: string;
  expiresAt: number;
}

const cache = new Map<string, ApiKeyCredentials>();
const inFlight = new Map<string, Promise<ApiKeyCredentials>>();

function decodeJwtSub(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function exchangeApiKeyForIdToken(apiKey: string): Promise<ApiKeyCredentials> {
  if (!FIREBASE_API_KEY) {
    throw new Error("NEXT_PUBLIC_FIREBASE_API_KEY is not configured");
  }

  // Step 1: api key → Firebase custom token.
  const authResponse = await fetch(`${AUTH_URL}/authenticate/api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: apiKey }),
  });
  if (!authResponse.ok) {
    throw new Error(`auth /authenticate/api-key failed: ${authResponse.status} ${await authResponse.text()}`);
  }
  const authData = await authResponse.json() as {
    status: string;
    data?: { firebaseCustomToken?: string };
    error?: { message?: string };
  };
  if (authData.status !== "success") {
    throw new Error(`auth failed: ${authData.error?.message || "unknown"}`);
  }
  const customToken = authData.data?.firebaseCustomToken;
  if (!customToken) throw new Error("auth returned no firebaseCustomToken");

  // Step 2: custom token → Firebase ID token.
  const fbResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  if (!fbResponse.ok) {
    throw new Error(`firebase signInWithCustomToken failed: ${fbResponse.status} ${await fbResponse.text()}`);
  }
  const fbData = await fbResponse.json() as {
    idToken?: string;
    error?: { message?: string };
  };
  if (!fbData.idToken) {
    throw new Error(`no idToken from firebase: ${fbData.error?.message || "unknown"}`);
  }

  const uid = decodeJwtSub(fbData.idToken);
  if (!uid) throw new Error("could not decode uid from idToken");

  return {
    idToken: fbData.idToken,
    uid,
    expiresAt: Date.now() + 55 * 60 * 1000,
  };
}

export async function getCredentialsForApiKey(apiKey: string): Promise<ApiKeyCredentials> {
  const now = Date.now();
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > now + 5 * 60 * 1000) {
    return cached;
  }
  let promise = inFlight.get(apiKey);
  if (!promise) {
    promise = exchangeApiKeyForIdToken(apiKey)
      .then(creds => {
        cache.set(apiKey, creds);
        inFlight.delete(apiKey);
        return creds;
      })
      .catch(err => {
        inFlight.delete(apiKey);
        throw err;
      });
    inFlight.set(apiKey, promise);
  }
  return promise;
}
