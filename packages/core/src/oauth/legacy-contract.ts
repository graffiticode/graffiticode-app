// The legacy OAuth store's migration contract, version 1 (installations plan,
// P5: the OAuth-store handover).
//
// Today every OAuth record lives in the shared auth service. The handover moves
// each installation's records into its own database. The auth service is the
// authority for records it still holds, so the handover depends on what it
// promises here. This file is that promise, as an interface. Two
// implementations are held to it by one suite (legacy-contract-suite.ts):
//   - the stand-in (legacy-standin.ts), which this repo's tests run against;
//   - the real auth service, over HTTP (mcp-server/src/oauth/firestore-store.ts),
//     run by the same suite against a deployed service before migration can be
//     activated. Passing against the stand-in alone clears nothing.
//
// What the source promises:
//   - status: its contract version, and whether an installation is fenced
//     and whether it is sealed.
//   - Reads keep working, fenced or not. A token read also reports the
//     record's marks: whether it was revoked, and whether it was marked
//     migrated (and under which claim).
//   - The fence. Once an installation is fenced, the source refuses every
//     ordinary write for it (LegacyFenced): registering, saving or deleting a
//     pending authorization or a code, marking a code used, saving, rotating,
//     updating or deleting a token, through any route. The fence is never lifted.
//   - Migration operations. They are accepted only once the installation is
//     fenced (before that: refused, not_fenced), and are the only writes
//     accepted after it:
//       consume(kind, hash, claimId)   a code's or a pending authorization's
//                                      single use;
//       markMigrated(hash, mode, claimId)  a token record's single migration;
//       revoke(hash)                    a token record's revocation.
//     consume and markMigrated are compare-and-set, with three outcomes:
//       applied   the first time, and again for the same claimId (an
//                 idempotent acknowledgement, so a lost response can be
//                 recovered by retrying);
//       refused   for good: the record is revoked, absent, or already
//                 consumed or marked under another claim;
//       a throw   (LegacyTransient) when the outcome isn't known: a transport
//                 error, a 5xx, or any answer that isn't exactly one of the
//                 above (parseOutcome). Never a refusal.
//     revoke is idempotent; revoking an absent record is applied.
//   - The seal: the handoff that retires the fallback. Once an installation
//     is sealed, the source refuses every migration operation for it,
//     revocation included (refused, sealed), so no revocation can land there
//     and be stranded after the installation stops reading the source. The
//     installation applies every revocation the source holds after sealing,
//     and only then retires its fallback. The seal is never lifted either.
//   - Inventory: the installation's token records (each with its marks) and
//     clients, a page at a time.
//
// Records written before installations carry no installation. The source
// treats them as Graffiticode's, the only installation that had any.
//
// HTTP binding (v1), on the auth service, with the caller's internal
// credential; every body and answer is JSON:
//   GET  /oauth-migration/v1/status?installation=<id>   → { contract: 1, fenced: boolean, sealed: boolean }
//   POST /oauth-migration/v1/consume       { installation, kind, hash, claim_id }  → { outcome, reason? }
//   POST /oauth-migration/v1/mark-migrated { installation, hash, mode, claim_id }  → { outcome, reason? }
//   POST /oauth-migration/v1/revoke        { installation, hash }                  → { outcome, reason? }
//   GET  /oauth-migration/v1/inventory?installation=<id>&cursor=<c>  → { records, next }
//   POST /oauth-migration/v1/fence         { installation }  (operator only)       → { fenced: true }
//   POST /oauth-migration/v1/seal          { installation }  (operator only, once fenced) → { sealed: true }
// The existing token reads (/oauth-tokens/lookup) add `revoked` and `migration`
// ({ mode, claim_id } or null) to the token they return. Every ordinary write
// route answers 409 { error: "migration_fenced" } once the installation is
// fenced. A 5xx or a transport failure is LegacyTransient.
import type { AuthorizationCode, OAuthClient, PendingAuth, TokenEntry } from "./records.js";

export const LEGACY_CONTRACT_VERSION = 1;

export type MigrationMode = "rotation" | "import";
export type ConsumeKind = "code" | "pending";
export const REFUSAL_REASONS = ["revoked", "absent", "consumed", "claimed", "not_fenced", "sealed"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export type Outcome = { outcome: "applied" } | { outcome: "refused"; reason: RefusalReason };

// An answer is an outcome only if it is exactly one the contract defines.
// Anything else (an empty body, an unknown reason, a newer shape) is an
// unknown outcome: the caller must treat it as LegacyTransient, never as a
// refusal, because a refusal ends a credential for good.
export function parseOutcome(x: unknown): Outcome | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (o.outcome === "applied") return { outcome: "applied" };
  if (o.outcome === "refused" && (REFUSAL_REASONS as readonly unknown[]).includes(o.reason)) {
    return { outcome: "refused", reason: o.reason as RefusalReason };
  }
  return null;
}

// A token record as the source reports it.
export type LegacyToken = {
  entry: TokenEntry;
  revoked: boolean;
  migration: { mode: MigrationMode; claimId: string } | null;
};

export type InventoryRecord =
  | { kind: "token"; key: string; token: LegacyToken }
  | { kind: "client"; key: string; client: OAuthClient };

// A write the fence refused.
export class LegacyFenced extends Error {
  constructor(message = "The legacy OAuth store is fenced for this installation") {
    super(message);
    this.name = "LegacyFenced";
  }
}

// The source's answer isn't known (transport error, 5xx, timeout).
export class LegacyTransient extends Error {
  constructor(message = "The legacy OAuth store didn't answer") {
    super(message);
    this.name = "LegacyTransient";
  }
}

export interface LegacySource {
  status(installation: string): Promise<{ contract: number; fenced: boolean; sealed: boolean }>;

  // Reads: always available.
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  getPendingAuth(state: string): Promise<PendingAuth | undefined>;
  getAuthCode(code: string): Promise<AuthorizationCode | undefined>;
  getTokenByAccessToken(accessToken: string): Promise<LegacyToken | null>;
  getTokenByRefreshToken(refreshToken: string): Promise<LegacyToken | null>;

  // Ordinary writes: refused once fenced (LegacyFenced).
  registerClient(client: OAuthClient): Promise<void>;
  savePendingAuth(pending: PendingAuth): Promise<void>;
  deletePendingAuth(state: string): Promise<void>;
  saveAuthCode(code: AuthorizationCode): Promise<void>;
  markAuthCodeUsed(code: string): Promise<void>;
  deleteAuthCode(code: string): Promise<void>;
  saveToken(uid: string, email: string, entry: TokenEntry): Promise<void>;
  rotateTokens(oldRefreshToken: string, next: TokenEntry): Promise<void>;
  updateToken(accessToken: string, updates: Partial<TokenEntry>): Promise<void>;
  deleteToken(accessToken: string): Promise<void>;

  // Migration operations: only once fenced.
  consume(installation: string, kind: ConsumeKind, hash: string, claimId: string): Promise<Outcome>;
  markMigrated(installation: string, hash: string, mode: MigrationMode, claimId: string): Promise<Outcome>;
  // Applied (idempotent, absent included), or refused: sealed.
  revoke(installation: string, hash: string): Promise<Outcome>;
  inventory(installation: string, cursor?: string | null): Promise<{ records: InventoryRecord[]; next: string | null }>;
}
