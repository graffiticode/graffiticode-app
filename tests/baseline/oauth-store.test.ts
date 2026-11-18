// The OAuth-store handover (installations plan, P5): the installation's own
// store in Firestore (the emulator), the legacy store as the contract's
// stand-in, and the migrating store between them. These are the plan's
// acceptance cases for this repo's half; the auth service's half is held to
// the same contract by its own run of the suite.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { start, type Harness } from "./harness";

let h: Harness;
let core: {
  standin: typeof import("@graffiticode-app/core/oauth/legacy-standin");
  local: typeof import("@graffiticode-app/core/oauth/local-store");
  store: typeof import("@graffiticode-app/core/oauth/store");
  migration: typeof import("@graffiticode-app/core/oauth/migration");
  records: typeof import("@graffiticode-app/core/oauth/records");
  contract: typeof import("@graffiticode-app/core/oauth/legacy-contract");
};
let mcp: {
  handlers: typeof import("../../packages/mcp-server/src/oauth/handlers");
  storeSel: typeof import("../../packages/mcp-server/src/oauth/firestore-store");
  introspection: typeof import("../../packages/mcp-server/src/oauth/introspection");
};

before(async () => {
  h = await start();
  delete process.env.MCP_SERVER_URL;
  delete process.env.OPENAPI_PUBLIC_URL;
  delete process.env.OPENAPI_RESOURCE;
  core = {
    standin: await import("@graffiticode-app/core/oauth/legacy-standin"),
    local: await import("@graffiticode-app/core/oauth/local-store"),
    store: await import("@graffiticode-app/core/oauth/store"),
    migration: await import("@graffiticode-app/core/oauth/migration"),
    records: await import("@graffiticode-app/core/oauth/records"),
    contract: await import("@graffiticode-app/core/oauth/legacy-contract"),
  };
  mcp = {
    handlers: await import("../../packages/mcp-server/src/oauth/handlers"),
    storeSel: await import("../../packages/mcp-server/src/oauth/firestore-store"),
    introspection: await import("../../packages/mcp-server/src/oauth/introspection"),
  };
});
after(async () => {
  mcp?.storeSel.setOAuthStore(null);
  await h?.stop();
});
beforeEach(async () => {
  await h.resetFirestore();
});

