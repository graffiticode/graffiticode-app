// Which OAuth store the authorization server uses, and the migration between
// them (installations plan, P5: the OAuth-store handover).
//
// Modes (OAUTH_STORE, read once at startup by oauthStoreMode):
//   legacy     today: every record in the shared auth service. The default, so
//              deploying this code changes nothing.
//   migrating  Graffiticode only, and only once the operator has verified the
//              auth service against the migration contract
//              (OAUTH_MIGRATION_VERIFIED_CONTRACT names the version verified).
//              It is armed, not active: it keeps behaving as legacy until the
//              source itself reports the installation fenced, under the
//              contract version verified. Then it latches, for the process's
//              life: new records are written locally, and lookups read
//              locally first and fall back to the legacy store. A legacy write
//              refused by the fence latches it too (after the same check) and
//              is redone locally.
//   local      the installation's own store, with no fallback: every
//              installation but Graffiticode, and Graffiticode once the
//              inventory finds nothing left unmigrated
//              (OAUTH_LEGACY_FALLBACK_RETIRED=1).
//
// The order the plan requires is enforced where it can be: the migration
// operations only work once the source is fenced, and this store only uses
// them once it has seen the fence. What can't be checked from here (that old
// revisions were drained before the fence was set) is the runbook's.
//
// Through the fallback, a legacy credential is used once, through a record
// created here first:
//   - a refresh token: a migration record (prepared, with the one replacement
//     pair), then markMigrated at the source; only a confirmation activates
//     the pair, and every refresh of that token (concurrent or retried) gets
//     that same pair while it is unused;
//   - a code or a pending authorization: a claim, then consume at the source;
//     only the caller that settles the claim gets the record.
// A source refusal ends them for good (tombstoned, or invalid_grant); an
// unknown outcome leaves them prepared, answers StoreUnavailable, and the
// client's retry, or the sweeper, completes them under the same claim.
import { LEGACY_CONTRACT_VERSION, LegacyFenced, LegacyTransient, parseOutcome, type ConsumeKind, type LegacySource, type LegacyToken, type Outcome } from "./legacy-contract.js";
import { LocalOAuthStore, credentialExpiry, type MigrationRecord } from "./local-store.js";
import {
  CredentialRefused, LEGACY_ISSUER, StoreUnavailable, credentialHash, tokenKey,
  type AuthorizationCode, type FirebaseUpdate, type OAuthClient, type OAuthStore, type PendingAuth, type TokenEntry,
} from "./records.js";

export type StoreMode = "legacy" | "migrating" | "local";

export class OAuthStoreConfigError extends Error {
  constructor(message: string) {
    super(`OAuth store: ${message}`);
    this.name = "OAuthStoreConfigError";
  }
}

// The mode this process runs in, or why it can't start.
export function oauthStoreMode(env: Record<string, string | undefined>, issuer: string): StoreMode {
  const mode = (env.OAUTH_STORE ?? "legacy").trim() || "legacy";
  if (mode === "legacy") return "legacy";
  if (mode === "migrating") {
    if (issuer !== LEGACY_ISSUER) {
      throw new OAuthStoreConfigError(`migrating is Graffiticode's (issuer ${LEGACY_ISSUER}); this installation's issuer is ${issuer}. Use local.`);
    }
    if (env.OAUTH_MIGRATION_VERIFIED_CONTRACT !== String(LEGACY_CONTRACT_VERSION)) {
      throw new OAuthStoreConfigError(`migrating needs OAUTH_MIGRATION_VERIFIED_CONTRACT=${LEGACY_CONTRACT_VERSION}, set once the auth service has passed the migration contract suite.`);
    }
    return "migrating";
  }
  if (mode === "local") {
    if (issuer === LEGACY_ISSUER && env.OAUTH_LEGACY_FALLBACK_RETIRED !== "1") {
      throw new OAuthStoreConfigError("Graffiticode's records are in the legacy store until migrated: use migrating, or set OAUTH_LEGACY_FALLBACK_RETIRED=1 once the inventory finds nothing unmigrated.");
    }
    return "local";
  }
  throw new OAuthStoreConfigError(`unknown OAUTH_STORE=${mode} (legacy, migrating or local)`);
}

