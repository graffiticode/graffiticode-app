// OAuth for the REST API. The authorization server is mcp's (it issues tokens
// for this API's resource too); this service checks each access token with it
// (RFC 7662 introspection), authenticating with its own Cloud Run identity, so
// it never holds the internal key that reads the token store. Answers are
// cached briefly, by token hash.
import { installationHosts } from "@graffiticode-app/core/profile/runtime";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { identityToken } from "@graffiticode-app/core/act-as";
import { ApiProblem } from "./problems.js";
import { publicBase, restOAuthEnabled } from "./spec.js";

const PREFIX = "gcmcp_at_";
const CACHE_MS = 30_000;
// The issuer (core/src/profile/hosts.ts: MCP_OAUTH_URL, or the profile).
export const authorizationServer = () => installationHosts().issuer;

export const isOAuthToken = (bearer: string) => bearer.startsWith(PREFIX);

// RFC 9728: where clients learn which authorization server issues for us.
const metadataPath = () => `/.well-known/oauth-protected-resource${new URL(publicBase()).pathname.replace(/\/$/, "")}`;
export const resourceMetadataUrl = () => `${new URL(publicBase()).origin}${metadataPath()}`;

// Without REST OAuth, the challenge points nowhere: there's no metadata to
// follow, and no sign-in would help.
export const oauthChallenge = () => restOAuthEnabled()
  ? new ApiProblem(401, "invalid_token", "Access token not valid", {
    detail: "The OAuth access token is expired, revoked, or wasn't issued for this API. Sign in again.",
    headers: { "WWW-Authenticate": `Bearer realm="graffiticode", error="invalid_token", resource_metadata="${resourceMetadataUrl()}"` },
  })
  : new ApiProblem(401, "invalid_token", "Access token not valid", {
    detail: "This API doesn't accept OAuth access tokens. Use an API key.",
    headers: { "WWW-Authenticate": `Bearer realm="graffiticode", error="invalid_token"` },
  });

const cache = new Map<string, { firebaseToken: string | null; until: number }>();

type IntrospectionDeps = { fetch?: typeof fetch; identityToken?: (audience: string) => Promise<string> };

// The Firebase ID token an active access token stands for, or null. Active
// means active for this installation: the answer must come from its issuer
// and name its REST resource, which must be one it declares.
export async function introspectOAuthToken(token: string, now = Date.now(), deps: IntrospectionDeps = {}): Promise<string | null> {
  const hosts = installationHosts();
  if (!restOAuthEnabled()) return null;
  const key = createHash("sha256").update(token).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.firebaseToken;
  const endpoint = `${authorizationServer()}/oauth/introspect`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${await (deps.identityToken ?? identityToken)(endpoint)}`, "Content-Type": "application/x-www-form-urlencoded" },
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
  const bound = body?.active === true && body.aud === publicBase() && (body.iss === undefined || body.iss === hosts.issuer);
  const firebaseToken = bound && typeof body.gc_firebase_token === "string" ? body.gc_firebase_token : null;
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
  // Served only while REST OAuth is enabled, decided per request.
  const serve = (c: any) => (restOAuthEnabled() ? c.json(metadata()) : c.notFound());
  app.get("/.well-known/oauth-protected-resource", serve);
  app.get(metadataPath(), serve);
}
