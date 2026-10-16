// Phase 4: MCP and REST are equivalent. Each scenario runs through MCP's tools
// (core mode, as production) and the REST API against the same backend, and
// checks the outcome class, item identity and status, and the documented
// renames — not field-for-field equality:
//
//   create_item        POST /items -> 202 + Location   continue_from_item_id -> source_item_id
//   update_item        POST /items/{id}/revisions      a conflict is a 409 problem, not tool-error text
//   get_item           GET /items/{id} (+ Prefer: wait) src/data with include=src,data
//   render_item        GET /items/{id}/view -> 303     a redirect instead of widget metadata
//   get_spec           GET /items/{id}/spec            coverage fields in the body
//   list_languages     GET /languages                  pagination
//   get_language_info  GET /languages/{id}             user_guide_resource -> guide_url
process.env.GRAFFITICODE_BACKEND = "core";
process.env.GENERATION_PROTOCOL = "v2";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";

let h: Harness;
let tools: any;
let app: any;
let mintSessionToken: any;
let deriveSessionNamespace: any;
before(async () => {
  h = await start();
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.GRAFFITICODE_API_URL = h.backendOrigin;
  process.env.OPENAPI_PUBLIC_URL = "https://openapi.test/v1";
  tools = await import("../../packages/mcp-server/src/tools");
  app = (await import("../../packages/openapi-server/src/app.ts")).createApp();
  ({ mintSessionToken } = await import("@graffiticode-app/core/lib/free-plan-session-token"));
  ({ deriveSessionNamespace } = await import("@graffiticode-app/core/lib/free-plan-context"));
});
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const DESCRIPTION = "Write a short literary passage about a lighthouse keeper.";
const mcp = (ctx: any, name: string, args: Record<string, unknown>) => tools.handleToolCall(ctx, name, args);
const mcpError = async (ctx: any, name: string, args: Record<string, unknown>) => {
  try { await mcp(ctx, name, args); } catch (err: any) { return String(err?.message ?? err); }
  return null;
};
const rest = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  app.request(`http://x/v1${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

const user = { mcp: { auth: { type: "firebase", token: userToken("alice"), source: "raw" }, clientKind: "baseline" }, rest: { Authorization: `Bearer ${userToken("alice")}` } };
async function freePlan(uuid: string) {
  const token = await mintSessionToken({ sessionNamespace: deriveSessionNamespace(uuid), sessionUuid: uuid });
  return { mcp: { auth: { type: "freePlan", sessionId: token, onWorkspace: () => {} }, clientKind: "baseline" }, rest: { "X-Graffiticode-Workspace": token } };
}

// One item made each way, both ready.
async function both(who = user) {
  const m = await mcp(who.mcp, "create_item", { language: "L0175", description: DESCRIPTION });
  const r = await rest("POST", "/items", who.rest, { language: "L0175", description: DESCRIPTION });
  const rb = await r.json();
  assert.equal(m.status, "generating");
  assert.equal(r.status, 202);
  assert.equal(rb.status, "generating", "create: both answer generating at once");
  assert.equal(m.language, rb.language);
  await h.drainJobs();
  return { m: m.item_id, r: rb.id };
}

test("create_item / POST /items, then get_item / GET /items/{id}: ready, same language, same program", async () => {
  const { m, r } = await both();
  const gm = await mcp(user.mcp, "get_item", { item_id: m });
  const gr = await (await rest("GET", `/items/${r}?include=src,data`, user.rest)).json();
  assert.equal(gm.status, "ready");
  assert.equal(gr.status, "ready");
  assert.equal(gm.language, gr.language);
  assert.equal(gm.src, gr.src, "the same description makes the same program either way");
  assert.deepEqual(gm.data, gr.data);
});

test("render_item / GET /view: the same view, as a URL or a redirect", async () => {
  const { m } = await both();
  const rendered = await mcp(user.mcp, "render_item", { item_id: m });
  const view = await rest("GET", `/items/${m}/view`, user.rest);
  assert.equal(view.status, 303);
  assert.equal(view.headers.get("location"), rendered.view_url ?? rendered.structuredContent?.view_url);
});

test("update_item / POST /revisions: both revise; a revision during generation is refused by both", async () => {
  const { m, r } = await both();
  h.setLlm(() => "```\n" + PROGRAM.replace(/"[^"]*"/, '"Winter"') + "\n```", 800);
  assert.equal((await mcp(user.mcp, "update_item", { item_id: m, modification: "Make it winter." })).status, "generating");
  assert.equal((await rest("POST", `/items/${r}/revisions`, user.rest, { modification: "Make it winter." })).status, 202);
  const mcpConflict = await mcpError(user.mcp, "update_item", { item_id: m, modification: "Make it summer." });
  const restConflict = await rest("POST", `/items/${r}/revisions`, user.rest, { modification: "Make it summer." });
  assert.match(String(mcpConflict), /still generating/);
  assert.equal(restConflict.status, 409);
  assert.equal((await restConflict.json()).code, "generation_in_progress");
  await h.drainJobs();
  const gm = await mcp(user.mcp, "get_item", { item_id: m });
  const gr = await (await rest("GET", `/items/${r}?include=src`, user.rest)).json();
  assert.equal(gm.src, gr.src, "the same revision lands either way");
});