const MCP = "https://mcp.graffiticode.org/mcp";
const REST = "https://openapi.graffiticode.org/v1";
const CLIENT = "legacy-client";
let n = 0;
const entry = (over: Record<string, unknown> = {}) => {
  n++;
  return {
    access_token: `gcmcp_at_legacy${n}`, refresh_token: `gcmcp_rt_legacy${n}`, client_id: CLIENT, client_name: "Agent",
    scope: "graffiticode", firebase_id_token: `fid-${n}`, firebase_refresh_token: `frt-${n}`,
    firebase_token_expires_at: Date.now() + 3_600_000, resource: MCP, created_at: Date.now(), ...over,
  } as any;
};
const next = () => {
  n++;
  return { ...entry(), access_token: `gcmcp_at_new${n}`, refresh_token: `gcmcp_rt_new${n}` };
};
const legacyClient = { client_id: CLIENT, client_name: "Agent", redirect_uris: ["https://agent.example/cb"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: 0 };

// A fenced stand-in, the installation's store, and the migrating store over both.
function setup({ fenced = true, pollMs = 0, now }: { fenced?: boolean; pollMs?: number; now?: () => number } = {}) {
  const source = new core.standin.LegacyStandIn();
  source.seedClient(legacyClient);
  if (fenced) source.fence();
  const local = new core.local.LocalOAuthStore(() => h.db, now ?? Date.now);
  const store = new core.store.MigratingOAuthStore(local, source, "graffiticode", { pollMs, now });
  return { source, local, store };
}
const liveTokens = async () => (await h.db.collection("oauth_tokens").get()).size;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// --- activation: deployment changes nothing until the source is fenced ---------

test("armed but unfenced, the migrating store is the legacy store; the fence latches it", async () => {
  const { source, store } = setup({ fenced: false });
  const t = entry();
  await store.saveToken("uid", "", t);
  assert.ok(source.tokens.size > 0, "written to the legacy store");
  assert.equal(await liveTokens(), 0, "nothing local");
  assert.equal(store.activation.latched, false);
  source.fence();
  const t2 = entry();
  await store.saveToken("uid", "", t2);
  assert.equal(store.activation.latched, true);
  assert.equal(await liveTokens(), 1, "after the fence, new tokens are written locally");
  assert.equal((await store.getTokenByAccessToken(t.access_token))?.access_token, t.access_token, "the earlier one through the fallback");
});

test("a write the fence refuses latches (after confirming with the source) and is redone locally", async () => {
  const { source, store } = setup({ fenced: false, pollMs: 3_600_000 });
  await store.getClient(CLIENT); // the first poll: unfenced
  source.fence();
  const t = entry();
  await store.saveToken("uid", "", t);
  assert.equal(store.activation.latched, true);
  assert.equal(await liveTokens(), 1);
  assert.ok(!source.tokens.has(core.records.tokenKey(t)));
});

test("a fence under another contract version never activates migration", async () => {
  const { source, store } = setup({ fenced: true, pollMs: 3_600_000 });
  source.contractVersion = 2;
  await assert.rejects(store.saveToken("uid", "", entry()), core.records.StoreUnavailable);
  assert.equal(store.activation.latched, false);
  assert.equal(await liveTokens(), 0);
});

test("migration operations are refused by the source before its fence", async () => {
  const { source } = setup({ fenced: false });
  const t = entry();
  source.seedToken(t);
  assert.deepEqual(await source.markMigrated("graffiticode", core.records.tokenKey(t), "import", "c"), { outcome: "refused", reason: "not_fenced" });
});

// --- clients and access tokens from before cutover -------------------------------

test("a client registered before cutover still authorizes; new registrations are local", async () => {
  const { source, store } = setup();
  assert.equal((await store.getClient(CLIENT))?.client_id, CLIENT, "through the fallback");
  await store.registerClient({ ...legacyClient, client_id: "new-client", issuer: core.records.LEGACY_ISSUER });
  assert.equal(source.clients.has("new-client"), false);
  assert.equal((await store.getClient("new-client"))?.issuer, core.records.LEGACY_ISSUER, "the issuer URL is unchanged");
});

test("an access token issued before cutover works on MCP and on REST (introspection)", async () => {
  const { source, store } = setup();
  const forMcp = entry();
  const forRest = entry({ resource: REST });
  source.seedToken(forMcp);
  source.seedToken(forRest);
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    assert.deepEqual(await mcp.handlers.resolveOAuthAccessToken(forMcp.access_token), { status: "valid", firebaseToken: forMcp.firebase_id_token });
    const verify = async (t: string, audience: string) => ({ email: t, email_verified: true, aud: audience });
    const ok = await mcp.introspection.introspect({ authorization: `Bearer ${mcp.introspection.introspectionCallers()[0]}`, token: forRest.access_token, verify });
    assert.deepEqual([ok.body.active, ok.body.aud], [true, REST]);
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
});

test("a token revoked before cutover stays revoked; one in neither store is refused", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t, { revoked: true });
  assert.equal(await store.getTokenByAccessToken(t.access_token), null);
  assert.equal(await store.getTokenByRefreshToken(t.refresh_token), null);
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
  assert.equal(await store.getTokenByAccessToken("gcmcp_at_nowhere"), null);
  await assert.rejects(store.rotateTokens("gcmcp_rt_nowhere", next()), core.records.CredentialRefused);
});

// --- a legacy refresh token yields exactly one local pair -------------------------

test("concurrent refreshes of one legacy token all receive the same pair, activated once", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => store.rotateTokens(t.refresh_token, next())));
  const pairs = new Set(results.map(r => `${r.access_token}|${r.refresh_token}`));
  assert.equal(pairs.size, 1, "one pair");
  assert.equal(await liveTokens(), 1, "activated once");
  const [pair] = results;
  assert.equal((await store.getTokenByAccessToken(pair.access_token))?.refresh_token, pair.refresh_token);
  assert.equal(await store.getTokenByAccessToken(t.access_token), null, "the legacy access token is spent");
  assert.equal(source.tokens.get(core.records.tokenKey(t))?.migration?.mode, "rotation");
  // A retry of the old token gets the same pair while it is unused...
  assert.equal((await store.rotateTokens(t.refresh_token, next())).access_token, pair.access_token);
  // ...and nothing once the pair has itself been used.
  await store.rotateTokens(pair.refresh_token!, next());
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
});

test("the token endpoint answers temporarily_unavailable on an unknown outcome, and the retry gets the pair", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.fail("markMigrated", "before");
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.deepEqual([first.status, first.json.error], [503, "temporarily_unavailable"]);
    assert.equal(await liveTokens(), 0, "nothing activated");
    const second = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.equal(second.status, 200);
    const again = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.equal(again.json.access_token, second.json.access_token, "the same pair");
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
});

test("a crash after the claim leaves the legacy token unusable through the fallback; the sweeper completes it", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.fail("markMigrated", "before");
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  const record = await local.getMigration(core.records.tokenKey(t));
  assert.equal(record?.state, "prepared");
  assert.equal(await store.getTokenByAccessToken(t.access_token), null, "the legacy token no longer works through the fallback");
  assert.equal(await store.getTokenByAccessToken(record!.pair!.access_token), null, "and the prepared pair authenticates nothing");
  assert.deepEqual(await core.migration.sweep(store, local), { confirmed: 1, tombstoned: 0, leftPrepared: 0, revoked: 0 });
  assert.equal((await store.getTokenByAccessToken(record!.pair!.access_token))?.access_token, record!.pair!.access_token);
  assert.equal(source.tokens.get(core.records.tokenKey(t))?.migration?.claimId, record!.claimId);
});

