/**
 * The shared auth service's OAuth store, over HTTP: the legacy store of the
 * installations plan's OAuth-store handover (P5), implementing its migration
 * contract (core/src/oauth/legacy-contract.ts, HTTP binding v1).
 *
 * The ordinary routes are today's, unchanged. What the contract adds: a write
 * the fence refuses (409 migration_fenced) throws LegacyFenced; an answer that
 * isn't known (a transport failure or a 5xx) throws LegacyTransient; token
 * reads carry the record's marks; and the migration operations.
 *
 * Which store the authorization server uses is decided once, at first use
 * (selectedOAuthStore): this one alone (legacy, the default), the
 * installation's own (local), or both during the migration (migrating).
 */

import { installationHosts } from "@graffiticode-app/core/profile/runtime";
import {
  LegacyFenced, LegacyTransient, parseOutcome,
  type ConsumeKind, type InventoryRecord, type LegacySource, type LegacyToken, type MigrationMode, type Outcome,
} from "@graffiticode-app/core/oauth/legacy-contract";
import { LocalOAuthStore } from "@graffiticode-app/core/oauth/local-store";
import {
  InstallationOAuthStore, LegacyOAuthStore, MigratingOAuthStore, oauthStoreMode, type StoreMode,
} from "@graffiticode-app/core/oauth/store";
import { LEGACY_INSTALLATION_ID, type OAuthStore } from "@graffiticode-app/core/oauth/records";
import type {
  OAuthClient,
  PendingAuth,
  AuthorizationCode,
  TokenEntry,
} from "./types.js";

// The auth service holds the legacy store.
const authUrl = () => installationHosts().auth;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// How long a pending authorization stays valid (used to set its expires_at).
const PENDING_AUTH_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Make authenticated HTTP request to auth service. A transport failure or a
 * 5xx is an unknown outcome (LegacyTransient); a refusal by the fence is
 * LegacyFenced. Anything else is the caller's to read.
 */
async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        "X-Internal-API-Key": INTERNAL_API_KEY,
      },
    });
  } catch (err) {
    throw new LegacyTransient(`auth service unreachable: ${(err as Error)?.message ?? err}`);
  }
  if (response.status >= 500) throw new LegacyTransient(`auth service answered ${response.status}`);
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as { error?: string } | null;
    if (body?.error === "migration_fenced") throw new LegacyFenced();
  }
  return response;
}

