// Phase 3.5 R1.1 rehearsal. The real console handlers, worker and sweeper run
// against the emulator through the switch from protocol v1 to v2, in the order
// operators will do it:
//
//   before: v1 traffic, plus v1 tasks still queued (a silent backlog)
//   switch: the drain is confirmed and the one-way floor is written
//   after:  producers reserve v2; the held v1 backlog lands and is refused on
//           items that now have v2 jobs, and completes on items that don't;
//           redeploying with v1 configuration changes nothing; a lost wake-up
//           is recovered by the sweeper; the floor can't be removed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";
import { generate, ok } from "./helpers";

let h: Harness;
let protocol: any;
let generation: any;
let sweeper: any;
let config: any;
let health: any;
let verify: any;
before(async () => {
  h = await start();
  await h.resetFirestore();
  protocol = await import("@graffiticode-app/core/generation-protocol");
  generation = await import("@graffiticode-app/core/generation");
  sweeper = await import("@graffiticode-app/core/sweeper");
  config = await import("@graffiticode-app/core/config");
  health = (await import("../../packages/console/src/pages/api/health")).default;
  verify = (await import("../../verify/console.mjs")).default;
  protocol.resetProtocolFloorCache();
});
after(async () => { await h?.stop(); });

const alice = { token: userToken("alice") };
const PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const doc = async (path: string) => (await h.db.doc(path).get()).data();
const item = (id: string) => doc(`users/alice/items/${id}`);
const START = `mutation($itemId:String,$lang:String!,$prompt:String!,$modification:String!){
  startCodeGeneration(itemId:$itemId, lang:$lang, prompt:$prompt, modification:$modification, client:"mcp"){ itemId status } }`;
const healthReport = async () => {
  const res: any = { setHeader() {}, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
  await health({ query: { deep: "1" } }, res);
  return res.body;
};

// State shared across the steps, in order.
const s: any = {};

test("before: v1 traffic, and v1 tasks still sitting in the queue", async () => {
  assert.equal((await protocol.effectiveProtocol()).effective, 1);
  s.a = ok(await generate(h, alice, {})).startCodeGeneration.itemId;
  s.b = ok(await generate(h, alice, {})).startCodeGeneration.itemId;
  assert.equal(h.jobPayloads.length, 2);
  assert.ok(h.jobPayloads.every((p: any) => p.v === 1), "v1 jobs carry the whole request");
  // Two revisions a v1 producer queued that haven't been delivered yet: one
  // for A, one for B. They'll arrive after the switch.
  s.heldA = { ...h.jobPayloads[0], itemId: s.a, modification: "held revision of A" };
  s.heldB = { ...h.jobPayloads[1], itemId: s.b, modification: "held revision of B" };
  assert.equal((await item(s.a)).generation, undefined, "v1 items carry no pointer");
});

test("switch: the floor is written once, and the console reports v2 within the cache window", async () => {
  const r = await protocol.activateGenerationV2({ by: "rehearsal" });
  assert.equal(r.changed, true);
  assert.deepEqual(await healthReport(), { ok: true, generationProtocol: 1, minProtocol: 2, effectiveProtocol: 2 });
  // gc-deploy's candidate check on this image passes against the floor.
  const logs: string[] = [];
  await verify({ candidateUrl: "x", headers: {}, log: (m: string) => logs.push(m),
    fetch: async () => new Response(JSON.stringify(await healthReport()), { status: 200 }) });
  assert.match(logs[0], /effective 2, floor 2/);
});

test("after: new work is v2, including revisions of items made under v1", async () => {
  const before = h.jobPayloads.length;
  s.c = ok(await generate(h, alice, {})).startCodeGeneration.itemId;
  assert.deepEqual(Object.keys(h.jobPayloads[before]).sort(), ["generationId", "v"]);
  assert.equal((await item(s.c)).generation.state, "completed");

  h.setLlm(() => "```\n" + PROGRAM.replace(/"[^"]*"/, '"After the switch"') + "\n```");
  ok(await h.gql(START, { itemId: s.a, lang: "0175", prompt: "Revise A.", modification: "Revise A." }, alice));
  await h.drainJobs();
  const a = await item(s.a);
  assert.equal(a.generation.state, "completed", "A now has a v2 job");
  assert.equal(a.generationStatus, "ready");
  s.aTask = a.taskId;
});

test("after: the held v1 backlog is refused on v2 items and completes on the rest", async () => {
  const onA = await generation.runJob(s.heldA);
  assert.deepEqual(onA, { status: 200, body: { status: "refused" } });
  const a = await item(s.a);
  assert.equal(a.taskId, s.aTask, "the legacy result never landed on A");
  assert.ok(!JSON.parse(a.help).some((e: any) => e.user === "held revision of A"));

  const onB = await generation.runJob(s.heldB);
  assert.equal(onB.status, 200);
  assert.equal(onB.body.status, "ready", "B never had a v2 job: the legacy path still completes it");
  const b = await item(s.b);
  assert.equal(b.generation, undefined);
  assert.ok(JSON.parse(b.help).some((e: any) => e.user === "held revision of B"));
});

test("after: redeploying with v1 configuration still produces v2", async () => {
  const current = config.coreConfig();
  config.setCoreConfig({ ...current, generationProtocol: 1 });
  protocol.resetProtocolFloorCache();
  try {
    const before = h.jobPayloads.length;
    ok(await generate(h, alice, {}));
    assert.equal(h.jobPayloads[before].v, 2);
    assert.equal((await healthReport()).effectiveProtocol, 2);
  } finally {
    config.setCoreConfig(null);
  }
});

test("after: a v2 job whose wake-up was lost is recovered by the sweeper", async () => {
  const id = ok(await generate(h, alice, {})).startCodeGeneration.itemId;
  const { generationId } = h.jobPayloads.at(-1);
  await h.db.doc(`generation-jobs/${generationId}`).update({
    "dispatch.state": "reserved", "dispatch.leaseOwner": null, "dispatch.nextDispatchAt": Date.now() - 1,
  });
  await h.db.doc(`users/alice/items/${id}`).update({ "generation.state": "reserved", generationStatus: "generating" });
  const r = await sweeper.sweep();
  await h.drainJobs();
  assert.equal(r.jobs.dispatched, 1);
  assert.equal((await doc(`generation-jobs/${generationId}`)).dispatch.state, "completed");
  assert.equal((await item(id)).generationStatus, "ready");
  // Nothing is left due.
  assert.deepEqual(await sweeper.sweep(), { jobs: {}, effects: {}, truncated: false });
});

test("after: the floor stays — writing it again changes nothing, and it can't be removed", async () => {
  const again = await protocol.activateGenerationV2({ by: "someone" });
  assert.equal(again.changed, false);
  assert.equal(again.floor.activatedBy, "rehearsal");
  await assert.rejects(protocol.removeFloorForStaging({ project: "graffiticode-app" }), /never lowered in production/);
  await assert.rejects(protocol.removeFloorForStaging({ project: "graffiticode-staging" }), /v2 jobs exist/);
  assert.equal((await protocol.effectiveProtocol()).effective, 2);
});
