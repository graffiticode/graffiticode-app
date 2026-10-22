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
const { handleToolCall, getItemTool, renderItemTool } = await import("../src/tools.js");
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
    : {};
  return { ok: true, status: 200, json: async () => ({ data }), text: async () => "" };
}) as never;

const ajv = new Ajv({ strict: false, allErrors: true });
const validGetItem = ajv.compile(getItemTool.outputSchema as object);
const validRenderItem = ajv.compile(renderItemTool.outputSchema as object);

const FREE = { type: "freePlan", sessionId: "s-1" };
const SIGNED_IN = { type: "firebase", token: "t", source: "oauth" };

async function call(tool: string, auth: unknown) {
  const ctx = { auth, clientKind: "openai-mcp", declaresUi: true } as never;
  return formatToolResult((await handleToolCall(ctx, tool, { item_id: "item-1" })) as Record<string, unknown>);
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
