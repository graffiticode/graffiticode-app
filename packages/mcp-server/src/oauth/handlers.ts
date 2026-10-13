/**
 * OAuth 2.1 Endpoint Handlers for MCP Server
 */

import type { IncomingMessage, ServerResponse } from "http";
import { oauthStore } from "./firestore-store.js";
import { verifyPKCE, generateRandomString } from "./pkce.js";
import type {
  OAuthClient,
  ClientRegistrationRequest,
  AuthorizationRequest,
  PendingAuth,
  AuthorizationCode,
  TokenEntry,
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
  OAuthError,
} from "./types.js";

// Environment configuration
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org";
const CONSOLE_URL = process.env.CONSOLE_URL || "https://console.graffiticode.org";
const AUTH_URL = process.env.GRAFFITICODE_AUTH_URL || "https://auth.graffiticode.org";
const FIREBASE_API_KEY = "AIzaSyAoVuUNi8ElnS7cn6wc3D8XExML-URLw0I";

// Token expiration (55 minutes to match Firebase token lifetime with buffer)
const TOKEN_EXPIRES_IN = 55 * 60;

// The single audience this authorization server issues tokens for.
const RESOURCE = `${MCP_SERVER_URL}/mcp`;
// The single scope we grant. Requests may only ask for this (or nothing).
const SUPPORTED_SCOPE = "graffiticode";

// Distinguishable prefixes for the credentials we mint. The prefix lets the MCP
// endpoint tell an OAuth access token apart from a raw Graffiticode API key, so an
// expired/revoked OAuth token produces a reauth challenge instead of silently
// falling through to the API-key path. (Tokens minted before this prefix existed
// no longer match and require one relink — an accepted one-time migration cost.)
export const OAUTH_ACCESS_TOKEN_PREFIX = "gcmcp_at_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "gcmcp_rt_";

// Cap request bodies. DCR/token payloads are tiny; anything larger is abuse.
const MAX_BODY_BYTES = 16 * 1024;

/** Whether a bearer was minted by us as an OAuth access token (vs a raw API key). */
export function isOAuthAccessToken(bearer: string): boolean {
  return bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);
}

/** Reasons an OAuth access token can be rejected, mapped to a challenge description. */
export type OAuthInvalidReason = "expired" | "revoked" | "resource" | "scope";

function reasonDescription(reason: OAuthInvalidReason): string {
  switch (reason) {
    case "expired":
      return "The access token expired";
    case "revoked":
      return "The access token was revoked or is unknown";
    case "resource":
      return "The access token was not issued for this resource";
    case "scope":
      return "The access token lacks the required scope";
  }
}

/**
 * Build the `WWW-Authenticate` / `mcp/www_authenticate` challenge value. The same
 * string is used for the HTTP 401 header (transport-level rejection) and the
 * `_meta["mcp/www_authenticate"]` array on an in-tool auth error — together they
 * point ChatGPT at protected-resource metadata to trigger reauthorization.
 */
export function buildWwwAuthenticate(reason: OAuthInvalidReason): string {
  const metadataUrl = `${MCP_SERVER_URL}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${reasonDescription(reason)}"`;
}

/**
 * Validate a DCR `redirect_uris` value. Returns an error description, or null when
 * valid: a non-empty array of absolute https URIs (localhost tolerated for dev).
 * Pure, so the open-redirect guard is unit-testable.
 */
export function redirectUrisError(uris: unknown): string | null {
  if (!Array.isArray(uris) || uris.length === 0) {
    return "redirect_uris must be a non-empty array";
  }
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri as string);
    } catch {
      return `Invalid redirect_uri: ${uri}`;
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return `redirect_uri must be https: ${uri}`;
    }
  }
  return null;
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Send OAuth error response
 */
function sendError(res: ServerResponse, status: number, error: OAuthError): void {
  sendJson(res, status, error);
}

/**
 * Redirect response
 */
function redirect(res: ServerResponse, url: string, status: 302 | 303 = 302): void {
  // 303 after a POST: tells the browser to follow with GET rather than re-POSTing
  // the body to the client's redirect_uri (RFC 9110 §15.4.4).
  res.writeHead(status, { Location: url, "Cache-Control": "no-store" });
  res.end();
}

/**
 * Parse URL-encoded form body
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function parseFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

/**
 * Parse JSON body
 */
async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * GET /.well-known/oauth-protected-resource
 * RFC 9728 - Protected Resource Metadata
 */
