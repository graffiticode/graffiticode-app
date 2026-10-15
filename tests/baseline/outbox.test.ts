// Phase 3.5 R1c: the outbox (effects/{id}) and the sweeper. Intents committed
// with a change are carried out under a lease, rerun with the same key after a
// crash, skipped when superseded, retried with backoff and abandoned past their
// grant. The sweeper redispatches due jobs from Firestore alone.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, JOB_SECRET, type Harness } from "./harness";
import { createItem, generate, ok } from "./helpers";

let h: Harness;
let protocol: any;
let effects: any;
let sweeper: any;
let jobs: any;
let sweepRoute: any;
before(async () => {
  h = await start();
  protocol = await import("@graffiticode-app/core/generation-protocol");
  effects = await import("@graffiticode-app/core/effects");
  sweeper = await import("@graffiticode-app/core/sweeper");
  jobs = await import("@graffiticode-app/core/generation-jobs");
  sweepRoute = (await import("../../packages/console/src/pages/api/internal/sweep-generations")).default;
});
after(async () => { await h?.stop(); });

// A Broker that dedupes by idempotency key: a replay returns the recorded
// outcome without writing again.
let writes: Map<string, number>;
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
  writes = new Map();
  h.setCompile(({ idempotencyKey }) => {
    writes.set(idempotencyKey, (writes.get(idempotencyKey) ?? 0) + 1);
    return { status: 200, body: { status: "success", data: { id: "x" } } };
  });
});

const alice = { token: userToken("alice") };
const DEFAULT_PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const doc = async (path: string) => (await h.db.doc(path).get()).data();
const compiles = () => h.calls.filter(c => c.path === "/compile");
const sends = () => [...writes.values()].length;

async function connectableItem() {
  const g = ok(await generate(h, alice, { lang: "0176" })).startCodeGeneration;
  const { generationId } = h.jobPayloads.at(-1);
  return { itemId: g.itemId, generationId, effectId: `${generationId}:connection_write` };
}

// Puts an effect back as if its processor had died mid-flight.
const crashed = (id: string, fields: Record<string, unknown> = {}) =>
  h.db.doc(`effects/${id}`).update({ state: "in_flight", leaseOwner: "dead", leaseExpires: Date.now() - 1, nextAttemptAt: Date.now() - 1, ...fields });

test("a v2 completion's connection write runs right after the commit, once", async () => {
  const { itemId, effectId } = await connectableItem();
  const it = await doc(`users/alice/items/${itemId}`);
  assert.equal(compiles().length, 1);
  assert.equal(compiles()[0].body.idempotencyKey, (await doc(`effects/${effectId}`)).payload.idempotencyKey);
  assert.equal(it.lastWrite.status, "ok");
  assert.equal(it.lastWrite.taskId, it.taskId);
  assert.equal((await doc(`effects/${effectId}`)).state, "done");
  assert.equal(h.calls.filter(c => c.path === "/internal/act-as").length, 1, "the worker reused its generation token");
});

test("after a crash the sweeper resends with the same key; Broker writes once", async () => {
  const { itemId, effectId } = await connectableItem();
  await h.db.doc(`users/alice/items/${itemId}`).update({ lastWrite: null });
  await crashed(effectId);
  const r = await sweeper.sweep();
  assert.equal(r.effects.done, 1);
  assert.equal(compiles().length, 2, "sent again");
  assert.equal(sends(), 1, "one key: Broker replayed instead of writing twice");
  assert.equal((await doc(`users/alice/items/${itemId}`)).lastWrite.status, "ok", "the outcome is recorded");
  // Done effects are never picked up again.
  assert.deepEqual((await sweeper.sweep()).effects, {});
});

test("a write for a version that's no longer current is superseded, not sent", async () => {
  const { itemId, effectId } = await connectableItem();
  await h.db.doc(`users/alice/items/${itemId}`).update({ taskId: "newer" });
  await crashed(effectId);
  const before = compiles().length;
  assert.equal(await effects.processEffect(effectId), "superseded");
  assert.equal(compiles().length, before);
});

