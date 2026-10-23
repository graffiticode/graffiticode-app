/**
 * The handlers' real output validates against the tools' own outputSchema.
 *
 * get_item spreads the item's hydration into structuredContent, and its schema
 * forbids undeclared properties, so a widget-only field leaking into that
 * hydration makes a validating client reject the whole response. `frame_url`
 * (free-plan L0176 only) did exactly that. This drives get_item and render_item
 * end to end against a stubbed console, through formatToolResult, and validates
 * what a client receives, for a free-plan and a signed-in caller.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";

delete process.env.GRAFFITICODE_BACKEND;
const { handleToolCall, getItemTool, renderItemTool, createItemTool, updateItemTool, renderIdOf } = await import("../src/tools.js");
const { formatToolResult } = await import("../src/tool-result.js");

const ITEM = {
  id: "item-1",
  name: "Presidents",
  taskId: "task-1",
  lang: "0176",
  help: null,
  isPublic: false,
  created: "2026-10-22T00:00:00Z",
  updated: "2026-10-22T00:00:00Z",
  client: "mcp",
  claimToken: null,
  generationStatus: "ready",
  generationError: null,
  generationStartedAt: null,
  generationDeadlineAt: null,
  generationChars: null,
  task: { id: "task-1", lang: "0176", code: "{}", src: "items [] {}.." },
};
const DATA = {
  type: "questions",
  data: { questions: [{ response_id: "r1", type: "orderlist", stimulus: "Order them", list: ["a", "b"] }] },
  request: { consumer_key: "K", signature: "$02$x", questions: [] },
};

// The console's GraphQL, answered per operation.
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const { query } = JSON.parse(init.body);
  const data = /GetItemWithTask/.test(query) ? { item: ITEM }
    : /GetData/.test(query) ? { data: JSON.stringify(DATA) }
    : /StartCodeGeneration/.test(query) ? { startCodeGeneration: { itemId: "item-1", status: "generating", workspaceNamespace: null } }
    : {};
  return { ok: true, status: 200, json: async () => ({ data }), text: async () => "" };
}) as never;

const ajv = new Ajv({ strict: false, allErrors: true });
const validGetItem = ajv.compile(getItemTool.outputSchema as object);
const validRenderItem = ajv.compile(renderItemTool.outputSchema as object);
const validCreateItem = ajv.compile(createItemTool.outputSchema as object);
const validUpdateItem = ajv.compile(updateItemTool.outputSchema as object);

const FREE = { type: "freePlan", sessionId: "s-1" };
const SIGNED_IN = { type: "firebase", token: "t", source: "oauth" };

async function call(
  tool: string,
  auth: unknown,
  args: Record<string, unknown> = { item_id: "item-1" },
  client: { clientKind: string; declaresUi: boolean } = { clientKind: "openai-mcp", declaresUi: true },
) {
  const ctx = { auth, ...client } as never;
  return formatToolResult((await handleToolCall(ctx, tool, args)) as Record<string, unknown>);
}

for (const [who, auth] of [["free-plan", FREE], ["signed-in", SIGNED_IN]] as const) {
  test(`${who} get_item for L0176 validates against its outputSchema`, async () => {
    const res = await call("get_item", auth);
    const sc = res.structuredContent as Record<string, unknown>;
    assert.ok(validGetItem(sc), JSON.stringify(validGetItem.errors));
    assert.equal("frame_url" in sc, false);
  });

  test(`${who} render_item for L0176 validates against its outputSchema`, async () => {
    const res = await call("render_item", auth);
    const sc = res.structuredContent as Record<string, unknown>;
    assert.ok(validRenderItem(sc), JSON.stringify(validRenderItem.errors));
    assert.equal("frame_url" in sc, false, "never in a field a model reads");
  });
}

test("frame_url reaches render_item's widget hydration, signed in or not, and never names the task", async () => {
  for (const auth of [FREE, SIGNED_IN]) {
    const res = await call("render_item", auth);
    const hydration = (res._meta as { graffiticode: Record<string, unknown> }).graffiticode;
    assert.equal(hydration.frame_url, "https://l0176.graffiticode.org/form?source=parent");
  }
});

// create_item / update_item return a "generating" result that carries `summary`;
// their schema forbids undeclared properties, so an undeclared field made every
// result invalid for a validating client.
for (const [who, auth] of [["free-plan", FREE], ["signed-in", SIGNED_IN]] as const) {
  test(`${who} create_item output validates against its outputSchema`, async () => {
    const res = await call("create_item", auth, { language: "L0176", description: "A multiple choice question about photosynthesis." });
    const sc = res.structuredContent as Record<string, unknown>;
    assert.equal(sc.status, "generating");
    assert.ok(validCreateItem(sc), JSON.stringify(validCreateItem.errors));
  });

  test(`${who} update_item output validates against its outputSchema`, async () => {
    const res = await call("update_item", auth, { item_id: "item-1", modification: "Make it harder." });
    const sc = res.structuredContent as Record<string, unknown>;
    assert.equal(sc.status, "generating");
    assert.ok(validUpdateItem(sc), JSON.stringify(validUpdateItem.errors));
  });
}

// What the model is told to do with a ready item depends on the TOOL as well as
// the host: only render_item mounts a widget. get_item has none, so it always
// asks for the contents, even on a host that renders render_item's widget.
test("a rendering host: render_item says the item is shown; get_item still asks for the contents", async () => {
  const render = await call("render_item", SIGNED_IN);
  const get = await call("get_item", SIGNED_IN);
  const msg = (r: Record<string, unknown>) => String((r.structuredContent as Record<string, unknown>).message);
  assert.match(msg(render), /displayed above/i);
  assert.match(msg(render), /do not reproduce/i);
  assert.doesNotMatch(msg(render), /Show the user this item's contents/);
  assert.match(msg(get), /Show the user this item's contents/);
  assert.doesNotMatch(msg(get), /displayed above/i);
});

test("a client that renders no widget is asked for the contents by render_item too", async () => {
  for (const client of [
    { clientKind: "claude-code", declaresUi: false },
    { clientKind: "codex-mcp-client", declaresUi: true },
  ]) {
    const render = await call("render_item", SIGNED_IN, { item_id: "item-1" }, client);
    assert.match(String((render.structuredContent as Record<string, unknown>).message), /Show the user this item's contents/, client.clientKind);
  }
});

test("render_item carries a fresh render_id in its widget hydration only; get_item carries none", async () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const a = await call("render_item", SIGNED_IN);
  const b = await call("render_item", SIGNED_IN);
  const idOf = (r: Record<string, unknown>) => (r._meta as { graffiticode: Record<string, unknown> }).graffiticode.render_id;
  assert.match(String(idOf(a)), uuid);
  assert.notEqual(idOf(a), idOf(b), "one per call");
  assert.equal("render_id" in (a.structuredContent as Record<string, unknown>), false, "never in a field a model reads");
  // What server.ts logs on the call's mcp_tool event.
  const raw = (await handleToolCall({ auth: SIGNED_IN, clientKind: "openai-mcp", declaresUi: true } as never, "render_item", { item_id: "item-1" })) as Record<string, unknown>;
  assert.match(String(renderIdOf(raw)), uuid);
  const get = (await handleToolCall({ auth: SIGNED_IN, clientKind: "openai-mcp", declaresUi: true } as never, "get_item", { item_id: "item-1" })) as Record<string, unknown>;
  assert.equal(renderIdOf(get), undefined);
  assert.equal("render_id" in get, false);
});