test("a crash during the claim transaction leaves no claim, and a retry succeeds", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  await assert.rejects(local.prepareMigration(core.records.tokenKey(t), "rotation", t, next(), () => { throw new Error("crash"); }), /crash/);
  assert.equal(await local.getMigration(core.records.tokenKey(t)), null);
  assert.equal((await store.getTokenByAccessToken(t.access_token))?.access_token, t.access_token, "still usable");
  assert.ok((await store.rotateTokens(t.refresh_token, next())).access_token);
});

test("lost acknowledgement: the source marked it but the answer was lost; the retry activates it exactly once", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.fail("markMigrated", "after");
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  assert.equal(source.tokens.get(core.records.tokenKey(t))?.migration?.mode, "rotation", "committed at the source");
  assert.equal(await liveTokens(), 0);
  const pair = await store.rotateTokens(t.refresh_token, next());
  assert.equal(await liveTokens(), 1);
  assert.equal((await store.rotateTokens(t.refresh_token, next())).access_token, pair.access_token);
  assert.equal(await liveTokens(), 1);
});

test("a revocation between preparation and confirmation: revoked here too, and nothing ever authenticates", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.before("markMigrated", () => { source.tokens.get(core.records.tokenKey(t))!.revoked = true; });
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
  const record = await local.getMigration(core.records.tokenKey(t));
  assert.equal(record?.state, "revoked");
  assert.equal(await store.getTokenByAccessToken(record!.pair!.access_token), null);
  assert.equal(await store.getTokenByAccessToken(t.access_token), null);
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
  assert.equal(await liveTokens(), 0);
});

// --- revocation during the overlap -------------------------------------------------

test("a revocation after the source's acknowledgement and before confirmation: nothing stays live", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.after("markMigrated", () => { source.tokens.get(core.records.tokenKey(t))!.revoked = true; });
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
  const record = await local.getMigration(core.records.tokenKey(t));
  assert.equal(record?.state, "revoked");
  assert.equal(await liveTokens(), 0);
  assert.equal(await store.getTokenByAccessToken(record!.pair!.access_token), null);
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
});

test("revocation through this store is durable first: a later confirmation activates nothing", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.fail("markMigrated", "after"); // the source marks it; the answer is lost
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  await store.deleteToken(t.access_token); // revoke while the record is prepared
  assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "revoked");
  assert.equal(source.tokens.get(core.records.tokenKey(t))?.revoked, true);
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
  const swept = await core.migration.sweep(store, local);
  assert.equal(swept.confirmed, 0);
  assert.equal(await liveTokens(), 0);
});

test("validation failing after the source revoked: nothing goes live, and the retry refuses it", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.after("markMigrated", () => {
    source.tokens.get(core.records.tokenKey(t))!.revoked = true;
    source.fail("read", "before"); // the validation read fails
  });
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.deepEqual([first.status, first.json.error], [503, "temporarily_unavailable"]);
    const record = await local.getMigration(core.records.tokenKey(t));
    assert.equal(record?.state, "acknowledged", "durably not live");
    assert.equal(await liveTokens(), 0);
    assert.equal(await store.getTokenByAccessToken(record!.pair!.access_token), null);
    const retry = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.deepEqual([retry.status, retry.json.error], [400, "invalid_grant"]);
    assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "revoked");
    assert.equal(await liveTokens(), 0);
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
});

test("validation failing with nothing revoked: still not live, and the sweeper validates and activates it", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.after("markMigrated", () => source.fail("read", "before"));
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "acknowledged");
  assert.equal(await liveTokens(), 0);
  assert.equal((await core.migration.sweep(store, local)).confirmed, 1);
  assert.equal(await liveTokens(), 1);
});

test("validation failing with nothing revoked: the client's retry through the endpoint completes it", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.after("markMigrated", () => source.fail("read", "before"));
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.equal(first.status, 503);
    assert.equal(await liveTokens(), 0);
    const retry = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.access_token, (await local.getMigration(core.records.tokenKey(t)))!.pair!.access_token);
    assert.equal(await liveTokens(), 1);
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
});

test("a local revocation landing while a retry is confirming wins: the confirmation activates nothing", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.fail("markMigrated", "before");
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  // The retry has read the prepared record; the revocation lands here before the
  // source acknowledges (its call to the source still to come).
  source.before("markMigrated", () => local.revokeMigration(core.records.tokenKey(t)));
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
  assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "revoked");
  assert.equal(await liveTokens(), 0);
});

test("revoking a migrated token removes its live successor, however far it has rotated", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t);
  const pair = await store.rotateTokens(t.refresh_token, next());
  const later = await store.rotateTokens(pair.refresh_token!, next());
  assert.ok(await store.getTokenByAccessToken(later.access_token));
  await store.deleteToken(t.access_token);
  assert.equal(await store.getTokenByAccessToken(later.access_token), null);
  assert.equal(await liveTokens(), 0);
});

