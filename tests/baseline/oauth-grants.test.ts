// OAuth consent grants (core/oauth-grants.ts): the one-time code the console's
// consent page hands the MCP server in place of a credential. Single use, bound
// to the authorization's state, expiring, and stored only as a hash.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, type Harness } from "./harness";

let h: Harness;
let grants: typeof import("@graffiticode-app/core/oauth-grants");
before(async () => {
  h = await start();
  grants = await import("@graffiticode-app/core/oauth-grants");
});
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const fakeCustomToken = (uid: string) =>
  `h.${Buffer.from(JSON.stringify({ uid, iss: "x" })).toString("base64url")}.s`;

test("a grant redeems once for the state it was minted for", async () => {
  const code = await grants.createOAuthGrant({ state: "s1", uid: "u1", firebaseCustomToken: fakeCustomToken("u1") });
  const got = await grants.redeemOAuthGrant({ code, state: "s1" });
  assert.deepEqual(got, { uid: "u1", firebaseCustomToken: fakeCustomToken("u1") });
  await assert.rejects(grants.redeemOAuthGrant({ code, state: "s1" }), { reason: "unknown" });
});

test("a wrong state is refused and burns the grant", async () => {
  const code = await grants.createOAuthGrant({ state: "s1", uid: "u1", firebaseCustomToken: fakeCustomToken("u1") });
  await assert.rejects(grants.redeemOAuthGrant({ code, state: "other" }), { reason: "state_mismatch" });
  await assert.rejects(grants.redeemOAuthGrant({ code, state: "s1" }), { reason: "unknown" });
});

test("an expired grant is refused", async () => {
  const minted = Date.now() - grants.OAUTH_GRANT_TTL_MS - 1;
  const code = await grants.createOAuthGrant({ state: "s1", uid: "u1", firebaseCustomToken: fakeCustomToken("u1") }, minted);
  await assert.rejects(grants.redeemOAuthGrant({ code, state: "s1" }), { reason: "expired" });
});

test("only a hash of the code is stored", async () => {
  const code = await grants.createOAuthGrant({ state: "s1", uid: "u1", firebaseCustomToken: fakeCustomToken("u1") });
  const docs = await h.db.collection("oauth-grants").get();
  assert.equal(docs.size, 1);
  assert.notEqual(docs.docs[0].id, code);
  assert.ok(!JSON.stringify(docs.docs[0].data()).includes(code));
});

test("customTokenUid reads the uid claim, and nothing from garbage", () => {
  assert.equal(grants.customTokenUid(fakeCustomToken("0xabc")), "0xabc");
  assert.equal(grants.customTokenUid("not-a-jwt"), null);
});
