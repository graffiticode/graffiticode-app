// The migration contract's acceptance suite (legacy-contract.ts), one set of
// cases for every implementation: the stand-in in this repo's tests, and the
// real auth service before migration is activated (mcp-server's
// tests/oauth-legacy-contract.test.ts, against a disposable auth service).
//
// The cases run in order and share state, because the fence is one-way:
// records are written through the ordinary routes first, the fence is set, and
// then the fenced behavior and the migration operations are checked.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { LEGACY_CONTRACT_VERSION, LegacyFenced, type LegacySource } from "./legacy-contract.js";
import { credentialHash, tokenKey, type AuthorizationCode, type OAuthClient, type PendingAuth, type TokenEntry } from "./records.js";

export type ContractHarness = {
  source: LegacySource;
  // The installation the records belong to: records written through the
  // ordinary routes carry none, and count as Graffiticode's.
  installation: string;
  // Set the fence, and later the seal, the way the operator will.
  fence(): Promise<void>;
  seal(): Promise<void>;
};

type Test = (name: string, fn: () => Promise<void>) => unknown;

export function defineLegacyContractSuite(test: Test, harness: () => Promise<ContractHarness>) {
  let h: ContractHarness;
  const run = randomUUID().slice(0, 8);
  const token = (n: string): TokenEntry => ({
    access_token: `gcmcp_at_contract_${run}_${n}`,
    refresh_token: `gcmcp_rt_contract_${run}_${n}`,
    client_id: `contract-client-${run}`,
    client_name: "Contract",
    scope: "graffiticode",
    firebase_id_token: `fid-${n}`,
    firebase_refresh_token: `frt-${n}`,
    firebase_token_expires_at: Date.now() + 3_600_000,
    resource: "https://mcp.graffiticode.org/mcp",
    created_at: Date.now(),
  });
  const client: OAuthClient = {
    client_id: `contract-client-${run}`, client_name: "Contract", redirect_uris: ["https://agent.example/cb"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: 0,
  };
  const code = (n: string): AuthorizationCode => ({
    code: `contract-code-${run}-${n}`, client_id: client.client_id, redirect_uri: "https://agent.example/cb", scope: "graffiticode",
    code_challenge: "c", code_challenge_method: "S256", resource: "https://mcp.graffiticode.org/mcp", expires_at: Date.now() + 600_000, used: false,
  });
  const pending: PendingAuth = {
    state: `contract-state-${run}`, client_id: client.client_id, redirect_uri: "https://agent.example/cb", scope: "graffiticode",
    code_challenge: "c", code_challenge_method: "S256", resource: "https://mcp.graffiticode.org/mcp", created_at: Date.now(),
  };
  const T = { a: token("a"), b: token("b"), c: token("c"), d: token("d"), e: token("e") };
  const C = { a: code("a"), b: code("b") };
  const applied = { outcome: "applied" };
  const refused = (reason: string) => ({ outcome: "refused", reason });

  test(`contract v${LEGACY_CONTRACT_VERSION}: status reports the version, unfenced`, async () => {
    h = await harness();
    assert.deepEqual(await h.source.status(h.installation), { contract: LEGACY_CONTRACT_VERSION, fenced: false, sealed: false });
  });

  test("before the fence: ordinary writes work and migration operations are refused", async () => {
    await h.source.registerClient(client);
    for (const t of Object.values(T)) await h.source.saveToken("uid", "", t);
    for (const c of Object.values(C)) await h.source.saveAuthCode(c);
    await h.source.savePendingAuth(pending);
    assert.deepEqual(await h.source.markMigrated(h.installation, tokenKey(T.a), "rotation", "early"), refused("not_fenced"));
    assert.deepEqual(await h.source.consume(h.installation, "code", credentialHash(C.a.code), "early"), refused("not_fenced"));
    const read = await h.source.getTokenByRefreshToken(T.a.refresh_token!);
    assert.equal(read?.entry.access_token, T.a.access_token);
    assert.deepEqual([read?.revoked, read?.migration], [false, null]);
  });

  test("the fence refuses every ordinary write; reads keep working", async () => {
    await h.fence();
    assert.deepEqual(await h.source.status(h.installation), { contract: LEGACY_CONTRACT_VERSION, fenced: true, sealed: false });
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["registerClient", () => h.source.registerClient({ ...client, client_id: `${client.client_id}-late` })],
      ["savePendingAuth", () => h.source.savePendingAuth({ ...pending, state: `${pending.state}-late` })],
      ["deletePendingAuth", () => h.source.deletePendingAuth(pending.state)],
      ["saveAuthCode", () => h.source.saveAuthCode(code("late"))],
      ["markAuthCodeUsed", () => h.source.markAuthCodeUsed(C.b.code)],
      ["deleteAuthCode", () => h.source.deleteAuthCode(C.b.code)],
      ["saveToken", () => h.source.saveToken("uid", "", token("late"))],
      ["rotateTokens", () => h.source.rotateTokens(T.b.refresh_token!, token("rotated"))],
      ["updateToken", () => h.source.updateToken(T.b.access_token, { firebase_id_token: "x" })],
      ["deleteToken", () => h.source.deleteToken(T.b.access_token)],
    ];
    for (const [name, write] of writes) await assert.rejects(write, LegacyFenced, name);
    assert.equal((await h.source.getClient(client.client_id))?.client_id, client.client_id);
    assert.equal((await h.source.getPendingAuth(pending.state))?.state, pending.state);
    assert.deepEqual([(await h.source.getAuthCode(C.b.code))?.used], [false], "markAuthCodeUsed was refused");
    assert.equal((await h.source.getTokenByAccessToken(T.b.access_token))?.entry.refresh_token, T.b.refresh_token, "rotate and delete were refused");
  });

  test("consume: single use, idempotent for its claim, refused for any other", async () => {
    const hash = credentialHash(C.a.code);
    assert.deepEqual(await h.source.consume(h.installation, "code", hash, "claim-1"), applied);
    assert.deepEqual(await h.source.consume(h.installation, "code", hash, "claim-1"), applied, "the same claim is acknowledged again");
    assert.deepEqual(await h.source.consume(h.installation, "code", hash, "claim-2"), refused("consumed"));
    assert.equal((await h.source.getAuthCode(C.a.code))?.used, true);
    assert.deepEqual(await h.source.consume(h.installation, "code", credentialHash("no-such-code"), "claim-1"), refused("absent"));
    const p = credentialHash(pending.state);
    assert.deepEqual(await h.source.consume(h.installation, "pending", p, "claim-3"), applied);
    assert.deepEqual(await h.source.consume(h.installation, "pending", p, "claim-4"), refused("consumed"));
    assert.equal(await h.source.getPendingAuth(pending.state), undefined, "a consumed pending authorization reads as gone");
  });

  test("markMigrated: compare-and-set with three outcomes, visible on reads", async () => {
    const key = tokenKey(T.a);
    assert.deepEqual(await h.source.markMigrated(h.installation, key, "rotation", "claim-a"), applied);
    assert.deepEqual(await h.source.markMigrated(h.installation, key, "rotation", "claim-a"), applied, "the same claim is acknowledged again");
    assert.deepEqual(await h.source.markMigrated(h.installation, key, "import", "claim-other"), refused("claimed"));
    const read = await h.source.getTokenByAccessToken(T.a.access_token);
    assert.deepEqual(read?.migration, { mode: "rotation", claimId: "claim-a" });
    assert.deepEqual(await h.source.markMigrated(h.installation, credentialHash("no-such-token"), "import", "claim-x"), refused("absent"));
  });

  test("revoke: idempotent, refuses a later mark, visible on reads", async () => {
    const key = tokenKey(T.c);
    assert.deepEqual(await h.source.revoke(h.installation, key), applied);
    assert.deepEqual(await h.source.revoke(h.installation, key), applied);
    assert.deepEqual(await h.source.revoke(h.installation, credentialHash("no-such-token")), applied);
    assert.deepEqual(await h.source.markMigrated(h.installation, key, "import", "claim-c"), refused("revoked"));
    assert.equal((await h.source.getTokenByRefreshToken(T.c.refresh_token!))?.revoked, true);
  });

  test("inventory: the installation's tokens with their marks, and its clients, across pages", async () => {
    const seen = new Map<string, any>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await h.source.inventory(h.installation, cursor);
      for (const r of page.records) seen.set(r.key, r);
      cursor = page.next;
      assert.ok(++pages < 10_000);
    } while (cursor);
    assert.equal(seen.get(client.client_id)?.kind, "client");
    for (const t of Object.values(T)) assert.equal(seen.get(tokenKey(t))?.kind, "token", t.access_token);
    assert.deepEqual(seen.get(tokenKey(T.a)).token.migration, { mode: "rotation", claimId: "claim-a" });
    assert.equal(seen.get(tokenKey(T.c)).token.revoked, true);
    assert.deepEqual([seen.get(tokenKey(T.d)).token.revoked, seen.get(tokenKey(T.d)).token.migration], [false, null]);
  });

  test("the seal hands revocation over: every migration operation is refused, reads keep working", async () => {
    await h.seal();
    assert.deepEqual(await h.source.status(h.installation), { contract: LEGACY_CONTRACT_VERSION, fenced: true, sealed: true });
    assert.deepEqual(await h.source.revoke(h.installation, tokenKey(T.e)), refused("sealed"));
    assert.equal((await h.source.getTokenByRefreshToken(T.e.refresh_token!))?.revoked, false, "a refused revocation leaves no mark");
    assert.deepEqual(await h.source.markMigrated(h.installation, tokenKey(T.e), "import", "claim-e"), refused("sealed"));
    assert.deepEqual(await h.source.consume(h.installation, "code", credentialHash(C.b.code), "claim-b"), refused("sealed"));
    await assert.rejects(h.source.saveToken("uid", "", token("after-seal")), LegacyFenced, "still fenced");
  });
}