test("a revocation made at the source after migration is reconciled by the sweeper", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  const pair = await store.rotateTokens(t.refresh_token, next());
  source.tokens.get(core.records.tokenKey(t))!.revoked = true;
  assert.equal((await core.migration.sweep(store, local)).revoked, 1);
  assert.equal(await store.getTokenByAccessToken(pair.access_token), null);
  assert.equal(await liveTokens(), 0);
});

// --- races with an import on the endpoint's own lookups -----------------------------

test("the token endpoint refreshes a token an import finished migrating during its lookup", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.before("read", async () => { await core.migration.importInventory(store, local, source, "graffiticode"); });
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(await store.getTokenByAccessToken(res.json.access_token));
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
});

test("an access token an import finished migrating during its lookup still resolves", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.before("read", async () => { await core.migration.importInventory(store, local, source, "graffiticode"); });
  assert.equal((await store.getTokenByAccessToken(t.access_token))?.access_token, t.access_token);
});

// --- an answer that isn't the contract's ----------------------------------------------

test("an unrecognized answer from the source leaves the record prepared and asks for a retry", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  const real = source.markMigrated.bind(source);
  source.markMigrated = (async () => ({})) as any;
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "prepared");
  source.markMigrated = (async () => ({ outcome: "refused", reason: "whatever" })) as any;
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  source.markMigrated = real;
  assert.ok((await store.rotateTokens(t.refresh_token, next())).access_token);
  const c = legacyCode();
  source.seedCode(c as any);
  source.consume = (async () => ({ outcome: "maybe" })) as any;
  await assert.rejects(store.consumeAuthCode(c.code), core.records.StoreUnavailable);
  assert.equal((await store.getAuthCode(c.code))?.used, false, "the code isn't spent");
});

// --- a replayed pair's lifetime ---------------------------------------------------------

test("a retry after the recorded pair's access token expired rotates past it, once", async () => {
  let clock = Date.now();
  const { source, store } = setup({ now: () => clock });
  const t = entry();
  source.seedToken(t);
  const pair = await store.rotateTokens(t.refresh_token, { ...next(), created_at: clock, access_token_expires_at: clock + 55 * 60_000 });
  clock += 60 * 60_000;
  const fresh = { ...next(), created_at: clock, access_token_expires_at: clock + 55 * 60_000 };
  const moved = await store.rotateTokens(t.refresh_token, fresh);
  assert.equal(moved.access_token, fresh.access_token, "not the expired pair");
  assert.equal(await store.getTokenByRefreshToken(pair.refresh_token!), null, "the pair's refresh token is spent");
  assert.equal(await liveTokens(), 1);
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.CredentialRefused);
});

// --- the writer fence ----------------------------------------------------------

test("an old revision's refresh is refused by the fence; with a new-path refresh racing, one successor survives", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t);
  const [oldPath, newPath] = await Promise.allSettled([source.rotateTokens(t.refresh_token, next()), store.rotateTokens(t.refresh_token, next())]);
  assert.equal(oldPath.status, "rejected");
  assert.ok((oldPath as PromiseRejectedResult).reason instanceof core.contract.LegacyFenced);
  assert.equal(newPath.status, "fulfilled");
  assert.equal(await liveTokens(), 1);
  assert.equal(source.tokens.size, 1, "the legacy store holds only the original, marked");
});

// --- codes and pending authorizations ----------------------------------------------

const legacyCode = (over: Record<string, unknown> = {}) => ({
  code: `legacy-code-${++n}`, client_id: CLIENT, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: "c",
  code_challenge_method: "S256", resource: MCP, expires_at: Date.now() + 600_000, used: false, grant: "g", grant_state: "s", ...over,
});

test("a legacy code works once: of simultaneous exchanges one wins; the legacy path is refused", async () => {
  const { source, store } = setup();
  const c = legacyCode();
  source.seedCode(c as any);
  assert.equal((await store.getAuthCode(c.code))?.used, false);
  const wins = await Promise.all(Array.from({ length: 4 }, () => store.consumeAuthCode(c.code)));
  assert.equal(wins.filter(Boolean).length, 1);
  assert.equal(await store.consumeAuthCode(c.code), false);
  assert.equal((await store.getAuthCode(c.code))?.used, true);
  await assert.rejects(source.markAuthCodeUsed(c.code), core.contract.LegacyFenced, "an old revision can't use it either");
  assert.equal((await source.consume("graffiticode", "code", hash(c.code), "another-claim")).outcome, "refused");
});

test("a lost acknowledgement on a code: the retry wins once", async () => {
  const { source, store } = setup();
  const c = legacyCode();
  source.seedCode(c as any);
  source.fail("consume", "after");
  await assert.rejects(store.consumeAuthCode(c.code), core.records.StoreUnavailable);
  assert.equal(await store.consumeAuthCode(c.code), true);
  assert.equal(await store.consumeAuthCode(c.code), false);
});

