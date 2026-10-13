/**
 * In-memory OAuth state storage
 */

import type {
  OAuthClient,
  PendingAuth,
  AuthorizationCode,
  TokenEntry,
} from "./types.js";

// Expiration times
const PENDING_AUTH_TTL = 10 * 60 * 1000; // 10 minutes
const AUTH_CODE_TTL = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class OAuthStore {
  private clients = new Map<string, OAuthClient>();
  private pendingAuths = new Map<string, PendingAuth>();
  private authCodes = new Map<string, AuthorizationCode>();
  private tokens = new Map<string, TokenEntry>();
  private refreshTokenIndex = new Map<string, string>(); // refresh_token -> access_token

  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL);
  }

  // Client methods

  registerClient(client: OAuthClient): void {
    this.clients.set(client.client_id, client);
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }

  deleteClient(clientId: string): boolean {
    return this.clients.delete(clientId);
  }

  // Pending auth methods

  savePendingAuth(pending: PendingAuth): void {
    this.pendingAuths.set(pending.state, pending);
  }

  getPendingAuth(state: string): PendingAuth | undefined {
    return this.pendingAuths.get(state);
  }

  deletePendingAuth(state: string): void {
    this.pendingAuths.delete(state);
  }

  // Authorization code methods

  saveAuthCode(authCode: AuthorizationCode): void {
    this.authCodes.set(authCode.code, authCode);
  }

  getAuthCode(code: string): AuthorizationCode | undefined {
    return this.authCodes.get(code);
  }

  markAuthCodeUsed(code: string): void {
    const authCode = this.authCodes.get(code);
    if (authCode) {
      authCode.used = true;
    }
  }

  deleteAuthCode(code: string): void {
    this.authCodes.delete(code);
  }

  // Token methods

  saveToken(entry: TokenEntry): void {
    this.tokens.set(entry.access_token, entry);
    if (entry.refresh_token) {
      this.refreshTokenIndex.set(entry.refresh_token, entry.access_token);
    }
  }

  getTokenByAccessToken(accessToken: string): TokenEntry | undefined {
    return this.tokens.get(accessToken);
  }

  getTokenByRefreshToken(refreshToken: string): TokenEntry | undefined {
    const accessToken = this.refreshTokenIndex.get(refreshToken);
    if (!accessToken) return undefined;
    return this.tokens.get(accessToken);
  }

  deleteToken(accessToken: string): void {
    const entry = this.tokens.get(accessToken);
    if (entry?.refresh_token) {
      this.refreshTokenIndex.delete(entry.refresh_token);
    }
    this.tokens.delete(accessToken);
  }

  deleteTokenByRefreshToken(refreshToken: string): void {
    const accessToken = this.refreshTokenIndex.get(refreshToken);
    if (accessToken) {
      this.deleteToken(accessToken);
    }
  }

  // Cleanup expired entries

  cleanupExpired(): void {
    const now = Date.now();

    // Cleanup expired pending auths
    for (const [state, pending] of this.pendingAuths) {
      if (now - pending.created_at > PENDING_AUTH_TTL) {
        this.pendingAuths.delete(state);
      }
    }

    // Cleanup expired auth codes
    for (const [code, authCode] of this.authCodes) {
      if (now > authCode.expires_at || authCode.used) {
        this.authCodes.delete(code);
      }
    }

    // Cleanup expired tokens (based on Firebase token expiration)
    for (const [accessToken, entry] of this.tokens) {
      if (now > entry.firebase_token_expires_at) {
        if (entry.refresh_token) {
          this.refreshTokenIndex.delete(entry.refresh_token);
        }
        this.tokens.delete(accessToken);
      }
    }
  }

  // Shutdown

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Singleton instance
export const oauthStore = new OAuthStore();
