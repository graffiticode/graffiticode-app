// Restricted MCP operations (core/operations.ts). OpenAI's app review requires
// each model-callable operation to be its own tool, with nothing hidden behind
// it. A job reserved with an operation therefore:
//   - never writes to an external system (no connection write is recorded or sent);
//   - is checked against the operation's permitted languages INSIDE the
//     reservation transaction, on the snapshot the job is reserved from;
//   - is pinned to its language (a wrong-tool request fails, durably, with the
//     language it belongs to, instead of switching);
//   - composes only with its operation's upstreams, with nothing grandfathered;
//   - keeps all of that across retries.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";
import { PROMPT, createItem, ok } from "./helpers";

let h: Harness;
let jobs: any;
let protocol: any;
let revise: any;
let operations: any;
let gen: any;
before(async () => {
  h = await start();
  jobs = await import("@graffiticode-app/core/generation-jobs");
  protocol = await import("@graffiticode-app/core/generation-protocol");
  revise = await import("@graffiticode-app/core/revise");
  operations = await import("@graffiticode-app/core/operations");
  gen = await import("@graffiticode-app/core/lib/code-generation/generate-for-request");
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2, activatedAt: Date.now(), activatedBy: "baseline" });
  protocol.resetProtocolFloorCache();
});

const alice = { uid: "alice", token: userToken("alice") };
const ctx = { token: userToken("alice") };
const doc = async (p: string) => (await h.db.doc(p).get()).data();
const DEFAULT_PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const withConnection = () => {
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
};

test("a restricted create never writes externally, even for a signed-in user with a connection", async () => {
  withConnection();
  const r = await revise.createFromDescription(ctx, { lang: "0176", description: "A multiple choice question about photosynthesis.", client: "mcp" },
    { operation: "create_learnosity_item" });
  await h.drainJobs();
  const { generationId } = h.jobPayloads.at(-1);
  const j = await doc(`generation-jobs/${generationId}`);
  assert.equal(j.dispatch.state, "completed");
  assert.equal(j.envelope.operation, "create_learnosity_item");
  assert.equal(j.envelope.externalWrites, false);
  assert.equal(j.envelope.pinLanguage, true);
  assert.equal(await doc(`effects/${generationId}:connection_write`), undefined, "no connection write recorded");
  assert.deepEqual(h.calls.filter(c => c.path === "/compile" && c.body?.connectionId), [], "nothing sent through the connection");
  assert.equal((await doc(`users/alice/items/${r.itemId}`)).generationStatus, "ready");
});

test("the same create without an operation still writes through the connection (unchanged)", async () => {
  withConnection();
  await revise.createFromDescription(ctx, { lang: "0176", description: "A multiple choice question about photosynthesis.", client: "mcp" });
  await h.drainJobs();
  const { generationId } = h.jobPayloads.at(-1);
  const j = await doc(`generation-jobs/${generationId}`);
  assert.equal(j.envelope.operation, null);
  assert.equal(j.envelope.externalWrites, true);
  assert.ok(await doc(`effects/${generationId}:connection_write`), "today's behaviour for console and REST");
});

test("an operation can only be passed in-process: the GraphQL generation input ignores it", async () => {
  const r = await h.gql(`mutation($lang:String!,$prompt:String!,$modification:String!){
    startCodeGeneration(lang:$lang, prompt:$prompt, modification:$modification, client:"mcp", operation:"create_quiz"){ itemId } }`,
  { lang: "0175", prompt: PROMPT, modification: PROMPT }, ctx);
  assert.ok(r.body.errors?.length, "the schema has no `operation` argument");
});

test("update_item is refused on a survey, naming respond_to_survey, and reserves nothing", async () => {
  const survey = await createItem(h, ctx, { lang: "0182" });
  const before = h.jobPayloads.length;
  await assert.rejects(revise.reviseItem(ctx, { itemId: survey.id, modification: "rank ideas" }, { operation: "update_item" }),
    (e: any) => e.reason === "operation_not_permitted" && /respond_to_survey/.test(e.message));
  assert.equal(h.jobPayloads.length, before);
});

