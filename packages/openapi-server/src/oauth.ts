// OAuth for the REST API. The authorization server is mcp's (it issues tokens
// for this API's resource too); this service checks each access token with it
// (RFC 7662 introspection), authenticating with its own Cloud Run identity, so
// it never holds the internal key that reads the token store. Answers are
// cached briefly, by token hash.
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { identityToken } from "@graffiticode-app/core/act-as";
import { ApiProblem } from "./problems.js";
import { publicBase } from "./spec.js";

const PREFIX = "gcmcp_at_";
const CACHE_MS = 30_000;
export const authorizationServer = () => (process.env.MCP_OAUTH_URL || "https://mcp.graffiticode.org").replace(/\/$/, "");

export const isOAuthToken = (bearer: string) => bearer.startsWith(PREFIX);

// RFC 9728: where clients learn which authorization server issues for us.
const metadataPath = () => `/.well-known/oauth-protected-resource${new URL(publicBase()).pathname.replace(/\/$/, "")}`;
export const resourceMetadataUrl = () => `${new URL(publicBase()).origin}${metadataPath()}`;

export const oauthChallenge = () => new ApiProblem(401, "invalid_token", "Access token not valid", {
  detail: "The OAuth access token is expired, revoked, or wasn't issued for this API. Sign in again.",
  headers: { "WWW-Authenticate": `Bearer realm="graffiticode", error="invalid_token", resource_metadata="${resourceMetadataUrl()}"` },
});

const cache = new Map<string, { firebaseToken: string | null; until: number }>();

// The Firebase ID token an active access token stands for, or null.
export async function introspectOAuthToken(token: string, now = Date.now()): Promise<string | null> {
  const key = createHash("sha256").update(token).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.firebaseToken;
  const endpoint = `${authorizationServer()}/oauth/introspect`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${await identityToken(endpoint)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ApiProblem(503, "unavailable", "Temporarily unavailable", { detail: "Couldn't check the access token. Try again.", headers: { "Retry-After": "5" } });
  }
  if (!res.ok) {
    console.error("[oauth] introspection refused", res.status);
    throw new ApiProblem(503, "unavailable", "Temporarily unavailable", { detail: "Couldn't check the access token. Try again.", headers: { "Retry-After": "5" } });
  }
  const body: any = await res.json().catch(() => ({}));
  const firebaseToken = body?.active === true && typeof body.gc_firebase_token === "string" ? body.gc_firebase_token : null;
  cache.set(key, { firebaseToken, until: now + CACHE_MS });
  if (cache.size > 10_000) cache.clear();
  return firebaseToken;
}

export function oauthRoutes(app: Hono) {
  const metadata = () => ({
    resource: publicBase(),
    authorization_servers: [authorizationServer()],
    scopes_supported: ["graffiticode"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${publicBase()}/docs`,
  });
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata()));
  app.get(metadataPath(), (c) => c.json(metadata()));
}
