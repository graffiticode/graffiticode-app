// The installation's own OAuth store (installations plan, P5: the OAuth-store
// handover), in the installation's database. Documents are keyed by a
// credential's hash, never the credential. Single use (codes, pending
// authorizations) and rotation are transactions, so two callers can't both win.
//
// It also keeps the migration's own records:
//   oauth_migrations/<legacy token key>  one per legacy token, created only if
//     absent: { mode, state: prepared | acknowledged | confirmed | tombstoned |
//     revoked, claimId, original, pair? }. Acknowledged: the source marked it
//     under this claim, and it hasn't been validated there since. A token
//     becomes live here only when its record is confirmed (confirmMigration,
//     allowed only from acknowledged, after that validation), which writes its
//     token documents in the same transaction, each tagged with the record's key as its
//     family; a local rotation carries the family on. Revoking the record
//     (revokeMigration) is final: it blocks confirmation, and deletes every
//     live token of the family in the same transaction.
//   oauth_legacy_claims/<kind>:<hash>    one per legacy code or pending
//     authorization used through the fallback: { state: prepared | consumed |
//     tombstoned, claimId, expires_at }. Only the transaction that moves it to
//     consumed hands the record to its caller.
//
// Expiry. Pending authorizations, codes and claims expire; nothing else here
// does. Each carries two fields:
//   expires_at  epoch milliseconds: the credential's own expiry, the only one
//               validation reads, and enforced on every read, however late
//               cleanup runs. A claim takes its credential's expiry when it is
//               created, and nothing (a retry, a settlement) changes it.
//   expireAt    a Firestore Timestamp for the TTL policy (storage-ttl.ts):
//               expires_at plus CLEANUP_GRACE_MS. Cleanup never comes before
//               the credential stopped being usable, even with clock skew.
import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../db.js";
import type { ConsumeKind, MigrationMode } from "./legacy-contract.js";
import {
  CredentialRefused, credentialHash,
  type AuthorizationCode, type FirebaseUpdate, type OAuthClient, type PendingAuth, type TokenEntry,
} from "./records.js";

export const COLLECTIONS = {
  clients: "oauth_clients",
  pending: "oauth_pending",
  codes: "oauth_codes",
  tokens: "oauth_tokens",
  refresh: "oauth_refresh",
  migrations: "oauth_migrations",
  claims: "oauth_legacy_claims",
} as const;

export const PENDING_TTL_MS = 10 * 60 * 1000;
// How long after a credential expires its document may be cleaned up.
export const CLEANUP_GRACE_MS = 60 * 60 * 1000;
export const cleanupAt = (expiresAtMs: number) => Timestamp.fromMillis(expiresAtMs + CLEANUP_GRACE_MS);

// When a legacy code or pending authorization stops being usable: a code's own
// expiry; a pending authorization's recorded one (the auth service stores
// expires_at), else ten minutes from its creation, as it was issued.
export function credentialExpiry(kind: ConsumeKind, record: AuthorizationCode | PendingAuth): number {
  if (kind === "code") return (record as AuthorizationCode).expires_at;
  const recorded = (record as PendingAuth & { expires_at?: number }).expires_at;
  return typeof recorded === "number" ? recorded : (record as PendingAuth).created_at + PENDING_TTL_MS;
}

export type MigrationState = "prepared" | "acknowledged" | "confirmed" | "tombstoned" | "revoked";
export type MigrationRecord = {
  key: string;
  mode: MigrationMode;
  state: MigrationState;
  claimId: string;
  // The legacy token as the source held it (absent on a record made only to
  // revoke a token never seen here).
  original?: TokenEntry;
  // For a rotation: the one replacement pair, chosen when it was prepared.
  pair?: TokenEntry;
  created_at: number;
  updated_at: number;
};
export type ClaimState = "prepared" | "consumed" | "tombstoned";
// `record`: the code or pending authorization as the source held it when
// claimed, since once consumed there the source reads it as used or gone.
export type LegacyClaim<T = AuthorizationCode | PendingAuth> = { kind: ConsumeKind; hash: string; state: ClaimState; claimId: string; record: T; expires_at: number; updated_at: number };

// What a transaction and a batch have in common, for writing token documents.
type Writer = { set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): unknown; delete(ref: FirebaseFirestore.DocumentReference): unknown };

