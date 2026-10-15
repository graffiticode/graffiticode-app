// Phase 3.5 R1a: the guards that keep v1 (legacy) work from writing around a v2
// generation job. No producer writes a `generation` pointer yet, so these tests
// plant one by hand, the way a v2 reservation will.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";
import { PROMPT, createItem, errorOf, generate, ok } from "./helpers";

let h: Harness;
let protocol: any;
let runJob: any;
let health: any;
before(async () => {
  h = await start();
  protocol = await import("@graffiticode-app/core/generation-protocol");
  ({ runJob } = await import("@graffiticode-app/core/generation"));
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

test("a v1 revision is refused while a v2 job is active, and on any item that has had one", async () => {
  const { id } = await readyItem();
  await setPointer(id, "running");
  assert.match(errorOf(await h.gql(START, { itemId: id, lang: "0175", prompt: PROMPT, modification: PROMPT }, alice)).message, /still generating/);
  await setPointer(id, "completed");
  assert.match(errorOf(await h.gql(START, { itemId: id, lang: "0175", prompt: PROMPT, modification: PROMPT }, alice)).message, /protocol v2/);
  assert.equal(h.jobPayloads.length, 1, "only the original create was enqueued");
});

test("a queued v1 job is refused, without writing, once the item has a v2 pointer", async () => {
  const { id, taskId } = await readyItem();
  const job = { ...h.jobPayloads[0], itemId: id };
  await setPointer(id, "running");
  const r = await runJob(job);
  assert.deepEqual(r, { status: 200, body: { status: "refused" } });
  const data = (await itemDoc(id).get()).data();
  assert.equal(data.taskId, taskId);
  assert.equal(data.generationLeaseOwner ?? null, null, "no lease taken");
});

test("a v1 completion is refused if a v2 pointer lands while it generates", async () => {
  const { id } = await readyItem();
  const before = (await itemDoc(id).get()).data();
  const job = { ...h.jobPayloads[0], itemId: id, modification: "winter" };
  // Slow the model so the pointer can land after the claim, before completion.
  h.setLlm(() => "```\n" + DEFAULT_PROGRAM + "\n```", 400);
  const p = runJob(job);
  while (!(await itemDoc(id).get()).data()?.generationLeaseOwner) await new Promise(r => setTimeout(r, 5));
  await setPointer(id, "running");
  assert.deepEqual(await p, { status: 200, body: { status: "refused" } });
  const after = (await itemDoc(id).get()).data();
  assert.equal(after.help, before.help, "the legacy result never landed");
  assert.equal(after.generationLeaseOwner, null, "the refused job released its lease");
});

test("the Firestore floor ratchets the effective protocol above the configured one", async () => {
  assert.deepEqual(await protocol.effectiveProtocol(), { configured: 1, minProtocol: 1, effective: 1 });
  await h.db.doc(protocol.PROTOCOL_DOC).set({ minProtocol: 2, activatedAt: Date.now(), activatedBy: "baseline" });
  protocol.resetProtocolFloorCache();
  assert.deepEqual(await protocol.effectiveProtocol(), { configured: 1, minProtocol: 2, effective: 2 });
  // This revision can't produce v2 jobs, so it refuses rather than enqueue v1 work.
  assert.match(errorOf(await h.gql(START, { lang: "0175", prompt: PROMPT, modification: PROMPT }, alice)).message, /protocol v2 is enabled/);
  assert.equal(h.jobPayloads.length, 0);
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
