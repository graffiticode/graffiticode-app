/**
 * OAuth 2.1 Types for MCP Server
 */

// The stored records are core's (core/src/oauth/records.ts), shared by every store.
export type { OAuthClient, PendingAuth, AuthorizationCode, TokenEntry } from "@graffiticode-app/core/oauth/records";

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
