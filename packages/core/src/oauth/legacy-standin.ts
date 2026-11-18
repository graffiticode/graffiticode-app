// An in-memory stand-in for the auth service's OAuth store, implementing the
// migration contract (legacy-contract.ts), for tests. It is held to the same
// suite as the real service (legacy-contract-suite.ts); it is not evidence
// that the real service behaves this way.
//
// Faults, for the failure cases: `fail(op, "before")` makes the next call of
// an operation throw LegacyTransient without applying it; `fail(op, "after")`
// applies it and then throws (a lost acknowledgement). `before(op, fn)` runs
// fn just before the next call of an operation decides, and `after(op, fn)`
// just after it applied and before it answers, to interleave another actor (a
// revocation landing between the source's acknowledgement and the caller's
// confirmation, say).
import {
  LEGACY_CONTRACT_VERSION, LegacyFenced, LegacyTransient,
  type ConsumeKind, type InventoryRecord, type LegacySource, type LegacyToken, type MigrationMode, type Outcome,
} from "./legacy-contract.js";
import { credentialHash, tokenKey, type AuthorizationCode, type OAuthClient, type PendingAuth, type TokenEntry } from "./records.js";

const LEGACY_INSTALLATION = "graffiticode";
type TokenRecord = { entry: TokenEntry; revoked: boolean; migration: { mode: MigrationMode; claimId: string } | null };
type Consumable<T> = { record: T; consumedBy: string | null };
type Op = "status" | "consume" | "markMigrated" | "revoke" | "inventory" | "read" | "write";

const clone = <T>(x: T): T => (x === undefined || x === null ? x : structuredClone(x));

export class LegacyStandIn implements LegacySource {
  readonly fenced = new Set<string>();
  readonly sealed = new Set<string>();
  readonly clients = new Map<string, OAuthClient>();
  readonly pending = new Map<string, Consumable<PendingAuth>>();
  readonly codes = new Map<string, Consumable<AuthorizationCode>>();
  readonly tokens = new Map<string, TokenRecord>();
  // What each operation was asked, for assertions.
  readonly calls: Array<{ op: Op; args: unknown[] }> = [];
  contractVersion = LEGACY_CONTRACT_VERSION;
  private faults: Array<{ op: Op; when: "before" | "after" }> = [];
  private hooks: Array<{ op: Op; fn: () => Promise<void> | void }> = [];
  private afterHooks: Array<{ op: Op; fn: () => Promise<void> | void }> = [];

  fail(op: Op, when: "before" | "after") {
    this.faults.push({ op, when });
  }
  before(op: Op, fn: () => Promise<void> | void) {
    this.hooks.push({ op, fn });
  }
  after(op: Op, fn: () => Promise<void> | void) {
    this.afterHooks.push({ op, fn });
  }
  // The operator's fence.
  fence(installation = LEGACY_INSTALLATION) {
    this.fenced.add(installation);
  }
  // The operator's seal (only once fenced).
  seal(installation = LEGACY_INSTALLATION) {
    if (!this.fenced.has(installation)) throw new Error("seal needs the fence");
    this.sealed.add(installation);
  }

  private async enter(op: Op, args: unknown[]) {
    this.calls.push({ op, args });
    const h = this.hooks.findIndex(x => x.op === op);
    if (h >= 0) await this.hooks.splice(h, 1)[0].fn();
    const f = this.faults.findIndex(x => x.op === op && x.when === "before");
    if (f >= 0) {
      this.faults.splice(f, 1);
      throw new LegacyTransient(`${op}: injected failure`);
    }
  }
  private async exit(op: Op) {
    const h = this.afterHooks.findIndex(x => x.op === op);
    if (h >= 0) await this.afterHooks.splice(h, 1)[0].fn();
    const f = this.faults.findIndex(x => x.op === op && x.when === "after");
    if (f >= 0) {
      this.faults.splice(f, 1);
      throw new LegacyTransient(`${op}: injected lost acknowledgement`);
    }
  }
  private async write<T>(fn: () => T): Promise<T> {
    await this.enter("write", []);
    if (this.fenced.has(LEGACY_INSTALLATION)) throw new LegacyFenced();
    const r = fn();
    await this.exit("write");
    return r;
  }
  private async read<T>(fn: () => T): Promise<T> {
    await this.enter("read", []);
    const r = fn();
    await this.exit("read");
    return clone(r);
  }

  // Seed a record as the store held it before the change (no fence check).
  seedToken(entry: TokenEntry, marks: Partial<Pick<TokenRecord, "revoked" | "migration">> = {}) {
    this.tokens.set(tokenKey(entry), { entry: clone(entry), revoked: false, migration: null, ...marks });
  }
  seedClient(client: OAuthClient) {
    this.clients.set(client.client_id, clone(client));
  }
  seedCode(code: AuthorizationCode) {
    this.codes.set(credentialHash(code.code), { record: clone(code), consumedBy: code.used ? "legacy" : null });
  }
  seedPending(pending: PendingAuth) {
    this.pending.set(credentialHash(pending.state), { record: clone(pending), consumedBy: null });
  }

  private tokenBy(field: "access_token" | "refresh_token", value: string): TokenRecord | null {
    for (const r of this.tokens.values()) if (r.entry[field] === value) return r;
    return null;
  }
  private view(r: TokenRecord | null): LegacyToken | null {
    return r ? { entry: r.entry, revoked: r.revoked, migration: r.migration } : null;
  }

