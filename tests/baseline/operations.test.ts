// Phase 3.5 R1d: what operators and reports need around v2 — funnel reports
// that read the events v2 commits to Firestore, billing deliveries waiting for
// a person, the drain gate, the one-way floor, and the candidate check.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, userToken, type Harness } from "./harness";
import { generate, ok } from "./helpers";

let h: Harness;
let digest: any;
let effects: any;
let protocol: any;
let drain: any;
let verify: any;
before(async () => {
  h = await start();
  digest = await import("../../packages/console/src/lib/funnel-digest");
  effects = await import("@graffiticode-app/core/effects");
  protocol = await import("@graffiticode-app/core/generation-protocol");
  drain = await import("../../packages/console/src/lib/generation-drain");
  verify = (await import("../../verify/console.mjs")).default;
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  protocol.resetProtocolFloorCache();
});

const alice = { token: userToken("alice") };
const count = async (collection: string) => (await h.db.collection(collection).get()).size;

test("reports read the events a v2 completion committed, in its window, without writing", async () => {
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
  const t0 = Date.now();
  ok(await generate(h, alice, {}));
  const t1 = Date.now() + 1;
  const docsBefore = await count("funnel-events");
  const first = await digest.fetchStoredEvents(new Date(t0), new Date(t1));
  const again = await digest.fetchStoredEvents(new Date(t0), new Date(t1));
  assert.deepEqual(first, again, "repeatable");
  assert.equal(await count("funnel-events"), docsBefore, "reading writes nothing");
  const created = first.find((e: any) => e.ev === "item_created");
  assert.ok(created, "the MCP create is reported");
  assert.equal(created.app, "mcp");
  assert.equal(created.at, undefined, "the storage field isn't part of the event");
  assert.deepEqual(await digest.fetchStoredEvents(new Date(t1), new Date(t1 + 60_000)), [], "outside the window: not counted");
});

test("stored events pass the same MCP-only filter as log lines, and merge in time order", async () => {
  const at = Date.now();
  const put = (id: string, e: Record<string, unknown>) => h.db.doc(`funnel-events/${id}`).set({ ...e, at });
  await put("a:item_created", { ev: "item_created", t: new Date(at).toISOString(), app: "mcp", session: "s1" });
  await put("b:item_created", { ev: "item_created", t: new Date(at).toISOString(), app: "console", session: "s2" });
  const stored = await digest.fetchStoredEvents(new Date(at - 1), new Date(at + 1));
  assert.deepEqual(stored.map((e: any) => e.session), ["s1"], "console authoring stays out");
  const merged = digest.mergeEvents(
    [{ ev: "mcp_tool", t: "2026-10-15T10:00:02.000Z" }, { ev: "mcp_tool", t: "2026-10-15T10:00:00.000Z" }],
    [{ ev: "item_created", t: "2026-10-15T10:00:01.000Z" }],
  );
  assert.deepEqual(merged.map((e: any) => e.t), ["2026-10-15T10:00:00.000Z", "2026-10-15T10:00:01.000Z", "2026-10-15T10:00:02.000Z"]);
});

const meter = (id: string, state: string, extra: Record<string, unknown> = {}) => h.db.doc(`effects/${id}`).set({
  kind: "stripe_meter", sourceId: "g", uid: "alice", itemId: "i1", state, attempts: 4, nextAttemptAt: effects.NEVER,
  leaseOwner: null, leaseExpires: 0, lastError: "x", createdAt: Date.now(),
  payload: { payer: "creator", stripeCustomerId: "cus_1", identifier: "i1__t1", timestamp: Date.now() - 3600_000 },
  firstSentAt: Date.now() - 25 * 3600_000, ...extra,
});

test("billing deliveries that stopped are listed, and an operator resolves them", async () => {
  await meter("e1", "uncertain");
  await meter("e2", "failed");
  await meter("e3", "done");
  await h.db.doc("effects/e4").set({ kind: "connection_write", state: "failed", payload: {}, createdAt: 0 });
  const rows = await effects.listBillingAttention();
  assert.deepEqual(rows.map((r: any) => r.id).sort(), ["e1", "e2"]);
  assert.equal(rows[0].identifier, "i1__t1");

  await effects.resolveBillingEffect("e1", "done", "op@example.com");
  const e1 = (await h.db.doc("effects/e1").get()).data();
  assert.equal(e1.state, "done");
  assert.deepEqual({ ...e1.resolution, at: 0 }, { action: "done", by: "op@example.com", at: 0, previousState: "uncertain" });

  await effects.resolveBillingEffect("e2", "resend", "op@example.com");
  const e2 = (await h.db.doc("effects/e2").get()).data();
  assert.equal(e2.state, "pending");
  assert.equal(e2.firstSentAt, null, "the next claim sends once more");
  assert.ok(e2.nextAttemptAt <= Date.now());

  await assert.rejects(effects.resolveBillingEffect("e3", "done", "op"), /not waiting for an operator/);
  await assert.rejects(effects.resolveBillingEffect("e4", "done", "op"), /not a billing effect/);
});