test("retries racing on one claim: both are acknowledged at the source, one gets the code", async () => {
  const { source, store } = setup();
  const c = legacyCode();
  source.seedCode(c as any);
  source.fail("consume", "after");
  await assert.rejects(store.consumeAuthCode(c.code), core.records.StoreUnavailable);
  // Hold each consume until both retries have been acknowledged under the same claim.
  const consume = source.consume.bind(source);
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>(r => { release = r; });
  source.consume = async (...args) => {
    const out = await consume(...args);
    if (++arrived === 2) release();
    await both;
    return out;
  };
  const wins = await Promise.all([store.consumeAuthCode(c.code), store.consumeAuthCode(c.code)]);
  assert.equal(arrived, 2, "both reached the source");
  assert.deepEqual(wins.filter(Boolean).length, 1);
});

test("a code issued after cutover is local and works once", async () => {
  const { source, store } = setup();
  const c = legacyCode();
  await store.saveAuthCode(c as any);
  assert.equal(source.codes.size, 0);
  assert.equal(await store.consumeAuthCode(c.code), true);
  assert.equal(await store.consumeAuthCode(c.code), false);
  assert.equal((await store.getAuthCode(c.code))?.used, true);
});

test("a refresh that finds the token just imported (marked at the source meanwhile) uses the import", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  // As the refresh reads the source, an import runs to completion.
  source.before("read", async () => { await core.migration.importInventory(store, local, source, "graffiticode"); });
  const rotated = await store.rotateTokens(t.refresh_token, next());
  assert.ok(await store.getTokenByAccessToken(rotated.access_token));
  assert.equal(await store.getTokenByAccessToken(t.access_token), null);
  assert.equal(await liveTokens(), 1);
});

test("a legacy pending authorization completes once", async () => {
  const { source, store } = setup();
  const p = { state: `legacy-state-${++n}`, client_id: CLIENT, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: "c", code_challenge_method: "S256", resource: MCP, created_at: Date.now() };
  source.seedPending(p);
  assert.equal((await store.getPendingAuth(p.state))?.state, p.state);
  const taken = await Promise.all([store.takePendingAuth(p.state), store.takePendingAuth(p.state)]);
  assert.equal(taken.filter(Boolean).length, 1);
  assert.equal(await store.getPendingAuth(p.state), undefined);
});

// --- import --------------------------------------------------------------------

test("import never overwrites a rotation: rotate first, then import", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  const pair = await store.rotateTokens(t.refresh_token, next());
  const r = await core.migration.importInventory(store, local, source, "graffiticode");
  assert.equal(r.imported, 0);
  assert.equal(r.skippedMarked, 1, "the source already shows it migrated");
  const record = await local.getMigration(core.records.tokenKey(t));
  assert.deepEqual([record?.mode, record?.state, record?.pair?.access_token], ["rotation", "confirmed", pair.access_token]);
});

test("an import racing a refresh: one record, and exactly one valid successor credential", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  const [imported, refreshed] = await Promise.all([core.migration.importInventory(store, local, source, "graffiticode"), store.rotateTokens(t.refresh_token, next())]);
  assert.equal(imported.imported + imported.alreadyRecorded + imported.skippedMarked, 1);
  assert.equal((await h.db.collection("oauth_migrations").get()).size, 1);
  assert.equal((await store.getTokenByRefreshToken(refreshed.refresh_token!))?.access_token, refreshed.access_token);
  // The original yields no second credential: refused, or the same pair again.
  const again = await store.rotateTokens(t.refresh_token, next()).catch((e: unknown) => e);
  assert.ok(again instanceof core.records.CredentialRefused || (again as any).access_token === refreshed.access_token);
  assert.equal(await liveTokens(), 1);
});

test("an imported credential keeps the original token, resolves through both lookups, and works on MCP and REST", async () => {
  const { source, local, store } = setup();
  const forMcp = entry();
  const forRest = entry({ resource: REST });
  source.seedToken(forMcp);
  source.seedToken(forRest);
  const r = await core.migration.importInventory(store, local, source, "graffiticode");
  assert.equal(r.imported, 2);
  assert.equal(r.clientsCopied, 1);
  assert.equal((await local.getTokenByAccessToken(forMcp.access_token))?.refresh_token, forMcp.refresh_token, "now local, unchanged");
  assert.equal((await store.getTokenByRefreshToken(forMcp.refresh_token))?.access_token, forMcp.access_token);
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    assert.equal((await mcp.handlers.resolveOAuthAccessToken(forMcp.access_token)).status, "valid");
    const verify = async (t: string) => ({ email: t, email_verified: true });
    const ok = await mcp.introspection.introspect({ authorization: `Bearer ${mcp.introspection.introspectionCallers()[0]}`, token: forRest.access_token, verify });
    assert.equal(ok.body.active, true);
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
  // A later refresh of it is an ordinary local one.
  const rotated = await store.rotateTokens(forMcp.refresh_token, next());
  assert.equal(await store.getTokenByAccessToken(forMcp.access_token), null);
  assert.ok(await store.getTokenByAccessToken(rotated.access_token));
});