const settle = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch (err) {
    if (err instanceof LegacyTransient) throw new StoreUnavailable(err.message);
    throw err;
  }
};
const usable = (t: LegacyToken | null) => (t && !t.revoked && !t.migration ? t : null);
// Through the fallback by access token: only one that still authenticates there.
const usableAccess = (t: LegacyToken | null) => (t && t.accessUsable ? t : null);
// Only an outcome the contract defines decides anything; any other answer is unknown.
const decided = (x: unknown): Outcome => {
  const out = parseOutcome(x);
  if (!out) throw new StoreUnavailable("The legacy store's answer wasn't recognized");
  return out;
};
// Until when an issued access token is good (55 minutes from issue when not recorded).
const accessExpiry = (t: TokenEntry) => t.access_token_expires_at ?? t.created_at + 55 * 60 * 1000;

// --- legacy: the shared auth service, as today --------------------------------

export class LegacyOAuthStore implements OAuthStore {
  constructor(private readonly source: LegacySource) {}
  registerClient(c: OAuthClient) { return this.source.registerClient(c); }
  getClient(id: string) { return this.source.getClient(id); }
  savePendingAuth(p: PendingAuth) { return this.source.savePendingAuth(p); }
  getPendingAuth(state: string) { return this.source.getPendingAuth(state); }
  async takePendingAuth(state: string) {
    const p = await this.source.getPendingAuth(state);
    if (p) await this.source.deletePendingAuth(state);
    return p;
  }
  saveAuthCode(c: AuthorizationCode) { return this.source.saveAuthCode(c); }
  getAuthCode(code: string) { return this.source.getAuthCode(code); }
  async consumeAuthCode(code: string) {
    await this.source.markAuthCodeUsed(code);
    return true;
  }
  deleteAuthCode(code: string) { return this.source.deleteAuthCode(code); }
  saveToken(uid: string, email: string, entry: TokenEntry) { return this.source.saveToken(uid, email, entry); }
  async getTokenByAccessToken(at: string) { return usable(await this.source.getTokenByAccessToken(at))?.entry ?? null; }
  async getTokenByRefreshToken(rt: string) { return usable(await this.source.getTokenByRefreshToken(rt))?.entry ?? null; }
  async rotateTokens(old: string, next: TokenEntry) {
    await this.source.rotateTokens(old, next);
    return next;
  }
  updateToken(at: string, u: FirebaseUpdate) { return this.source.updateToken(at, u); }
  deleteToken(at: string) { return this.source.deleteToken(at); }
}

// --- local: the installation's own store ---------------------------------------

export class InstallationOAuthStore implements OAuthStore {
  constructor(private readonly local: LocalOAuthStore) {}
  registerClient(c: OAuthClient) { return this.local.registerClient(c); }
  getClient(id: string) { return this.local.getClient(id); }
  savePendingAuth(p: PendingAuth) { return this.local.savePendingAuth(p); }
  getPendingAuth(state: string) { return this.local.getPendingAuth(state); }
  takePendingAuth(state: string) { return this.local.takePendingAuth(state); }
  saveAuthCode(c: AuthorizationCode) { return this.local.saveAuthCode(c); }
  getAuthCode(code: string) { return this.local.getAuthCode(code); }
  consumeAuthCode(code: string) { return this.local.consumeAuthCode(code); }
  deleteAuthCode(code: string) { return this.local.deleteAuthCode(code); }
  saveToken(uid: string, _email: string, entry: TokenEntry) { return this.local.saveToken(uid, entry); }
  getTokenByAccessToken(at: string) { return this.local.getTokenByAccessToken(at); }
  getTokenByRefreshToken(rt: string) { return this.local.getTokenByRefreshToken(rt); }
  rotateTokens(old: string, next: TokenEntry) { return this.local.rotateTokens(old, next); }
  updateToken(at: string, u: FirebaseUpdate) { return this.local.updateToken(at, u); }
  deleteToken(at: string) { return this.local.deleteToken(at); }
}

// --- the activation gate --------------------------------------------------------

export class Activation {
  latched = false;
  private checkedAt = -Infinity;
  constructor(
    private readonly source: LegacySource,
    private readonly installation: string,
    private readonly opts: { pollMs?: number; now?: () => number; log?: (msg: string) => void } = {},
  ) {}

  private async observe(): Promise<boolean> {
    const s = await this.source.status(this.installation);
    if (!s.fenced) return false;
    if (s.contract !== LEGACY_CONTRACT_VERSION) {
      this.opts.log?.(`[oauth-store] the legacy store is fenced under contract ${s.contract}; this release speaks ${LEGACY_CONTRACT_VERSION}. Not migrating.`);
      return false;
    }
    if (!this.latched) this.opts.log?.("[oauth-store] the legacy store is fenced: migrating");
    this.latched = true;
    return true;
  }