export function handleProtectedResourceMetadata(
  _req: IncomingMessage,
  res: ServerResponse
): void {
  const metadata: ProtectedResourceMetadata = {
    resource: `${MCP_SERVER_URL}/mcp`,
    authorization_servers: [MCP_SERVER_URL],
  };
  sendJson(res, 200, metadata);
}

/**
 * GET /.well-known/oauth-authorization-server
 * RFC 8414 - Authorization Server Metadata
 */
export function handleAuthServerMetadata(
  _req: IncomingMessage,
  res: ServerResponse
): void {
  const metadata: AuthorizationServerMetadata = {
    issuer: MCP_SERVER_URL,
    authorization_endpoint: `${MCP_SERVER_URL}/oauth/authorize`,
    token_endpoint: `${MCP_SERVER_URL}/oauth/token`,
    registration_endpoint: `${MCP_SERVER_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Public clients only. We never issue or validate a client secret, so we must
    // not advertise client_secret_post (a lie that invites secret-bearing clients).
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SUPPORTED_SCOPE],
  };
  sendJson(res, 200, metadata);
}

/**
 * POST /oauth/register
 * RFC 7591 - Dynamic Client Registration
 */
export async function handleClientRegistration(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: ClientRegistrationRequest;
  try {
    body = (await parseJsonBody(req)) as ClientRegistrationRequest;
  } catch {
    sendError(res, 413, { error: "invalid_client_metadata", error_description: "Request body too large" });
    return;
  }

  // Require a non-empty set of absolute https redirect URIs. Without this an empty
  // list was accepted and later let authorize accept ANY redirect (open redirect).
  const redirectUris = body.redirect_uris;
  const redirectError = redirectUrisError(redirectUris);
  if (redirectError) {
    sendError(res, 400, { error: "invalid_redirect_uri", error_description: redirectError });
    return;
  }

  // We are a public authorization server: only the "none" auth method, the "code"
  // response type, and authorization_code/refresh_token grants are supported.
  const authMethod = body.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    sendError(res, 400, { error: "invalid_client_metadata", error_description: "Only token_endpoint_auth_method 'none' is supported" });
    return;
  }
  const responseTypes = body.response_types ?? ["code"];
  if (!responseTypes.every((t) => t === "code")) {
    sendError(res, 400, { error: "invalid_client_metadata", error_description: "Only the 'code' response_type is supported" });
    return;
  }
  const grantTypes = body.grant_types ?? ["authorization_code"];
  if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    sendError(res, 400, { error: "invalid_client_metadata", error_description: "Only authorization_code and refresh_token grants are supported" });
    return;
  }

  // Generate client credentials
  const clientId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const client: OAuthClient = {
    client_id: clientId,
    client_name: body.client_name || "Unknown Client",
    redirect_uris: redirectUris as string[], // guaranteed non-empty by redirectUrisError
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: "none",
    client_id_issued_at: now,
  };

  await oauthStore.registerClient(client);

  // Return client metadata (RFC 7591 Section 3.2.1)
  sendJson(res, 201, {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    client_id_issued_at: client.client_id_issued_at,
  });
}

/**
 * GET /oauth/authorize
 * OAuth 2.1 Authorization Endpoint
 */
export async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const params = url.searchParams;

  // Extract parameters
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");
  const scope = params.get("scope") || SUPPORTED_SCOPE;
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  const resource = params.get("resource") || RESOURCE;

  // Validate required parameters
  if (!clientId) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing client_id" });
    return;
  }

  if (!redirectUri) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing redirect_uri" });
    return;
  }

  if (responseType !== "code") {
    sendError(res, 400, { error: "unsupported_response_type", error_description: "Only 'code' response type is supported" });
    return;
  }

  if (!state) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing state parameter" });
    return;
  }

  if (!codeChallenge || !codeChallengeMethod) {
    sendError(res, 400, { error: "invalid_request", error_description: "PKCE required (code_challenge and code_challenge_method)" });
    return;
  }

  if (codeChallengeMethod !== "S256") {
    sendError(res, 400, { error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" });
    return;
  }

  // Reject any scope beyond the single one we grant.
  if (!scope.split(/\s+/).filter(Boolean).every((s) => s === SUPPORTED_SCOPE)) {
    sendError(res, 400, { error: "invalid_scope", error_description: `Only the '${SUPPORTED_SCOPE}' scope is supported` });
    return;
  }

  // The resource (audience) must be exactly this MCP server. OpenAI flows the
  // resource through authorization; anything else is a misconfigured/hostile client.
  if (resource !== RESOURCE) {
    sendError(res, 400, { error: "invalid_target", error_description: `resource must be ${RESOURCE}` });
    return;
  }

  // Validate client exists
  const client = await oauthStore.getClient(clientId);
  if (!client) {
    sendError(res, 400, { error: "invalid_client", error_description: "Unknown client_id" });
    return;
  }

  // Exact redirect_uri match against the client's registered set. DCR now
  // guarantees that set is non-empty, so there is no "no URIs registered" bypass.
  if (!client.redirect_uris.includes(redirectUri)) {
    sendError(res, 400, { error: "invalid_request", error_description: "Invalid redirect_uri" });
    return;
  }

  // Generate internal state for consent page callback
  const internalState = generateRandomString(32);

  // Store pending auth
  const pending: PendingAuth = {
    state: internalState,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    resource,
    created_at: Date.now(),
  };

  // Also store the client's original state mapped to our internal state
  (pending as any).client_state = state;

  await oauthStore.savePendingAuth(pending);

  // Build consent page URL
  const consentUrl = new URL("/oauth/consent", CONSOLE_URL);
  consentUrl.searchParams.set("callback_url", `${MCP_SERVER_URL}/oauth/callback`);
  consentUrl.searchParams.set("state", internalState);
  consentUrl.searchParams.set("app_name", client.client_name || "MCP Client");

  redirect(res, consentUrl.toString());
}

/**
 * GET /oauth/callback
 * Callback from consent page with Google ID token.
 *
 * SECURITY BLOCKER (OpenAI-submission item 2c-vi — NOT yet resolved): the consent
 * page redirects the browser here with `google_id_token` in the QUERY STRING, so a
 * live Google ID token can land in browser history, CDN/proxy access logs, and
 * Referer headers. Fixing this requires a COORDINATED change in the console/auth
 * consent service (it builds this redirect): replace the query-string token with a
 * short-lived, single-use result code redeemed server-to-server (preferred) or a
 * form POST — bound to the pending OAuth state/client, expiring fast, consumed once.
 * Until that lands, OAuth is NOT review-ready; ship v1 noauth-only (see the
 * go/no-go gate) rather than advertise a partially-hardened OAuth surface.
 */
export async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // The consent page POSTs the Google ID token in a form body. It must never travel
  // in a query string: URLs are recorded by the CDN and by Cloud Run request logs
  // (verified — a real user's id_token sat in plaintext in Cloud Logging), kept in
  // browser history, and forwarded in Referer headers. The body is in none of those.
  //
  // GET is still accepted so a consent page deployed before this change keeps
  // working, but it logs a warning and should stop being reachable once the console
  // rollout is complete. The cancel path stays GET: it carries only error + state.
  const isPost = req.method === "POST";
  const params = isPost ? await parseFormBody(req) : url.searchParams;

  const googleIdToken = params.get("google_id_token");
  if (!isPost && googleIdToken) {
    console.warn(
      "[oauth] google_id_token arrived in the callback QUERY STRING (pre-POST consent page). " +
        "It is now in this request's access log. Deploy the console consent page that POSTs it."
    );
  }
  const state = params.get("state");
  const error = params.get("error");
  const errorDescription = params.get("error_description");

  // Check for error from consent page
  if (error) {
    const pending = state ? await oauthStore.getPendingAuth(state) : null;
    if (pending) {
      const clientState = (pending as any).client_state;
      await oauthStore.deletePendingAuth(state!);

      const redirectUrl = new URL(pending.redirect_uri);
      redirectUrl.searchParams.set("error", error);
      if (errorDescription) {
        redirectUrl.searchParams.set("error_description", errorDescription);
      }
      redirectUrl.searchParams.set("state", clientState);
      redirect(res, redirectUrl.toString(), isPost ? 303 : 302);
      return;
    }
    sendError(res, 400, { error, error_description: errorDescription || undefined });
    return;
  }

  if (!state) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing state" });
    return;
  }

  if (!googleIdToken) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing google_id_token" });
    return;
  }

  // Look up pending auth
  const pending = await oauthStore.getPendingAuth(state);
  if (!pending) {
    sendError(res, 400, { error: "invalid_request", error_description: "Invalid or expired state" });
    return;
  }

  const clientState = (pending as any).client_state;
  await oauthStore.deletePendingAuth(state);

  // Generate authorization code
  const code = generateRandomString(64);
  const authCode: AuthorizationCode = {
    code,
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    scope: pending.scope,
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method,
    google_id_token: googleIdToken,
    resource: pending.resource,
    expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes
    used: false,
  };

  await oauthStore.saveAuthCode(authCode);

  // Redirect to client with authorization code
  const redirectUrl = new URL(pending.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", clientState);

  redirect(res, redirectUrl.toString(), isPost ? 303 : 302);
}

/**
 * Exchange Google ID token for Firebase ID token and refresh token
 */
/**
 * The auth service refused the sign-in itself — most often "No Graffiticode account for this
 * email" — as opposed to failing. Answered as OAuth `invalid_grant` (400) with the service's
 * own message, which a client can show the person; a 500 says only that the server broke.
 */
export class GrantRefused extends Error {}

/** The refusal message the auth service sent, from its JSON envelope or as plain text. */
export function refusalMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
    if (msg) return String(msg).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || "Sign-in was refused.";
}

/** Logs never carry an email address (CLAUDE.md privacy contract), even inside a message. */
export function redactEmails(text: string): string {
  return text.replace(/[^\s@<>"',;()]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "<email>");
}

async function exchangeGoogleTokenForFirebaseToken(googleIdToken: string): Promise<{
  firebaseIdToken: string;
  firebaseRefreshToken: string;
  providerId: string;
  email: string;
  expiresAt: number;
}> {
  // Step 1: Exchange Google ID token for Firebase custom token
  const authResponse = await fetch(`${AUTH_URL}/authenticate/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: googleIdToken }),
  });

  if (!authResponse.ok) {
    const error = await authResponse.text();
    if (authResponse.status === 401 || authResponse.status === 403) {
      throw new GrantRefused(refusalMessage(error));
    }
    throw new Error(`Failed to authenticate with Google: ${error}`);
  }

  const authData = (await authResponse.json()) as {
    status: string;
    error?: { message: string } | null;
    data?: { firebaseCustomToken?: string; uid?: string } | null;
  };

  if (authData.status !== "success" || !authData.data?.firebaseCustomToken) {
    throw new Error(authData.error?.message || "Failed to get Firebase custom token");
  }

  // Step 2: Exchange Firebase custom token for ID token + refresh token
  const firebaseResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: authData.data.firebaseCustomToken,
        returnSecureToken: true,
      }),
    }
  );

  if (!firebaseResponse.ok) {
    const error = await firebaseResponse.text();
    throw new Error(`Failed to exchange custom token: ${error}`);
  }

  const firebaseData = (await firebaseResponse.json()) as {
    idToken?: string;
    refreshToken?: string;
    localId?: string;
    error?: { message: string };
  };

  if (!firebaseData.idToken) {
    throw new Error(firebaseData.error?.message || "No ID token returned");
  }

  if (!firebaseData.refreshToken) {
    throw new Error("No refresh token returned from Firebase");
  }

  // Firebase ID tokens expire in 1 hour, we use 55 minutes with buffer
  const expiresAt = Date.now() + TOKEN_EXPIRES_IN * 1000;

  // The providerId is the Firebase UID from the custom token auth
  // This is the same UID stored in the oauth-links collection
  const providerId = firebaseData.localId || authData.data.uid || "";

  // Extract email from Google ID token (JWT payload)
  let email = "";
  try {
    const payload = JSON.parse(Buffer.from(googleIdToken.split(".")[1], "base64").toString());
    email = payload.email || "";
  } catch {
    // Ignore - email is optional
  }

  return {
    firebaseIdToken: firebaseData.idToken,
    firebaseRefreshToken: firebaseData.refreshToken,
    providerId,
    email,
    expiresAt,
  };
}