test("an access token the source no longer accepts never becomes live: the import carries a fresh one", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t, { accessUsable: false });
  assert.equal(await store.getTokenByAccessToken(t.access_token), null, "not usable before");
  const r = await core.migration.importInventory(store, local, source, "graffiticode");
  assert.equal(r.imported, 1);
  assert.equal(await store.getTokenByAccessToken(t.access_token), null, "not usable after");
  const record = await local.getMigration(core.records.tokenKey(t));
  assert.notEqual(record!.original!.access_token, t.access_token);
  assert.ok(record!.original!.access_token.startsWith("gcmcp_at_"));
  assert.equal(record!.original!.refresh_token, t.refresh_token, "the refresh token, still usable, is imported as it is");
  assert.equal(await liveTokens(), 1);
  // A re-run mints nothing new.
  await core.migration.importInventory(store, local, source, "graffiticode");
  assert.equal((await local.getMigration(core.records.tokenKey(t)))!.original!.access_token, record!.original!.access_token);
  // The refresh token works, and yields a new pair; the old access token still doesn't.
  const next1 = await store.rotateTokens(t.refresh_token, next());
  assert.ok(await store.getTokenByAccessToken(next1.access_token));
  assert.equal(await store.getTokenByAccessToken(t.access_token), null);
  mcp.storeSel.setOAuthStore(store, "migrating");
  try {
    assert.equal((await mcp.handlers.resolveOAuthAccessToken(t.access_token)).status, "invalid");
  } finally {
    mcp.storeSel.setOAuthStore(null);
  }
});

test("refreshing such a record through the fallback activates only the new pair", async () => {
  const { source, store } = setup();
  const t = entry();
  source.seedToken(t, { accessUsable: false });
  const pair = await store.rotateTokens(t.refresh_token, next());
  assert.ok(await store.getTokenByAccessToken(pair.access_token));
  assert.equal(await store.getTokenByAccessToken(t.access_token), null);
  assert.equal(await liveTokens(), 1);
});

test("importing a revoked or already-migrated record never produces a live credential", async () => {
  const { source, local, store } = setup();
  source.seedToken(entry(), { revoked: true });
  source.seedToken(entry(), { migration: { mode: "rotation", claimId: "elsewhere" } });
  const raced = entry();
  source.seedToken(raced);
  source.before("markMigrated", () => { source.tokens.get(core.records.tokenKey(raced))!.revoked = true; });
  const r = await core.migration.importInventory(store, local, source, "graffiticode");
  assert.deepEqual([r.skippedRevoked, r.skippedMarked, r.tombstoned, r.imported], [1, 1, 1, 0]);
  assert.equal(await liveTokens(), 0);
  assert.equal(await store.getTokenByAccessToken(raced.access_token), null);
});

test("a crash after the local import and before markMigrated: a re-run completes it, duplicating nothing", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  await assert.rejects(core.migration.importInventory(store, local, source, "graffiticode", { afterPrepare: () => { throw new Error("crash"); } }), /crash/);
  assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "prepared");
  assert.equal(await store.getTokenByAccessToken(t.access_token), null, "a prepared import authenticates nothing");
  const r = await core.migration.importInventory(store, local, source, "graffiticode");
  assert.equal(r.imported, 1);
  assert.equal((await h.db.collection("oauth_migrations").get()).size, 1);
  assert.equal(await liveTokens(), 1);
  assert.equal((await store.getTokenByAccessToken(t.access_token))?.access_token, t.access_token);
});