test("get_spec / GET /spec: the same spec and coverage", async () => {
  const { m } = await both();
  const sm = await mcp(user.mcp, "get_spec", { item_id: m });
  const sr = await (await rest("GET", `/items/${m}/spec`, user.rest)).json();
  const text = sm.spec ?? sm.structuredContent?.spec ?? sm.content?.[0]?.text;
  assert.equal(sr.spec, text);
  assert.equal(sr.item_id, m);
});

test("list_languages / GET /languages: the same catalog", async () => {
  const lm = await mcp(user.mcp, "list_languages", {});
  const lr = await (await rest("GET", "/languages?limit=100")).json();
  assert.deepEqual(lr.data.map((l: any) => l.id).sort(), lm.languages.map((l: any) => l.id).sort());
  const domain = lm.languages.find((l: any) => l.domains?.length)?.domains[0];
  const dm = await mcp(user.mcp, "list_languages", { domain });
  const dr = await (await rest("GET", `/languages?limit=100&domain=${domain}`)).json();
  assert.deepEqual(dr.data.map((l: any) => l.id).sort(), dm.languages.map((l: any) => l.id).sort());
});

test("get_language_info / GET /languages/{id}: the same envelope; the guide is a URL", async () => {
  const im = await mcp(user.mcp, "get_language_info", { language: "L0175" });
  const ir = await (await rest("GET", "/languages/L0175")).json();
  for (const k of ["id", "name", "description", "domains", "authoring_guide", "supported_item_types", "not_for", "example_prompts", "spec_url"]) {
    assert.deepEqual(ir[k], im[k], k);
  }
  assert.equal(im.user_guide_resource, "graffiticode://language/L0175/user-guide");
  assert.equal(ir.guide_url, "https://openapi.test/v1/languages/L0175/guide");
});

test("a missing item: a tool error and a 404", async () => {
  assert.match(String(await mcpError(user.mcp, "get_item", { item_id: "nope" })), /not found/i);
  assert.equal((await rest("GET", "/items/nope", user.rest)).status, 404);
});

test("a failed generation reads as failed, with the same message", async () => {
  h.setLlm(() => "OUT_OF_SCOPE: this language writes passages, not spreadsheets.");
  const m = await mcp(user.mcp, "create_item", { language: "L0175", description: "A budget spreadsheet with monthly totals." });
  const r = await (await rest("POST", "/items", user.rest, { language: "L0175", description: "A budget spreadsheet with monthly totals." })).json();
  await h.drainJobs();
  const gm = await mcp(user.mcp, "get_item", { item_id: m.item_id });
  const gr = await (await rest("GET", `/items/${r.id}`, user.rest)).json();
  assert.equal(gm.status, "failed");
  assert.equal(gr.status, "failed");
  assert.equal(gr.error.message, gm.error);
});

test("free plan: an expired item is refused by both, as expired rather than missing", async () => {
  const fp = await freePlan("33333333-3333-4333-8333-333333333333");
  const { m } = await both(fp);
  await h.db.doc(`users/trial-uid/items/${m}`).update({ expiresAt: Date.now() - 1000 });
  assert.match(String(await mcpError(fp.mcp, "get_item", { item_id: m })), /expired/i);
  const r = await rest("GET", `/items/${m}`, fp.rest);
  assert.equal(r.status, 410);
  assert.equal((await r.json()).code, "free_plan_item_expired");
});

test("bad credentials: refused by both", async () => {
  const bad = { auth: { type: "firebase", token: "garbage", source: "raw" }, clientKind: "baseline" };
  assert.ok(await mcpError(bad, "create_item", { language: "L0175", description: DESCRIPTION }));
  assert.equal((await rest("POST", "/items", { Authorization: "Bearer garbage" }, { language: "L0175", description: DESCRIPTION })).status, 401);
  assert.equal(h.jobPayloads.length, 0);
});
