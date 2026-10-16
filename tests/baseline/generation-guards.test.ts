// Phase 3.5: the guard that keeps any content change from writing around a
// running v2 generation job, and the protocol floor. (The v1 refusals tested
// here before were retired with protocol v1, 2026-10-17.)
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";
import { PROMPT, createItem, errorOf, generate, ok } from "./helpers";

let h: Harness;
let protocol: any;
let health: any;
before(async () => {
  h = await start();
  protocol = await import("@graffiticode-app/core/generation-protocol");
  health = (await import("../../packages/console/src/pages/api/health")).default;
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  protocol.resetProtocolFloorCache();
});

const alice = { token: userToken("alice") };
const DEFAULT_PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const itemDoc = (id: string) => h.db.doc(`users/alice/items/${id}`);
const setPointer = (id: string, state: string) => itemDoc(id).update({ generation: { id: "gen-1", state } });
const UPDATE = `mutation($id:String!,$t:String!){ updateItem(id:$id, taskId:$t){ taskId } }`;
const START = `mutation($itemId:String,$lang:String!,$prompt:String!,$modification:String!){
  startCodeGeneration(itemId:$itemId, lang:$lang, prompt:$prompt, modification:$modification, client:"mcp"){ itemId status } }`;

async function readyItem() {
  const g = ok(await generate(h, alice, {})).startCodeGeneration;
  const data = (await itemDoc(g.itemId).get()).data();
  assert.equal(data.generationStatus, "ready");
  return { id: g.itemId, taskId: data.taskId };
}

test("an editor save is refused while a v2 job owns the item, and allowed once it ends", async () => {
  const item = await createItem(h, alice);
  const next = h.addTask({ lang: "0175", code: { root: "1" } });
  for (const state of ["reserved", "running"]) {
    await setPointer(item.id, state);
    const err = errorOf(await h.gql(UPDATE, { id: item.id, t: next }, alice));
    assert.match(err.message, /still generating/);
    assert.equal((await itemDoc(item.id).get()).data().taskId, item.taskId, "nothing written");
  }
  await setPointer(item.id, "completed");
  assert.equal(ok(await h.gql(UPDATE, { id: item.id, t: next }, alice)).updateItem.taskId, next);
});

test("a rename is not a content change and is never blocked", async () => {
  const item = await createItem(h, alice);
  await setPointer(item.id, "running");
  const r = ok(await h.gql(`mutation($id:String!){ updateItem(id:$id, name:"renamed"){ name } }`, { id: item.id }, alice));
  assert.equal(r.updateItem.name, "renamed");
});

test("the Firestore floor ratchets the effective protocol above the configured one", async () => {
  assert.deepEqual(await protocol.effectiveProtocol(), { configured: 1, minProtocol: 1, effective: 1 });
  await h.db.doc(protocol.PROTOCOL_DOC).set({ minProtocol: 2, activatedAt: Date.now(), activatedBy: "baseline" });
  protocol.resetProtocolFloorCache();
  assert.deepEqual(await protocol.effectiveProtocol(), { configured: 1, minProtocol: 2, effective: 2 });
  // With the floor at 2, producers reserve v2 jobs whatever the env says.
  ok(await h.gql(START, { lang: "0175", prompt: PROMPT, modification: PROMPT }, alice));
  await h.drainJobs();
  assert.equal(h.jobPayloads.length, 1);
  assert.equal(h.jobPayloads[0].v, 2);
});

test("/api/health reports liveness, and the effective protocol with ?deep=1", async () => {
  const call = async (query: Record<string, string>) => {
    const res: any = { headers: {}, setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    await health({ query }, res);
    return res;
  };
  assert.deepEqual((await call({})).body, { ok: true });
  await h.db.doc(protocol.PROTOCOL_DOC).set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
  const deep = await call({ deep: "1" });
  assert.equal(deep.code, 200);
  assert.deepEqual(deep.body, { ok: true, generationProtocol: 1, minProtocol: 2, effectiveProtocol: 2 });
});