test("nothing is imported before the fence", async () => {
  const { source, local, store } = setup({ fenced: false });
  source.seedToken(entry());
  await assert.rejects(core.migration.importInventory(store, local, source, "graffiticode"), /isn't fenced/);
  assert.equal(await liveTokens(), 0);
});

test("the fallback is retirable only when a re-run of the inventory finds nothing unmigrated", async () => {
  const { source, local, store } = setup();
  source.seedToken(entry());
  source.seedToken(entry(), { revoked: true });
  const pending = entry();
  source.seedToken(pending);
  assert.equal((await core.migration.report(local, source, "graffiticode")).fallbackRetirable, false);
  source.fail("markMigrated", "before");
  const first = await core.migration.importInventory(store, local, source, "graffiticode");
  assert.equal(first.leftPrepared, 1);
  const mid = await core.migration.report(local, source, "graffiticode");
  assert.deepEqual([mid.unmigrated, mid.prepared, mid.fallbackRetirable], [1, 1, false]);
  await core.migration.sweep(store, local);
  const unsealed = await core.migration.report(local, source, "graffiticode");
  assert.deepEqual([unsealed.unmigrated, unsealed.revoked, unsealed.clientsMissing, unsealed.prepared, unsealed.sealed, unsealed.fallbackRetirable], [0, 1, 0, 0, false, false],
    "only the seal is missing");
  source.seal();
  await core.migration.sweep(store, local);
  assert.equal((await core.migration.report(local, source, "graffiticode")).fallbackRetirable, true);
});

test("retirement waits until every source revocation is applied here, and the seal stops new ones", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  const pair = await store.rotateTokens(t.refresh_token, next());
  await core.migration.importInventory(store, local, source, "graffiticode"); // copies the clients
  source.seal();
  // Revoked at the source (before the seal took effect there), not yet applied here.
  source.tokens.get(core.records.tokenKey(t))!.revoked = true;
  const before = await core.migration.report(local, source, "graffiticode");
  assert.deepEqual([before.unreconciled, before.sealed, before.fallbackRetirable], [1, true, false]);
  assert.ok(await store.getTokenByAccessToken(pair.access_token), "still live until reconciled");
  await core.migration.sweep(store, local);
  assert.equal(await store.getTokenByAccessToken(pair.access_token), null);
  const after = await core.migration.report(local, source, "graffiticode");
  assert.deepEqual([after.unreconciled, after.fallbackRetirable], [0, true]);
  // Sealed: a later revocation can't land at the source, so nothing is stranded.
  const other = entry();
  source.seedToken(other);
  assert.deepEqual(await source.revoke("graffiticode", core.records.tokenKey(other)), { outcome: "refused", reason: "sealed" });
});

test("a source refusing for its seal never tombstones a credential", async () => {
  const { source, local, store } = setup();
  const t = entry();
  source.seedToken(t);
  source.seal();
  await assert.rejects(store.rotateTokens(t.refresh_token, next()), core.records.StoreUnavailable);
  assert.equal((await local.getMigration(core.records.tokenKey(t)))?.state, "prepared");
});

// --- expiry and cleanup (TTL) ------------------------------------------------------

const GRACE = 60 * 60 * 1000;
const millis = (ts: any) => ts.toMillis();

test("local pending authorizations and codes keep millisecond expiry for validation, and clean up only after it", async () => {
  let clock = Date.now();
  const { store } = setup({ now: () => clock });
  const p = { state: `state-${++n}`, client_id: CLIENT, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: "c", code_challenge_method: "S256", resource: MCP, created_at: clock };
  await store.savePendingAuth(p);
  const pdoc = (await h.db.collection("oauth_pending").doc(hash(p.state)).get()).data();
  assert.equal(pdoc.expires_at, clock + 10 * 60_000);
  assert.equal(millis(pdoc.expireAt), pdoc.expires_at + GRACE);
  const c = legacyCode({ expires_at: clock + 10 * 60_000 });
  await store.saveAuthCode(c as any);
  const cdoc = (await h.db.collection("oauth_codes").doc(hash(c.code)).get()).data();
  assert.equal(cdoc.expires_at, c.expires_at);
  assert.equal(millis(cdoc.expireAt), c.expires_at + GRACE);
  assert.equal("expireAt" in (await store.getAuthCode(c.code))!, false, "reads return the record as issued");
  // Past expiry, before any cleanup ran: still refused.
  clock += 10 * 60_000 + 1;
  assert.equal(await store.getPendingAuth(p.state), undefined);
  assert.equal(await store.takePendingAuth(p.state), undefined);
  assert.equal(await store.consumeAuthCode(c.code), false);
});

test("a legacy code's claim carries the code's own expiry; a retry never extends it", async () => {
  let clock = Date.now();
  const { source, local, store } = setup({ now: () => clock });
  const c = legacyCode({ expires_at: clock + 5 * 60_000 });
  source.seedCode(c as any);
  source.fail("consume", "after");
  await assert.rejects(store.consumeAuthCode(c.code), core.records.StoreUnavailable);
  const ref = h.db.collection("oauth_legacy_claims").doc(`code:${hash(c.code)}`);
  const first = (await ref.get()).data();
  assert.equal(first.expires_at, c.expires_at);
  assert.equal(millis(first.expireAt), c.expires_at + GRACE, "cleanup comes only after the code stopped being usable");
  clock += 60_000;
  assert.equal(await store.consumeAuthCode(c.code), true, "the retry, still within the code's life");
  const after = (await ref.get()).data();
  assert.deepEqual([after.expires_at, millis(after.expireAt)], [first.expires_at, millis(first.expireAt)], "unchanged by the retry");
  // A racing first attempt that reaches claim() after it exists changes nothing either.
  clock += 60_000;
  await local.claim("code", hash(c.code), { ...c, expires_at: clock + 10 * 60_000 } as any);
  const raced = (await ref.get()).data();
  assert.deepEqual([raced.expires_at, millis(raced.expireAt)], [first.expires_at, millis(first.expireAt)]);
});