test("update_item is refused on internal and hidden-language items before any generation", async () => {
  for (const lang of ["0014", "0159", "0010", "0166"]) {
    const it = await createItem(h, ctx, { lang });
    const before = h.jobPayloads.length;
    await assert.rejects(revise.reviseItem(ctx, { itemId: it.id, modification: "change it" }, { operation: "update_item" }),
      (e: any) => e.reason === "operation_not_permitted", lang);
    assert.equal(h.jobPayloads.length, before, `no job for L${lang}`);
  }
});

test("the reservation checks the operation against ITS snapshot: a language changed after the caller's read is refused", async () => {
  // The caller (reviseItem) read a quiz; by reservation it has become a survey.
  const it = await createItem(h, ctx, { lang: "0180" });
  await h.db.doc(`users/alice/items/${it.id}`).update({ lang: "0182" });
  await assert.rejects(jobs.reserveGeneration({ auth: alice, itemId: it.id, lang: "0180", prompt: PROMPT, modification: "x", operation: "update_item" }),
    (e: any) => e.reason === "operation_not_permitted");
  // …and a change to another permitted language is still a changed item, not a silent switch.
  await h.db.doc(`users/alice/items/${it.id}`).update({ lang: "0181" });
  await assert.rejects(jobs.reserveGeneration({ auth: alice, itemId: it.id, lang: "0180", prompt: PROMPT, modification: "x", operation: "update_item" }),
    (e: any) => e.reason === "item_changed");
});

test("a create operation is refused for any language but its own", async () => {
  await assert.rejects(jobs.reserveGeneration({ auth: alice, lang: "0179", prompt: PROMPT, modification: "x", operation: "create_quiz" }),
    (e: any) => e.reason === "operation_not_permitted" && /create_spreadsheet/.test(e.message));
});

test("a retry of a restricted job stays restricted", async () => {
  withConnection();
  const { itemId, generationId } = await jobs.reserveGeneration({ auth: alice, lang: "0176", prompt: PROMPT, modification: "a question", operation: "create_learnosity_item" });
  await h.drainJobs();
  await h.db.doc(`generation-jobs/${generationId}`).update({ "dispatch.state": "reserved", "dispatch.leaseOwner": null, "envelope.deadlineAt": Date.now() - 1 });
  await h.db.doc(`users/alice/items/${itemId}`).update({ "generation.state": "reserved", generationStatus: "generating", taskId: null, billed: false });
  await jobs.runJobV2(generationId);
  const r = await jobs.retryGeneration({ auth: alice, itemId });
  await h.drainJobs();
  const j = await doc(`generation-jobs/${r.generationId}`);
  assert.equal(j.envelope.operation, "create_learnosity_item");
  assert.equal(j.envelope.externalWrites, false);
  assert.equal(j.envelope.pinLanguage, true);
  assert.equal(j.dispatch.state, "completed");
  assert.equal(await doc(`effects/${r.generationId}:connection_write`), undefined);
});