test("an act-as outage retries with backoff; past its grant the save is abandoned and shown", async () => {
  const { itemId, effectId } = await connectableItem();
  await crashed(effectId);
  h.setActAs(() => ({ status: 503, body: { status: "error", error: { message: "unavailable" } } }));
  const now = Date.now();
  assert.equal(await effects.processEffect(effectId, { now }), "pending");
  const e = await doc(`effects/${effectId}`);
  assert.equal(e.state, "pending");
  assert.equal(e.nextAttemptAt, now + effects.effectBackoffMs(e.attempts));
  assert.match(e.lastError, /unavailable|503/);

  // A week later the grant has expired: abandoned, and the user can see it.
  const later = now + 8 * 24 * 60 * 60_000;
  assert.equal(await effects.processEffect(effectId, { now: later }), "abandoned");
  const it = await doc(`users/alice/items/${itemId}`);
  assert.equal((await doc(`effects/${effectId}`)).state, "abandoned");
  assert.equal(it.lastWrite.status, "ok", "a success for this version is never replaced by the abandonment");
});

test("an abandoned save with no prior success tells the user it was not sent", async () => {
  const { itemId, effectId } = await connectableItem();
  await h.db.doc(`users/alice/items/${itemId}`).update({ lastWrite: null });
  await crashed(effectId);
  assert.equal(await effects.processEffect(effectId, { now: Date.now() + 8 * 24 * 60 * 60_000 }), "abandoned");
  const it = await doc(`users/alice/items/${itemId}`);
  assert.equal(it.lastWrite.status, "failed");
  assert.match(it.lastWrite.message, /not sent/);
});

test("an expired effect lease is taken over; a live one can't be claimed twice", async () => {
  const { itemId, effectId } = await connectableItem();
  await h.db.doc(`users/alice/items/${itemId}`).update({ lastWrite: null });
  await crashed(effectId);
  // A new processor claims it; the dead one's claim is gone.
  const claimed = await effects.claimEffect(effectId, "new-owner");
  assert.equal(claimed.leaseOwner, "new-owner");
  assert.equal(await effects.claimEffect(effectId, "third"), null, "a live lease can't be claimed");
  assert.equal((await doc(`effects/${effectId}`)).leaseOwner, "new-owner");
});

test("an editor save under v2 records its write and carries it out before answering", async () => {
  const item = await createItem(h, alice, { lang: "0176" });
  const next = h.addTask({ lang: "0176", code: { root: "2" } });
  const r = ok(await h.gql(`mutation($id:String!,$t:String!){ updateItem(id:$id, taskId:$t){ taskId lastWrite { taskId status } } }`, { id: item.id, t: next }, alice)).updateItem;
  assert.equal(r.lastWrite.taskId, next);
  assert.equal(r.lastWrite.status, "ok");
  const saved = (await h.db.collection("effects").where("itemId", "==", item.id).get()).docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const save = saved.find((e: any) => e.payload.taskId === next);
  assert.match(save.id, /^save-.*:connection_write$/);
  assert.equal(save.state, "done");
});