test("an expired legacy code or claim is never consumed at the source", async () => {
  let clock = Date.now();
  const { source, store } = setup({ now: () => clock });
  const claimed = legacyCode({ expires_at: clock + 60_000 });
  source.seedCode(claimed as any);
  source.fail("consume", "before");
  await assert.rejects(store.consumeAuthCode(claimed.code), core.records.StoreUnavailable);
  const unclaimed = legacyCode({ expires_at: clock + 60_000 });
  source.seedCode(unclaimed as any);
  clock += 60_001;
  const calls = source.calls.filter(c => c.op === "consume").length;
  assert.equal(await store.consumeAuthCode(claimed.code), false, "its claim has expired");
  assert.equal(await store.consumeAuthCode(unclaimed.code), false, "expired before any claim");
  assert.equal(source.calls.filter(c => c.op === "consume").length, calls, "nothing asked of the source");
  assert.equal(await h.db.collection("oauth_legacy_claims").doc(`code:${hash(unclaimed.code)}`).get().then((d: any) => d.exists), false);
});

test("expiry passing while the claim is being created: nothing is consumed at the source", async () => {
  let clock = Date.now();
  const { source, local, store } = setup({ now: () => clock });
  const c = legacyCode({ expires_at: clock + 60_000 });
  source.seedCode(c as any);
  const p = { state: `slow-${++n}`, client_id: CLIENT, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: "c", code_challenge_method: "S256", resource: MCP, created_at: clock, expires_at: clock + 60_000 };
  source.seedPending(p as any);
  // The claim transaction completes only after the credential has expired.
  const claim = local.claim.bind(local);
  local.claim = async (...args) => {
    const made = await claim(...args);
    clock += 60_001;
    return made;
  };
  assert.equal(await store.consumeAuthCode(c.code), false);
  clock -= 60_001; // the pending authorization starts within its life too
  assert.equal(await store.takePendingAuth(p.state), undefined);
  assert.equal(source.calls.filter(x => x.op === "consume").length, 0, "the source was never asked");
  assert.equal((await source.getAuthCode(c.code))?.used, false);
});

test("expiry passing while the source consumes: the record isn't handed out", async () => {
  let clock = Date.now();
  const { source, store } = setup({ now: () => clock });
  const p = { state: `late-${++n}`, client_id: CLIENT, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: "c", code_challenge_method: "S256", resource: MCP, created_at: clock, expires_at: clock + 60_000 };
  source.seedPending(p as any);
  source.after("consume", () => { clock += 60_001; });
  assert.equal(await store.takePendingAuth(p.state), undefined);
  assert.equal(await store.takePendingAuth(p.state), undefined, "and it stays spent");
});

test("a legacy pending authorization's claim: its recorded expiry, or ten minutes from its creation", async () => {
  let clock = Date.now();
  const { source, store } = setup({ now: () => clock });
  const base = { client_id: CLIENT, redirect_uri: "https://agent.example/cb", scope: "graffiticode", code_challenge: "c", code_challenge_method: "S256", resource: MCP };
  const recorded = { ...base, state: `rec-${++n}`, created_at: clock - 60_000, expires_at: clock + 3 * 60_000 };
  const unrecorded = { ...base, state: `unrec-${++n}`, created_at: clock - 60_000 };
  source.seedPending(recorded as any);
  source.seedPending(unrecorded as any);
  assert.ok(await store.takePendingAuth(recorded.state));
  assert.ok(await store.takePendingAuth(unrecorded.state));
  const claim = async (state: string) => (await h.db.collection("oauth_legacy_claims").doc(`pending:${hash(state)}`).get()).data();
  assert.equal((await claim(recorded.state)).expires_at, recorded.expires_at);
  assert.equal((await claim(unrecorded.state)).expires_at, unrecorded.created_at + 10 * 60_000);
  for (const s of [recorded.state, unrecorded.state]) assert.equal(millis((await claim(s)).expireAt), (await claim(s)).expires_at + GRACE);
  // An expired legacy pending authorization isn't offered or taken.
  const old = { ...base, state: `old-${++n}`, created_at: clock - 11 * 60_000 };
  source.seedPending(old as any);
  assert.equal(await store.getPendingAuth(old.state), undefined);
  assert.equal(await store.takePendingAuth(old.state), undefined);
});

// --- HTTP helper ------------------------------------------------------------------

async function tokenRequest(body: Record<string, string>) {
  const req = Readable.from([Buffer.from(new URLSearchParams(body).toString())]) as any;
  req.method = "POST";
  req.url = "/oauth/token";
  req.headers = { host: "localhost" };
  const res: any = { status: 0, raw: "" };
  res.writeHead = (s: number) => ((res.status = s), res);
  res.end = (b?: string) => void (res.raw = b ?? "");
  await mcp.handlers.handleToken(req, res);
  return { status: res.status, json: res.raw ? JSON.parse(res.raw) : null };
}
