// Core operations called directly (Phase 1d): the shared create/revise
// preparation must produce the same generation job as MCP's own tools, and
// full-account operations refuse free-plan principals on their own, whatever
// transport reaches them.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, userToken, type Harness } from "./harness";
import { PROMPT, createItem, session } from "./helpers";

let h: Harness;
let tools: any;
let core: any;
before(async () => {
  h = await start();
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.GRAFFITICODE_API_URL = h.backendOrigin;
  tools = await import("../../packages/mcp-server/src/tools");
  core = {
    ...(await import("@graffiticode-app/core/revise")),
    ...(await import("@graffiticode-app/core/auth")),
    ...(await import("@graffiticode-app/core/errors")),
    ...(await import("@graffiticode-app/core/versions")),
    ...(await import("@graffiticode-app/core/compiles")),
    ...(await import("@graffiticode-app/core/writes")),
    ...(await import("@graffiticode-app/core/items")),
    ...(await import("@graffiticode-app/core/tasks")),
  };
});
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const mcpCtx = { auth: { type: "firebase", token: userToken("alice"), source: "raw" }, clientKind: "baseline" };
const coreCtx = { token: userToken("alice") };
const JOB_FIELDS = ["itemId", "lang", "prompt", "modification", "currentSrc", "currentData", "client"] as const;
const pick = (job: any) => Object.fromEntries(JOB_FIELDS.map(k => [k, job[k] ?? null]));

test("reviseItem builds the same generation job as MCP's update_item", async () => {
  const c = await tools.handleToolCall(mcpCtx, "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  const MOD = "Make the lighthouse keeper older and wiser.";
  await tools.handleToolCall(mcpCtx, "update_item", { item_id: c.item_id, modification: MOD });
  await h.drainJobs();
  const viaMcp = pick(h.jobPayloads.at(-1));
  // The MCP revision changed the item's history; compare against a core
  // revision of the same state by revising again through both paths.
  const MOD2 = "Add a storm at sea.";
  await tools.handleToolCall(mcpCtx, "update_item", { item_id: c.item_id, modification: MOD2 });
  const mcpJob = pick(h.jobPayloads.at(-1));
  await h.drainJobs();
  // Roll the item back to the state MCP saw for MOD2, then revise through core.
  const ref = h.db.doc(`users/alice/items/${c.item_id}`);
  const help = JSON.parse((await ref.get()).data().help);
  await ref.update({ help: JSON.stringify(help.slice(0, -1)), taskId: mcpJob.currentSrc ? (await ref.get()).data().taskId : null });
  const before = h.jobPayloads.length;
  const r = await core.reviseItem(coreCtx, { itemId: c.item_id, modification: MOD2, client: "mcp" });
  assert.equal(r.status, "generating");
  const coreJob = pick(h.jobPayloads.at(before));
  await h.drainJobs();
  assert.equal(viaMcp.modification, MOD);
  assert.deepEqual({ ...coreJob, currentSrc: null, currentData: null }, { ...mcpJob, currentSrc: null, currentData: null });
  assert.equal(typeof coreJob.currentSrc, "string");
  assert.ok(coreJob.prompt.endsWith(`Now, please address this new request:\n${MOD2}`));
  assert.ok(!coreJob.prompt.includes(coreJob.currentSrc), "the prompt text excludes the source");
});

test("createFromDescription builds the same generation job as MCP's create_item", async () => {
  await tools.handleToolCall(mcpCtx, "create_item", { language: "L0175", description: PROMPT });
  const mcpJob = pick(h.jobPayloads.at(-1));
  await h.drainJobs();
  const r = await core.createFromDescription(coreCtx, { lang: "L0175", description: PROMPT, client: "mcp" });
  const coreJob = pick(h.jobPayloads.at(-1));
  await h.drainJobs();
  assert.equal(r.status, "generating");
  assert.deepEqual({ ...coreJob, itemId: "x" }, { ...mcpJob, itemId: "x" });
});

test("both refuse a forwarded item id or AST as a description", async () => {
  const ast = '{"1":{"tag":"STR","elts":["x"]}}';
  await assert.rejects(core.createFromDescription(coreCtx, { lang: "0175", description: "AbCdEfGhIjKlMnOpQrSt" }), /looks like an item id/);
  await assert.rejects(core.createFromDescription(coreCtx, { lang: "0175", description: ast }), /language-private artifact/);
  await assert.rejects(tools.handleToolCall(mcpCtx, "create_item", { language: "L0175", description: "AbCdEfGhIjKlMnOpQrSt" }), /looks like an item id/);
});

test("reviseItem reports a missing item", async () => {
  await assert.rejects(core.reviseItem(coreCtx, { itemId: "no-such-item", modification: "anything at all" }),
    (err: any) => err instanceof core.NotFoundError && /Item not found: no-such-item/.test(err.message));
});

test("full-account operations refuse a free-plan principal themselves", async () => {
  const A = session(1);
  const a = await createItem(h, A);
  const principal = await core.resolveAuth({ freePlan: true, sessionNamespace: "ns" });
  const refused = async (p: Promise<unknown>, message: RegExp) =>
    assert.rejects(p, (err: any) => err instanceof core.ForbiddenError && message.test(err.message));
  await refused(core.getTaskVersions({ auth: principal, lang: "0175" }), /Version history requires a full account/);
  await refused(core.compiles({ auth: principal, lang: "0175", type: "*" }), /Version history/);
  await refused(core.getTasks({ auth: principal, lang: "0175" }), /Version history/);
  for (const op of ["retryItemWrite", "reconcileItemWrite", "recompileItem", "republishItem"]) {
    await refused(core[op]({ auth: principal, id: a.id }), /Connections require a full account/);
  }
  await refused(core.shareItem({ auth: principal, itemId: a.id, targetUserId: "bob" }), /Sharing requires a full account/);
});

test("readItemData ignores a free-plan caller's connection", async () => {
  const principal = await core.resolveAuth({ freePlan: true, sessionNamespace: "ns" });
  await core.readItemData({ auth: principal, id: "t1", connectionId: "conn-1" });
  const user = await core.resolveAuth({ token: userToken("alice") });
  await core.readItemData({ auth: user, id: "t1", connectionId: "conn-1" });
  const reads = h.calls.filter(c => c.path.startsWith("/data?id=t1")).map(c => c.path);
  assert.ok(!reads[0].includes("connection="), reads[0]);
  assert.ok(reads[1].includes("connection=conn-1"), reads[1]);
});
