// POST /oauth/introspect (RFC 7662) — how the Graffiticode REST API validates
// the OAuth access tokens this authorization server issues for it.
//
// Only Graffiticode services may ask: the caller authenticates with a
// Google-signed ID token for its Cloud Run service account (audience: this
// endpoint's URL), and the account must be in OAUTH_INTROSPECTION_CALLERS
// (openapi-run@ only). Token lookups go through the auth service with the
// shared internal key, which stays here; the REST service never holds it.
//
// A token is active only if it was authorized for the REST API's resource —
// strictly: legacy entries with no recorded resource are not. An active
// answer carries, as the extension field gc_firebase_token, the Firebase ID
// token the access token stands for, so the REST service can act as that user
// exactly as this server does for MCP requests.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isOAuthAccessToken, OPENAPI_RESOURCE, resolveOAuthAccessToken } from "./handlers.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org";
export const INTROSPECTION_AUDIENCE = `${MCP_SERVER_URL}/oauth/introspect`;
const MAX_BODY_BYTES = 8 * 1024;

export const introspectionCallers = () =>
  (process.env.OAUTH_INTROSPECTION_CALLERS ?? "openapi-run@graffiticode-app.iam.gserviceaccount.com")
    .split(",").map(s => s.trim()).filter(Boolean);

type Claims = { email?: string; email_verified?: boolean };
export type IdentityVerifier = (token: string, audience: string) => Promise<Claims>;
export type TokenResolver = typeof resolveOAuthAccessToken;

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const googleVerifier: IdentityVerifier = async (token, audience) =>
  (await jwtVerify(token, GOOGLE_JWKS, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience })).payload as Claims;

type Result = { status: number; body: Record<string, unknown> };

/** The decision, free of HTTP, for tests. */
export async function introspect({ authorization, token, verify = googleVerifier, resolve = resolveOAuthAccessToken }: {
  authorization: string | undefined;
  token: string | undefined;
  verify?: IdentityVerifier;
  resolve?: TokenResolver;
}): Promise<Result> {
  const identity = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  let caller: string | undefined;
  try {
    const claims = identity ? await verify(identity, INTROSPECTION_AUDIENCE) : null;
    if (claims?.email && claims.email_verified === true) caller = claims.email;
  } catch {
    caller = undefined;
  }
  if (!caller || !introspectionCallers().includes(caller)) {
    console.log(JSON.stringify({ logName: "security_audit", service: "mcp", event: "oauth_introspect", outcome: "denied", reason: "caller", caller: caller ?? null }));
    return { status: 401, body: { error: "invalid_client" } };
  }
  if (!token || !isOAuthAccessToken(token)) return { status: 200, body: { active: false } };
  const resolved = await resolve(token, OPENAPI_RESOURCE, true);
  if (resolved.status !== "valid") return { status: 200, body: { active: false } };
  return {
    status: 200,
    body: { active: true, token_type: "Bearer", scope: "graffiticode", aud: OPENAPI_RESOURCE, gc_firebase_token: resolved.firebaseToken },
  };
}

export async function handleIntrospect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }
  }
  const token = new URLSearchParams(raw).get("token") ?? undefined;
  const result = await introspect({ authorization: req.headers.authorization, token });
  res.writeHead(result.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(result.body));
}
