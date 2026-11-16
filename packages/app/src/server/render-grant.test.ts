// node:test via tsx: `npm test` (packages/app).
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type KeyLike } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { GrantRefused, JWKS_REFETCH_MS, JWKS_TTL_MS, POLICY_ISSUER, RENDER_AUDIENCE, RENDER_TYP, buildPolicyJwks, resolveWithGrant, verifyRenderGrant, type HeldItem } from "./render-grant";

const OWNER = "uid-owner";
const ITEM = "item-1";
const TASK = "task-1";
const NOW = Date.UTC(2026, 10, 16, 12);
const nowSeconds = Math.floor(NOW / 1000);

const keysFor = async (kid = "k1") => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
  return { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }), jwks: { keys: [jwk] } };
};

const claims = (over: Record<string, unknown> = {}) => ({ sub: OWNER, itm: ITEM, tsk: TASK, cmd: "cmd-1", fg: 1, stg: "s0", occ: "rt.snap:0.x", cseq: 3, ...over });
const sign = async (privateKey: KeyLike, { payload = claims(), typ = RENDER_TYP, aud = RENDER_AUDIENCE, iss = POLICY_ISSUER, iat = nowSeconds, ttl = 300, alg = "ES256", kid = "k1" }: { payload?: Record<string, unknown>; typ?: string; aud?: string; iss?: string; iat?: number; ttl?: number; alg?: string; kid?: string } = {}) =>
  new SignJWT(payload).setProtectedHeader({ alg, kid, typ }).setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + ttl).setJti("jti-1").sign(privateKey);

const held = (over: Partial<HeldItem> = {}): HeldItem => ({ exists: true, id: ITEM, taskId: TASK, ...over });
const resolve = async (keys: JWTVerifyGetKey, grantHeader: string, { query = `id=${ITEM}`, authorization = null as string | null, item = held(), reads = [] as unknown[] } = {}) =>
  resolveWithGrant({
    grantHeader,
    authorization,
    params: new URLSearchParams(query),
    keys,
    readItem: async (uid, itemId) => {
      reads.push([uid, itemId]);
      return item;
    },
    now: () => NOW,
  });
const refusedWith = async (promise: Promise<unknown>, status: number, reason: string) => {
  const e = await promise.then(() => null, err => err);
  assert.ok(e instanceof GrantRefused, `expected a refusal, got ${e}`);
  assert.deepEqual([e.status, e.reason], [status, reason]);
};

test("resolves exactly the granted item to exactly its pinned task, reading the item under its subject", async () => {
  const { privateKey, keys } = await keysFor();
  const reads: unknown[] = [];
  const { grant, answer } = await resolve(keys, await sign(privateKey), { reads });
  assert.deepEqual(answer, { allowed: true, taskId: TASK, itemId: ITEM });
  assert.deepEqual(reads, [[OWNER, ITEM]]);
  assert.equal(grant.jti, "jti-1");
});

test("accepts only Policy's render grant: its typ, audience, issuer, algorithm and lifetime", async () => {
  const { privateKey, keys } = await keysFor();
  const other = await keysFor();
  for (const token of [
    await sign(privateKey, { typ: "gc-session+jwt" }),
    await sign(privateKey, { typ: "gc-exec+jwt", aud: "urn:graffiticode:broker" }),
    await sign(privateKey, { aud: "urn:graffiticode:policy" }),
    await sign(privateKey, { iss: "urn:someone-else" }),
    await sign(privateKey, { ttl: 301 }),
    await sign(privateKey, { iat: nowSeconds - 400 }),
    await sign(privateKey, { iat: nowSeconds + 120 }),
    await sign(other.privateKey),
    await sign(privateKey, { payload: claims({ tsk: undefined }) }),
    await sign(privateKey, { payload: claims({ cseq: "3" }) }),
    "not-a-jwt",
    "",
  ]) {
    await refusedWith(resolve(keys, token), 401, "bad-render-grant");
  }
  // The verifier on its own, too.
  await assert.rejects(verifyRenderGrant(await sign(privateKey, { ttl: 3600 }), { keys, now: () => NOW }), GrantRefused);
});

test("never mixes a grant with a user's credential", async () => {
  const { privateKey, keys } = await keysFor();
  await refusedWith(resolve(keys, await sign(privateKey), { authorization: "Bearer user-token" }), 400, "mixed-credentials");
});

test("refuses any other id, extra ids, and any other parameter", async () => {
  const { privateKey, keys } = await keysFor();
  const token = await sign(privateKey);
  const reads: unknown[] = [];
  await refusedWith(resolve(keys, token, { query: "id=item-2", reads }), 403, "grant-scope-mismatch");
  await refusedWith(resolve(keys, token, { query: `id=${TASK}` }), 403, "grant-scope-mismatch");
  for (const query of [`id=${ITEM}&id=item-2`, `id=${ITEM}&view=1`, `id=${ITEM}&taskId=other`, "", `id=`]) {
    await refusedWith(resolve(keys, token, { query, reads }), 400, "bad-request");
  }
  assert.deepEqual(reads, []);
});

test("never retargets: an item now naming another task is refused", async () => {
  const { privateKey, keys } = await keysFor();
  await refusedWith(resolve(keys, await sign(privateKey), { item: held({ taskId: "task-2" }) }), 409, "render-target-changed");
  await refusedWith(resolve(keys, await sign(privateKey), { item: held({ taskId: undefined }) }), 409, "render-target-changed");
});