/**
 * Refresh Firebase ID token using refresh token
 */
async function refreshFirebaseToken(firebaseRefreshToken: string): Promise<{
  firebaseIdToken: string;
  firebaseRefreshToken: string;
  expiresAt: number;
}> {
  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(firebaseRefreshToken)}`,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh Firebase token: ${error}`);
  }

  const data = (await response.json()) as {
    id_token?: string;
    refresh_token?: string;
    error?: { message: string };
  };

  if (!data.id_token) {
    throw new Error(data.error?.message || "No ID token returned from refresh");
  }

  // Firebase ID tokens expire in 1 hour, we use 55 minutes with buffer
  const expiresAt = Date.now() + TOKEN_EXPIRES_IN * 1000;

  return {
    firebaseIdToken: data.id_token,
    firebaseRefreshToken: data.refresh_token || firebaseRefreshToken,
    expiresAt,
  };
}

/**
 * POST /oauth/token
 * OAuth 2.1 Token Endpoint
 */
export async function handleToken(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parseFormBody(req);

  const grantType = body.get("grant_type");
  const clientId = body.get("client_id");

  if (!grantType) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing grant_type" });
    return;
  }

  if (grantType === "authorization_code") {
    await handleAuthorizationCodeGrant(body, res);
  } else if (grantType === "refresh_token") {
    await handleRefreshTokenGrant(body, res);
  } else {
    sendError(res, 400, { error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token grants are supported" });
  }
}

/**
 * Handle authorization_code grant type
 */
async function handleAuthorizationCodeGrant(
  body: URLSearchParams,
  res: ServerResponse
): Promise<void> {
  const code = body.get("code");
  const redirectUri = body.get("redirect_uri");
  const clientId = body.get("client_id");
  const codeVerifier = body.get("code_verifier");
  const resource = body.get("resource");

  if (!code) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing code" });
    return;
  }

  // A public client MUST identify itself and echo the redirect_uri it authorized
  // with (OAuth 2.1 §4.1.3). Both were optional before, weakening code binding.
  if (!clientId) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing client_id" });
    return;
  }

  if (!redirectUri) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing redirect_uri" });
    return;
  }

  if (!codeVerifier) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing code_verifier" });
    return;
  }

  // Look up authorization code
  const authCode = await oauthStore.getAuthCode(code);
  if (!authCode) {
    sendError(res, 400, { error: "invalid_grant", error_description: "Invalid or expired authorization code" });
    return;
  }

  // Check if already used
  if (authCode.used) {
    await oauthStore.deleteAuthCode(code);
    sendError(res, 400, { error: "invalid_grant", error_description: "Authorization code already used" });
    return;
  }

  // Check expiration
  if (Date.now() > authCode.expires_at) {
    await oauthStore.deleteAuthCode(code);
    sendError(res, 400, { error: "invalid_grant", error_description: "Authorization code expired" });
    return;
  }

  // Exact client_id + redirect_uri match to the values bound at authorization.
  if (clientId !== authCode.client_id) {
    sendError(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
    return;
  }

  if (redirectUri !== authCode.redirect_uri) {
    sendError(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }

  // If the client re-sends resource at exchange, it must match what it authorized.
  if (resource && resource !== authCode.resource) {
    sendError(res, 400, { error: "invalid_target", error_description: "resource mismatch" });
    return;
  }

  // Verify PKCE
  if (!verifyPKCE(codeVerifier, authCode.code_challenge, authCode.code_challenge_method)) {
    sendError(res, 400, { error: "invalid_grant", error_description: "Invalid code_verifier" });
    return;
  }

  // Mark code as used
  await oauthStore.markAuthCodeUsed(code);

  try {
    // Exchange Google ID token for Firebase ID token + refresh token
    const { firebaseIdToken, firebaseRefreshToken, providerId, email, expiresAt } = await exchangeGoogleTokenForFirebaseToken(
      authCode.google_id_token
    );

    // Get client name for token metadata
    const client = await oauthStore.getClient(authCode.client_id);
    const clientName = client?.client_name || "Unknown";

    // Generate tokens (prefixed so the MCP endpoint can tell them from API keys).
    const accessToken = OAUTH_ACCESS_TOKEN_PREFIX + generateRandomString(64);
    const refreshToken = OAUTH_REFRESH_TOKEN_PREFIX + generateRandomString(64);
    const issuedAt = Date.now();

    // Store token entry (now includes Firebase refresh token for indefinite persistence)
    const tokenEntry: TokenEntry = {
      access_token: accessToken,
      refresh_token: refreshToken,
      client_id: authCode.client_id,
      client_name: clientName,
      scope: authCode.scope,
      firebase_id_token: firebaseIdToken,
      firebase_refresh_token: firebaseRefreshToken,
      firebase_token_expires_at: expiresAt,
      access_token_expires_at: issuedAt + TOKEN_EXPIRES_IN * 1000,
      resource: authCode.resource,
      created_at: issuedAt,
    };

    await oauthStore.saveToken(providerId, email, tokenEntry);

    // Clean up auth code
    await oauthStore.deleteAuthCode(code);

    // Return token response
    sendJson(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_EXPIRES_IN,
      refresh_token: refreshToken,
      scope: authCode.scope,
    });
  } catch (error) {
    if (error instanceof GrantRefused) {
      // Expected, and the person can act on it: no stack, and no email in the log.
      console.warn(`[oauth] token exchange refused by auth: ${redactEmails(error.message)}`);
      sendError(res, 400, { error: "invalid_grant", error_description: error.message });
      return;
    }
    console.error("Token exchange error:", error);
    sendError(res, 500, {
      error: "server_error",
      error_description: error instanceof Error ? error.message : "Token exchange failed",
    });
  }
}