const NOW = Date.parse("2026-10-20T12:00:00Z");
const QUIET = 20 * 60_000;
const revs = [
  { name: "console-old-1", createdAt: NOW - 10 * 86_400_000 },
  { name: "console-old-2", createdAt: NOW - 5 * 86_400_000 },
  { name: "console-r1", createdAt: NOW - 86_400_000 },
];
const idle = { "console-old-1": [[NOW - 40 * 60_000, 0], [NOW - 60_000, 0]], "console-old-2": [[NOW - 40 * 60_000, 0]] } as any;
const verdict = (over: Record<string, unknown>) => drain.drainVerdict({
  service: "console", floorRevision: "console-r1", revisions: revs, now: NOW, quietMs: QUIET,
  traffic: [{ revisionName: "console-r1", percent: 100 }], instances: idle, ...over,
});

test("the drain gate: clean only with no tags, traffic or recent instances on pre-floor revisions", async () => {
  const clean = verdict({});
  assert.equal(clean.ok, true, JSON.stringify(clean.problems));
  assert.deepEqual(clean.pre, ["console-old-1", "console-old-2"]);

  const tagged = verdict({ traffic: [{ revisionName: "console-r1", percent: 100 }, { revisionName: "console-old-2", percent: 0, tag: "rmv778lrd-8a0873" }] });
  assert.equal(tagged.ok, false);
  assert.match(tagged.problems[0], /tag "rmv778lrd-8a0873".*retire-tags/);

  assert.match(verdict({ traffic: [{ revisionName: "console-old-2", percent: 10 }, { revisionName: "console-r1", percent: 90 }] }).problems.join(), /10% of traffic/);

  const busy = verdict({ instances: { ...idle, "console-old-2": [[NOW - 5 * 60_000, 1]] } });
  assert.equal(busy.ok, false);
  assert.match(busy.problems[0], /had instances/);

  assert.match(verdict({ floorRevision: "nope" }).problems[0], /not found/);
  assert.match(verdict({ instances: { "console-old-1": [[NOW - 60_000, 0]] } }).problems.join(), /don't cover/);
});

test("the v2 floor is one-way; only staging can remove it, and only before any v2 job", async () => {
  const first = await protocol.activateGenerationV2({ by: "op@example.com", now: 1 });
  assert.equal(first.changed, true);
  const again = await protocol.activateGenerationV2({ by: "someone-else", now: 2 });
  assert.equal(again.changed, false);
  assert.equal(again.floor.activatedBy, "op@example.com", "the first activation stands");
  assert.equal((await protocol.effectiveProtocol()).effective, 2);

  await assert.rejects(protocol.removeFloorForStaging({ project: "graffiticode-app" }), /never lowered in production/);
  await h.db.doc("generation-jobs/g1").set({ dispatch: { state: "completed" } });
  await assert.rejects(protocol.removeFloorForStaging({ project: "graffiticode-staging" }), /v2 jobs exist/);
  await h.db.doc("generation-jobs/g1").delete();
  await protocol.removeFloorForStaging({ project: "graffiticode-staging" });
  assert.equal((await protocol.effectiveProtocol()).effective, 1);
});

test("the console candidate check passes an R1 image and refuses an older one", async () => {
  const logs: string[] = [];
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  await verify({ candidateUrl: "https://c", headers: {}, log: (m: string) => logs.push(m),
    fetch: respond(200, { ok: true, generationProtocol: 1, minProtocol: 2, effectiveProtocol: 2 }) });
  assert.match(logs[0], /effective 2, floor 2/);
  await assert.rejects(verify({ candidateUrl: "https://c", headers: {}, log: () => {}, fetch: respond(404, {}) }), /expected 200, got 404/);
  await assert.rejects(verify({ candidateUrl: "https://c", headers: {}, log: () => {}, fetch: respond(200, { ok: true }) }), /no protocol report/);
  await assert.rejects(verify({ candidateUrl: "https://c", headers: {}, log: () => {},
    fetch: respond(200, { ok: true, minProtocol: 2, effectiveProtocol: 1 }) }), /below the floor/);
});
