/**
 * OAuth 2.1 Types for MCP Server
 */

// OAuth Client registered via Dynamic Client Registration (RFC 7591)
export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: number;
}

// Client registration request (RFC 7591)
export interface ClientRegistrationRequest {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

// Authorization request parameters
export interface AuthorizationRequest {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope?: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource?: string;
}

// Pending authorization (waiting for consent page callback)
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

// Authorization code (short-lived, single use)
export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  google_id_token: string;
  resource: string;
  expires_at: number;
  used: boolean;
}

// Token request parameters
export interface TokenRequest {
  grant_type: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  refresh_token?: string;
}

// Token response
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

// Stored token entry (maps access_token to firebase_id_token)
export interface TokenEntry {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_name?: string;
  scope: string;
  firebase_id_token: string;
  firebase_refresh_token: string;
  firebase_token_expires_at: number;
  // Advertised OAuth access-token expiry (created_at + expires_in). Enforced on
  // every use, independent of the refreshable Firebase token behind it, so an
  // access token stops working past its own lifetime. Optional for back-compat
  // with entries written before this field existed (treated as already-expired).
  access_token_expires_at?: number;
  resource: string;
  created_at: number;
}

// OAuth error response
export interface OAuthError {
  error: string;
  error_description?: string;
}

// Protected Resource Metadata (RFC 9728)
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

// Authorization Server Metadata (RFC 8414)
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported?: string[];
}
