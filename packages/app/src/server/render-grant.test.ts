// node:test via tsx: `npm test` (packages/app).
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type KeyLike } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { GrantRefused, POLICY_ISSUER, RENDER_AUDIENCE, RENDER_TYP, resolveWithGrant, verifyRenderGrant, type HeldItem } from "./render-grant";

const OWNER = "uid-owner";
const ITEM = "item-1";
const TASK = "task-1";
const NOW = Date.UTC(2026, 10, 16, 12);
const nowSeconds = Math.floor(NOW / 1000);

const keysFor = async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  return { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
};

const claims = (over: Record<string, unknown> = {}) => ({ sub: OWNER, itm: ITEM, tsk: TASK, cmd: "cmd-1", fg: 1, stg: "s0", occ: "rt.snap:0.x", cseq: 3, ...over });
const sign = async (privateKey: KeyLike, { payload = claims(), typ = RENDER_TYP, aud = RENDER_AUDIENCE, iss = POLICY_ISSUER, iat = nowSeconds, ttl = 300, alg = "ES256", kid = "k1" } = {}) =>
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
