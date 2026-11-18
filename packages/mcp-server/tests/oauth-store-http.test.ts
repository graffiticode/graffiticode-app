// The legacy store's HTTP client keeps the contract's outcomes exact, and the
// token endpoint advertises the lifetime of what it actually issued
// (installations plan, P5: the OAuth-store handover).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test, { afterEach } from "node:test";
import { LegacyTransient } from "@graffiticode-app/core/oauth/legacy-contract";
import { legacySource, setOAuthStore } from "../src/oauth/firestore-store.js";
import { handleToken } from "../src/oauth/handlers.js";

delete process.env.PROFILE_DIR;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setOAuthStore(null);
});
const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
};

test("only the contract's own outcomes are outcomes; anything else is unknown, never a refusal", async () => {
  for (const body of [{}, { outcome: "refused" }, { outcome: "refused", reason: "nope" }, { outcome: "Applied" }, [], "not json"]) {
    answer(200, body);
    await assert.rejects(legacySource.markMigrated("graffiticode", "k", "rotation", "c"), LegacyTransient, JSON.stringify(body));
    await assert.rejects(legacySource.consume("graffiticode", "code", "k", "c"), LegacyTransient, JSON.stringify(body));
  }
  answer(200, { outcome: "applied" });
  assert.deepEqual(await legacySource.markMigrated("graffiticode", "k", "rotation", "c"), { outcome: "applied" });
  answer(200, { outcome: "refused", reason: "revoked", extra: 1 });
  assert.deepEqual(await legacySource.markMigrated("graffiticode", "k", "rotation", "c"), { outcome: "refused", reason: "revoked" });
  for (const status of [400, 404, 503]) {
    answer(status, { outcome: "refused", reason: "revoked" });
    await assert.rejects(legacySource.markMigrated("graffiticode", "k", "rotation", "c"), LegacyTransient, `status ${status}`);
  }
});

test("status, revoke and inventory answers are checked too", async () => {
  answer(200, { contract: "1", fenced: true });
  await assert.rejects(legacySource.status("graffiticode"), LegacyTransient);
  answer(200, { contract: 1, fenced: true });
  await assert.rejects(legacySource.status("graffiticode"), LegacyTransient, "sealed is required");
  answer(200, { contract: 1, fenced: true, sealed: false });
  assert.deepEqual(await legacySource.status("graffiticode"), { contract: 1, fenced: true, sealed: false });
  answer(200, {});
  await assert.rejects(legacySource.revoke("graffiticode", "k"), LegacyTransient);
  answer(200, { outcome: "refused", reason: "sealed" });
  assert.deepEqual(await legacySource.revoke("graffiticode", "k"), { outcome: "refused", reason: "sealed" });
  answer(200, { records: [{ key: "k", kind: "token" }], next: null });
  await assert.rejects(legacySource.inventory("graffiticode"), LegacyTransient);
});

test("a fenced write is LegacyFenced; an unreachable service is LegacyTransient", async () => {
  answer(409, { error: "migration_fenced" });
  await assert.rejects(legacySource.markAuthCodeUsed("code"), { name: "LegacyFenced" });
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(legacySource.getClient("c"), LegacyTransient);
});

// --- expires_in ------------------------------------------------------------------

const CLIENT = { client_id: "c1", redirect_uris: ["https://a.example/cb"], grant_types: ["refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: 0 };
const ENTRY = { access_token: "gcmcp_at_old", refresh_token: "gcmcp_rt_old", client_id: "c1", scope: "graffiticode", firebase_id_token: "f", firebase_refresh_token: "fr", firebase_token_expires_at: Date.now() + 3_600_000, resource: "https://mcp.graffiticode.org/mcp", created_at: Date.now() };

function storeIssuing(issued: Record<string, unknown>) {
  setOAuthStore({
    getClient: async () => CLIENT,
    getTokenByRefreshToken: async () => ENTRY,
    rotateTokens: async () => issued,
  } as any);
}
async function refresh() {
  const req = Readable.from([Buffer.from(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "gcmcp_rt_old", client_id: "c1" }).toString())]) as any;
  req.method = "POST";
  req.url = "/oauth/token";
  req.headers = { host: "localhost" };
  const res: any = { status: 0, raw: "" };
  res.writeHead = (s: number) => ((res.status = s), res);
  res.end = (b?: string) => void (res.raw = b ?? "");
  await handleToken(req, res);
  return { status: res.status, json: JSON.parse(res.raw) };
}

test("expires_in is what's left on the issued token, not a fixed lifetime", async () => {
  const now = Date.now();
  storeIssuing({ ...ENTRY, access_token: "gcmcp_at_pair", refresh_token: "gcmcp_rt_pair", created_at: now - 45 * 60_000, access_token_expires_at: now + 10 * 60_000 });
  const r = await refresh();
  assert.equal(r.status, 200);
  assert.ok(r.json.expires_in > 590 && r.json.expires_in <= 600, String(r.json.expires_in));
  // Recorded without an explicit expiry: 55 minutes from its creation.
  storeIssuing({ ...ENTRY, access_token: "gcmcp_at_pair2", refresh_token: "gcmcp_rt_pair2", created_at: now - 50 * 60_000 });
  const r2 = await refresh();
  assert.ok(r2.json.expires_in > 290 && r2.json.expires_in <= 300, String(r2.json.expires_in));
});

test("an issued token that has already expired is never handed out: the client retries", async () => {
  storeIssuing({ ...ENTRY, access_token: "gcmcp_at_stale", refresh_token: "gcmcp_rt_stale", created_at: Date.now() - 2 * 3_600_000, access_token_expires_at: Date.now() - 1 });
  const r = await refresh();
  assert.deepEqual([r.status, r.json.error], [503, "temporarily_unavailable"]);
  assert.equal(r.json.access_token, undefined);
});