const effect = (id: string, kind: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  h.db.doc(`effects/${id}`).set({
    kind, sourceId: "src", uid: "alice", itemId: "i", payload, state: "pending", attempts: 0,
    nextAttemptAt: Date.now() - 1, leaseOwner: null, leaseExpires: 0, lastError: null, createdAt: Date.now(), ...extra,
  });

test("billing: an unmetered event is done; a delivery Stripe refuses is failed, not swallowed", async () => {
  await effect("m1", "stripe_meter", { subscription: { plan: "demo" }, stripeCustomerId: "cus_1", identifier: "i__t", timestamp: Date.now() });
  assert.equal(await effects.processEffect("m1"), "done");
  assert.equal((await doc("effects/m1")).skipped, "not-enrolled", "a hard-capped plan meters only once enrolled");

  // No Stripe key in this deployment: a definite failure, recorded.
  await effect("m2", "stripe_meter", { subscription: { plan: "pro" }, stripeCustomerId: "cus_1", identifier: "i__t", periodItemCount: 999, timestamp: Date.now() });
  assert.equal(await effects.processEffect("m2"), "failed");
  assert.match((await doc("effects/m2")).lastError, /STRIPE_SECRET_KEY/);
  assert.ok((await doc("effects/m2")).firstSentAt, "the first send's time is persisted before sending");
});

test("billing: past Stripe's replay window a resend stops for an operator", async () => {
  await effect("m3", "stripe_meter", { subscription: { plan: "pro" }, stripeCustomerId: "cus_1", identifier: "i__t", timestamp: Date.now() },
    { firstSentAt: Date.now() - 25 * 60 * 60_000, attempts: 3 });
  assert.equal(await effects.processEffect("m3"), "uncertain");
  assert.equal((await doc("effects/m3")).nextAttemptAt, effects.NEVER);
});

test("first_outcome and sponsor_alert effects complete", async () => {
  await effect("f1", "first_outcome", { workspaceKey: "ws-1", outcome: "ok" });
  assert.equal(await effects.processEffect("f1"), "done");
  await effect("s1", "sponsor_alert", { sponsorUid: "sponsor", sponsorName: "Acme", periodStart: Date.now() - 1000, now: Date.now() });
  assert.equal(await effects.processEffect("s1"), "done");
});

// A job whose wake-up never arrived: reserved, due, never claimed.
async function lostWakeUp(fields: Record<string, unknown> = {}) {
  const { itemId, generationId } = await jobs.reserveGeneration({ auth: { uid: "alice", token: userToken("alice") }, lang: "0175", prompt: "A poem about the sea, please.", modification: "sea" });
  await h.drainJobs();
  await h.db.doc(`generation-jobs/${generationId}`).update({
    "dispatch.state": "reserved", "dispatch.leaseOwner": null, "dispatch.nextDispatchAt": Date.now() - 1, ...fields,
  });
  await h.db.doc(`users/alice/items/${itemId}`).update({ "generation.state": "reserved", generationStatus: "generating", taskId: null });
  return { itemId, generationId };
}

test("the sweeper redispatches a job whose wake-up was lost, and it completes", async () => {
  h.setLlm(() => "```\n" + DEFAULT_PROGRAM + "\n```");
  const { itemId, generationId } = await lostWakeUp();
  const payloads = h.jobPayloads.length;
  const r = await sweeper.sweep();
  await h.drainJobs();
  assert.equal(r.jobs.dispatched, 1);
  assert.deepEqual(h.jobPayloads[payloads], { v: 2, generationId });
  const j = await doc(`generation-jobs/${generationId}`);
  assert.equal(j.dispatch.dispatchCount, 1);
  assert.equal(j.dispatch.state, "completed");
  assert.equal((await doc(`users/alice/items/${itemId}`)).generationStatus, "ready");
});

test("overlapping sweeps take one dispatch slot between them", async () => {
  h.setLlm(() => "```\n" + DEFAULT_PROGRAM + "\n```", 300);
  const { generationId } = await lostWakeUp();
  const now = Date.now();
  const outcomes = await Promise.all([jobs.redispatchJob(generationId, now), jobs.redispatchJob(generationId, now)]);
  assert.deepEqual(outcomes.sort(), ["dispatched", "skipped"]);
  await h.drainJobs();
  assert.equal((await doc(`generation-jobs/${generationId}`)).dispatch.dispatchCount, 1);
});

test("out of dispatch slots, or past the deadline, the sweeper fails the job retryably", async () => {
  const a = await lostWakeUp({ "dispatch.dispatchCount": 5 });
  await sweeper.sweep();
  assert.equal((await doc(`generation-jobs/${a.generationId}`)).dispatch.failure.code, "dispatch_exhausted");
  assert.equal((await doc(`users/alice/items/${a.itemId}`)).generationStatus, "failed");

  const b = await lostWakeUp({ "envelope.deadlineAt": Date.now() - 1 });
  await sweeper.sweep();
  const fb = (await doc(`generation-jobs/${b.generationId}`)).dispatch;
  assert.equal(fb.failure.code, "deadline_exceeded");
  assert.equal(fb.failure.retryable, true);
  assert.equal(fb.nextDispatchAt, effects.NEVER, "terminal jobs leave the due-time query");
});

test("a running job with a live lease is never redispatched", async () => {
  const { generationId } = await lostWakeUp({ "dispatch.state": "running", "dispatch.leaseOwner": "w", "dispatch.leaseExpires": Date.now() + 60_000 });
  assert.equal(await jobs.redispatchJob(generationId), "skipped");
});

test("the sweep route requires the internal job secret", async () => {
  const call = async (headers: Record<string, string>) => {
    const res: any = { status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    await sweepRoute({ method: "POST", headers }, res);
    return res;
  };
  assert.equal((await call({})).code, 401);
  const okRes = await call({ "x-internal-job-secret": JOB_SECRET });
  assert.equal(okRes.code, 200);
  assert.deepEqual(okRes.body, { jobs: {}, effects: {}, truncated: false });
});