test("refuses an item its subject doesn't hold, or holds inconsistently", async () => {
  const { privateKey, keys } = await keysFor();
  await refusedWith(resolve(keys, await sign(privateKey), { item: { exists: false } }), 404, "item-not-found");
  await refusedWith(resolve(keys, await sign(privateKey), { item: held({ id: "other" }) }), 404, "item-not-found");
});

test("answers an item-store failure as temporary", async () => {
  const { privateKey, keys } = await keysFor();
  const failing = resolveWithGrant({
    grantHeader: await sign(privateKey),
    authorization: null,
    params: new URLSearchParams(`id=${ITEM}`),
    keys,
    readItem: async () => { throw new Error("firestore down"); },
    now: () => NOW,
  });
  await refusedWith(failing, 503, "item-store-unavailable");
});

// The owner's review of app#117: Policy's JWKS route is private. Its keys are
// fetched with this service's ID token, and a key-service failure is 503.
const POLICY = "https://policy.example";
const keysServer = (jwks: unknown, { fail = false } = {}) => {
  const asked: unknown[] = [];
  const fetch = async (url: string, { headers }: { headers: Record<string, string> }) => {
    asked.push([url, headers.Authorization]);
    if (fail || headers.Authorization !== `Bearer id-for-${POLICY}`) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => jwks };
  };
  return { asked, fetch };
};

test("fetches Policy's keys with an ID token for Policy, and verifies a grant with them", async () => {
  const { privateKey, jwks } = await keysFor();
  const server = keysServer(jwks);
  const keys = buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch: server.fetch, now: () => NOW });
  const { answer } = await resolve(keys, await sign(privateKey));
  assert.equal(answer.taskId, TASK);
  await resolve(keys, await sign(privateKey));
  assert.deepEqual(server.asked, [[`${POLICY}/v1/jwks`, `Bearer id-for-${POLICY}`]]);
});

test("answers 503 when Policy's keys can't be fetched", async () => {
  const { privateKey, jwks } = await keysFor();
  for (const keys of [
    buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch: keysServer(jwks, { fail: true }).fetch }),
    buildPolicyJwks({ policyUrl: POLICY, idToken: async () => "not-policy's", fetch: keysServer(jwks).fetch }),
    buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch: async () => { throw new Error("unreachable"); } }),
    buildPolicyJwks({ policyUrl: POLICY, idToken: async () => { throw new Error("no metadata server"); }, fetch: keysServer(jwks).fetch }),
  ]) {
    await refusedWith(resolve(keys, await sign(privateKey)), 503, "render-grants-unavailable");
  }
});

test("holds the keys a while, refetches for an unknown key at most every 30 s, and never uses them stale", async () => {
  const { privateKey, jwks } = await keysFor();
  const stranger = await keysFor("k9");
  let now = NOW;
  let fail = false;
  const server = keysServer(jwks);
  const fetch = async (url: string, init: { headers: Record<string, string> }) => (fail ? { ok: false, status: 500, json: async () => ({}) } : server.fetch(url, init));
  const keys = buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch, now: () => now });
  await verifyRenderGrant(await sign(privateKey), { keys, now: () => NOW });
  await assert.rejects(verifyRenderGrant(await sign(stranger.privateKey, { kid: "k9" }), { keys, now: () => NOW }), (e: GrantRefused) => e.status === 401);
  assert.equal(server.asked.length, 1);
  now += JWKS_REFETCH_MS;
  await assert.rejects(verifyRenderGrant(await sign(stranger.privateKey, { kid: "k9" }), { keys, now: () => NOW }), (e: GrantRefused) => e.status === 401);
  assert.equal(server.asked.length, 2);
  now += JWKS_TTL_MS;
  fail = true;
  await assert.rejects(verifyRenderGrant(await sign(privateKey), { keys, now: () => NOW }), (e: GrantRefused) => e.status === 503);
});

// The owner's second review of app#117: a key rotation seen by two requests at
// once. The second waits for the first's refresh instead of deciding on the
// keys being replaced; a failed refresh is both's 503.
test("shares one refresh between concurrent requests, and its failure", async () => {
  const old = await keysFor("k1");
  const rotated = await keysFor("k2");
  const both = { keys: [...old.jwks.keys, ...rotated.jwks.keys] };
  let now = NOW;
  let served: unknown = old.jwks;
  // Each refresh after the first waits at a gate the test opens.
  const gate = () => {
    let open: () => void = () => {};
    const shut = new Promise<void>(resolve => { open = resolve; });
    return { shut, open };
  };
  let current = gate();
  const release = () => current.open();
  let fail = false;
  let fetches = 0;
  const fetch = async () => {
    fetches++;
    if (fetches > 1) await current.shut;
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => served };
  };
  const keys = buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch, now: () => now });
  const verify = (token: string) => verifyRenderGrant(token, { keys, now: () => NOW });
  // Signed beforehand, so both requests reach the keys together.
  const [k1a, k1b, k2a, k2b] = [await sign(old.privateKey, { kid: "k1" }), await sign(old.privateKey, { kid: "k1" }), await sign(rotated.privateKey, { kid: "k2" }), await sign(rotated.privateKey, { kid: "k2" })];
  await verify(k1a);
  served = both;
  now += JWKS_REFETCH_MS;
  const pair = Promise.all([verify(k2a), verify(k2b)]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual((await pair).map(g => g.tsk), [TASK, TASK]);
  assert.equal(fetches, 2);
  now += JWKS_TTL_MS;
  fail = true;
  current = gate();
  const failing = Promise.allSettled([verify(k1a), verify(k1b)]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const outcomes = await failing;
  assert.deepEqual(outcomes.map(o => o.status === "rejected" && (o.reason as GrantRefused).status), [503, 503]);
  assert.equal(fetches, 3);
});