// Firestore drops undefined fields only when told to; strip them here.
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export class LocalOAuthStore {
  constructor(private readonly firestore: () => FirebaseFirestore.Firestore = db, private readonly now: () => number = Date.now) {}

  private col(name: keyof typeof COLLECTIONS) {
    return this.firestore().collection(COLLECTIONS[name]);
  }

  // --- clients -------------------------------------------------------------

  async registerClient(client: OAuthClient) {
    await this.col("clients").doc(client.client_id).set(plain(client));
  }
  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    const s = await this.col("clients").doc(clientId).get();
    return s.exists ? (s.data() as OAuthClient) : undefined;
  }
  // A copy from the legacy store: never overwrites. True if it was copied now.
  async copyClient(client: OAuthClient): Promise<boolean> {
    try {
      await this.col("clients").doc(client.client_id).create(plain(client));
      return true;
    } catch (err: any) {
      if (err?.code === 6) return false; // ALREADY_EXISTS
      throw err;
    }
  }

  // --- pending authorizations ----------------------------------------------

  async savePendingAuth(pending: PendingAuth) {
    const expires_at = this.now() + PENDING_TTL_MS;
    await this.col("pending").doc(credentialHash(pending.state)).set({ ...plain({ ...pending, expires_at }), expireAt: cleanupAt(expires_at) });
  }
  async getPendingAuth(state: string): Promise<PendingAuth | undefined> {
    const s = await this.col("pending").doc(credentialHash(state)).get();
    const d = s.data() as (PendingAuth & { expires_at: number }) | undefined;
    return d && d.expires_at > this.now() ? stripExpiry(d) : undefined;
  }
  async takePendingAuth(state: string): Promise<PendingAuth | undefined> {
    const ref = this.col("pending").doc(credentialHash(state));
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const d = s.data() as (PendingAuth & { expires_at: number }) | undefined;
      if (!d) return undefined;
      tx.delete(ref);
      return d.expires_at > this.now() ? stripExpiry(d) : undefined;
    });
  }
  async hasPendingAuth(state: string) {
    return (await this.col("pending").doc(credentialHash(state)).get()).exists;
  }

  // --- codes ---------------------------------------------------------------

  async saveAuthCode(code: AuthorizationCode) {
    await this.col("codes").doc(credentialHash(code.code)).set({ ...plain(code), expireAt: cleanupAt(code.expires_at) });
  }
  // Returned expired too: the token endpoint checks expires_at and says so.
  async getAuthCode(code: string): Promise<AuthorizationCode | undefined> {
    const s = await this.col("codes").doc(credentialHash(code)).get();
    return s.exists ? stripCleanup(s.data() as AuthorizationCode) : undefined;
  }
  async consumeAuthCode(code: string): Promise<boolean> {
    const ref = this.col("codes").doc(credentialHash(code));
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const d = s.data() as AuthorizationCode | undefined;
      if (!d || d.used || d.expires_at <= this.now()) return false;
      tx.update(ref, { used: true });
      return true;
    });
  }
  async deleteAuthCode(code: string) {
    await this.col("codes").doc(credentialHash(code)).delete();
  }

  // --- tokens --------------------------------------------------------------

  // `family`: the migration record a token descends from, if any.
  private writeToken(tx: Writer, entry: TokenEntry, uid?: string, family?: string) {
    const accessHash = credentialHash(entry.access_token);
    tx.set(this.col("tokens").doc(accessHash), plain({ ...entry, ...(uid ? { uid } : {}), ...(family ? { family } : {}) }));
    if (entry.refresh_token) tx.set(this.col("refresh").doc(credentialHash(entry.refresh_token)), { access_hash: accessHash });
  }
  private deleteTokenDocs(tx: Writer, entry: TokenEntry) {
    tx.delete(this.col("tokens").doc(credentialHash(entry.access_token)));
    if (entry.refresh_token) tx.delete(this.col("refresh").doc(credentialHash(entry.refresh_token)));
  }

  async saveToken(uid: string, entry: TokenEntry) {
    const batch = this.firestore().batch();
    this.writeToken(batch, entry, uid);
    await batch.commit();
  }
  async getTokenByAccessToken(accessToken: string): Promise<TokenEntry | null> {
    const s = await this.col("tokens").doc(credentialHash(accessToken)).get();
    return s.exists ? stripUid(s.data() as TokenEntry) : null;
  }
  async getTokenByRefreshToken(refreshToken: string): Promise<TokenEntry | null> {
    const idx = await this.col("refresh").doc(credentialHash(refreshToken)).get();
    if (!idx.exists) return null;
    const s = await this.col("tokens").doc(idx.data()!.access_hash).get();
    return s.exists ? stripUid(s.data() as TokenEntry) : null;
  }
  async hasRefreshToken(refreshToken: string) {
    return (await this.col("refresh").doc(credentialHash(refreshToken)).get()).exists;
  }
  // Exactly one caller rotates a refresh token; any other is refused.
  async rotateTokens(oldRefreshToken: string, next: TokenEntry): Promise<TokenEntry> {
    const idxRef = this.col("refresh").doc(credentialHash(oldRefreshToken));
    return this.firestore().runTransaction(async tx => {
      const idx = await tx.get(idxRef);
      if (!idx.exists) throw new CredentialRefused("The refresh token was already used");
      const oldRef = this.col("tokens").doc(idx.data()!.access_hash);
      const old = await tx.get(oldRef);
      tx.delete(idxRef);
      if (old.exists) tx.delete(oldRef);
      this.writeToken(tx, next, (old.data() as any)?.uid, (old.data() as any)?.family);
      return next;
    });
  }
  async updateToken(accessToken: string, updates: FirebaseUpdate) {
    await this.col("tokens").doc(credentialHash(accessToken)).update(plain(updates));
  }
  async deleteToken(accessToken: string) {
    const ref = this.col("tokens").doc(credentialHash(accessToken));
    await this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      if (s.exists) this.deleteTokenDocs(tx, s.data() as TokenEntry);
    });
  }

  // --- migration records ---------------------------------------------------

  async getMigration(key: string): Promise<MigrationRecord | null> {
    const s = await this.col("migrations").doc(key).get();
    return s.exists ? (s.data() as MigrationRecord) : null;
  }

  // Create the token's one migration record if it has none, in one
  // transaction; return whichever record exists afterwards. `beforeCommit`
  // runs inside the transaction (tests use it to fail there).
  async prepareMigration(key: string, mode: MigrationMode, original: TokenEntry, pair?: TokenEntry, beforeCommit?: () => void): Promise<{ record: MigrationRecord; created: boolean }> {
    const ref = this.col("migrations").doc(key);
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      if (s.exists) return { record: s.data() as MigrationRecord, created: false };
      const t = this.now();
      const record: MigrationRecord = plain({ key, mode, state: "prepared", claimId: randomUUID(), original, ...(pair ? { pair } : {}), created_at: t, updated_at: t });
      tx.create(ref, record);
      beforeCommit?.();
      return { record, created: true };
    });
  }

  // The source acknowledged this record's claim. Nothing is live yet.
  async acknowledgeMigration(key: string, claimId: string): Promise<MigrationRecord> {
    const ref = this.col("migrations").doc(key);
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const r = s.data() as MigrationRecord | undefined;
      if (!r || r.claimId !== claimId) throw new Error(`No migration record ${key} under claim ${claimId}`);
      if (r.state === "acknowledged" || r.state === "confirmed") return r;
      if (r.state !== "prepared") throw new CredentialRefused("The legacy token can't be migrated");
      const done = { ...r, state: "acknowledged" as const, updated_at: this.now() };
      tx.set(ref, done);
      return done;
    });
  }

  // The source acknowledged this record's claim and was then found to still
  // hold the token unrevoked under it: activate its credential, once.
  async confirmMigration(key: string, claimId: string): Promise<MigrationRecord> {
    const ref = this.col("migrations").doc(key);
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const r = s.data() as MigrationRecord | undefined;
      if (!r || r.claimId !== claimId) throw new Error(`No migration record ${key} under claim ${claimId}`);
      if (r.state === "confirmed") return r;
      if (r.state !== "acknowledged") throw new CredentialRefused("The legacy token can't be migrated");
      if (r.mode === "rotation") this.writeToken(tx, r.pair!, undefined, key);
      else this.writeToken(tx, r.original!, undefined, key);
      const done = { ...r, state: "confirmed" as const, updated_at: this.now() };
      tx.set(ref, done);
      return done;
    });
  }

  // The source refused this record's claim for good: its credential never goes live.
  async tombstoneMigration(key: string, claimId: string): Promise<void> {
    const ref = this.col("migrations").doc(key);
    await this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const r = s.data() as MigrationRecord | undefined;
      if (!r || r.claimId !== claimId || (r.state !== "prepared" && r.state !== "acknowledged")) return;
      tx.update(ref, { state: "tombstoned", updated_at: this.now() });
    });
  }

  // Revoke a legacy token's migration for good, whatever its state, before
  // the source is told: no later confirmation activates anything, and every
  // live token descended from it is deleted, in one transaction. A token
  // never seen here gets a record that says so.
  async revokeMigration(key: string): Promise<void> {
    const ref = this.col("migrations").doc(key);
    const family = this.col("tokens").where("family", "==", key);
    await this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const live = await tx.get(family);
      for (const d of live.docs) this.deleteTokenDocs(tx, d.data() as TokenEntry);
      const t = this.now();
      if (s.exists) tx.update(ref, { state: "revoked", updated_at: t });
      else tx.create(ref, { key, mode: "import", state: "revoked", claimId: "", created_at: t, updated_at: t });
    });
  }

  async confirmedMigrations(): Promise<MigrationRecord[]> {
    const q = await this.col("migrations").where("state", "==", "confirmed").get();
    return q.docs.map(d => d.data() as MigrationRecord);
  }

  // Records not yet decided: prepared or acknowledged.
  async preparedMigrations(limit = 500): Promise<MigrationRecord[]> {
    const q = await this.col("migrations").where("state", "in", ["prepared", "acknowledged"]).limit(limit).get();
    return q.docs.map(d => d.data() as MigrationRecord);
  }

  // How many live tokens descend from a migration record.
  async liveDescendants(key: string): Promise<number> {
    return (await this.col("tokens").where("family", "==", key).get()).size;
  }

  // --- legacy single-use claims --------------------------------------------

  private claimRef(kind: ConsumeKind, hash: string) {
    return this.col("claims").doc(`${kind}:${hash}`);
  }
  // Returned expired too: the caller checks expires_at (a claim outlives its
  // credential's use only until cleanup).
  async getClaim(kind: ConsumeKind, hash: string): Promise<LegacyClaim | null> {
    const s = await this.claimRef(kind, hash).get();
    return s.exists ? stripCleanup(s.data() as LegacyClaim) : null;
  }
  // The one claim on a legacy code or pending authorization, created if absent.
  async claim(kind: ConsumeKind, hash: string, record: AuthorizationCode | PendingAuth): Promise<LegacyClaim> {
    const ref = this.claimRef(kind, hash);
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      if (s.exists) return stripCleanup(s.data() as LegacyClaim);
      const expires_at = credentialExpiry(kind, record);
      const c: LegacyClaim = plain({ kind, hash, state: "prepared", claimId: randomUUID(), record, expires_at, updated_at: this.now() });
      tx.create(ref, { ...c, expireAt: cleanupAt(expires_at) });
      return c;
    });
  }
  // Settle a prepared claim. True only for the call that moved it.
  async settleClaim(kind: ConsumeKind, hash: string, claimId: string, state: "consumed" | "tombstoned"): Promise<boolean> {
    const ref = this.claimRef(kind, hash);
    return this.firestore().runTransaction(async tx => {
      const s = await tx.get(ref);
      const c = s.data() as LegacyClaim | undefined;
      if (!c || c.claimId !== claimId || c.state !== "prepared") return false;
      tx.update(ref, { state, updated_at: this.now() });
      return true;
    });
  }
}

function stripExpiry(d: PendingAuth & { expires_at?: number; expireAt?: unknown }): PendingAuth {
  const { expires_at: _e, expireAt: _c, ...rest } = d;
  return rest;
}
function stripCleanup<T>(d: T & { expireAt?: unknown }): T {
  const { expireAt: _c, ...rest } = d;
  return rest as T;
}
function stripUid(d: TokenEntry & { uid?: string; family?: string }): TokenEntry {
  const { uid: _u, family: _f, ...rest } = d;
  return rest;
}
