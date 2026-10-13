/**
 * OAuth storage backed by the auth service API.
 *
 * All OAuth state — tokens, clients, pending authorizations, and authorization
 * codes — is persisted via HTTP to the auth service (Firestore). Nothing is
 * kept in this process's memory, so the flow survives multiple Cloud Run
 * instances and restarts.
 */

import type {
  OAuthClient,
  PendingAuth,
  AuthorizationCode,
  TokenEntry,
} from "./types.js";

const AUTH_URL = process.env.GRAFFITICODE_AUTH_URL || "https://auth.graffiticode.org";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// How long a pending authorization stays valid (used to set its expires_at).
const PENDING_AUTH_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Make authenticated HTTP request to auth service
 */
async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "X-Internal-API-Key": INTERNAL_API_KEY,
    },
  });
}

export class FirestoreOAuthStore {
  // ============ Generic OAuth flow record helpers (auth service) ============
  // Clients, pending auths, and auth codes are persisted via the auth service
  // (alongside tokens) so the OAuth flow survives multiple Cloud Run instances
  // and restarts. Each record is keyed by its natural id in a dedicated
  // collection: oauth-clients/<client_id>, oauth-pending/<state>,
  // oauth-codes/<code>. The auth service wraps the record as { data: { record } }.

  private async putFlowRecord(collection: string, key: string, record: unknown): Promise<void> {
    const response = await authFetch(
      `${AUTH_URL}/${collection}/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to save ${collection} record: ${await response.text()}`);
    }
  }

  private async getFlowRecord<T>(collection: string, key: string): Promise<T | undefined> {
    const response = await authFetch(`${AUTH_URL}/${collection}/${encodeURIComponent(key)}`);
    if (!response.ok) {
      if (response.status === 404) return undefined;
      throw new Error(`Failed to get ${collection} record: ${await response.text()}`);
    }
    const data = await response.json() as { data?: { record?: T } };
    return data.data?.record;
  }

  private async patchFlowRecord(collection: string, key: string, updates: unknown): Promise<void> {
    const response = await authFetch(
      `${AUTH_URL}/${collection}/${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }
    );
    // 404 is acceptable — the record may already be gone.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to update ${collection} record: ${await response.text()}`);
    }
  }

  private async deleteFlowRecord(collection: string, key: string): Promise<void> {
    const response = await authFetch(
      `${AUTH_URL}/${collection}/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete ${collection} record: ${await response.text()}`);
    }
  }

  // ==================== Client methods (persisted) ====================

  async registerClient(client: OAuthClient): Promise<void> {
    await this.putFlowRecord("oauth-clients", client.client_id, client);
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.getFlowRecord<OAuthClient>("oauth-clients", clientId);
  }

  async deleteClient(clientId: string): Promise<void> {
    await this.deleteFlowRecord("oauth-clients", clientId);
  }

  // ==================== Pending auth methods (persisted) ====================

  async savePendingAuth(pending: PendingAuth): Promise<void> {
    await this.putFlowRecord("oauth-pending", pending.state, {
      ...pending,
      expires_at: Date.now() + PENDING_AUTH_TTL,
    });
  }

  async getPendingAuth(state: string): Promise<PendingAuth | undefined> {
    return this.getFlowRecord<PendingAuth>("oauth-pending", state);
  }

  async deletePendingAuth(state: string): Promise<void> {
    await this.deleteFlowRecord("oauth-pending", state);
  }

  // ==================== Authorization code methods (persisted) ====================

  async saveAuthCode(authCode: AuthorizationCode): Promise<void> {
    // authCode.expires_at is set by the caller; the store honors it for lazy expiry.
    await this.putFlowRecord("oauth-codes", authCode.code, authCode);
  }

  async getAuthCode(code: string): Promise<AuthorizationCode | undefined> {
    return this.getFlowRecord<AuthorizationCode>("oauth-codes", code);
  }

  async markAuthCodeUsed(code: string): Promise<void> {
    await this.patchFlowRecord("oauth-codes", code, { used: true });
  }

  async deleteAuthCode(code: string): Promise<void> {
    await this.deleteFlowRecord("oauth-codes", code);
  }

  // ==================== Token methods (Firestore via auth service) ====================

  /**
   * Save a new token to Firestore.
   * @param providerId - The Google provider ID (Firebase UID from Google sign-in)
   * @param entry - The token entry to save
   */
  async saveToken(providerId: string, email: string, entry: TokenEntry): Promise<void> {
    const response = await authFetch(`${AUTH_URL}/oauth-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: providerId,
        email,
        access_token: entry.access_token,
        refresh_token: entry.refresh_token,
        firebase_id_token: entry.firebase_id_token,
        firebase_refresh_token: entry.firebase_refresh_token,
        firebase_token_expires_at: entry.firebase_token_expires_at,
        client_id: entry.client_id,
        client_name: entry.client_name,
        scope: entry.scope,
        resource: entry.resource,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to save token: ${error}`);
    }
  }

  /**
   * Get a token by its access token.
   */
  async getTokenByAccessToken(accessToken: string): Promise<TokenEntry | null> {
    // Tokens go in the body, never the URL: request URLs are logged.
    const response = await authFetch(`${AUTH_URL}/oauth-tokens/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.text();
      throw new Error(`Failed to get token: ${error}`);
    }

    const data = await response.json() as { data?: { token?: unknown } };
    return this.mapTokenResponse(data.data?.token);
  }

  /**
   * Get a token by its refresh token.
   */
  async getTokenByRefreshToken(refreshToken: string): Promise<TokenEntry | null> {
    const response = await authFetch(`${AUTH_URL}/oauth-tokens/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.text();
      throw new Error(`Failed to get token: ${error}`);
    }

    const data = await response.json() as { data?: { token?: unknown } };
    return this.mapTokenResponse(data.data?.token);
  }

  /**
   * Update token fields (e.g., after Firebase token refresh).
   */
  async updateToken(
    accessToken: string,
    updates: Partial<Pick<TokenEntry, "firebase_id_token" | "firebase_refresh_token" | "firebase_token_expires_at">>
  ): Promise<void> {
    const response = await authFetch(`${AUTH_URL}/oauth-tokens/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, access_token: accessToken }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update token: ${error}`);
    }
  }

  /**
   * Delete a token by its access token.
   */
  async deleteToken(accessToken: string): Promise<void> {
    const response = await authFetch(`${AUTH_URL}/oauth-tokens/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`Failed to delete token: ${error}`);
    }
  }

  /**
   * Rotate tokens (OAuth 2.1 refresh flow).
   * @param oldRefreshToken - The old refresh token to invalidate
   * @param newEntry - The new token entry
   */
  async rotateTokens(
    oldRefreshToken: string,
    newEntry: TokenEntry
  ): Promise<void> {
    const response = await authFetch(`${AUTH_URL}/oauth-tokens/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        old_refresh_token: oldRefreshToken,
        access_token: newEntry.access_token,
        refresh_token: newEntry.refresh_token,
        firebase_id_token: newEntry.firebase_id_token,
        firebase_refresh_token: newEntry.firebase_refresh_token,
        firebase_token_expires_at: newEntry.firebase_token_expires_at,
        client_id: newEntry.client_id,
        client_name: newEntry.client_name,
        scope: newEntry.scope,
        resource: newEntry.resource,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to rotate tokens: ${error}`);
    }
  }

  /**
   * Map auth service response to TokenEntry
   */
  private mapTokenResponse(token: any): TokenEntry | null {
    if (!token) return null;

    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      client_id: token.client_id,
      client_name: token.client_name,
      scope: token.scope,
      firebase_id_token: token.firebase_id_token,
      firebase_refresh_token: token.firebase_refresh_token,
      firebase_token_expires_at: token.firebase_token_expires_at,
      resource: token.resource,
      created_at: token.created_at,
    };
  }

  // ==================== Shutdown ====================

  shutdown(): void {
    // No in-process timers to clear; OAuth flow records expire in Firestore
    // (lazy expiry on read, plus an optional Firestore TTL policy on expires_at).
  }
}

// Singleton instance
export const oauthStore = new FirestoreOAuthStore();
