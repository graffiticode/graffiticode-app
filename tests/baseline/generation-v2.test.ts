// Phase 3.5 R1b: generation protocol v2. Firestore owns the job; the worker
// claims a lease, runs as the user through act-as, and commits completion —
// content, version, billing accounting, funnel events and effect intents — in
// one transaction fenced on its lease and the job's deadline.
//
// v2 is switched on per test by the Firestore floor (system/generation-protocol),
// exactly as scripts/enable-generation-v2.ts will in production.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { start, userToken, ACT_AS_SECRET, CONSOLE_IDENTITY, type Harness } from "./harness";
import { PROMPT, createItem, errorOf, generate, ok, session } from "./helpers";

let h: Harness;
let protocol: any;
let jobs: any;
let tools: any;
before(async () => {
  h = await start();
  protocol = await import("@graffiticode-app/core/generation-protocol");
  jobs = await import("@graffiticode-app/core/generation-jobs");
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.GRAFFITICODE_API_URL = h.backendOrigin;
  tools = await import("../../packages/mcp-server/src/tools");
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2, activatedAt: Date.now(), activatedBy: "baseline" });
  protocol.resetProtocolFloorCache();
});

const alice = { token: userToken("alice") };
const DEFAULT_PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const aliceAuth = { uid: "alice", token: userToken("alice") };
const doc = async (path: string) => (await h.db.doc(path).get()).data();
const item = (id: string, uid = "alice") => doc(`users/${uid}/items/${id}`);
const job = (id: string) => doc(`generation-jobs/${id}`);
const actAsCalls = () => h.calls.filter(c => c.path === "/internal/act-as");
const START = `mutation($itemId:String,$lang:String!,$prompt:String!,$modification:String!){
  startCodeGeneration(itemId:$itemId, lang:$lang, prompt:$prompt, modification:$modification, client:"mcp"){ itemId status } }`;

