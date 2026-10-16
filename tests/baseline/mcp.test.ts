// MCP tools, driven through the in-process console exactly as production does
// (mcp-server -> console GraphQL), plus the generation lifecycle they depend on.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, userToken, type Harness } from "./harness";
import { PROMPT, generate, getItem, ok, lastJob, protocolV2 } from "./helpers";

let h: Harness;
let tools: any;
let mcpSession: any;
before(async () => {
  h = await start();
  // mcp-server reads these at import.
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.GRAFFITICODE_API_URL = h.backendOrigin;
  tools = await import("../../packages/mcp-server/src/tools");
  mcpSession = await import("../../packages/mcp-server/src/session-token");
});
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const user = (uid = "alice") => ({ auth: { type: "firebase", token: userToken(uid), source: "raw" }, clientKind: "baseline" });

async function call(ctx: any, name: string, args: Record<string, unknown>) {
  return tools.handleToolCall(ctx, name, args);
}

test("create_item starts a generation and returns status generating", async () => {
  const r = await call(user(), "create_item", { language: "L0175", description: PROMPT, name: "lighthouse" });
  assert.equal(r.status, "generating");
  assert.equal(r.operation, "create");
  assert.equal(r.language, "L0175");
  assert.ok(r.item_id);
  await h.drainJobs();
  // The worker received the description as both prompt and modification.
  const job = await lastJob(h);
  assert.equal(job.itemId, r.item_id);
  assert.equal(job.modification, PROMPT);
  assert.ok(String(job.prompt).includes(PROMPT));
});

test("get_item returns the raw program once ready; render_item a compact result", async () => {
  const c = await call(user(), "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  const g = await call(user(), "get_item", { item_id: c.item_id });
  assert.equal(g.status, "ready", JSON.stringify(g));
  assert.ok(g.task_id);
  assert.ok(typeof g.src === "string" && g.src.includes("passage"));
  assert.ok(g.view_url);
  const r = await call(user(), "render_item", { item_id: c.item_id });
  const rendered = r.structuredContent ?? r;
  assert.equal(rendered.status, "ready");
  assert.equal(rendered.src, undefined, "render_item keeps src out of the model-visible result");
});

test("update_item sends history and the new request as the prompt, and the source separately", async () => {
  const c = await call(user(), "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  const before = await call(user(), "get_item", { item_id: c.item_id });
  const MOD = "Make the lighthouse keeper older and wiser.";
  const u = await call(user(), "update_item", { item_id: c.item_id, modification: MOD });
  assert.equal(u.status, "generating");
  assert.equal(u.operation, "update");
  await h.drainJobs();
  const job = await lastJob(h);
  assert.equal(job.itemId, c.item_id);
  assert.equal(job.modification, MOD);
  assert.match(job.prompt, /^Previous conversation:/);
  assert.ok(job.prompt.includes(`User: ${PROMPT}`), job.prompt);
  assert.ok(job.prompt.endsWith(`Now, please address this new request:\n${MOD}`), job.prompt);
  assert.ok(!job.prompt.includes(before.src), "the prompt text excludes the current source");
  assert.equal(job.currentSrc, before.src, "the current source travels as its own argument");
  assert.ok(job.currentData, "the compiled data travels too");
  const after = await call(user(), "get_item", { item_id: c.item_id });
  assert.equal(after.status, "ready");
});

test("a generation whose output doesn't parse leaves the item failed", async () => {
  h.setLlm(() => "```\nthis is not a program\n```");
  const c = await call(user(), "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  const g = await call(user(), "get_item", { item_id: c.item_id });
  assert.equal(g.status, "failed", JSON.stringify(g));
  assert.ok(g.error);
});

test("get_spec returns the generated English spec and caches it on the item", async () => {
  const c = await call(user(), "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  h.setLlm(() => "A passage about a lighthouse keeper.");
  const before = h.llmRequests.length;
  const s = await call(user(), "get_spec", { item_id: c.item_id });
  assert.equal(s.item_id, c.item_id);
  assert.equal(s.language, "L0175");
  assert.match(s.spec, /lighthouse keeper/);
  assert.equal(h.llmRequests.length, before + 1);
  await call(user(), "get_spec", { item_id: c.item_id });
  assert.equal(h.llmRequests.length, before + 1, "a second read is served from the cache");
});

test("list_languages and get_language_info describe the catalog", async () => {
  const l = await call(user(), "list_languages", {});
  assert.ok(Array.isArray(l.languages) && l.languages.length > 0);
  assert.ok(l.languages.every((x: any) => /^L\d{4}$/.test(x.id)));
  const info = await call(user(), "get_language_info", { language: "0175" });
  assert.equal(info.id, "L0175");
  assert.equal(info.user_guide_resource, "graffiticode://language/L0175/user-guide");
});

test("a free-plan MCP session creates in its own workspace and gets claim links", async () => {
  const token = await mcpSession.mintSessionToken("33333333-3333-4333-8333-333333333333");
  const ctx = { auth: { type: "freePlan", sessionId: token, onWorkspace: () => {} }, clientKind: "baseline" };
  const c = await call(ctx, "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  const g = await call(ctx, "get_item", { item_id: c.item_id });
  assert.equal(g.status, "ready", JSON.stringify(g));
  assert.match(String(g.claim_url), /\/claim\?token=/);
});

test("a second revision while one is generating is acknowledged but dropped", async () => {
  const alice = { token: userToken("alice") };
  const first = ok(await generate(h, alice, {})).startCodeGeneration;
  // Slow the LLM so the first revision is still running when the second arrives.
  h.setLlm(() => "```\n" + 'passage "Revised"\n  type literary\n  lines [\n    "Line one."\n  ] claims []\n  evidence []\n  outcomes [] {}..' + "\n```", 300);
  const one = h.gql(`mutation($id:String!,$m:String!){ startCodeGeneration(itemId:$id, lang:"0175", prompt:$m, modification:$m){ itemId status } }`,
    { id: first.itemId, m: "First revision: retitle it Revised." }, alice);
  await new Promise(r => setTimeout(r, 50));
  const two = h.gql(`mutation($id:String!,$m:String!){ startCodeGeneration(itemId:$id, lang:"0175", prompt:$m, modification:$m){ itemId status } }`,
    { id: first.itemId, m: "Second revision: add a second line." }, alice);
  const [r1, r2] = await Promise.all([one, two]);
  assert.equal(ok(r1).startCodeGeneration.status, "generating");
  if (protocolV2()) {
    // CHANGED in Phase 3.5 (v2): the second revision is refused up front
    // (generation_in_progress) instead of being acknowledged and silently
    // dropped. Exactly one revision still lands.
    assert.match(r2.body.errors?.[0]?.message ?? "", /still generating/);
  } else {
    assert.equal(ok(r2).startCodeGeneration.status, "generating");
  }
  await h.drainJobs();
  const item = ok(await getItem(h, alice, first.itemId)).item;
  const help = JSON.parse(item.help || "[]").map((e: any) => e.user);
  // v1: both are accepted, one generation runs, the other's job finds the
  // lease busy and is acked as a duplicate. Exactly one revision lands.
  const revisions = help.filter((u: string) => /revision/.test(u));
  assert.deepEqual(revisions, ["First revision: retitle it Revised."], JSON.stringify(help));
  assert.equal(item.generationStatus, "ready");
});