// A contract call's answer, unvalidated. Not a 2xx, or not JSON: the outcome
// isn't known (LegacyTransient); each caller then checks the shape.
async function contractCall(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await authFetch(`${authUrl()}/oauth-migration/v1/${path}`, init);
  if (!response.ok) throw new LegacyTransient(`oauth-migration ${path}: ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new LegacyTransient(`oauth-migration ${path}: the answer isn't JSON`);
  }
}
async function outcomeCall(path: string, init: RequestInit): Promise<Outcome> {
  const out = parseOutcome(await contractCall(path, init));
  if (!out) throw new LegacyTransient(`oauth-migration ${path}: unrecognized answer`);
  return out;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export class FirestoreOAuthStore implements LegacySource {
  // ============ Generic OAuth flow record helpers (auth service) ============
  // Clients, pending auths, and auth codes are persisted via the auth service
  // (alongside tokens) so the OAuth flow survives multiple Cloud Run instances
  // and restarts. Each record is keyed by its natural id in a dedicated
  // collection: oauth-clients/<client_id>, oauth-pending/<state>,
  // oauth-codes/<code>. The auth service wraps the record as { data: { record } }.

  private async putFlowRecord(collection: string, key: string, record: unknown): Promise<void> {
    const response = await authFetch(
      `${authUrl()}/${collection}/${encodeURIComponent(key)}`,
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
    const response = await authFetch(`${authUrl()}/${collection}/${encodeURIComponent(key)}`);
    if (!response.ok) {
      if (response.status === 404) return undefined;
      throw new Error(`Failed to get ${collection} record: ${await response.text()}`);
    }
    const data = await response.json() as { data?: { record?: T } };
    return data.data?.record;
  }

  private async patchFlowRecord(collection: string, key: string, updates: unknown): Promise<void> {
    const response = await authFetch(
      `${authUrl()}/${collection}/${encodeURIComponent(key)}`,
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
      `${authUrl()}/${collection}/${encodeURIComponent(key)}`,
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
    const response = await authFetch(`${authUrl()}/oauth-tokens`, {
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
  async getTokenByAccessToken(accessToken: string): Promise<LegacyToken | null> {
    // Tokens go in the body, never the URL: request URLs are logged.
    const response = await authFetch(`${authUrl()}/oauth-tokens/lookup`, {
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
  async getTokenByRefreshToken(refreshToken: string): Promise<LegacyToken | null> {
    const response = await authFetch(`${authUrl()}/oauth-tokens/lookup`, {
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
    const response = await authFetch(`${authUrl()}/oauth-tokens/update`, {
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
    const response = await authFetch(`${authUrl()}/oauth-tokens/delete`, {
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
    const response = await authFetch(`${authUrl()}/oauth-tokens/rotate`, {
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
  private mapTokenResponse(token: any): LegacyToken | null {
    if (!token) return null;
    // Marks (contract v1); a service that predates them reports none.
    const migration = token.migration?.mode && token.migration?.claim_id
      ? { mode: token.migration.mode as MigrationMode, claimId: String(token.migration.claim_id) }
      : null;
    return { revoked: token.revoked === true, migration, entry: this.mapEntry(token) };
  }

  private mapEntry(token: any): TokenEntry {
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

  // ==================== Migration contract (v1) ====================

  async status(installation: string): Promise<{ contract: number; fenced: boolean; sealed: boolean }> {
    const r = await contractCall(`status?installation=${encodeURIComponent(installation)}`) as any;
    if (!Number.isInteger(r?.contract) || typeof r?.fenced !== "boolean" || typeof r?.sealed !== "boolean") throw new LegacyTransient("oauth-migration status: unrecognized answer");
    return { contract: r.contract, fenced: r.fenced, sealed: r.sealed };
  }

  consume(installation: string, kind: ConsumeKind, hash: string, claimId: string): Promise<Outcome> {
    return outcomeCall("consume", post({ installation, kind, hash, claim_id: claimId }));
  }

  markMigrated(installation: string, hash: string, mode: MigrationMode, claimId: string): Promise<Outcome> {
    return outcomeCall("mark-migrated", post({ installation, hash, mode, claim_id: claimId }));
  }

  revoke(installation: string, hash: string): Promise<Outcome> {
    return outcomeCall("revoke", post({ installation, hash }));
  }

  async inventory(installation: string, cursor?: string | null): Promise<{ records: InventoryRecord[]; next: string | null }> {
    const q = new URLSearchParams({ installation, ...(cursor ? { cursor } : {}) });
    const r = await contractCall(`inventory?${q}`) as any;
    const known = (x: any) => (x?.kind === "client" && x.client?.client_id) || (x?.kind === "token" && x.token?.access_token);
    if (!Array.isArray(r?.records) || !r.records.every((x: any) => typeof x?.key === "string" && known(x)) || (r.next != null && typeof r.next !== "string")) {
      throw new LegacyTransient("oauth-migration inventory: unrecognized answer");
    }
    return {
      next: r.next ?? null,
      records: r.records.map((x: any) => x.kind === "client"
        ? { kind: "client" as const, key: String(x.key), client: x.client as OAuthClient }
        : { kind: "token" as const, key: String(x.key), token: this.mapTokenResponse(x.token)! }),
    };
  }

  // The operator's fence; the contract suite sets it on a disposable service.
  async fence(installation: string): Promise<void> {
    await contractCall("fence", post({ installation }));
  }

  // The operator's seal, which hands revocation over to the installation.
  async seal(installation: string): Promise<void> {
    await contractCall("seal", post({ installation }));
  }

  // ==================== Shutdown ====================

  shutdown(): void {
    // No in-process timers to clear; OAuth flow records expire in Firestore
    // (lazy expiry on read, plus an optional Firestore TTL policy on expires_at).
  }
}

// ==================== The store the authorization server uses ====================

export const legacySource = new FirestoreOAuthStore();

let selected: { mode: StoreMode; store: OAuthStore } | null = null;

// Decided once, at first use, from OAUTH_STORE (core/src/oauth/store.ts). An
// invalid configuration throws; the server checks it at startup.
export function selectedOAuthStore(): { mode: StoreMode; store: OAuthStore } {
  if (selected) return selected;
  const mode = oauthStoreMode(process.env, installationHosts().issuer);
  const log = (msg: string) => console.log(msg);
  const store: OAuthStore = mode === "legacy" ? new LegacyOAuthStore(legacySource)
    : mode === "local" ? new InstallationOAuthStore(new LocalOAuthStore())
      : new MigratingOAuthStore(new LocalOAuthStore(), legacySource, LEGACY_INSTALLATION_ID, { log });
  return (selected = { mode, store });
}

// Tests supply their own; null returns to the configured one.
export function setOAuthStore(store: OAuthStore | null, mode: StoreMode = "legacy") {
  selected = store ? { mode, store } : null;
}

// What /health reports: the mode, and whether a migrating store has seen the fence.
export function oauthStoreStatus() {
  const s = selectedOAuthStore();
  return { mode: s.mode, ...(s.store instanceof MigratingOAuthStore ? { migrating: s.store.activation.latched } : {}) };
}

// The store, resolved on each call.
export const oauthStore: OAuthStore = new Proxy({} as OAuthStore, {
  get: (_target, name) => (...args: unknown[]) => (selectedOAuthStore().store as any)[name](...args),
});