test("a wrong-tool request fails durably with the language it belongs to, readable after the job ends", async () => {
  const saved = process.env.SCOPE_GATE_ENABLED;
  process.env.SCOPE_GATE_ENABLED = "true";
  h.setLlm((req) => {
    const text = JSON.stringify(req);
    if (/best-fit language id/.test(text)) return '{"inScope": false, "routedLang": "0179", "reason": "It is a spreadsheet."}';
    return DEFAULT_PROGRAM;
  });
  try {
    const r = await revise.createFromDescription(ctx, { lang: "0180", description: "A budget spreadsheet with rent and food rows.", client: "mcp" },
      { operation: "create_quiz" });
    await h.drainJobs();
    const { generationId } = h.jobPayloads.at(-1);
    const j = await doc(`generation-jobs/${generationId}`);
    assert.equal(j.dispatch.state, "failed");
    assert.equal(j.dispatch.failure.code, "wrong_tool");
    assert.equal(j.dispatch.failure.routedLang, "0179");
    const it = await doc(`users/alice/items/${r.itemId}`);
    assert.equal(it.lang, "0180", "never switched");
    assert.equal(it.generationErrorCode, "wrong_tool");
    assert.equal(it.generationRoutedLang, "0179");
    // A later poll (the GraphQL item read the MCP server uses) still carries it.
    const read = ok(await h.gql(`query($id:String!){ item(id:$id){ generationStatus generationErrorCode generationRoutedLang } }`, { id: r.itemId }, ctx)).item;
    assert.deepEqual(read, { generationStatus: "failed", generationErrorCode: "wrong_tool", generationRoutedLang: "0179" });
  } finally {
    process.env.SCOPE_GATE_ENABLED = saved;
    h.setLlm(() => DEFAULT_PROGRAM);
  }
});

test("an unpinned request routed elsewhere still switches languages (unchanged)", async () => {
  const saved = process.env.SCOPE_GATE_ENABLED;
  process.env.SCOPE_GATE_ENABLED = "true";
  h.setLlm((req) => /best-fit language id/.test(JSON.stringify(req))
    ? '{"inScope": false, "routedLang": "0179", "reason": "It is a spreadsheet."}' : DEFAULT_PROGRAM);
  try {
    const r = await revise.createFromDescription(ctx, { lang: "0180", description: "A budget spreadsheet.", client: "mcp" });
    await h.drainJobs();
    const it = await doc(`users/alice/items/${r.itemId}`);
    assert.equal(it.lang, "0179");
    assert.equal(it.generationRoutedLang ?? null, null);
  } finally {
    process.env.SCOPE_GATE_ENABLED = saved;
    h.setLlm(() => DEFAULT_PROGRAM);
  }
});

test("composition: a restricted job permits only its operation's upstreams, with nothing grandfathered", () => {
  const existingChain = 'data use "0185" {}..';
  // Unrestricted: an upstream the existing item already binds is kept (grandfathered).
  const open = gen.compositionPermits({ headLang: "0176", currentSrc: existingChain, allowedUpstreams: null });
  assert.ok(open.permits.includes("0185"), "unrestricted keeps an existing binding");
  // Restricted: the same existing binding is NOT permitted…
  const restricted = gen.compositionPermits({
    headLang: "0176", currentSrc: existingChain,
    allowedUpstreams: [...operations.permittedUpstreams("update_item", "0176")],
  });
  assert.equal(restricted.permits.includes("0185"), false, "a disallowed existing upstream is refused");
  assert.deepEqual(restricted.grandfathered, []);
  // …while the declared edges still are.
  for (const lang of ["0179", "0183"]) assert.ok(restricted.permits.includes(lang), lang);
  // A chart may compose with fetched data; a quiz composes with nothing.
  assert.deepEqual([...operations.permittedUpstreams("create_chart", "0184")], ["0185"]);
  assert.deepEqual([...operations.permittedUpstreams("create_quiz", "0180")], []);
  assert.deepEqual([...operations.permittedUpstreams("save_to_learnosity_item_bank", "0176")], ["0179", "0183"]);
});

test("the operations table: one create tool per content language, update_item a positive list without surveys", () => {
  const langs = Object.values(operations.CREATE_OPERATIONS);
  assert.equal(new Set(langs).size, langs.length, "no language has two create tools");
  assert.deepEqual([...operations.OPERATION_LANGS.update_item].sort(), langs.filter((l: string) => l !== "0182").sort());
  assert.deepEqual([...operations.OPERATION_LANGS.respond_to_survey], ["0182"]);
  assert.deepEqual([...operations.OPERATION_LANGS.save_to_learnosity_item_bank], ["0176"]);
});
