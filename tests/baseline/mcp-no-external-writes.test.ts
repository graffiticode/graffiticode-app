// MCP authoring never writes outside Graffiticode (OpenAI's app review: no
// operation hidden behind create_item / update_item).
//
// The in-process MCP backend passes core a trusted `{ externalWrites: false }`
// (a separate argument GraphQL and REST never reach). The job records it, and
// the worker then skips the connection lookup entirely: no connection_write is
// recorded and nothing is sent through a connection. The check is about the
// EFFECT, not the language: it runs before, and regardless of, whatever
// language or composed upstreams the router produced, so routing and
// composition are unchanged. Saving to a Learnosity item bank is a console
// action, and that path is unchanged too.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";
import { PROMPT } from "./helpers";

let h: Harness;
let jobs: any;
let protocol: any;
let revise: any;
before(async () => {
  h = await start();
  jobs = await import("@graffiticode-app/core/generation-jobs");
  protocol = await import("@graffiticode-app/core/generation-protocol");
  revise = await import("@graffiticode-app/core/revise");
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2, activatedAt: Date.now(), activatedBy: "baseline" });
  protocol.resetProtocolFloorCache();
});

const alice = { uid: "alice", token: userToken("alice") };
const ctx = { token: userToken("alice") };
const MCP = { externalWrites: false } as const;
const doc = async (p: string) => (await h.db.doc(p).get()).data();
const DEFAULT_PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const withConnection = () => {
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
};
const lastGenerationId = () => h.jobPayloads.at(-1).generationId;
const connectionCompiles = () => h.calls.filter(c => c.path === "/compile" && c.body?.connectionId);

async function assertNoWrite(generationId: string) {
  const j = await doc(`generation-jobs/${generationId}`);
  assert.equal(j.envelope.externalWrites, false);
  assert.equal(j.dispatch.state, "completed");
  assert.equal(await doc(`effects/${generationId}:connection_write`), undefined, "no connection write recorded");
  assert.deepEqual(connectionCompiles(), [], "nothing sent through the connection");
}

test("MCP create of a Learnosity item by a signed-in user with a connection writes nothing externally", async () => {
  withConnection();
  const r = await revise.createFromDescription(ctx, { lang: "0176", description: "A multiple choice question about photosynthesis. Save it to my item bank.", client: "mcp" }, MCP);
  await h.drainJobs();
  await assertNoWrite(lastGenerationId());
  assert.equal((await doc(`users/alice/items/${r.itemId}`)).generationStatus, "ready");
});

test("MCP update of a Learnosity item writes nothing externally either", async () => {
  withConnection();
  const created = await revise.createFromDescription(ctx, { lang: "0176", description: "A question about photosynthesis.", client: "mcp" }, MCP);
  await h.drainJobs();
  h.calls.length = 0;
  // A real revision: a different program, so a new version (writes follow only a new version).
  h.setLlm(() => DEFAULT_PROGRAM.replace('"Title"', '"Harder title"'));
  try {
    await revise.reviseItem(ctx, { itemId: created.itemId, modification: "Make it harder, and save it to the item bank.", client: "mcp" }, MCP);
    await h.drainJobs();
    const it = await doc(`users/alice/items/${created.itemId}`);
    assert.notEqual(it.taskId, (await doc(`generation-jobs/${lastGenerationId()}`)).envelope.baseTaskId, "a new version");
    await assertNoWrite(lastGenerationId());
  } finally {
    h.setLlm(() => DEFAULT_PROGRAM);
  }
});

test("routing is unchanged: a marked request the router moves to another language still routes, and still writes nothing", async () => {
  withConnection();
  const saved = process.env.SCOPE_GATE_ENABLED;
  process.env.SCOPE_GATE_ENABLED = "true";
  h.setLlm((req) => /best-fit language id/.test(JSON.stringify(req))
    ? '{"inScope": false, "routedLang": "0179", "reason": "It is a spreadsheet."}'
    : DEFAULT_PROGRAM);
  try {
    // The client guessed a quiz; the router moves it to the spreadsheet language.
    const r = await revise.createFromDescription(ctx, { lang: "0180", description: "A budget spreadsheet with rent and food rows.", client: "mcp" }, MCP);
    await h.drainJobs();
    assert.equal((await doc(`users/alice/items/${r.itemId}`)).lang, "0179", "the router still chooses the language");
    await assertNoWrite(lastGenerationId());
  } finally {
    process.env.SCOPE_GATE_ENABLED = saved;
    h.setLlm(() => DEFAULT_PROGRAM);
  }
});

test("the unmarked path (console, GraphQL, REST) still writes through the connection, unchanged", async () => {
  withConnection();
  await revise.createFromDescription(ctx, { lang: "0176", description: "A multiple choice question about photosynthesis.", client: "mcp" });
  await h.drainJobs();
  const generationId = lastGenerationId();
  assert.equal((await doc(`generation-jobs/${generationId}`)).envelope.externalWrites, true);
  assert.ok(await doc(`effects/${generationId}:connection_write`), "today's behaviour for every other caller");
});

test("the marker can't come from request input: GraphQL has no such argument", async () => {
  const r = await h.gql(`mutation($lang:String!,$prompt:String!,$modification:String!){
    startCodeGeneration(lang:$lang, prompt:$prompt, modification:$modification, client:"mcp", externalWrites:false){ itemId } }`,
  { lang: "0175", prompt: PROMPT, modification: PROMPT }, ctx);
  assert.ok(r.body.errors?.length, "the schema rejects it");
});

test("a retry of MCP authoring stays write-free", async () => {
  withConnection();
  const { itemId, generationId } = await jobs.reserveGeneration({ auth: alice, lang: "0176", prompt: PROMPT, modification: "a question", externalWrites: false });
  await h.drainJobs();
  await h.db.doc(`generation-jobs/${generationId}`).update({ "dispatch.state": "reserved", "dispatch.leaseOwner": null, "envelope.deadlineAt": Date.now() - 1 });
  await h.db.doc(`users/alice/items/${itemId}`).update({ "generation.state": "reserved", generationStatus: "generating", taskId: null, billed: false });
  await jobs.runJobV2(generationId);
  h.calls.length = 0;
  const r = await jobs.retryGeneration({ auth: alice, itemId });
  await h.drainJobs();
  await assertNoWrite(r.generationId);
});
