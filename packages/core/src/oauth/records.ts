// OAuth records and the store the authorization server uses (installations
// plan, P5: the OAuth-store handover). The MCP server's handlers speak only
// this interface; which store stands behind it (the shared auth service, the
// installation's own database, or the two during migration) is store.ts's
// decision.
import { createHash } from "node:crypto";

// A client registered via Dynamic Client Registration (RFC 7591).
export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: number;
  // The issuer of the installation it registered with. Absent on clients
  // registered before installations: those are Graffiticode's.
  issuer?: string;
}

// An authorization waiting for the consent page's callback.
export interface PendingAuth {
  state: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  created_at: number;
}

// An authorization code (short-lived, single use).
export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  // The consent page's one-time console grant (core/oauth-grants), redeemed at
  // token exchange with the internal state it was minted for.
  grant?: string;
  grant_state?: string;
  resource: string;
  expires_at: number;
  used: boolean;
}

// An issued access token, its refresh token, and the Firebase session behind them.
export interface TokenEntry {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_name?: string;
  scope: string;
  firebase_id_token: string;
  firebase_refresh_token: string;
  firebase_token_expires_at: number;
  // Advertised OAuth access-token expiry (created_at + expires_in).
  access_token_expires_at?: number;
  resource: string;
  created_at: number;
}

export type FirebaseUpdate = Partial<Pick<TokenEntry, "firebase_id_token" | "firebase_refresh_token" | "firebase_token_expires_at">>;

// Records written before installations name no issuer or resource. They are
// Graffiticode's: its issuer and its MCP resource, as they were served then.
// The migration's fallback to the legacy store is Graffiticode's alone, and
// keeps this issuer URL: changing it is a separate, compatible step, because
// clients are bound to the issuer they registered with.
export const LEGACY_ISSUER = "https://mcp.graffiticode.org";
export const LEGACY_RESOURCE = "https://mcp.graffiticode.org/mcp";
export const LEGACY_INSTALLATION_ID = "graffiticode";

// The prefix of every access token the authorization server issues.
export const ACCESS_TOKEN_PREFIX = "gcmcp_at_";

// A credential is referred to by its hash wherever it's a key: in a document
// id, in the migration contract, in a log.
export const credentialHash = (credential: string) => createHash("sha256").update(credential).digest("hex");

// The key of a token record in the legacy store: its refresh token's hash, or
// its access token's when it has none.
export const tokenKey = (entry: Pick<TokenEntry, "access_token" | "refresh_token">) =>
  credentialHash(entry.refresh_token || entry.access_token);

// The credential was refused for good: the caller answers invalid_grant.
export class CredentialRefused extends Error {
  constructor(message = "The credential isn't valid") {
    super(message);
    this.name = "CredentialRefused";
  }
}

// The store can't decide right now: the caller answers temporarily_unavailable
// and the client retries. Nothing was decided against the credential.
export class StoreUnavailable extends Error {
  constructor(message = "The OAuth store is temporarily unavailable") {
    super(message);
    this.name = "StoreUnavailable";
  }
}

export interface OAuthStore {
  registerClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;

  savePendingAuth(pending: PendingAuth): Promise<void>;
  // Read without using it up.
  getPendingAuth(state: string): Promise<PendingAuth | undefined>;
  // Use it up: returns it to exactly one caller, undefined to every other.
  takePendingAuth(state: string): Promise<PendingAuth | undefined>;

  saveAuthCode(code: AuthorizationCode): Promise<void>;
  // Read without using it up (`used` says whether it already was).
  getAuthCode(code: string): Promise<AuthorizationCode | undefined>;
  // Use it up: true for exactly one caller.
  consumeAuthCode(code: string): Promise<boolean>;
  deleteAuthCode(code: string): Promise<void>;

  saveToken(uid: string, email: string, entry: TokenEntry): Promise<void>;
  getTokenByAccessToken(accessToken: string): Promise<TokenEntry | null>;
  getTokenByRefreshToken(refreshToken: string): Promise<TokenEntry | null>;
  // Replace the token a refresh token belongs to with `next`, and return what
  // was actually issued: `next`, or, for a refresh already decided (a
  // migration's recorded pair), that decision. Throws CredentialRefused when the
  // refresh token is no longer good, StoreUnavailable when that can't be known yet.
  rotateTokens(oldRefreshToken: string, next: TokenEntry): Promise<TokenEntry>;
  updateToken(accessToken: string, updates: FirebaseUpdate): Promise<void>;
  deleteToken(accessToken: string): Promise<void>;
}