  // Whether to migrate now. Asks the source at most every pollMs; a source
  // that doesn't answer leaves things as they are.
  async active(): Promise<boolean> {
    if (this.latched) return true;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.checkedAt < (this.opts.pollMs ?? 30_000)) return false;
    this.checkedAt = now;
    try {
      return await this.observe();
    } catch {
      return false;
    }
  }

  // A legacy write was refused by the fence: confirm it with the source, or
  // the caller can't proceed either way yet.
  async fenced(): Promise<void> {
    let ok = false;
    try {
      ok = await this.observe();
    } catch {
      ok = false;
    }
    if (!ok) throw new StoreUnavailable("The legacy store refused a write, but migration can't start yet");
  }
}

// --- migrating ----------------------------------------------------------------

export type MigratingOptions = { pollMs?: number; now?: () => number; log?: (msg: string) => void };

export class MigratingOAuthStore implements OAuthStore {
  readonly activation: Activation;
  private readonly legacy: LegacyOAuthStore;
  private readonly now: () => number;
  constructor(
    private readonly local: LocalOAuthStore,
    private readonly source: LegacySource,
    private readonly installation: string,
    opts: MigratingOptions = {},
  ) {
    this.activation = new Activation(source, installation, opts);
    this.legacy = new LegacyOAuthStore(source);
    this.now = opts.now ?? Date.now;
  }

  // Before the fence, as legacy; a write the fence refuses is confirmed and redone.
  private async either<T>(legacy: () => Promise<T>, migrating: () => Promise<T>): Promise<T> {
    if (await this.activation.active()) return migrating();
    try {
      return await legacy();
    } catch (err) {
      if (!(err instanceof LegacyFenced)) throw err;
      await this.activation.fenced();
      return migrating();
    }
  }

  registerClient(c: OAuthClient) {
    return this.either(() => this.legacy.registerClient(c), () => this.local.registerClient(c));
  }
  getClient(id: string) {
    return this.either(() => this.legacy.getClient(id), async () => (await this.local.getClient(id)) ?? (await settle(this.source.getClient(id))));
  }

  savePendingAuth(p: PendingAuth) {
    return this.either(() => this.legacy.savePendingAuth(p), () => this.local.savePendingAuth(p));
  }
  getPendingAuth(state: string) {
    return this.either(() => this.legacy.getPendingAuth(state), async () => {
      const local = await this.local.getPendingAuth(state);
      if (local) return local;
      const claim = await this.local.getClaim("pending", credentialHash(state));
      if (claim) return claim.state === "prepared" && claim.expires_at > this.now() ? (claim.record as PendingAuth) : undefined;
      const p = await settle(this.source.getPendingAuth(state));
      return p && credentialExpiry("pending", p) > this.now() ? p : undefined;
    });
  }
  takePendingAuth(state: string) {
    return this.either(() => this.legacy.takePendingAuth(state), async () => {
      if (await this.local.hasPendingAuth(state)) return this.local.takePendingAuth(state);
      return this.takeLegacy("pending", state, async () => settle(this.source.getPendingAuth(state))) as Promise<PendingAuth | undefined>;
    });
  }

  saveAuthCode(c: AuthorizationCode) {
    return this.either(() => this.legacy.saveAuthCode(c), () => this.local.saveAuthCode(c));
  }
  getAuthCode(code: string) {
    return this.either(() => this.legacy.getAuthCode(code), async () => {
      const local = await this.local.getAuthCode(code);
      if (local) return local;
      const claim = await this.local.getClaim("code", credentialHash(code));
      if (claim) return claim.state === "tombstoned" ? undefined : { ...(claim.record as AuthorizationCode), used: claim.state === "consumed" };
      return settle(this.source.getAuthCode(code));
    });
  }
  consumeAuthCode(code: string) {
    return this.either(() => this.legacy.consumeAuthCode(code), async () => {
      if (await this.local.getAuthCode(code)) return this.local.consumeAuthCode(code);
      const read = async () => {
        const c = await settle(this.source.getAuthCode(code));
        return c && !c.used ? c : undefined;
      };
      return !!(await this.takeLegacy("code", code, read));
    });
  }
  deleteAuthCode(code: string) {
    // A legacy code is spent at the source; nothing there to delete.
    return this.either(() => this.legacy.deleteAuthCode(code), () => this.local.deleteAuthCode(code));
  }