  async status(installation: string) {
    await this.enter("status", [installation]);
    const r = { contract: this.contractVersion, fenced: this.fenced.has(installation), sealed: this.sealed.has(installation) };
    await this.exit("status");
    return r;
  }

  getClient(id: string) { return this.read(() => this.clients.get(id)); }
  getPendingAuth(state: string) {
    return this.read(() => {
      const p = this.pending.get(credentialHash(state));
      return p && !p.consumedBy ? p.record : undefined;
    });
  }
  getAuthCode(code: string) {
    return this.read(() => {
      const c = this.codes.get(credentialHash(code));
      return c ? { ...c.record, used: c.record.used || !!c.consumedBy } : undefined;
    });
  }
  getTokenByAccessToken(at: string) { return this.read(() => this.view(this.tokenBy("access_token", at))); }
  getTokenByRefreshToken(rt: string) { return this.read(() => this.view(this.tokenBy("refresh_token", rt))); }

  registerClient(c: OAuthClient) { return this.write(() => void this.clients.set(c.client_id, clone(c))); }
  savePendingAuth(p: PendingAuth) { return this.write(() => void this.pending.set(credentialHash(p.state), { record: clone(p), consumedBy: null })); }
  deletePendingAuth(state: string) { return this.write(() => void this.pending.delete(credentialHash(state))); }
  saveAuthCode(c: AuthorizationCode) { return this.write(() => void this.codes.set(credentialHash(c.code), { record: clone(c), consumedBy: null })); }
  markAuthCodeUsed(code: string) {
    return this.write(() => {
      const c = this.codes.get(credentialHash(code));
      if (c) c.record.used = true;
    });
  }
  deleteAuthCode(code: string) { return this.write(() => void this.codes.delete(credentialHash(code))); }
  saveToken(_uid: string, _email: string, entry: TokenEntry) { return this.write(() => void this.seedToken(entry)); }
  rotateTokens(old: string, next: TokenEntry) {
    return this.write(() => {
      const r = this.tokenBy("refresh_token", old);
      if (r) this.tokens.delete(tokenKey(r.entry));
      this.seedToken(next);
    });
  }
  updateToken(at: string, updates: Partial<TokenEntry>) {
    return this.write(() => {
      const r = this.tokenBy("access_token", at);
      if (r) Object.assign(r.entry, updates);
    });
  }
  deleteToken(at: string) {
    return this.write(() => {
      const r = this.tokenBy("access_token", at);
      if (r) this.tokens.delete(tokenKey(r.entry));
    });
  }

  async consume(installation: string, kind: ConsumeKind, hash: string, claimId: string): Promise<Outcome> {
    await this.enter("consume", [installation, kind, hash, claimId]);
    let out: Outcome;
    const c = installation === LEGACY_INSTALLATION ? (kind === "code" ? this.codes : this.pending).get(hash) : undefined;
    if (!this.fenced.has(installation)) out = { outcome: "refused", reason: "not_fenced" };
    else if (this.sealed.has(installation)) out = { outcome: "refused", reason: "sealed" };
    else if (!c) out = { outcome: "refused", reason: "absent" };
    else if (c.consumedBy === claimId) out = { outcome: "applied" };
    else if (c.consumedBy || (kind === "code" && (c.record as AuthorizationCode).used)) out = { outcome: "refused", reason: "consumed" };
    else {
      c.consumedBy = claimId;
      out = { outcome: "applied" };
    }
    await this.exit("consume");
    return out;
  }

  async markMigrated(installation: string, hash: string, mode: MigrationMode, claimId: string): Promise<Outcome> {
    await this.enter("markMigrated", [installation, hash, mode, claimId]);
    let out: Outcome;
    const r = installation === LEGACY_INSTALLATION ? this.tokens.get(hash) : undefined;
    if (!this.fenced.has(installation)) out = { outcome: "refused", reason: "not_fenced" };
    else if (this.sealed.has(installation)) out = { outcome: "refused", reason: "sealed" };
    else if (!r) out = { outcome: "refused", reason: "absent" };
    else if (r.revoked) out = { outcome: "refused", reason: "revoked" };
    else if (r.migration) out = r.migration.claimId === claimId ? { outcome: "applied" } : { outcome: "refused", reason: "claimed" };
    else {
      r.migration = { mode, claimId };
      out = { outcome: "applied" };
    }
    await this.exit("markMigrated");
    return out;
  }

  async revoke(installation: string, hash: string): Promise<Outcome> {
    await this.enter("revoke", [installation, hash]);
    let out: Outcome = { outcome: "applied" };
    if (this.sealed.has(installation)) out = { outcome: "refused", reason: "sealed" };
    else {
      const r = installation === LEGACY_INSTALLATION ? this.tokens.get(hash) : undefined;
      if (r) r.revoked = true;
    }
    await this.exit("revoke");
    return out;
  }

  async inventory(installation: string, cursor?: string | null) {
    await this.enter("inventory", [installation, cursor]);
    const all: InventoryRecord[] = installation === LEGACY_INSTALLATION
      ? [
        ...[...this.clients.values()].map(c => ({ kind: "client" as const, key: c.client_id, client: clone(c) })),
        ...[...this.tokens.entries()].map(([key, r]) => ({ kind: "token" as const, key, token: clone(this.view(r)!) })),
      ]
      : [];
    const PAGE = 2; // small, so paging is exercised
    const start = cursor ? Number(cursor) : 0;
    const out = { records: all.slice(start, start + PAGE), next: start + PAGE < all.length ? String(start + PAGE) : null };
    await this.exit("inventory");
    return out;
  }
}
