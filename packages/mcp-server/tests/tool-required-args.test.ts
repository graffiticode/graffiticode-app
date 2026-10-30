import assert from "node:assert/strict";
import test from "node:test";
import { handleToolCall, missingRequiredArgs } from "../src/tools.js";
import type { AuthContext } from "../src/api.js";

// A call with no arguments used to reach the handlers and fail inside them with
// messages like "Cannot read properties of undefined (reading 'replace')". The
// dispatcher now checks each tool's inputSchema.required first.

const ctx = { auth: { type: "freePlan", sessionId: "test" } as AuthContext };

test("every tool that needs an argument names it when called with none", async () => {
  for (const [tool, arg] of [
    ["get_item", "item_id"],
    ["render_item", "item_id"],
    ["get_spec", "item_id"],
    ["get_language_info", "language"],
    ["update_item", "item_id, modification"],
    ["create_item", "language, description"],
  ]) {
    await assert.rejects(
      handleToolCall(ctx as never, tool, {}),
      (err: Error) => err.message.startsWith("Missing required argument") && err.message.includes(arg),
      tool,
    );
  }
});

test("blank and non-string values count as missing", () => {
  assert.deepEqual(missingRequiredArgs("get_item", { item_id: "  " }), ["item_id"]);
  assert.deepEqual(missingRequiredArgs("get_item", { item_id: 42 }), ["item_id"]);
  assert.deepEqual(missingRequiredArgs("get_item", undefined), ["item_id"]);
});

test("present arguments and tools with nothing required pass", () => {
  assert.deepEqual(missingRequiredArgs("get_item", { item_id: "abc" }), []);
  assert.deepEqual(missingRequiredArgs("list_languages", {}), []);
  assert.deepEqual(missingRequiredArgs("no_such_tool", {}), []);
});