  // A legacy code or pending authorization, used once: claim it here, consume
  // it at the source under that claim, and hand it to whoever settles the claim.
  // Never once it has expired (the claim carries the credential's expiry).
  private async takeLegacy(kind: ConsumeKind, credential: string, read: () => Promise<AuthorizationCode | PendingAuth | undefined>) {
    const hash = credentialHash(credential);
    // A claim is usable while prepared and unexpired. Checked again right
    // before the source is asked (claiming takes time, and expiry doesn't
    // wait), and once more before the record is handed out.
    const usableClaim = (c: { state: string; expires_at: number }) => c.state === "prepared" && c.expires_at > this.now();
    let claim = await this.local.getClaim(kind, hash);
    if (claim && !usableClaim(claim)) return undefined;
    if (!claim) {
      const record = await read();
      if (!record || credentialExpiry(kind, record) <= this.now()) return undefined;
      claim = await this.local.claim(kind, hash, record);
    }
    if (!usableClaim(claim)) return undefined;
    const out = decided(await settle(this.source.consume(this.installation, kind, hash, claim.claimId)));
    if (out.outcome === "applied") {
      const won = await this.local.settleClaim(kind, hash, claim.claimId, "consumed");
      return won && claim.expires_at > this.now() ? claim.record : undefined;
    }
    if (out.reason === "not_fenced" || out.reason === "sealed") throw new StoreUnavailable(`The legacy store refused: ${out.reason}`);
    await this.local.settleClaim(kind, hash, claim.claimId, "tombstoned");
    return undefined;
  }

  saveToken(uid: string, email: string, entry: TokenEntry) {
    return this.either(() => this.legacy.saveToken(uid, email, entry), () => this.local.saveToken(uid, entry));
  }

  // A legacy token is usable through the fallback only while nothing has been
  // decided about it: not revoked or marked at the source, and no migration
  // record here (a prepared one makes it unusable until confirmed).
  private async fallback(t: LegacyToken | null): Promise<TokenEntry | null> {
    const live = usable(t);
    if (!live) return null;
    return (await this.local.getMigration(tokenKey(live.entry))) ? null : live.entry;
  }

  // Local first, then the legacy store. A legacy record the source already
  // shows migrated was migrated by a record here, possibly since the local
  // read (a racing import or refresh): read locally again before answering.
  getTokenByAccessToken(at: string) {
    return this.either(() => this.legacy.getTokenByAccessToken(at), async () => {
      const local = await this.local.getTokenByAccessToken(at);
      if (local) return local;
      const t = usableAccess(await settle(this.source.getTokenByAccessToken(at)));
      if (t?.migration && !t.revoked) return this.local.getTokenByAccessToken(at);
      return this.fallback(t);
    });
  }

  getTokenByRefreshToken(rt: string) {
    return this.either(() => this.legacy.getTokenByRefreshToken(rt), async () => {
      const fromLocal = async () => {
        const local = await this.local.getTokenByRefreshToken(rt);
        if (local) return { found: true, entry: local };
        const m = await this.local.getMigration(credentialHash(rt));
        if (m) return { found: true, entry: (await this.pending(m)) ? m.original! : null };
        return { found: false, entry: null };
      };
      const first = await fromLocal();
      if (first.found) return first.entry;
      const t = await settle(this.source.getTokenByRefreshToken(rt));
      if (t?.migration && !t.revoked) return (await fromLocal()).entry;
      return this.fallback(t);
    });
  }

  // Whether a migration record can still answer a refresh of its legacy token.
  private async pending(m: MigrationRecord) {
    if (m.state === "prepared" || m.state === "acknowledged") return true;
    if (m.state === "confirmed" && m.mode === "rotation") return this.local.hasRefreshToken(m.pair!.refresh_token!);
    return false;
  }

