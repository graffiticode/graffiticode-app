// Phase 3.5's explicit recovery (core retryGeneration, REST POST
// /items/{id}/retry): a new job for a retryable failure, reusing the failed
// job's work inputs with a fresh id, deadline and grant.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { start, userToken, ACT_AS_SECRET, type Harness } from "./harness";
import { PROMPT, createItem } from "./helpers";

let h: Harness;
let jobs: any;
let protocol: any;
before(async () => {
  h = await start();
  jobs = await import("@graffiticode-app/core/generation-jobs");
  protocol = await import("@graffiticode-app/core/generation-protocol");
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
});

const alice = { uid: "alice", token: userToken("alice") };
const doc = async (p: string) => (await h.db.doc(p).get()).data();

// A create whose job failed retryably: reserved, then past its deadline.
async function failedCreate() {
  const { itemId, generationId } = await jobs.reserveGeneration({ auth: alice, lang: "0175", prompt: PROMPT, modification: "a lighthouse" });
  await h.drainJobs();
  await h.db.doc(`generation-jobs/${generationId}`).update({ "dispatch.state": "reserved", "dispatch.leaseOwner": null, "envelope.deadlineAt": Date.now() - 1 });
  await h.db.doc(`users/alice/items/${itemId}`).update({ "generation.state": "reserved", generationStatus: "generating", taskId: null, billed: false });
  assert.deepEqual(await jobs.runJobV2(generationId), { status: 200, body: { status: "expired" } });
  return { itemId, generationId };
}

test("a retryable failure retries as a new job with a fresh id, deadline and grant", async () => {
  const { itemId, generationId } = await failedCreate();
  const before = await doc(`generation-jobs/${generationId}`);
  const r = await jobs.retryGeneration({ auth: alice, itemId });
  await h.drainJobs();
  assert.notEqual(r.generationId, generationId);
  const j = await doc(`generation-jobs/${r.generationId}`);
  assert.equal(j.dispatch.state, "completed");
  assert.equal(j.envelope.modification, before.envelope.modification, "the same request");
  assert.equal(j.envelope.baseTaskId, null);
  assert.ok(j.envelope.deadlineAt > before.envelope.deadlineAt, "a fresh deadline");
  const [payload] = j.envelope.actAsGrant.split(".");
  assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).s, r.generationId, "a grant for the new job");
  assert.equal(createHmac("sha256", ACT_AS_SECRET).update(`act-as.v1.${payload}`).digest("base64url"), j.envelope.actAsGrant.split(".")[1]);
  const it = await doc(`users/alice/items/${itemId}`);
  assert.equal(it.generationStatus, "ready");
  assert.deepEqual(it.generation, { id: r.generationId, state: "completed" });
});

test("only a retryable failure can be retried", async () => {
  const ready = await createItem(h, { token: userToken("alice") });
  await assert.rejects(jobs.retryGeneration({ auth: alice, itemId: ready.id }), (e: any) => e.reason === "not_retryable");

  const { itemId, generationId } = await failedCreate();
  await h.db.doc(`generation-jobs/${generationId}`).update({ "dispatch.failure.retryable": false });
  await assert.rejects(jobs.retryGeneration({ auth: alice, itemId }), (e: any) => e.reason === "not_retryable");
});

test("a retry of a revision is refused if the item moved on since", async () => {
  const { itemId } = await failedCreate();
  await h.db.doc(`users/alice/items/${itemId}`).update({ taskId: "moved-on" });
  await assert.rejects(jobs.retryGeneration({ auth: alice, itemId }), (e: any) => e.reason === "item_changed");
});

test("another account's item is not found", async () => {
  const { itemId } = await failedCreate();
  await assert.rejects(jobs.retryGeneration({ auth: { uid: "bob", token: userToken("bob") }, itemId }), /not found/i);
});