/**
 * Handle refresh_token grant type
 */
async function handleRefreshTokenGrant(
  body: URLSearchParams,
  res: ServerResponse
): Promise<void> {
  const refreshToken = body.get("refresh_token");
  const clientId = body.get("client_id");
  const resource = body.get("resource");

  if (!refreshToken) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing refresh_token" });
    return;
  }

  // A public client must identify itself on refresh (redirect_uri is NOT required
  // here — it belongs to the authorization-code exchange, not refresh).
  if (!clientId) {
    sendError(res, 400, { error: "invalid_request", error_description: "Missing client_id" });
    return;
  }

  try {
    // Look up token by refresh token (now async)
    const tokenEntry = await oauthStore.getTokenByRefreshToken(refreshToken);
    if (!tokenEntry) {
      sendError(res, 400, { error: "invalid_grant", error_description: "Invalid refresh_token" });
      return;
    }

    // Exact client_id match to the token's owner.
    if (clientId !== tokenEntry.client_id) {
      sendError(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
      return;
    }

    // Resource is inherited from the original grant; if the client re-sends it, it
    // must match. It is never widened on refresh.
    if (resource && resource !== tokenEntry.resource) {
      sendError(res, 400, { error: "invalid_target", error_description: "resource mismatch" });
      return;
    }

    // Check if Firebase token needs refresh
    let firebaseIdToken = tokenEntry.firebase_id_token;
    let firebaseRefreshToken = tokenEntry.firebase_refresh_token;
    let firebaseExpiresAt = tokenEntry.firebase_token_expires_at;

    if (Date.now() > tokenEntry.firebase_token_expires_at) {
      // Firebase token expired - refresh it using the stored Firebase refresh token
      const refreshed = await refreshFirebaseToken(tokenEntry.firebase_refresh_token);
      firebaseIdToken = refreshed.firebaseIdToken;
      firebaseRefreshToken = refreshed.firebaseRefreshToken;
      firebaseExpiresAt = refreshed.expiresAt;
    }

    // Rotate OAuth tokens (OAuth 2.1 requirement)
    const newAccessToken = OAUTH_ACCESS_TOKEN_PREFIX + generateRandomString(64);
    const newRefreshToken = OAUTH_REFRESH_TOKEN_PREFIX + generateRandomString(64);
    const issuedAt = Date.now();

    // Create new token entry with potentially refreshed Firebase token
    const newTokenEntry: TokenEntry = {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      client_id: tokenEntry.client_id,
      client_name: tokenEntry.client_name,
      scope: tokenEntry.scope,
      firebase_id_token: firebaseIdToken,
      firebase_refresh_token: firebaseRefreshToken,
      firebase_token_expires_at: firebaseExpiresAt,
      access_token_expires_at: issuedAt + TOKEN_EXPIRES_IN * 1000,
      resource: tokenEntry.resource,
      created_at: issuedAt,
    };

    // Rotate tokens in Firestore (delete old, create new)
    await oauthStore.rotateTokens(refreshToken, newTokenEntry);

    // Return token response with full expiration time (since we refreshed)
    sendJson(res, 200, {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: TOKEN_EXPIRES_IN,
      refresh_token: newRefreshToken,
      scope: tokenEntry.scope,
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    sendError(res, 500, {
      error: "server_error",
      error_description: error instanceof Error ? error.message : "Token refresh failed",
    });
  }
}

/**
 * Resolve an OAuth access token for the /mcp endpoint.
 *
 * Validates the token's expiry, audience (resource), and scope on EVERY call — a
 * stateful MCP session may cache identity but never authorization validity — then
 * returns the backing Firebase ID token (auto-refreshing it if the short-lived
 * Firebase token lapsed while the OAuth access token is still within its own
 * lifetime). A discriminated result lets the caller distinguish "valid" from an
 * expired/revoked token that must trigger a reauthorization challenge, instead of
 * silently downgrading to the raw-API-key path.
 */
export type OAuthResolution =
  | { status: "valid"; firebaseToken: string }
  | { status: "invalid"; reason: OAuthInvalidReason };

/**
 * When a stored token entry expires, in epoch ms — or null if that can't be known.
 *
 * We set `access_token_expires_at` when issuing, but it never survives a round trip:
 * the auth service persists an explicit allowlist of fields (`packages/auth`,
 * `src/routes/oauth-tokens.js` + `src/storage/oauth-tokens.js`) that does not include
 * it, and `mapTokenResponse` doesn't read it back either. So every entry loaded from
 * the store has it `undefined`.
 *
 * That is why this falls back to `created_at` — which the auth service DOES stamp
 * (`Date.now()`) and return — plus the same lifetime we advertise as `expires_in`.
 * Without the fallback, a strict `typeof !== "number"` check rejects every freshly
 * minted OAuth token as expired, which is precisely the bug this repairs: the client
 * gets a 401 on its first call, refreshes, is rejected again, and silently falls back
 * to an anonymous free-plan session.
 *
 * The original intent — force one relink for pre-hardening entries — is preserved:
 * those were created long ago, so a `created_at`-derived expiry has already passed.
 *
 * Follow-up (cross-service, not required for correctness): add
 * `access_token_expires_at` to the auth service's allowlist and to
 * `mapTokenResponse`, so the issued value is authoritative rather than re-derived.
 */
export function accessTokenExpiry(
  entry: Pick<TokenEntry, "access_token_expires_at" | "created_at">,
): number | null {
  if (typeof entry.access_token_expires_at === "number") return entry.access_token_expires_at;
  if (typeof entry.created_at === "number") return entry.created_at + TOKEN_EXPIRES_IN * 1000;
  return null;
}

/**
 * Pure validity check for a stored token entry — expiry, audience, scope. Kept
 * store- and network-free so the authorization rules are unit-testable. Returns
 * null when the entry is valid, or the rejection reason otherwise.
 */
export function evaluateTokenValidity(
  entry: Pick<TokenEntry, "access_token_expires_at" | "resource" | "scope" | "created_at">,
  expectedResource: string,
  now: number,
): OAuthInvalidReason | null {
  // Enforce the advertised OAuth access-token expiry.
  const expiresAt = accessTokenExpiry(entry);
  if (expiresAt === null || now > expiresAt) {
    return "expired";
  }
  // Audience binding: the token must have been issued for this resource.
  if (entry.resource && entry.resource !== expectedResource) {
    return "resource";
  }
  // Scope: must include the one scope we grant.
  const scopes = String(entry.scope || "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(SUPPORTED_SCOPE)) {
    return "scope";
  }
  return null;
}

export async function resolveOAuthAccessToken(
  accessToken: string,
  expectedResource: string = RESOURCE,
): Promise<OAuthResolution> {
  const tokenEntry = await oauthStore.getTokenByAccessToken(accessToken);
  if (!tokenEntry) {
    return { status: "invalid", reason: "revoked" };
  }

  const reason = evaluateTokenValidity(tokenEntry, expectedResource, Date.now());
  if (reason) {
    return { status: "invalid", reason };
  }

  // Refresh the backing Firebase token if it lapsed (the OAuth access token itself
  // is still valid per the checks above).
  if (Date.now() > tokenEntry.firebase_token_expires_at) {
    try {
      const refreshed = await refreshFirebaseToken(tokenEntry.firebase_refresh_token);
      await oauthStore.updateToken(accessToken, {
        firebase_id_token: refreshed.firebaseIdToken,
        firebase_refresh_token: refreshed.firebaseRefreshToken,
        firebase_token_expires_at: refreshed.expiresAt,
      });
      return { status: "valid", firebaseToken: refreshed.firebaseIdToken };
    } catch (error) {
      console.error("Failed to refresh Firebase token:", error);
      await oauthStore.deleteToken(accessToken);
      return { status: "invalid", reason: "revoked" };
    }
  }

  return { status: "valid", firebaseToken: tokenEntry.firebase_id_token };
}