  rotateTokens(old: string, next: TokenEntry) {
    return this.either(() => this.legacy.rotateTokens(old, next), async () => {
      if (await this.local.hasRefreshToken(old)) return this.local.rotateTokens(old, next);
      const key = credentialHash(old);
      let m = await this.local.getMigration(key);
      if (!m) {
        const live = usable(await settle(this.source.getTokenByRefreshToken(old)));
        // Marked at the source meanwhile: by a record made here (a racing
        // import or refresh), which then decides; otherwise it's spent.
        if (!live) m = await this.local.getMigration(key);
        else m = (await this.local.prepareMigration(key, "rotation", live.entry, next)).record;
        if (!m) throw new CredentialRefused();
        if (await this.local.hasRefreshToken(old)) return this.local.rotateTokens(old, next);
      }
      m = await this.complete(m);
      if (m.mode === "rotation") {
        const pair = m.pair!;
        if (!(await this.local.hasRefreshToken(pair.refresh_token!))) throw new CredentialRefused("The refresh token was already used");
        // The recorded pair answers a retry while its access token is good.
        // Once that has expired, the retry continues as a refresh of the pair
        // itself: one more rotation, single-use like any other.
        if (accessExpiry(pair) > this.now()) return pair;
        return this.local.rotateTokens(pair.refresh_token!, next);
      }
      // An imported token is now a local one.
      return this.local.rotateTokens(old, next);
    });
  }

  // Drive a migration record to its outcome at the source: confirmed (its
  // credential activated, once) or refused for good. Unknown: StoreUnavailable.
  //
  // Three durable steps, so nothing authenticates before it is validated, even
  // across a crash or a retry:
  //   1. markMigrated at the source (idempotent for this claim);
  //   2. acknowledged here: still not live;
  //   3. the source read again: it must still hold the token unrevoked under
  //      this claim. Only then confirmed (live). Revoked there: revoked here.
  // A failure in step 3 leaves the record acknowledged, and every retry (the
  // client's, the sweeper's) redoes steps 1 and 3.
  async complete(m: MigrationRecord): Promise<MigrationRecord> {
    if (m.state === "tombstoned" || m.state === "revoked") throw new CredentialRefused();
    if (m.state === "confirmed") return m;
    const out = decided(await settle(this.source.markMigrated(this.installation, m.key, m.mode, m.claimId)));
    if (out.outcome === "refused") {
      // Not a statement about the credential: retry later.
      if (out.reason === "not_fenced" || out.reason === "sealed") throw new StoreUnavailable(`The legacy store refused: ${out.reason}`);
      // Revoked there: revoked here (also undoing anything this claim left).
      if (out.reason === "revoked") await this.local.revokeMigration(m.key);
      else await this.local.tombstoneMigration(m.key, m.claimId);
      throw new CredentialRefused();
    }
    await this.local.acknowledgeMigration(m.key, m.claimId);
    if (!(await this.heldAtSource(m))) {
      await this.local.revokeMigration(m.key);
      throw new CredentialRefused("The legacy token was revoked");
    }
    return this.local.confirmMigration(m.key, m.claimId);
  }

  private async readSource(m: MigrationRecord) {
    const o = m.original!;
    return settle(o.refresh_token ? this.source.getTokenByRefreshToken(o.refresh_token) : this.source.getTokenByAccessToken(o.access_token));
  }

  // Whether the source still holds the legacy token unrevoked, marked under
  // this record's claim.
  private async heldAtSource(m: MigrationRecord) {
    const t = await this.readSource(m);
    return !!t && !t.revoked && t.migration?.claimId === m.claimId;
  }

  // Revocation during the overlap: here first, durably (no confirmation can
  // follow, and every live successor goes), then at the source. A sealed
  // source has handed revocation over: the local revocation is the whole of it.
  async revokeLegacy(key: string) {
    await this.local.revokeMigration(key);
    decided(await settle(this.source.revoke(this.installation, key)));
  }

  // A confirmed record whose legacy token the source now shows revoked (a
  // revocation made there, not through revokeLegacy): revoke it here too.
  async reconcile(m: MigrationRecord): Promise<boolean> {
    if (m.state !== "confirmed") return false;
    const t = await this.readSource(m);
    if (t && !t.revoked) return false;
    await this.local.revokeMigration(m.key);
    return true;
  }

  updateToken(at: string, u: FirebaseUpdate) {
    // A legacy token's refreshed Firebase session isn't persisted: the fenced
    // store refuses the write. It is used for this request and refreshed again
    // next time, until the token migrates.
    return this.either(() => this.legacy.updateToken(at, u), async () => {
      if (await this.local.getTokenByAccessToken(at)) await this.local.updateToken(at, u);
    });
  }

  deleteToken(at: string) {
    return this.either(() => this.legacy.deleteToken(at), async () => {
      if (await this.local.getTokenByAccessToken(at)) return this.local.deleteToken(at);
      const t = await settle(this.source.getTokenByAccessToken(at));
      if (t) await this.revokeLegacy(tokenKey(t.entry));
    });
  }
}

export type { LegacySource };
