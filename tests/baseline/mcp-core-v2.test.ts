// Phase 3.5 R2: MCP in core mode on v2. What R2 relies on beyond the shared
// suite: creates reserve v2 jobs in-process (no GraphQL hop), the LLM-backed
// get_spec stays on the console, and reads never call Policy (only the console
// may).
process.env.GRAFFITICODE_BACKEND = "core";
process.env.GENERATION_PROTOCOL = "v2";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, userToken, type Harness } from "./harness";

let h: Harness;
let tools: any;
let backend: any;
before(async () => {
  h = await start();
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.GRAFFITICODE_API_URL = h.backendOrigin;
  tools = await import("../../packages/mcp-server/src/tools");
  backend = await import("../../packages/mcp-server/src/core-backend");
});
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const ctx = { auth: { type: "firebase", token: userToken("alice"), source: "raw" }, clientKind: "baseline" };
const DESCRIPTION = "Write a short literary passage about a lighthouse keeper.";

test("create_item in core mode reserves a v2 job in-process; the console's worker runs it", async () => {
  const c = await tools.handleToolCall(ctx, "create_item", { language: "L0175", description: DESCRIPTION });
  const itemId = c.item_id;
  await h.drainJobs();
  assert.ok(itemId);
  const payload = h.jobPayloads.at(-1);
  assert.deepEqual(Object.keys(payload).sort(), ["generationId", "v"]);
  const job = (await h.db.doc(`generation-jobs/${payload.generationId}`).get()).data();
  assert.equal(job.envelope.client, "mcp");
  assert.equal(job.dispatch.state, "completed");
  const it = (await h.db.doc(`users/alice/items/${itemId}`).get()).data();
  assert.equal(it.generationStatus, "ready");
});

test("get_spec stays on the console; every other operation is answered in-process", async () => {
  assert.equal(backend.coreHandles("query GetSpec($id: String!) { spec(id: $id) { spec } }"), false);
  for (const op of ["GetItem", "GetItemWithTask", "GetData", "GetTask", "ListLanguages", "GetLanguageInfo"]) {
    assert.equal(backend.coreHandles(`query ${op}($id: String!) { x }`), true, op);
  }
  assert.equal(backend.coreHandles("mutation StartCodeGeneration($lang: String!) { x }"), true);
});

test("reads of a connectable item make no Policy call in core mode", async () => {
  h.enablePolicy();
  h.setConnections([{ connectionId: "conn-1", backend: "learnosity", status: "active", label: "Item bank", ownerPermissions: null }]);
  const c = await tools.handleToolCall(ctx, "create_item", { language: "L0176", description: "A multiple choice question about photosynthesis." });
  const itemId = c.item_id;
  await h.drainJobs();
  const before = h.calls.length;
  await tools.handleToolCall(ctx, "get_item", { item_id: itemId });
  const policy = h.calls.slice(before).filter(c => c.path.startsWith("/v1/"));
  assert.deepEqual(policy.map(c => c.path), [], "no Policy route called by the read");
});

test("core readiness: ready with Firestore, secrets and free-plan credentials; names what's missing", async () => {
  const { coreReadiness } = await import("@graffiticode-app/core/readiness");
  const { coreConfig, setCoreConfig } = await import("@graffiticode-app/core/config");
  const ready = await coreReadiness();
  assert.equal(ready.ok, true, JSON.stringify(ready.checks));
  assert.deepEqual(Object.keys(ready.checks).sort(), ["config", "firestore", "freePlan"], "the queue check is skipped in local mode");
  assert.equal(ready.effectiveProtocol, 2);

  const base = coreConfig();
  setCoreConfig({ ...base, actAs: { ...base.actAs, grantSecret: "" },
    generationQueue: { ...base.generationQueue, local: false, workerUrl: "https://console.graffiticode.org/api/generate-job" } });
  try {
    const short = await coreReadiness({ queue: false });
    assert.equal(short.ok, false);
    assert.match(short.checks.config, /missing ACT_AS_GRANT_SECRET/);
  } finally {
    setCoreConfig(null);
  }
});

test("the mcp candidate check refuses a core candidate that isn't ready or runs the wrong backend", async () => {
  const verify = (await import("../../verify/mcp.mjs")).default;
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const core = { env: { GRAFFITICODE_BACKEND: "core" } };
  const logs: string[] = [];
  await verify({ candidateUrl: "x", headers: {}, config: core, log: (m: string) => logs.push(m),
    fetch: respond(200, { status: "ok", backend: "core", effectiveProtocol: 2, minProtocol: 2, checks: { firestore: "ok", queue: "ok" } }) });
  assert.match(logs[0], /backend core; core ready \(firestore, queue\); protocol 2, floor 2/);
  await assert.rejects(verify({ candidateUrl: "x", headers: {}, config: core, log: () => {},
    fetch: respond(503, { status: "unready", checks: { queue: "cannot create tasks on the generation queue" } }) }), /503.*cannot create tasks/);
  await assert.rejects(verify({ candidateUrl: "x", headers: {}, config: core, log: () => {},
    fetch: respond(200, { status: "ok", backend: "graphql" }) }), /runs backend graphql, configuration says core/);
});