function verifyGrant(token: string) {
  const [payload, sig] = token.split(".");
  const want = createHmac("sha256", ACT_AS_SECRET).update(`act-as.v1.${payload}`).digest("base64url");
  assert.equal(sig, want, "grant is signed with ACT_AS_GRANT_SECRET in the backend's format");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

test("a v2 create commits the item, version, billing and events in one completion", async () => {
  const g = ok(await generate(h, alice, {})).startCodeGeneration;
  assert.equal(g.status, "generating");
  assert.equal(h.jobPayloads.length, 1);
  const { v, generationId } = h.jobPayloads[0];
  assert.equal(v, 2);
  assert.deepEqual(Object.keys(h.jobPayloads[0]).sort(), ["generationId", "v"], "the task carries only the job id");

  const it = await item(g.itemId);
  assert.equal(it.generationStatus, "ready");
  assert.deepEqual(it.generation, { id: generationId, state: "completed" });
  assert.equal(it.generationDeadlineAt, null);
  assert.ok(it.taskId);
  assert.equal(it.billed, true);
  assert.equal(JSON.parse(it.help).at(-1).taskId, it.taskId);

  const j = await job(generationId);
  assert.equal(j.dispatch.state, "completed");
  assert.equal(j.dispatch.attempt, 1);
  assert.equal(j.envelope.principal.kind, "user");
  assert.equal(j.envelope.actAsGrant.length > 0, true);
  assert.equal(JSON.stringify(j).includes(userToken("alice")), false, "the job stores no bearer token");

  // The worker acted as alice through act-as, with the console's identity and the job's grant.
  const [call] = actAsCalls();
  assert.equal(call.headers["x-caller-identity"], CONSOLE_IDENTITY);
  assert.deepEqual({ ...call.body, grant: undefined }, { purpose: "generation", uid: "alice", subject: generationId, grant: undefined });
  const grant = verifyGrant(call.body.grant);
  assert.deepEqual([grant.p, grant.u, grant.s], ["generation", "alice", generationId]);

  assert.ok(await doc(`users/alice/versions/${g.itemId}__${it.taskId}`), "version recorded");
  const usage = await doc(`usage/item:${g.itemId}:creator`);
  assert.equal(usage.units, 1);
  assert.equal((await doc("usage/alice")).currentMonthTotal, 1);
  const created = await doc(`funnel-events/${generationId}:item_created`);
  assert.equal(created.ev, "item_created");
  assert.equal(created.first_for_account, true);
  assert.equal((await doc(`effects/${generationId}:first_outcome`)).payload.outcome, "ok");
});

test("a v2 revision appends help, records an edit event and bills nothing", async () => {
  const g = ok(await generate(h, alice, {})).startCodeGeneration;
  const before = await item(g.itemId);
  // A different program, so the taskId moves.
  h.setLlm(() => "```\n" + DEFAULT_PROGRAM.replace(/"[^"]*"/, '"Winter keeper"') + "\n```");
  ok(await h.gql(START, { itemId: g.itemId, lang: "0175", prompt: "Make it winter.", modification: "Make it winter." }, alice));
  await h.drainJobs();
  const after = await item(g.itemId);
  const generationId = h.jobPayloads[1].generationId;
  assert.notEqual(after.taskId, before.taskId);
  assert.equal(after.generationStatus, "ready");
  assert.equal(JSON.parse(after.help).length, JSON.parse(before.help).length + 1);
  assert.ok(await doc(`users/alice/versions/${g.itemId}__${after.taskId}`));
  assert.ok(await doc(`funnel-events/${generationId}:item_updated`));
  assert.equal(await doc(`funnel-events/${generationId}:item_created`), undefined);
  assert.equal((await doc("usage/alice")).currentMonthTotal, 1, "revisions are never billed");
  assert.equal((await job(generationId)).envelope.baseTaskId, before.taskId);
});

test("a free-plan v2 create runs as the trial account without act-as", async () => {
  const A = session(4);
  const g = ok(await generate(h, A, {})).startCodeGeneration;
  const j = await job(h.jobPayloads[0].generationId);
  assert.equal(j.envelope.principal.kind, "freePlan");
  assert.equal(j.envelope.actAsGrant, null);
  assert.equal(actAsCalls().length, 0);
  const it = await item(g.itemId, "trial-uid");
  assert.equal(it.generationStatus, "ready");
  assert.equal(await doc(`effects/item:${g.itemId}:stripe_meter:creator`), undefined, "the trial is never metered");
});

test("redelivery after completion does nothing", async () => {
  const g = ok(await generate(h, alice, {})).startCodeGeneration;
  const { generationId } = h.jobPayloads[0];
  const before = await item(g.itemId);
  const calls = h.calls.length;
  assert.deepEqual(await jobs.runJobV2(generationId), { status: 200, body: { status: "terminal" } });
  assert.deepEqual(await item(g.itemId), before);
  assert.equal(h.calls.length, calls, "no generation, no act-as");
});

test("a live lease is respected; an expired one is taken over, and the old holder is fenced out", async () => {
  const { itemId } = await jobs.reserveGeneration({ auth: aliceAuth, lang: "0175", prompt: PROMPT, modification: PROMPT });
  await h.drainJobs();
  // The wake-up ran it to completion; reserve a revision and control its lease by hand.
  const it = await item(itemId);
  assert.equal(it.generationStatus, "ready");

  const r = await jobs.reserveGeneration({ auth: aliceAuth, itemId, lang: "0175", prompt: PROMPT, modification: "again", baseTaskId: it.taskId });
  await h.drainJobs();
  // Take the job back to running with someone else's live lease.
  const ref = h.db.doc(`generation-jobs/${r.generationId}`);
  await ref.update({ "dispatch.state": "running", "dispatch.leaseOwner": "other", "dispatch.leaseExpires": Date.now() + 60_000 });
  await h.db.doc(`users/alice/items/${itemId}`).update({ "generation.state": "running", generationStatus: "generating" });
  assert.deepEqual(await jobs.runJobV2(r.generationId), { status: 200, body: { status: "busy" } });

  // Expired: a new attempt claims it and completes.
  await ref.update({ "dispatch.leaseExpires": Date.now() - 1 });
  const done = await jobs.runJobV2(r.generationId);
  assert.equal(done.body.status, "ready");
  assert.equal((await job(r.generationId)).dispatch.attempt, 2);
  // The old holder can no longer write.
  await assert.rejects(jobs.failJob(r.generationId, "other", { code: "x", retryable: false, message: "late" }), /lease lost/);
  assert.equal((await item(itemId)).generationStatus, "ready");
});

test("a job past its deadline fails durably, whoever touches it", async () => {
    const { itemId, generationId } = await jobs.reserveGeneration({ auth: aliceAuth, lang: "0175", prompt: PROMPT, modification: PROMPT });
  await h.drainJobs();
  const ref = h.db.doc(`generation-jobs/${generationId}`);
  // Rewind: not yet run, and already past its deadline.
  await ref.update({ "dispatch.state": "reserved", "dispatch.leaseOwner": null, "envelope.deadlineAt": Date.now() - 1 });
  await h.db.doc(`users/alice/items/${itemId}`).update({ "generation.state": "reserved", generationStatus: "generating" });
  assert.deepEqual(await jobs.runJobV2(generationId), { status: 200, body: { status: "expired" } });
  const j = await job(generationId);
  assert.deepEqual(j.dispatch.failure, { code: "deadline_exceeded", retryable: true, message: "Generation did not finish in time. Try again." });
  const it = await item(itemId);
  assert.equal(it.generationStatus, "failed");
  assert.equal(it.generation.state, "failed");
  assert.ok(await doc(`funnel-events/${generationId}:item_generation_failed`));
});

test("racing reservations on one item: exactly one wins", async () => {
  const base = await createItem(h, alice);
  // Hold the winner in generation, so a loser's retried transaction still finds it running.
  h.setLlm(() => "```\n" + DEFAULT_PROGRAM + "\n```", 4000);
  const attempts = await Promise.allSettled([1, 2, 3].map(n =>
    jobs.reserveGeneration({ auth: aliceAuth, itemId: base.id, lang: "0175", prompt: PROMPT, modification: `try ${n}` })));
  const won = attempts.filter(a => a.status === "fulfilled");
  const lost = attempts.filter(a => a.status === "rejected") as PromiseRejectedResult[];
  assert.equal(won.length, 1);
  for (const l of lost) assert.equal(l.reason.reason, "generation_in_progress");
  await h.drainJobs();
});

test("a revision prepared against an older taskId is refused as item_changed", async () => {
  const base = await createItem(h, alice);
  await assert.rejects(
    jobs.reserveGeneration({ auth: aliceAuth, itemId: base.id, lang: "0175", prompt: PROMPT, modification: PROMPT, baseTaskId: "stale" }),
    (e: any) => e.reason === "item_changed");
  assert.equal((await item(base.id)).generation, undefined, "nothing reserved");
});

test("a legacy job still holding its lease blocks a v2 reservation", async () => {
  const base = await createItem(h, alice);
  await h.db.doc(`users/alice/items/${base.id}`).update({
    generationStatus: "generating", generationLeaseOwner: "legacy", generationLeaseExpires: Date.now() + 60_000,
  });
  assert.match(errorOf(await h.gql(START, { itemId: base.id, lang: "0175", prompt: PROMPT, modification: PROMPT }, alice)).message, /still generating/);
});

test("an act-as refusal fails the job, retryably, without generating", async () => {
  h.setActAs(() => ({ status: 403, body: { status: "error", error: { message: "grant-expired" } } }));
  const g = ok(await generate(h, alice, {})).startCodeGeneration;
  const j = await job(h.jobPayloads[0].generationId);
  assert.equal(j.dispatch.failure.code, "credentials_refused");
  assert.equal(j.dispatch.failure.retryable, true);
  assert.equal((await item(g.itemId)).generationStatus, "failed");
  assert.equal(h.llmRequests.length, 0, "nothing generated without credentials");
});

test("an act-as outage releases the attempt for the sweeper instead of failing", async () => {
  h.setActAs(() => ({ status: 503, body: { status: "error", error: { message: "unavailable" } } }));
  const g = ok(await generate(h, alice, {})).startCodeGeneration;
  const j = await job(h.jobPayloads[0].generationId);
  assert.equal(j.dispatch.state, "running");
  assert.equal(j.dispatch.leaseOwner, null);
  assert.match(j.dispatch.lastDispatchError, /unavailable|503/);
  assert.equal((await item(g.itemId)).generationStatus, "generating");
});

test("a connectable item's completion records its connection write with a fixed key and grant", async () => {
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
  const g = ok(await generate(h, alice, { lang: "0176" })).startCodeGeneration;
  const { generationId } = h.jobPayloads[0];
  const it = await item(g.itemId);
  const effect = await doc(`effects/${generationId}:connection_write`);
  assert.equal(effect.state, "done", "carried out right after the commit (outbox.test.ts)");
  assert.equal(effect.payload.taskId, it.taskId);
  assert.equal(effect.payload.connectionId, "conn-1");
  assert.match(effect.payload.idempotencyKey, /^save:/);
  const grant = verifyGrant(effect.payload.effectGrant);
  assert.deepEqual([grant.p, grant.u, grant.s], ["effect", "alice", `${generationId}:connection_write:${it.taskId}`]);
  const sent = h.calls.filter(c => c.path === "/compile");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.idempotencyKey, effect.payload.idempotencyKey);
});

test("GraphQL and MCP: a v2 job is never failed by MCP's stale guard", async () => {
  const base = await createItem(h, alice);
  const ref = h.db.doc(`users/alice/items/${base.id}`);
  const old = Date.now() - 20 * 60_000;
  // A legacy job that old reads as failed straight away.
  await ref.update({ generationStatus: "generating", generationStartedAt: old });
  const ctx = { auth: { type: "firebase", token: userToken("alice"), source: "raw" }, clientKind: "baseline" };
  const legacy = await tools.handleToolCall(ctx, "get_item", { item_id: base.id });
  assert.match(JSON.stringify(legacy), /Generation timed out/);

  // A v2 job of the same age keeps generating until its durable state ends it.
  await ref.update({ generationStatus: "generating", generationStartedAt: old, generationDeadlineAt: Date.now() + 60_000, generation: { id: "g", state: "running" } });
  const gql = ok(await h.gql(`query($id:String!){ item(id:$id){ generationDeadlineAt } }`, { id: base.id }, alice));
  assert.ok(gql.item.generationDeadlineAt);
  setTimeout(() => { void ref.update({ generationStatus: "ready", generationDeadlineAt: null, generationStartedAt: null }); }, 1500);
  const v2 = await tools.handleToolCall(ctx, "get_item", { item_id: base.id });
  assert.doesNotMatch(JSON.stringify(v2), /timed out/);
});

test("act-as grants match the backend's format byte for byte", async () => {
  const { signActAsGrant } = await import("@graffiticode-app/core/act-as");
  // Produced by @graffiticode/common/act-as signActAsGrant (graffiticode e0973f7a).
  assert.equal(
    signActAsGrant("v".repeat(32), { purpose: "generation", uid: "alice", subject: "gen-1", notAfter: 1700000000000 }),
    "eyJwIjoiZ2VuZXJhdGlvbiIsInUiOiJhbGljZSIsInMiOiJnZW4tMSIsIm4iOjE3MDAwMDAwMDAwMDB9.Pfs65Z379N6gjeyHUWnc4dI0kaJbw4Qi8NMjZvm15fU",
  );
  assert.throws(() => signActAsGrant("short", { purpose: "generation", uid: "a", subject: "s", notAfter: 1 }), /at least 32/);
});
