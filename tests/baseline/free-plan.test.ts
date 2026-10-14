// Free-plan (anonymous MCP) behaviour: workspace-scoped listing, by-id
// capability access across namespaces, expiry, limits, adoption, and the
// restricted version history.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, userToken, type Harness } from "./harness";
import { ITEM_FIELDS, PROMPT, createItem, errorOf, generate, getItem, ok, session } from "./helpers";

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const A = session(1);
const B = session(2);

test("listing is scoped to the caller's namespace", async () => {
  const a = await createItem(h, A, { name: "in-a" });
  await createItem(h, B, { name: "in-b" });
  const la = ok(await h.gql(`query { items(lang:"0175"){ id name } }`, {}, A)).items;
  const lb = ok(await h.gql(`query { items(lang:"0175"){ id name } }`, {}, B)).items;
  assert.deepEqual(la.map((i: any) => i.name), ["in-a"]);
  assert.deepEqual(lb.map((i: any) => i.name), ["in-b"]);
  assert.equal(la[0].id, a.id);
});

test("by-id access treats the item id as the capability, across namespaces", async () => {
  const a = await createItem(h, A, { name: "shared-by-id" });
  const fromB = ok(await getItem(h, B, a.id)).item;
  assert.equal(fromB.id, a.id);
  assert.equal(fromB.name, "shared-by-id");
});

test("an expired free-plan item is reported as expired (wrapped), not as missing", async () => {
  const a = await createItem(h, A, { name: "old" });
  const snap = await h.db.collectionGroup("items").get();
  const ref = snap.docs.find((d: any) => d.id === a.id).ref;
  const data = (await ref.get()).data();
  assert.ok("expiresAt" in data, `free-plan items carry expiresAt: ${Object.keys(data)}`);
  await ref.update({ expiresAt: Date.now() - 1000 });
  // Today the item resolver re-wraps the FreePlanError, so the client gets the
  // expiry text behind "Failed to get item:" and no free_plan_item_expired code.
  const err = errorOf(await getItem(h, A, a.id));
  assert.match(err.message, /^Failed to get item: This item has expired\./);
  assert.equal(err.extensions?.code, undefined);
  // Expired items also drop out of the namespace's listing.
  assert.deepEqual(ok(await h.gql(`query { items(lang:"0175"){ id } }`, {}, A)).items, []);
});

test("free-plan items are listed only once they have a program", async () => {
  // A generation whose prompt is under the free plan's minimum fails, leaving
  // a shell with no taskId: readable by id, absent from the listing.
  const g = ok(await generate(h, A, { prompt: "too short", modification: "too short" })).startCodeGeneration;
  const item = ok(await getItem(h, A, g.itemId)).item;
  assert.equal(item.generationStatus, "failed");
  assert.equal(item.taskId, null);
  assert.match(item.generationError, /at least 20 characters/);
  assert.deepEqual(ok(await h.gql(`query { items(lang:"0175"){ id } }`, {}, A)).items, []);
});

test("free-plan responses carry a workspace handle and a claim token; signed-in ones don't", async () => {
  const a = await createItem(h, A);
  assert.match(a.workspace, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.match(a.claimToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const u = await createItem(h, { token: userToken("alice") });
  assert.equal(u.workspace, null);
  assert.equal(u.claimToken, null);
});

test("sending the returned workspace handle lands later items in the same workspace", async () => {
  const first = await createItem(h, A, { name: "one" });
  const next = { freePlan: first.workspace };
  await createItem(h, next, { name: "two" });
  const names = ok(await h.gql(`query { items(lang:"0175"){ name } }`, {}, A)).items.map((i: any) => i.name).sort();
  assert.deepEqual(names, ["one", "two"]);
});

test("startCodeGeneration reports the workspace namespace for free-plan callers only", async () => {
  const g = ok(await generate(h, A, {})).startCodeGeneration;
  assert.equal(g.status, "generating");
  assert.match(g.workspaceNamespace, /^[0-9a-f]{64}$/);
  const u = ok(await generate(h, { token: userToken("alice") }, {})).startCodeGeneration;
  assert.equal(u.workspaceNamespace, null);
});

test("free-plan version history is empty; signed-in history lists versions", async () => {
  await createItem(h, A);
  assert.deepEqual(ok(await h.gql(`query { taskVersions(lang:"0175"){ taskId } }`, {}, A)).taskVersions, []);
  const alice = { token: userToken("alice") };
  const item = await createItem(h, alice);
  const versions = ok(await h.gql(`query { taskVersions(lang:"0175"){ taskId } }`, {}, alice)).taskVersions;
  assert.deepEqual(versions.map((v: any) => v.taskId), [item.taskId]);
});

test("the free-plan revision limit stops further generations on an item", async () => {
  const g = ok(await generate(h, A, {})).startCodeGeneration;
  const ready = ok(await getItem(h, A, g.itemId)).item;
  assert.equal(ready.generationStatus, "ready", JSON.stringify(ready));
  // Use up the remaining revisions directly, then ask for one more.
  const snap = await h.db.collectionGroup("items").get();
  const ref = snap.docs.find((d: any) => d.id === g.itemId).ref;
  await ref.update({ trialRevisions: 1000 });
  ok(await generate(h, A, { itemId: g.itemId, modification: "Make the lighthouse keeper older and wiser." }));
  const after = ok(await getItem(h, A, g.itemId)).item;
  assert.equal(after.generationStatus, "failed");
  assert.match(after.generationError, /revision/i);
});

test("a burst of free-plan requests is throttled with 429", async () => {
  process.env.FREE_PLAN_API_BURST_LIMIT = "3";
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await h.gql(`query { items(lang:"0175"){ id } }`, {}, A)).status);
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.ok(statuses.slice(3).every(s => s === 429), `statuses: ${statuses}`);
  } finally {
    delete process.env.FREE_PLAN_API_BURST_LIMIT;
  }
});

test("free-plan callers can't check connection writes", async () => {
  const a = await createItem(h, A);
  const err = errorOf(await h.gql(`mutation($id:String!){ reconcileItemWrite(id:$id){ id } }`, { id: a.id }, A));
  assert.match(err.message, /full account/);
});

test("PROMPT is long enough for the free plan", () => {
  assert.ok(PROMPT.length >= 20);
  assert.ok(ITEM_FIELDS.includes("lastWrite"));
});
